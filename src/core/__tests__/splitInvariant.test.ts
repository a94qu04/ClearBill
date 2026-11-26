import { describe, expect, it, vi } from 'vitest'
import {
  assertSplitInvariant,
  getSettlementRoundingToleranceUnits,
  SplitInvariantError,
  StrictTransactionSchema,
  validateSplitInvariant,
} from '@/core/splitInvariant'
import { calculateSettleUp } from '@/core/settleUpEngine'
import { migrateTransaction, SchemaMigrationError } from '@/core/migrationEngine'
import type { Transaction } from '@/schemas/ledgerSchema'

function createTx(
  overrides: Partial<Transaction> & Pick<Transaction, 'id' | 'amount'>,
): Transaction {
  return {
    schemaVersion: 1,
    vaultLevel: 'normal',
    type: 'expense',
    currency: 'TWD',
    exchangeRateToBase: 1,
    categoryKey: 'cat_food',
    date: '2026-11-26',
    time: '12:00',
    updatedAt: 1732600000000,
    ...overrides,
  }
}

describe('splitInvariant - 拆帳金額守恆不變式', () => {
  it('無 splitConfig 之個人交易視為合法', () => {
    const tx = createTx({
      id: '11111111-1111-4111-8111-111111111111',
      amount: 500,
    })

    const result = validateSplitInvariant(tx)
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.sharesSumUnits).toBeNull()
    expect(result.payersSumUnits).toBeNull()
  })

  it('單人墊付：Σshares === amount 時通過驗證（含兩位小數幣別 USD）', () => {
    const tx = createTx({
      id: '11111111-1111-4111-8111-111111111112',
      amount: 100,
      currency: 'USD',
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 33.34 },
          { memberId: 'bob', finalAmount: 33.33 },
          { memberId: 'charlie', finalAmount: 33.33 },
        ],
      },
    })

    const result = validateSplitInvariant(tx)
    expect(result.valid).toBe(true)
    expect(result.amountUnits).toBe(10000)
    expect(result.sharesSumUnits).toBe(10000)
    expect(result.payersSumUnits).toBeNull()
    expect(() => assertSplitInvariant(tx)).not.toThrow()
    expect(StrictTransactionSchema.safeParse(tx).success).toBe(true)
  })

  it('單人墊付：Σshares !== amount 時回報 SHARE_SUM_MISMATCH 並於 assert 拋錯', () => {
    const tx = createTx({
      id: '11111111-1111-4111-8111-111111111113',
      amount: 1000,
      splitConfig: {
        payerId: 'alice',
        mode: 'custom_plus_equal',
        shares: [
          { memberId: 'alice', finalAmount: 400 },
          { memberId: 'bob', finalAmount: 500 },
        ],
      },
    })

    const result = validateSplitInvariant(tx)
    expect(result.valid).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].code).toBe('SHARE_SUM_MISMATCH')
    expect(result.violations[0].diffUnits).toBe(100)
    expect(result.violations[0].diffAmount).toBe(100)
    expect(() => assertSplitInvariant(tx)).toThrow(SplitInvariantError)
    expect(StrictTransactionSchema.safeParse(tx).success).toBe(false)
  })

  it('多人墊付：Σpayers 與 Σshares 皆等於 amount 時通過驗證', () => {
    const tx = createTx({
      id: '11111111-1111-4111-8111-111111111114',
      amount: 3000,
      splitConfig: {
        payerId: 'alice',
        payers: [
          { memberId: 'alice', amount: 1800 },
          { memberId: 'bob', amount: 1200 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 1000 },
          { memberId: 'bob', finalAmount: 1000 },
          { memberId: 'charlie', finalAmount: 1000 },
        ],
      },
    })

    const result = validateSplitInvariant(tx)
    expect(result.valid).toBe(true)
    expect(result.payersSumUnits).toBe(3000)
    expect(result.sharesSumUnits).toBe(3000)
  })

  it('多人墊付：Σpayers !== amount 時回報 PAYER_SUM_MISMATCH', () => {
    const tx = createTx({
      id: '11111111-1111-4111-8111-111111111115',
      amount: 3000,
      splitConfig: {
        payerId: 'alice',
        payers: [
          { memberId: 'alice', amount: 1800 },
          { memberId: 'bob', amount: 700 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 1000 },
          { memberId: 'bob', finalAmount: 1000 },
          { memberId: 'charlie', finalAmount: 1000 },
        ],
      },
    })

    const result = validateSplitInvariant(tx)
    expect(result.valid).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].code).toBe('PAYER_SUM_MISMATCH')
    expect(result.violations[0].diffUnits).toBe(500)
    expect(result.violations[0].diffAmount).toBe(500)
  })

  it('退款（refund）：同樣套用不變式，正常通過、分攤或多人退款不平時回報異常', () => {
    const validRefund = createTx({
      id: '11111111-1111-4111-8111-111111111116',
      type: 'refund',
      amount: 1200,
      splitConfig: {
        payerId: 'alice',
        payers: [
          { memberId: 'alice', amount: 600 },
          { memberId: 'bob', amount: 600 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 600 },
          { memberId: 'bob', finalAmount: 600 },
        ],
      },
    })
    expect(validateSplitInvariant(validRefund).valid).toBe(true)

    const brokenRefund = createTx({
      id: '11111111-1111-4111-8111-111111111117',
      type: 'refund',
      amount: 1200,
      splitConfig: {
        payerId: 'alice',
        payers: [
          { memberId: 'alice', amount: 600 },
          { memberId: 'bob', amount: 400 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 500 },
          { memberId: 'bob', finalAmount: 500 },
        ],
      },
    })
    const result = validateSplitInvariant(brokenRefund)
    expect(result.valid).toBe(false)
    expect(result.violations.map((v) => v.code)).toEqual([
      'SHARE_SUM_MISMATCH',
      'PAYER_SUM_MISMATCH',
    ])
  })

  it('migrationEngine.migrateTransaction 預設寬鬆模式相容舊資料，嚴格模式則拒絕違規資料', () => {
    const legacyRaw = {
      id: '11111111-1111-4111-8111-111111111118',
      vaultLevel: 'normal',
      type: 'expense',
      amount: 1000,
      currency: 'TWD',
      categoryKey: 'cat_food',
      date: '2026-11-26',
      updatedAt: 1732600000000,
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 400 },
          { memberId: 'bob', finalAmount: 400 },
        ],
      },
    }

    const onViolation = vi.fn()
    const migrated = migrateTransaction(legacyRaw, {
      onSplitInvariantViolation: onViolation,
    })
    expect(migrated.id).toBe(legacyRaw.id)
    expect(onViolation).toHaveBeenCalledTimes(1)
    expect(onViolation.mock.calls[0][1][0].code).toBe('SHARE_SUM_MISMATCH')

    expect(() =>
      migrateTransaction(legacyRaw, { strictSplitInvariant: true }),
    ).toThrow(SchemaMigrationError)
  })
})

