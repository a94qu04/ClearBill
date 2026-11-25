<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChevronDown,
  CopyPlus,
  ExternalLink,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wallet,
  X,
} from 'lucide-vue-next'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import { formatCurrencyAmount, fromMinorUnits, toMinorUnits } from '@/core/currency'
import { matchesDateQuery } from '@/core/ledgerHelpers'
import type { ProjectMember, Transaction } from '@/schemas/ledgerSchema'
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
const selectedCategoryFilter = ref<string>('all')
const selectedMemberFilter = ref<string>('all')
const selectedProjectFilter = ref<string>('all')
const showAll = ref(false)
const inlineNewCategoryOpen = ref(false)
const inlineNewCategoryName = ref('')
const expandedTxId = ref<string | null>(null)

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

function getPayerColors(tx: Transaction): string[] {
  if (!tx.splitConfig) return []
  const multi = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
  if (multi.length > 1) {
    return multi.map((p) => getMemberColor(p.memberId, tx.projectId))
  }
  return [getMemberColor(tx.splitConfig.payerId, tx.projectId)]
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
    selectedCategoryFilter.value !== 'all' &&
    tx.categoryKey !== selectedCategoryFilter.value
  ) {
    return false
  }
  if (
    selectedMemberFilter.value !== 'all' &&
    !isMemberInvolvedInTx(tx, selectedMemberFilter.value)
  ) {
    return false
  }
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return true

  const note = (tx.note ?? '').toLowerCase()
  const catName = getCategoryLabel(tx.categoryKey).toLowerCase()
  const timeStr = tx.time.toLowerCase()
  const amountStr = String(tx.amount)
  const qWithoutComma = q.replace(/,/g, '')
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
    currencyStr.includes(q) ||
    projectName.includes(q) ||
    payerNames.includes(q) ||
    shareNames.includes(q)
  )
}

