<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Camera,
  ChevronDown,
  CopyPlus,
  ExternalLink,
  Pencil,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Wallet,
  X,
} from 'lucide-vue-next'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import { formatCurrencyAmount, fromMinorUnits, toMinorUnits } from '@/core/currency'
import { matchesDateQuery } from '@/core/ledgerHelpers'
import type { ProjectMember, Transaction } from '@/schemas/ledgerSchema'
import CategoryIconBadge from '@/components/CategoryIconBadge.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'
import SwipeableTxRow from '@/components/SwipeableTxRow.vue'

interface Props {
  context: 'home' | 'project'
  transactions: Transaction[]
  title?: string
  emptyText: string
  projectBaseCurrency?: string
  projectMembers?: ProjectMember[]
  myMemberId?: string
  filterProjects?: Array<{ id: string; name: string }>
  collapsibleLimit?: number
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
  projectBaseCurrency: undefined,
  projectMembers: undefined,
  myMemberId: undefined,
  filterProjects: undefined,
  collapsibleLimit: 0,
})

const emit = defineEmits<{
  (e: 'edit', tx: Transaction): void
  (e: 'duplicate', tx: Transaction): void
  (e: 'delete', id: string): void
  (e: 'openProject', projectId: string): void
  (e: 'previewPhotos', payload: { photos: string[]; index: number }): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const searchQuery = ref('')
const selectedCategoryFilters = ref<string[]>([])
const selectedMemberFilter = ref<string>('all')
const selectedProjectFilter = ref<string>('all')
const onlyRefunds = ref(false)
const onlyWithPhotos = ref(false)
const filterDrawerOpen = ref(false)
const homeSearchOpen = ref(false)
const showAll = ref(false)
const expandedTxId = ref<string | null>(null)

const activeFilterChipCount = computed(() => {
  let count = 0
  if (selectedProjectFilter.value !== 'all') count += 1
  count += selectedCategoryFilters.value.length
  if (selectedMemberFilter.value !== 'all') count += 1
  if (onlyRefunds.value) count += 1
  if (onlyWithPhotos.value) count += 1
  return count
})

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

function toggleExpandTx(txId: string) {
  expandedTxId.value = expandedTxId.value === txId ? null : txId
}

function resolveCategoryLabel(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

const orderedFilterMembers = computed<ProjectMember[]>(() => {
  const list = props.projectMembers ?? []
  if (!props.myMemberId) return list
  const mine = list.find((m) => m.id === props.myMemberId)
  if (!mine) return list
  return [mine, ...list.filter((m) => m.id !== props.myMemberId)]
})

const allCategories = computed(() =>
  store.categories.map((cat) => ({
    key: cat.key,
    label: resolveCategoryLabel(cat),
    color: cat.color,
    icon: cat.icon,
  })),
)

function getCategoryLabel(key: string): string {
  const found = store.categories.find((c) => c.key === key)
  if (found) return resolveCategoryLabel(found)
  const translated = t(`categories.${key}`)
  return translated === `categories.${key}` ? key : translated
}

function getCategoryColor(key: string): string {
  return store.categories.find((c) => c.key === key)?.color ?? '#64748b'
}

function getCategoryIcon(key: string): string | undefined {
  return store.categories.find((c) => c.key === key)?.icon
}

function getMemberName(memberId: string, projectId?: string): string {
  const proj = projectId
    ? store.getProjectById(projectId)
    : store.activeProject
  return proj?.members.find((m) => m.id === memberId)?.name ?? memberId
}

function getMemberColor(memberId: string, projectId?: string): string {
  const proj = projectId
    ? store.getProjectById(projectId)
    : store.activeProject
  return proj?.members.find((m) => m.id === memberId)?.avatarColor ?? '#10b981'
}

function getMemberAvatar(memberId: string, projectId?: string): string | undefined {
  const proj = projectId
    ? store.getProjectById(projectId)
    : store.activeProject
  return proj?.members.find((m) => m.id === memberId)?.avatarImage
}

function getPayerIndicatorMembers(
  tx: Transaction,
): Array<{ memberId: string; name: string; color: string; image?: string }> {
  if (!tx.splitConfig) return []
  const multi = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
  const payerIds = multi.length > 1 ? multi.map((p) => p.memberId) : [tx.splitConfig.payerId]
  return payerIds.map((memberId) => ({
    memberId,
    name: getMemberName(memberId, tx.projectId),
    color: getMemberColor(memberId, tx.projectId),
    image: getMemberAvatar(memberId, tx.projectId),
  }))
}

function getSplitIndicatorMembers(
  tx: Transaction,
): Array<{ memberId: string; name: string; color: string; image?: string }> {
  if (tx.type === 'transfer' || !tx.splitConfig) return []
  const activeShares = tx.splitConfig.shares.filter((s) => s.finalAmount > 0)
  if (activeShares.length === 0) return []
  return activeShares.map((s) => ({
    memberId: s.memberId,
    name: getMemberName(s.memberId, tx.projectId),
    color: getMemberColor(s.memberId, tx.projectId),
    image: getMemberAvatar(s.memberId, tx.projectId),
  }))
}

function getSplitIndicatorTooltip(tx: Transaction): string {
  const members = getSplitIndicatorMembers(tx)
  if (members.length === 0) return ''
  return t('project.splitIndicatorTooltip', {
    count: members.length,
    names: members.map((m) => m.name).join('、'),
  })
}

function getPayerBadgeText(tx: Transaction): string {
  if (!tx.splitConfig) return ''
  const multi = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
  if (multi.length > 1) {
    return t('project.multiPayerBadge', { count: multi.length })
  }
  return t('project.paidByLabel', {
    name: getMemberName(tx.splitConfig.payerId, tx.projectId),
  })
}

function getTxPayerBreakdown(
  tx: Transaction,
): Array<{ memberId: string; amount: number }> {
  if (!tx.splitConfig) return []
  const multi = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
  if (multi.length > 1) return multi
  return [{ memberId: tx.splitConfig.payerId, amount: tx.amount }]
}

function getTxShareBreakdown(
  tx: Transaction,
): Array<{ memberId: string; finalAmount: number }> {
  if (!tx.splitConfig) return []
  return tx.splitConfig.shares.filter((s) => s.finalAmount > 0)
}

function isMemberInvolvedInTx(tx: Transaction, memberId: string): boolean {
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

function matchesFilter(tx: Transaction): boolean {
  if (
    selectedProjectFilter.value !== 'all' &&
    tx.projectId !== selectedProjectFilter.value
  ) {
    return false
  }
  if (
    selectedCategoryFilters.value.length > 0 &&
    !selectedCategoryFilters.value.includes(tx.categoryKey)
  ) {
    return false
  }
  if (
    selectedMemberFilter.value !== 'all' &&
    !isMemberInvolvedInTx(tx, selectedMemberFilter.value)
  ) {
    return false
  }
  if (onlyRefunds.value && tx.type !== 'refund') {
    return false
  }
  if (onlyWithPhotos.value && (!tx.receiptImages || tx.receiptImages.length === 0)) {
    return false
  }
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return true

  const note = (tx.note ?? '').toLowerCase()
  const catName = getCategoryLabel(tx.categoryKey).toLowerCase()
  const timeStr = tx.time.toLowerCase()
  const amountStr = String(tx.amount)
  const qWithoutComma = q.replace(/,/g, '')
  const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
  const convertedBase = tx.amount * rate
  const convertedIntStr = String(Math.round(convertedBase))
  const convertedFixedStr = String(Number(convertedBase.toFixed(2)))
  const currencyStr = tx.currency.toLowerCase()
  const projectName = (store.getProjectById(tx.projectId)?.name ?? '').toLowerCase()
  const payerNames = tx.splitConfig
    ? [
        getMemberName(tx.splitConfig.payerId, tx.projectId),
        ...(tx.splitConfig.payers ?? []).map((p) =>
          getMemberName(p.memberId, tx.projectId),
        ),
      ]
        .join(' ')
        .toLowerCase()
    : ''
  const shareNames = tx.splitConfig
    ? tx.splitConfig.shares
        .filter((s) => s.finalAmount > 0)
        .map((s) => getMemberName(s.memberId, tx.projectId))
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

const hasActiveFilter = computed(
  () =>
    Boolean(searchQuery.value.trim()) ||
    selectedCategoryFilters.value.length > 0 ||
    selectedMemberFilter.value !== 'all' ||
    selectedProjectFilter.value !== 'all' ||
    onlyRefunds.value ||
    onlyWithPhotos.value,
)

const filteredMemberShareSubtotal = computed<number | null>(() => {
  if (
    selectedMemberFilter.value === 'all' ||
    props.context !== 'project' ||
    !props.projectBaseCurrency
  ) {
    return null
  }
  const memberId = selectedMemberFilter.value
  let units = 0
  for (const tx of filteredTransactions.value) {
    if (tx.type !== 'expense' && tx.type !== 'refund') continue
    const share = tx.splitConfig?.shares.find((s) => s.memberId === memberId)
    if (!share || share.finalAmount <= 0) continue
    const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
    const sign = tx.type === 'refund' ? -1 : 1
    units += sign * toMinorUnits(share.finalAmount * rate, props.projectBaseCurrency)
  }
  return fromMinorUnits(units, props.projectBaseCurrency)
})

/** 成員篩選時同步計算該成員於篩選清單內實際墊付小計（方便核對刷卡帳單） */
const filteredMemberPaidSubtotal = computed<number | null>(() => {
  if (
    selectedMemberFilter.value === 'all' ||
    props.context !== 'project' ||
    !props.projectBaseCurrency
  ) {
    return null
  }
  const memberId = selectedMemberFilter.value
  let units = 0
  for (const tx of filteredTransactions.value) {
    if (tx.type !== 'expense' && tx.type !== 'refund') continue
    if (!tx.splitConfig) continue
    const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
    const sign = tx.type === 'refund' ? -1 : 1
    const multi = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
    let paidAmt = 0
    if (multi.length > 0) {
      paidAmt = multi.find((p) => p.memberId === memberId)?.amount ?? 0
    } else if (tx.splitConfig.payerId === memberId) {
      paidAmt = tx.amount
    }
    if (paidAmt > 0) {
      units += sign * toMinorUnits(paidAmt * rate, props.projectBaseCurrency)
    }
  }
  return fromMinorUnits(units, props.projectBaseCurrency)
})

const filteredTransactions = computed(() =>
  props.transactions
    .filter(matchesFilter)
    .sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date)
      if (dateCmp !== 0) return dateCmp
      const timeCmp = b.time.localeCompare(a.time)
      if (timeCmp !== 0) return timeCmp
      return b.updatedAt - a.updatedAt
    }),
)

const displayedTransactions = computed(() => {
  if (!props.collapsibleLimit || showAll.value) {
    return filteredTransactions.value
  }
  return filteredTransactions.value.slice(0, props.collapsibleLimit)
})

interface DateGroup {
  date: string
  dateLabel: string
  items: Transaction[]
  projectNetSubtotal: number | null
}

function formatGroupDateHeading(isoDate: string): string {
  const parts = isoDate.split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return isoDate
  }
  try {
    const dt = new Date(parts[0], parts[1] - 1, parts[2])
    const formatted = new Intl.DateTimeFormat(locale.value, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    }).format(dt)
    const nowYear = new Date().getFullYear()
    return parts[0] !== nowYear ? `${parts[0]} ${formatted}` : formatted
  } catch {
    return isoDate
  }
}