describe('settleUpEngine - 尾差容許與超額差額回報', () => {
  it('多人墊付跨幣別換算僅有 ≤ 成員數個 minor unit 尾差時，自動吸收且不回報異常', () => {
    // 3 人各分攤 333 / 333 / 334 JPY（總額 1000 JPY），兩人墊付 500 / 500 JPY
    // 匯率 0.213 -> shares: round(70.929)=71, 71, round(71.142)=71 (總 213)；payers: round(106.5)=107, 107 (總 214)
    // roundingDiff = -1，容許上限 = 3（3 位成員），應自動吸收且全體淨額守恆為 0
    const tx = createTx({
      id: '22222222-2222-4222-8222-222222222201',
      amount: 1000,
      currency: 'JPY',
      exchangeRateToBase: 0.213,
      splitConfig: {
        payerId: 'alice',
        payers: [
          { memberId: 'alice', amount: 500 },
          { memberId: 'bob', amount: 500 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 333 },
          { memberId: 'bob', finalAmount: 333 },
          { memberId: 'charlie', finalAmount: 334 },
        ],
      },
    })

    expect(getSettlementRoundingToleranceUnits(tx)).toBe(3)
    const result = calculateSettleUp([tx], 'TWD', ['alice', 'bob', 'charlie'])
    expect(result.anomalies).toEqual([])
    expect(result.balances.reduce((acc, b) => acc + b.netAmount, 0)).toBe(0)
  })

  it('多人墊付差額超過容許尾差時，不得靜默灌給第一位墊付人，並於 anomalies 回報', () => {
    // 總額 3000，shares 總和 3000，但 payers 總和僅 2500（差 500 > 容許上限 3）
    const tx = createTx({
      id: '22222222-2222-4222-8222-222222222202',
      amount: 3000,
      splitConfig: {
        payerId: 'alice',
        payers: [
          { memberId: 'alice', amount: 2000 },
          { memberId: 'bob', amount: 500 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 1000 },
          { memberId: 'bob', finalAmount: 1000 },
          { memberId: 'charlie', finalAmount: 1000 },
        ],
      },
    })

    const result = calculateSettleUp([tx], 'TWD', ['alice', 'bob', 'charlie'])
    // Alice 實付應維持 2000，不可被靜默灌水成 2500
    const aliceBal = result.balances.find((b) => b.memberId === 'alice')
    const bobBal = result.balances.find((b) => b.memberId === 'bob')
    expect(aliceBal?.totalPaid).toBe(2000)
    expect(bobBal?.totalPaid).toBe(500)

    expect(result.anomalies).toEqual([
      {
        transactionId: tx.id,
        code: 'PAYER_SUM_MISMATCH',
        diffUnits: 500,
        toleranceUnits: 3,
        diffAmount: 500,
        currency: 'TWD',
      },
    ])
  })

  it('單人墊付 Σshares !== amount 時，於 anomalies 回報 SHARE_SUM_MISMATCH', () => {
    const tx = createTx({
      id: '22222222-2222-4222-8222-222222222203',
      amount: 1000,
      splitConfig: {
        payerId: 'alice',
        mode: 'custom_plus_equal',
        shares: [
          { memberId: 'alice', finalAmount: 300 },
          { memberId: 'bob', finalAmount: 400 },
        ],
      },
    })

    const result = calculateSettleUp([tx], 'TWD', ['alice', 'bob'])
    expect(result.anomalies).toEqual([
      {
        transactionId: tx.id,
        code: 'SHARE_SUM_MISMATCH',
        diffUnits: 300,
        toleranceUnits: 0,
        diffAmount: 300,
        currency: 'TWD',
      },
    ])
  })

  it('多人退款（refund）差額超過容許尾差時，同樣不靜默灌給第一位墊付人並回報異常', () => {
    const tx = createTx({
      id: '22222222-2222-4222-8222-222222222204',
      type: 'refund',
      amount: 1000,
      splitConfig: {
        payerId: 'alice',
        payers: [
          { memberId: 'alice', amount: 400 },
          { memberId: 'bob', amount: 200 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 500 },
          { memberId: 'bob', finalAmount: 500 },
        ],
      },
    })

    const result = calculateSettleUp([tx], 'TWD', ['alice', 'bob'])
    const aliceBal = result.balances.find((b) => b.memberId === 'alice')
    expect(aliceBal?.totalPaid).toBe(-400)
    expect(result.anomalies).toEqual([
      {
        transactionId: tx.id,
        code: 'PAYER_SUM_MISMATCH',
        diffUnits: 400,
        toleranceUnits: 2,
        diffAmount: 400,
        currency: 'TWD',
      },
    ])
  })
})
