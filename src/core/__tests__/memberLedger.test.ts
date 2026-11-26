import { describe, expect, it } from 'vitest'
import {
  computeMemberTxContribution,
  computeTxLedgerBreakdown,
  summarizeMemberTransactions,
  sumProjectExpense,
  sumTransactionsExpense,
} from '@/core/memberLedger'
import {
  applySettlementRatesToTransactions,
  calculateSettleUp,
} from '@/core/settleUpEngine'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'
import type { Transaction } from '@/schemas/ledgerSchema'

function createTx(
  overrides: Partial<Transaction> & Pick<Transaction, 'id' | 'amount' | 'splitConfig'>,
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

describe('memberLedger - 成員單筆／彙總與結算引擎統一計算口徑', () => {
  it('單人墊付跨幣別四捨五入時，墊付金額採 Σshares 口徑與結算引擎一致（不因 tx.amount * rate 產生 1 元落差）', () => {
    // JPY 1000 三人拆帳 334 / 333 / 333，匯率 0.214 -> TWD：
    // 各 share 換算：round(334*0.214)=71, round(333*0.214)=71, round(333*0.214)=71 -> Σshares = 213 TWD
    // 若誤用 tx.amount * rate = 1000 * 0.214 = 214 TWD，會與結算引擎落差 1 元
    const tx = createTx({
      id: '11111111-1111-4111-8111-111111111111',
      amount: 1000,
      currency: 'JPY',
      exchangeRateToBase: 0.214,
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 334 },
          { memberId: 'bob', finalAmount: 333 },
          { memberId: 'carol', finalAmount: 333 },
        ],
      },
    })

    const aliceContrib = computeMemberTxContribution(tx, 'alice', 'TWD')
    const bobContrib = computeMemberTxContribution(tx, 'bob', 'TWD')
    const settleUp = calculateSettleUp([tx], 'TWD', ['alice', 'bob', 'carol'])
    const aliceBal = settleUp.balances.find((b) => b.memberId === 'alice')!

    // 1000 JPY * 0.214 = 214 TWD，最大餘數法分配為 72 / 71 / 71（總和不蒸發，與結算引擎 100% 對拍）
    expect(aliceContrib.share).toBe(72)
    expect(aliceContrib.paid).toBe(214)
    expect(aliceContrib.net).toBe(142)
    expect(aliceContrib.paid).toBe(aliceBal.totalPaid)
    expect(aliceContrib.share).toBe(aliceBal.totalExpense)
    expect(aliceContrib.net).toBe(aliceBal.netAmount)

    expect(bobContrib.share).toBe(71)
    expect(bobContrib.paid).toBe(0)
    expect(bobContrib.net).toBe(-71)
  })

  it('個人對帳逐筆加總與 calculateSettleUp.balances 之 totalExpense / totalPaid / netAmount 100% 對拍（含單人墊付、多人墊付、跨幣別尾差、退款、還款與軟刪除）', () => {
    const rawTxs: Transaction[] = [
      // 1. 單人墊付跨幣別（會產生 Σshares ≠ tx.amount*rate 的尾差情境）
      createTx({
        id: '21111111-1111-4111-8111-111111111111',
        amount: 1000,
        currency: 'JPY',
        exchangeRateToBase: 0.214,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 334 },
            { memberId: 'bob', finalAmount: 333 },
            { memberId: 'carol', finalAmount: 333 },
          ],
        },
      }),
      // 2. 多人墊付跨幣別（容許尾差吸收至第一位墊付人）
      createTx({
        id: '22222222-2222-4222-8222-222222222222',
        amount: 1000,
        currency: 'JPY',
        exchangeRateToBase: 0.214,
        splitConfig: {
          payerId: 'bob',
          payers: [
            { memberId: 'bob', amount: 500 },
            { memberId: 'carol', amount: 500 },
          ],
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 334 },
            { memberId: 'bob', finalAmount: 333 },
            { memberId: 'carol', finalAmount: 333 },
          ],
        },
      }),
      // 3. 退款沖銷（負向貢獻）
      createTx({
        id: '23333333-3333-4333-8333-333333333333',
        type: 'refund',
        amount: 300,
        currency: 'JPY',
        exchangeRateToBase: 0.214,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 100 },
            { memberId: 'bob', finalAmount: 100 },
            { memberId: 'carol', finalAmount: 100 },
          ],
        },
      }),
      // 4. 還款轉帳（不計入 totalExpense / totalPaid，但計入 netAmount）
      createTx({
        id: '24444444-4444-4444-8444-444444444444',
        type: 'transfer',
        amount: 50,
        currency: 'TWD',
        exchangeRateToBase: 1,
        categoryKey: 'cat_settlement',
        splitConfig: {
          payerId: 'carol',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'alice', finalAmount: 50 }],
        },
      }),
      // 5. 已軟刪除交易（應完全忽略）
      createTx({
        id: '25555555-5555-4555-8555-555555555555',
        amount: 9999,
        currency: 'TWD',
        exchangeRateToBase: 1,
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

    const members = ['alice', 'bob', 'carol']
    const settleUp = calculateSettleUp(rawTxs, 'TWD', members)
    const effectiveTxs = applySettlementRatesToTransactions(rawTxs, 'TWD')

    for (const memberId of members) {
      const bal = settleUp.balances.find((b) => b.memberId === memberId)!

      // 模擬 ProjectSettleTab.selectedMemberStatement 僅對消費／退款逐筆累加
      const spendingTxs = effectiveTxs.filter(
        (tx) => !tx.isDeleted && (tx.type === 'expense' || tx.type === 'refund'),
      )
      let statementShareUnits = 0
      let statementPaidUnits = 0
      for (const tx of spendingTxs) {
        const c = computeMemberTxContribution(tx, memberId, 'TWD')
        statementShareUnits += c.shareUnits
        statementPaidUnits += c.paidUnits
      }

      expect(fromMinorUnits(statementShareUnits, 'TWD')).toBe(bal.totalExpense)
      expect(fromMinorUnits(statementPaidUnits, 'TWD')).toBe(bal.totalPaid)

      // 模擬 summarizeMemberTransactions（含 transfer）對拍三項指標
      const summary = summarizeMemberTransactions(effectiveTxs, memberId, 'TWD')
      expect(summary.totalExpense).toBe(bal.totalExpense)
      expect(summary.totalPaid).toBe(bal.totalPaid)
      expect(summary.netAmount).toBe(bal.netAmount)
    }

    // 專案總消費加總對拍
    expect(sumTransactionsExpense(effectiveTxs, 'TWD')).toBe(
      settleUp.totalProjectExpense,
    )
  })

  it('兩位小數幣別（USD）與跨幣別覆寫匯率下，對帳明細加總與結算餘額精準一致', () => {
    const txs: Transaction[] = [
      createTx({
        id: '31111111-1111-4111-8111-111111111111',
        amount: 100,
        currency: 'EUR',
        exchangeRateToBase: 1.083,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 33.34 },
            { memberId: 'bob', finalAmount: 33.33 },
            { memberId: 'carol', finalAmount: 33.33 },
          ],
        },
      }),
    ]

    const effective = applySettlementRatesToTransactions(txs, 'USD', {
      EUR: 1.095,
    })
    const settleUp = calculateSettleUp(txs, 'USD', ['alice', 'bob', 'carol'], {
      overrideRatesByCurrency: { EUR: 1.095 },
    })

    for (const memberId of ['alice', 'bob', 'carol']) {
      const bal = settleUp.balances.find((b) => b.memberId === memberId)!
      const contrib = computeMemberTxContribution(effective[0], memberId, 'USD')
      expect(contrib.share).toBe(bal.totalExpense)
      expect(contrib.paid).toBe(bal.totalPaid)
      expect(contrib.net).toBe(bal.netAmount)
      expect(contrib.shareUnits).toBe(toMinorUnits(bal.totalExpense, 'USD'))
      expect(contrib.paidUnits).toBe(toMinorUnits(bal.totalPaid, 'USD'))
    }
  })

  it('多人墊付超出容許尾差時回報 payerSumMismatch 且不靜默灌給第一位墊付人', () => {
    const tx = createTx({
      id: '41111111-1111-4111-8111-111111111111',
      amount: 1000,
      currency: 'TWD',
      exchangeRateToBase: 1,
      splitConfig: {
        payerId: 'alice',
        payers: [
          { memberId: 'alice', amount: 400 },
          { memberId: 'bob', amount: 400 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 500 },
          { memberId: 'bob', finalAmount: 500 },
        ],
      },
    })

    const breakdown = computeTxLedgerBreakdown(tx, 'TWD')
    expect(breakdown).not.toBeNull()
    expect(breakdown!.payerSumMismatch).toEqual({
      diffUnits: 200,
      toleranceUnits: 2,
      diffAmount: 200,
      currency: 'TWD',
    })
    expect(computeMemberTxContribution(tx, 'alice', 'TWD').paid).toBe(400)
    expect(computeMemberTxContribution(tx, 'bob', 'TWD').paid).toBe(400)
  })

  it('sumTransactionsExpense 支援無 splitConfig 之舊交易回退，並忽略 isDeleted 與 transfer', () => {
    const txs: Transaction[] = [
      {
        id: '51111111-1111-4111-8111-111111111111',
        schemaVersion: 1,
        vaultLevel: 'normal',
        type: 'expense',
        amount: 250,
        currency: 'TWD',
        exchangeRateToBase: 1,
        categoryKey: 'cat_food',
        date: '2026-11-26',
        time: '12:00',
        updatedAt: 1732600000000,
      },
      createTx({
        id: '52222222-2222-4222-8222-222222222222',
        type: 'refund',
        amount: 50,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [{ memberId: 'alice', finalAmount: 50 }],
        },
      }),
      createTx({
        id: '53333333-3333-4333-8333-333333333333',
        type: 'transfer',
        amount: 100,
        splitConfig: {
          payerId: 'bob',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'alice', finalAmount: 100 }],
        },
      }),
    ]

    expect(sumTransactionsExpense(txs, 'TWD')).toBe(200)
  })

  it('sumProjectExpense 首頁總額與結算頁 calculateSettleUp(per_tx) 之 totalProjectExpense 100% 對拍，且不受即時匯率覆寫影響', () => {
    const txs: Transaction[] = [
      // 跨幣別單人墊付（尾差情境：JPY 1000 * 0.214 -> Σshares = 213 TWD）
      createTx({
        id: '61111111-1111-4111-8111-111111111111',
        amount: 1000,
        currency: 'JPY',
        exchangeRateToBase: 0.214,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 334 },
            { memberId: 'bob', finalAmount: 333 },
            { memberId: 'carol', finalAmount: 333 },
          ],
        },
      }),
      // 多人墊付 USD -> TWD
      createTx({
        id: '62222222-2222-4222-8222-222222222222',
        amount: 10,
        currency: 'USD',
        exchangeRateToBase: 32.5,
        splitConfig: {
          payerId: 'bob',
          payers: [
            { memberId: 'bob', amount: 4 },
            { memberId: 'carol', amount: 6 },
          ],
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 5 },
            { memberId: 'bob', finalAmount: 5 },
          ],
        },
      }),
      // 退款（負向沖銷）
      createTx({
        id: '63333333-3333-4333-8333-333333333333',
        type: 'refund',
        amount: 200,
        currency: 'JPY',
        exchangeRateToBase: 0.21,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 100 },
            { memberId: 'bob', finalAmount: 100 },
          ],
        },
      }),
      // 還款轉帳（不計入專案總消費）
      createTx({
        id: '64444444-4444-4444-8444-444444444444',
        type: 'transfer',
        amount: 500,
        currency: 'TWD',
        exchangeRateToBase: 1,
        categoryKey: 'cat_settlement',
        splitConfig: {
          payerId: 'bob',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'alice', finalAmount: 500 }],
        },
      }),
      // 已軟刪除（應忽略）
      createTx({
        id: '65555555-5555-4555-8555-555555555555',
        amount: 9999,
        currency: 'TWD',
        exchangeRateToBase: 1,
        isDeleted: true,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [{ memberId: 'alice', finalAmount: 9999 }],
        },
      }),
      // 無 splitConfig 舊交易（與 calculateSettleUp 一致忽略）
      {
        id: '66666666-6666-4666-8666-666666666666',
        schemaVersion: 1,
        vaultLevel: 'normal',
        type: 'expense',
        amount: 888,
        currency: 'TWD',
        exchangeRateToBase: 1,
        categoryKey: 'cat_food',
        date: '2026-11-26',
        time: '12:00',
        updatedAt: 1732600000000,
      },
    ]

    const perTxSettle = calculateSettleUp(txs, 'TWD', ['alice', 'bob', 'carol'])
    const liveOverrideSettle = calculateSettleUp(
      txs,
      'TWD',
      ['alice', 'bob', 'carol'],
      { overrideRatesByCurrency: { JPY: 0.25, USD: 35 } },
    )

    // 213 + (163 + 163) - (21 + 21) = 497
    expect(sumProjectExpense(txs, 'TWD')).toBe(perTxSettle.totalProjectExpense)
    expect(sumProjectExpense(txs, 'TWD')).toBe(497)
    // 確認首頁總額採 per_tx 固定口徑，不因 live 匯率覆寫而變動
    expect(liveOverrideSettle.totalProjectExpense).not.toBe(
      perTxSettle.totalProjectExpense,
    )
  })

  it('sumProjectExpense 於兩位小數幣別（USD）與空清單下結果與 calculateSettleUp(per_tx) 一致', () => {
    expect(sumProjectExpense([], 'USD')).toBe(0)

    const txs: Transaction[] = [
      createTx({
        id: '71111111-1111-4111-8111-111111111111',
        amount: 100,
        currency: 'EUR',
        exchangeRateToBase: 1.083,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 33.34 },
            { memberId: 'bob', finalAmount: 33.33 },
            { memberId: 'carol', finalAmount: 33.33 },
          ],
        },
      }),
    ]

    const perTxSettle = calculateSettleUp(txs, 'USD', ['alice', 'bob', 'carol'])
    expect(sumProjectExpense(txs, 'USD')).toBe(perTxSettle.totalProjectExpense)
  })
})
