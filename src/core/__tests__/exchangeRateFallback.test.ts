import { describe, expect, it } from 'vitest'
import { getSuggestedExchangeRate } from '@/core/ledgerHelpers'
import {
  applySettlementRatesToTransactions,
  calculateSettleUp,
} from '@/core/settleUpEngine'
import type { Transaction } from '@/schemas/ledgerSchema'

function createUnknownCurrencyTx(): Transaction {
  return {
    id: '33333333-3333-4333-8333-333333333301',
    schemaVersion: 1,
    vaultLevel: 'normal',
    type: 'expense',
    amount: 100000,
    currency: 'ARS',
    exchangeRateToBase: 0.03,
    categoryKey: 'cat_food',
    date: '2026-11-26',
    time: '12:00',
    updatedAt: 1732600000000,
    splitConfig: {
      payerId: 'alice',
      mode: 'equal',
      shares: [
        { memberId: 'alice', finalAmount: 50000 },
        { memberId: 'bob', finalAmount: 50000 },
      ],
    },
  }
}

describe('exchangeRateFallback - 未知幣別不得靜默回退 1:1', () => {
  it('同幣別（包含離線表未收錄幣別如 ARS→ARS）回傳 1', () => {
    expect(getSuggestedExchangeRate('TWD', 'TWD')).toBe(1)
    expect(getSuggestedExchangeRate('ARS', 'ARS')).toBe(1)
    expect(getSuggestedExchangeRate(' ars ', 'ARS')).toBe(1)
  })

  it('已知常用幣別對回傳正確離線估算匯率', () => {
    expect(getSuggestedExchangeRate('JPY', 'TWD')).toBe(0.21)
    expect(getSuggestedExchangeRate('USD', 'TWD')).toBe(32)
    expect(getSuggestedExchangeRate('TWD', 'JPY')).toBe(Number((1 / 0.21).toFixed(4)))
  })

  it('未知幣別對（如 ARS→TWD、TWD→ARS、CLP→TWD、空字串）必須回傳 null，絕不可靜默回傳 1', () => {
    expect(getSuggestedExchangeRate('ARS', 'TWD')).toBeNull()
    expect(getSuggestedExchangeRate('TWD', 'ARS')).toBeNull()
    expect(getSuggestedExchangeRate('CLP', 'TWD')).toBeNull()
    expect(getSuggestedExchangeRate('', 'TWD')).toBeNull()
    expect(getSuggestedExchangeRate('TWD', '')).toBeNull()
  })

  it('ARS→TWD 無快取與無記憶匯率時，結算覆寫表不得填入 1:1，應保留交易原記帳匯率', () => {
    const arsTx = createUnknownCurrencyTx()

    // 模擬 Store 在 live / custom 模式下組裝 overrideRatesByCurrency：
    // 當 getEffectiveExchangeRate('ARS', 'TWD') 回傳 null 時，不得將 1 寫入覆寫表
    const suggested = getSuggestedExchangeRate('ARS', 'TWD')
    const overrideRatesByCurrency: Record<string, number> = {}
    if (suggested !== null && suggested > 0) {
      overrideRatesByCurrency.ARS = suggested
    }
    expect(overrideRatesByCurrency.ARS).toBeUndefined()

    const effective = applySettlementRatesToTransactions(
      [arsTx],
      'TWD',
      Object.keys(overrideRatesByCurrency).length > 0
        ? overrideRatesByCurrency
        : undefined,
      'TWD',
      1,
    )
    expect(effective[0].exchangeRateToBase).toBe(0.03)

    const settle = calculateSettleUp([arsTx], 'TWD', ['alice', 'bob'], {
      ...(Object.keys(overrideRatesByCurrency).length > 0
        ? { overrideRatesByCurrency }
        : {}),
      projectBaseCurrency: 'TWD',
      baseToSettlementRate: 1,
    })

    // 100,000 ARS * 0.03 = 3,000 TWD，絕不可因靜默 1:1 變成 100,000 TWD
    expect(settle.totalProjectExpense).toBe(3000)
    expect(settle.transfers).toEqual([
      {
        fromMemberId: 'bob',
        toMemberId: 'alice',
        amount: 1500,
        currency: 'TWD',
      },
    ])
  })

  it('getSuggestedExchangeRate 支援大小寫正規化、非 TWD 交叉換算與正反方向近似倒數', () => {
    expect(getSuggestedExchangeRate(' jpy ', ' twd ')).toBe(0.21)

    const usdToJpy = getSuggestedExchangeRate('USD', 'JPY')
    const jpyToUsd = getSuggestedExchangeRate('JPY', 'USD')
    expect(usdToJpy).not.toBeNull()
    expect(jpyToUsd).not.toBeNull()
    expect(usdToJpy!).toBeGreaterThan(100)
    expect(usdToJpy! * jpyToUsd!).toBeCloseTo(1, 1)

    const eurToKrw = getSuggestedExchangeRate('EUR', 'KRW')
    expect(eurToKrw).not.toBeNull()
    expect(Number.isFinite(eurToKrw!)).toBe(true)
    expect(eurToKrw!).toBeGreaterThan(0)
  })
})
