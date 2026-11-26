import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  formatTxGroupDateHeading,
  groupTransactionsByDate,
  isMemberInvolvedInTx,
  matchesTxFilter,
  sortTransactionsDesc,
  useTxFilters,
  type TxFilterCriteria,
  type TxFilterResolvers,
} from '@/composables/useTxFilters'
import type { ProjectMember, Transaction } from '@/schemas/ledgerSchema'

const defaultResolvers: TxFilterResolvers = {
  getCategoryLabel: (key) =>
    ({ cat_food: '餐飲', cat_transport: '交通' })[key] ?? key,
  getMemberName: (id) =>
    ({ m_alice: 'Alice', m_bob: 'Bob', m_charlie: 'Charlie' })[id] ?? id,
  getProjectName: (id) =>
    ({ proj_1: '東京行', proj_2: '大阪行' })[id] ?? '',
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx_1',
    schemaVersion: 1,
    projectId: 'proj_1',
    vaultLevel: 'normal',
    type: 'expense',
    amount: 1000,
    currency: 'JPY',
    exchangeRateToBase: 0.22,
    categoryKey: 'cat_food',
    date: '2026-11-26',
    time: '12:00',
    note: '一蘭拉麵',
    updatedAt: 1700000000000,
    splitConfig: {
      payerId: 'm_alice',
      mode: 'equal',
      shares: [
        { memberId: 'm_alice', finalAmount: 500 },
        { memberId: 'm_bob', finalAmount: 500 },
      ],
    },
    ...overrides,
  }
}

function makeCriteria(
  overrides: Partial<TxFilterCriteria> = {},
): TxFilterCriteria {
  return {
    searchQuery: '',
    selectedCategoryFilters: [],
    selectedMemberFilter: 'all',
    selectedProjectFilter: 'all',
    onlyRefunds: false,
    onlyWithPhotos: false,
    ...overrides,
  }
}

