import type { Project, Transaction } from '@/schemas/ledgerSchema'
import type { SettleUpOptions } from '@/core/settleUpEngine'

export type SettlementRateMode = 'per_tx' | 'live' | 'custom'

export type ExchangeRateSource =
  | 'same'
  | 'live'
  | 'remembered'
  | 'estimated'
  | 'missing'

export type SettlementRateSource = ExchangeRateSource | 'custom'

export interface ExchangeRateLookupResult {
  rate: number | null
  source: ExchangeRateSource
}

export type ExchangeRateLookupFn = (
  fromCurrency: string,
  toCurrency: string,
) => ExchangeRateLookupResult

export interface LocalSettlementViewPrefs {
  settlementCurrency?: string
  settlementRateMode?: SettlementRateMode
  settlementCustomRates?: Record<string, number>
  settlementCustomRatesByCurrency?: Record<string, Record<string, number>>
}

export type SettlementProjectLike = Pick<
  Project,
  | 'baseCurrency'
  | 'settlementCurrency'
  | 'settlementRateMode'
  | 'settlementCustomRates'
  | 'settlementCustomRatesByCurrency'
> & { id?: string }

export interface ResolvedRateWithSource {
  rate: number | null
  source: SettlementRateSource
}

export interface ResolvedSettlementOptions {
  settlementCurrency: string
  projectBaseCurrency: string
  mode: SettlementRateMode
  isCrossCurrency: boolean
  /** 1 projectBaseCurrency = ? settlementCurrency */
  baseToSettlement: ResolvedRateWithSource
  /** 1 settlementCurrency = ? projectBaseCurrency（與 baseToSettlement 互為倒數，確保兩向一致） */
  settlementToBase: ResolvedRateWithSource
  /** 傳遞給 calculateSettleUp / applySettlementRatesToTransactions 的選項 */
  options: SettleUpOptions
}

export function normalizeCurrencyCode(code: string | undefined | null): string {
  return (code ?? '').trim().toUpperCase()
}

function isPositiveFiniteRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
}

/** 過濾並正規化自訂匯率表，僅保留 3 碼大寫幣別與大於 0 的有限數值 */
export function sanitizeCustomRatesMap(
  customRates?: Record<string, number>,
): Record<string, number> {
  const clean: Record<string, number> = {}
  if (!customRates) return clean
  for (const [k, v] of Object.entries(customRates)) {
    const code = normalizeCurrencyCode(k)
    if (/^[A-Z]{3}$/.test(code) && isPositiveFiniteRate(v)) {
      clean[code] = v
    }
  }
  return clean
}

/** 檢查專案是否仍帶有舊版結算視角欄位（已改由本機裝置視角保存） */
export function hasLegacyProjectSettlementFields(
  project: SettlementProjectLike,
): boolean {
  return Boolean(
    project.settlementCurrency ||
      project.settlementRateMode ||
      (project.settlementCustomRates &&
        Object.keys(project.settlementCustomRates).length > 0) ||
      (project.settlementCustomRatesByCurrency &&
        Object.keys(project.settlementCustomRatesByCurrency).length > 0),
  )
}

/**
 * 從專案舊欄位抽取為本機結算視角物件，供一次性遷移使用。
 * 若專案沒有任何舊結算欄位則回傳 null。
 */
export function extractLegacySettlementView(
  project: SettlementProjectLike,
): LocalSettlementViewPrefs | null {
  if (!hasLegacyProjectSettlementFields(project)) return null

  const settlementCurrency = normalizeCurrencyCode(
    project.settlementCurrency || project.baseCurrency,
  )
  const settlementRateMode: SettlementRateMode =
    project.settlementRateMode ?? 'per_tx'
  const cleanFlat = sanitizeCustomRatesMap(project.settlementCustomRates)
  const mergedBuckets = mergeCustomRateBuckets({
    existingBuckets: project.settlementCustomRatesByCurrency,
    targetCurrency: settlementCurrency,
    targetRates: Object.keys(cleanFlat).length > 0 ? cleanFlat : undefined,
    overwriteTarget: false,
  })
  const currentTargetRates = mergedBuckets?.[settlementCurrency]

  return {
    ...(settlementCurrency ? { settlementCurrency } : {}),
    settlementRateMode,
    ...(currentTargetRates && Object.keys(currentTargetRates).length > 0
      ? { settlementCustomRates: { ...currentTargetRates } }
      : {}),
    ...(mergedBuckets
      ? { settlementCustomRatesByCurrency: mergedBuckets }
      : {}),
  }
}

