import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  CURRENT_SCHEMA_VERSION,
  CurrencyCodeSchema,
  type LedgerBackup,
  type Project,
  type ProjectMember,
  type ProjectSplitGroup,
  type SplitConfig,
  type SplitMode,
  type Transaction,
  type TransactionType,
  type UserProfile,
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
import {
  applySettlementRatesToTransactions,
  calculateSettleUp,
  type SettleUpOptions,
} from '@/core/settleUpEngine'
import { getSuggestedExchangeRate } from '@/core/ledgerHelpers'
import {
  isValidCategoryIconKey,
  resolveDefaultCategoryIcon,
} from '@/core/categoryIcons'
import {
  computeCrossRateFromUsdTable,
  loadCachedLiveRates,
  refreshLiveExchangeRates,
  type LiveRatesCache,
} from '@/services/exchangeRateService'
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
  rotateProjectAccessKeyOnFirestore,
  subscribeSharedProject,
} from '@/services/firestoreSyncService'
import {
  disconnectGoogleDrive,
  downloadBackupFromGoogleDrive,
  getLastGoogleSyncAt,
  getSavedGoogleAccount,
  getSavedGoogleClientId,
  GoogleDriveSyncError,
  hasGoogleDriveDirtyChanges,
  isGoogleAutoSyncEnabled,
  isGoogleDriveConnected,
  setGoogleAutoSyncEnabled,
  setGoogleDriveDirtyChanges,
  syncWithGoogleDrive,
  type GoogleDriveAccountInfo,
  type GoogleDriveSyncErrorCode,
  type GoogleDriveSyncResult,
} from '@/services/googleDriveSync'

const ACTIVE_PROJECT_STORAGE_KEY = 'clearbill_active_project_id'
const PREFS_STORAGE_KEY = 'clearbill_user_prefs_v2'

export const INITIAL_CURRENCIES = [
  'TWD',
  'JPY',
  'THB',
  'USD',
  'KRW',
  'EUR',
  'HKD',
] as const

export const AVATAR_PALETTE = [
  '#059669', // 翡翠綠
  '#2563eb', // 寶藍
  '#d97706', // 琥珀金
  '#7c3aed', // 靛紫
  '#db2777', // 洋紅
  '#0891b2', // 湖水青
  '#ea580c', // 亮橘
  '#dc2626', // 正紅
  '#4f46e5', // 湛藍紫
  '#65a30d', // 鮮萊姆綠
  '#c026d3', // 紫紅
  '#0369a1', // 深海藍
  '#92400e', // 焦糖棕
  '#0f766e', // 深水鴨青
] as const

export const PROJECT_CARD_PALETTE = [
  '#0f172a',
  '#065f46',
  '#1e3a8a',
  '#0e7490',
  '#581c87',
  '#9d174d',
  '#9a3412',
  '#854d0e',
] as const

export interface ManagedCategory {
  key: string
  /** 若使用者未修改過內建分類，維持 undefined 以便自動套用當前語系翻譯；修改過則顯示此自訂名稱 */
  customLabel?: string
  color: string
  /** 分類圖示鍵值（對應 categoryIcons.ts） */
  icon?: string
  isBuiltin?: boolean
}

