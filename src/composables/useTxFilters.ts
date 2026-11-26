import { computed, ref } from 'vue'
import { matchesDateQuery } from '@/core/ledgerHelpers'
import {
  summarizeMemberTransactions,
  sumTransactionsExpense,
} from '@/core/memberLedger'
import type { ProjectMember, Transaction } from '@/schemas/ledgerSchema'

export interface TxDateGroup {
  date: string
  dateLabel: string
  items: Transaction[]
  projectNetSubtotal: number | null
}

export interface TxFilterCriteria {
  searchQuery: string
  selectedCategoryFilters: readonly string[]
  selectedMemberFilter: string
  selectedProjectFilter: string
  onlyRefunds: boolean
  onlyWithPhotos: boolean
}

export interface TxFilterResolvers {
  getCategoryLabel: (categoryKey: string) => string
  getMemberName: (memberId: string, projectId?: string) => string
  getProjectName: (projectId: string) => string
}

export interface UseTxFiltersOptions extends TxFilterResolvers {
  context: () => 'home' | 'project'
  transactions: () => Transaction[]
  projectBaseCurrency: () => string | undefined
  projectMembers: () => ProjectMember[] | undefined
  myMemberId: () => string | undefined
  collapsibleLimit: () => number
  locale: () => string
  onReset?: () => void
}

/**
 * 判斷指定成員是否參與該筆交易（主墊付人、多人墊付之一或分攤金額大於 0）
 */
export function isMemberInvolvedInTx(
  tx: Transaction,
  memberId: string,
): boolean {
  if (!tx.splitConfig) return false
  if (tx.splitConfig.payerId === memberId) return true
  if (
    tx.splitConfig.payers?.some(
      (p) => p.memberId === memberId && p.amount > 0,
    )
  ) {
    return true
  }
  return tx.splitConfig.shares.some(
    (s) => s.memberId === memberId && s.finalAmount > 0,
  )
}

/**
 * 判斷單筆交易是否符合篩選條件與全文搜尋關鍵字
 */
export function matchesTxFilter(
  tx: Transaction,
  criteria: TxFilterCriteria,
  resolvers: TxFilterResolvers,
): boolean {
  if (
    criteria.selectedProjectFilter !== 'all' &&
    tx.projectId !== criteria.selectedProjectFilter
  ) {
    return false
  }
  if (
    criteria.selectedCategoryFilters.length > 0 &&
    !criteria.selectedCategoryFilters.includes(tx.categoryKey)
  ) {
    return false
  }
  if (
    criteria.selectedMemberFilter !== 'all' &&
    !isMemberInvolvedInTx(tx, criteria.selectedMemberFilter)
  ) {
    return false
  }
  if (criteria.onlyRefunds && tx.type !== 'refund') {
    return false
  }
  if (
    criteria.onlyWithPhotos &&
    (!tx.receiptImages || tx.receiptImages.length === 0)
  ) {
    return false
  }

  const q = criteria.searchQuery.trim().toLowerCase()
  if (!q) return true

  const note = (tx.note ?? '').toLowerCase()
  const catName = resolvers.getCategoryLabel(tx.categoryKey).toLowerCase()
  const timeStr = tx.time.toLowerCase()
  const amountStr = String(tx.amount)
  const qWithoutComma = q.replace(/,/g, '')
  const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
  const convertedBase = tx.amount * rate
  const convertedIntStr = String(Math.round(convertedBase))
  const convertedFixedStr = String(Number(convertedBase.toFixed(2)))
  const currencyStr = tx.currency.toLowerCase()
  const projectName = tx.projectId
    ? resolvers.getProjectName(tx.projectId).toLowerCase()
    : ''
  const payerNames = tx.splitConfig
    ? [
        resolvers.getMemberName(tx.splitConfig.payerId, tx.projectId),
        ...(tx.splitConfig.payers ?? []).map((p) =>
          resolvers.getMemberName(p.memberId, tx.projectId),
        ),
      ]
        .join(' ')
        .toLowerCase()
    : ''
  const shareNames = tx.splitConfig
    ? tx.splitConfig.shares
        .filter((s) => s.finalAmount > 0)
        .map((s) => resolvers.getMemberName(s.memberId, tx.projectId))
        .join(' ')
        .toLowerCase()
    : ''

  return (
    note.includes(q) ||
    catName.includes(q) ||
    matchesDateQuery(tx.date, q) ||
    timeStr.includes(q) ||
    amountStr.includes(qWithoutComma) ||
    convertedIntStr.includes(qWithoutComma) ||
    convertedFixedStr.includes(qWithoutComma) ||
    currencyStr.includes(q) ||
    projectName.includes(q) ||
    payerNames.includes(q) ||
    shareNames.includes(q)
  )
}

