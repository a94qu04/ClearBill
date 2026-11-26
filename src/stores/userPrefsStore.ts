import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  CurrencyCodeSchema,
  type SplitConfig,
  type UserProfile,
} from '@/schemas/ledgerSchema'
import {
  createDefaultUserPrefs,
  parseUserPrefsV1Json,
  parseUserPrefsV2Json,
  type ManagedCategory,
  type PersistedUserPrefsV2,
  type QuickExchangeRatePresets,
} from '@/schemas/userPrefsSchema'
import type { LocalSettlementViewPrefs } from '@/core/settlementRateResolver'
import { getSuggestedExchangeRate } from '@/core/ledgerHelpers'
import { isValidCategoryIconKey } from '@/core/categoryIcons'
import {
  computeCrossRateFromUsdTable,
  LIVE_RATES_CACHE_TTL_MS,
  loadCachedLiveRates,
  refreshLiveExchangeRates,
  type LiveRatesCache,
} from '@/services/exchangeRateService'

export const PREFS_STORAGE_KEY = 'clearbill_user_prefs_v2'

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

export type { ManagedCategory }

export const DEFAULT_MANAGED_CATEGORIES: ManagedCategory[] = [
  { key: 'cat_food', color: '#ea580c', icon: 'utensils', isBuiltin: true },
  { key: 'cat_transport', color: '#2563eb', icon: 'train', isBuiltin: true },
  { key: 'cat_lodging', color: '#7c3aed', icon: 'bed', isBuiltin: true },
  { key: 'cat_shopping', color: '#db2777', icon: 'shopping_bag', isBuiltin: true },
  { key: 'cat_entertainment', color: '#0891b2', icon: 'ticket', isBuiltin: true },
  { key: 'cat_daily', color: '#ca8a04', icon: 'package', isBuiltin: true },
  { key: 'cat_other', color: '#475569', icon: 'tag', isBuiltin: true },
]

export function createDefaultUserProfile(): UserProfile {
  return {
    displayName: '',
    avatarColor: AVATAR_PALETTE[0],
    avatarImage: undefined,
    paymentInfo: undefined,
  }
}

export function cloneDefaultCategories(): ManagedCategory[] {
  return DEFAULT_MANAGED_CATEGORIES.map((c) => ({ ...c }))
}

const USER_PREFS_PARSE_DEFAULTS = {
  initialCurrencies: INITIAL_CURRENCIES,
  defaultCategories: DEFAULT_MANAGED_CATEGORIES,
  defaultAvatarColor: AVATAR_PALETTE[0],
} as const

export function loadUserPrefs(): PersistedUserPrefsV2 {
  if (typeof window === 'undefined') {
    return createDefaultUserPrefs(USER_PREFS_PARSE_DEFAULTS)
  }

  try {
    const rawV2 = window.localStorage.getItem(PREFS_STORAGE_KEY)
    if (rawV2) {
      return parseUserPrefsV2Json(rawV2, USER_PREFS_PARSE_DEFAULTS)
    }

    // 向下相容遷移 v1 偏好設定
    const rawV1 = window.localStorage.getItem('clearbill_user_prefs_v1')
    if (rawV1) {
      return parseUserPrefsV1Json(rawV1, USER_PREFS_PARSE_DEFAULTS)
    }
  } catch {
    return createDefaultUserPrefs(USER_PREFS_PARSE_DEFAULTS)
  }

  return createDefaultUserPrefs(USER_PREFS_PARSE_DEFAULTS)
}

/** 將消費拆帳結果正規化為可重用記憶模板（保留墊付人、拆帳模式與分攤名單／比例，不帶入舊帳單固定金額避免阻擋下筆） */
export function sanitizeSplitConfigForMemory(config: SplitConfig): SplitConfig {
  const primaryPayerId =
    config.payers && config.payers.length > 0
      ? [...config.payers].sort((a, b) => b.amount - a.amount)[0].memberId
      : config.payerId
  return {
    payerId: primaryPayerId,
    mode: config.mode,
    shares: config.shares.map((s) => {
      if (config.mode === 'weight') {
        const weight =
          s.weight !== undefined ? s.weight : s.finalAmount > 0 ? 1 : 0
        return {
          memberId: s.memberId,
          finalAmount: 0,
          isIncludedInRemainder: weight > 0,
          weight,
        }
      }
      if (config.mode === 'percentage') {
        const percent = s.percent ?? 0
        return {
          memberId: s.memberId,
          finalAmount: 0,
          isIncludedInRemainder: percent > 0,
          percent,
        }
      }
      if (config.mode === 'custom_plus_equal') {
        const included = Boolean(
          s.isIncludedInRemainder ||
            (s.customAmount ?? 0) > 0 ||
            s.finalAmount > 0,
        )
        return {
          memberId: s.memberId,
          finalAmount: 0,
          customAmount: 0,
          isIncludedInRemainder: included,
        }
      }
      const included =
        s.isIncludedInRemainder !== undefined
          ? s.isIncludedInRemainder
          : s.finalAmount > 0
      return {
        memberId: s.memberId,
        finalAmount: 0,
        isIncludedInRemainder: included,
      }
    }),
  }
}

