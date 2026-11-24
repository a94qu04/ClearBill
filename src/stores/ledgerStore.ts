import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  CURRENT_SCHEMA_VERSION,
  CurrencyCodeSchema,
  type LedgerBackup,
  type Project,
  type ProjectMember,
  type SplitConfig,
  type SplitMode,
  type Transaction,
  type TransactionType,
} from '@/schemas/ledgerSchema'
import {
  clearProjectSyncOutbox,
  enqueueSyncOutbox,
  listSyncOutbox,
  normalVaultDb,
  removeSyncOutboxKeys,
  saveProjectToNormalVault,
  saveTransactionToNormalVault,
} from '@/db/normalVaultDb'
import { calculateSettleUp } from '@/core/settleUpEngine'
import {
  createLedgerBackupPayload,
  createSingleProjectBackupPayload,
  parseAndMergeLedgerBackup,
  type LedgerMergeStats,
} from '@/core/backupMergeEngine'
import { reconcileRemoteTransactions } from '@/core/realtimeSyncEngine'
import {
  isFirebaseConfigured,
  joinSharedProjectOnFirestore,
  publishProjectToFirestore,
  pushProjectUpdateToFirestore,
  pushTransactionToFirestore,
  subscribeSharedProject,
} from '@/services/firestoreSyncService'

const ACTIVE_PROJECT_STORAGE_KEY = 'clearbill_active_project_id'
const PREFS_STORAGE_KEY = 'clearbill_user_prefs_v2'

export const INITIAL_CURRENCIES = ['TWD', 'JPY', 'USD', 'KRW', 'EUR', 'HKD'] as const

export const AVATAR_PALETTE = [
  '#10b981',
  '#3b82f6',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#14b8a6',
] as const

export interface ManagedCategory {
  key: string
  /** 若使用者未修改過內建分類，維持 undefined 以便自動套用當前語系翻譯；修改過則顯示此自訂名稱 */
  customLabel?: string
  color: string
  isBuiltin?: boolean
}

export const DEFAULT_MANAGED_CATEGORIES: ManagedCategory[] = [
  { key: 'cat_food', color: '#f97316', isBuiltin: true },
  { key: 'cat_transport', color: '#3b82f6', isBuiltin: true },
  { key: 'cat_lodging', color: '#8b5cf6', isBuiltin: true },
  { key: 'cat_shopping', color: '#ec4899', isBuiltin: true },
  { key: 'cat_entertainment', color: '#06b6d4', isBuiltin: true },
  { key: 'cat_daily', color: '#10b981', isBuiltin: true },
  { key: 'cat_other', color: '#64748b', isBuiltin: true },
]

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

export type ProjectRealtimeSyncStatus =
  | 'local'
  | 'connecting'
  | 'synced'
  | 'offline'
  | 'error'

export interface PendingDeletionGuardAlert {
  projectId: string
  projectName: string
  localActiveCount: number
  newlyDeletedCount: number
  deletionRatio: number
  pendingDeletes: Transaction[]
}

export interface CreateProjectPayload {
  name: string
  baseCurrency: string
  memberNames: string[]
  defaultSplitMode?: SplitMode
}

export interface UpdateProjectPayload {
  name?: string
  baseCurrency?: string
  defaultSplitMode?: SplitMode
  defaultPayerId?: string
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
  splitConfig?: SplitConfig
}

export interface RecordSettlementPayload {
  projectId: string
  fromMemberId: string
  toMemberId: string
  amount: number
  currency: string
  date: string
  time?: string
  note?: string
}

interface PersistedUserPrefsV2 {
  defaultCurrency: string
  enabledCurrencies: string[]
  categories: ManagedCategory[]
  projectOrder?: string[]
  exchangeRates?: Record<string, number>
}

function cloneDefaultCategories(): ManagedCategory[] {
  return DEFAULT_MANAGED_CATEGORIES.map((c) => ({ ...c }))
}