/**
 * 依日期由新到舊、時間由新到舊、最後更新時間由新到舊排序（不變異原陣列）
 */
export function sortTransactionsDesc(
  transactions: readonly Transaction[],
): Transaction[] {
  return [...transactions].sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date)
    if (dateCmp !== 0) return dateCmp
    const timeCmp = b.time.localeCompare(a.time)
    if (timeCmp !== 0) return timeCmp
    return b.updatedAt - a.updatedAt
  })
}

/**
 * 格式化日期分組標題（跨年時補上年份）
 */
export function formatTxGroupDateHeading(
  isoDate: string,
  locale: string,
  nowYear = new Date().getFullYear(),
): string {
  const parts = isoDate.split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return isoDate
  }
  try {
    const dt = new Date(parts[0], parts[1] - 1, parts[2])
    const formatted = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    }).format(dt)
    return parts[0] !== nowYear ? `${parts[0]} ${formatted}` : formatted
  } catch {
    return isoDate
  }
}

/**
 * 將已排序之交易依日期分組，並於專案視角計算每日淨消費小計
 */
export function groupTransactionsByDate(
  transactions: readonly Transaction[],
  options: {
    context: 'home' | 'project'
    projectBaseCurrency?: string
    locale: string
    nowYear?: number
  },
): TxDateGroup[] {
  const map = new Map<string, Transaction[]>()
  for (const tx of transactions) {
    const list = map.get(tx.date)
    if (list) list.push(tx)
    else map.set(tx.date, [tx])
  }

  const groups: TxDateGroup[] = []
  for (const [date, items] of map.entries()) {
    const projectNetSubtotal =
      options.context === 'project' && options.projectBaseCurrency
        ? sumTransactionsExpense(items, options.projectBaseCurrency)
        : null

    groups.push({
      date,
      dateLabel: formatTxGroupDateHeading(date, options.locale, options.nowYear),
      items,
      projectNetSubtotal,
    })
  }
  return groups
}

/**
 * 交易明細清單之搜尋、篩選、排序、日期分組與成員小計狀態管理
 */