describe('useTxFilters 純函式與 composable', () => {
  it('isMemberInvolvedInTx 支援主墊付、多人墊付與分攤成員判定', () => {
    const tx = makeTx({
      splitConfig: {
        payerId: 'm_alice',
        payers: [
          { memberId: 'm_alice', amount: 600 },
          { memberId: 'm_charlie', amount: 400 },
        ],
        mode: 'equal',
        shares: [
          { memberId: 'm_alice', finalAmount: 0 },
          { memberId: 'm_bob', finalAmount: 1000 },
        ],
      },
    })
    expect(isMemberInvolvedInTx(tx, 'm_alice')).toBe(true)
    expect(isMemberInvolvedInTx(tx, 'm_charlie')).toBe(true)
    expect(isMemberInvolvedInTx(tx, 'm_bob')).toBe(true)
    expect(isMemberInvolvedInTx(tx, 'm_other')).toBe(false)
  })

  it('matchesTxFilter 支援專案、分類複選、成員、退款、收據與關鍵字（含折合金額與專案/成員名）', () => {
    const tx = makeTx({
      amount: 1000,
      exchangeRateToBase: 0.22, // 折合 220
      receiptImages: ['data:image/jpeg;base64,abc'],
    })

    expect(matchesTxFilter(tx, makeCriteria(), defaultResolvers)).toBe(true)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ selectedProjectFilter: 'proj_2' }),
        defaultResolvers,
      ),
    ).toBe(false)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ selectedCategoryFilters: ['cat_transport'] }),
        defaultResolvers,
      ),
    ).toBe(false)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ selectedCategoryFilters: ['cat_food', 'cat_transport'] }),
        defaultResolvers,
      ),
    ).toBe(true)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ onlyRefunds: true }),
        defaultResolvers,
      ),
    ).toBe(false)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ onlyWithPhotos: true }),
        defaultResolvers,
      ),
    ).toBe(true)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ searchQuery: '220' }),
        defaultResolvers,
      ),
    ).toBe(true)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ searchQuery: '東京' }),
        defaultResolvers,
      ),
    ).toBe(true)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ searchQuery: 'bob' }),
        defaultResolvers,
      ),
    ).toBe(true)
    expect(
      matchesTxFilter(
        tx,
        makeCriteria({ searchQuery: '1,000' }),
        defaultResolvers,
      ),
    ).toBe(true)
  })

  it('sortTransactionsDesc 依 date、time、updatedAt 由新到舊排序且不變異原陣列', () => {
    const list = [
      makeTx({ id: 'a', date: '2026-11-25', time: '18:00', updatedAt: 100 }),
      makeTx({ id: 'b', date: '2026-11-26', time: '09:00', updatedAt: 100 }),
      makeTx({ id: 'c', date: '2026-11-26', time: '09:00', updatedAt: 200 }),
      makeTx({ id: 'd', date: '2026-11-26', time: '14:00', updatedAt: 50 }),
    ]
    const sorted = sortTransactionsDesc(list)
    expect(sorted.map((t) => t.id)).toEqual(['d', 'c', 'b', 'a'])
    expect(list.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('groupTransactionsByDate 於專案視角計算每日淨消費小計，於首頁視角回傳 null', () => {
    const txs = [
      makeTx({ id: '1', date: '2026-11-26', amount: 1000, exchangeRateToBase: 0.2 }),
      makeTx({
        id: '2',
        date: '2026-11-26',
        type: 'refund',
        amount: 200,
        exchangeRateToBase: 0.2,
        splitConfig: {
          payerId: 'm_alice',
          mode: 'equal',
          shares: [
            { memberId: 'm_alice', finalAmount: 100 },
            { memberId: 'm_bob', finalAmount: 100 },
          ],
        },
      }),
    ]
    const projectGroups = groupTransactionsByDate(txs, {
      context: 'project',
      projectBaseCurrency: 'TWD',
      locale: 'zh-TW',
      nowYear: 2026,
    })
    expect(projectGroups).toHaveLength(1)
    expect(projectGroups[0].projectNetSubtotal).toBe(160)

    const homeGroups = groupTransactionsByDate(txs, {
      context: 'home',
      locale: 'zh-TW',
      nowYear: 2026,
    })
    expect(homeGroups[0].projectNetSubtotal).toBeNull()
  })

  it('formatTxGroupDateHeading 跨年時加上年份，非合法日期原樣回傳', () => {
    expect(formatTxGroupDateHeading('2025-11-26', 'zh-TW', 2026)).toContain(
      '2025',
    )
    expect(formatTxGroupDateHeading('invalid', 'zh-TW', 2026)).toBe('invalid')
  })

  it('useTxFilters 整合狀態、成員置頂排序、分攤／墊付小計、折疊截斷與 resetFilters', () => {
    const members: ProjectMember[] = [
      { id: 'm_alice', name: 'Alice', avatarColor: '#111' },
      { id: 'm_bob', name: 'Bob', avatarColor: '#222' },
    ]
    const transactions = ref<Transaction[]>([
      makeTx({ id: 'tx_1', date: '2026-11-26', amount: 1000, exchangeRateToBase: 1, currency: 'TWD' }),
      makeTx({
        id: 'tx_2',
        date: '2026-11-25',
        amount: 600,
        exchangeRateToBase: 1,
        currency: 'TWD',
        categoryKey: 'cat_transport',
        splitConfig: {
          payerId: 'm_alice',
          mode: 'equal',
          shares: [
            { memberId: 'm_alice', finalAmount: 300 },
            { memberId: 'm_bob', finalAmount: 300 },
          ],
        },
      }),
    ])
    const onReset = vi.fn()

    const filters = useTxFilters({
      context: () => 'project',
      transactions: () => transactions.value,
      projectBaseCurrency: () => 'TWD',
      projectMembers: () => members,
      myMemberId: () => 'm_bob',
      collapsibleLimit: () => 1,
      locale: () => 'zh-TW',
      ...defaultResolvers,
      onReset,
    })

    // myMemberId 排第一
    expect(filters.orderedFilterMembers.value.map((m) => m.id)).toEqual([
      'm_bob',
      'm_alice',
    ])
    // 預設折疊 1 筆
    expect(filters.displayedTransactions.value).toHaveLength(1)
    filters.showAll.value = true
    expect(filters.displayedTransactions.value).toHaveLength(2)

    // 成員篩選同步計算分攤與墊付小計
    filters.filterDrawerOpen.value = true
    filters.setMemberFilter('m_alice')
    expect(filters.filterDrawerOpen.value).toBe(false)
    expect(filters.activeFilterChipCount.value).toBe(1)
    expect(filters.filteredMemberShareSubtotal.value).toBe(800)
    expect(filters.filteredMemberPaidSubtotal.value).toBe(1600)

    // 切換分類與重設
    filters.toggleCategoryFilter('cat_food')
    expect(filters.filteredTransactions.value).toHaveLength(1)
    filters.resetFilters()
    expect(filters.hasActiveFilter.value).toBe(false)
    expect(filters.selectedMemberFilter.value).toBe('all')
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