function loadUserPrefs(): PersistedUserPrefsV2 {
  const defaults: PersistedUserPrefsV2 = {
    defaultCurrency: 'TWD',
    enabledCurrencies: [...INITIAL_CURRENCIES],
    categories: cloneDefaultCategories(),
    projectOrder: [],
    exchangeRates: {},
  }
  if (typeof window === 'undefined') return defaults

  try {
    const rawV2 = window.localStorage.getItem(PREFS_STORAGE_KEY)
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<PersistedUserPrefsV2>
      const defaultCurrency =
        typeof parsed.defaultCurrency === 'string' &&
        /^[A-Z]{3}$/.test(parsed.defaultCurrency)
          ? parsed.defaultCurrency
          : 'TWD'

      const enabledSet = new Set<string>(
        Array.isArray(parsed.enabledCurrencies)
          ? parsed.enabledCurrencies.filter(
              (c): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c),
            )
          : [...INITIAL_CURRENCIES],
      )
      enabledSet.add(defaultCurrency)

      const categories =
        Array.isArray(parsed.categories) && parsed.categories.length > 0
          ? parsed.categories
              .filter(
                (c): c is ManagedCategory =>
                  typeof c === 'object' &&
                  c !== null &&
                  typeof c.key === 'string' &&
                  c.key.trim().length > 0,
              )
              .map((c) => ({
                key: c.key.trim(),
                customLabel:
                  typeof c.customLabel === 'string' && c.customLabel.trim()
                    ? c.customLabel.trim()
                    : undefined,
                color: typeof c.color === 'string' && c.color ? c.color : '#10b981',
                isBuiltin: Boolean(c.isBuiltin),
              }))
          : cloneDefaultCategories()

      const projectOrder = Array.isArray(parsed.projectOrder)
        ? parsed.projectOrder.filter((id): id is string => typeof id === 'string')
        : []

      const exchangeRates: Record<string, number> = {}
      if (parsed.exchangeRates && typeof parsed.exchangeRates === 'object') {
        for (const [pairKey, rate] of Object.entries(parsed.exchangeRates)) {
          if (
            /^[A-Z]{3}_[A-Z]{3}$/.test(pairKey) &&
            typeof rate === 'number' &&
            Number.isFinite(rate) &&
            rate > 0
          ) {
            exchangeRates[pairKey] = rate
          }
        }
      }

      return {
        defaultCurrency,
        enabledCurrencies: Array.from(enabledSet),
        categories,
        projectOrder,
        exchangeRates,
      }
    }

    // 向下相容遷移 v1 偏好設定
    const rawV1 = window.localStorage.getItem('clearbill_user_prefs_v1')
    if (rawV1) {
      const v1 = JSON.parse(rawV1) as {
        defaultCurrency?: string
        customCurrencies?: string[]
        customCategories?: Array<{ key: string; label: string; color?: string }>
      }
      const defCur =
        typeof v1.defaultCurrency === 'string' && /^[A-Z]{3}$/.test(v1.defaultCurrency)
          ? v1.defaultCurrency
          : 'TWD'
      const curSet = new Set<string>([
        ...INITIAL_CURRENCIES,
        ...(Array.isArray(v1.customCurrencies) ? v1.customCurrencies : []),
        defCur,
      ])
      const cats: ManagedCategory[] = [
        ...cloneDefaultCategories(),
        ...(Array.isArray(v1.customCategories)
          ? v1.customCategories.map((c) => ({
              key: c.key,
              customLabel: c.label,
              color: c.color || '#10b981',
              isBuiltin: false,
            }))
          : []),
      ]
      return {
        defaultCurrency: defCur,
        enabledCurrencies: Array.from(curSet),
        categories: cats,
      }
    }
  } catch {
    return defaults
  }

  return defaults
}

