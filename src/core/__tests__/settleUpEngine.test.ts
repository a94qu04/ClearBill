import { describe, expect, it } from 'vitest'
import {
  applySettlementRatesToTransactions,
  buildHubSettlementTransfers,
  calculateSettleUp,
  simplifyNetBalances,
  type MissingSettlementRateInfo,
} from '@/core/settleUpEngine'
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

  it('支援依自訂或即時結算匯率（overrideRatesByCurrency）統一重算外幣結算金額', () => {
    // 一筆 10,000 JPY（原紀錄匯率 0.20 = 2,000 TWD），Alice 墊付、兩人平分
    const transactions: Transaction[] = [
      createExpenseTx({
        id: '88888888-8888-4888-8888-888888888888',
        amount: 10000,
        currency: 'JPY',
        exchangeRateToBase: 0.2,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 5000 },
            { memberId: 'bob', finalAmount: 5000 },
          ],
        },
      }),
    ]

    // 各筆原匯率：總額 2000 TWD，Bob 付 Alice 1000 TWD
    const perTx = calculateSettleUp(transactions, 'TWD')
    expect(perTx.totalProjectExpense).toBe(2000)
    expect(perTx.transfers).toEqual([
      { fromMemberId: 'bob', toMemberId: 'alice', amount: 1000, currency: 'TWD' },
    ])

    // 結算改選用 0.22 匯率：總額 2200 TWD，Bob 付 Alice 1100 TWD
    const overridden = calculateSettleUp(transactions, 'TWD', [], {
      overrideRatesByCurrency: { JPY: 0.22 },
    })
    expect(overridden.totalProjectExpense).toBe(2200)
    expect(overridden.transfers).toEqual([
      { fromMemberId: 'bob', toMemberId: 'alice', amount: 1100, currency: 'TWD' },
    ])
    expect(overridden.balances.reduce((acc, b) => acc + b.netAmount, 0)).toBe(0)
  })

  it('支援結算頁獨立指定不同於記帳主幣別之結帳幣別（含原幣別保留 1:1、跨幣別轉換與結帳幣別還款沖銷）', () => {
    // 專案記帳主幣別為 KRW：
    // 1. Alice 墊付 KRW 100,000（兩人平分各 50,000 KRW）
    // 2. Bob 先在台灣用 TWD 1,000 訂票（記帳時折合 KRW 匯率 40，兩人平分各 500 TWD）
    const transactions: Transaction[] = [
      createExpenseTx({
        id: '99999999-9999-4999-8999-999999999991',
        amount: 100000,
        currency: 'KRW',
        exchangeRateToBase: 1,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 50000 },
            { memberId: 'bob', finalAmount: 50000 },
          ],
        },
      }),
      createExpenseTx({
        id: '99999999-9999-4999-8999-999999999992',
        amount: 1000,
        currency: 'TWD',
        exchangeRateToBase: 40,
        splitConfig: {
          payerId: 'bob',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 500 },
            { memberId: 'bob', finalAmount: 500 },
          ],
        },
      }),
    ]

    // 結算頁改選以 TWD 結帳（1 KRW = 0.024 TWD）：
    // - KRW 100,000 -> TWD 2,400（各負擔 1,200，Alice 墊付 2,400）
    // - TWD 1,000 原幣別即為結帳幣別 -> 嚴格維持 1:1 = TWD 1,000（各負擔 500，Bob 墊付 1,000）
    // - 總支出 = 3,400 TWD；Alice 淨額 +700，Bob 淨額 -700 -> Bob 付 Alice 700 TWD
    const inTwd = calculateSettleUp(transactions, 'TWD', ['alice', 'bob'], {
      projectBaseCurrency: 'KRW',
      baseToSettlementRate: 0.024,
    })

    expect(inTwd.currency).toBe('TWD')
    expect(inTwd.totalProjectExpense).toBe(3400)
    expect(inTwd.transfers).toEqual([
      { fromMemberId: 'bob', toMemberId: 'alice', amount: 700, currency: 'TWD' },
    ])
    expect(inTwd.balances.reduce((acc, b) => acc + b.netAmount, 0)).toBe(0)

    // Bob 直接以 TWD 還款 700 給 Alice 後應完全結清
    const afterPaid = calculateSettleUp(
      [
        ...transactions,
        createExpenseTx({
          id: '99999999-9999-4999-8999-999999999993',
          type: 'transfer',
          amount: 700,
          currency: 'TWD',
          exchangeRateToBase: 41.6667,
          categoryKey: 'cat_settlement',
          splitConfig: {
            payerId: 'bob',
            mode: 'custom_plus_equal',
            shares: [{ memberId: 'alice', finalAmount: 700 }],
          },
        }),
      ],
      'TWD',
      ['alice', 'bob'],
      {
        projectBaseCurrency: 'KRW',
        baseToSettlementRate: 0.024,
      },
    )

    expect(afterPaid.transfers).toEqual([])
    expect(afterPaid.balances.every((b) => b.netAmount === 0)).toBe(true)
  })

  it('保留專案成員順序並支援「財務長集中收付」與「公費袋虛擬成員」完整數學守恆', () => {
    // 模擬 3 位團員 + 1 個公費袋：每人交 3000 THB 給公費袋，公費袋墊付包車 4500 THB（3 人平分各 1500）
    const orderedIds = ['z_charlie', 'a_alice', 'm_bob', 'pool_fund']
    const txs: Transaction[] = [
      ...['z_charlie', 'a_alice', 'm_bob'].map((mid, idx) =>
        createExpenseTx({
          id: `10000000-0000-4000-8000-00000000000${idx + 1}`,
          type: 'transfer',
          amount: 3000,
          currency: 'THB',
          categoryKey: 'cat_settlement',
          splitConfig: {
            payerId: mid,
            mode: 'custom_plus_equal',
            shares: [{ memberId: 'pool_fund', finalAmount: 3000 }],
          },
        }),
      ),
      createExpenseTx({
        id: '10000000-0000-4000-8000-000000000010',
        type: 'expense',
        amount: 4500,
        currency: 'THB',
        splitConfig: {
          payerId: 'pool_fund',
          mode: 'equal',
          shares: [
            { memberId: 'z_charlie', finalAmount: 1500 },
            { memberId: 'a_alice', finalAmount: 1500 },
            { memberId: 'm_bob', finalAmount: 1500 },
          ],
        },
      }),
    ]

    const res = calculateSettleUp(txs, 'THB', orderedIds)

    // 1. 保留專案原始成員順序，不再被 UUID / 字母順序打亂
    expect(res.balances.map((b) => b.memberId)).toEqual(orderedIds)
    // 2. 公費袋剩餘現金 4500（netAmount = -4500），三位團員各有應收回 +1500
    expect(res.balances.find((b) => b.memberId === 'pool_fund')?.netAmount).toBe(-4500)
    expect(res.balances.find((b) => b.memberId === 'z_charlie')?.netAmount).toBe(1500)

    // 3. 集中收付模式（指定 a_alice 為財務長窗口）：不產生自己轉自己，且淨收支精準守恆
    const hubTransfers = buildHubSettlementTransfers(res.balances, 'a_alice', 'THB')
    expect(hubTransfers.every((tr) => tr.fromMemberId !== tr.toMemberId)).toBe(true)
    expect(hubTransfers).toEqual([
      { fromMemberId: 'pool_fund', toMemberId: 'a_alice', amount: 4500, currency: 'THB' },
      { fromMemberId: 'a_alice', toMemberId: 'z_charlie', amount: 1500, currency: 'THB' },
      { fromMemberId: 'a_alice', toMemberId: 'm_bob', amount: 1500, currency: 'THB' },
    ])
  })

  it('結算切換自訂匯率與結帳幣別不會變動原交易之 exchangeRateToBase，切回原匯率可 100% 還原', () => {
    const rawTxs: Transaction[] = [
      createExpenseTx({
        id: '20000000-0000-4000-8000-000000000001',
        amount: 1000,
        currency: 'THB',
        exchangeRateToBase: 0.91,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 500 },
            { memberId: 'bob', finalAmount: 500 },
          ],
        },
      }),
      createExpenseTx({
        id: '20000000-0000-4000-8000-000000000002',
        amount: 1000,
        currency: 'THB',
        exchangeRateToBase: 0.95,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 500 },
            { memberId: 'bob', finalAmount: 500 },
          ],
        },
      }),
    ]

    // 先以各筆原匯率結算：910 + 950 = 1860 TWD
    const orig = calculateSettleUp(rawTxs, 'TWD', ['alice', 'bob'])
    expect(orig.totalProjectExpense).toBe(1860)

    // 切換統一自訂結算匯率 1.0：2000 TWD
    const custom = calculateSettleUp(rawTxs, 'TWD', ['alice', 'bob'], {
      overrideRatesByCurrency: { THB: 1.0 },
    })
    expect(custom.totalProjectExpense).toBe(2000)

    // 切回各筆原匯率：原始兩筆交易的匯率 0.91 與 0.95 應毫髮無傷並還原 1860 TWD
    expect(rawTxs[0].exchangeRateToBase).toBe(0.91)
    expect(rawTxs[1].exchangeRateToBase).toBe(0.95)
    const restored = calculateSettleUp(rawTxs, 'TWD', ['alice', 'bob'])
    expect(restored.totalProjectExpense).toBe(1860)
  })

  it('已刪除之公費袋若在歷史消費僅殘留 0 元分攤項目，結算清單不得復活成幽靈成員', () => {
    const txs: Transaction[] = [
      createExpenseTx({
        id: '30000000-0000-4000-8000-000000000001',
        amount: 600,
        currency: 'TWD',
        exchangeRateToBase: 1,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 300 },
            { memberId: 'bob', finalAmount: 300 },
            { memberId: 'pool_mww38l7v', finalAmount: 0 },
          ],
        },
      }),
    ]

    const result = calculateSettleUp(txs, 'TWD', ['alice', 'bob'])
    expect(result.balances.map((b) => b.memberId)).toEqual(['alice', 'bob'])
    expect(result.transfers).toEqual([
      { fromMemberId: 'bob', toMemberId: 'alice', amount: 300, currency: 'TWD' },
    ])
  })

  it('單筆合併之多人繳公費 transfer 應精準計入各繳款人與公費袋餘額，且不重複灌水專案總支出', () => {
    const txs: Transaction[] = [
      // 3 人各繳 1000 進公費袋（單筆統一帳目，共 3000）
      createExpenseTx({
        id: '40000000-0000-4000-8000-000000000001',
        type: 'transfer',
        amount: 3000,
        currency: 'TWD',
        exchangeRateToBase: 1,
        categoryKey: 'cat_settlement',
        splitConfig: {
          payerId: 'alice',
          payers: [
            { memberId: 'alice', amount: 1000 },
            { memberId: 'bob', amount: 1000 },
            { memberId: 'carol', amount: 1000 },
          ],
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'pool_1', finalAmount: 3000 }],
        },
      }),
      // 公費袋實際支出 1800（三人均攤各 600）
      createExpenseTx({
        id: '40000000-0000-4000-8000-000000000002',
        type: 'expense',
        amount: 1800,
        currency: 'TWD',
        exchangeRateToBase: 1,
        splitConfig: {
          payerId: 'pool_1',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 600 },
            { memberId: 'bob', finalAmount: 600 },
            { memberId: 'carol', finalAmount: 600 },
          ],
        },
      }),
    ]

    const result = calculateSettleUp(txs, 'TWD', ['alice', 'bob', 'carol', 'pool_1'])
    expect(result.totalProjectExpense).toBe(1800)
    expect(result.balances.find((b) => b.memberId === 'pool_1')).toEqual({
      memberId: 'pool_1',
      totalExpense: 0,
      totalPaid: 1800,
      netAmount: -1200,
    })
    for (const id of ['alice', 'bob', 'carol']) {
      expect(result.balances.find((b) => b.memberId === id)).toEqual({
        memberId: id,
        totalExpense: 600,
        totalPaid: 0,
        netAmount: 400,
      })
    }
    expect(result.balances.reduce((acc, b) => acc + b.netAmount, 0)).toBe(0)
  })

  it('小額外幣多人墊付消費不蒸發且絕不產生負數已墊付金額', () => {
    // 2,000 VND（匯率 0.0012 -> 2.4 TWD ≈ 2 TWD），5 人各分 400 VND，由 a 墊付 400、b 墊付 1,600
    const txs: Transaction[] = [
      createExpenseTx({
        id: '50000000-0000-4000-8000-000000000001',
        type: 'expense',
        amount: 2000,
        currency: 'VND',
        exchangeRateToBase: 0.0012,
        splitConfig: {
          payerId: 'a',
          payers: [
            { memberId: 'a', amount: 400 },
            { memberId: 'b', amount: 1600 },
          ],
          mode: 'equal',
          shares: [
            { memberId: 'a', finalAmount: 400 },
            { memberId: 'b', finalAmount: 400 },
            { memberId: 'c', finalAmount: 400 },
            { memberId: 'd', finalAmount: 400 },
            { memberId: 'e', finalAmount: 400 },
          ],
        },
      }),
    ]

    const result = calculateSettleUp(txs, 'TWD', ['a', 'b', 'c', 'd', 'e'])
    expect(result.totalProjectExpense).toBe(2)
    expect(result.balances.every((b) => b.totalPaid >= 0)).toBe(true)
    expect(result.balances.every((b) => b.totalExpense >= 0)).toBe(true)
    expect(result.balances.reduce((acc, b) => acc + b.totalPaid, 0)).toBe(2)
    expect(result.balances.reduce((acc, b) => acc + b.netAmount, 0)).toBe(0)
  })
})

