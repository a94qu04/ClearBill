import { describe, expect, it } from 'vitest'
import { calculateSettleUp, simplifyNetBalances } from '@/core/settleUpEngine'
import type { Transaction } from '@/schemas/ledgerSchema'

function createExpenseTx(
  overrides: Partial<Transaction> & Pick<Transaction, 'id' | 'amount' | 'splitConfig'>,
): Transaction {
  return {
    schemaVersion: 1,
    vaultLevel: 'normal',
    type: 'expense',
    currency: 'TWD',
    exchangeRateToBase: 1,
    categoryKey: 'cat_food',
    date: '2026-11-24',
    time: '00:00',
    updatedAt: 1732400000000,
    ...overrides,
  }
}

describe('settleUpEngine - 多人債務最小化結算演算法', () => {
  it('鏈式債務簡化：A 幫 B 付 300、B 幫 C 付 300，簡化為 C 直接付 A 300', () => {
    const transactions: Transaction[] = [
      createExpenseTx({
        id: '11111111-1111-4111-8111-111111111111',
        amount: 300,
        splitConfig: {
          payerId: 'alice',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'bob', finalAmount: 300 }],
        },
      }),
      createExpenseTx({
        id: '22222222-2222-4222-8222-222222222222',
        amount: 300,
        splitConfig: {
          payerId: 'bob',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'charlie', finalAmount: 300 }],
        },
      }),
    ]

    const result = calculateSettleUp(transactions, 'TWD')

    expect(result.transfers).toEqual([
      {
        fromMemberId: 'charlie',
        toMemberId: 'alice',
        amount: 300,
        currency: 'TWD',
      },
    ])
  })

  it('四人旅遊多筆交錯墊付，能最小化轉帳筆數且收支總和為 0', () => {
    const transactions: Transaction[] = [
      // Alice 墊付住宿 4000（四人平分各 1000）
      createExpenseTx({
        id: '11111111-1111-4111-8111-111111111111',
        amount: 4000,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 1000 },
            { memberId: 'bob', finalAmount: 1000 },
            { memberId: 'charlie', finalAmount: 1000 },
            { memberId: 'dave', finalAmount: 1000 },
          ],
        },
      }),
      // Bob 墊付晚餐 1200（四人平分各 300）
      createExpenseTx({
        id: '22222222-2222-4222-8222-222222222222',
        amount: 1200,
        splitConfig: {
          payerId: 'bob',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 300 },
            { memberId: 'bob', finalAmount: 300 },
            { memberId: 'charlie', finalAmount: 300 },
            { memberId: 'dave', finalAmount: 300 },
          ],
        },
      }),
    ]

    // 淨餘額：Alice +2700, Bob -100, Charlie -1300, Dave -1300
    const result = calculateSettleUp(transactions, 'TWD')

    expect(result.transfers).toEqual([
      { fromMemberId: 'charlie', toMemberId: 'alice', amount: 1300, currency: 'TWD' },
      { fromMemberId: 'dave', toMemberId: 'alice', amount: 1300, currency: 'TWD' },
      { fromMemberId: 'bob', toMemberId: 'alice', amount: 100, currency: 'TWD' },
    ])

    const netSum = result.balances.reduce((acc, b) => acc + b.netAmount, 0)
    expect(netSum).toBe(0)
  })

  it('支援外幣匯率換算、退款（refund）沖銷與忽略軟刪除交易', () => {
    const transactions: Transaction[] = [
      // Alice 在日本墊付 JPY 10000，匯率 0.21 -> TWD 2100（Alice 與 Bob 平分各 1050）
      createExpenseTx({
        id: '11111111-1111-4111-8111-111111111111',
        amount: 10000,
        currency: 'JPY',
        exchangeRateToBase: 0.21,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 5000 },
            { memberId: 'bob', finalAmount: 5000 },
          ],
        },
      }),
      // Alice 收到退稅退款 JPY 2000，匯率 0.21 -> TWD 420（兩人平分各減免 210）
      createExpenseTx({
        id: '22222222-2222-4222-8222-222222222222',
        type: 'refund',
        amount: 2000,
        currency: 'JPY',
        exchangeRateToBase: 0.21,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 1000 },
            { memberId: 'bob', finalAmount: 1000 },
          ],
        },
      }),
      // 已刪除交易應被忽略
      createExpenseTx({
        id: '33333333-3333-4333-8333-333333333333',
        amount: 9999,
        isDeleted: true,
        splitConfig: {
          payerId: 'bob',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 5000 },
            { memberId: 'bob', finalAmount: 4999 },
          ],
        },
      }),
    ]

    const result = calculateSettleUp(transactions, 'TWD')

    // Bob 應付給 Alice：1050 - 210 = 840 TWD
    expect(result.transfers).toEqual([
      { fromMemberId: 'bob', toMemberId: 'alice', amount: 840, currency: 'TWD' },
    ])
  })

  it('支援 USD 兩位小數精準結算，無浮點誤差', () => {
    const result = simplifyNetBalances(
      {
        alice: 33.34,
        bob: -16.67,
        charlie: -16.67,
      },
      'USD',
    )

    expect(result.transfers).toEqual([
      { fromMemberId: 'bob', toMemberId: 'alice', amount: 16.67, currency: 'USD' },
      { fromMemberId: 'charlie', toMemberId: 'alice', amount: 16.67, currency: 'USD' },
    ])
  })

  it('支援多人同時墊付同一筆消費（splitConfig.payers）', () => {
    // 總額 3000（三人均攤各 1000）：Alice 付 2000、Bob 付 1000、Charlie 付 0
    // 淨餘額：Alice +1000, Bob 0, Charlie -1000 -> Charlie 支付給 Alice 1000
    const transactions: Transaction[] = [
      createExpenseTx({
        id: '44444444-4444-4444-8444-444444444444',
        amount: 3000,
        splitConfig: {
          payerId: 'alice',
          payers: [
            { memberId: 'alice', amount: 2000 },
            { memberId: 'bob', amount: 1000 },
          ],
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 1000 },
            { memberId: 'bob', finalAmount: 1000 },
            { memberId: 'charlie', finalAmount: 1000 },
          ],
        },
      }),
    ]

    const result = calculateSettleUp(transactions, 'TWD')

    expect(result.transfers).toEqual([
      { fromMemberId: 'charlie', toMemberId: 'alice', amount: 1000, currency: 'TWD' },
    ])
    expect(result.balances.reduce((acc, b) => acc + b.netAmount, 0)).toBe(0)
  })

  it('支援還款紀錄（transfer）部分已付與全額結清沖銷', () => {
    const transactions: Transaction[] = [
      // Alice 幫 Bob 墊付 2000（Bob 欠 Alice 2000）
      createExpenseTx({
        id: '55555555-5555-4555-8555-555555555555',
        amount: 2000,
        splitConfig: {
          payerId: 'alice',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'bob', finalAmount: 2000 }],
        },
      }),
      // Bob 先還給 Alice 800（部分還款）
      createExpenseTx({
        id: '66666666-6666-4666-8666-666666666666',
        type: 'transfer',
        amount: 800,
        categoryKey: 'cat_settlement',
        splitConfig: {
          payerId: 'bob',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'alice', finalAmount: 800 }],
        },
      }),
    ]

    const partialResult = calculateSettleUp(transactions, 'TWD')
    expect(partialResult.transfers).toEqual([
      { fromMemberId: 'bob', toMemberId: 'alice', amount: 1200, currency: 'TWD' },
    ])

    // Bob 再把剩下的 1200 付清
    transactions.push(
      createExpenseTx({
        id: '77777777-7777-4777-8777-777777777777',
        type: 'transfer',
        amount: 1200,
        categoryKey: 'cat_settlement',
        splitConfig: {
          payerId: 'bob',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'alice', finalAmount: 1200 }],
        },
      }),
    )

    const settledResult = calculateSettleUp(transactions, 'TWD')
    expect(settledResult.transfers).toEqual([])
    // 即使已完全結清，個人消費總支出與總墊付仍應精準統計（不把 transfer 還款算作消費）
    const aliceBal = settledResult.balances.find((b) => b.memberId === 'alice')
    const bobBal = settledResult.balances.find((b) => b.memberId === 'bob')
    expect(settledResult.totalProjectExpense).toBe(2000)
    expect(aliceBal).toEqual({
      memberId: 'alice',
      totalExpense: 0,
      totalPaid: 2000,
      netAmount: 0,
    })
    expect(bobBal).toEqual({
      memberId: 'bob',
      totalExpense: 2000,
      totalPaid: 0,
      netAmount: 0,
    })
  })
})
