import { ref, type Ref } from 'vue'
import type {
  Project,
  ProjectMember,
  SplitConfig,
  Transaction,
  TransactionType,
} from '@/schemas/ledgerSchema'
import { saveProjectToNormalVault } from '@/db/normalVaultDb'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'
import {
  findOrphanedPoolMemberIdInTransactions as findOrphanedPoolMemberIdInTxList,
  generatePoolMemberId,
  isPoolCollectionTransaction as isPoolCollectionTxCore,
} from '@/core/poolFund'

export interface PoolTransactionWritePayload {
  projectId?: string
  type?: TransactionType
  amount: number
  currency: string
  exchangeRateToBase?: number
  categoryKey: string
  date: string
  time?: string
  note?: string
  links?: string[]
  receiptImages?: string[]
  isReimbursable?: boolean
  splitConfig?: SplitConfig
}

export interface PoolActionsContext {
  projects: Ref<Project[]>
  transactions: Ref<Transaction[]>
  getEffectiveExchangeRate: (from: string, to: string) => number | null
  addTransaction: (payload: PoolTransactionWritePayload) => Promise<Transaction>
  updateTransaction: (
    id: string,
    payload: PoolTransactionWritePayload,
  ) => Promise<Transaction | null>
  syncRememberedPayerForProject: (
    projectId: string,
    nextPayerId: string | undefined,
  ) => void
  enqueueAndFlushProjectChange: (
    projectId: string | undefined,
    entityType: 'project' | 'transaction',
    entityId: string,
    updatedAt: number,
  ) => Promise<void>
  markGoogleDriveDirty: () => void
  toPlainClone: <T>(value: T) => T
}

