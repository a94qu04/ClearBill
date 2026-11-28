import { computed, ref, toRaw } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import {
  CURRENT_SCHEMA_VERSION,
  type FeeBreakdown,
  type LedgerBackup,
  type Project,
  type ProjectMember,
  type ProjectSplitGroup,
  type SplitConfig,
  type SplitMode,
  type Transaction,
  type TransactionType,
} from '@/schemas/ledgerSchema'
import {
  enqueueSyncOutbox,
  normalVaultDb,
  saveProjectToNormalVault,
  saveTransactionToNormalVault,
} from '@/db/normalVaultDb'
import { cloneAsPlain } from '@/core/plainClone'
import {
  applySettlementRatesToTransactions,
  calculateSettleUp,
} from '@/core/settleUpEngine'
import type { LocalSettlementViewPrefs } from '@/core/settlementRateResolver'
import { sumProjectExpense } from '@/core/memberLedger'
import {
  migrateLoadedLedgerRecords,
  type QuarantinedRecord,
} from '@/core/migrationEngine'
import { assertSplitInvariant } from '@/core/splitInvariant'
import {
  collectRealtimeOutboxEntriesFromMerge,
  createLedgerBackupPayload,
  createSingleProjectBackupPayload,
  parseAndMergeLedgerBackup,
  type LedgerMergeStats,
} from '@/core/backupMergeEngine'
import {
  AVATAR_PALETTE,
  DEFAULT_MANAGED_CATEGORIES,
  INITIAL_CURRENCIES,
  PROJECT_CARD_PALETTE,
  sanitizeSplitConfigForMemory,
  useUserPrefsStore,
  type ManagedCategory,
} from '@/stores/userPrefsStore'
import { useSettlementViewStore } from '@/stores/settlementViewStore'
import {
  useGoogleDriveStore,
  type GoogleDriveSyncStatus,
} from '@/stores/googleDriveStore'
import {
  useRealtimeSyncStore,
  type PendingDeletionGuardAlert,
  type ProjectRealtimeSyncStatus,
} from '@/stores/realtimeSyncStore'
import { createPoolActions } from '@/stores/poolActions'
import { createTrashActions } from '@/stores/trashActions'

const ACTIVE_PROJECT_STORAGE_KEY = 'clearbill_active_project_id'

