import { z } from 'zod'
import {
  CurrencyCodeSchema,
  SplitConfigSchema,
  type SplitConfig,
  type UserProfile,
} from '@/schemas/ledgerSchema'
import {
  isValidCategoryIconKey,
  resolveDefaultCategoryIcon,
} from '@/core/categoryIcons'
import type { LocalSettlementViewPrefs } from '@/core/settlementRateResolver'

const PlainObjectSchema = z
  .record(z.string(), z.unknown())
  .refine((val) => !Array.isArray(val), '必須為一般物件')

const PositiveFiniteNumberSchema = z.number().finite().positive()
const NonNegativeTimestampSchema = z.number().finite().min(0)
const NonEmptyTrimmedStringSchema = z.string().trim().min(1)
const CurrencyPairKeySchema = z.string().regex(/^[A-Z]{3}_[A-Z]{3}$/)

export const SettlementRateModeSchema = z.enum(['per_tx', 'live', 'custom'])

export const ManagedCategorySchema = z.object({
  key: NonEmptyTrimmedStringSchema,
  /** 若使用者未修改過內建分類，維持 undefined 以便自動套用當前語系翻譯；修改過則顯示此自訂名稱 */
  customLabel: NonEmptyTrimmedStringSchema.optional(),
  color: NonEmptyTrimmedStringSchema,
  /** 分類圖示鍵值（對應 categoryIcons.ts） */
  icon: NonEmptyTrimmedStringSchema.optional(),
  isBuiltin: z.boolean().optional(),
})
export type ManagedCategory = z.infer<typeof ManagedCategorySchema>

export const QuickExchangeRatePresetsSchema = z.object({
  cash: PositiveFiniteNumberSchema.optional(),
  card: PositiveFiniteNumberSchema.optional(),
})
export type QuickExchangeRatePresets = z.infer<typeof QuickExchangeRatePresetsSchema>

export const LocalSettlementViewPrefsSchema = z.object({
  settlementCurrency: CurrencyCodeSchema.optional(),
  settlementRateMode: SettlementRateModeSchema.optional(),
  settlementCustomRates: z
    .record(CurrencyCodeSchema, PositiveFiniteNumberSchema)
    .optional(),
  settlementCustomRatesByCurrency: z
    .record(
      CurrencyCodeSchema,
      z.record(CurrencyCodeSchema, PositiveFiniteNumberSchema),
    )
    .optional(),
})

export const PersistedUserPrefsV2Schema = z.object({
  defaultCurrency: CurrencyCodeSchema,
  enabledCurrencies: z.array(CurrencyCodeSchema).min(1),
  categories: z.array(ManagedCategorySchema).min(1),
  projectOrder: z.array(z.string()).optional(),
  projectOrderUpdatedAt: z.number().int().nonnegative().optional(),
  exchangeRates: z
    .record(CurrencyPairKeySchema, PositiveFiniteNumberSchema)
    .optional(),
  quickExchangeRates: z
    .record(CurrencyPairKeySchema, QuickExchangeRatePresetsSchema)
    .optional(),
  lastExpenseProjectId: z.string().optional(),
  lastCurrencyByProject: z.record(z.string(), CurrencyCodeSchema).optional(),
  lastSplitByProject: z.record(z.string(), SplitConfigSchema).optional(),
  settlementViewByProject: z
    .record(z.string(), LocalSettlementViewPrefsSchema)
    .optional(),
  userProfile: z
    .object({
      displayName: z.string().trim().max(50),
      avatarColor: NonEmptyTrimmedStringSchema,
      avatarImage: z
        .string()
        .refine((val) => val.startsWith('data:image/'))
        .optional(),
      paymentInfo: z.string().trim().min(1).max(120).optional(),
      updatedAt: z.number().int().nonnegative().optional(),
    })
    .optional(),
})
export type PersistedUserPrefsV2 = z.infer<typeof PersistedUserPrefsV2Schema>

export const UserPrefsV1CustomCategorySchema = z.object({
  key: NonEmptyTrimmedStringSchema,
  label: NonEmptyTrimmedStringSchema,
  color: NonEmptyTrimmedStringSchema.optional(),
})