export function useTxFilters(options: UseTxFiltersOptions) {
  const searchQuery = ref('')
  const selectedCategoryFilters = ref<string[]>([])
  const selectedMemberFilter = ref<string>('all')
  const selectedProjectFilter = ref<string>('all')
  const onlyRefunds = ref(false)
  const onlyWithPhotos = ref(false)
  const filterDrawerOpen = ref(false)
  const homeSearchOpen = ref(false)
  const showAll = ref(false)

  const activeFilterChipCount = computed(() => {
    let count = 0
    if (selectedProjectFilter.value !== 'all') count += 1
    count += selectedCategoryFilters.value.length
    if (selectedMemberFilter.value !== 'all') count += 1
    if (onlyRefunds.value) count += 1
    if (onlyWithPhotos.value) count += 1
    return count
  })

  const hasActiveFilter = computed(
    () =>
      Boolean(searchQuery.value.trim()) ||
      selectedCategoryFilters.value.length > 0 ||
      selectedMemberFilter.value !== 'all' ||
      selectedProjectFilter.value !== 'all' ||
      onlyRefunds.value ||
      onlyWithPhotos.value,
  )

  const orderedFilterMembers = computed<ProjectMember[]>(() => {
    const list = options.projectMembers() ?? []
    const mineId = options.myMemberId()
    if (!mineId) return list
    const mine = list.find((m) => m.id === mineId)
    if (!mine) return list
    return [mine, ...list.filter((m) => m.id !== mineId)]
  })

  const filteredTransactions = computed(() => {
    const criteria: TxFilterCriteria = {
      searchQuery: searchQuery.value,
      selectedCategoryFilters: selectedCategoryFilters.value,
      selectedMemberFilter: selectedMemberFilter.value,
      selectedProjectFilter: selectedProjectFilter.value,
      onlyRefunds: onlyRefunds.value,
      onlyWithPhotos: onlyWithPhotos.value,
    }
    const matched = options
      .transactions()
      .filter((tx) => matchesTxFilter(tx, criteria, options))
    return sortTransactionsDesc(matched)
  })

  const displayedTransactions = computed(() => {
    const limit = options.collapsibleLimit()
    if (!limit || showAll.value) {
      return filteredTransactions.value
    }
    return filteredTransactions.value.slice(0, limit)
  })

  const filteredMemberSummary = computed(() => {
    const baseCurrency = options.projectBaseCurrency()
    if (
      selectedMemberFilter.value === 'all' ||
      options.context() !== 'project' ||
      !baseCurrency
    ) {
      return null
    }
    return summarizeMemberTransactions(
      filteredTransactions.value,
      selectedMemberFilter.value,
      baseCurrency,
    )
  })

  const filteredMemberShareSubtotal = computed<number | null>(
    () => filteredMemberSummary.value?.totalExpense ?? null,
  )

  /** 成員篩選時同步計算該成員於篩選清單內實際墊付小計（方便核對刷卡帳單） */
  const filteredMemberPaidSubtotal = computed<number | null>(
    () => filteredMemberSummary.value?.totalPaid ?? null,
  )

  const groupedTransactions = computed<TxDateGroup[]>(() =>
    groupTransactionsByDate(displayedTransactions.value, {
      context: options.context(),
      projectBaseCurrency: options.projectBaseCurrency(),
      locale: options.locale(),
    }),
  )

  function toggleCategoryFilter(categoryKey: string) {
    if (selectedCategoryFilters.value.includes(categoryKey)) {
      selectedCategoryFilters.value = selectedCategoryFilters.value.filter(
        (key) => key !== categoryKey,
      )
    } else {
      selectedCategoryFilters.value = [
        ...selectedCategoryFilters.value,
        categoryKey,
      ]
    }
  }

  function resetFilters() {
    searchQuery.value = ''
    selectedCategoryFilters.value = []
    selectedMemberFilter.value = 'all'
    selectedProjectFilter.value = 'all'
    onlyRefunds.value = false
    onlyWithPhotos.value = false
    options.onReset?.()
  }

  function setMemberFilter(memberId: string) {
    selectedMemberFilter.value = memberId || 'all'
    if (memberId && memberId !== 'all') {
      filterDrawerOpen.value = false
    }
  }

  return {
    searchQuery,
    selectedCategoryFilters,
    selectedMemberFilter,
    selectedProjectFilter,
    onlyRefunds,
    onlyWithPhotos,
    filterDrawerOpen,
    homeSearchOpen,
    showAll,
    activeFilterChipCount,
    hasActiveFilter,
    orderedFilterMembers,
    filteredTransactions,
    displayedTransactions,
    filteredMemberSummary,
    filteredMemberShareSubtotal,
    filteredMemberPaidSubtotal,
    groupedTransactions,
    toggleCategoryFilter,
    resetFilters,
    setMemberFilter,
  }
}
