import { describe, expect, it } from 'vitest'
import {
  buildNextSettlementViewForCurrencyChange,
  buildNextSettlementViewForRateConfig,
  extractLegacySettlementView,
  hasLegacyProjectSettlementFields,
  mergeCustomRateBuckets,
  migrateLegacyProjectSettlementViews,
  resolveCustomRatesForTarget,
  resolveSettlementCurrency,
  resolveSettlementOptions,
  resolveSettlementRateMode,
  type ExchangeRateLookupFn,
  type LocalSettlementViewPrefs,
  type SettlementProjectLike,
} from '@/core/settlementRateResolver'

function makeLookup(
  table: Record<string, { rate: number; source: 'live' | 'remembered' | 'estimated' }>,
): ExchangeRateLookupFn {
  return (from, to) => {
    const f = from.trim().toUpperCase()
    const t = to.trim().toUpperCase()
    if (f === t) return { rate: 1, source: 'same' }
    const hit = table[`${f}->${t}`]
    if (hit) return hit
    return { rate: null, source: 'missing' }
  }
}

const baseProject: SettlementProjectLike = {
  id: 'proj-1',
  baseCurrency: 'JPY',
}

const sampleTxs = [
  { currency: 'JPY', isDeleted: false },
  { currency: 'USD', isDeleted: false },
  { currency: 'TWD', isDeleted: false },
  { currency: 'EUR', isDeleted: true }, // 已刪除交易不應進入覆寫表
]

describe('settlementRateResolver: per_tx / live / custom × 同幣 / 跨幣 矩陣', () => {
  const lookup = makeLookup({
    'USD->JPY': { rate: 150, source: 'live' },
    'TWD->JPY': { rate: 4.8, source: 'live' },
    'JPY->TWD': { rate: 0.21, source: 'live' },
    'USD->TWD': { rate: 32, source: 'live' },
  })

  it('同幣 + per_tx：不產生 overrideRatesByCurrency，雙向匯率皆為 1 (same)', () => {
    const res = resolveSettlementOptions(baseProject, undefined, sampleTxs, lookup)
    expect(res.settlementCurrency).toBe('JPY')
    expect(res.projectBaseCurrency).toBe('JPY')
    expect(res.mode).toBe('per_tx')
    expect(res.isCrossCurrency).toBe(false)
    expect(res.baseToSettlement).toEqual({ rate: 1, source: 'same' })
    expect(res.settlementToBase).toEqual({ rate: 1, source: 'same' })
    expect(res.options.overrideRatesByCurrency).toBeUndefined()
    expect(res.options.baseToSettlementRate).toBe(1)
  })

  it('同幣 + live：對所有未刪除外幣產生即時覆寫，忽略已刪除交易', () => {
    const localView: LocalSettlementViewPrefs = {
      settlementCurrency: 'JPY',
      settlementRateMode: 'live',
    }
    const res = resolveSettlementOptions(baseProject, localView, sampleTxs, lookup)
    expect(res.mode).toBe('live')
    expect(res.isCrossCurrency).toBe(false)
    expect(res.options.overrideRatesByCurrency).toEqual({
      USD: 150,
      TWD: 4.8,
    })
    expect(res.options.overrideRatesByCurrency?.EUR).toBeUndefined()
  })

  it('同幣 + custom：優先套用自訂匯率，缺漏幣別回退 lookup', () => {
    const localView: LocalSettlementViewPrefs = {
      settlementCurrency: 'JPY',
      settlementRateMode: 'custom',
      settlementCustomRatesByCurrency: {
        JPY: { USD: 155 },
      },
    }
    const res = resolveSettlementOptions(baseProject, localView, sampleTxs, lookup)
    expect(res.mode).toBe('custom')
    expect(res.options.overrideRatesByCurrency).toEqual({
      USD: 155,
      TWD: 4.8,
    })
  })

  it('跨幣 (JPY→TWD) + per_tx：不覆寫各筆外幣，但帶入互為倒數的 baseToSettlement / settlementToBase', () => {
    const localView: LocalSettlementViewPrefs = {
      settlementCurrency: 'TWD',
      settlementRateMode: 'per_tx',
    }
    const res = resolveSettlementOptions(baseProject, localView, sampleTxs, lookup)
    expect(res.settlementCurrency).toBe('TWD')
    expect(res.isCrossCurrency).toBe(true)
    expect(res.options.overrideRatesByCurrency).toBeUndefined()
    expect(res.baseToSettlement).toEqual({ rate: 0.21, source: 'live' })
    expect(res.settlementToBase.source).toBe('live')
    expect(res.settlementToBase.rate).toBeCloseTo(1 / 0.21, 10)
    expect(res.baseToSettlement.rate! * res.settlementToBase.rate!).toBeCloseTo(1, 12)
    expect(res.options.baseToSettlementRate).toBe(0.21)
  })

  it('跨幣 (JPY→TWD) + live：所有非 TWD 交易幣別（含專案主幣別 JPY）皆以 live 覆寫', () => {
    const localView: LocalSettlementViewPrefs = {
      settlementCurrency: 'TWD',
      settlementRateMode: 'live',
    }
    const res = resolveSettlementOptions(baseProject, localView, sampleTxs, lookup)
    expect(res.isCrossCurrency).toBe(true)
    expect(res.options.overrideRatesByCurrency).toEqual({
      JPY: 0.21,
      USD: 32,
    })
    expect(res.baseToSettlement).toEqual({ rate: 0.21, source: 'live' })
    expect(res.settlementToBase.rate).toBeCloseTo(1 / 0.21, 10)
  })

  it('跨幣 (JPY→TWD) + custom：baseToSettlement 與 settlementToBase 皆採 custom 且嚴格互為倒數', () => {
    const localView: LocalSettlementViewPrefs = {
      settlementCurrency: 'TWD',
      settlementRateMode: 'custom',
      settlementCustomRatesByCurrency: {
        TWD: { JPY: 0.22, USD: 31.5 },
      },
    }
    const res = resolveSettlementOptions(baseProject, localView, sampleTxs, lookup)
    expect(res.isCrossCurrency).toBe(true)
    expect(res.options.overrideRatesByCurrency).toEqual({
      JPY: 0.22,
      USD: 31.5,
    })
    expect(res.baseToSettlement).toEqual({ rate: 0.22, source: 'custom' })
    expect(res.settlementToBase.source).toBe('custom')
    expect(res.settlementToBase.rate).toBeCloseTo(1 / 0.22, 12)
    expect(res.baseToSettlement.rate! * res.settlementToBase.rate!).toBeCloseTo(1, 12)
    expect(res.options.baseToSettlementRate).toBe(0.22)
  })

  it('跨幣且正向 lookup 查無時，若反向有值則以倒數推算，保持雙向一致', () => {
    const reverseOnlyLookup = makeLookup({
      'TWD->JPY': { rate: 5, source: 'remembered' },
    })
    const localView: LocalSettlementViewPrefs = {
      settlementCurrency: 'TWD',
      settlementRateMode: 'per_tx',
    }
    const res = resolveSettlementOptions(
      baseProject,
      localView,
      sampleTxs,
      reverseOnlyLookup,
    )
    expect(res.baseToSettlement).toEqual({ rate: 0.2, source: 'remembered' })
    expect(res.settlementToBase).toEqual({ rate: 5, source: 'remembered' })
    expect(res.options.baseToSettlementRate).toBe(0.2)
  })

  it('跨幣且雙向皆查無匯率時（例如 VND→TWD 無快取），不應回退 1:1，應標示 missing', () => {
    const vndProject: SettlementProjectLike = {
      id: 'proj-vnd',
      baseCurrency: 'VND',
    }
    const emptyLookup = makeLookup({})
    const localView: LocalSettlementViewPrefs = {
      settlementCurrency: 'TWD',
      settlementRateMode: 'live',
    }
    const res = resolveSettlementOptions(
      vndProject,
      localView,
      [{ currency: 'VND', isDeleted: false }],
      emptyLookup,
    )
    expect(res.baseToSettlement).toEqual({ rate: null, source: 'missing' })
    expect(res.settlementToBase).toEqual({ rate: null, source: 'missing' })
    expect(res.options.baseToSettlementRate).toBeUndefined()
    expect(res.options.overrideRatesByCurrency).toBeUndefined()
  })
})