export const PersistedUserPrefsV1Schema = z.object({
  defaultCurrency: CurrencyCodeSchema.optional(),
  customCurrencies: z.array(CurrencyCodeSchema).optional(),
  customCategories: z.array(UserPrefsV1CustomCategorySchema).optional(),
})

export const LiveRatesCacheSchema = z.object({
  /** 以 USD 為基準（1 USD = N 該幣別）的匯率表 */
  ratesPerUsd: z.record(CurrencyCodeSchema, PositiveFiniteNumberSchema),
  fetchedAt: NonNegativeTimestampSchema,
  source: NonEmptyTrimmedStringSchema,
})
export type LiveRatesCache = z.infer<typeof LiveRatesCacheSchema>

export const GoogleSessionTokenSchema = z.object({
  token: NonEmptyTrimmedStringSchema,
  expiresAt: PositiveFiniteNumberSchema,
})
export type GoogleSessionToken = z.infer<typeof GoogleSessionTokenSchema>

export const GoogleDriveAccountInfoSchema = z.object({
  email: NonEmptyTrimmedStringSchema,
  displayName: NonEmptyTrimmedStringSchema,
})
export type GoogleDriveAccountInfo = z.infer<typeof GoogleDriveAccountInfoSchema>

export const CustomFeeRatesSchema = z.object({
  service: z.number().finite().gt(0).lte(100),
  fx: z.number().finite().gt(0).lte(100),
})
export type CustomFeeRates = z.infer<typeof CustomFeeRatesSchema>

export interface UserPrefsParseDefaults {
  initialCurrencies: readonly string[]
  defaultCategories: readonly ManagedCategory[]
  defaultAvatarColor: string
}

function safeJsonParse(raw: string | null | undefined): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false }
  }
}

function cloneDefaultCategories(defaults: readonly ManagedCategory[]): ManagedCategory[] {
  return defaults.map((c) => ({ ...c }))
}

function createDefaultUserProfile(defaultAvatarColor: string): UserProfile {
  return {
    displayName: '',
    avatarColor: defaultAvatarColor,
    avatarImage: undefined,
    paymentInfo: undefined,
  }
}

export function createDefaultUserPrefs(
  defaults: UserPrefsParseDefaults,
): PersistedUserPrefsV2 {
  return {
    defaultCurrency: 'TWD',
    enabledCurrencies: [...defaults.initialCurrencies],
    categories: cloneDefaultCategories(defaults.defaultCategories),
    projectOrder: [],
    exchangeRates: {},
  }
}

/**
 * 清理並驗證 `clearbill_user_prefs_v2` 原始物件（欄位級 Zod safeParse，壞欄位自動回退預設而不遺失其他正常設定）
 */