export interface MigrateLegacySettlementViewsResult {
  nextLocalViews: Record<string, LocalSettlementViewPrefs>
  migratedProjectIds: string[]
  changed: boolean
}

/**
 * 一次性將帶有舊結算欄位的專案遷移至本機結算視角表（`settlementViewByProject`）。
 * 若該專案已存在本機視角設定，一律以本機視角為準，不覆寫。
 */
export function migrateLegacyProjectSettlementViews(
  projects: ReadonlyArray<Pick<Project, 'id'> & SettlementProjectLike>,
  existingLocalViews: Record<string, LocalSettlementViewPrefs>,
): MigrateLegacySettlementViewsResult {
  const nextLocalViews: Record<string, LocalSettlementViewPrefs> = {
    ...existingLocalViews,
  }
  const migratedProjectIds: string[] = []

  for (const project of projects) {
    if (!project.id || nextLocalViews[project.id]) continue
    const extracted = extractLegacySettlementView(project)
    if (!extracted) continue
    nextLocalViews[project.id] = extracted
    migratedProjectIds.push(project.id)
  }

  return {
    nextLocalViews,
    migratedProjectIds,
    changed: migratedProjectIds.length > 0,
  }
}

/**
 * 解析此裝置上專案結算頁使用的結帳幣別：
 * - 若本機視角已存在，僅以本機視角為準（缺值時回退記帳主幣別），不再回退舊專案欄位。
 * - 若本機視角尚未建立，兼容回退舊專案欄位後再回退記帳主幣別。
 */
export function resolveSettlementCurrency(
  project: Pick<Project, 'baseCurrency' | 'settlementCurrency'>,
  localView?: LocalSettlementViewPrefs | null,
): string {
  if (localView) {
    return normalizeCurrencyCode(
      localView.settlementCurrency || project.baseCurrency,
    )
  }
  return normalizeCurrencyCode(
    project.settlementCurrency || project.baseCurrency,
  )
}

/**
 * 解析此裝置上專案結算頁使用的匯率模式：
 * - 若本機視角已存在，僅以本機視角為準（缺值時回退 per_tx），不再回退舊專案欄位。
 * - 若本機視角尚未建立，兼容回退舊專案欄位後再回退 per_tx。
 */
export function resolveSettlementRateMode(
  project: Pick<Project, 'settlementRateMode'>,
  localView?: LocalSettlementViewPrefs | null,
): SettlementRateMode {
  if (localView) {
    return localView.settlementRateMode ?? 'per_tx'
  }
  return project.settlementRateMode ?? 'per_tx'
}

/**
 * 讀取指定目標結帳幣別對應的自訂匯率對照表。
 * 若本機視角已存在，僅讀取本機視角分桶與平鋪設定，不再混讀專案舊欄位。
 */