export const useUserPrefsStore = defineStore('userPrefs', () => {
  const initialPrefs = loadUserPrefs()

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
  const lastExpenseProjectId = ref<string>(
    initialPrefs.lastExpenseProjectId ?? '',
  )
  const lastCurrencyByProject = ref<Record<string, string>>(
    initialPrefs.lastCurrencyByProject ?? {},
  )
  const lastSplitByProject = ref<Record<string, SplitConfig>>(
    initialPrefs.lastSplitByProject ?? {},
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

  let onDriveDirtyHook: (() => void) | null = null

  function bindDriveDirtyHook(callback: () => void): void {
    onDriveDirtyHook = callback
  }

  function notifyDriveDirty(): void {
    onDriveDirtyHook?.()
  }

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

  function saveUserPrefs(): void {
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
        lastExpenseProjectId: lastExpenseProjectId.value || undefined,
        lastCurrencyByProject: lastCurrencyByProject.value,
        lastSplitByProject: lastSplitByProject.value,
        settlementViewByProject: settlementViewByProject.value,
        userProfile: userProfile.value,
      }
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(data))
    } catch {
      // 忽略受限儲存環境
    }
  }

  function applyUserProfilePatch(patch: {
    displayName?: string
    avatarColor?: string
    avatarImage?: string | null
    paymentInfo?: string | null
  }): UserProfile {
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
    notifyDriveDirty()
    return next
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

  function rememberLastExpenseProject(projectId: string): void {
    const id = projectId.trim()
    if (!id || lastExpenseProjectId.value === id) return
    lastExpenseProjectId.value = id
    saveUserPrefs()
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

  function rememberProjectLastSplitConfig(
    projectId: string,
    config: SplitConfig,
  ): void {
    if (!projectId || !config) return
    const sanitized = sanitizeSplitConfigForMemory(config)
    lastSplitByProject.value = {
      ...lastSplitByProject.value,
      [projectId]: sanitized,
    }
    saveUserPrefs()
  }

  /** 取得任意兩幣別的最佳參考匯率與來源（即時快取 > 記憶自訂 > 離線估算；查無時回傳 null，不再靜默 1:1） */
  function getEffectiveExchangeRateWithSource(
    from: string,
    to: string,
  ): {
    rate: number | null
    source: 'same' | 'live' | 'remembered' | 'estimated' | 'missing'
  } {
    const f = from.trim().toUpperCase()
    const tCode = to.trim().toUpperCase()
    if (!f || !tCode) return { rate: null, source: 'missing' }
    if (f === tCode) return { rate: 1, source: 'same' }
    const live = getLiveExchangeRate(f, tCode)
    if (live !== null && live > 0) return { rate: live, source: 'live' }
    const remembered = getRememberedExchangeRate(f, tCode)
    if (remembered !== null && remembered > 0) {
      return { rate: remembered, source: 'remembered' }
    }
    const suggested = getSuggestedExchangeRate(f, tCode)
    if (suggested !== null && suggested > 0) {
      return { rate: suggested, source: 'estimated' }
    }
    return { rate: null, source: 'missing' }
  }

  /** 取得任意兩幣別的最佳參考匯率（即時快取 > 記憶自訂 > 離線估算；查無時回傳 null） */
  function getEffectiveExchangeRate(from: string, to: string): number | null {
    return getEffectiveExchangeRateWithSource(from, to).rate
  }

  const availableCurrencies = computed(() => {
    const set = new Set<string>(enabledCurrencies.value)
    if (defaultCurrency.value) set.add(defaultCurrency.value)
    return Array.from(set)
  })

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
    notifyDriveDirty()
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
    notifyDriveDirty()
  }

  function removeCategory(key: string): boolean {
    if (categories.value.length <= 1) {
      return false
    }
    categories.value = categories.value.filter((c) => c.key !== key)
    saveUserPrefs()
    notifyDriveDirty()
    return true
  }

  function resetDefaultCategories(): void {
    const existingCustom = categories.value.filter((c) => !c.isBuiltin)
    categories.value = [...cloneDefaultCategories(), ...existingCustom]
    saveUserPrefs()
    notifyDriveDirty()
  }

  return {
    defaultCurrency,
    enabledCurrencies,
    categories,
    projectOrder,
    projectOrderUpdatedAt,
    rememberedExchangeRates,
    quickExchangeRates,
    lastExpenseProjectId,
    lastCurrencyByProject,
    lastSplitByProject,
    settlementViewByProject,
    userProfile,
    liveRatesCache,
    liveRatesCacheTtlMs: LIVE_RATES_CACHE_TTL_MS,
    isRefreshingLiveRates,
    liveRatesFetchedAt,
    liveRatesSource,
    availableCurrencies,
    bindDriveDirtyHook,
    refreshExchangeRates,
    getLiveExchangeRate,
    saveUserPrefs,
    applyUserProfilePatch,
    getRememberedExchangeRate,
    rememberExchangeRate,
    clearRememberedExchangeRate,
    getQuickExchangeRatePresets,
    saveQuickExchangeRatePreset,
    rememberLastExpenseProject,
    rememberProjectLastCurrency,
    rememberProjectLastSplitConfig,
    getEffectiveExchangeRateWithSource,
    getEffectiveExchangeRate,
    setDefaultCurrency,
    addCurrency,
    removeCurrency,
    addCategory,
    updateCategory,
    removeCategory,
    resetDefaultCategories,
  }
})