export const DEFAULT_MANAGED_CATEGORIES: ManagedCategory[] = [
  { key: 'cat_food', color: '#ea580c', icon: 'utensils', isBuiltin: true },
  { key: 'cat_transport', color: '#2563eb', icon: 'train', isBuiltin: true },
  { key: 'cat_lodging', color: '#7c3aed', icon: 'bed', isBuiltin: true },
  { key: 'cat_shopping', color: '#db2777', icon: 'shopping_bag', isBuiltin: true },
  { key: 'cat_entertainment', color: '#0891b2', icon: 'ticket', isBuiltin: true },
  { key: 'cat_daily', color: '#ca8a04', icon: 'package', isBuiltin: true },
  { key: 'cat_other', color: '#475569', icon: 'tag', isBuiltin: true },
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

export type GoogleDriveSyncStatus =
  | 'disconnected'
  | 'syncing'
  | 'synced'
  | 'pending'
  | 'needs_auth'
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

interface QuickExchangeRatePresets {
  cash?: number
  card?: number
}

export interface LocalSettlementViewPrefs {
  settlementCurrency?: string
  settlementRateMode?: 'per_tx' | 'live' | 'custom'
  settlementCustomRates?: Record<string, number>
  settlementCustomRatesByCurrency?: Record<string, Record<string, number>>
}

interface PersistedUserPrefsV2 {
  defaultCurrency: string
  enabledCurrencies: string[]
  categories: ManagedCategory[]
  projectOrder?: string[]
  projectOrderUpdatedAt?: number
  exchangeRates?: Record<string, number>
  quickExchangeRates?: Record<string, QuickExchangeRatePresets>
  lastCurrencyByProject?: Record<string, string>
  settlementViewByProject?: Record<string, LocalSettlementViewPrefs>
  userProfile?: UserProfile
}

function createDefaultUserProfile(): UserProfile {
  return {
    displayName: '',
    avatarColor: AVATAR_PALETTE[0],
    avatarImage: undefined,
    paymentInfo: undefined,
  }
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
              .map((c) => {
                const key = c.key.trim()
                return {
                  key,
                  customLabel:
                    typeof c.customLabel === 'string' && c.customLabel.trim()
                      ? c.customLabel.trim()
                      : undefined,
                  color: typeof c.color === 'string' && c.color ? c.color : '#10b981',
                  icon: isValidCategoryIconKey(c.icon)
                    ? c.icon
                    : resolveDefaultCategoryIcon(key),
                  isBuiltin: Boolean(c.isBuiltin),
                }
              })
          : cloneDefaultCategories()

      const projectOrder = Array.isArray(parsed.projectOrder)
        ? parsed.projectOrder.filter((id): id is string => typeof id === 'string')
        : []
      const projectOrderUpdatedAt =
        typeof parsed.projectOrderUpdatedAt === 'number' &&
        Number.isFinite(parsed.projectOrderUpdatedAt) &&
        parsed.projectOrderUpdatedAt >= 0
          ? Math.floor(parsed.projectOrderUpdatedAt)
          : undefined

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

      const quickExchangeRates: Record<string, QuickExchangeRatePresets> = {}
      if (
        parsed.quickExchangeRates &&
        typeof parsed.quickExchangeRates === 'object'
      ) {
        for (const [pairKey, preset] of Object.entries(parsed.quickExchangeRates)) {
          if (!/^[A-Z]{3}_[A-Z]{3}$/.test(pairKey) || !preset || typeof preset !== 'object') {
            continue
          }
          const clean: QuickExchangeRatePresets = {}
          if (typeof preset.cash === 'number' && Number.isFinite(preset.cash) && preset.cash > 0) {
            clean.cash = preset.cash
          }
          if (typeof preset.card === 'number' && Number.isFinite(preset.card) && preset.card > 0) {
            clean.card = preset.card
          }
          if (clean.cash !== undefined || clean.card !== undefined) {
            quickExchangeRates[pairKey] = clean
          }
        }
      }

      const lastCurrencyByProject: Record<string, string> = {}
      if (
        parsed.lastCurrencyByProject &&
        typeof parsed.lastCurrencyByProject === 'object'
      ) {
        for (const [projId, cur] of Object.entries(parsed.lastCurrencyByProject)) {
          if (
            typeof projId === 'string' &&
            projId.trim() &&
            typeof cur === 'string' &&
            /^[A-Z]{3}$/.test(cur.trim().toUpperCase())
          ) {
            lastCurrencyByProject[projId] = cur.trim().toUpperCase()
          }
        }
      }

      const settlementViewByProject: Record<string, LocalSettlementViewPrefs> = {}
      if (
        parsed.settlementViewByProject &&
        typeof parsed.settlementViewByProject === 'object'
      ) {
        for (const [projId, rawView] of Object.entries(parsed.settlementViewByProject)) {
          if (!projId.trim() || !rawView || typeof rawView !== 'object') continue
          const cleanView: LocalSettlementViewPrefs = {}
          if (
            typeof rawView.settlementCurrency === 'string' &&
            /^[A-Z]{3}$/.test(rawView.settlementCurrency.trim().toUpperCase())
          ) {
            cleanView.settlementCurrency = rawView.settlementCurrency.trim().toUpperCase()
          }
          if (
            rawView.settlementRateMode === 'per_tx' ||
            rawView.settlementRateMode === 'live' ||
            rawView.settlementRateMode === 'custom'
          ) {
            cleanView.settlementRateMode = rawView.settlementRateMode
          }
          if (
            rawView.settlementCustomRates &&
            typeof rawView.settlementCustomRates === 'object'
          ) {
            const cleanFlat: Record<string, number> = {}
            for (const [k, v] of Object.entries(rawView.settlementCustomRates)) {
              const code = k.trim().toUpperCase()
              if (/^[A-Z]{3}$/.test(code) && typeof v === 'number' && Number.isFinite(v) && v > 0) {
                cleanFlat[code] = v
              }
            }
            if (Object.keys(cleanFlat).length > 0) {
              cleanView.settlementCustomRates = cleanFlat
            }
          }
          if (
            rawView.settlementCustomRatesByCurrency &&
            typeof rawView.settlementCustomRatesByCurrency === 'object'
          ) {
            const cleanByCur: Record<string, Record<string, number>> = {}
            for (const [targetCur, bucket] of Object.entries(
              rawView.settlementCustomRatesByCurrency,
            )) {
              const tCode = targetCur.trim().toUpperCase()
              if (!/^[A-Z]{3}$/.test(tCode) || !bucket || typeof bucket !== 'object') continue
              const cleanBucket: Record<string, number> = {}
              for (const [k, v] of Object.entries(bucket)) {
                const code = k.trim().toUpperCase()
                if (/^[A-Z]{3}$/.test(code) && typeof v === 'number' && Number.isFinite(v) && v > 0) {
                  cleanBucket[code] = v
                }
              }
              if (Object.keys(cleanBucket).length > 0) {
                cleanByCur[tCode] = cleanBucket
              }
            }
            if (Object.keys(cleanByCur).length > 0) {
              cleanView.settlementCustomRatesByCurrency = cleanByCur
            }
          }
          if (Object.keys(cleanView).length > 0) {
            settlementViewByProject[projId] = cleanView
          }
        }
      }

      const rawProfile = parsed.userProfile
      const userProfile: UserProfile =
        rawProfile && typeof rawProfile === 'object'
          ? {
              displayName:
                typeof rawProfile.displayName === 'string'
                  ? rawProfile.displayName.trim().slice(0, 50)
                  : '',
              avatarColor:
                typeof rawProfile.avatarColor === 'string' &&
                rawProfile.avatarColor.trim()
                  ? rawProfile.avatarColor.trim()
                  : AVATAR_PALETTE[0],
              avatarImage:
                typeof rawProfile.avatarImage === 'string' &&
                rawProfile.avatarImage.startsWith('data:image/')
                  ? rawProfile.avatarImage
                  : undefined,
              paymentInfo:
                typeof rawProfile.paymentInfo === 'string' &&
                rawProfile.paymentInfo.trim()
                  ? rawProfile.paymentInfo.trim().slice(0, 120)
                  : undefined,
              updatedAt:
                typeof rawProfile.updatedAt === 'number' &&
                Number.isFinite(rawProfile.updatedAt) &&
                rawProfile.updatedAt >= 0
                  ? Math.floor(rawProfile.updatedAt)
                  : undefined,
            }
          : createDefaultUserProfile()

      return {
        defaultCurrency,
        enabledCurrencies: Array.from(enabledSet),
        categories,
        projectOrder,
        projectOrderUpdatedAt,
        exchangeRates,
        quickExchangeRates,
        lastCurrencyByProject,
        settlementViewByProject,
        userProfile,
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

  // 即時多人協作同步狀態、最後同步時間、離線待補傳計數與異常大量刪除熔斷告警
  const syncStatusByProject = ref<Record<string, ProjectRealtimeSyncStatus>>({})
  const lastSyncedAtByProject = ref<Record<string, number>>({})
  const outboxCountByProject = ref<Record<string, number>>({})
  const pendingDeletionGuard = ref<PendingDeletionGuardAlert | null>(null)
  const activeRealtimeUnsubscribers = new Map<string, () => void>()
  const flushingProjectIds = new Set<string>()

  // Google 雲端跨裝置自動同步狀態
  const googleDriveAccount = ref<GoogleDriveAccountInfo | null>(
    getSavedGoogleAccount(),
  )
  const googleDriveAutoSync = ref<boolean>(isGoogleAutoSyncEnabled())
  const googleDriveLastSyncAt = ref<number | null>(getLastGoogleSyncAt())
  const googleDriveDirty = ref<boolean>(hasGoogleDriveDirtyChanges())
  const googleDriveLastErrorCode = ref<GoogleDriveSyncErrorCode | null>(null)
  const googleDriveLastErrorDetail = ref<string | null>(null)
  const googleDriveStatus = ref<GoogleDriveSyncStatus>(
    resolveInitialGoogleDriveStatus(),
  )
  let googleAutoSyncTimer: ReturnType<typeof setTimeout> | null = null
  let googleSyncInFlight: Promise<GoogleDriveSyncResult | null> | null = null

  function resolveInitialGoogleDriveStatus(): GoogleDriveSyncStatus {
    if (isGoogleDriveConnected()) {
      return hasGoogleDriveDirtyChanges() ? 'pending' : 'synced'
    }
    if (isGoogleAutoSyncEnabled() || getSavedGoogleAccount()) {
      return typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'offline'
        : 'needs_auth'
    }
    return 'disconnected'
  }

  // 使用者自訂偏好（預設幣別、可自由增刪的常用幣別、可自由增刪改的消費分類、專案排序、記憶匯率、個人成員檔案）
  const defaultCurrency = ref<string>(initialPrefs.defaultCurrency)
  const enabledCurrencies = ref<string[]>(initialPrefs.enabledCurrencies)
  const categories = ref<ManagedCategory[]>(initialPrefs.categories)
  const projectOrder = ref<string[]>(initialPrefs.projectOrder ?? [])
  const projectOrderUpdatedAt = ref<number>(
    initialPrefs.projectOrderUpdatedAt ?? 0,
  )
  const rememberedExchangeRates = ref<Record<string, number>>(
    initialPrefs.exchangeRates ?? {},
  )
  const quickExchangeRates = ref<Record<string, QuickExchangeRatePresets>>(
    initialPrefs.quickExchangeRates ?? {},
  )
  const lastCurrencyByProject = ref<Record<string, string>>(
    initialPrefs.lastCurrencyByProject ?? {},
  )
  const settlementViewByProject = ref<Record<string, LocalSettlementViewPrefs>>(
    initialPrefs.settlementViewByProject ?? {},
  )
  const userProfile = ref<UserProfile>(
    initialPrefs.userProfile ?? createDefaultUserProfile(),
  )

  // 即時參考匯率響應式快取（每小時自動向免費公開資料庫更新，含抓取時間戳）
  const liveRatesCache = ref<LiveRatesCache | null>(loadCachedLiveRates())
  const isRefreshingLiveRates = ref(false)
  const liveRatesFetchedAt = computed<number | null>(
    () => liveRatesCache.value?.fetchedAt ?? null,
  )
  const liveRatesSource = computed<string>(
    () => liveRatesCache.value?.source ?? '',
  )

  async function refreshExchangeRates(force = false): Promise<LiveRatesCache | null> {
    if (isRefreshingLiveRates.value && !force) return liveRatesCache.value
    isRefreshingLiveRates.value = true
    try {
      const fresh = await refreshLiveExchangeRates(force)
      if (fresh) {
        liveRatesCache.value = fresh
      }
      return liveRatesCache.value
    } finally {
      isRefreshingLiveRates.value = false
    }
  }

  function getLiveExchangeRate(from: string, to: string): number | null {
    const f = from.trim().toUpperCase()
    const tCode = to.trim().toUpperCase()
    if (!f || !tCode) return null
    if (f === tCode) return 1
    const cache = liveRatesCache.value
    if (!cache) return null
    return computeCrossRateFromUsdTable(cache.ratesPerUsd, f, tCode)
  }

  function saveUserPrefs() {
    if (typeof window === 'undefined') return
    try {
      const data: PersistedUserPrefsV2 = {
        defaultCurrency: defaultCurrency.value,
        enabledCurrencies: enabledCurrencies.value,
        categories: categories.value,
        projectOrder: projectOrder.value,
        projectOrderUpdatedAt: projectOrderUpdatedAt.value || undefined,
        exchangeRates: rememberedExchangeRates.value,
        quickExchangeRates: quickExchangeRates.value,
        lastCurrencyByProject: lastCurrencyByProject.value,
        settlementViewByProject: settlementViewByProject.value,
        userProfile: userProfile.value,
      }
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(data))
    } catch {
      // 忽略受限儲存環境
    }
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
    const nextPaymentInfo =
      patch.paymentInfo === null
        ? undefined
        : patch.paymentInfo !== undefined
          ? patch.paymentInfo.trim().slice(0, 120) || undefined
          : userProfile.value.paymentInfo

    const next: UserProfile = {
      displayName:
        patch.displayName !== undefined
          ? patch.displayName.trim().slice(0, 50)
          : userProfile.value.displayName,
      avatarColor:
        patch.avatarColor !== undefined && patch.avatarColor.trim()
          ? patch.avatarColor.trim()
          : userProfile.value.avatarColor || AVATAR_PALETTE[0],
      avatarImage:
        patch.avatarImage === null
          ? undefined
          : patch.avatarImage !== undefined
            ? patch.avatarImage
            : userProfile.value.avatarImage,
      paymentInfo: nextPaymentInfo,
      updatedAt: Date.now(),
    }
    userProfile.value = next
    saveUserPrefs()
    markGoogleDriveDirty()

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

  function clearRememberedExchangeRate(from: string, to: string): void {
    const f = from.trim().toUpperCase()
    const tCode = to.trim().toUpperCase()
    const key = `${f}_${tCode}`
    if (!(key in rememberedExchangeRates.value)) return
    const next = { ...rememberedExchangeRates.value }
    delete next[key]
    rememberedExchangeRates.value = next
    saveUserPrefs()
  }

  function getQuickExchangeRatePresets(
    from: string,
    to: string,
  ): QuickExchangeRatePresets {
    const f = from.trim().toUpperCase()
    const tCode = to.trim().toUpperCase()
    if (!f || !tCode || f === tCode) return {}
    return quickExchangeRates.value[`${f}_${tCode}`] ?? {}
  }

  function saveQuickExchangeRatePreset(
    from: string,
    to: string,
    slot: 'cash' | 'card',
    rate: number,
  ): void {
    const f = from.trim().toUpperCase()
    const tCode = to.trim().toUpperCase()
    if (!f || !tCode || f === tCode) return
    if (!Number.isFinite(rate) || rate <= 0) return
    const key = `${f}_${tCode}`
    quickExchangeRates.value = {
      ...quickExchangeRates.value,
      [key]: {
        ...(quickExchangeRates.value[key] ?? {}),
        [slot]: rate,
      },
    }
    saveUserPrefs()
  }

  function getProjectLastCurrency(projectId: string, fallbackCurrency: string): string {
    const remembered = lastCurrencyByProject.value[projectId]
    if (remembered && /^[A-Z]{3}$/.test(remembered)) {
      return remembered
    }
    return fallbackCurrency.trim().toUpperCase()
  }

  function rememberProjectLastCurrency(projectId: string, currency: string): void {
    const code = currency.trim().toUpperCase()
    if (!projectId || !/^[A-Z]{3}$/.test(code)) return
    if (lastCurrencyByProject.value[projectId] === code) return
    lastCurrencyByProject.value = {
      ...lastCurrencyByProject.value,
      [projectId]: code,
    }
    saveUserPrefs()
  }

  /** 取得專案目前於此裝置結算頁使用的結帳幣別（優先讀取本機視角偏好，未設定時回退專案設定／記帳主幣別） */
  function getProjectSettlementCurrency(
    project: Pick<Project, 'baseCurrency' | 'settlementCurrency'> & { id?: string },
  ): string {
    const localCur = project.id
      ? settlementViewByProject.value[project.id]?.settlementCurrency
      : undefined
    return (localCur || project.settlementCurrency || project.baseCurrency)
      .trim()
      .toUpperCase()
  }

  /** 取得專案目前於此裝置結算頁使用的匯率模式（本機偏好獨立保存，不與旅伴透過 Firestore 互蓋） */
  function getProjectSettlementRateMode(
    project: Pick<Project, 'id' | 'settlementRateMode'>,
  ): 'per_tx' | 'live' | 'custom' {
    return (
      settlementViewByProject.value[project.id]?.settlementRateMode ??
      project.settlementRateMode ??
      'per_tx'
    )
  }

  /** 取得任意兩幣別的最佳參考匯率（即時快取 > 記憶自訂 > 離線估算） */
  function getEffectiveExchangeRate(from: string, to: string): number {
    const f = from.trim().toUpperCase()
    const tCode = to.trim().toUpperCase()
    if (!f || !tCode || f === tCode) return 1
    const live = getLiveExchangeRate(f, tCode)
    if (live !== null && live > 0) return live
    const remembered = getRememberedExchangeRate(f, tCode)
    if (remembered !== null && remembered > 0) return remembered
    return getSuggestedExchangeRate(f, tCode)
  }

  function getProjectCustomRatesForTarget(
    project: Project,
    targetCurrency: string,
  ): Record<string, number> | undefined {
    const target = targetCurrency.trim().toUpperCase()
    const localView = settlementViewByProject.value[project.id]
    const localBucket = localView?.settlementCustomRatesByCurrency?.[target]
    if (localBucket && Object.keys(localBucket).length > 0) {
      return localBucket
    }
    const currentSettle = getProjectSettlementCurrency(project)
    if (
      target === currentSettle &&
      localView?.settlementCustomRates &&
      Object.keys(localView.settlementCustomRates).length > 0
    ) {
      return localView.settlementCustomRates
    }
    const bucket = project.settlementCustomRatesByCurrency?.[target]
    if (bucket && Object.keys(bucket).length > 0) {
      return bucket
    }
    if (
      target === currentSettle &&
      project.settlementCustomRates &&
      Object.keys(project.settlementCustomRates).length > 0
    ) {
      return project.settlementCustomRates
    }
    return undefined
  }

  /**
   * 依據專案設定的結帳幣別與匯率模式（per_tx / live / custom）產出結算幣別與匯率覆寫設定
   */
  function getProjectSettlementRateOverrides(
    project: Project,
    projectTxs?: Transaction[],
  ): Record<string, number> | undefined {
    const mode = getProjectSettlementRateMode(project)
    if (mode === 'per_tx') return undefined

    const settleCurrency = getProjectSettlementCurrency(project)
    const savedCustomForTarget = getProjectCustomRatesForTarget(
      project,
      settleCurrency,
    )
    const txs =
      projectTxs ??
      visibleTransactions.value.filter((tx) => tx.projectId === project.id)
    const foreignCurrencies = new Set<string>()
    for (const tx of txs) {
      const c = tx.currency.trim().toUpperCase()
      if (c && c !== settleCurrency) foreignCurrencies.add(c)
    }

    const overrides: Record<string, number> = {}
    for (const cur of foreignCurrencies) {
      if (mode === 'live') {
        const rate = getEffectiveExchangeRate(cur, settleCurrency)
        if (rate > 0) {
          overrides[cur] = rate
        }
      } else if (mode === 'custom') {
        const custom = savedCustomForTarget?.[cur]
        if (typeof custom === 'number' && Number.isFinite(custom) && custom > 0) {
          overrides[cur] = custom
        } else {
          const fallback = getEffectiveExchangeRate(cur, settleCurrency)
          if (fallback > 0) {
            overrides[cur] = fallback
          }
        }
      }
    }

    return Object.keys(overrides).length > 0 ? overrides : undefined
  }

  function getProjectSettlementOptions(
    project: Project,
    projectTxs?: Transaction[],
  ): { settlementCurrency: string; options: SettleUpOptions } {
    const settlementCurrency = getProjectSettlementCurrency(project)
    const projectBaseCurrency = project.baseCurrency.trim().toUpperCase()
    const overrideRatesByCurrency = getProjectSettlementRateOverrides(
      project,
      projectTxs,
    )
    const baseToSettlementRate =
      projectBaseCurrency === settlementCurrency
        ? 1
        : getEffectiveExchangeRate(projectBaseCurrency, settlementCurrency)

    return {
      settlementCurrency,
      options: {
        ...(overrideRatesByCurrency ? { overrideRatesByCurrency } : {}),
        projectBaseCurrency,
        baseToSettlementRate,
      },
    }
  }

  /**
   * 切換此裝置上的結帳幣別（純本機視角偏好，不推送 Firestore 避免多人結帳時互相覆寫打架）
   */
  async function updateProjectSettlementCurrency(
    projectId: string,
    currency: string,
  ): Promise<Project | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) return null

    const normalized = CurrencyCodeSchema.parse(currency)
    const prevLocal = settlementViewByProject.value[projectId]
    const prevSettleCurrency = getProjectSettlementCurrency(existing)
    if (normalized === prevSettleCurrency && prevLocal?.settlementCurrency === normalized) {
      return existing
    }

    // 依目標結帳幣別分桶完整保留各幣別曾設定的自訂結算匯率，切換後再切回絕不洗掉
    const nextByCurrency: Record<string, Record<string, number>> = {}
    const sourceByCur =
      prevLocal?.settlementCustomRatesByCurrency ??
      existing.settlementCustomRatesByCurrency
    if (sourceByCur) {
      for (const [targetCur, map] of Object.entries(sourceByCur)) {
        nextByCurrency[targetCur] = { ...map }
      }
    }
    const prevFlat =
      prevLocal?.settlementCustomRates ?? existing.settlementCustomRates
    if (prevFlat && Object.keys(prevFlat).length > 0) {
      nextByCurrency[prevSettleCurrency] = {
        ...(nextByCurrency[prevSettleCurrency] ?? {}),
        ...prevFlat,
      }
    }

    const prevMode = getProjectSettlementRateMode(existing)
    const restoredCustomForNewTarget = nextByCurrency[normalized]
    const nextMode =
      prevMode === 'custom' && !restoredCustomForNewTarget ? 'live' : prevMode

    settlementViewByProject.value = {
      ...settlementViewByProject.value,
      [projectId]: {
        settlementCurrency: normalized,
        settlementRateMode: nextMode,
        settlementCustomRates: restoredCustomForNewTarget
          ? { ...restoredCustomForNewTarget }
          : undefined,
        settlementCustomRatesByCurrency:
          Object.keys(nextByCurrency).length > 0 ? nextByCurrency : undefined,
      },
    }
    saveUserPrefs()
    return existing
  }

  /**
   * 切換此裝置上的結算匯率模式／自訂結算匯率（純本機視角偏好，不推送 Firestore）
   */
  async function updateProjectSettlementRateConfig(
    projectId: string,
    mode: 'per_tx' | 'live' | 'custom',
    customRates?: Record<string, number>,
  ): Promise<Project | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) return null

    const prevLocal = settlementViewByProject.value[projectId]
    const settleCurrency = getProjectSettlementCurrency(existing)
    const cleanCustom: Record<string, number> = {}
    if (customRates) {
      for (const [k, v] of Object.entries(customRates)) {
        const code = k.trim().toUpperCase()
        if (/^[A-Z]{3}$/.test(code) && typeof v === 'number' && Number.isFinite(v) && v > 0) {
          cleanCustom[code] = v
        }
      }
    }

    const mergedCurrentCustom =
      Object.keys(cleanCustom).length > 0
        ? cleanCustom
        : getProjectCustomRatesForTarget(existing, settleCurrency)

    const nextByCurrency: Record<string, Record<string, number>> = {}
    const sourceByCur =
      prevLocal?.settlementCustomRatesByCurrency ??
      existing.settlementCustomRatesByCurrency
    if (sourceByCur) {
      for (const [targetCur, map] of Object.entries(sourceByCur)) {
        nextByCurrency[targetCur] = { ...map }
      }
    }
    if (mergedCurrentCustom && Object.keys(mergedCurrentCustom).length > 0) {
      nextByCurrency[settleCurrency] = { ...mergedCurrentCustom }
    }

    settlementViewByProject.value = {
      ...settlementViewByProject.value,
      [projectId]: {
        settlementCurrency: settleCurrency,
        settlementRateMode: mode,
        settlementCustomRates: mergedCurrentCustom
          ? { ...mergedCurrentCustom }
          : prevLocal?.settlementCustomRates,
        settlementCustomRatesByCurrency:
          Object.keys(nextByCurrency).length > 0 ? nextByCurrency : undefined,
      },
    }
    saveUserPrefs()
    return existing
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
    projectOrderUpdatedAt.value = Date.now()
    saveUserPrefs()
    markGoogleDriveDirty()
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
    saveUserPrefs()
    markGoogleDriveDirty()
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

  /** 專案內依當前結帳幣別與結算匯率模式套用換算後之消費清單（供圓餅圖、結算與報表 100% 同步一致） */
  const activeProjectEffectiveExpenses = computed(() => {
    const proj = activeProject.value
    if (!proj) return []
    const { settlementCurrency, options } = getProjectSettlementOptions(
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
    const { settlementCurrency, options } = getProjectSettlementOptions(
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

  /** 各專案累計淨消費總額對照表（以記帳主幣別 baseCurrency 計算，供首頁小卡與頂部標頭顯示） */
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
      const sameCurrency =
        getProjectSettlementCurrency(proj) === proj.baseCurrency.trim().toUpperCase()
      const overrides = sameCurrency
        ? getProjectSettlementRateOverrides(proj, projTxs)
        : undefined
      const settle = calculateSettleUp(
        projTxs,
        proj.baseCurrency,
        proj.members.map((m) => m.id),
        overrides ? { overrideRatesByCurrency: overrides } : undefined,
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
  function addCategory(
    label: string,
    color?: string,
    icon?: string,
  ): ManagedCategory {
    const trimmed = label.trim()
    const key = `custom_${Date.now().toString(36)}`
    const cat: ManagedCategory = {
      key,
      customLabel: trimmed,
      color:
        color || AVATAR_PALETTE[categories.value.length % AVATAR_PALETTE.length],
      icon: isValidCategoryIconKey(icon) ? icon : 'tag',
      isBuiltin: false,
    }
    categories.value = [...categories.value, cat]
    saveUserPrefs()
    markGoogleDriveDirty()
    return cat
  }

  function updateCategory(
    key: string,
    patch: { customLabel?: string; color?: string; icon?: string },
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
        icon: isValidCategoryIconKey(patch.icon) ? patch.icon : cat.icon,
      }
    })
    saveUserPrefs()
    markGoogleDriveDirty()
  }

  function removeCategory(key: string): boolean {
    if (categories.value.length <= 1) {
      return false
    }
    categories.value = categories.value.filter((c) => c.key !== key)
    saveUserPrefs()
    markGoogleDriveDirty()
    return true
  }

  function resetDefaultCategories(): void {
    const existingCustom = categories.value.filter((c) => !c.isBuiltin)
    categories.value = [...cloneDefaultCategories(), ...existingCustom]
    saveUserPrefs()
    markGoogleDriveDirty()
  }

  // ==================== Google 雲端跨裝置自動同步協調器 ====================
  function scheduleGoogleDriveAutoSync(delayMs = 2500): void {
    if (typeof window === 'undefined') return
    if (googleAutoSyncTimer) {
      clearTimeout(googleAutoSyncTimer)
      googleAutoSyncTimer = null
    }
    if (!googleDriveAutoSync.value || !getSavedGoogleClientId()) return
    googleAutoSyncTimer = setTimeout(() => {
      googleAutoSyncTimer = null
      void syncGoogleDriveNow({ silentOnly: true })
    }, delayMs)
  }

  function markGoogleDriveDirty(): void {
    googleDriveDirty.value = true
    setGoogleDriveDirtyChanges(true)
    if (!googleDriveAutoSync.value) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      googleDriveStatus.value = 'offline'
      return
    }
    if (googleDriveStatus.value !== 'syncing') {
      googleDriveStatus.value = 'pending'
    }
    scheduleGoogleDriveAutoSync(2500)
  }

  function setGoogleDriveAutoSync(enabled: boolean): void {
    googleDriveAutoSync.value = enabled
    setGoogleAutoSyncEnabled(enabled)
    if (enabled) {
      if (isGoogleDriveConnected()) {
        googleDriveStatus.value = googleDriveDirty.value ? 'pending' : 'synced'
        if (googleDriveDirty.value) {
          scheduleGoogleDriveAutoSync(600)
        }
      } else if (googleDriveAccount.value) {
        googleDriveStatus.value = 'needs_auth'
      }
    } else if (googleAutoSyncTimer) {
      clearTimeout(googleAutoSyncTimer)
      googleAutoSyncTimer = null
    }
  }

  async function syncGoogleDriveNow(options?: {
    clientId?: string
    silentOnly?: boolean
    selectAccount?: boolean
    enableAutoSyncOnSuccess?: boolean
  }): Promise<GoogleDriveSyncResult | null> {
    if (googleSyncInFlight) {
      return googleSyncInFlight
    }

    const silentOnly = Boolean(options?.silentOnly)
    const effectiveClientId = (
      options?.clientId ?? getSavedGoogleClientId()
    ).trim()

    if (!effectiveClientId) {
      if (silentOnly) return null
      throw new GoogleDriveSyncError('ERR_MISSING_CLIENT_ID')
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      googleDriveStatus.value = 'offline'
      if (silentOnly) return null
      throw new GoogleDriveSyncError('ERR_GIS_LOAD', 'Offline')
    }

    const run = async (): Promise<GoogleDriveSyncResult | null> => {
      googleDriveStatus.value = 'syncing'
      googleDriveLastErrorCode.value = null
      googleDriveLastErrorDetail.value = null
      try {
        const res = await syncWithGoogleDrive({
          clientId: effectiveClientId,
          silentOnly,
          selectAccount: options?.selectAccount,
          hasLocalChanges: googleDriveDirty.value || !googleDriveLastSyncAt.value,
          onMergeRemote: (rawJson) => importAndMergeLedgerBackup(rawJson),
          getMergedBackup: () => exportLedgerBackup(),
        })

        googleDriveLastSyncAt.value = res.syncedAt
        if (res.account) {
          googleDriveAccount.value = res.account
        }
        googleDriveDirty.value = false
        setGoogleDriveDirtyChanges(false)
        googleDriveLastErrorCode.value = null
        googleDriveLastErrorDetail.value = null
        googleDriveStatus.value = 'synced'

        // 首次透過互動式按鈕連結成功時，預設開啟跨裝置自動同步
        if (!silentOnly && options?.enableAutoSyncOnSuccess !== false) {
          if (!googleDriveAutoSync.value) {
            googleDriveAutoSync.value = true
            setGoogleAutoSyncEnabled(true)
          }
        }
        return res
      } catch (err) {
        if (err instanceof GoogleDriveSyncError) {
          if (err.code === 'ERR_OAUTH_SILENT_REQUIRED') {
            googleDriveStatus.value = 'needs_auth'
            googleDriveLastErrorCode.value = null
            googleDriveLastErrorDetail.value = null
            if (silentOnly) return null
            throw err
          }
          googleDriveLastErrorCode.value = err.code
          googleDriveLastErrorDetail.value = err.message
          googleDriveStatus.value = 'error'
          if (silentOnly) return null
          throw err
        }
        googleDriveLastErrorCode.value = null
        googleDriveLastErrorDetail.value =
          err instanceof Error ? err.message : String(err)
        googleDriveStatus.value = 'error'
        if (silentOnly) return null
        throw err
      } finally {
        googleSyncInFlight = null
      }
    }

    googleSyncInFlight = run()
    return googleSyncInFlight
  }

  async function pullGoogleDriveNow(clientId?: string): Promise<{
    stats: LedgerMergeStats
    syncedAt: number
  }> {
    googleDriveStatus.value = 'syncing'
    googleDriveLastErrorCode.value = null
    googleDriveLastErrorDetail.value = null
    try {
      const downloaded = await downloadBackupFromGoogleDrive(clientId, false)
      if (!downloaded) {
        throw new GoogleDriveSyncError('ERR_DRIVE_NOT_FOUND')
      }
      const stats = await importAndMergeLedgerBackup(downloaded.rawJson)
      googleDriveLastSyncAt.value = downloaded.syncedAt
      if (downloaded.account) {
        googleDriveAccount.value = downloaded.account
      }
      googleDriveStatus.value = googleDriveDirty.value ? 'pending' : 'synced'
      return { stats, syncedAt: downloaded.syncedAt }
    } catch (err) {
      if (err instanceof GoogleDriveSyncError) {
        googleDriveLastErrorCode.value = err.code
        googleDriveLastErrorDetail.value = err.message
        if (err.code === 'ERR_OAUTH_SILENT_REQUIRED') {
          googleDriveStatus.value = 'needs_auth'
          throw err
        }
      } else {
        googleDriveLastErrorDetail.value =
          err instanceof Error ? err.message : String(err)
      }
      googleDriveStatus.value = 'error'
      throw err
    }
  }

  function disconnectGoogleDriveAccount(): void {
    if (googleAutoSyncTimer) {
      clearTimeout(googleAutoSyncTimer)
      googleAutoSyncTimer = null
    }
    disconnectGoogleDrive()
    googleDriveAccount.value = null
    googleDriveAutoSync.value = false
    googleDriveLastErrorCode.value = null
    googleDriveLastErrorDetail.value = null
    googleDriveStatus.value = 'disconnected'
  }

  async function tryBackgroundGoogleDriveSync(force = false): Promise<void> {
    if (!googleDriveAutoSync.value) return
    if (!getSavedGoogleClientId()) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      googleDriveStatus.value = 'offline'
      return
    }
    const elapsed = googleDriveLastSyncAt.value
      ? Date.now() - googleDriveLastSyncAt.value
      : Infinity
    if (!force && !googleDriveDirty.value && elapsed < 15_000) {
      return
    }
    await syncGoogleDriveNow({ silentOnly: true })
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
      lastSyncedAtByProject.value = {
        ...lastSyncedAtByProject.value,
        [projectId]: Date.now(),
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
    lastSyncedAtByProject.value = {
      ...lastSyncedAtByProject.value,
      [localProjectId]: Date.now(),
    }
  }

  async function applyRemoteTransactionsList(
    localProjectId: string,
    txList: Transaction[],
  ): Promise<void> {
    if (txList.length === 0) return

    const plainIncomingList = toPlainClone(txList)
    const localMap = new Map(transactions.value.map((t) => [t.id, toPlainClone(t)]))
    const toPersist: Transaction[] = []

    for (const incoming of plainIncomingList) {
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

    const plainToPersist = toPlainClone(toPersist)
    await normalVaultDb.transactions.bulkPut(plainToPersist)
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
    lastSyncedAtByProject.value = {
      ...lastSyncedAtByProject.value,
      [localProjectId]: Date.now(),
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
      lastSyncedAtByProject.value = {
        ...lastSyncedAtByProject.value,
        [projectId]: Date.now(),
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
    applyMyProfile?: boolean
  }): Promise<Project> {
    const now = Date.now()
    const plainRemoteProject = toPlainClone(params.remoteProject)
    const plainRemoteTransactions = toPlainClone(params.remoteTransactions)

    let members = plainRemoteProject.members.map((m) => ({ ...m }))
    let claimedMemberId = params.selectedMemberId
    let projectMemberChanged = false

    const trimmedNewName = params.newMemberName?.trim()
    if (!claimedMemberId && trimmedNewName) {
      const createdMember: ProjectMember = {
        id: `m_${members.length + 1}_${now.toString(36)}`,
        name: trimmedNewName,
        avatarColor:
          userProfile.value.avatarColor ||
          AVATAR_PALETTE[members.length % AVATAR_PALETTE.length],
        ...(userProfile.value.avatarImage
          ? { avatarImage: userProfile.value.avatarImage }
          : {}),
        ...(userProfile.value.paymentInfo
          ? { paymentInfo: userProfile.value.paymentInfo }
          : {}),
      }
      members = [...members, createdMember]
      claimedMemberId = createdMember.id
      projectMemberChanged = true
    } else if (claimedMemberId && params.applyMyProfile) {
      const profile = userProfile.value
      const hasProfileCustom = Boolean(
        profile.displayName ||
          profile.avatarImage ||
          profile.avatarColor ||
          profile.paymentInfo,
      )
      if (hasProfileCustom) {
        members = members.map((m) => {
          if (m.id !== claimedMemberId) return m
          return {
            ...m,
            name: profile.displayName || m.name,
            avatarColor: profile.avatarColor || m.avatarColor,
            ...(profile.avatarImage
              ? { avatarImage: profile.avatarImage }
              : {}),
            ...(profile.paymentInfo
              ? { paymentInfo: profile.paymentInfo }
              : {}),
          }
        })
        projectMemberChanged = true
      }
    }

    const existingLocal = projects.value.find(
      (p) => p.id === plainRemoteProject.id,
    )

    const joinedProject: Project = {
      ...plainRemoteProject,
      members,
      isActive: true,
      isDeleted: false,
      isArchived: false,
      defaultPayerId: claimedMemberId || members[0]?.id,
      updatedAt: projectMemberChanged
        ? Math.max(now, plainRemoteProject.updatedAt + 1)
        : plainRemoteProject.updatedAt,
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

    await applyRemoteTransactionsList(savedProj.id, plainRemoteTransactions)

    if (projectMemberChanged) {
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

  async function rotateProjectInviteLink(
    projectId: string,
  ): Promise<{ shareId: string; accessKey: string } | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    const shareId = existing?.syncMeta?.shareId
    if (!existing || existing.syncMeta?.mode !== 'firestore' || !shareId) {
      return null
    }
    const nextAccessKey = await rotateProjectAccessKeyOnFirestore(shareId)
    const updated: Project = {
      ...existing,
      syncMeta: {
        ...existing.syncMeta,
        accessKey: nextAccessKey,
        lastSyncedAt: Date.now(),
      },
      members: existing.members.map((m) => ({ ...m })),
    }
    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    return { shareId, accessKey: nextAccessKey }
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
      ...(payload.cardCoverImage ? { cardCoverImage: payload.cardCoverImage } : {}),
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
    saveUserPrefs()
    activeProjectId.value = saved.id
    persistActiveProjectId(saved.id)
    markGoogleDriveDirty()
    return saved
  }

  async function updateProject(
    projectId: string,
    patch: UpdateProjectPayload,
  ): Promise<Project | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
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
    const now = Date.now()

    const updated: Project = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      baseCurrency: nextBase,
      defaultSplitMode: patch.defaultSplitMode ?? existing.defaultSplitMode,
      defaultPayerId: patch.defaultPayerId ?? existing.defaultPayerId,
      cardColor: nextCardColor,
      cardCoverImage: nextCardCoverImage,
      members: existing.members.map((m) => ({ ...m })),
      updatedAt: now,
    }

    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))

    // 變更專案記帳主幣別時，自動依舊主幣別➔新主幣別匯率重算既有交易之 exchangeRateToBase（保留原幣金額不毀帳）
    if (baseCurrencyChanged) {
      const oldToNewRate = getEffectiveExchangeRate(oldBase, nextBase)
      if (Number.isFinite(oldToNewRate) && oldToNewRate > 0) {
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
          await enqueueAndFlushProjectChange(
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

    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    markGoogleDriveDirty()
    return saved
  }

  function hasDuplicateMemberName(
    projectId: string,
    candidateName: string,
    excludeMemberId?: string,
  ): boolean {
    const normalized = candidateName.trim().toLowerCase()
    if (!normalized) return false
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
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
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
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
    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    markGoogleDriveDirty()
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
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
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
        ...(nextAvatarImage ? { avatarImage: nextAvatarImage } : { avatarImage: undefined }),
        ...(nextPaymentInfo ? { paymentInfo: nextPaymentInfo } : { paymentInfo: undefined }),
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
    markGoogleDriveDirty()
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
    const updated: Project = {
      ...baseExisting,
      members: remainingMembers,
      defaultPayerId: nextDefaultPayer,
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
        const cleanedTx: Transaction = {
          ...plainTx,
          splitConfig: {
            ...plainTx.splitConfig!,
            shares: nextShares,
          },
          updatedAt: now,
        }
        const savedTx = await saveTransactionToNormalVault(cleanedTx)
        cleanedTxMap.set(savedTx.id, savedTx)
        await enqueueAndFlushProjectChange(
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

    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    markGoogleDriveDirty()
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
    markGoogleDriveDirty()
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
    markGoogleDriveDirty()
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
    markGoogleDriveDirty()
    return saved
  }

  async function saveProjectSplitGroup(
    projectId: string,
    name: string,
    memberIds: string[],
  ): Promise<ProjectSplitGroup | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) return null
    const trimmed = name.trim().slice(0, 32)
    const validIds = new Set(existing.members.map((m) => m.id))
    const cleanIds = Array.from(new Set(memberIds.filter((id) => validIds.has(id))))
    if (!trimmed || cleanIds.length === 0) return null

    const currentGroups = existing.splitGroups ? existing.splitGroups.map((g) => ({ ...g, memberIds: [...g.memberIds] })) : []
    const existingIdx = currentGroups.findIndex(
      (g) => g.name.toLowerCase() === trimmed.toLowerCase(),
    )
    let savedGroup: ProjectSplitGroup
    if (existingIdx >= 0) {
      savedGroup = { ...currentGroups[existingIdx], name: trimmed, memberIds: cleanIds }
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
    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    markGoogleDriveDirty()
    return savedGroup
  }

  async function removeProjectSplitGroup(
    projectId: string,
    groupId: string,
  ): Promise<void> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
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
    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    markGoogleDriveDirty()
  }

  /** 查找專案有效交易中是否遺留尚未掛回成員清單之孤兒公費袋 ID（例如先刪公費成員又復原紀錄） */
  function findOrphanedPoolMemberIdInTransactions(
    projectId: string,
    existingMemberIds: Set<string>,
  ): string | null {
    for (const tx of transactions.value) {
      if (tx.isDeleted || tx.projectId !== projectId || !tx.splitConfig) continue
      const candidateIds: string[] = [
        tx.splitConfig.payerId,
        ...(tx.splitConfig.payers ?? [])
          .filter((p) => p.amount > 0)
          .map((p) => p.memberId),
        ...tx.splitConfig.shares
          .filter((s) => s.finalAmount > 0)
          .map((s) => s.memberId),
      ]
      for (const id of candidateIds) {
        if (id.startsWith('pool_') && !existingMemberIds.has(id)) {
          return id
        }
      }
    }
    return null
  }

  async function ensureProjectPoolMember(
    projectId: string,
    poolName: string,
  ): Promise<ProjectMember | null> {
    const existing = projects.value.find((p) => p.id === projectId && !p.isDeleted)
    if (!existing) return null

    const already = existing.members.find((m) => m.isPool)
    if (already) return already

    const existingMemberIds = new Set(existing.members.map((m) => m.id))
    const orphanedPoolId = findOrphanedPoolMemberIdInTransactions(
      projectId,
      existingMemberIds,
    )

    const poolMember: ProjectMember = {
      id: orphanedPoolId ?? `pool_${Date.now().toString(36)}`,
      name: poolName.trim().slice(0, 50) || 'Pool',
      avatarColor: '#0f766e',
      isPool: true,
    }

    const baseExisting = toPlainClone(existing)
    const updated: Project = {
      ...baseExisting,
      members: [...baseExisting.members.map((m) => ({ ...m })), poolMember],
      updatedAt: Date.now(),
    }
    const saved = await saveProjectToNormalVault(updated)
    projects.value = projects.value.map((p) => (p.id === projectId ? saved : p))
    await enqueueAndFlushProjectChange(projectId, 'project', saved.id, saved.updatedAt)
    markGoogleDriveDirty()
    return poolMember
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
  }): Promise<number> {
    const validContributors = Array.from(
      new Set(
        params.contributorMemberIds.filter(
          (id) => id && id !== params.collectorMemberId,
        ),
      ),
    )
    if (validContributors.length === 0 || params.amountPerMember <= 0) return 0

    let count = 0
    for (const memberId of validContributors) {
      await recordSettlementPayment({
        projectId: params.projectId,
        fromMemberId: memberId,
        toMemberId: params.collectorMemberId,
        amount: params.amountPerMember,
        currency: params.currency,
        exchangeRateToBase: params.exchangeRateToBase,
        date: params.date,
        note: params.note,
      })
      count += 1
    }
    return count
  }

  async function recordSettlementPayment(
    payload: RecordSettlementPayload,
  ): Promise<Transaction> {
    const proj = projects.value.find((p) => p.id === payload.projectId)
    const payCurrency = payload.currency.trim().toUpperCase()
    const baseCurrency = proj?.baseCurrency.trim().toUpperCase() ?? payCurrency
    const effectiveRate =
      payload.exchangeRateToBase && payload.exchangeRateToBase > 0
        ? payload.exchangeRateToBase
        : payCurrency === baseCurrency
          ? 1
          : getEffectiveExchangeRate(payCurrency, baseCurrency)

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

    const editorName = resolveCurrentEditorName(payload.projectId ?? existing.projectId)

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
    markGoogleDriveDirty()
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
    markGoogleDriveDirty()
  }

  async function softDeleteTransactionsBatch(ids: string[]): Promise<string[]> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)))
    if (uniqueIds.length === 0) return []
    const now = Date.now()
    const deletedMap = new Map<string, Transaction>()
    for (const id of uniqueIds) {
      const target = transactions.value.find((tx) => tx.id === id && !tx.isDeleted)
      if (!target) continue
      const updated: Transaction = {
        ...target,
        isDeleted: true,
        updatedAt: now,
      }
      await saveTransactionToNormalVault(updated)
      deletedMap.set(id, updated)
    }
    if (deletedMap.size === 0) return []
    transactions.value = transactions.value.map(
      (tx) => deletedMap.get(tx.id) ?? tx,
    )
    for (const updated of deletedMap.values()) {
      await enqueueAndFlushProjectChange(
        updated.projectId,
        'transaction',
        updated.id,
        updated.updatedAt,
      )
    }
    markGoogleDriveDirty()
    return Array.from(deletedMap.keys())
  }

  async function restoreTransaction(
    id: string,
  ): Promise<{ ok: boolean; projectId?: string }> {
    const target = transactions.value.find((tx) => tx.id === id && tx.isDeleted)
    if (!target) return { ok: false }

    const now = Date.now()

    // 若該筆消費原本屬於某個專案且該專案目前處於軟刪除狀態，一併復原專案；若交易指向已刪除的公費袋 ID，亦自動補回該公費袋成員避免出現孤兒 ID
    let targetProjectId = target.projectId
    if (targetProjectId) {
      const parentProject = projects.value.find((p) => p.id === targetProjectId)
      if (parentProject) {
        const existingMemberIds = new Set(parentProject.members.map((m) => m.id))
        const missingPoolIds = new Set<string>()
        if (target.splitConfig) {
          const refIds = [
            target.splitConfig.payerId,
            ...(target.splitConfig.payers ?? [])
              .filter((p) => p.amount > 0)
              .map((p) => p.memberId),
            ...target.splitConfig.shares
              .filter((s) => s.finalAmount > 0)
              .map((s) => s.memberId),
          ]
          for (const refId of refIds) {
            if (refId.startsWith('pool_') && !existingMemberIds.has(refId)) {
              missingPoolIds.add(refId)
            }
          }
        }

        if (parentProject.isDeleted || missingPoolIds.size > 0) {
          const plainParent = toPlainClone(parentProject)
          const extraPoolMembers: ProjectMember[] = Array.from(missingPoolIds).map(
            (poolId) => ({
              id: poolId,
              name: '公費袋',
              avatarColor: '#0f766e',
              isPool: true,
            }),
          )
          const restoredProject = await saveProjectToNormalVault({
            ...plainParent,
            isDeleted: false,
            isActive: true,
            members: [
              ...plainParent.members.map((m) => ({ ...m })),
              ...extraPoolMembers,
            ],
            updatedAt: now,
          })
          projects.value = projects.value.map((p) =>
            p.id === restoredProject.id ? restoredProject : p,
          )
          await enqueueAndFlushProjectChange(
            restoredProject.id,
            'project',
            restoredProject.id,
            restoredProject.updatedAt,
          )
        }
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
    markGoogleDriveDirty()
    return { ok: true, projectId: saved.projectId }
  }

  async function restoreProject(
    projectId: string,
  ): Promise<{ ok: boolean; restoredTxCount: number; projectName?: string }> {
    const target = projects.value.find((p) => p.id === projectId && p.isDeleted)
    if (!target) return { ok: false, restoredTxCount: 0 }

    const now = Date.now()
    const restoredProject: Project = {
      ...target,
      isDeleted: false,
      isActive: true,
      isArchived: false,
      members: target.members.map((m) => ({ ...m })),
      updatedAt: now,
    }
    const savedProj = await saveProjectToNormalVault(restoredProject)
    projects.value = projects.value.map((p) =>
      p.id === projectId ? savedProj : p,
    )

    // 一併復原隨該專案軟刪除之關聯交易
    const relatedDeleted = transactions.value.filter(
      (tx) => tx.projectId === projectId && tx.isDeleted,
    )
    const restoredMap = new Map<string, Transaction>()
    for (const tx of relatedDeleted) {
      const savedTx = await saveTransactionToNormalVault({
        ...tx,
        isDeleted: false,
        updatedAt: now,
      })
      restoredMap.set(savedTx.id, savedTx)
    }
    if (restoredMap.size > 0) {
      transactions.value = transactions.value.map(
        (tx) => restoredMap.get(tx.id) ?? tx,
      )
    }

    activeProjectId.value = savedProj.id
    persistActiveProjectId(savedProj.id)
    markGoogleDriveDirty()
    return {
      ok: true,
      restoredTxCount: restoredMap.size,
      projectName: savedProj.name,
    }
  }

  async function permanentlyDeleteProject(projectId: string): Promise<void> {
    const relatedIds = transactions.value
      .filter((tx) => tx.projectId === projectId)
      .map((tx) => tx.id)
    if (relatedIds.length > 0) {
      await normalVaultDb.transactions.bulkDelete(relatedIds)
      const idSet = new Set(relatedIds)
      transactions.value = transactions.value.filter((tx) => !idSet.has(tx.id))
    }
    await normalVaultDb.projects.delete(projectId)
    projects.value = projects.value.filter((p) => p.id !== projectId)
    projectOrder.value = projectOrder.value.filter((id) => id !== projectId)
    saveUserPrefs()
  }

  async function permanentlyDeleteTransaction(id: string): Promise<void> {
    await normalVaultDb.transactions.delete(id)
    transactions.value = transactions.value.filter((tx) => tx.id !== id)
  }

  async function emptyTrash(): Promise<number> {
    const txIds = deletedTransactions.value.map((tx) => tx.id)
    const projIds = deletedProjects.value.map((p) => p.id)
    const total = txIds.length + projIds.length
    if (total === 0) return 0

    if (txIds.length > 0) {
      await normalVaultDb.transactions.bulkDelete(txIds)
      const deletedSet = new Set(txIds)
      transactions.value = transactions.value.filter((tx) => !deletedSet.has(tx.id))
    }
    if (projIds.length > 0) {
      await normalVaultDb.projects.bulkDelete(projIds)
      const projSet = new Set(projIds)
      projects.value = projects.value.filter((p) => !projSet.has(p.id))
      projectOrder.value = projectOrder.value.filter((id) => !projSet.has(id))
      saveUserPrefs()
    }
    return total
  }

  /** 將含 Vue Reactive Proxy 的資料深拷貝為純淨 Plain Object，徹底避免 IndexedDB structuredClone DataCloneError */
  function toPlainClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }

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

  function exportLedgerBackup(options?: { omitReceiptImages?: boolean }): LedgerBackup {
    const clonedTxs = cloneTransactionsForBackup(transactions.value).map((tx) => {
      if (options?.omitReceiptImages && tx.receiptImages) {
        const { receiptImages: _ignored, ...rest } = tx
        return rest
      }
      return tx
    })
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
    const target = projects.value.find((p) => p.id === projectId && !p.isDeleted)
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

    const plainProjects = toPlainClone(merged.projects)
    const plainTransactions = toPlainClone(merged.transactions)

    if (plainProjects.length > 0) {
      await normalVaultDb.projects.bulkPut(plainProjects)
    }
    if (plainTransactions.length > 0) {
      await normalVaultDb.transactions.bulkPut(plainTransactions)
    }

    projects.value = plainProjects
    transactions.value = plainTransactions

    let prefsChanged = false
    if (merged.categories.length > 0) {
      categories.value = toPlainClone(merged.categories)
      prefsChanged = true
    }
    if (merged.userProfileUpdated && merged.userProfile) {
      userProfile.value = toPlainClone(merged.userProfile)
      prefsChanged = true
    }
    if (merged.projectOrderUpdated && merged.projectOrder) {
      projectOrder.value = toPlainClone(merged.projectOrder)
      if (merged.projectOrderUpdatedAt !== undefined) {
        projectOrderUpdatedAt.value = merged.projectOrderUpdatedAt
      }
      prefsChanged = true
    }
    if (prefsChanged) {
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
    lastSyncedAtByProject,
    outboxCountByProject,
    pendingDeletionGuard,
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
    activeProjectEffectiveExpenses,
    activeProjectSettlements,
    activeProjectSettleUp,
    activeProjectBaseSettleUp,
    projectTotalExpenseMap,
    liveRatesCache,
    liveRatesFetchedAt,
    liveRatesSource,
    isRefreshingLiveRates,
    refreshExchangeRates,
    getLiveExchangeRate,
    getEffectiveExchangeRate,
    getProjectSettlementCurrency,
    getProjectSettlementRateMode,
    getProjectSettlementOptions,
    settlementViewByProject,
    getProjectTotalExpense,
    getProjectTransactionCount,
    getRememberedExchangeRate,
    rememberExchangeRate,
    clearRememberedExchangeRate,
    getQuickExchangeRatePresets,
    saveQuickExchangeRatePreset,
    getProjectLastCurrency,
    rememberProjectLastCurrency,
    getProjectSettlementRateOverrides,
    getProjectCustomRatesForTarget,
    updateProjectSettlementCurrency,
    updateProjectSettlementRateConfig,
    getProjectById,
    getAnyProjectById,
    setDefaultCurrency,
    addCurrency,
    removeCurrency,
    addCategory,
    updateCategory,
    removeCategory,
    resetDefaultCategories,
    updateUserProfile,
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
    hasDuplicateMemberName,
    saveProjectSplitGroup,
    removeProjectSplitGroup,
    ensureProjectPoolMember,
    batchCollectPoolFund,
    isMemberUsedInProjectTransactions,
    softDeleteProject,
    restoreProject,
    permanentlyDeleteProject,
    selectProject,
    addTransaction,
    recordSettlementPayment,
    updateTransaction,
    softDeleteTransaction,
    softDeleteTransactionsBatch,
    restoreTransaction,
    permanentlyDeleteTransaction,
    emptyTrash,
    storageUsageStats,
    exportLedgerBackup,
    exportProjectBackup,
    importAndMergeLedgerBackup,
    enableProjectRealtimeSync,
    fetchSharedProjectForJoin,
    finalizeJoinSharedProject,
    setMyMemberForProject,
    rotateProjectInviteLink,
    stopProjectRealtimeSync,
    startProjectRealtimeListener,
    startAllSharedProjectListeners,
    stopAllSharedProjectListeners,
    flushProjectOutbox,
    flushAllSharedProjectsOutbox,
    approvePendingRemoteDeletes,
    rejectPendingRemoteDeletes,
    setGoogleDriveAutoSync,
    syncGoogleDriveNow,
    pullGoogleDriveNow,
    disconnectGoogleDriveAccount,
    tryBackgroundGoogleDriveSync,
  }
})