export {
  INITIAL_CURRENCIES,
  AVATAR_PALETTE,
  PROJECT_CARD_PALETTE,
  DEFAULT_MANAGED_CATEGORIES,
}
export type {
  ManagedCategory,
  ProjectRealtimeSyncStatus,
  GoogleDriveSyncStatus,
  PendingDeletionGuardAlert,
  LocalSettlementViewPrefs,
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export interface CreateProjectPayload {
  name: string
  baseCurrency: string
  memberNames: string[]
  defaultSplitMode?: SplitMode
  cardColor?: string
  cardCoverImage?: string
}

export interface UpdateProjectPayload {
  name?: string
  baseCurrency?: string
  defaultSplitMode?: SplitMode
  defaultPayerId?: string
  cardColor?: string | null
  cardCoverImage?: string | null
}

export interface CreateTransactionPayload {
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
  feeBreakdown?: FeeBreakdown
  splitConfig?: SplitConfig
}

export interface RecordSettlementPayload {
  projectId: string
  fromMemberId: string
  toMemberId: string
  amount: number
  currency: string
  exchangeRateToBase?: number
  date: string
  time?: string
  note?: string
}

export const useLedgerStore = defineStore('ledger', () => {
  // 領域子 Store
  const userPrefsStore = useUserPrefsStore()
  const settlementViewStore = useSettlementViewStore()
  const googleDriveStore = useGoogleDriveStore()
  const realtimeSyncStore = useRealtimeSyncStore()

  // 透傳各領域子 Store 之響應式狀態（使用 storeToRefs 保持對外響應式 API 完全一致）
  const {
    defaultCurrency,
    enabledCurrencies,
    categories,
    projectOrder,
    projectOrderUpdatedAt,
    lastExpenseProjectId,
    lastCurrencyByProject,
    lastSplitByProject,
    settlementViewByProject,
    userProfile,
    liveRatesCache,
    isRefreshingLiveRates,
    liveRatesFetchedAt,
    liveRatesSource,
    availableCurrencies,
  } = storeToRefs(userPrefsStore)

  const {
    googleDriveAccount,
    googleDriveAutoSync,
    googleDriveLastSyncAt,
    googleDriveDirty,
    googleDriveLastErrorCode,
    googleDriveLastErrorDetail,
    googleDriveStatus,
  } = storeToRefs(googleDriveStore)

  const {
    syncStatusByProject,
    lastSyncedAtByProject,
    outboxCountByProject,
    pendingDeletionGuard,
    pendingDeletionGuardCount,
  } = storeToRefs(realtimeSyncStore)

  // 帳本核心狀態
  const projects = ref<Project[]>([])
  const transactions = ref<Transaction[]>([])
  const quarantinedRecords = ref<QuarantinedRecord[]>([])
  const activeProjectId = ref<string | null>(null)
  const isLoaded = ref(false)
  const isStoragePersisted = ref(false)

  /** 將含 Vue Reactive Proxy 的資料深拷貝為純淨 Plain Object（採 structuredClone + toRaw，保留 undefined 與原生型別並避免 JSON 大字串序列化開銷） */
  function toPlainClone<T>(value: T): T {
    return cloneAsPlain(value, toRaw)
  }

  function persistActiveProjectId(id: string | null): void {
    if (typeof window === 'undefined') return
    try {
      if (id) {
        window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, id)
      } else {
        window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY)
      }
    } catch {
      // 忽略受限環境
    }
  }

  // 綁定領域子 Store 跨模組橋接（維持單向依賴、零循環）
  userPrefsStore.bindDriveDirtyHook(() => {
    googleDriveStore.markGoogleDriveDirty()
  })

  realtimeSyncStore.bindLedgerContext({
    projects,
    transactions,
    activeProjectId,
    projectOrder,
    userProfile,
    persistActiveProjectId,
    saveUserPrefs: userPrefsStore.saveUserPrefs,
    toPlainClone,
  })

  // ==================== 專案與交易衍生視圖 ====================
  /** 所有未刪除之專案（含已封存），供查詢與總額對照使用 */
  const allNonDeletedProjects = computed(() => {
    const orderIndex = new Map<string, number>()
    projectOrder.value.forEach((id, idx) => orderIndex.set(id, idx))

    return projects.value
      .filter((p) => !p.isDeleted)
      .sort((a, b) => {
        const idxA = orderIndex.get(a.id)
        const idxB = orderIndex.get(b.id)
        if (idxA !== undefined && idxB !== undefined) return idxA - idxB
        if (idxA !== undefined) return -1
        if (idxB !== undefined) return 1
        return b.updatedAt - a.updatedAt
      })
  })

  /** 進行中（未刪除且未封存）之專案清單 */
  const activeProjects = computed(() =>
    allNonDeletedProjects.value.filter((p) => !p.isArchived),
  )

  /** 已封存（結案歸檔）之專案清單 */
  const archivedProjects = computed(() =>
    allNonDeletedProjects.value.filter((p) => Boolean(p.isArchived)),
  )

  const activeProject = computed<Project | null>(() => {
    if (!activeProjectId.value) {
      return (
        activeProjects.value.find((p) => p.isActive) ??
        activeProjects.value[0] ??
        null
      )
    }
    return (
      allNonDeletedProjects.value.find((p) => p.id === activeProjectId.value) ??
      activeProjects.value[0] ??
      null
    )
  })

  const visibleTransactions = computed(() =>
    transactions.value
      .filter((tx) => !tx.isDeleted)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  )

  /** 最近刪除（回收桶）之專案清單，提供一鍵整批復原 */
  const deletedProjects = computed(() =>
    projects.value
      .filter((p) => Boolean(p.isDeleted))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  )

  /** 最近刪除（回收桶）清單，提供一鍵復原 */
  const deletedTransactions = computed(() =>
    transactions.value
      .filter((tx) => Boolean(tx.isDeleted))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  )

  const dailyTransactions = computed(() =>
    visibleTransactions.value.filter((tx) => !tx.projectId),
  )

  const activeProjectTransactions = computed(() => {
    const currentProject = activeProject.value
    if (!currentProject) return []
    return visibleTransactions.value.filter(
      (tx) => tx.projectId === currentProject.id,
    )
  })

  settlementViewStore.bindDataSource({
    findNonDeletedProject: (projectId) =>
      projects.value.find((p) => p.id === projectId && !p.isDeleted),
    getVisibleProjectTransactions: (projectId) =>
      visibleTransactions.value.filter((tx) => tx.projectId === projectId),
  })

  // ==================== 記帳記憶查詢（跨專案與偏好） ====================
  function getLatestExpenseTx(projectId?: string): Transaction | null {
    const activeSet = new Set(activeProjects.value.map((p) => p.id))
    let best: Transaction | null = null
    for (const tx of transactions.value) {
      if (tx.isDeleted || tx.type === 'transfer' || !tx.projectId) continue
      if (projectId) {
        if (tx.projectId !== projectId) continue
      } else if (!activeSet.has(tx.projectId)) {
        continue
      }
      if (
        !best ||
        tx.updatedAt > best.updatedAt ||
        (tx.updatedAt === best.updatedAt && tx.date > best.date)
      ) {
        best = tx
      }
    }
    return best
  }

  function getLastExpenseProject(): Project | null {
    const list = activeProjects.value
    if (list.length === 0) return null
    if (lastExpenseProjectId.value) {
      const remembered = list.find((p) => p.id === lastExpenseProjectId.value)
      if (remembered) return remembered
    }
    const latestTx = getLatestExpenseTx()
    if (latestTx) {
      const fromTx = list.find((p) => p.id === latestTx.projectId)
      if (fromTx) return fromTx
    }
    if (
      activeProject.value &&
      list.some((p) => p.id === activeProject.value?.id)
    ) {
      return activeProject.value
    }
    return list[0] ?? null
  }

  function getProjectLastCurrency(
    projectId: string,
    fallbackCurrency: string,
  ): string {
    const remembered = lastCurrencyByProject.value[projectId]
    if (remembered && /^[A-Z]{3}$/.test(remembered)) {
      return remembered
    }
    const latestTx = getLatestExpenseTx(projectId)
    if (latestTx && /^[A-Z]{3}$/.test(latestTx.currency.trim().toUpperCase())) {
      return latestTx.currency.trim().toUpperCase()
    }
    return fallbackCurrency.trim().toUpperCase()
  }

  function getProjectLastSplitConfig(projectId: string): SplitConfig | null {
    const proj = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!proj) return null
    const latestSplitConfig = getLatestExpenseTx(projectId)?.splitConfig
    const raw =
      lastSplitByProject.value[projectId] ??
      (latestSplitConfig ? sanitizeSplitConfigForMemory(latestSplitConfig) : null)
    if (!raw) return null
    const memberIds = new Set(proj.members.map((m) => m.id))
    const validShares = raw.shares.filter((s) => memberIds.has(s.memberId))
    if (validShares.length === 0) return null
    const resolvedPayerId = memberIds.has(raw.payerId)
      ? raw.payerId
      : proj.defaultPayerId && memberIds.has(proj.defaultPayerId)
        ? proj.defaultPayerId
        : proj.members[0]?.id ?? raw.payerId
    return {
      payerId: resolvedPayerId,
      mode: raw.mode,
      shares: validShares.map((s) => ({ ...s })),
    }
  }

  /** 當使用者主動切換「公費優先墊付」或在設定頁改「預設墊付人」時，同步更新該專案記憶之墊付人 */
  function syncRememberedPayerForProject(
    projectId: string,
    nextPayerId: string | undefined,
  ): void {
    if (!projectId || !nextPayerId) return
    const base = getProjectLastSplitConfig(projectId)
    if (!base) return
    if (lastSplitByProject.value[projectId]?.payerId === nextPayerId) return
    lastSplitByProject.value = {
      ...lastSplitByProject.value,
      [projectId]: {
        ...base,
        payerId: nextPayerId,
      },
    }
    userPrefsStore.saveUserPrefs()
  }

  // ==================== 公費與回收桶模組掛載 ====================
  const poolActions = createPoolActions({
    projects,
    transactions,
    getEffectiveExchangeRate: userPrefsStore.getEffectiveExchangeRate,
    addTransaction,
    updateTransaction,
    syncRememberedPayerForProject,
    enqueueAndFlushProjectChange: realtimeSyncStore.enqueueAndFlushProjectChange,
    markGoogleDriveDirty: googleDriveStore.markGoogleDriveDirty,
    toPlainClone,
  })

  const trashActions = createTrashActions({
    projects,
    transactions,
    activeProjectId,
    activeProject,
    activeProjects,
    deletedProjects,
    deletedTransactions,
    projectOrder,
    persistActiveProjectId,
    saveUserPrefs: userPrefsStore.saveUserPrefs,
    unsubscribeProjectRealtime: realtimeSyncStore.unsubscribeProjectRealtime,
    refreshOutboxCounts: realtimeSyncStore.refreshOutboxCounts,
    enqueueAndFlushProjectChange: realtimeSyncStore.enqueueAndFlushProjectChange,
    markGoogleDriveDirty: googleDriveStore.markGoogleDriveDirty,
    toPlainClone,
  })

  // ==================== 專案結算與統計視圖 ====================
  /** 專案內消費/退款支出（不含還款與繳公費 transfer，避免累計總支出與圓餅圖重複計算） */
  const activeProjectExpenses = computed(() =>
    activeProjectTransactions.value.filter((tx) => tx.type !== 'transfer'),
  )

  /** 專案「明細」分頁顯示清單：含所有消費／退款與繳公費紀錄（不含單純個人間還款） */
  const activeProjectEntriesWithPool = computed(() =>
    activeProjectTransactions.value.filter(
      (tx) =>
        tx.type !== 'transfer' ||
        poolActions.isPoolCollectionTransaction(tx, activeProject.value),
    ),
  )

  /** 專案內已記錄的還款轉帳明細（type === 'transfer'） */
  const activeProjectSettlements = computed(() =>
    activeProjectTransactions.value.filter((tx) => tx.type === 'transfer'),
  )

  /** 專案內依當前結帳幣別與結算匯率模式套用換算後之消費清單（供圓餅圖、結算與報表 100% 同步一致） */
  const activeProjectEffectiveExpenses = computed(() => {
    const proj = activeProject.value
    if (!proj) return []
    const { settlementCurrency, options } =
      settlementViewStore.getProjectSettlementOptions(
        proj,
        activeProjectTransactions.value,
      )
    return applySettlementRatesToTransactions(
      activeProjectExpenses.value,
      settlementCurrency,
      options.overrideRatesByCurrency,
      options.projectBaseCurrency,
      options.baseToSettlementRate,
    )
  })

  const activeProjectSettleUp = computed(() => {
    const proj = activeProject.value
    if (!proj) return null
    const { settlementCurrency, options } =
      settlementViewStore.getProjectSettlementOptions(
        proj,
        activeProjectTransactions.value,
      )
    return calculateSettleUp(
      activeProjectTransactions.value,
      settlementCurrency,
      proj.members.map((m) => m.id),
      options,
    )
  })

  /** 以專案記帳主幣別（baseCurrency）＋各筆原始匯率計算的結算對照（供結算頁跨幣別結帳時小標示主幣別原額） */
  const activeProjectBaseSettleUp = computed(() => {
    const proj = activeProject.value
    if (!proj) return null
    return calculateSettleUp(
      activeProjectTransactions.value,
      proj.baseCurrency,
      proj.members.map((m) => m.id),
    )
  })

  /** 各專案累計淨消費總額對照表（明確採 per_tx 原始匯率口徑換算至專案主幣別 baseCurrency，供首頁小卡與頂部標頭顯示） */
  const projectTotalExpenseMap = computed<Record<string, number>>(() => {
    const txByProject = new Map<string, Transaction[]>()
    for (const tx of visibleTransactions.value) {
      if (!tx.projectId) continue
      const list = txByProject.get(tx.projectId)
      if (list) list.push(tx)
      else txByProject.set(tx.projectId, [tx])
    }

    const result: Record<string, number> = {}
    for (const proj of allNonDeletedProjects.value) {
      const projTxs = txByProject.get(proj.id) ?? []
      result[proj.id] =
        projTxs.length === 0 ? 0 : sumProjectExpense(projTxs, proj.baseCurrency)
    }
    return result
  })

  function getProjectTotalExpense(projectId: string): number {
    return projectTotalExpenseMap.value[projectId] ?? 0
  }

  function getProjectTransactionCount(projectId: string): number {
    return visibleTransactions.value.filter((tx) => tx.projectId === projectId)
      .length
  }

  function getProjectById(projectId: string | undefined): Project | null {
    if (!projectId) return null
    return allNonDeletedProjects.value.find((p) => p.id === projectId) ?? null
  }

  function getAnyProjectById(projectId: string | undefined): Project | null {
    if (!projectId) return null
    return projects.value.find((p) => p.id === projectId) ?? null
  }

  function reorderProjects(sourceId: string, targetId: string): void {
    if (!sourceId || !targetId || sourceId === targetId) return
    const currentIds = activeProjects.value.map((p) => p.id)
    const fromIdx = currentIds.indexOf(sourceId)
    const toIdx = currentIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return

    const next = [...currentIds]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    projectOrder.value = next
    projectOrderUpdatedAt.value = Date.now()
    userPrefsStore.saveUserPrefs()
    googleDriveStore.markGoogleDriveDirty()
  }

  function moveProjectOrder(
    projectId: string,
    direction: 'up' | 'down',
  ): boolean {
    const currentIds = activeProjects.value.map((p) => p.id)
    const idx = currentIds.indexOf(projectId)
    if (idx === -1) return false

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= currentIds.length) return false

    const next = [...currentIds]
    const [moved] = next.splice(idx, 1)
    next.splice(targetIdx, 0, moved)
    projectOrder.value = next
    projectOrderUpdatedAt.value = Date.now()
    userPrefsStore.saveUserPrefs()
    googleDriveStore.markGoogleDriveDirty()
    return true
  }

  async function updateUserProfile(
    patch: {
      displayName?: string
      avatarColor?: string
      avatarImage?: string | null
      paymentInfo?: string | null
    },
    options?: { applyToExistingProjects?: boolean },
  ): Promise<number> {
    const next = userPrefsStore.applyUserProfilePatch(patch)

    let updatedProjectsCount = 0
    if (options?.applyToExistingProjects) {
      const nonDeleted = projects.value.filter((p) => !p.isDeleted)
      for (const proj of nonDeleted) {
        const myId =
          proj.syncMeta?.myMemberId ||
          proj.defaultPayerId ||
          proj.members[0]?.id
        if (!myId) continue
        const targetMember = proj.members.find((m) => m.id === myId)
        if (!targetMember) continue
        await updateProjectMember(proj.id, myId, {
          name: next.displayName || targetMember.name,
          avatarColor: next.avatarColor,
          avatarImage: next.avatarImage ?? null,
          paymentInfo: next.paymentInfo ?? null,
        })
        updatedProjectsCount += 1
      }
    }
    return updatedProjectsCount
  }

  // ==================== IndexedDB 初始化與專案／成員 CRUD ====================
  async function initFromIndexedDb(): Promise<void> {
    if (isLoaded.value) return
    try {
      const [rawProjects, rawTransactions] = await Promise.all([
        normalVaultDb.projects.toArray(),
        normalVaultDb.transactions.toArray(),
      ])
      const migrated = migrateLoadedLedgerRecords(rawProjects, rawTransactions)
      projects.value = migrated.projects
      transactions.value = migrated.transactions
      quarantinedRecords.value = migrated.quarantined
      settlementViewStore.migrateLegacyProjectViews(migrated.projects)

      if (migrated.quarantined.length > 0) {
        console.warn(
          `[ClearBill] 載入本機資料庫時隔離了 ${migrated.quarantined.length} 筆無法遷移的異常紀錄`,
          migrated.quarantined.map((item) => ({
            entityType: item.entityType,
            id: item.id,
            error: item.error,
          })),
        )
      }

      // 若有舊版（如 v0）資料完成升級，靜默回寫 IndexedDB 完成落盤遷移（不改動既有 updatedAt）
      if (
        migrated.upgradedProjects.length > 0 ||
        migrated.upgradedTransactions.length > 0
      ) {
        await Promise.all([
          migrated.upgradedProjects.length > 0
            ? normalVaultDb.projects.bulkPut(migrated.upgradedProjects)
            : Promise.resolve(),
          migrated.upgradedTransactions.length > 0
            ? normalVaultDb.transactions.bulkPut(migrated.upgradedTransactions)
            : Promise.resolve(),
        ]).catch((err) => {
          console.warn(
            '[ClearBill] 回寫遷移後之本機資料失敗，下次啟動將重新遷移',
            err,
          )
        })
      }

      await realtimeSyncStore.refreshOutboxCounts()

      const savedId =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)
          : null
      const savedStillActive = savedId
        ? migrated.projects.find((p) => p.id === savedId && !p.isDeleted)
        : undefined
      const fallbackActive = migrated.projects
        .filter((p) => !p.isDeleted && p.isActive)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]

      activeProjectId.value = savedStillActive?.id ?? fallbackActive?.id ?? null
    } finally {
      isLoaded.value = true
    }
  }

  function setStoragePersisted(persisted: boolean): void {
    isStoragePersisted.value = persisted
  }

  async function createProject(payload: CreateProjectPayload): Promise<Project> {
    const now = Date.now()
    const members: ProjectMember[] = payload.memberNames
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name, idx) => {
        const isFirstSelf = idx === 0
        const profile = userProfile.value
        return {
          id: `m_${idx + 1}_${now.toString(36)}`,
          name,
          avatarColor:
            isFirstSelf && profile.avatarColor
              ? profile.avatarColor
              : AVATAR_PALETTE[idx % AVATAR_PALETTE.length],
          ...(isFirstSelf && profile.avatarImage
            ? { avatarImage: profile.avatarImage }
            : {}),
          ...(isFirstSelf && profile.paymentInfo
            ? { paymentInfo: profile.paymentInfo }
            : {}),
        }
      })

    const project: Project = {
      id: generateUuid(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      name: payload.name.trim(),
      baseCurrency: payload.baseCurrency.trim().toUpperCase(),
      members,
      defaultSplitMode: payload.defaultSplitMode ?? 'equal',
      defaultPayerId: members[0]?.id,
      isActive: true,
      ...(payload.cardColor ? { cardColor: payload.cardColor } : {}),
      ...(payload.cardCoverImage
        ? { cardCoverImage: payload.cardCoverImage }
        : {}),
      createdAt: now,
      updatedAt: now,
    }

    const saved = await saveProjectToNormalVault(project)
    projects.value = [saved, ...projects.value]
    projectOrder.value = [
      saved.id,
      ...projectOrder.value.filter((id) => id !== saved.id),
    ]
    projectOrderUpdatedAt.value = Date.now()
    userPrefsStore.saveUserPrefs()
    activeProjectId.value = saved.id
    persistActiveProjectId(saved.id)
    googleDriveStore.markGoogleDriveDirty()
    return saved
  }

  async function updateProject(
    projectId: string,
    patch: UpdateProjectPayload,
  ): Promise<Project | null> {
    const existing = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return null

    const nextCardColor =
      patch.cardColor === null
        ? undefined
        : patch.cardColor !== undefined
          ? patch.cardColor.trim() || undefined
          : existing.cardColor
    const nextCardCoverImage =
      patch.cardCoverImage === null
        ? undefined
        : patch.cardCoverImage !== undefined
          ? patch.cardCoverImage
          : existing.cardCoverImage

    const oldBase = existing.baseCurrency.trim().toUpperCase()
    const nextBase =
      patch.baseCurrency !== undefined
        ? patch.baseCurrency.trim().toUpperCase()
        : oldBase
    const baseCurrencyChanged = nextBase !== oldBase
    const nextName = patch.name !== undefined ? patch.name.trim() : existing.name
    const nextDefaultSplitMode =
      patch.defaultSplitMode ?? existing.defaultSplitMode
    const sharedFieldsChanged =
      nextName !== existing.name ||
      baseCurrencyChanged ||
      nextDefaultSplitMode !== existing.defaultSplitMode ||
      nextCardColor !== existing.cardColor ||
      nextCardCoverImage !== existing.cardCoverImage
    const now = Date.now()

    // defaultPayerId 屬本機裝置偏好；若本次僅調整預設墊付人而未改動任何共享欄位，
    // 僅更新本機 IndexedDB，不遞增 updatedAt 亦不推播雲端，避免與多人協作遠端更新衝突
    const updated: Project = {
      ...existing,
      name: nextName,
      baseCurrency: nextBase,
      defaultSplitMode: nextDefaultSplitMode,
      defaultPayerId: patch.defaultPayerId ?? existing.defaultPayerId,
      cardColor: nextCardColor,
      cardCoverImage: nextCardCoverImage,
      members: existing.members.map((m) => ({ ...m })),
      updatedAt: sharedFieldsChanged ? now : existing.updatedAt,
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    if (patch.defaultPayerId && patch.defaultPayerId !== existing.defaultPayerId) {
      syncRememberedPayerForProject(projectId, patch.defaultPayerId)
    }

    if (!sharedFieldsChanged) {
      return saved
    }

    // 變更專案記帳主幣別時，自動依舊主幣別➔新主幣別匯率重算既有交易之 exchangeRateToBase（保留原幣金額不毀帳）
    if (baseCurrencyChanged) {
      const oldToNewRate = userPrefsStore.getEffectiveExchangeRate(
        oldBase,
        nextBase,
      )
      if (
        oldToNewRate !== null &&
        Number.isFinite(oldToNewRate) &&
        oldToNewRate > 0
      ) {
        const affected = transactions.value.filter(
          (tx) => tx.projectId === projectId && !tx.isDeleted,
        )
        const updatedMap = new Map<string, Transaction>()
        for (const tx of affected) {
          const txCur = tx.currency.trim().toUpperCase()
          let nextRate: number
          if (txCur === nextBase) {
            nextRate = 1
          } else if (txCur === oldBase) {
            nextRate = Number(oldToNewRate.toFixed(6))
          } else {
            const origToOld = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
            nextRate = Number((origToOld * oldToNewRate).toFixed(6))
          }
          if (!Number.isFinite(nextRate) || nextRate <= 0) {
            nextRate = 1
          }
          const updatedTx: Transaction = {
            ...tx,
            exchangeRateToBase: nextRate,
            updatedAt: now,
          }
          const savedTx = await saveTransactionToNormalVault(updatedTx)
          updatedMap.set(savedTx.id, savedTx)
          await realtimeSyncStore.enqueueAndFlushProjectChange(
            projectId,
            'transaction',
            savedTx.id,
            savedTx.updatedAt,
          )
        }
        if (updatedMap.size > 0) {
          transactions.value = transactions.value.map(
            (tx) => updatedMap.get(tx.id) ?? tx,
          )
        }
      }
    }

    await realtimeSyncStore.enqueueAndFlushProjectChange(
      projectId,
      'project',
      saved.id,
      saved.updatedAt,
    )
    googleDriveStore.markGoogleDriveDirty()
    return saved
  }

  function hasDuplicateMemberName(
    projectId: string,
    candidateName: string,
    excludeMemberId?: string,
  ): boolean {
    const normalized = candidateName.trim().toLowerCase()
    if (!normalized) return false
    const existing = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return false
    return existing.members.some(
      (m) =>
        m.id !== excludeMemberId && m.name.trim().toLowerCase() === normalized,
    )
  }

  async function addProjectMember(
    projectId: string,
    memberName: string,
    avatarColor?: string,
    avatarImage?: string,
  ): Promise<Project | null> {
    const existing = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    const trimmed = memberName.trim()
    if (!existing || !trimmed) return null
    if (hasDuplicateMemberName(projectId, trimmed)) return null

    const now = Date.now()
    const newMember: ProjectMember = {
      id: `m_${existing.members.length + 1}_${now.toString(36)}`,
      name: trimmed,
      avatarColor:
        avatarColor ||
        AVATAR_PALETTE[existing.members.length % AVATAR_PALETTE.length],
      ...(avatarImage ? { avatarImage } : {}),
    }

    const updated: Project = {
      ...existing,
      members: [...existing.members.map((m) => ({ ...m })), newMember],
      updatedAt: now,
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await realtimeSyncStore.enqueueAndFlushProjectChange(
      projectId,
      'project',
      saved.id,
      saved.updatedAt,
    )
    googleDriveStore.markGoogleDriveDirty()
    return saved
  }

  async function updateProjectMember(
    projectId: string,
    memberId: string,
    patch: {
      name?: string
      avatarColor?: string
      avatarImage?: string | null
      paymentInfo?: string | null
    },
  ): Promise<Project | null> {
    const existing = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return null
    if (
      patch.name !== undefined &&
      patch.name.trim() &&
      hasDuplicateMemberName(projectId, patch.name, memberId)
    ) {
      return null
    }

    const nextMembers = existing.members.map((m) => {
      if (m.id !== memberId) return { ...m }
      const nextAvatarImage =
        patch.avatarImage === null
          ? undefined
          : patch.avatarImage !== undefined
            ? patch.avatarImage
            : m.avatarImage
      const nextPaymentInfo =
        patch.paymentInfo === null
          ? undefined
          : patch.paymentInfo !== undefined
            ? patch.paymentInfo.trim().slice(0, 120) || undefined
            : m.paymentInfo
      return {
        ...m,
        name: patch.name !== undefined ? patch.name.trim() || m.name : m.name,
        avatarColor: patch.avatarColor ?? m.avatarColor,
        ...(nextAvatarImage
          ? { avatarImage: nextAvatarImage }
          : { avatarImage: undefined }),
        ...(nextPaymentInfo
          ? { paymentInfo: nextPaymentInfo }
          : { paymentInfo: undefined }),
      }
    })

    const updated: Project = {
      ...existing,
      members: nextMembers,
      updatedAt: Date.now(),
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await realtimeSyncStore.enqueueAndFlushProjectChange(
      projectId,
      'project',
      saved.id,
      saved.updatedAt,
    )
    googleDriveStore.markGoogleDriveDirty()
    return saved
  }

  function isMemberUsedInProjectTransactions(
    projectId: string,
    memberId: string,
  ): boolean {
    return transactions.value.some((tx) => {
      // 連同回收桶中尚未永久刪除的交易一併檢查，避免刪除成員後復原交易出現裸露孤兒 ID
      if (tx.projectId !== projectId || !tx.splitConfig) {
        return false
      }
      if (tx.splitConfig.payerId === memberId) return true
      if (
        tx.splitConfig.payers?.some(
          (p) => p.memberId === memberId && p.amount > 0,
        )
      ) {
        return true
      }
      return tx.splitConfig.shares.some(
        (s) => s.memberId === memberId && s.finalAmount > 0,
      )
    })
  }

  async function removeProjectMember(
    projectId: string,
    memberId: string,
  ): Promise<{ ok: boolean; reason?: 'last_member' | 'in_use' }> {
    const existing = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return { ok: false }

    const targetMember = existing.members.find((m) => m.id === memberId)
    if (!targetMember) return { ok: false }

    const humanMemberCount = existing.members.filter((m) => !m.isPool).length
    if (
      existing.members.length <= 1 ||
      (!targetMember.isPool && humanMemberCount <= 1)
    ) {
      return { ok: false, reason: 'last_member' }
    }

    if (isMemberUsedInProjectTransactions(projectId, memberId)) {
      return { ok: false, reason: 'in_use' }
    }

    const remainingMembers = existing.members
      .filter((m) => m.id !== memberId)
      .map((m) => ({ ...m }))

    const nextDefaultPayer =
      existing.defaultPayerId === memberId
        ? remainingMembers.find((m) => !m.isPool)?.id ?? remainingMembers[0]?.id
        : existing.defaultPayerId

    const cleanedSplitGroups = existing.splitGroups
      ?.map((g) => ({
        ...g,
        memberIds: g.memberIds.filter((id) => id !== memberId),
      }))
      .filter((g) => g.memberIds.length > 0)

    const now = Date.now()
    const baseExisting = toPlainClone(existing)
    const nextSyncMeta = baseExisting.syncMeta
      ? {
          ...baseExisting.syncMeta,
          myMemberId:
            baseExisting.syncMeta.myMemberId === memberId
              ? undefined
              : baseExisting.syncMeta.myMemberId,
        }
      : undefined
    const updated: Project = {
      ...baseExisting,
      members: remainingMembers,
      defaultPayerId: nextDefaultPayer,
      syncMeta: nextSyncMeta,
      splitGroups:
        cleanedSplitGroups && cleanedSplitGroups.length > 0
          ? cleanedSplitGroups
          : undefined,
      updatedAt: now,
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))

    // 順手清理既有交易中該已刪除成員的 0 元分攤殘留（避免日後匯出或對帳出現幽靈成員 ID）
    const txsWithZeroShare = transactions.value.filter(
      (tx) =>
        !tx.isDeleted &&
        tx.projectId === projectId &&
        tx.splitConfig?.shares.some(
          (s) => s.memberId === memberId && s.finalAmount === 0,
        ),
    )
    if (txsWithZeroShare.length > 0) {
      const cleanedTxMap = new Map<string, Transaction>()
      for (const tx of txsWithZeroShare) {
        if (!tx.splitConfig) continue
        const nextShares = tx.splitConfig.shares.filter(
          (s) => !(s.memberId === memberId && s.finalAmount === 0),
        )
        if (nextShares.length === 0) continue
        const plainTx = toPlainClone(tx)
        if (!plainTx.splitConfig) continue
        const cleanedTx: Transaction = {
          ...plainTx,
          splitConfig: {
            ...plainTx.splitConfig,
            shares: nextShares,
          },
          updatedAt: now,
        }
        const savedTx = await saveTransactionToNormalVault(cleanedTx)
        cleanedTxMap.set(savedTx.id, savedTx)
        await realtimeSyncStore.enqueueAndFlushProjectChange(
          projectId,
          'transaction',
          savedTx.id,
          savedTx.updatedAt,
        )
      }
      if (cleanedTxMap.size > 0) {
        transactions.value = transactions.value.map(
          (tx) => cleanedTxMap.get(tx.id) ?? tx,
        )
      }
    }

    await realtimeSyncStore.enqueueAndFlushProjectChange(
      projectId,
      'project',
      saved.id,
      saved.updatedAt,
    )
    googleDriveStore.markGoogleDriveDirty()
    return { ok: true }
  }

  async function toggleArchiveProject(
    projectId: string,
  ): Promise<Project | null> {
    const existing = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return null

    const nextArchived = !existing.isArchived
    const updated: Project = {
      ...existing,
      isArchived: nextArchived,
      isActive: !nextArchived,
      members: existing.members.map((m) => ({ ...m })),
      updatedAt: Date.now(),
    }
    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))

    if (nextArchived && activeProjectId.value === projectId) {
      const next = activeProjects.value[0]?.id ?? null
      activeProjectId.value = next
      persistActiveProjectId(next)
    } else if (!nextArchived) {
      activeProjectId.value = saved.id
      persistActiveProjectId(saved.id)
    }
    googleDriveStore.markGoogleDriveDirty()
    return saved
  }

  async function createDemoProject(labels: {
    projectName: string
    members: [string, string, string]
    hotelNote: string
    dinnerNote: string
    shoppingNote: string
    taxRefundNote: string
    repaymentNote: string
  }): Promise<Project> {
    const proj = await createProject({
      name: labels.projectName,
      baseCurrency: 'TWD',
      memberNames: labels.members,
      defaultSplitMode: 'equal',
    })

    const [m1, m2, m3] = proj.members
    const today = new Date()
    const fmtDate = (offsetDays: number) => {
      const d = new Date(today.getTime() - offsetDays * 86400000)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    // 1. 住宿（台幣，m1 墊付，三人均攤）
    await addTransaction({
      projectId: proj.id,
      type: 'expense',
      amount: 9600,
      currency: 'TWD',
      exchangeRateToBase: 1,
      categoryKey: 'cat_lodging',
      date: fmtDate(2),
      time: '15:00',
      note: labels.hotelNote,
      splitConfig: {
        payerId: m1.id,
        mode: 'equal',
        shares: [
          { memberId: m1.id, finalAmount: 3200, customAmount: 0, isIncludedInRemainder: true },
          { memberId: m2.id, finalAmount: 3200, customAmount: 0, isIncludedInRemainder: true },
          { memberId: m3.id, finalAmount: 3200, customAmount: 0, isIncludedInRemainder: true },
        ],
      },
    })

    // 2. 燒肉晚餐（日圓外幣，m2 墊付，混合拆帳：m3 多點酒 2000，其餘均攤）
    await addTransaction({
      projectId: proj.id,
      type: 'expense',
      amount: 14000,
      currency: 'JPY',
      exchangeRateToBase: 0.215,
      categoryKey: 'cat_food',
      date: fmtDate(1),
      time: '19:30',
      note: labels.dinnerNote,
      splitConfig: {
        payerId: m2.id,
        mode: 'custom_plus_equal',
        shares: [
          { memberId: m1.id, finalAmount: 4000, customAmount: 0, isIncludedInRemainder: true },
          { memberId: m2.id, finalAmount: 4000, customAmount: 0, isIncludedInRemainder: true },
          { memberId: m3.id, finalAmount: 6000, customAmount: 2000, isIncludedInRemainder: true },
        ],
      },
    })

    // 3. 藥妝購物（日圓，m1 墊付，m1 與 m2 平分）
    await addTransaction({
      projectId: proj.id,
      type: 'expense',
      amount: 10000,
      currency: 'JPY',
      exchangeRateToBase: 0.215,
      categoryKey: 'cat_shopping',
      date: fmtDate(0),
      time: '14:20',
      note: labels.shoppingNote,
      splitConfig: {
        payerId: m1.id,
        mode: 'equal',
        shares: [
          { memberId: m1.id, finalAmount: 5000, customAmount: 0, isIncludedInRemainder: true },
          { memberId: m2.id, finalAmount: 5000, customAmount: 0, isIncludedInRemainder: true },
          { memberId: m3.id, finalAmount: 0, customAmount: 0, isIncludedInRemainder: false },
        ],
      },
    })

    // 4. 退稅退款（日圓退款，退給 m1，m1 與 m2 平分）
    await addTransaction({
      projectId: proj.id,
      type: 'refund',
      amount: 1000,
      currency: 'JPY',
      exchangeRateToBase: 0.215,
      categoryKey: 'cat_shopping',
      date: fmtDate(0),
      time: '14:35',
      note: labels.taxRefundNote,
      splitConfig: {
        payerId: m1.id,
        mode: 'equal',
        shares: [
          { memberId: m1.id, finalAmount: 500, customAmount: 0, isIncludedInRemainder: true },
          { memberId: m2.id, finalAmount: 500, customAmount: 0, isIncludedInRemainder: true },
          { memberId: m3.id, finalAmount: 0, customAmount: 0, isIncludedInRemainder: false },
        ],
      },
    })

    // 5. 部分還款範例（m3 先轉給 m1 2000）
    await recordSettlementPayment({
      projectId: proj.id,
      fromMemberId: m3.id,
      toMemberId: m1.id,
      amount: 2000,
      currency: 'TWD',
      date: fmtDate(0),
      note: labels.repaymentNote,
    })

    return proj
  }

  function selectProject(projectId: string | null): void {
    activeProjectId.value = projectId
    persistActiveProjectId(projectId)
  }

  function resolveCurrentEditorName(projectId?: string): string | undefined {
    if (projectId) {
      const proj = projects.value.find((p) => p.id === projectId)
      const myId = proj?.syncMeta?.myMemberId || proj?.defaultPayerId
      const memberName = myId
        ? proj?.members.find((m) => m.id === myId)?.name?.trim()
        : undefined
      if (memberName) return memberName.slice(0, 50)
    }
    const profileName = userProfile.value.displayName.trim()
    return profileName ? profileName.slice(0, 50) : undefined
  }

  // ==================== 交易新增、更新與還款 ====================
  async function addTransaction(
    payload: CreateTransactionPayload,
  ): Promise<Transaction> {
    const now = Date.now()
    const cleanLinks =
      payload.links && payload.links.length > 0
        ? payload.links.slice(0, 3)
        : undefined
    const cleanImages =
      payload.receiptImages && payload.receiptImages.length > 0
        ? payload.receiptImages.slice(0, 3)
        : undefined
    const editorName = resolveCurrentEditorName(payload.projectId)

    const tx: Transaction = {
      id: generateUuid(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projectId: payload.projectId,
      vaultLevel: 'normal',
      type: payload.type ?? 'expense',
      amount: payload.amount,
      currency: payload.currency.trim().toUpperCase(),
      exchangeRateToBase: payload.exchangeRateToBase ?? 1,
      categoryKey: payload.categoryKey,
      date: payload.date,
      time: payload.time && payload.time.trim() !== '' ? payload.time : '00:00',
      updatedAt: now,
      note: payload.note?.trim() || undefined,
      links: cleanLinks,
      receiptImages: cleanImages,
      isReimbursable: payload.isReimbursable,
      ...(editorName ? { lastEditedBy: editorName } : {}),
      ...(payload.feeBreakdown ? { feeBreakdown: payload.feeBreakdown } : {}),
      splitConfig: payload.splitConfig,
    }

    assertSplitInvariant(tx)
    const saved = await saveTransactionToNormalVault(tx)
    transactions.value = [saved, ...transactions.value]
    await realtimeSyncStore.enqueueAndFlushProjectChange(
      saved.projectId,
      'transaction',
      saved.id,
      saved.updatedAt,
    )
    googleDriveStore.markGoogleDriveDirty()
    return saved
  }

  async function saveProjectSplitGroup(
    projectId: string,
    name: string,
    memberIds: string[],
  ): Promise<ProjectSplitGroup | null> {
    const existing = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return null
    const trimmed = name.trim().slice(0, 32)
    const validIds = new Set(existing.members.map((m) => m.id))
    const cleanIds = Array.from(
      new Set(memberIds.filter((id) => validIds.has(id))),
    )
    if (!trimmed || cleanIds.length === 0) return null

    const currentGroups = existing.splitGroups
      ? existing.splitGroups.map((g) => ({ ...g, memberIds: [...g.memberIds] }))
      : []
    const existingIdx = currentGroups.findIndex(
      (g) => g.name.toLowerCase() === trimmed.toLowerCase(),
    )
    let savedGroup: ProjectSplitGroup
    if (existingIdx >= 0) {
      savedGroup = {
        ...currentGroups[existingIdx],
        name: trimmed,
        memberIds: cleanIds,
      }
      currentGroups[existingIdx] = savedGroup
    } else {
      if (currentGroups.length >= 20) return null
      savedGroup = {
        id: `grp_${Date.now().toString(36)}`,
        name: trimmed,
        memberIds: cleanIds,
      }
      currentGroups.push(savedGroup)
    }

    const baseExisting = toPlainClone(existing)
    const updated: Project = {
      ...baseExisting,
      splitGroups: currentGroups,
      members: baseExisting.members.map((m) => ({ ...m })),
      updatedAt: Date.now(),
    }
    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await realtimeSyncStore.enqueueAndFlushProjectChange(
      projectId,
      'project',
      saved.id,
      saved.updatedAt,
    )
    googleDriveStore.markGoogleDriveDirty()
    return savedGroup
  }

  async function removeProjectSplitGroup(
    projectId: string,
    groupId: string,
  ): Promise<void> {
    const existing = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing || !existing.splitGroups?.length) return

    const nextGroups = existing.splitGroups.filter((g) => g.id !== groupId)
    const baseExisting = toPlainClone(existing)
    const updated: Project = {
      ...baseExisting,
      splitGroups: nextGroups.length > 0 ? nextGroups : undefined,
      members: baseExisting.members.map((m) => ({ ...m })),
      updatedAt: Date.now(),
    }
    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await realtimeSyncStore.enqueueAndFlushProjectChange(
      projectId,
      'project',
      saved.id,
      saved.updatedAt,
    )
    googleDriveStore.markGoogleDriveDirty()
  }

  async function recordSettlementPayment(
    payload: RecordSettlementPayload,
  ): Promise<Transaction> {
    const proj = projects.value.find((p) => p.id === payload.projectId)
    const payCurrency = payload.currency.trim().toUpperCase()
    const baseCurrency = proj?.baseCurrency.trim().toUpperCase() ?? payCurrency
    const resolvedRate =
      payload.exchangeRateToBase && payload.exchangeRateToBase > 0
        ? payload.exchangeRateToBase
        : payCurrency === baseCurrency
          ? 1
          : userPrefsStore.getEffectiveExchangeRate(payCurrency, baseCurrency)
    if (
      resolvedRate === null ||
      !Number.isFinite(resolvedRate) ||
      resolvedRate <= 0
    ) {
      throw new Error('ERR_EXCHANGE_RATE_REQUIRED')
    }
    const effectiveRate = resolvedRate

    return addTransaction({
      projectId: payload.projectId,
      type: 'transfer',
      amount: payload.amount,
      currency: payCurrency,
      exchangeRateToBase: effectiveRate,
      categoryKey: 'cat_settlement',
      date: payload.date,
      time: payload.time || '00:00',
      note: payload.note,
      splitConfig: {
        payerId: payload.fromMemberId,
        mode: 'custom_plus_equal',
        shares: [
          {
            memberId: payload.toMemberId,
            finalAmount: payload.amount,
            customAmount: payload.amount,
            isIncludedInRemainder: false,
          },
        ],
      },
    })
  }

  async function updateTransaction(
    id: string,
    payload: CreateTransactionPayload,
  ): Promise<Transaction | null> {
    const existing = transactions.value.find((tx) => tx.id === id)
    if (!existing) return null

    const cleanLinks =
      payload.links && payload.links.length > 0
        ? payload.links.slice(0, 3)
        : undefined
    const cleanImages =
      payload.receiptImages && payload.receiptImages.length > 0
        ? payload.receiptImages.slice(0, 3)
        : undefined

    const editorName = resolveCurrentEditorName(
      payload.projectId ?? existing.projectId,
    )

    const updated: Transaction = {
      ...existing,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projectId: payload.projectId,
      type: payload.type ?? existing.type,
      amount: payload.amount,
      currency: payload.currency.trim().toUpperCase(),
      exchangeRateToBase:
        payload.exchangeRateToBase ?? existing.exchangeRateToBase,
      categoryKey: payload.categoryKey,
      date: payload.date,
      time: payload.time && payload.time.trim() !== '' ? payload.time : '00:00',
      updatedAt: Date.now(),
      note: payload.note?.trim() || undefined,
      links: cleanLinks,
      receiptImages: cleanImages,
      isReimbursable: payload.isReimbursable,
      lastEditedBy: editorName ?? existing.lastEditedBy,
      feeBreakdown: payload.feeBreakdown,
      splitConfig: payload.splitConfig,
    }

    assertSplitInvariant(updated)
    const saved = await saveTransactionToNormalVault(updated)
    transactions.value = transactions.value.map((tx) =>
      tx.id === id ? saved : tx,
    )
    await realtimeSyncStore.enqueueAndFlushProjectChange(
      saved.projectId,
      'transaction',
      saved.id,
      saved.updatedAt,
    )
    googleDriveStore.markGoogleDriveDirty()
    return saved
  }

  // ==================== 儲存量統計與備份匯入匯出 ====================
  function cloneProjectsForBackup(list: Project[]): Project[] {
    return toPlainClone(list)
  }

  function cloneTransactionsForBackup(list: Transaction[]): Transaction[] {
    return toPlainClone(list)
  }

  /** 本機儲存空間與圖片體積概覽（協助使用者掌握備份體積與圖片占用） */
  const storageUsageStats = computed(() => {
    let receiptImageCount = 0
    let receiptBytes = 0
    let avatarAndCoverCount = 0
    let avatarAndCoverBytes = 0

    for (const tx of transactions.value) {
      if (tx.receiptImages) {
        for (const img of tx.receiptImages) {
          receiptImageCount += 1
          receiptBytes += img.length
        }
      }
    }
    for (const proj of projects.value) {
      if (proj.cardCoverImage) {
        avatarAndCoverCount += 1
        avatarAndCoverBytes += proj.cardCoverImage.length
      }
      for (const m of proj.members) {
        if (m.avatarImage) {
          avatarAndCoverCount += 1
          avatarAndCoverBytes += m.avatarImage.length
        }
      }
    }
    if (userProfile.value.avatarImage) {
      avatarAndCoverCount += 1
      avatarAndCoverBytes += userProfile.value.avatarImage.length
    }

    const totalImageBytes = receiptBytes + avatarAndCoverBytes
    return {
      projectCount: allNonDeletedProjects.value.length,
      transactionCount: visibleTransactions.value.length,
      receiptImageCount,
      receiptBytes,
      avatarAndCoverCount,
      avatarAndCoverBytes,
      totalImageCount: receiptImageCount + avatarAndCoverCount,
      totalImageBytes,
    }
  })

  function exportLedgerBackup(options?: {
    omitReceiptImages?: boolean
  }): LedgerBackup {
    // 若略過收據圖片，先剔除 receiptImages 再深拷貝，避免白白複製大量 base64 圖片資料
    const clonedTxs = options?.omitReceiptImages
      ? transactions.value.map((tx) => {
          const rawTx = toRaw(tx)
          if (rawTx.receiptImages) {
            const { receiptImages: _ignored, ...rest } = rawTx
            return toPlainClone(rest)
          }
          return toPlainClone(rawTx)
        })
      : cloneTransactionsForBackup(transactions.value)
    return createLedgerBackupPayload(
      cloneProjectsForBackup(projects.value),
      clonedTxs,
      Date.now(),
      toPlainClone(categories.value),
      toPlainClone(userProfile.value),
      toPlainClone(projectOrder.value),
      projectOrderUpdatedAt.value || undefined,
    )
  }

  function exportProjectBackup(projectId: string): LedgerBackup | null {
    const target = projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!target) return null
    const clonedProject = cloneProjectsForBackup([target])[0]
    const clonedTxs = cloneTransactionsForBackup(
      transactions.value.filter((tx) => tx.projectId === projectId),
    )
    return createSingleProjectBackupPayload(
      clonedProject,
      clonedTxs,
      toPlainClone(categories.value),
    )
  }

  async function importAndMergeLedgerBackup(
    raw: string | unknown,
  ): Promise<LedgerMergeStats> {
    const merged = parseAndMergeLedgerBackup(
      {
        projects: cloneProjectsForBackup(projects.value),
        transactions: cloneTransactionsForBackup(transactions.value),
        categories: toPlainClone(categories.value),
        userProfile: toPlainClone(userProfile.value),
        projectOrder: toPlainClone(projectOrder.value),
        projectOrderUpdatedAt: projectOrderUpdatedAt.value || undefined,
      },
      raw,
    )

    // parseAndMergeLedgerBackup 之輸入與 Zod 驗證後匯入資料皆已為純淨物件，不需二次全量深拷貝；
    // 先寫入 IndexedDB 再交由 Vue ref 包裹，確保 bulkPut 過程不含任何 Reactive Proxy。
    const plainProjects = merged.projects
    const plainTransactions = merged.transactions

    if (plainProjects.length > 0) {
      await normalVaultDb.projects.bulkPut(plainProjects)
    }
    if (plainTransactions.length > 0) {
      await normalVaultDb.transactions.bulkPut(plainTransactions)
    }

    projects.value = plainProjects
    transactions.value = plainTransactions
    settlementViewStore.migrateLegacyProjectViews(plainProjects)

    let prefsChanged = false
    if (merged.categories.length > 0) {
      categories.value = merged.categories
      prefsChanged = true
    }
    if (merged.userProfileUpdated && merged.userProfile) {
      userProfile.value = merged.userProfile
      prefsChanged = true
    }
    if (merged.projectOrderUpdated && merged.projectOrder) {
      projectOrder.value = merged.projectOrder
      if (merged.projectOrderUpdatedAt !== undefined) {
        projectOrderUpdatedAt.value = merged.projectOrderUpdatedAt
      }
      prefsChanged = true
    }
    if (prefsChanged) {
      userPrefsStore.saveUserPrefs()
    }

    if (!activeProjectId.value && activeProjects.value.length > 0) {
      activeProjectId.value = activeProjects.value[0].id
      persistActiveProjectId(activeProjectId.value)
    }

    // 匯入備份或 Google Drive 合併後，將屬於即時共享專案的變更項目補排進 Firestore Outbox，
    // 確保離線／跨裝置帶入的新交易與專案更新能同步給其他協作成員，避免資料分歧。
    const outboxEntries = collectRealtimeOutboxEntriesFromMerge(merged).filter(
      (entry) => realtimeSyncStore.isProjectRealtimeSynced(entry.projectId),
    )
    if (outboxEntries.length > 0) {
      const affectedProjectIds = new Set<string>()
      for (const entry of outboxEntries) {
        await enqueueSyncOutbox(
          entry.projectId,
          entry.entityType,
          entry.entityId,
          entry.updatedAt,
        )
        affectedProjectIds.add(entry.projectId)
      }
      await realtimeSyncStore.refreshOutboxCounts()
      for (const projectId of affectedProjectIds) {
        void realtimeSyncStore.flushProjectOutbox(projectId)
      }
    }

    return merged.stats
  }

  googleDriveStore.bindBackupBridge({
    exportLedgerBackup,
    importAndMergeLedgerBackup,
  })

  return {
    projects,
    transactions,
    activeProjectId,
    isLoaded,
    isStoragePersisted,
    syncStatusByProject,
    lastSyncedAtByProject,
    outboxCountByProject,
    pendingDeletionGuard,
    pendingDeletionGuardCount,
    googleDriveStatus,
    googleDriveAccount,
    googleDriveAutoSync,
    googleDriveLastSyncAt,
    googleDriveDirty,
    googleDriveLastErrorCode,
    googleDriveLastErrorDetail,
    defaultCurrency,
    enabledCurrencies,
    categories,
    userProfile,
    availableCurrencies,
    allNonDeletedProjects,
    activeProjects,
    archivedProjects,
    deletedProjects,
    activeProject,
    visibleTransactions,
    deletedTransactions,
    dailyTransactions,
    activeProjectTransactions,
    activeProjectExpenses,
    activeProjectEntriesWithPool,
    activeProjectEffectiveExpenses,
    activeProjectSettlements,
    activeProjectSettleUp,
    activeProjectBaseSettleUp,
    projectTotalExpenseMap,
    liveRatesCache,
    liveRatesCacheTtlMs: userPrefsStore.liveRatesCacheTtlMs,
    liveRatesFetchedAt,
    liveRatesSource,
    isRefreshingLiveRates,
    refreshExchangeRates: userPrefsStore.refreshExchangeRates,
    getLiveExchangeRate: userPrefsStore.getLiveExchangeRate,
    getEffectiveExchangeRate: userPrefsStore.getEffectiveExchangeRate,
    getEffectiveExchangeRateWithSource:
      userPrefsStore.getEffectiveExchangeRateWithSource,
    getProjectSettlementCurrency:
      settlementViewStore.getProjectSettlementCurrency,
    getProjectSettlementRateMode:
      settlementViewStore.getProjectSettlementRateMode,
    getProjectSettlementOptions:
      settlementViewStore.getProjectSettlementOptions,
    settlementViewByProject,
    getProjectTotalExpense,
    getProjectTransactionCount,
    getRememberedExchangeRate: userPrefsStore.getRememberedExchangeRate,
    rememberExchangeRate: userPrefsStore.rememberExchangeRate,
    clearRememberedExchangeRate: userPrefsStore.clearRememberedExchangeRate,
    getQuickExchangeRatePresets: userPrefsStore.getQuickExchangeRatePresets,
    saveQuickExchangeRatePreset: userPrefsStore.saveQuickExchangeRatePreset,
    rememberLastExpenseProject: userPrefsStore.rememberLastExpenseProject,
    getLastExpenseProject,
    getProjectLastCurrency,
    rememberProjectLastCurrency: userPrefsStore.rememberProjectLastCurrency,
    rememberProjectLastSplitConfig:
      userPrefsStore.rememberProjectLastSplitConfig,
    getProjectLastSplitConfig,
    getProjectSettlementRateOverrides:
      settlementViewStore.getProjectSettlementRateOverrides,
    getProjectCustomRatesForTarget:
      settlementViewStore.getProjectCustomRatesForTarget,
    updateProjectSettlementCurrency:
      settlementViewStore.updateProjectSettlementCurrency,
    updateProjectSettlementRateConfig:
      settlementViewStore.updateProjectSettlementRateConfig,
    getProjectById,
    getAnyProjectById,
    setDefaultCurrency: userPrefsStore.setDefaultCurrency,
    addCurrency: userPrefsStore.addCurrency,
    removeCurrency: userPrefsStore.removeCurrency,
    addCategory: userPrefsStore.addCategory,
    updateCategory: userPrefsStore.updateCategory,
    removeCategory: userPrefsStore.removeCategory,
    resetDefaultCategories: userPrefsStore.resetDefaultCategories,
    updateUserProfile,
    initFromIndexedDb,
    quarantinedRecords,
    setStoragePersisted,
    createProject,
    createDemoProject,
    reorderProjects,
    moveProjectOrder,
    updateProject,
    toggleArchiveProject,
    addProjectMember,
    updateProjectMember,
    removeProjectMember,
    hasDuplicateMemberName,
    saveProjectSplitGroup,
    removeProjectSplitGroup,
    ensureProjectPoolMember: poolActions.ensureProjectPoolMember,
    togglePreferPoolPayer: poolActions.togglePreferPoolPayer,
    batchCollectPoolFund: poolActions.batchCollectPoolFund,
    isPoolCollectionTransaction: poolActions.isPoolCollectionTransaction,
    isMemberUsedInProjectTransactions,
    softDeleteProject: trashActions.softDeleteProject,
    restoreProject: trashActions.restoreProject,
    permanentlyDeleteProject: trashActions.permanentlyDeleteProject,
    selectProject,
    addTransaction,
    recordSettlementPayment,
    updateTransaction,
    softDeleteTransaction: trashActions.softDeleteTransaction,
    softDeleteTransactionsBatch: trashActions.softDeleteTransactionsBatch,
    restoreTransaction: trashActions.restoreTransaction,
    permanentlyDeleteTransaction: trashActions.permanentlyDeleteTransaction,
    emptyTrash: trashActions.emptyTrash,
    storageUsageStats,
    exportLedgerBackup,
    exportProjectBackup,
    importAndMergeLedgerBackup,
    enableProjectRealtimeSync: realtimeSyncStore.enableProjectRealtimeSync,
    fetchSharedProjectForJoin: realtimeSyncStore.fetchSharedProjectForJoin,
    finalizeJoinSharedProject: realtimeSyncStore.finalizeJoinSharedProject,
    setMyMemberForProject: realtimeSyncStore.setMyMemberForProject,
    rotateProjectInviteLink: realtimeSyncStore.rotateProjectInviteLink,
    stopProjectRealtimeSync: realtimeSyncStore.stopProjectRealtimeSync,
    startProjectRealtimeListener:
      realtimeSyncStore.startProjectRealtimeListener,
    startAllSharedProjectListeners:
      realtimeSyncStore.startAllSharedProjectListeners,
    stopAllSharedProjectListeners:
      realtimeSyncStore.stopAllSharedProjectListeners,
    flushProjectOutbox: realtimeSyncStore.flushProjectOutbox,
    flushAllSharedProjectsOutbox:
      realtimeSyncStore.flushAllSharedProjectsOutbox,
    approvePendingRemoteDeletes: realtimeSyncStore.approvePendingRemoteDeletes,
    rejectPendingRemoteDeletes: realtimeSyncStore.rejectPendingRemoteDeletes,
    isFirebaseConfigured: realtimeSyncStore.isFirebaseConfigured,
    hasBuiltInFirebaseConfig: realtimeSyncStore.hasBuiltInFirebaseConfig,
    getCustomFirebaseConfig: realtimeSyncStore.getCustomFirebaseConfig,
    saveCustomFirebaseConfig: realtimeSyncStore.saveCustomFirebaseConfig,
    clearCustomFirebaseConfig: realtimeSyncStore.clearCustomFirebaseConfig,
    getRealtimeSyncErrorCode: realtimeSyncStore.getRealtimeSyncErrorCode,
    setGoogleDriveAutoSync: googleDriveStore.setGoogleDriveAutoSync,
    syncGoogleDriveNow: googleDriveStore.syncGoogleDriveNow,
    pullGoogleDriveNow: googleDriveStore.pullGoogleDriveNow,
    disconnectGoogleDriveAccount: googleDriveStore.disconnectGoogleDriveAccount,
    tryBackgroundGoogleDriveSync: googleDriveStore.tryBackgroundGoogleDriveSync,
    getBuiltInGoogleClientId: googleDriveStore.getBuiltInGoogleClientId,
    hasBuiltInGoogleClientId: googleDriveStore.hasBuiltInGoogleClientId,
    getCustomGoogleClientId: googleDriveStore.getCustomGoogleClientId,
    saveGoogleClientId: googleDriveStore.saveGoogleClientId,
    getGoogleDriveErrorCode: googleDriveStore.getGoogleDriveErrorCode,
  }
})
