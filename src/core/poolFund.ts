import type { Project, ProjectMember, Transaction } from '@/schemas/ledgerSchema'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'

/** 虛擬公費袋成員 ID 統一前綴 */
export const POOL_MEMBER_ID_PREFIX = 'pool_'

export interface PoolCollectBatchSummary {
  ids: string[]
  count: number
  amountPerPerson: number
  totalAmount: number
  currency: string
  date: string
}

export interface PartitionedBalances<T extends { memberId: string }> {
  poolMemberIds: Set<string>
  poolBalances: T[]
  humanBalances: T[]
}

/** 依 ID 前綴判斷是否為公費袋成員 ID（相容已被移除但仍存在於歷史交易中的孤兒公費 ID） */
export function isPoolMemberId(memberId: string | null | undefined): boolean {
  return Boolean(memberId && memberId.startsWith(POOL_MEMBER_ID_PREFIX))
}

/** 判斷成員物件是否為公費袋（以 isPool 標記或 pool_ 前綴為準） */
export function isPoolMember(
  member: Pick<ProjectMember, 'id' | 'isPool'> | null | undefined,
): boolean {
  if (!member) return false
  return Boolean(member.isPool || isPoolMemberId(member.id))
}

/** 判斷指定 memberId 在專案中是否屬於公費袋 */
export function isPoolMemberIdInProject(
  memberId: string | null | undefined,
  project?: Pick<Project, 'members'> | null,
): boolean {
  if (!memberId) return false
  if (isPoolMemberId(memberId)) return true
  return Boolean(project?.members.some((m) => m.id === memberId && Boolean(m.isPool)))
}

/** 產生新的公費袋成員 ID */
export function generatePoolMemberId(now: number = Date.now()): string {
  return `${POOL_MEMBER_ID_PREFIX}${now.toString(36)}`
}

/** 收集專案內所有公費袋 ID（包含 members 中標記為 isPool，以及 balances 中殘留的 pool_ 孤兒 ID） */
export function collectPoolMemberIds(
  members: ReadonlyArray<Pick<ProjectMember, 'id' | 'isPool'>>,
  balances?: ReadonlyArray<{ memberId: string }>,
): Set<string> {
  const ids = new Set<string>()
  for (const m of members) {
    if (isPoolMember(m)) {
      ids.add(m.id)
    }
  }
  if (balances) {
    for (const b of balances) {
      if (isPoolMemberId(b.memberId)) {
        ids.add(b.memberId)
      }
    }
  }
  return ids
}

/** 將結算餘額清單分區為公費袋餘額與真人成員餘額，確保結算頁與各報表分區口徑一致 */
export function partitionPoolAndHumanBalances<
  T extends { memberId: string },
>(
  balances: ReadonlyArray<T>,
  members: ReadonlyArray<Pick<ProjectMember, 'id' | 'isPool'>>,
): PartitionedBalances<T> {
  const poolMemberIds = collectPoolMemberIds(members, balances)
  const poolBalances: T[] = []
  const humanBalances: T[] = []
  for (const bal of balances) {
    if (poolMemberIds.has(bal.memberId)) {
      poolBalances.push(bal)
    } else {
      humanBalances.push(bal)
    }
  }
  return { poolMemberIds, poolBalances, humanBalances }
}

/** 判斷該筆交易是否為「繳公費」轉帳（收款對象為公費袋，或多人共同繳交之公費紀錄） */
export function isPoolCollectionTransaction(
  tx: Transaction,
  project?: Pick<Project, 'members'> | null,
): boolean {
  if (tx.type !== 'transfer' || !tx.splitConfig) return false
  const activePayers = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
  if (activePayers.length > 1) return true
  const toId = tx.splitConfig.shares[0]?.memberId
  return isPoolMemberIdInProject(toId, project)
}

/**
 * 辨識最近一次「批次收公費」的轉帳紀錄，相容兩種格式：
 * 1. 新版單筆合併多人公費紀錄（splitConfig.payers 有 2 位以上正額繳交人）
 * 2. 舊版多筆同批個人轉帳紀錄（同收款公費袋、同日期、同幣別、同單人金額、同備註）
 */
export function findLatestPoolCollectBatch(
  settlements: ReadonlyArray<Transaction>,
  poolMemberIds: ReadonlySet<string>,
): PoolCollectBatchSummary | null {
  if (poolMemberIds.size === 0) return null

  const poolDeposits = settlements
    .filter((tx) => {
      if (tx.isDeleted || tx.type !== 'transfer') return false
      const toId = tx.splitConfig?.shares[0]?.memberId
      return Boolean(toId && poolMemberIds.has(toId))
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const latest = poolDeposits[0]
  if (!latest) return null

  const multiPayers = (latest.splitConfig?.payers ?? []).filter((p) => p.amount > 0)
  if (multiPayers.length > 1) {
    return {
      ids: [latest.id],
      count: multiPayers.length,
      amountPerPerson: multiPayers[0].amount,
      totalAmount: latest.amount,
      currency: latest.currency,
      date: latest.date,
    }
  }

  const targetPoolId = latest.splitConfig?.shares[0]?.memberId
  const latestNote = (latest.note ?? '').trim()
  const batch = poolDeposits.filter((tx) => {
    const txMultiPayers = (tx.splitConfig?.payers ?? []).filter((p) => p.amount > 0)
    if (txMultiPayers.length > 1) return false
    return (
      tx.splitConfig?.shares[0]?.memberId === targetPoolId &&
      tx.date === latest.date &&
      tx.currency === latest.currency &&
      Math.abs(tx.amount - latest.amount) < 0.005 &&
      (tx.note ?? '').trim() === latestNote
    )
  })

  if (batch.length === 0) return null

  const perPersonUnits = toMinorUnits(latest.amount, latest.currency)
  const totalAmount = fromMinorUnits(perPersonUnits * batch.length, latest.currency)

  return {
    ids: batch.map((tx) => tx.id),
    count: batch.length,
    amountPerPerson: latest.amount,
    totalAmount,
    currency: latest.currency,
    date: latest.date,
  }
}

/** 抽出單筆交易中引用到、但專案成員清單已不存在的孤兒公費袋 ID（去重保序） */
export function extractMissingPoolMemberIdsFromTransaction(
  tx: Transaction,
  existingMemberIds: ReadonlySet<string>,
): string[] {
  if (!tx.splitConfig) return []
  const candidateIds: string[] = [
    tx.splitConfig.payerId,
    ...(tx.splitConfig.payers ?? [])
      .filter((p) => p.amount > 0)
      .map((p) => p.memberId),
    ...tx.splitConfig.shares
      .filter((s) => s.finalAmount > 0)
      .map((s) => s.memberId),
  ]
  const missing: string[] = []
  const seen = new Set<string>()
  for (const id of candidateIds) {
    if (isPoolMemberId(id) && !existingMemberIds.has(id) && !seen.has(id)) {
      seen.add(id)
      missing.push(id)
    }
  }
  return missing
}

/** 查找專案有效交易中是否遺留尚未掛回成員清單之孤兒公費袋 ID（例如先刪公費成員又復原紀錄） */
export function findOrphanedPoolMemberIdInTransactions(
  transactions: ReadonlyArray<Transaction>,
  projectId: string,
  existingMemberIds: ReadonlySet<string>,
): string | null {
  for (const tx of transactions) {
    if (tx.isDeleted || tx.projectId !== projectId || !tx.splitConfig) continue
    const missing = extractMissingPoolMemberIdsFromTransaction(tx, existingMemberIds)
    if (missing.length > 0) {
      return missing[0]
    }
  }
  return null
}