describe('applySettlementRatesToTransactions - 結算匯率套用與無效匯率防護', () => {
  it('同幣別結算且無覆寫匯率時，直接回傳原陣列不建立多餘副本', () => {
    const txs: Transaction[] = [
      createExpenseTx({
        id: '50000000-0000-4000-8000-000000000001',
        amount: 500,
        currency: 'TWD',
        exchangeRateToBase: 1,
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [{ memberId: 'alice', finalAmount: 500 }],
        },
      }),
    ]

    const result = applySettlementRatesToTransactions(txs, 'TWD', undefined, 'TWD')
    expect(result).toBe(txs)
  })

  it('交易原幣別等於結帳幣別時一律正規化為 1，且覆寫匯率優先於跨幣換算、不修改原始交易', () => {
    const twdTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000002',
      amount: 1000,
      currency: 'TWD',
      exchangeRateToBase: 40, // 原專案主幣別為 KRW 時的匯率
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [{ memberId: 'alice', finalAmount: 1000 }],
      },
    })
    const krwTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000003',
      amount: 100000,
      currency: 'KRW',
      exchangeRateToBase: 1,
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [{ memberId: 'alice', finalAmount: 100000 }],
      },
    })
    const jpyTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000004',
      amount: 10000,
      currency: 'JPY',
      exchangeRateToBase: 9, // 1 JPY = 9 KRW
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [{ memberId: 'alice', finalAmount: 10000 }],
      },
    })
    const usdTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000005',
      amount: 100,
      currency: 'USD',
      exchangeRateToBase: 1350, // 1 USD = 1350 KRW
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [{ memberId: 'alice', finalAmount: 100 }],
      },
    })

    const effective = applySettlementRatesToTransactions(
      [twdTx, krwTx, jpyTx, usdTx],
      'TWD',
      { JPY: 0.22, USD: -1 }, // USD 無效覆寫應被忽略並改走 baseToSettlementRate
      'KRW',
      0.024,
    )

    expect(effective[0].exchangeRateToBase).toBe(1)
    expect(effective[1].exchangeRateToBase).toBe(0.024)
    expect(effective[2].exchangeRateToBase).toBe(0.22)
    expect(effective[3].exchangeRateToBase).toBe(Number((1350 * 0.024).toFixed(6)))

    // 原物件不得被突變
    expect(twdTx.exchangeRateToBase).toBe(40)
    expect(krwTx.exchangeRateToBase).toBe(1)
    expect(jpyTx.exchangeRateToBase).toBe(9)
    expect(usdTx.exchangeRateToBase).toBe(1350)
  })

  it('跨幣結算且 baseToSettlementRate 無效時，strict 模式拋出 ERR_SETTLEMENT_RATE_INVALID，預設模式透過回呼與 anomalies 標記', () => {
    const krwBaseTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000010',
      amount: 100000,
      currency: 'KRW',
      exchangeRateToBase: 1,
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 50000 },
          { memberId: 'bob', finalAmount: 50000 },
        ],
      },
    })
    const jpyThirdTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000011',
      amount: 10000,
      currency: 'JPY',
      exchangeRateToBase: 9,
      splitConfig: {
        payerId: 'bob',
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 5000 },
          { memberId: 'bob', finalAmount: 5000 },
        ],
      },
    })

    for (const badRate of [undefined, 0, -0.024, Number.NaN, Number.POSITIVE_INFINITY]) {
      // 1. strict 模式直接拋錯
      expect(() =>
        applySettlementRatesToTransactions([krwBaseTx], 'TWD', undefined, 'KRW', badRate, {
          strict: true,
        }),
      ).toThrow(/ERR_SETTLEMENT_RATE_INVALID/)

      // 2. 非 strict 模式透過 onMissingRate 標記所有缺少有效匯率的交易
      const missing: MissingSettlementRateInfo[] = []
      applySettlementRatesToTransactions(
        [krwBaseTx, jpyThirdTx],
        'TWD',
        undefined,
        'KRW',
        badRate,
        {
          onMissingRate: (info) => missing.push(info),
        },
      )
      expect(missing).toEqual([
        {
          transactionId: krwBaseTx.id,
          sourceCurrency: 'KRW',
          projectBaseCurrency: 'KRW',
          settlementCurrency: 'TWD',
        },
        {
          transactionId: jpyThirdTx.id,
          sourceCurrency: 'JPY',
          projectBaseCurrency: 'KRW',
          settlementCurrency: 'TWD',
        },
      ])
    }

    // 3. calculateSettleUp 預設於 anomalies 回報 MISSING_SETTLEMENT_RATE；strictRates=true 則拋錯
    const settle = calculateSettleUp([krwBaseTx, jpyThirdTx], 'TWD', ['alice', 'bob'], {
      projectBaseCurrency: 'KRW',
      baseToSettlementRate: undefined,
    })
    expect(settle.anomalies).toEqual([
      {
        transactionId: krwBaseTx.id,
        code: 'MISSING_SETTLEMENT_RATE',
        diffUnits: 0,
        toleranceUnits: 0,
        diffAmount: 0,
        currency: 'TWD',
        sourceCurrency: 'KRW',
      },
      {
        transactionId: jpyThirdTx.id,
        code: 'MISSING_SETTLEMENT_RATE',
        diffUnits: 0,
        toleranceUnits: 0,
        diffAmount: 0,
        currency: 'TWD',
        sourceCurrency: 'JPY',
      },
    ])

    expect(() =>
      calculateSettleUp([krwBaseTx], 'TWD', ['alice', 'bob'], {
        projectBaseCurrency: 'KRW',
        baseToSettlementRate: 0,
        strictRates: true,
      }),
    ).toThrow(/ERR_SETTLEMENT_RATE_INVALID/)
  })

  it('跨幣結算無 baseToSettlementRate 時，原幣別已等於結帳幣別、已有有效覆寫匯率或已軟刪除交易不應誤報異常', () => {
    const twdTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000020',
      amount: 1000,
      currency: 'TWD',
      exchangeRateToBase: 40,
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 500 },
          { memberId: 'bob', finalAmount: 500 },
        ],
      },
    })
    const jpyOverriddenTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000021',
      amount: 10000,
      currency: 'JPY',
      exchangeRateToBase: 9,
      splitConfig: {
        payerId: 'bob',
        mode: 'equal',
        shares: [
          { memberId: 'alice', finalAmount: 5000 },
          { memberId: 'bob', finalAmount: 5000 },
        ],
      },
    })
    const deletedKrwTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000022',
      amount: 50000,
      currency: 'KRW',
      exchangeRateToBase: 1,
      isDeleted: true,
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [{ memberId: 'alice', finalAmount: 50000 }],
      },
    })

    const missing: MissingSettlementRateInfo[] = []
    const effective = applySettlementRatesToTransactions(
      [twdTx, jpyOverriddenTx, deletedKrwTx],
      'TWD',
      { JPY: 0.21 },
      'KRW',
      undefined,
      {
        strict: true,
        onMissingRate: (info) => missing.push(info),
      },
    )

    expect(missing).toEqual([])
    expect(effective[0].exchangeRateToBase).toBe(1)
    expect(effective[1].exchangeRateToBase).toBe(0.21)

    const settle = calculateSettleUp(
      [twdTx, jpyOverriddenTx, deletedKrwTx],
      'TWD',
      ['alice', 'bob'],
      {
        overrideRatesByCurrency: { JPY: 0.21 },
        projectBaseCurrency: 'KRW',
        baseToSettlementRate: undefined,
        strictRates: true,
      },
    )
    expect(settle.anomalies).toEqual([])
    expect(settle.totalProjectExpense).toBe(3100) // 1000 + 2100
  })

  it('跨幣換算後匯率因極小值四捨五入歸 0 時，亦視為無效匯率並標記或拋錯', () => {
    const tinyTx = createExpenseTx({
      id: '50000000-0000-4000-8000-000000000030',
      amount: 1000,
      currency: 'VND',
      exchangeRateToBase: 0.0001,
      splitConfig: {
        payerId: 'alice',
        mode: 'equal',
        shares: [{ memberId: 'alice', finalAmount: 1000 }],
      },
    })

    const missing: MissingSettlementRateInfo[] = []
    applySettlementRatesToTransactions([tinyTx], 'USD', undefined, 'TWD', 0.0001, {
      onMissingRate: (info) => missing.push(info),
    })
    expect(missing).toHaveLength(1)
    expect(missing[0].sourceCurrency).toBe('VND')

    expect(() =>
      applySettlementRatesToTransactions([tinyTx], 'USD', undefined, 'TWD', 0.0001, {
        strict: true,
      }),
    ).toThrow(/ERR_SETTLEMENT_RATE_INVALID/)
  })
})
