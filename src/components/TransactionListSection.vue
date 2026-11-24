<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil, Plus, Search, Trash2, X } from 'lucide-vue-next'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import { formatCurrencyAmount } from '@/core/currency'
import { matchesDateQuery } from '@/core/ledgerHelpers'
import type { Transaction } from '@/schemas/ledgerSchema'
import SwipeableTxRow from '@/components/SwipeableTxRow.vue'

interface Props {
  context: 'home' | 'project'
  transactions: Transaction[]
  title?: string
  emptyText: string
  projectBaseCurrency?: string
  collapsibleLimit?: number
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
  projectBaseCurrency: undefined,
  collapsibleLimit: 0,
})

const emit = defineEmits<{
  (e: 'edit', tx: Transaction): void
  (e: 'delete', id: string): void
  (e: 'openProject', projectId: string): void
  (e: 'previewPhotos', payload: { photos: string[]; index: number }): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const searchQuery = ref('')
const selectedCategoryFilter = ref<string>('all')
const showAll = ref(false)
const inlineNewCategoryOpen = ref(false)
const inlineNewCategoryName = ref('')

function resolveCategoryLabel(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

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

function matchesFilter(tx: Transaction): boolean {
  if (
    selectedCategoryFilter.value !== 'all' &&
    tx.categoryKey !== selectedCategoryFilter.value
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

  return (
    note.includes(q) ||
    catName.includes(q) ||
    matchesDateQuery(tx.date, q) ||
    timeStr.includes(q) ||
    amountStr.includes(qWithoutComma) ||
    currencyStr.includes(q) ||
    projectName.includes(q) ||
    payerNames.includes(q)
  )
}

const filteredTransactions = computed(() =>
  props.transactions.filter(matchesFilter),
)

const displayedTransactions = computed(() => {
  if (!props.collapsibleLimit || showAll.value) {
    return filteredTransactions.value
  }
  return filteredTransactions.value.slice(0, props.collapsibleLimit)
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
  inlineNewCategoryOpen.value = false
}

defineExpose({ resetFilters })
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

    <!-- 費用類別篩選膠囊列＋現場新增類別 -->
    <div class="mb-3 flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        class="rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
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
        class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
        :class="
          selectedCategoryFilter === cat.key
            ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
        "
        @click="selectedCategoryFilter = cat.key"
      >
        <span
          class="h-1.5 w-1.5 rounded-full"
          :style="{
            backgroundColor:
              selectedCategoryFilter === cat.key ? '#ffffff' : cat.color,
          }"
        />
        <span>{{ cat.label }}</span>
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-0.5 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-700 dark:text-slate-400"
        @click="inlineNewCategoryOpen = !inlineNewCategoryOpen"
      >
        <Plus class="h-3 w-3" />
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

    <div
      v-if="filteredTransactions.length > 0"
      class="mb-2 flex items-center justify-between text-[10px] text-slate-400"
    >
      <span>{{ t('swipe.hint') }}</span>
      <span v-if="searchQuery || selectedCategoryFilter !== 'all'">
        {{ t('search.filteredCount', { count: filteredTransactions.length }) }}
      </span>
    </div>

    <p
      v-if="filteredTransactions.length === 0"
      class="py-8 text-center text-xs text-slate-400 dark:text-slate-500"
    >
      {{
        searchQuery || selectedCategoryFilter !== 'all'
          ? t('search.noMatches')
          : emptyText
      }}
    </p>

    <ul v-else class="divide-y divide-slate-100 dark:divide-slate-800">
      <li v-for="tx in displayedTransactions" :key="tx.id">
        <SwipeableTxRow
          @edit="emit('edit', tx)"
          @delete="emit('delete', tx.id)"
        >
          <div class="flex items-center justify-between gap-2.5 py-2.5">
            <div class="flex min-w-0 items-center gap-2.5">
              <!-- 收據圖片縮圖（點擊於多圖燈箱瀏覽全部收據） -->
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

                  <!-- 還款標記 -->
                  <span
                    v-if="tx.type === 'transfer'"
                    class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                  >
                    {{ t('home.settlementBadge') }}
                  </span>

                  <!-- 退款／退稅標記 -->
                  <span
                    v-if="tx.type === 'refund'"
                    class="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700 dark:bg-teal-950/70 dark:text-teal-300"
                  >
                    {{ t('project.refundBadge') }}
                  </span>

                  <!-- 首頁顯示所屬專案標籤 -->
                  <button
                    v-if="context === 'home' && tx.projectId && store.getProjectById(tx.projectId)"
                    type="button"
                    class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300"
                    @click.stop="emit('openProject', tx.projectId)"
                  >
                    {{ store.getProjectById(tx.projectId)?.name }}
                  </button>

                  <!-- 專案內顯示含成員色點之墊付人標籤 -->
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
                  <span>·</span>
                  <span>{{ tx.date }} {{ tx.time !== '00:00' ? tx.time : '' }}</span>
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

            <div class="flex shrink-0 items-center gap-1">
              <span
                class="mr-1 text-sm font-bold tabular-nums"
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
              <button
                type="button"
                :aria-label="t('home.editTx')"
                class="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/60 dark:hover:text-emerald-400"
                @click.stop="emit('edit', tx)"
              >
                <Pencil class="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                :aria-label="t('home.deleteTx')"
                class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                @click.stop="emit('delete', tx.id)"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </SwipeableTxRow>
      </li>
    </ul>

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