const groupedTransactions = computed<DateGroup[]>(() => {
  const map = new Map<string, Transaction[]>()
  for (const tx of displayedTransactions.value) {
    const list = map.get(tx.date)
    if (list) list.push(tx)
    else map.set(tx.date, [tx])
  }

  const groups: DateGroup[] = []
  for (const [date, items] of map.entries()) {
    let projectNetSubtotal: number | null = null
    if (props.context === 'project' && props.projectBaseCurrency) {
      let units = 0
      for (const tx of items) {
        if (tx.type !== 'expense' && tx.type !== 'refund') continue
        const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
        const sign = tx.type === 'refund' ? -1 : 1
        if (tx.splitConfig && tx.splitConfig.shares.length > 0) {
          for (const share of tx.splitConfig.shares) {
            units += sign * toMinorUnits(share.finalAmount * rate, props.projectBaseCurrency)
          }
        } else {
          units += sign * toMinorUnits(tx.amount * rate, props.projectBaseCurrency)
        }
      }
      projectNetSubtotal = fromMinorUnits(units, props.projectBaseCurrency)
    }

    groups.push({
      date,
      dateLabel: formatGroupDateHeading(date),
      items,
      projectNetSubtotal,
    })
  }
  return groups
})

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}

function resetFilters() {
  searchQuery.value = ''
  selectedCategoryFilters.value = []
  selectedMemberFilter.value = 'all'
  selectedProjectFilter.value = 'all'
  onlyRefunds.value = false
  onlyWithPhotos.value = false
  expandedTxId.value = null
}