describe('settlementRateResolver: 視角優先權與自訂匯率分桶合併 (3-5)', () => {
  it('本機視角優先於專案舊欄位', () => {
    const proj: SettlementProjectLike = {
      baseCurrency: 'JPY',
      settlementCurrency: 'USD',
      settlementRateMode: 'live',
      settlementCustomRatesByCurrency: {
        TWD: { JPY: 0.2 },
      },
    }
    const local: LocalSettlementViewPrefs = {
      settlementCurrency: 'TWD',
      settlementRateMode: 'custom',
      settlementCustomRatesByCurrency: {
        TWD: { JPY: 0.23 },
      },
    }
    expect(resolveSettlementCurrency(proj, local)).toBe('TWD')
    expect(resolveSettlementRateMode(proj, local)).toBe('custom')
    expect(resolveCustomRatesForTarget(proj, local, 'TWD')).toEqual({ JPY: 0.23 })
  })

  it('mergeCustomRateBuckets 會過濾不合法幣別與非正數，並正確合併或覆寫目標分桶', () => {
    const merged = mergeCustomRateBuckets({
      existingBuckets: {
        TWD: { JPY: 0.21, USD: 32 },
      },
      targetCurrency: 'twd',
      targetRates: { jpy: 0.22, INVALID: 10, EUR: -1, GBP: Number.NaN },
      overwriteTarget: false,
    })
    expect(merged).toEqual({
      TWD: { JPY: 0.22, USD: 32 },
    })

    const overwritten = mergeCustomRateBuckets({
      existingBuckets: merged,
      targetCurrency: 'TWD',
      targetRates: { JPY: 0.25 },
      overwriteTarget: true,
    })
    expect(overwritten).toEqual({
      TWD: { JPY: 0.25 },
    })
  })

  it('切換結帳幣別時完整保留原目標幣別分桶，切回後可還原 custom 匯率', () => {
    const proj: SettlementProjectLike = { baseCurrency: 'JPY' }
    const step1 = buildNextSettlementViewForRateConfig(
      proj,
      { settlementCurrency: 'TWD', settlementRateMode: 'per_tx' },
      'custom',
      { JPY: 0.22, USD: 31.5 },
    )
    expect(step1.settlementCustomRatesByCurrency).toEqual({
      TWD: { JPY: 0.22, USD: 31.5 },
    })

    // 切到 USD（尚無自訂匯率 → 自動回退 live，但 TWD 分桶保留）
    const step2 = buildNextSettlementViewForCurrencyChange(proj, step1, 'USD')
    expect(step2.settlementCurrency).toBe('USD')
    expect(step2.settlementRateMode).toBe('live')
    expect(step2.settlementCustomRates).toBeUndefined()
    expect(step2.settlementCustomRatesByCurrency).toEqual({
      TWD: { JPY: 0.22, USD: 31.5 },
    })

    // 切回 TWD → 還原 TWD 的自訂匯率
    const step3 = buildNextSettlementViewForCurrencyChange(proj, step2, 'TWD')
    expect(step3.settlementCurrency).toBe('TWD')
    expect(step3.settlementCustomRates).toEqual({ JPY: 0.22, USD: 31.5 })
    expect(step3.settlementCustomRatesByCurrency).toEqual({
      TWD: { JPY: 0.22, USD: 31.5 },
    })
  })

  it('migrateLegacyProjectSettlementViews 會將專案舊結算欄位一次性搬移至本機，不覆寫既有本機視角', () => {
    const legacyProj = {
      id: 'p-legacy',
      baseCurrency: 'JPY',
      settlementCurrency: 'TWD',
      settlementRateMode: 'custom' as const,
      settlementCustomRates: { JPY: 0.215 },
    }
    const alreadyLocalProj = {
      id: 'p-local',
      baseCurrency: 'JPY',
      settlementCurrency: 'USD',
      settlementRateMode: 'live' as const,
    }
    const cleanProj = {
      id: 'p-clean',
      baseCurrency: 'TWD',
    }

    expect(hasLegacyProjectSettlementFields(legacyProj)).toBe(true)
    expect(hasLegacyProjectSettlementFields(cleanProj)).toBe(false)
    expect(extractLegacySettlementView(cleanProj)).toBeNull()

    const existing: Record<string, LocalSettlementViewPrefs> = {
      'p-local': {
        settlementCurrency: 'TWD',
        settlementRateMode: 'per_tx',
      },
    }

    const res = migrateLegacyProjectSettlementViews(
      [legacyProj, alreadyLocalProj, cleanProj],
      existing,
    )
    expect(res.changed).toBe(true)
    expect(res.migratedProjectIds).toEqual(['p-legacy'])
    expect(res.nextLocalViews['p-legacy']).toEqual({
      settlementCurrency: 'TWD',
      settlementRateMode: 'custom',
      settlementCustomRates: { JPY: 0.215 },
      settlementCustomRatesByCurrency: { TWD: { JPY: 0.215 } },
    })
    // 既有本機視角維持原樣不被舊欄位覆寫
    expect(res.nextLocalViews['p-local']).toEqual(existing['p-local'])
    expect(res.nextLocalViews['p-clean']).toBeUndefined()

    // 再次執行應為冪等（changed = false）
    const res2 = migrateLegacyProjectSettlementViews(
      [legacyProj, alreadyLocalProj, cleanProj],
      res.nextLocalViews,
    )
    expect(res2.changed).toBe(false)
    expect(res2.migratedProjectIds).toEqual([])
  })

  it('本機視角存在時僅讀本機設定，不再回退混用專案舊結算欄位', () => {
    const projWithLegacy: SettlementProjectLike = {
      id: 'p-1',
      baseCurrency: 'JPY',
      settlementCurrency: 'USD',
      settlementRateMode: 'custom',
      settlementCustomRates: { JPY: 0.007 },
      settlementCustomRatesByCurrency: {
        USD: { JPY: 0.007 },
        TWD: { JPY: 0.99 },
      },
    }
    const localOnly: LocalSettlementViewPrefs = {
      settlementCurrency: 'TWD',
      settlementRateMode: 'live',
    }
    expect(resolveSettlementCurrency(projWithLegacy, localOnly)).toBe('TWD')
    expect(resolveSettlementRateMode(projWithLegacy, localOnly)).toBe('live')
    // 本機視角未設自訂匯率時，不應偷讀專案舊欄位的 TWD: { JPY: 0.99 }
    expect(resolveCustomRatesForTarget(projWithLegacy, localOnly, 'TWD')).toBeUndefined()
  })
})