export function resolveCustomRatesForTarget(
  project: SettlementProjectLike,
  localView: LocalSettlementViewPrefs | null | undefined,
  targetCurrency: string,
): Record<string, number> | undefined {
  const target = normalizeCurrencyCode(targetCurrency)
  if (!target) return undefined

  const currentSettle = resolveSettlementCurrency(project, localView)

  if (localView) {
    const localBucket = localView.settlementCustomRatesByCurrency?.[target]
    if (localBucket && Object.keys(localBucket).length > 0) {
      return localBucket
    }
    if (
      target === currentSettle &&
      localView.settlementCustomRates &&
      Object.keys(localView.settlementCustomRates).length > 0
    ) {
      return localView.settlementCustomRates
    }
    return undefined
  }

  const projectBucket = project.settlementCustomRatesByCurrency?.[target]
  if (projectBucket && Object.keys(projectBucket).length > 0) {
    return projectBucket
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
 * 合併依目標結帳幣別分桶的自訂匯率表，確保切換結帳幣別或更新自訂匯率時不互相覆寫洗掉
 */
export function mergeCustomRateBuckets(params: {
  existingBuckets?: Record<string, Record<string, number>>
  targetCurrency: string
  targetRates?: Record<string, number>
  /** true：以 targetRates 覆蓋該目標幣別分桶；false：與既有分桶淺合併 */
  overwriteTarget?: boolean
}): Record<string, Record<string, number>> | undefined {
  const nextByCurrency: Record<string, Record<string, number>> = {}
  if (params.existingBuckets) {
    for (const [targetCur, map] of Object.entries(params.existingBuckets)) {
      const normalizedTarget = normalizeCurrencyCode(targetCur)
      if (!normalizedTarget) continue
      const cleanMap = sanitizeCustomRatesMap(map)
      if (Object.keys(cleanMap).length > 0) {
        nextByCurrency[normalizedTarget] = cleanMap
      }
    }
  }

  const target = normalizeCurrencyCode(params.targetCurrency)
  const cleanTargetRates = sanitizeCustomRatesMap(params.targetRates)
  if (target && Object.keys(cleanTargetRates).length > 0) {
    nextByCurrency[target] = params.overwriteTarget
      ? cleanTargetRates
      : {
          ...(nextByCurrency[target] ?? {}),
          ...cleanTargetRates,
        }
  }

  return Object.keys(nextByCurrency).length > 0 ? nextByCurrency : undefined
}

/** 切換目標結帳幣別時，產出更新後的本機結算視角設定（完整保留各目標幣別分桶） */
export function buildNextSettlementViewForCurrencyChange(
  project: SettlementProjectLike,
  localView: LocalSettlementViewPrefs | null | undefined,
  nextCurrency: string,
): LocalSettlementViewPrefs {
  const normalized = normalizeCurrencyCode(nextCurrency)
  const prevSettleCurrency = resolveSettlementCurrency(project, localView)
  const sourceByCur = localView
    ? localView.settlementCustomRatesByCurrency
    : project.settlementCustomRatesByCurrency
  const prevFlat = localView
    ? localView.settlementCustomRates
    : project.settlementCustomRates

  const nextByCurrency = mergeCustomRateBuckets({
    existingBuckets: sourceByCur,
    targetCurrency: prevSettleCurrency,
    targetRates: prevFlat,
    overwriteTarget: false,
  })

  const prevMode = resolveSettlementRateMode(project, localView)
  const restoredCustomForNewTarget = nextByCurrency?.[normalized]
  const nextMode: SettlementRateMode =
    prevMode === 'custom' && !restoredCustomForNewTarget ? 'live' : prevMode

  return {
    settlementCurrency: normalized,
    settlementRateMode: nextMode,
    settlementCustomRates: restoredCustomForNewTarget
      ? { ...restoredCustomForNewTarget }
      : undefined,
    settlementCustomRatesByCurrency: nextByCurrency,
  }
}

/** 切換結算匯率模式或更新自訂匯率時，產出更新後的本機結算視角設定 */
export function buildNextSettlementViewForRateConfig(
  project: SettlementProjectLike,
  localView: LocalSettlementViewPrefs | null | undefined,
  mode: SettlementRateMode,
  customRates?: Record<string, number>,
): LocalSettlementViewPrefs {
  const settleCurrency = resolveSettlementCurrency(project, localView)
  const cleanCustom = sanitizeCustomRatesMap(customRates)
  const mergedCurrentCustom =
    Object.keys(cleanCustom).length > 0
      ? cleanCustom
      : resolveCustomRatesForTarget(project, localView, settleCurrency)

  const sourceByCur = localView
    ? localView.settlementCustomRatesByCurrency
    : project.settlementCustomRatesByCurrency
  const nextByCurrency = mergeCustomRateBuckets({
    existingBuckets: sourceByCur,
    targetCurrency: settleCurrency,
    targetRates: mergedCurrentCustom,
    overwriteTarget: true,
  })

  return {
    settlementCurrency: settleCurrency,
    settlementRateMode: mode,
    settlementCustomRates: mergedCurrentCustom
      ? { ...mergedCurrentCustom }
      : localView?.settlementCustomRates,
    settlementCustomRatesByCurrency: nextByCurrency,
  }
}

/**
 * 統一解析結算幣別、匯率覆寫表與主幣別↔結帳幣別雙向匯率（保證兩向互為倒數）
 */
export function resolveSettlementOptions(
  project: SettlementProjectLike,
  localView: LocalSettlementViewPrefs | null | undefined,
  txs: ReadonlyArray<Pick<Transaction, 'currency' | 'isDeleted'>>,
  rateLookup: ExchangeRateLookupFn,
): ResolvedSettlementOptions {
  const settlementCurrency = resolveSettlementCurrency(project, localView)
  const projectBaseCurrency = normalizeCurrencyCode(project.baseCurrency)
  const mode = resolveSettlementRateMode(project, localView)
  const isCrossCurrency =
    Boolean(settlementCurrency) &&
    Boolean(projectBaseCurrency) &&
    settlementCurrency !== projectBaseCurrency

  const savedCustomForTarget = resolveCustomRatesForTarget(
    project,
    localView,
    settlementCurrency,
  )

  let overrideRatesByCurrency: Record<string, number> | undefined
  if (mode !== 'per_tx') {
    const foreignCurrencies = new Set<string>()
    for (const tx of txs) {
      if (tx.isDeleted) continue
      const c = normalizeCurrencyCode(tx.currency)
      if (c && c !== settlementCurrency) {
        foreignCurrencies.add(c)
      }
    }

    const overrides: Record<string, number> = {}
    for (const cur of foreignCurrencies) {
      if (mode === 'live') {
        const looked = rateLookup(cur, settlementCurrency)
        if (isPositiveFiniteRate(looked.rate)) {
          overrides[cur] = looked.rate
        }
      } else if (mode === 'custom') {
        const custom = savedCustomForTarget?.[cur]
        if (isPositiveFiniteRate(custom)) {
          overrides[cur] = custom
        } else {
          const fallback = rateLookup(cur, settlementCurrency)
          if (isPositiveFiniteRate(fallback.rate)) {
            overrides[cur] = fallback.rate
          }
        }
      }
    }

    if (Object.keys(overrides).length > 0) {
      overrideRatesByCurrency = overrides
    }
  }

  let baseToSettlement: ResolvedRateWithSource
  let settlementToBase: ResolvedRateWithSource

  if (!isCrossCurrency) {
    baseToSettlement = { rate: 1, source: 'same' }
    settlementToBase = { rate: 1, source: 'same' }
  } else {
    const customBaseRate =
      mode === 'custom' ? savedCustomForTarget?.[projectBaseCurrency] : undefined
    if (isPositiveFiniteRate(customBaseRate)) {
      baseToSettlement = { rate: customBaseRate, source: 'custom' }
      settlementToBase = { rate: 1 / customBaseRate, source: 'custom' }
    } else {
      const direct = rateLookup(projectBaseCurrency, settlementCurrency)
      if (isPositiveFiniteRate(direct.rate)) {
        baseToSettlement = { rate: direct.rate, source: direct.source }
        settlementToBase = { rate: 1 / direct.rate, source: direct.source }
      } else {
        const reverse = rateLookup(settlementCurrency, projectBaseCurrency)
        if (isPositiveFiniteRate(reverse.rate)) {
          baseToSettlement = { rate: 1 / reverse.rate, source: reverse.source }
          settlementToBase = { rate: reverse.rate, source: reverse.source }
        } else {
          baseToSettlement = { rate: null, source: 'missing' }
          settlementToBase = { rate: null, source: 'missing' }
        }
      }
    }
  }

  const options: SettleUpOptions = {
    ...(overrideRatesByCurrency ? { overrideRatesByCurrency } : {}),
    projectBaseCurrency,
    ...(isPositiveFiniteRate(baseToSettlement.rate)
      ? { baseToSettlementRate: baseToSettlement.rate }
      : {}),
  }

  return {
    settlementCurrency,
    projectBaseCurrency,
    mode,
    isCrossCurrency,
    baseToSettlement,
    settlementToBase,
    options,
  }
}