export function parseUserPrefsV2(
  raw: unknown,
  defaults: UserPrefsParseDefaults,
): PersistedUserPrefsV2 {
  const objResult = PlainObjectSchema.safeParse(raw)
  if (!objResult.success) {
    return createDefaultUserPrefs(defaults)
  }
  const obj = objResult.data

  const defCurResult = CurrencyCodeSchema.safeParse(obj.defaultCurrency)
  const defaultCurrency = defCurResult.success ? defCurResult.data : 'TWD'

  const enabledSet = new Set<string>()
  const enabledArrResult = z.array(z.unknown()).safeParse(obj.enabledCurrencies)
  if (enabledArrResult.success) {
    for (const item of enabledArrResult.data) {
      const codeRes = CurrencyCodeSchema.safeParse(item)
      if (codeRes.success) {
        enabledSet.add(codeRes.data)
      }
    }
  } else {
    for (const code of defaults.initialCurrencies) {
      enabledSet.add(code)
    }
  }
  enabledSet.add(defaultCurrency)

  let categories: ManagedCategory[] = []
  const rawCatsResult = z.array(z.unknown()).safeParse(obj.categories)
  if (rawCatsResult.success && rawCatsResult.data.length > 0) {
    for (const rawCat of rawCatsResult.data) {
      const catObjRes = PlainObjectSchema.safeParse(rawCat)
      if (!catObjRes.success) continue
      const keyRes = NonEmptyTrimmedStringSchema.safeParse(catObjRes.data.key)
      if (!keyRes.success) continue
      const key = keyRes.data
      const labelRes = NonEmptyTrimmedStringSchema.safeParse(catObjRes.data.customLabel)
      const colorRes = NonEmptyTrimmedStringSchema.safeParse(catObjRes.data.color)
      const iconRes = NonEmptyTrimmedStringSchema.safeParse(catObjRes.data.icon)
      const icon =
        iconRes.success && isValidCategoryIconKey(iconRes.data)
          ? iconRes.data
          : resolveDefaultCategoryIcon(key)
      categories.push({
        key,
        customLabel: labelRes.success ? labelRes.data : undefined,
        color: colorRes.success ? colorRes.data : '#10b981',
        icon,
        isBuiltin: Boolean(catObjRes.data.isBuiltin),
      })
    }
  }
  if (categories.length === 0) {
    categories = cloneDefaultCategories(defaults.defaultCategories)
  }

  const projectOrder: string[] = []
  const rawOrderResult = z.array(z.unknown()).safeParse(obj.projectOrder)
  if (rawOrderResult.success) {
    for (const item of rawOrderResult.data) {
      const idRes = z.string().safeParse(item)
      if (idRes.success) {
        projectOrder.push(idRes.data)
      }
    }
  }

  const orderTsResult = NonNegativeTimestampSchema.safeParse(obj.projectOrderUpdatedAt)
  const projectOrderUpdatedAt = orderTsResult.success
    ? Math.floor(orderTsResult.data)
    : undefined

  const exchangeRates: Record<string, number> = {}
  const rawRatesResult = PlainObjectSchema.safeParse(obj.exchangeRates)
  if (rawRatesResult.success) {
    for (const [pairKey, rate] of Object.entries(rawRatesResult.data)) {
      const keyRes = CurrencyPairKeySchema.safeParse(pairKey)
      const rateRes = PositiveFiniteNumberSchema.safeParse(rate)
      if (keyRes.success && rateRes.success) {
        exchangeRates[keyRes.data] = rateRes.data
      }
    }
  }

  const quickExchangeRates: Record<string, QuickExchangeRatePresets> = {}
  const rawQuickResult = PlainObjectSchema.safeParse(obj.quickExchangeRates)
  if (rawQuickResult.success) {
    for (const [pairKey, rawPreset] of Object.entries(rawQuickResult.data)) {
      const keyRes = CurrencyPairKeySchema.safeParse(pairKey)
      const presetObjRes = PlainObjectSchema.safeParse(rawPreset)
      if (!keyRes.success || !presetObjRes.success) continue
      const clean: QuickExchangeRatePresets = {}
      const cashRes = PositiveFiniteNumberSchema.safeParse(presetObjRes.data.cash)
      if (cashRes.success) clean.cash = cashRes.data
      const cardRes = PositiveFiniteNumberSchema.safeParse(presetObjRes.data.card)
      if (cardRes.success) clean.card = cardRes.data
      if (clean.cash !== undefined || clean.card !== undefined) {
        quickExchangeRates[keyRes.data] = clean
      }
    }
  }

  const lastProjRes = NonEmptyTrimmedStringSchema.safeParse(obj.lastExpenseProjectId)
  const lastExpenseProjectId = lastProjRes.success ? lastProjRes.data : ''

  const lastCurrencyByProject: Record<string, string> = {}
  const rawLastCurResult = PlainObjectSchema.safeParse(obj.lastCurrencyByProject)
  if (rawLastCurResult.success) {
    for (const [projId, cur] of Object.entries(rawLastCurResult.data)) {
      if (!projId.trim()) continue
      const curRes = CurrencyCodeSchema.safeParse(cur)
      if (curRes.success) {
        lastCurrencyByProject[projId] = curRes.data
      }
    }
  }

  const lastSplitByProject: Record<string, SplitConfig> = {}
  const rawLastSplitResult = PlainObjectSchema.safeParse(obj.lastSplitByProject)
  if (rawLastSplitResult.success) {
    for (const [projId, rawSplit] of Object.entries(rawLastSplitResult.data)) {
      if (!projId.trim()) continue
      const parsedSplit = SplitConfigSchema.safeParse(rawSplit)
      if (parsedSplit.success) {
        lastSplitByProject[projId] = parsedSplit.data
      }
    }
  }

  const settlementViewByProject: Record<string, LocalSettlementViewPrefs> = {}
  const rawViewMapResult = PlainObjectSchema.safeParse(obj.settlementViewByProject)
  if (rawViewMapResult.success) {
    for (const [projId, rawView] of Object.entries(rawViewMapResult.data)) {
      if (!projId.trim()) continue
      const viewObjRes = PlainObjectSchema.safeParse(rawView)
      if (!viewObjRes.success) continue
      const cleanView: LocalSettlementViewPrefs = {}

      const curRes = CurrencyCodeSchema.safeParse(viewObjRes.data.settlementCurrency)
      if (curRes.success) {
        cleanView.settlementCurrency = curRes.data
      }

      const modeRes = SettlementRateModeSchema.safeParse(
        viewObjRes.data.settlementRateMode,
      )
      if (modeRes.success) {
        cleanView.settlementRateMode = modeRes.data
      }

      const flatRatesObjRes = PlainObjectSchema.safeParse(
        viewObjRes.data.settlementCustomRates,
      )
      if (flatRatesObjRes.success) {
        const cleanFlat: Record<string, number> = {}
        for (const [k, v] of Object.entries(flatRatesObjRes.data)) {
          const codeRes = CurrencyCodeSchema.safeParse(k)
          const valRes = PositiveFiniteNumberSchema.safeParse(v)
          if (codeRes.success && valRes.success) {
            cleanFlat[codeRes.data] = valRes.data
          }
        }
        if (Object.keys(cleanFlat).length > 0) {
          cleanView.settlementCustomRates = cleanFlat
        }
      }

      const byCurObjRes = PlainObjectSchema.safeParse(
        viewObjRes.data.settlementCustomRatesByCurrency,
      )
      if (byCurObjRes.success) {
        const cleanByCur: Record<string, Record<string, number>> = {}
        for (const [targetCur, rawBucket] of Object.entries(byCurObjRes.data)) {
          const tCodeRes = CurrencyCodeSchema.safeParse(targetCur)
          const bucketObjRes = PlainObjectSchema.safeParse(rawBucket)
          if (!tCodeRes.success || !bucketObjRes.success) continue
          const cleanBucket: Record<string, number> = {}
          for (const [k, v] of Object.entries(bucketObjRes.data)) {
            const codeRes = CurrencyCodeSchema.safeParse(k)
            const valRes = PositiveFiniteNumberSchema.safeParse(v)
            if (codeRes.success && valRes.success) {
              cleanBucket[codeRes.data] = valRes.data
            }
          }
          if (Object.keys(cleanBucket).length > 0) {
            cleanByCur[tCodeRes.data] = cleanBucket
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

  const rawProfileRes = PlainObjectSchema.safeParse(obj.userProfile)
  let userProfile: UserProfile
  if (rawProfileRes.success) {
    const p = rawProfileRes.data
    const displayNameRes = z.string().safeParse(p.displayName)
    const avatarColorRes = NonEmptyTrimmedStringSchema.safeParse(p.avatarColor)
    const avatarImageRes = z
      .string()
      .refine((s) => s.startsWith('data:image/'))
      .safeParse(p.avatarImage)
    const paymentInfoRes = NonEmptyTrimmedStringSchema.safeParse(p.paymentInfo)
    const updatedAtRes = NonNegativeTimestampSchema.safeParse(p.updatedAt)

    userProfile = {
      displayName: displayNameRes.success
        ? displayNameRes.data.trim().slice(0, 50)
        : '',
      avatarColor: avatarColorRes.success
        ? avatarColorRes.data
        : defaults.defaultAvatarColor,
      avatarImage: avatarImageRes.success ? avatarImageRes.data : undefined,
      paymentInfo: paymentInfoRes.success
        ? paymentInfoRes.data.slice(0, 120)
        : undefined,
      updatedAt: updatedAtRes.success
        ? Math.floor(updatedAtRes.data)
        : undefined,
    }
  } else {
    userProfile = createDefaultUserProfile(defaults.defaultAvatarColor)
  }

  return {
    defaultCurrency,
    enabledCurrencies: Array.from(enabledSet),
    categories,
    projectOrder,
    projectOrderUpdatedAt,
    exchangeRates,
    quickExchangeRates,
    lastExpenseProjectId,
    lastCurrencyByProject,
    lastSplitByProject,
    settlementViewByProject,
    userProfile,
  }
}

export function parseUserPrefsV2Json(
  rawJson: string | null | undefined,
  defaults: UserPrefsParseDefaults,
): PersistedUserPrefsV2 {
  const parsed = safeJsonParse(rawJson)
  if (!parsed.ok) return createDefaultUserPrefs(defaults)
  return parseUserPrefsV2(parsed.value, defaults)
}

/**
 * 向下相容遷移舊版 `clearbill_user_prefs_v1`
 */
export function parseUserPrefsV1(
  raw: unknown,
  defaults: UserPrefsParseDefaults,
): PersistedUserPrefsV2 {
  const objRes = PlainObjectSchema.safeParse(raw)
  if (!objRes.success) {
    return createDefaultUserPrefs(defaults)
  }
  const obj = objRes.data
  const defCurRes = CurrencyCodeSchema.safeParse(obj.defaultCurrency)
  const defCur = defCurRes.success ? defCurRes.data : 'TWD'

  const curSet = new Set<string>([...defaults.initialCurrencies, defCur])
  const rawCustomCurs = z.array(z.unknown()).safeParse(obj.customCurrencies)
  if (rawCustomCurs.success) {
    for (const item of rawCustomCurs.data) {
      const codeRes = CurrencyCodeSchema.safeParse(item)
      if (codeRes.success) curSet.add(codeRes.data)
    }
  }

  const cats: ManagedCategory[] = cloneDefaultCategories(defaults.defaultCategories)
  const rawCustomCats = z.array(z.unknown()).safeParse(obj.customCategories)
  if (rawCustomCats.success) {
    for (const item of rawCustomCats.data) {
      const catRes = UserPrefsV1CustomCategorySchema.safeParse(item)
      if (catRes.success) {
        cats.push({
          key: catRes.data.key,
          customLabel: catRes.data.label,
          color: catRes.data.color || '#10b981',
          icon: resolveDefaultCategoryIcon(catRes.data.key),
          isBuiltin: false,
        })
      }
    }
  }

  return {
    defaultCurrency: defCur,
    enabledCurrencies: Array.from(curSet),
    categories: cats,
  }
}

export function parseUserPrefsV1Json(
  rawJson: string | null | undefined,
  defaults: UserPrefsParseDefaults,
): PersistedUserPrefsV2 {
  const parsed = safeJsonParse(rawJson)
  if (!parsed.ok) return createDefaultUserPrefs(defaults)
  return parseUserPrefsV1(parsed.value, defaults)
}

/**
 * 驗證並清理即時匯率快取（過濾無效幣別代碼與非正數／非有限數值）
 */
export function parseLiveRatesCache(raw: unknown): LiveRatesCache | null {
  const objRes = PlainObjectSchema.safeParse(raw)
  if (!objRes.success) return null
  const obj = objRes.data

  const fetchedAtRes = NonNegativeTimestampSchema.safeParse(obj.fetchedAt)
  const ratesObjRes = PlainObjectSchema.safeParse(obj.ratesPerUsd)
  if (!fetchedAtRes.success || !ratesObjRes.success) return null

  const cleanRates: Record<string, number> = {}
  for (const [k, v] of Object.entries(ratesObjRes.data)) {
    const codeRes = CurrencyCodeSchema.safeParse(k)
    const valRes = PositiveFiniteNumberSchema.safeParse(v)
    if (codeRes.success && valRes.success) {
      cleanRates[codeRes.data] = valRes.data
    }
  }
  if (Object.keys(cleanRates).length === 0) return null

  const sourceRes = NonEmptyTrimmedStringSchema.safeParse(obj.source)
  return {
    ratesPerUsd: cleanRates,
    fetchedAt: fetchedAtRes.data,
    source: sourceRes.success ? sourceRes.data : 'cache',
  }
}

export function parseLiveRatesCacheJson(
  rawJson: string | null | undefined,
): LiveRatesCache | null {
  const parsed = safeJsonParse(rawJson)
  if (!parsed.ok) return null
  return parseLiveRatesCache(parsed.value)
}

/**
 * 驗證外部匯率 API 回傳的幣別對 USD 匯率字典
 */
export function sanitizeUsdRatesMap(
  rawRates: unknown,
): Record<string, number> | null {
  const ratesObjRes = PlainObjectSchema.safeParse(rawRates)
  if (!ratesObjRes.success) return null
  const normalized: Record<string, number> = { USD: 1 }
  for (const [k, v] of Object.entries(ratesObjRes.data)) {
    const codeRes = CurrencyCodeSchema.safeParse(k)
    const valRes = PositiveFiniteNumberSchema.safeParse(v)
    if (codeRes.success && valRes.success) {
      normalized[codeRes.data] = valRes.data
    }
  }
  return Object.keys(normalized).length > 1 ? normalized : null
}

/**
 * 驗證 Google Drive 暫存 OAuth 權杖（token + expiresAt）
 */
export function parseGoogleSessionToken(raw: unknown): GoogleSessionToken | null {
  const res = GoogleSessionTokenSchema.safeParse(raw)
  return res.success ? res.data : null
}

export function parseGoogleSessionTokenJson(
  rawJson: string | null | undefined,
): GoogleSessionToken | null {
  const parsed = safeJsonParse(rawJson)
  if (!parsed.ok) return null
  return parseGoogleSessionToken(parsed.value)
}

/**
 * 驗證 Google Drive 已登入帳號快取（displayName 缺失時安全回退為 email）
 */
export function parseGoogleDriveAccountInfo(
  raw: unknown,
): GoogleDriveAccountInfo | null {
  const objRes = PlainObjectSchema.safeParse(raw)
  if (!objRes.success) return null
  const emailRes = NonEmptyTrimmedStringSchema.safeParse(objRes.data.email)
  if (!emailRes.success) return null
  const displayNameRes = NonEmptyTrimmedStringSchema.safeParse(
    objRes.data.displayName,
  )
  return {
    email: emailRes.data,
    displayName: displayNameRes.success ? displayNameRes.data : emailRes.data,
  }
}

export function parseGoogleDriveAccountInfoJson(
  rawJson: string | null | undefined,
): GoogleDriveAccountInfo | null {
  const parsed = safeJsonParse(rawJson)
  if (!parsed.ok) return null
  return parseGoogleDriveAccountInfo(parsed.value)
}

/**
 * 驗證自訂服務費與海外刷卡手續費設定（單欄壞值時僅該欄回退預設）
 */
export function parseCustomFeeRates(
  raw: unknown,
  defaults: CustomFeeRates = { service: 10, fx: 1.5 },
): CustomFeeRates {
  const objRes = PlainObjectSchema.safeParse(raw)
  if (!objRes.success) return { ...defaults }
  const serviceRes = CustomFeeRatesSchema.shape.service.safeParse(
    objRes.data.service,
  )
  const fxRes = CustomFeeRatesSchema.shape.fx.safeParse(objRes.data.fx)
  return {
    service: serviceRes.success ? serviceRes.data : defaults.service,
    fx: fxRes.success ? fxRes.data : defaults.fx,
  }
}

export function parseCustomFeeRatesJson(
  rawJson: string | null | undefined,
  defaults: CustomFeeRates = { service: 10, fx: 1.5 },
): CustomFeeRates {
  const parsed = safeJsonParse(rawJson)
  if (!parsed.ok) return { ...defaults }
  return parseCustomFeeRates(parsed.value, defaults)
}