export const useLedgerStore = defineStore('ledger', () => {
  const initialPrefs = loadUserPrefs()

  const projects = ref<Project[]>([])
  const transactions = ref<Transaction[]>([])
  const activeProjectId = ref<string | null>(null)
  const isLoaded = ref(false)
  const isStoragePersisted = ref(false)

  // 即時多人協作同步狀態、離線待補傳計數與異常大量刪除熔斷告警
  const syncStatusByProject = ref<Record<string, ProjectRealtimeSyncStatus>>({})
  const outboxCountByProject = ref<Record<string, number>>({})
  const pendingDeletionGuard = ref<PendingDeletionGuardAlert | null>(null)
  const activeRealtimeUnsubscribers = new Map<string, () => void>()
  const flushingProjectIds = new Set<string>()

  // 使用者自訂偏好（預設幣別、可自由增刪的常用幣別、可自由增刪改的消費分類、專案排序、記憶匯率）
  const defaultCurrency = ref<string>(initialPrefs.defaultCurrency)
  const enabledCurrencies = ref<string[]>(initialPrefs.enabledCurrencies)
  const categories = ref<ManagedCategory[]>(initialPrefs.categories)
  const projectOrder = ref<string[]>(initialPrefs.projectOrder ?? [])
  const rememberedExchangeRates = ref<Record<string, number>>(
    initialPrefs.exchangeRates ?? {},
  )

  function saveUserPrefs() {
    if (typeof window === 'undefined') return
    try {
      const data: PersistedUserPrefsV2 = {
        defaultCurrency: defaultCurrency.value,
        enabledCurrencies: enabledCurrencies.value,
        categories: categories.value,
        projectOrder: projectOrder.value,
        exchangeRates: rememberedExchangeRates.value,
      }
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(data))
    } catch {
      // 忽略受限儲存環境
    }
  }

  function getRememberedExchangeRate(from: string, to: string): number | null {
    const f = from.trim().toUpperCase()
    const tCode = to.trim().toUpperCase()
    if (!f || !tCode || f === tCode) return 1
    const val = rememberedExchangeRates.value[`${f}_${tCode}`]
    return typeof val === 'number' && Number.isFinite(val) && val > 0 ? val : null
  }

  function rememberExchangeRate(from: string, to: string, rate: number): void {
    const f = from.trim().toUpperCase()
    const tCode = to.trim().toUpperCase()
    if (!f || !tCode || f === tCode) return
    if (!Number.isFinite(rate) || rate <= 0) return
    rememberedExchangeRates.value = {
      ...rememberedExchangeRates.value,
      [`${f}_${tCode}`]: rate,
    }
    saveUserPrefs()
  }

  const availableCurrencies = computed(() => {
    const set = new Set<string>(enabledCurrencies.value)
    if (defaultCurrency.value) set.add(defaultCurrency.value)
    return Array.from(set)
  })

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
    saveUserPrefs()
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
    saveUserPrefs()
    return true
  }

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
    if (!activeProject.value) return []
    return visibleTransactions.value.filter(
      (tx) => tx.projectId === activeProject.value!.id,
    )
  })

  /** 專案內消費/退款支出（不含還款 transfer，避免累計總支出重複計算） */
  const activeProjectExpenses = computed(() =>
    activeProjectTransactions.value.filter((tx) => tx.type !== 'transfer'),
  )

  /** 專案內已記錄的還款轉帳明細（type === 'transfer'） */
  const activeProjectSettlements = computed(() =>
    activeProjectTransactions.value.filter((tx) => tx.type === 'transfer'),
  )

  const activeProjectSettleUp = computed(() => {
    const proj = activeProject.value
    if (!proj) return null
    return calculateSettleUp(
      activeProjectTransactions.value,
      proj.baseCurrency,
      proj.members.map((m) => m.id),
    )
  })

  /** 各專案累計淨消費總額對照表（採與 settleUpEngine 完全一致之整數運算，供首頁與清單卡片顯示） */
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
      if (projTxs.length === 0) {
        result[proj.id] = 0
        continue
      }
      const settle = calculateSettleUp(
        projTxs,
        proj.baseCurrency,
        proj.members.map((m) => m.id),
      )
      result[proj.id] = settle.totalProjectExpense
    }
    return result
  })

  function getProjectTotalExpense(projectId: string): number {
    return projectTotalExpenseMap.value[projectId] ?? 0
  }

  function getProjectTransactionCount(projectId: string): number {
    return visibleTransactions.value.filter((tx) => tx.projectId === projectId).length
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

  function getProjectById(projectId: string | undefined): Project | null {
    if (!projectId) return null
    return allNonDeletedProjects.value.find((p) => p.id === projectId) ?? null
  }

  function getAnyProjectById(projectId: string | undefined): Project | null {
    if (!projectId) return null
    return projects.value.find((p) => p.id === projectId) ?? null
  }

  // ==================== 幣別管理（除預設幣別外皆可刪除、搜尋新增） ====================
  function setDefaultCurrency(code: string): void {
    const normalized = CurrencyCodeSchema.parse(code)
    defaultCurrency.value = normalized
    if (!enabledCurrencies.value.includes(normalized)) {
      enabledCurrencies.value = [...enabledCurrencies.value, normalized]
    }
    saveUserPrefs()
  }

  function addCurrency(code: string): string {
    const normalized = CurrencyCodeSchema.parse(code)
    if (!enabledCurrencies.value.includes(normalized)) {
      enabledCurrencies.value = [...enabledCurrencies.value, normalized]
      saveUserPrefs()
    }
    return normalized
  }

  function removeCurrency(code: string): boolean {
    const normalized = code.trim().toUpperCase()
    // 預設幣別不可刪除，須先切換其他預設幣別後才可移除
    if (normalized === defaultCurrency.value) {
      return false
    }
    enabledCurrencies.value = enabledCurrencies.value.filter(
      (c) => c !== normalized,
    )
    saveUserPrefs()
    return true
  }

  // ==================== 消費分類管理（所有分類皆可新增、修改、刪除） ====================
  function addCategory(label: string, color?: string): ManagedCategory {
    const trimmed = label.trim()
    const key = `custom_${Date.now().toString(36)}`
    const cat: ManagedCategory = {
      key,
      customLabel: trimmed,
      color:
        color || AVATAR_PALETTE[categories.value.length % AVATAR_PALETTE.length],
      isBuiltin: false,
    }
    categories.value = [...categories.value, cat]
    saveUserPrefs()
    return cat
  }

  function updateCategory(
    key: string,
    patch: { customLabel?: string; color?: string },
  ): void {
    categories.value = categories.value.map((cat) => {
      if (cat.key !== key) return cat
      const nextLabel =
        patch.customLabel !== undefined
          ? patch.customLabel.trim() || cat.customLabel
          : cat.customLabel
      return {
        ...cat,
        customLabel: nextLabel,
        color: patch.color ?? cat.color,
      }
    })
    saveUserPrefs()
  }

  function removeCategory(key: string): boolean {
    if (categories.value.length <= 1) {
      return false
    }
    categories.value = categories.value.filter((c) => c.key !== key)
    saveUserPrefs()
    return true
  }

  function resetDefaultCategories(): void {
    const existingCustom = categories.value.filter((c) => !c.isBuiltin)
    categories.value = [...cloneDefaultCategories(), ...existingCustom]
    saveUserPrefs()
  }

  async function refreshOutboxCounts(): Promise<void> {
    try {
      const items = await listSyncOutbox()
      const counts: Record<string, number> = {}
      for (const item of items) {
        counts[item.projectId] = (counts[item.projectId] ?? 0) + 1
      }
      outboxCountByProject.value = counts
    } catch {
      // 忽略受限環境
    }
  }

  function isProjectRealtimeSynced(projectId: string | undefined): boolean {
    if (!projectId) return false
    const proj = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    return Boolean(proj?.syncMeta?.mode === 'firestore' && proj.syncMeta.shareId)
  }

  async function enqueueAndFlushProjectChange(
    projectId: string | undefined,
    entityType: 'project' | 'transaction',
    entityId: string,
    updatedAt: number,
  ): Promise<void> {
    if (!projectId || !isProjectRealtimeSynced(projectId)) return
    await enqueueSyncOutbox(projectId, entityType, entityId, updatedAt)
    await refreshOutboxCounts()
    void flushProjectOutbox(projectId)
  }

  async function flushProjectOutbox(projectId: string): Promise<void> {
    const proj = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    const shareId = proj?.syncMeta?.shareId
    if (!proj || proj.syncMeta?.mode !== 'firestore' || !shareId) return
    if (!isFirebaseConfigured()) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]: 'offline',
      }
      return
    }
    if (flushingProjectIds.has(projectId)) return

    flushingProjectIds.add(projectId)
    try {
      const pendingItems = await listSyncOutbox(projectId)
      if (pendingItems.length === 0) return

      const syncImages = proj.syncMeta.syncReceiptImages !== false
      const succeededKeys: string[] = []

      for (const item of pendingItems) {
        if (item.entityType === 'project') {
          const latestProj = projects.value.find((p) => p.id === projectId)
          if (latestProj) {
            await pushProjectUpdateToFirestore(shareId, latestProj)
          }
          succeededKeys.push(item.key)
        } else {
          const latestTx = transactions.value.find((t) => t.id === item.entityId)
          if (latestTx) {
            await pushTransactionToFirestore(shareId, latestTx, syncImages)
          }
          succeededKeys.push(item.key)
        }
      }

      await removeSyncOutboxKeys(succeededKeys)
      await refreshOutboxCounts()
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]: 'synced',
      }
    } catch {
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]:
          typeof navigator !== 'undefined' && navigator.onLine === false
            ? 'offline'
            : 'error',
      }
    } finally {
      flushingProjectIds.delete(projectId)
    }
  }

  async function flushAllSharedProjectsOutbox(): Promise<void> {
    const sharedIds = projects.value
      .filter((p) => !p.isDeleted && p.syncMeta?.mode === 'firestore' && p.syncMeta.shareId)
      .map((p) => p.id)
    for (const id of sharedIds) {
      await flushProjectOutbox(id)
    }
  }

  async function applyRemoteProjectUpdate(
    localProjectId: string,
    remoteProject: Project,
  ): Promise<void> {
    const localProj = projects.value.find((p) => p.id === localProjectId)
    if (!localProj) return
    if (remoteProject.updatedAt <= localProj.updatedAt) return

    const mergedProject: Project = {
      ...remoteProject,
      id: localProj.id,
      // 保留此裝置私有欄位（封存狀態、同步資訊與本機認領身分）
      isArchived: localProj.isArchived,
      defaultPayerId:
        localProj.syncMeta?.myMemberId &&
        remoteProject.members.some((m) => m.id === localProj.syncMeta?.myMemberId)
          ? localProj.syncMeta.myMemberId
          : remoteProject.defaultPayerId,
      syncMeta: localProj.syncMeta
        ? { ...localProj.syncMeta, lastSyncedAt: Date.now() }
        : undefined,
    }

    const saved = await saveProjectToNormalVault(mergedProject)
    projects.value = projects.value.map((p) => (p.id === localProjectId ? saved : p))
  }

  async function applyRemoteTransactionsList(
    localProjectId: string,
    txList: Transaction[],
  ): Promise<void> {
    if (txList.length === 0) return

    const localMap = new Map(transactions.value.map((t) => [t.id, t]))
    const toPersist: Transaction[] = []

    for (const incoming of txList) {
      const existing = localMap.get(incoming.id)
      // 若遠端因圖片體積過大略過圖片，保留本地既有圖片避免遺失
      const preservedImages =
        (!incoming.receiptImages || incoming.receiptImages.length === 0) &&
        existing?.receiptImages &&
        existing.receiptImages.length > 0
          ? [...existing.receiptImages]
          : incoming.receiptImages

      const normalized: Transaction = {
        ...incoming,
        projectId: localProjectId,
        receiptImages: preservedImages,
      }
      toPersist.push(normalized)
      localMap.set(normalized.id, normalized)
    }

    await normalVaultDb.transactions.bulkPut(toPersist)
    transactions.value = Array.from(localMap.values())
  }

  async function handleRemoteTransactionsBatch(
    localProjectId: string,
    remoteTxs: Transaction[],
  ): Promise<void> {
    const localProj = projects.value.find((p) => p.id === localProjectId)
    if (!localProj) return

    const localProjectTxs = transactions.value.filter(
      (tx) => tx.projectId === localProjectId,
    )
    const reconciled = reconcileRemoteTransactions(localProjectTxs, remoteTxs)

    // 先安全套用遠端的新增與一般修改
    if (reconciled.safeUpserts.length > 0) {
      await applyRemoteTransactionsList(localProjectId, reconciled.safeUpserts)
    }

    // 異常大量刪除熔斷器：達門檻時自動攔截並要求使用者確認
    if (reconciled.circuitBreaker.triggered) {
      pendingDeletionGuard.value = {
        projectId: localProjectId,
        projectName: localProj.name,
        localActiveCount: reconciled.circuitBreaker.localActiveCount,
        newlyDeletedCount: reconciled.circuitBreaker.newlyDeletedCount,
        deletionRatio: reconciled.circuitBreaker.deletionRatio,
        pendingDeletes: reconciled.incomingDeletes,
      }
      return
    }

    if (reconciled.incomingDeletes.length > 0) {
      await applyRemoteTransactionsList(localProjectId, reconciled.incomingDeletes)
    }

    syncStatusByProject.value = {
      ...syncStatusByProject.value,
      [localProjectId]: 'synced',
    }
  }

  async function approvePendingRemoteDeletes(): Promise<number> {
    const guard = pendingDeletionGuard.value
    if (!guard) return 0
    pendingDeletionGuard.value = null
    await applyRemoteTransactionsList(guard.projectId, guard.pendingDeletes)
    return guard.pendingDeletes.length
  }

  async function rejectPendingRemoteDeletes(): Promise<number> {
    const guard = pendingDeletionGuard.value
    if (!guard) return 0
    pendingDeletionGuard.value = null

    const now = Date.now()
    let restoredCount = 0
    for (const blockedDelete of guard.pendingDeletes) {
      const localTx = transactions.value.find((t) => t.id === blockedDelete.id)
      if (!localTx || localTx.isDeleted) continue
      const bumped: Transaction = {
        ...localTx,
        isDeleted: false,
        updatedAt: Math.max(now, blockedDelete.updatedAt + 1),
      }
      const saved = await saveTransactionToNormalVault(bumped)
      transactions.value = transactions.value.map((t) =>
        t.id === saved.id ? saved : t,
      )
      await enqueueAndFlushProjectChange(
        guard.projectId,
        'transaction',
        saved.id,
        saved.updatedAt,
      )
      restoredCount += 1
    }
    return restoredCount
  }

  function unsubscribeProjectRealtime(projectId: string): void {
    const unsub = activeRealtimeUnsubscribers.get(projectId)
    if (unsub) {
      unsub()
      activeRealtimeUnsubscribers.delete(projectId)
    }
  }

  async function startProjectRealtimeListener(projectId: string): Promise<void> {
    const proj = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    const shareId = proj?.syncMeta?.shareId
    if (!proj || proj.syncMeta?.mode !== 'firestore' || !shareId) return
    if (!isFirebaseConfigured()) {
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]: 'error',
      }
      return
    }
    if (activeRealtimeUnsubscribers.has(projectId)) return

    syncStatusByProject.value = {
      ...syncStatusByProject.value,
      [projectId]: 'connecting',
    }

    try {
      const unsub = await subscribeSharedProject(shareId, {
        onProjectChange: (remoteProj) => {
          void applyRemoteProjectUpdate(projectId, remoteProj)
        },
        onTransactionsBatch: (remoteTxs) => {
          void handleRemoteTransactionsBatch(projectId, remoteTxs)
        },
        onError: () => {
          syncStatusByProject.value = {
            ...syncStatusByProject.value,
            [projectId]:
              typeof navigator !== 'undefined' && navigator.onLine === false
                ? 'offline'
                : 'error',
          }
        },
      })
      activeRealtimeUnsubscribers.set(projectId, unsub)
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]: 'synced',
      }
      void flushProjectOutbox(projectId)
    } catch {
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]:
          typeof navigator !== 'undefined' && navigator.onLine === false
            ? 'offline'
            : 'error',
      }
    }
  }

  async function startAllSharedProjectListeners(): Promise<void> {
    if (!isFirebaseConfigured()) return
    const sharedProjects = projects.value.filter(
      (p) => !p.isDeleted && p.syncMeta?.mode === 'firestore' && p.syncMeta.shareId,
    )
    for (const proj of sharedProjects) {
      await startProjectRealtimeListener(proj.id)
    }
  }

  function stopAllSharedProjectListeners(): void {
    for (const unsub of activeRealtimeUnsubscribers.values()) {
      unsub()
    }
    activeRealtimeUnsubscribers.clear()
  }

  async function enableProjectRealtimeSync(
    projectId: string,
    options: { myMemberId?: string; syncReceiptImages?: boolean } = {},
  ): Promise<{ shareId: string; accessKey: string; omittedImageTxCount: number }> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) {
      throw new Error('ERR_PROJECT_NOT_FOUND')
    }

    const syncImages = options.syncReceiptImages !== false
    const projTxs = transactions.value.filter((tx) => tx.projectId === projectId)
    const published = await publishProjectToFirestore(existing, projTxs, syncImages)

    const updated: Project = {
      ...existing,
      defaultPayerId: options.myMemberId || existing.defaultPayerId,
      syncMeta: {
        mode: 'firestore',
        shareId: published.shareId,
        accessKey: published.accessKey,
        role: 'owner',
        myMemberId: options.myMemberId || existing.defaultPayerId,
        syncReceiptImages: syncImages,
        lastSyncedAt: published.syncedAt,
      },
      members: existing.members.map((m) => ({ ...m })),
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await startProjectRealtimeListener(projectId)

    return {
      shareId: published.shareId,
      accessKey: published.accessKey,
      omittedImageTxCount: published.omittedImageTxCount,
    }
  }

  async function fetchSharedProjectForJoin(
    shareId: string,
    accessKey: string,
  ): Promise<{ project: Project; transactions: Transaction[] }> {
    const res = await joinSharedProjectOnFirestore(shareId, accessKey)
    return { project: res.project, transactions: res.transactions }
  }

  async function finalizeJoinSharedProject(params: {
    shareId: string
    accessKey: string
    remoteProject: Project
    remoteTransactions: Transaction[]
    selectedMemberId?: string
    newMemberName?: string
  }): Promise<Project> {
    const now = Date.now()
    let members = params.remoteProject.members.map((m) => ({ ...m }))
    let claimedMemberId = params.selectedMemberId
    let addedNewMember = false

    const trimmedNewName = params.newMemberName?.trim()
    if (!claimedMemberId && trimmedNewName) {
      const createdMember: ProjectMember = {
        id: `m_${members.length + 1}_${now.toString(36)}`,
        name: trimmedNewName,
        avatarColor: AVATAR_PALETTE[members.length % AVATAR_PALETTE.length],
      }
      members = [...members, createdMember]
      claimedMemberId = createdMember.id
      addedNewMember = true
    }

    const existingLocal = projects.value.find(
      (p) => p.id === params.remoteProject.id,
    )

    const joinedProject: Project = {
      ...params.remoteProject,
      members,
      isActive: true,
      isDeleted: false,
      isArchived: false,
      defaultPayerId: claimedMemberId || members[0]?.id,
      updatedAt: addedNewMember
        ? Math.max(now, params.remoteProject.updatedAt + 1)
        : params.remoteProject.updatedAt,
      syncMeta: {
        mode: 'firestore',
        shareId: params.shareId,
        accessKey: params.accessKey,
        role: existingLocal?.syncMeta?.role ?? 'editor',
        myMemberId: claimedMemberId || members[0]?.id,
        syncReceiptImages: true,
        lastSyncedAt: now,
      },
    }

    const savedProj = await saveProjectToNormalVault(joinedProject)
    if (existingLocal) {
      projects.value = projects.value.map((p) =>
        p.id === savedProj.id ? savedProj : p,
      )
    } else {
      projects.value = [savedProj, ...projects.value]
      projectOrder.value = [
        savedProj.id,
        ...projectOrder.value.filter((id) => id !== savedProj.id),
      ]
      saveUserPrefs()
    }

    await applyRemoteTransactionsList(savedProj.id, params.remoteTransactions)

    if (addedNewMember) {
      await enqueueAndFlushProjectChange(
        savedProj.id,
        'project',
        savedProj.id,
        savedProj.updatedAt,
      )
    }

    activeProjectId.value = savedProj.id
    persistActiveProjectId(savedProj.id)
    await startProjectRealtimeListener(savedProj.id)
    return savedProj
  }

  async function setMyMemberForProject(
    projectId: string,
    memberId: string,
  ): Promise<void> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) return
    if (!existing.members.some((m) => m.id === memberId)) return

    const updated: Project = {
      ...existing,
      defaultPayerId: memberId,
      syncMeta: existing.syncMeta
        ? { ...existing.syncMeta, myMemberId: memberId }
        : undefined,
      members: existing.members.map((m) => ({ ...m })),
    }
    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
  }

  async function stopProjectRealtimeSync(projectId: string): Promise<void> {
    unsubscribeProjectRealtime(projectId)
    await clearProjectSyncOutbox(projectId)
    await refreshOutboxCounts()

    const existing = projects.value.find((p) => p.id === projectId)
    if (!existing) return
    const updated: Project = {
      ...existing,
      syncMeta: undefined,
      members: existing.members.map((m) => ({ ...m })),
    }
    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    syncStatusByProject.value = {
      ...syncStatusByProject.value,
      [projectId]: 'local',
    }
  }

  async function initFromIndexedDb(): Promise<void> {
    if (isLoaded.value) return
    try {
      const [loadedProjects, loadedTransactions] = await Promise.all([
        normalVaultDb.projects.toArray(),
        normalVaultDb.transactions.toArray(),
      ])
      projects.value = loadedProjects
      transactions.value = loadedTransactions
      await refreshOutboxCounts()

      const savedId =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)
          : null
      const savedStillActive = savedId
        ? loadedProjects.find((p) => p.id === savedId && !p.isDeleted)
        : undefined
      const fallbackActive = loadedProjects
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
      .map((name, idx) => ({
        id: `m_${idx + 1}_${now.toString(36)}`,
        name,
        avatarColor: AVATAR_PALETTE[idx % AVATAR_PALETTE.length],
      }))

    const project: Project = {
      id: generateUuid(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      name: payload.name.trim(),
      baseCurrency: payload.baseCurrency.trim().toUpperCase(),
      members,
      defaultSplitMode: payload.defaultSplitMode ?? 'equal',
      defaultPayerId: members[0]?.id,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }

    const saved = await saveProjectToNormalVault(project)
    projects.value = [saved, ...projects.value]
    projectOrder.value = [
      saved.id,
      ...projectOrder.value.filter((id) => id !== saved.id),
    ]
    saveUserPrefs()
    activeProjectId.value = saved.id
    persistActiveProjectId(saved.id)
    return saved
  }

  async function updateProject(
    projectId: string,
    patch: UpdateProjectPayload,
  ): Promise<Project | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) return null

    const updated: Project = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      baseCurrency:
        patch.baseCurrency !== undefined
          ? patch.baseCurrency.trim().toUpperCase()
          : existing.baseCurrency,
      defaultSplitMode: patch.defaultSplitMode ?? existing.defaultSplitMode,
      defaultPayerId: patch.defaultPayerId ?? existing.defaultPayerId,
      members: existing.members.map((m) => ({ ...m })),
      updatedAt: Date.now(),
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    return saved
  }

  async function addProjectMember(
    projectId: string,
    memberName: string,
    avatarColor?: string,
  ): Promise<Project | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    const trimmed = memberName.trim()
    if (!existing || !trimmed) return null

    const now = Date.now()
    const newMember: ProjectMember = {
      id: `m_${existing.members.length + 1}_${now.toString(36)}`,
      name: trimmed,
      avatarColor:
        avatarColor ||
        AVATAR_PALETTE[existing.members.length % AVATAR_PALETTE.length],
    }

    const updated: Project = {
      ...existing,
      members: [...existing.members.map((m) => ({ ...m })), newMember],
      updatedAt: now,
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    return saved
  }

  async function updateProjectMember(
    projectId: string,
    memberId: string,
    patch: { name?: string; avatarColor?: string },
  ): Promise<Project | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) return null

    const nextMembers = existing.members.map((m) => {
      if (m.id !== memberId) return { ...m }
      return {
        ...m,
        name: patch.name !== undefined ? patch.name.trim() || m.name : m.name,
        avatarColor: patch.avatarColor ?? m.avatarColor,
      }
    })

    const updated: Project = {
      ...existing,
      members: nextMembers,
      updatedAt: Date.now(),
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    return saved
  }

  function isMemberUsedInProjectTransactions(
    projectId: string,
    memberId: string,
  ): boolean {
    return transactions.value.some((tx) => {
      if (tx.isDeleted || tx.projectId !== projectId || !tx.splitConfig) {
        return false
      }
      if (tx.splitConfig.payerId === memberId) return true
      if (tx.splitConfig.payers?.some((p) => p.memberId === memberId && p.amount > 0)) {
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
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) return { ok: false }

    if (existing.members.length <= 1) {
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
        ? remainingMembers[0]?.id
        : existing.defaultPayerId

    const updated: Project = {
      ...existing,
      members: remainingMembers,
      defaultPayerId: nextDefaultPayer,
      updatedAt: Date.now(),
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    return { ok: true }
  }

  async function toggleArchiveProject(
    projectId: string,
  ): Promise<Project | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
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

  async function softDeleteProject(projectId: string): Promise<void> {
    const existing = projects.value.find((p) => p.id === projectId)
    if (!existing) return

    unsubscribeProjectRealtime(projectId)
    await clearProjectSyncOutbox(projectId)
    await refreshOutboxCounts()

    const now = Date.now()
    const updatedProject: Project = {
      ...existing,
      isActive: false,
      isDeleted: true,
      updatedAt: now,
    }
    await saveProjectToNormalVault(updatedProject)
    projects.value = projects.value.map((p) =>
      p.id === projectId ? updatedProject : p,
    )

    const relatedTxs = transactions.value.filter(
      (tx) => tx.projectId === projectId && !tx.isDeleted,
    )
    for (const tx of relatedTxs) {
      const deletedTx: Transaction = {
        ...tx,
        isDeleted: true,
        updatedAt: now,
      }
      await saveTransactionToNormalVault(deletedTx)
    }
    if (relatedTxs.length > 0) {
      const relatedIds = new Set(relatedTxs.map((tx) => tx.id))
      transactions.value = transactions.value.map((tx) =>
        relatedIds.has(tx.id) ? { ...tx, isDeleted: true, updatedAt: now } : tx,
      )
    }

    if (activeProjectId.value === projectId) {
      const next = activeProjects.value[0]?.id ?? null
      activeProjectId.value = next
      persistActiveProjectId(next)
    }
  }

  function selectProject(projectId: string | null): void {
    activeProjectId.value = projectId
    persistActiveProjectId(projectId)
  }

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
      splitConfig: payload.splitConfig,
    }

    const saved = await saveTransactionToNormalVault(tx)
    transactions.value = [saved, ...transactions.value]
    await enqueueAndFlushProjectChange(
      saved.projectId,
      'transaction',
      saved.id,
      saved.updatedAt,
    )
    return saved
  }

  async function recordSettlementPayment(
    payload: RecordSettlementPayload,
  ): Promise<Transaction> {
    return addTransaction({
      projectId: payload.projectId,
      type: 'transfer',
      amount: payload.amount,
      currency: payload.currency,
      exchangeRateToBase: 1,
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
      splitConfig: payload.splitConfig,
    }

    const saved = await saveTransactionToNormalVault(updated)
    transactions.value = transactions.value.map((tx) =>
      tx.id === id ? saved : tx,
    )
    await enqueueAndFlushProjectChange(
      saved.projectId,
      'transaction',
      saved.id,
      saved.updatedAt,
    )
    return saved
  }

  async function softDeleteTransaction(id: string): Promise<void> {
    const target = transactions.value.find((tx) => tx.id === id)
    if (!target) return
    const updated: Transaction = {
      ...target,
      isDeleted: true,
      updatedAt: Date.now(),
    }
    await saveTransactionToNormalVault(updated)
    transactions.value = transactions.value.map((tx) =>
      tx.id === id ? updated : tx,
    )
    await enqueueAndFlushProjectChange(
      updated.projectId,
      'transaction',
      updated.id,
      updated.updatedAt,
    )
  }

  async function restoreTransaction(
    id: string,
  ): Promise<{ ok: boolean; projectId?: string }> {
    const target = transactions.value.find((tx) => tx.id === id && tx.isDeleted)
    if (!target) return { ok: false }

    const now = Date.now()

    // 若該筆消費原本屬於某個專案且該專案目前處於軟刪除狀態，一併復原專案確保消費自動回到專案中
    let targetProjectId = target.projectId
    if (targetProjectId) {
      const parentProject = projects.value.find((p) => p.id === targetProjectId)
      if (parentProject && parentProject.isDeleted) {
        const restoredProject = await saveProjectToNormalVault({
          ...parentProject,
          isDeleted: false,
          isActive: true,
          members: parentProject.members.map((m) => ({ ...m })),
          updatedAt: now,
        })
        projects.value = projects.value.map((p) =>
          p.id === restoredProject.id ? restoredProject : p,
        )
      }
      // 同步切換回該專案，讓使用者馬上看到復原後的帳目與更新後結算
      activeProjectId.value = targetProjectId
      persistActiveProjectId(targetProjectId)
    } else if (activeProject.value) {
      // 若復原的是無專案歸屬的舊消費且目前隱藏日常記帳模式中有進行中專案，仍保留原資料不亂竄改
      targetProjectId = undefined
    }

    const restoredPayload: Transaction = {
      ...target,
      projectId: targetProjectId,
      isDeleted: false,
      updatedAt: now,
    }
    const saved = await saveTransactionToNormalVault(restoredPayload)
    transactions.value = transactions.value.map((tx) =>
      tx.id === id ? saved : tx,
    )
    await enqueueAndFlushProjectChange(
      saved.projectId,
      'transaction',
      saved.id,
      saved.updatedAt,
    )
    return { ok: true, projectId: saved.projectId }
  }

  async function permanentlyDeleteTransaction(id: string): Promise<void> {
    await normalVaultDb.transactions.delete(id)
    transactions.value = transactions.value.filter((tx) => tx.id !== id)
  }

  async function emptyTrash(): Promise<number> {
    const ids = deletedTransactions.value.map((tx) => tx.id)
    if (ids.length === 0) return 0
    await normalVaultDb.transactions.bulkDelete(ids)
    const deletedSet = new Set(ids)
    transactions.value = transactions.value.filter((tx) => !deletedSet.has(tx.id))
    return ids.length
  }

  function cloneProjectsForBackup(list: Project[]): Project[] {
    return list.map((p) => ({
      ...p,
      members: p.members.map((m) => ({ ...m })),
    }))
  }

  function cloneTransactionsForBackup(list: Transaction[]): Transaction[] {
    return list.map((tx) => ({
      ...tx,
      links: tx.links ? [...tx.links] : undefined,
      receiptImages: tx.receiptImages ? [...tx.receiptImages] : undefined,
      splitConfig: tx.splitConfig
        ? {
            ...tx.splitConfig,
            payers: tx.splitConfig.payers
              ? tx.splitConfig.payers.map((p) => ({ ...p }))
              : undefined,
            shares: tx.splitConfig.shares.map((s) => ({ ...s })),
          }
        : undefined,
    }))
  }

  function exportLedgerBackup(): LedgerBackup {
    return createLedgerBackupPayload(
      cloneProjectsForBackup(projects.value),
      cloneTransactionsForBackup(transactions.value),
      Date.now(),
      categories.value.map((c) => ({ ...c })),
    )
  }

  function exportProjectBackup(projectId: string): LedgerBackup | null {
    const target = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!target) return null
    const clonedProject = cloneProjectsForBackup([target])[0]
    const clonedTxs = cloneTransactionsForBackup(
      transactions.value.filter((tx) => tx.projectId === projectId),
    )
    return createSingleProjectBackupPayload(
      clonedProject,
      clonedTxs,
      categories.value.map((c) => ({ ...c })),
    )
  }

  async function importAndMergeLedgerBackup(
    raw: string | unknown,
  ): Promise<LedgerMergeStats> {
    const merged = parseAndMergeLedgerBackup(
      {
        projects: projects.value,
        transactions: transactions.value,
        categories: categories.value.map((c) => ({ ...c })),
      },
      raw,
    )

    if (merged.projects.length > 0) {
      await normalVaultDb.projects.bulkPut(merged.projects)
    }
    if (merged.transactions.length > 0) {
      await normalVaultDb.transactions.bulkPut(merged.transactions)
    }

    projects.value = merged.projects
    transactions.value = merged.transactions

    if (merged.categories.length > 0) {
      categories.value = merged.categories.map((c) => ({ ...c }))
      saveUserPrefs()
    }

    if (!activeProjectId.value && activeProjects.value.length > 0) {
      activeProjectId.value = activeProjects.value[0].id
      persistActiveProjectId(activeProjectId.value)
    }

    return merged.stats
  }

  return {
    projects,
    transactions,
    activeProjectId,
    isLoaded,
    isStoragePersisted,
    syncStatusByProject,
    outboxCountByProject,
    pendingDeletionGuard,
    defaultCurrency,
    enabledCurrencies,
    categories,
    availableCurrencies,
    allNonDeletedProjects,
    activeProjects,
    archivedProjects,
    activeProject,
    visibleTransactions,
    deletedTransactions,
    dailyTransactions,
    activeProjectTransactions,
    activeProjectExpenses,
    activeProjectSettlements,
    activeProjectSettleUp,
    projectTotalExpenseMap,
    getProjectTotalExpense,
    getProjectTransactionCount,
    getRememberedExchangeRate,
    rememberExchangeRate,
    getProjectById,
    getAnyProjectById,
    setDefaultCurrency,
    addCurrency,
    removeCurrency,
    addCategory,
    updateCategory,
    removeCategory,
    resetDefaultCategories,
    initFromIndexedDb,
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
    isMemberUsedInProjectTransactions,
    softDeleteProject,
    selectProject,
    addTransaction,
    recordSettlementPayment,
    updateTransaction,
    softDeleteTransaction,
    restoreTransaction,
    permanentlyDeleteTransaction,
    emptyTrash,
    exportLedgerBackup,
    exportProjectBackup,
    importAndMergeLedgerBackup,
    enableProjectRealtimeSync,
    fetchSharedProjectForJoin,
    finalizeJoinSharedProject,
    setMyMemberForProject,
    stopProjectRealtimeSync,
    startProjectRealtimeListener,
    startAllSharedProjectListeners,
    stopAllSharedProjectListeners,
    flushProjectOutbox,
    flushAllSharedProjectsOutbox,
    approvePendingRemoteDeletes,
    rejectPendingRemoteDeletes,
  }
})