export function createPoolActions(ctx: PoolActionsContext) {
  /** 記住切換「公費袋優先支出」前原本的真人預設墊付人，方便取消時無縫切回 */
  const previousHumanPayerByProject = ref<Record<string, string>>({})

  /** 判斷該筆交易是否為「繳公費」轉帳（收款對象為公費袋，或多人共同繳交之公費紀錄） */
  function isPoolCollectionTransaction(
    tx: Transaction,
    project?: Project | null,
  ): boolean {
    const proj = project ?? ctx.projects.value.find((p) => p.id === tx.projectId)
    return isPoolCollectionTxCore(tx, proj)
  }

  /** 查找專案有效交易中是否遺留尚未掛回成員清單之孤兒公費袋 ID（例如先刪公費成員又復原紀錄） */
  function findOrphanedPoolMemberIdInTransactions(
    projectId: string,
    existingMemberIds: Set<string>,
  ): string | null {
    return findOrphanedPoolMemberIdInTxList(
      ctx.transactions.value,
      projectId,
      existingMemberIds,
    )
  }

  async function ensureProjectPoolMember(
    projectId: string,
    poolName: string,
  ): Promise<ProjectMember | null> {
    const existing = ctx.projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return null

    const already = existing.members.find((m) => m.isPool)
    if (already) return already

    const existingMemberIds = new Set(existing.members.map((m) => m.id))
    const orphanedPoolId = findOrphanedPoolMemberIdInTransactions(
      projectId,
      existingMemberIds,
    )

    const poolMember: ProjectMember = {
      id: orphanedPoolId ?? generatePoolMemberId(),
      name: poolName.trim().slice(0, 50) || 'Pool',
      avatarColor: '#0f766e',
      isPool: true,
    }

    const baseExisting = ctx.toPlainClone(existing)
    const updated: Project = {
      ...baseExisting,
      members: [...baseExisting.members.map((m) => ({ ...m })), poolMember],
      updatedAt: Date.now(),
    }
    const saved = await saveProjectToNormalVault(updated)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === projectId ? saved : p,
    )
    await ctx.enqueueAndFlushProjectChange(
      projectId,
      'project',
      saved.id,
      saved.updatedAt,
    )
    ctx.markGoogleDriveDirty()
    return poolMember
  }

  async function togglePreferPoolPayer(
    projectId: string,
    defaultPoolName = 'Pool',
  ): Promise<{ enabled: boolean } | null> {
    const existing = ctx.projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return null

    let poolMember = existing.members.find((m) => m.isPool) ?? null
    if (!poolMember) {
      poolMember = await ensureProjectPoolMember(projectId, defaultPoolName)
    }
    const latest = ctx.projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!latest || !poolMember) return null

    const currentlyEnabled = latest.defaultPayerId === poolMember.id
    let nextDefaultPayerId: string | undefined

    if (!currentlyEnabled) {
      if (latest.defaultPayerId && latest.defaultPayerId !== poolMember.id) {
        previousHumanPayerByProject.value = {
          ...previousHumanPayerByProject.value,
          [projectId]: latest.defaultPayerId,
        }
      }
      nextDefaultPayerId = poolMember.id
    } else {
      const remembered = previousHumanPayerByProject.value[projectId]
      const fallbackHuman =
        (remembered &&
        latest.members.some((m) => m.id === remembered && !m.isPool)
          ? remembered
          : undefined) ||
        (latest.syncMeta?.myMemberId &&
        latest.members.some(
          (m) => m.id === latest.syncMeta?.myMemberId && !m.isPool,
        )
          ? latest.syncMeta.myMemberId
          : undefined) ||
        latest.members.find((m) => !m.isPool)?.id ||
        latest.members[0]?.id
      nextDefaultPayerId = fallbackHuman
    }

    // defaultPayerId 定義為本機裝置偏好（與 isArchived、syncMeta 同級）：
    // 僅寫入本機 IndexedDB，不遞增 updatedAt、不推播 Firestore 亦不標記 Drive dirty，
    // 避免單一裝置切換「公費袋優先」覆蓋他機協作成員的預設墊付人（新建公費成員時已由 ensureProjectPoolMember 同步）。
    const baseLatest = ctx.toPlainClone(latest)
    const updated: Project = {
      ...baseLatest,
      defaultPayerId: nextDefaultPayerId,
      members: baseLatest.members.map((m) => ({ ...m })),
    }
    const saved = await saveProjectToNormalVault(updated)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === projectId ? saved : p,
    )
    ctx.syncRememberedPayerForProject(projectId, nextDefaultPayerId)
    return { enabled: !currentlyEnabled }
  }

  async function batchCollectPoolFund(params: {
    projectId: string
    collectorMemberId: string
    contributorMemberIds: string[]
    amountPerMember: number
    currency: string
    exchangeRateToBase?: number
    date: string
    note?: string
    editingTxId?: string
  }): Promise<number> {
    const validContributors = Array.from(
      new Set(
        params.contributorMemberIds.filter(
          (id) => id && id !== params.collectorMemberId,
        ),
      ),
    )
    if (validContributors.length === 0 || params.amountPerMember <= 0) return 0

    const proj = ctx.projects.value.find((p) => p.id === params.projectId)
    const payCurrency = params.currency.trim().toUpperCase()
    const baseCurrency = proj?.baseCurrency.trim().toUpperCase() ?? payCurrency
    const resolvedRate =
      params.exchangeRateToBase && params.exchangeRateToBase > 0
        ? params.exchangeRateToBase
        : payCurrency === baseCurrency
          ? 1
          : ctx.getEffectiveExchangeRate(payCurrency, baseCurrency)
    if (
      resolvedRate === null ||
      !Number.isFinite(resolvedRate) ||
      resolvedRate <= 0
    ) {
      throw new Error('ERR_EXCHANGE_RATE_REQUIRED')
    }
    const effectiveRate = resolvedRate

    // 統一收斂為單筆多人繳交之公費帳目，避免一次收公費產生大量零散紀錄
    const perMemberUnits = toMinorUnits(params.amountPerMember, payCurrency)
    const normalizedPerMember = fromMinorUnits(perMemberUnits, payCurrency)
    const totalAmount = fromMinorUnits(
      perMemberUnits * validContributors.length,
      payCurrency,
    )

    const payload: PoolTransactionWritePayload = {
      projectId: params.projectId,
      type: 'transfer',
      amount: totalAmount,
      currency: payCurrency,
      exchangeRateToBase: effectiveRate,
      categoryKey: 'cat_settlement',
      date: params.date,
      time: '00:00',
      note: params.note,
      splitConfig: {
        payerId: validContributors[0],
        payers: validContributors.map((memberId) => ({
          memberId,
          amount: normalizedPerMember,
        })),
        mode: 'custom_plus_equal',
        shares: [
          {
            memberId: params.collectorMemberId,
            finalAmount: totalAmount,
            customAmount: totalAmount,
            isIncludedInRemainder: false,
          },
        ],
      },
    }

    if (params.editingTxId) {
      await ctx.updateTransaction(params.editingTxId, payload)
    } else {
      await ctx.addTransaction(payload)
    }
    return validContributors.length
  }

  return {
    isPoolCollectionTransaction,
    ensureProjectPoolMember,
    togglePreferPoolPayer,
    batchCollectPoolFund,
  }
}