function setMemberFilter(memberId: string) {
  selectedMemberFilter.value = memberId || 'all'
  if (memberId && memberId !== 'all') {
    filterDrawerOpen.value = false
  }
}

defineExpose({ resetFilters, setMemberFilter })
</script>

<template>
  <section class="space-y-3">
    <!-- 頂部標題與極簡搜尋／篩選列（Apple 錢包風格：不常駐堆疊多排膠囊，點「篩選」才展開條件） -->
    <div v-if="title" class="flex items-center justify-between gap-2 px-1">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {{ title }}
      </h2>
      <button
        v-if="context === 'home' && transactions.length > 0"
        type="button"
        class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition"
        :class="
          homeSearchOpen || hasActiveFilter
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            : 'text-slate-500 hover:bg-black/5 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10'
        "
        @click="homeSearchOpen = !homeSearchOpen"
      >
        <Search class="h-3.5 w-3.5" />
        <span>{{ t('search.filterToggleShort') }}</span>
        <span
          v-if="activeFilterChipCount > 0"
          class="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-bold text-white dark:bg-emerald-500 dark:text-slate-950"
        >
          {{ activeFilterChipCount }}
        </span>
      </button>
    </div>

    <!-- 單行 Apple 圓角搜尋列 ＋ 單一篩選切換按鈕（首頁按需顯示，專案內常駐 1 行清爽呈現） -->
    <div
      v-if="context === 'project' || homeSearchOpen || hasActiveFilter"
      class="space-y-2"
    >
      <div class="flex items-center gap-2">
        <div class="relative min-w-0 flex-1">
          <Search
            class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          />
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('search.placeholder')"
            class="w-full rounded-xl bg-slate-200/70 py-2 pl-9 pr-8 text-xs text-slate-900 placeholder-slate-400 transition focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30 dark:bg-[#1C1C1E] dark:text-white dark:placeholder-slate-500 dark:focus:bg-[#2C2C2E]"
          />
          <button
            v-if="searchQuery"
            type="button"
            :aria-label="t('settings.close')"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full bg-slate-300/80 p-0.5 text-slate-600 hover:bg-slate-400/80 dark:bg-slate-700 dark:text-slate-300"
            @click="searchQuery = ''"
          >
            <X class="h-3 w-3" />
          </button>
        </div>

        <button
          type="button"
          class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition active:scale-95"
          :class="
            filterDrawerOpen || activeFilterChipCount > 0
              ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
              : 'bg-white text-slate-700 shadow-sm hover:bg-slate-50 dark:bg-[#1C1C1E] dark:text-slate-200 dark:hover:bg-[#2C2C2E]'
          "
          @click="filterDrawerOpen = !filterDrawerOpen"
        >
          <SlidersHorizontal class="h-3.5 w-3.5" />
          <span>{{ t('search.filterToggleShort') }}</span>
          <span
            v-if="activeFilterChipCount > 0"
            class="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-white/25 px-1 text-[10px] font-bold"
          >
            {{ activeFilterChipCount }}
          </span>
        </button>
      </div>

      <!-- 按需展開之篩選卡片（專案 / 類別 / 成員 / 退款 / 收據照） -->
      <div
        v-if="filterDrawerOpen"
        class="space-y-3 rounded-2xl bg-white p-3.5 shadow-sm dark:bg-[#1C1C1E]"
      >
        <!-- 首頁專案篩選 -->
        <div
          v-if="context === 'home' && filterProjects && filterProjects.length > 1"
          class="space-y-1.5"
        >
          <div class="text-[11px] font-semibold text-slate-400">
            {{ t('search.allProjects') }}
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button
              type="button"
              class="rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
              :class="
                selectedProjectFilter === 'all'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
              "
              @click="selectedProjectFilter = 'all'"
            >
              {{ t('search.allProjects') }}
            </button>
            <button
              v-for="proj in filterProjects"
              :key="proj.id"
              type="button"
              class="max-w-[150px] truncate rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
              :class="
                selectedProjectFilter === proj.id
                  ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
              "
              @click="
                selectedProjectFilter =
                  selectedProjectFilter === proj.id ? 'all' : proj.id
              "
            >
              {{ proj.name }}
            </button>
          </div>
        </div>

        <!-- 成員快速篩選 -->
        <div
          v-if="context === 'project' && projectMembers && projectMembers.length > 0"
          class="space-y-1.5"
        >
          <div class="text-[11px] font-semibold text-slate-400">
            {{ t('project.membersLabel') }}
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button
              type="button"
              class="rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
              :class="
                selectedMemberFilter === 'all'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
              "
              @click="selectedMemberFilter = 'all'"
            >
              {{ t('search.allMembers') }}
            </button>
            <button
              v-for="m in orderedFilterMembers"
              :key="m.id"
              type="button"
              class="inline-flex items-center gap-1 rounded-full py-0.5 pl-1 pr-2.5 text-[11px] font-semibold transition"
              :class="
                selectedMemberFilter === m.id
                  ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
              "
              @click="
                selectedMemberFilter = selectedMemberFilter === m.id ? 'all' : m.id
              "
            >
              <Wallet v-if="m.isPool" class="ml-0.5 h-3 w-3 shrink-0" />
              <MemberAvatar
                v-else
                :name="m.name"
                :color="m.avatarColor"
                :image="m.avatarImage"
                size="xxs"
                ring
              />
              <span>{{ m.name }}</span>
              <span
                v-if="myMemberId && m.id === myMemberId"
                class="rounded-full bg-emerald-500/20 px-1 text-[9px] font-bold"
                :class="
                  selectedMemberFilter === m.id
                    ? 'bg-white/25 text-white dark:bg-slate-950/20 dark:text-slate-950'
                    : 'text-emerald-700 dark:text-emerald-300'
                "
              >
                {{ t('settle.meBadge') }}
              </span>
            </button>
          </div>
        </div>

        <!-- 類別篩選（支援複選，不提供新增類別功能） -->
        <div class="space-y-1.5">
          <div class="text-[11px] font-semibold text-slate-400">
            {{ t('export.csvCategory') }}
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button
              type="button"
              class="rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
              :class="
                selectedCategoryFilters.length === 0
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
              "
              @click="selectedCategoryFilters = []"
            >
              {{ t('search.allCategories') }}
            </button>
            <button
              v-for="cat in allCategories"
              :key="cat.key"
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-2.5 text-[11px] font-semibold transition"
              :style="
                selectedCategoryFilters.includes(cat.key)
                  ? { backgroundColor: cat.color }
                  : undefined
              "
              :class="
                selectedCategoryFilters.includes(cat.key)
                  ? 'text-white shadow-xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
              "
              @click="toggleCategoryFilter(cat.key)"
            >
              <CategoryIconBadge
                v-if="selectedCategoryFilters.includes(cat.key)"
                :icon="cat.icon"
                :category-key="cat.key"
                size="xs"
                plain
              />
              <CategoryIconBadge
                v-else
                :icon="cat.icon"
                :category-key="cat.key"
                :color="cat.color"
                size="xs"
              />
              <span>{{ cat.label }}</span>
            </button>
          </div>
        </div>

        <!-- 快捷條件＋重設 -->
        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 dark:border-white/10">
          <div class="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
              :class="
                onlyRefunds
                  ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
              "
              @click="onlyRefunds = !onlyRefunds"
            >
              <RotateCcw class="h-3 w-3 shrink-0" />
              <span>{{ t('search.filterRefundsOnly') }}</span>
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
              :class="
                onlyWithPhotos
                  ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
              "
              @click="onlyWithPhotos = !onlyWithPhotos"
            >
              <Camera class="h-3 w-3 shrink-0" />
              <span>{{ t('search.filterWithPhotosOnly') }}</span>
            </button>
          </div>

          <button
            v-if="hasActiveFilter"
            type="button"
            class="text-xs font-semibold text-rose-500 hover:underline"
            @click="resetFilters"
          >
            {{ t('search.clearFiltersButton') }}
          </button>
        </div>
      </div>

      <!-- 已啟用篩選時的一行精簡結果摘要條（含成員分攤與墊付小計） -->
      <div
        v-if="hasActiveFilter"
        class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/80 px-3 py-2 text-[11px] shadow-sm dark:bg-[#1C1C1E]"
      >
        <div class="flex flex-wrap items-center gap-1.5 font-medium text-slate-600 dark:text-slate-300">
          <span
            v-if="selectedMemberFilter !== 'all'"
            class="rounded-full bg-emerald-500/15 px-2 py-0.5 font-bold text-emerald-700 dark:text-emerald-300"
          >
            {{ getMemberName(selectedMemberFilter) }}
          </span>
          <span>{{ t('search.filteredCount', { count: filteredTransactions.length }) }}</span>
          <template
            v-if="filteredMemberShareSubtotal !== null && projectBaseCurrency"
          >
            ·
            <span class="font-semibold text-slate-900 dark:text-white">{{
              t('search.memberShareTotal', {
                amount: fmt(filteredMemberShareSubtotal, projectBaseCurrency),
              })
            }}</span>
          </template>
          <template
            v-if="filteredMemberPaidSubtotal !== null && projectBaseCurrency"
          >
            ·
            <span class="font-semibold text-emerald-700 dark:text-emerald-400">{{
              t('search.memberPaidTotal', {
                amount: fmt(filteredMemberPaidSubtotal, projectBaseCurrency),
              })
            }}</span>
          </template>
        </div>
        <button
          type="button"
          class="shrink-0 font-semibold text-slate-400 hover:text-rose-500"
          @click="resetFilters"
        >
          {{ t('search.clearFiltersButton') }}
        </button>
      </div>
    </div>

    <!-- 空狀態 -->
    <div
      v-if="filteredTransactions.length === 0"
      class="rounded-2xl bg-white py-10 text-center text-xs text-slate-400 shadow-sm dark:bg-[#1C1C1E] dark:text-slate-500"
    >
      {{ hasActiveFilter ? t('search.noMatches') : emptyText }}
    </div>

    <!-- Apple 錢包風格：無框日期標題 ＋ 純白圓角 Inset Grouped 清單（無斑馬紋） -->
    <div v-else class="space-y-4">
      <div v-for="group in groupedTransactions" :key="group.date" class="space-y-1.5">
        <div class="flex items-baseline justify-between px-1.5 text-xs">
          <span class="font-semibold text-slate-500 dark:text-slate-400">
            {{ group.dateLabel }}
          </span>
          <span
            v-if="group.projectNetSubtotal !== null && projectBaseCurrency"
            class="text-[11px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
          >
            {{ fmt(group.projectNetSubtotal, projectBaseCurrency) }}
          </span>
          <span v-else class="text-[11px] text-slate-400 dark:text-slate-500">
            {{ t('stats.entryCount', { count: group.items.length }) }}
          </span>
        </div>

        <ul class="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-sm dark:divide-white/10 dark:bg-[#1C1C1E]">
          <li v-for="tx in group.items" :key="tx.id">
            <SwipeableTxRow
              @edit="emit('edit', tx)"
              @delete="emit('delete', tx.id)"
            >
              <!-- 收合狀態極簡交易列（點擊展開詳情） -->
              <div
                class="cursor-pointer bg-white px-3.5 py-3 transition active:bg-slate-50 dark:bg-[#1C1C1E] dark:active:bg-[#2C2C2E]"
                @click="toggleExpandTx(tx.id)"
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-3">
                    <!-- 左側：收據縮圖或柔和分類圓形圖標 -->
                    <button
                      v-if="tx.receiptImages && tx.receiptImages.length > 0"
                      type="button"
                      class="relative h-10 w-10 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-[#2C2C2E]"
                      @click.stop="
                        emit('previewPhotos', {
                          photos: tx.receiptImages,
                          index: 0,
                        })
                      "
                    >
                      <img
                        :src="tx.receiptImages[0]"
                        alt="receipt"
                        class="h-full w-full object-cover"
                      />
                      <span
                        v-if="tx.receiptImages.length > 1"
                        class="absolute bottom-0 right-0 rounded-tl-md bg-black/70 px-1 text-[9px] font-bold text-white"
                      >
                        +{{ tx.receiptImages.length - 1 }}
                      </span>
                    </button>
                    <CategoryIconBadge
                      v-else
                      :icon="getCategoryIcon(tx.categoryKey)"
                      :category-key="tx.categoryKey"
                      :color="getCategoryColor(tx.categoryKey)"
                      size="lg"
                    />

                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span class="truncate text-[14px] font-semibold text-slate-900 dark:text-white">
                          {{ tx.note || getCategoryLabel(tx.categoryKey) }}
                        </span>
                        <span
                          v-if="tx.type === 'refund'"
                          class="shrink-0 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
                        >
                          {{ t('project.refundBadge') }}
                        </span>
                        <span
                          v-else-if="tx.type === 'transfer'"
                          class="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-[#2C2C2E] dark:text-slate-300"
                        >
                          {{ t('home.settlementBadge') }}
                        </span>
                      </div>

                      <!-- 單行清爽副標（所屬專案 ＋ 墊付者小圈圈與名稱 · 時間 · 外幣折合） -->
                      <div class="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-400 dark:text-slate-500">
                        <button
                          v-if="context === 'home' && tx.projectId && store.getProjectById(tx.projectId)"
                          type="button"
                          class="max-w-[96px] shrink-0 truncate font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                          @click.stop="emit('openProject', tx.projectId)"
                        >
                          {{ store.getProjectById(tx.projectId)?.name }}
                        </button>
                        <span
                          v-if="tx.splitConfig"
                          class="inline-flex min-w-0 items-center gap-1 truncate"
                        >
                          <span class="inline-flex shrink-0 items-center -space-x-1">
                            <MemberAvatar
                              v-for="pm in getPayerIndicatorMembers(tx).slice(0, 3)"
                              :key="pm.memberId"
                              :name="pm.name"
                              :color="pm.color"
                              :image="pm.image"
                              size="micro"
                              ring
                            />
                          </span>
                          <span class="truncate">{{ getPayerBadgeText(tx) }}</span>
                        </span>
                        <span v-else-if="context !== 'home'">{{ getCategoryLabel(tx.categoryKey) }}</span>
                        <span v-if="tx.time !== '00:00'" class="shrink-0">· {{ tx.time }}</span>
                        <span
                          v-if="
                            context === 'project' &&
                            projectBaseCurrency &&
                            tx.currency !== projectBaseCurrency
                          "
                          class="shrink-0 tabular-nums"
                        >
                          · {{
                            t('project.convertedPreview', {
                              amount: `${tx.type === 'refund' ? '-' : ''}${fmt(
                                tx.amount * tx.exchangeRateToBase,
                                projectBaseCurrency,
                              )}`,
                            })
                          }}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div class="flex shrink-0 items-center gap-1.5">
                    <div class="flex flex-col items-end">
                      <span
                        class="text-[15px] font-semibold tabular-nums leading-tight"
                        :class="
                          tx.type === 'income' || tx.type === 'refund'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-slate-900 dark:text-white'
                        "
                      >
                        {{
                          tx.type === 'income'
                            ? '+'
                            : tx.type === 'refund'
                              ? '-'
                              : ''
                        }}{{ fmt(tx.amount, tx.currency) }}
                      </span>
                      <!-- 金額下方精巧分攤成員小圈圈（首頁與專案明細皆顯示） -->
                      <div
                        v-if="getSplitIndicatorMembers(tx).length > 0"
                        :title="getSplitIndicatorTooltip(tx)"
                        class="mt-1 flex items-center justify-end"
                      >
                        <div class="flex items-center -space-x-1">
                          <MemberAvatar
                            v-for="m in getSplitIndicatorMembers(tx).slice(0, 4)"
                            :key="m.memberId"
                            :name="m.name"
                            :color="m.color"
                            :image="m.image"
                            size="micro"
                            ring
                          />
                          <span
                            v-if="getSplitIndicatorMembers(tx).length > 4"
                            class="inline-flex h-3 min-w-[12px] items-center justify-center rounded-full bg-slate-200 px-1 text-[7px] font-bold text-slate-600 ring-1 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-[#1C1C1E]"
                          >
                            +{{ getSplitIndicatorMembers(tx).length - 4 }}
                          </span>
                        </div>
                      </div>
                    </div>
                    <ChevronDown
                      class="h-3.5 w-3.5 text-slate-300 transition-transform dark:text-slate-600"
                      :class="expandedTxId === tx.id ? 'rotate-180 text-emerald-600 dark:text-emerald-400' : ''"
                    />
                  </div>
                </div>

                <!-- 展開之帳目詳情面板（誰墊付、誰分攤多少、匯率、收據與快捷操作） -->
                <div
                  v-if="expandedTxId === tx.id"
                  class="mt-3 space-y-2.5 rounded-xl bg-[#F2F2F7]/90 p-3 text-xs dark:bg-[#2C2C2E]"
                  @click.stop
                >
                  <!-- 墊付明細 -->
                  <div v-if="getTxPayerBreakdown(tx).length > 0" class="space-y-1">
                    <div class="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {{ t('split.payerLabel') }}
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      <span
                        v-for="payer in getTxPayerBreakdown(tx)"
                        :key="payer.memberId"
                        class="inline-flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 dark:bg-[#1C1C1E] dark:text-slate-200"
                      >
                        <MemberAvatar
                          :name="getMemberName(payer.memberId, tx.projectId)"
                          :color="getMemberColor(payer.memberId, tx.projectId)"
                          :image="getMemberAvatar(payer.memberId, tx.projectId)"
                          size="xs"
                        />
                        <span>{{ getMemberName(payer.memberId, tx.projectId) }}</span>
                        <span class="tabular-nums font-bold text-emerald-600 dark:text-emerald-400">
                          {{ fmt(payer.amount, tx.currency) }}
                        </span>
                      </span>
                    </div>
                  </div>

                  <!-- 分攤明細 -->
                  <div v-if="getTxShareBreakdown(tx).length > 0" class="space-y-1">
                    <div class="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {{ t('project.splitBreakdownLabel') }}
                    </div>
                    <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      <div
                        v-for="share in getTxShareBreakdown(tx)"
                        :key="share.memberId"
                        class="flex items-center justify-between gap-1.5 rounded-lg bg-white px-2 py-1 text-[11px] dark:bg-[#1C1C1E]"
                      >
                        <span class="flex min-w-0 items-center gap-1.5">
                          <MemberAvatar
                            :name="getMemberName(share.memberId, tx.projectId)"
                            :color="getMemberColor(share.memberId, tx.projectId)"
                            :image="getMemberAvatar(share.memberId, tx.projectId)"
                            size="xs"
                          />
                          <span class="truncate font-medium text-slate-700 dark:text-slate-200">
                            {{ getMemberName(share.memberId, tx.projectId) }}
                          </span>
                        </span>
                        <span class="shrink-0 tabular-nums font-bold text-slate-900 dark:text-white">
                          {{ fmt(share.finalAmount, tx.currency) }}
                        </span>
                      </div>
                    </div>
                  </div>

                  <!-- 跨幣別匯率說明 -->
                  <div
                    v-if="projectBaseCurrency && tx.currency !== projectBaseCurrency"
                    class="text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    {{ t('project.exchangeRateLabel', { from: tx.currency }) }}
                    <strong class="tabular-nums text-slate-700 dark:text-slate-200">{{ tx.exchangeRateToBase }}</strong>
                    {{ projectBaseCurrency }}
                  </div>

                  <!-- 全部收據縮圖 -->
                  <div
                    v-if="tx.receiptImages && tx.receiptImages.length > 0"
                    class="flex flex-wrap gap-2 pt-0.5"
                  >
                    <button
                      v-for="(img, imgIdx) in tx.receiptImages"
                      :key="imgIdx"
                      type="button"
                      class="h-14 w-14 overflow-hidden rounded-xl bg-white dark:bg-[#1C1C1E]"
                      @click="
                        emit('previewPhotos', {
                          photos: tx.receiptImages!,
                          index: imgIdx,
                        })
                      "
                    >
                      <img
                        :src="img"
                        alt="receipt"
                        class="h-full w-full object-cover"
                      />
                    </button>
                  </div>

                  <!-- 外部訂單／地圖連結 -->
                  <div
                    v-if="tx.links && tx.links.length > 0"
                    class="flex flex-wrap gap-1.5"
                  >
                    <a
                      v-for="(url, uIdx) in tx.links"
                      :key="uIdx"
                      :href="url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-emerald-600 hover:underline dark:bg-[#1C1C1E] dark:text-emerald-400"
                    >
                      <ExternalLink class="h-3 w-3" />
                      <span class="max-w-[180px] truncate">{{ url }}</span>
                    </a>
                  </div>

                  <!-- 詳情列底部：編輯者標記 ＋ 快捷操作按鈕 -->
                  <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/70 pt-2 dark:border-white/10">
                    <span
                      v-if="tx.lastEditedBy"
                      class="text-[10px] font-medium text-slate-400"
                    >
                      {{ t('project.lastEditedByLabel', { name: tx.lastEditedBy }) }}
                    </span>
                    <span v-else />
                    <div class="flex items-center gap-1.5">
                      <button
                        v-if="tx.type !== 'transfer'"
                        type="button"
                        class="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:text-emerald-600 dark:bg-[#1C1C1E] dark:text-slate-300"
                        @click="emit('duplicate', tx)"
                      >
                        <CopyPlus class="h-3 w-3" />
                        <span>{{ t('home.duplicateTx') }}</span>
                      </button>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:text-emerald-600 dark:bg-[#1C1C1E] dark:text-slate-200"
                        @click="emit('edit', tx)"
                      >
                        <Pencil class="h-3 w-3" />
                        <span>{{ t('home.editTx') }}</span>
                      </button>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-semibold text-rose-500 transition hover:bg-rose-50 dark:bg-[#1C1C1E] dark:text-rose-400"
                        @click="emit('delete', tx.id)"
                      >
                        <Trash2 class="h-3 w-3" />
                        <span>{{ t('home.deleteTx') }}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </SwipeableTxRow>
          </li>
        </ul>
      </div>
    </div>

    <div
      v-if="collapsibleLimit && filteredTransactions.length > collapsibleLimit"
      class="pt-1 text-center"
    >
      <button
        type="button"
        class="text-xs font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
        @click="showAll = !showAll"
      >
        {{
          showAll
            ? t('home.showLess')
            : t('home.showAll', { count: filteredTransactions.length })
        }}
      </button>
    </div>
  </section>
</template>