const hasActiveFilter = computed(
  () =>
    Boolean(searchQuery.value.trim()) ||
    selectedCategoryFilter.value !== 'all' ||
    selectedMemberFilter.value !== 'all' ||
    selectedProjectFilter.value !== 'all',
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

function confirmInlineAddCategory() {
  const trimmed = inlineNewCategoryName.value.trim()
  if (!trimmed) return
  const created = store.addCategory(trimmed)
  selectedCategoryFilter.value = created.key
  inlineNewCategoryName.value = ''
  inlineNewCategoryOpen.value = false
  emit('toast', t('settings.categoryAddedToast'))
}

function resetFilters() {
  searchQuery.value = ''
  selectedCategoryFilter.value = 'all'
  selectedMemberFilter.value = 'all'
  selectedProjectFilter.value = 'all'
  inlineNewCategoryOpen.value = false
  expandedTxId.value = null
}

function setMemberFilter(memberId: string) {
  selectedMemberFilter.value = memberId || 'all'
}

defineExpose({ resetFilters, setMemberFilter })
</script>

<template>
  <section
    class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
  >
    <div v-if="title" class="mb-3 flex items-center justify-between gap-2">
      <h2 class="text-xs font-bold text-slate-700 dark:text-slate-200">
        {{ title }}
      </h2>
    </div>

    <!-- 帳目搜尋框（支援 "-" 與 "/" 萬用日期及千分位金額搜尋） -->
    <div class="relative mb-2.5">
      <Search
        class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
      />
      <input
        v-model="searchQuery"
        type="text"
        :placeholder="t('search.placeholder')"
        class="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-8 pr-8 text-xs text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
      />
      <button
        v-if="searchQuery"
        type="button"
        class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
        @click="searchQuery = ''"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>

    <!-- 首頁近期帳目：專案快速篩選膠囊列（單行橫向滑動，節省手機垂直高度） -->
    <div
      v-if="context === 'home' && filterProjects && filterProjects.length > 1"
      class="no-scrollbar mb-2 flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5"
    >
      <button
        type="button"
        class="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
        :class="
          selectedProjectFilter === 'all'
            ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
        "
        @click="selectedProjectFilter = 'all'"
      >
        {{ t('search.allProjects') }}
      </button>
      <button
        v-for="proj in filterProjects"
        :key="proj.id"
        type="button"
        class="max-w-[140px] shrink-0 truncate whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
        :class="
          selectedProjectFilter === proj.id
            ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
        "
        @click="
          selectedProjectFilter =
            selectedProjectFilter === proj.id ? 'all' : proj.id
        "
      >
        {{ proj.name }}
      </button>
    </div>

    <!-- 費用類別篩選膠囊列＋現場新增類別（單行橫向滑動，手機不換行佔高度） -->
    <div class="no-scrollbar mb-2.5 flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5">
      <button
        type="button"
        class="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
        :class="
          selectedCategoryFilter === 'all'
            ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
        "
        @click="selectedCategoryFilter = 'all'"
      >
        {{ t('search.allCategories') }}
      </button>
      <button
        v-for="cat in allCategories"
        :key="cat.key"
        type="button"
        class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
        :class="
          selectedCategoryFilter === cat.key
            ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
        "
        @click="selectedCategoryFilter = cat.key"
      >
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :style="{
            backgroundColor:
              selectedCategoryFilter === cat.key ? '#ffffff' : cat.color,
          }"
        />
        <span>{{ cat.label }}</span>
      </button>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-700 dark:text-slate-400"
        @click="inlineNewCategoryOpen = !inlineNewCategoryOpen"
      >
        <Plus class="h-3 w-3 shrink-0" />
        <span>{{ t('search.addCategoryInline') }}</span>
      </button>
    </div>

    <div
      v-if="inlineNewCategoryOpen"
      class="mb-3 flex gap-1.5 rounded-xl bg-slate-50 p-2 dark:bg-slate-800/70"
    >
      <input
        v-model="inlineNewCategoryName"
        type="text"
        maxlength="24"
        :placeholder="t('search.newCategoryPlaceholder')"
        class="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
        @keyup.enter="confirmInlineAddCategory"
      />
      <button
        type="button"
        class="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white"
        @click="confirmInlineAddCategory"
      >
        {{ t('settings.add') }}
      </button>
      <button
        type="button"
        class="rounded-lg px-2 py-1 text-slate-400"
        @click="inlineNewCategoryOpen = false"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>

    <!-- 專案成員快速篩選膠囊列（單行橫向滑動，點選成員即列出其墊付或分攤之明細） -->
    <div
      v-if="context === 'project' && projectMembers && projectMembers.length > 0"
      class="no-scrollbar mb-2.5 flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5"
    >
      <button
        type="button"
        class="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
        :class="
          selectedMemberFilter === 'all'
            ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
        "
        @click="selectedMemberFilter = 'all'"
      >
        {{ t('search.allMembers') }}
      </button>
      <button
        v-for="m in orderedFilterMembers"
        :key="m.id"
        type="button"
        class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full py-0.5 pl-1 pr-2.5 text-[11px] font-semibold transition"
        :class="
          selectedMemberFilter === m.id
            ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
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

    <div
      v-if="filteredTransactions.length > 0"
      class="mb-2 flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-400"
    >
      <span>{{ t('swipe.hintTapExpand') }}</span>
      <span v-if="hasActiveFilter" class="font-semibold text-slate-500 dark:text-slate-400">
        {{ t('search.filteredCount', { count: filteredTransactions.length }) }}
        <template
          v-if="filteredMemberShareSubtotal !== null && projectBaseCurrency"
        >
          ·
          {{
            t('search.memberShareTotal', {
              amount: fmt(filteredMemberShareSubtotal, projectBaseCurrency),
            })
          }}
        </template>
      </span>
    </div>

    <p
      v-if="filteredTransactions.length === 0"
      class="py-8 text-center text-xs text-slate-400 dark:text-slate-500"
    >
      {{ hasActiveFilter ? t('search.noMatches') : emptyText }}
    </p>

    <!-- 依日期分組之明細清單（含單日小計與點擊展開分攤詳情） -->
    <div v-else class="space-y-4">
      <div v-for="group in groupedTransactions" :key="group.date">
        <!-- 日期分組標頭列（高對比靛藍石板條） -->
        <div
          class="mb-1.5 flex items-center justify-between rounded-xl border border-indigo-100 bg-indigo-50/75 px-3 py-1.5 text-[11px] font-bold text-indigo-950 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-200"
        >
          <span>{{ group.dateLabel }}</span>
          <span
            v-if="group.projectNetSubtotal !== null && projectBaseCurrency"
            class="tabular-nums text-indigo-900 dark:text-indigo-100"
          >
            {{
              t('project.daySubtotal', {
                amount: fmt(group.projectNetSubtotal, projectBaseCurrency),
              })
            }}
          </span>
          <span v-else class="text-[10px] font-semibold text-indigo-700/80 dark:text-indigo-300">
            {{ t('stats.entryCount', { count: group.items.length }) }}
          </span>
        </div>

        <ul class="divide-y divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/80 dark:divide-slate-800 dark:border-slate-800">
          <li
            v-for="tx in group.items"
            :key="tx.id"
            class="odd:bg-white even:bg-slate-50/80 dark:odd:bg-slate-900 dark:even:bg-slate-800/40"
          >
            <SwipeableTxRow
              @edit="emit('edit', tx)"
              @delete="emit('delete', tx.id)"
            >
              <!-- 點擊整列可展開／收合分攤詳情 -->
              <div
                class="cursor-pointer px-2.5 py-2.5 transition hover:bg-indigo-50/40 dark:hover:bg-slate-800/60"
                @click="toggleExpandTx(tx.id)"
              >
                <div class="flex items-center justify-between gap-2.5">
                  <div class="flex min-w-0 items-center gap-2.5">
                    <!-- 收據圖片縮圖 -->
                    <button
                      v-if="tx.receiptImages && tx.receiptImages.length > 0"
                      type="button"
                      class="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700"
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
                        class="absolute bottom-0 right-0 rounded-tl bg-slate-950/75 px-1 text-[9px] font-bold text-white"
                      >
                        +{{ tx.receiptImages.length - 1 }}
                      </span>
                    </button>

                    <div class="min-w-0">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {{ tx.note || getCategoryLabel(tx.categoryKey) }}
                        </span>

                        <span
                          v-if="tx.type === 'transfer'"
                          class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                        >
                          {{ t('home.settlementBadge') }}
                        </span>

                        <span
                          v-if="tx.type === 'refund'"
                          class="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700 dark:bg-teal-950/60 dark:text-teal-300"
                        >
                          {{ t('project.refundBadge') }}
                        </span>

                        <button
                          v-if="context === 'home' && tx.projectId && store.getProjectById(tx.projectId)"
                          type="button"
                          class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300"
                          @click.stop="emit('openProject', tx.projectId)"
                        >
                          {{ store.getProjectById(tx.projectId)?.name }}
                        </button>

                        <span
                          v-if="context === 'project' && tx.splitConfig"
                          class="inline-flex items-center gap-1 rounded-full border border-slate-200/80 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        >
                          <span class="inline-flex items-center -space-x-0.5">
                            <span
                              v-for="(color, cIdx) in getPayerColors(tx)"
                              :key="cIdx"
                              class="h-2 w-2 rounded-full ring-1 ring-white dark:ring-slate-900"
                              :style="{ backgroundColor: color }"
                            />
                          </span>
                          <span>{{ getPayerBadgeText(tx) }}</span>
                        </span>
                      </div>

                      <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                        <span
                          class="h-1.5 w-1.5 rounded-full"
                          :style="{ backgroundColor: getCategoryColor(tx.categoryKey) }"
                        />
                        <span>{{ getCategoryLabel(tx.categoryKey) }}</span>
                        <span v-if="tx.time !== '00:00'">· {{ tx.time }}</span>
                        <span
                          v-if="
                            context === 'project' &&
                            projectBaseCurrency &&
                            tx.currency !== projectBaseCurrency
                          "
                          class="text-amber-600 dark:text-amber-400"
                        >
                          ({{
                            t('project.convertedPreview', {
                              amount: `${tx.type === 'refund' ? '-' : ''}${fmt(
                                tx.amount * tx.exchangeRateToBase,
                                projectBaseCurrency,
                              )}`,
                            })
                          }})
                        </span>
                      </div>
                    </div>
                  </div>

                  <div class="flex shrink-0 items-center gap-1.5">
                    <div class="flex flex-col items-end">
                      <span
                        class="text-sm font-bold tabular-nums leading-tight"
                        :class="
                          tx.type === 'income'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : tx.type === 'refund'
                              ? 'text-teal-600 dark:text-teal-400'
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

                      <!-- 金額下方分攤成員小圈圈：一眼辨識此筆有做金額分攤與參與對象 -->
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
                            size="xxs"
                            ring
                          />
                          <span
                            v-if="getSplitIndicatorMembers(tx).length > 4"
                            class="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-slate-200 px-1 text-[8px] font-bold text-slate-700 ring-1 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-900"
                          >
                            +{{ getSplitIndicatorMembers(tx).length - 4 }}
                          </span>
                        </div>
                      </div>
                    </div>
                    <ChevronDown
                      class="h-3.5 w-3.5 text-slate-400 transition-transform"
                      :class="expandedTxId === tx.id ? 'rotate-180 text-emerald-600 dark:text-emerald-400' : ''"
                    />
                  </div>
                </div>

                <!-- 展開之帳目詳情面板（誰墊付、誰分攤多少、全部收據與快速操作） -->
                <div
                  v-if="expandedTxId === tx.id"
                  class="mt-2.5 space-y-2.5 rounded-xl border border-slate-100 bg-slate-50/90 p-3 text-xs dark:border-slate-800 dark:bg-slate-800/60"
                  @click.stop
                >
                  <!-- 墊付明細 -->
                  <div v-if="getTxPayerBreakdown(tx).length > 0" class="space-y-1">
                    <div class="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      {{ t('split.payerLabel') }}
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      <span
                        v-for="payer in getTxPayerBreakdown(tx)"
                        :key="payer.memberId"
                        class="inline-flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-200"
                      >
                        <MemberAvatar
                          :name="getMemberName(payer.memberId, tx.projectId)"
                          :color="getMemberColor(payer.memberId, tx.projectId)"
                          :image="getMemberAvatar(payer.memberId, tx.projectId)"
                          size="xs"
                        />
                        <span>{{ getMemberName(payer.memberId, tx.projectId) }}</span>
                        <span class="tabular-nums font-bold text-emerald-700 dark:text-emerald-400">
                          {{ fmt(payer.amount, tx.currency) }}
                        </span>
                      </span>
                    </div>
                  </div>

                  <!-- 分攤明細 -->
                  <div v-if="getTxShareBreakdown(tx).length > 0" class="space-y-1">
                    <div class="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      {{ t('project.splitBreakdownLabel') }}
                    </div>
                    <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      <div
                        v-for="share in getTxShareBreakdown(tx)"
                        :key="share.memberId"
                        class="flex items-center justify-between gap-1.5 rounded-lg bg-white px-2 py-1 text-[11px] dark:bg-slate-900"
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
                    class="text-[11px] text-amber-700 dark:text-amber-300"
                  >
                    {{ t('project.exchangeRateLabel', { from: tx.currency }) }}
                    <strong class="tabular-nums">{{ tx.exchangeRateToBase }}</strong>
                    {{ projectBaseCurrency }}
                  </div>

                  <!-- 全部收據縮圖（點擊開對應索引之多圖燈箱） -->
                  <div
                    v-if="tx.receiptImages && tx.receiptImages.length > 0"
                    class="flex flex-wrap gap-2 pt-0.5"
                  >
                    <button
                      v-for="(img, imgIdx) in tx.receiptImages"
                      :key="imgIdx"
                      type="button"
                      class="h-14 w-14 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700"
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
                      class="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-sky-600 hover:underline dark:bg-slate-900 dark:text-sky-400"
                    >
                      <ExternalLink class="h-3 w-3" />
                      <span class="max-w-[180px] truncate">{{ url }}</span>
                    </a>
                  </div>

                  <!-- 詳情列底部：編輯者標記 ＋ 快捷編輯／刪除按鈕 -->
                  <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/70 pt-2 dark:border-slate-700/70">
                    <span
                      v-if="tx.lastEditedBy"
                      class="text-[10px] font-medium text-slate-400 dark:text-slate-500"
                    >
                      {{ t('project.lastEditedByLabel', { name: tx.lastEditedBy }) }}
                    </span>
                    <span v-else />
                    <div class="flex items-center gap-1.5">
                      <button
                        v-if="tx.type !== 'transfer'"
                        type="button"
                        class="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 shadow-sm hover:bg-sky-50 hover:text-sky-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:text-sky-400"
                        @click="emit('duplicate', tx)"
                      >
                        <CopyPlus class="h-3 w-3" />
                        <span>{{ t('home.duplicateTx') }}</span>
                      </button>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 shadow-sm hover:bg-emerald-50 hover:text-emerald-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:text-emerald-400"
                        @click="emit('edit', tx)"
                      >
                        <Pencil class="h-3 w-3" />
                        <span>{{ t('home.editTx') }}</span>
                      </button>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-bold text-rose-600 shadow-sm hover:bg-rose-50 dark:bg-slate-900 dark:text-rose-400"
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
      class="mt-3 text-center"
    >
      <button
        type="button"
        class="text-xs font-semibold text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
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
