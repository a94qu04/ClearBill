import { describe, expect, it } from 'vitest'
import {
  findPotentialDuplicateTransaction,
  isPotentialDuplicateTransaction,
  type DuplicateTxCandidate,
} from '@/core/duplicateDetector'
import type { Transaction } from '@/schemas/ledgerSchema'

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx_1',
    schemaVersion: 1,
    projectId: 'proj_1',
    vaultLevel: 'normal',
    type: 'expense',
    amount: 1200,
    currency: 'JPY',
    exchangeRateToBase: 0.21,
    categoryKey: 'cat_food',
    date: '2026-11-26',
    time: '12:30',
    note: '一蘭拉麵',
    updatedAt: 1700000000000,
    ...overrides,
  }
}

function makeCandidate(
  overrides: Partial<DuplicateTxCandidate> = {},
): DuplicateTxCandidate {
  return {
    projectId: 'proj_1',
    type: 'expense',
    amount: 1200,
    currency: 'JPY',
    categoryKey: 'cat_food',
    date: '2026-11-26',
    note: '一蘭拉麵',
    ...overrides,
  }
}

describe('duplicateDetector', () => {
  it('同專案、同類型、同日、同幣別、同金額且同備註時判定為疑似重複', () => {
    const existing = makeTx()
    const incoming = makeCandidate()
    expect(isPotentialDuplicateTransaction(existing, incoming)).toBe(true)
    expect(findPotentialDuplicateTransaction([existing], incoming)).toBe(existing)
  })

  it('幣別與備註比對忽略大小寫與前後空白，金額在容差內亦命中', () => {
    const existing = makeTx({
      currency: ' jpy ',
      note: '  Ichiran Ramen ',
      amount: 1200,
    })
    const incoming = makeCandidate({
      currency: 'JPY',
      note: 'ichiran ramen',
      amount: 1200.004,
    })
    expect(isPotentialDuplicateTransaction(existing, incoming)).toBe(true)
  })

  it('金額差距達容差門檻（>= 0.005）時不判定為重複', () => {
    const existing = makeTx({ amount: 1200 })
    const incoming = makeCandidate({ amount: 1200.005 })
    expect(isPotentialDuplicateTransaction(existing, incoming)).toBe(false)
  })

  it('兩筆皆有填寫不同備註時不誤報重複', () => {
    const existing = makeTx({ note: '午餐拉麵' })
    const incoming = makeCandidate({ note: '晚餐拉麵' })
    expect(isPotentialDuplicateTransaction(existing, incoming)).toBe(false)
  })

  it('僅一方有備註而另一方為空時仍視為疑似重複（防協作漏填備註）', () => {
    const existingWithNote = makeTx({ note: '一蘭拉麵' })
    const incomingEmptyNote = makeCandidate({ note: '   ' })
    expect(
      isPotentialDuplicateTransaction(existingWithNote, incomingEmptyNote),
    ).toBe(true)

    const existingEmptyNote = makeTx({ note: '' })
    const incomingWithNote = makeCandidate({ note: '一蘭拉麵' })
    expect(
      isPotentialDuplicateTransaction(existingEmptyNote, incomingWithNote),
    ).toBe(true)
  })

  it('兩筆皆無備註時：同分類命中、不同分類不誤報', () => {
    const existing = makeTx({ note: '', categoryKey: 'cat_food' })
    expect(
      isPotentialDuplicateTransaction(
        existing,
        makeCandidate({ note: '', categoryKey: 'cat_food' }),
      ),
    ).toBe(true)
    expect(
      isPotentialDuplicateTransaction(
        existing,
        makeCandidate({ note: '', categoryKey: 'cat_transport' }),
      ),
    ).toBe(false)
  })

  it('專案、類型、日期或幣別不同時不命中', () => {
    const existing = makeTx()
    expect(
      isPotentialDuplicateTransaction(
        existing,
        makeCandidate({ projectId: 'proj_2' }),
      ),
    ).toBe(false)
    expect(
      isPotentialDuplicateTransaction(
        existing,
        makeCandidate({ type: 'refund' }),
      ),
    ).toBe(false)
    expect(
      isPotentialDuplicateTransaction(
        existing,
        makeCandidate({ date: '2026-11-27' }),
      ),
    ).toBe(false)
    expect(
      isPotentialDuplicateTransaction(
        existing,
        makeCandidate({ currency: 'TWD' }),
      ),
    ).toBe(false)
  })

  it('忽略已軟刪除帳目與 excludeTransactionId 指定之自身帳目', () => {
    const deletedTx = makeTx({ id: 'tx_del', isDeleted: true })
    const activeTx = makeTx({ id: 'tx_self' })

    expect(
      findPotentialDuplicateTransaction([deletedTx], makeCandidate()),
    ).toBeNull()
    expect(
      findPotentialDuplicateTransaction([deletedTx, activeTx], makeCandidate(), {
        excludeTransactionId: 'tx_self',
      }),
    ).toBeNull()
  })
})
