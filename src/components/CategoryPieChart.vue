<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PieChart } from 'lucide-vue-next'
import type { Transaction } from '@/schemas/ledgerSchema'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import { calculateCategoryStats } from '@/core/categoryStats'
import { formatCurrencyAmount } from '@/core/currency'
import CategoryIconBadge from '@/components/CategoryIconBadge.vue'

interface Props {
  transactions: Transaction[]
  rawTransactions?: Transaction[]
  baseCurrency: string
  projectBaseCurrency?: string
}

const props = withDefaults(defineProps<Props>(), {
  rawTransactions: undefined,
  projectBaseCurrency: undefined,
})

const { t, locale } = useI18n()
const store = useLedgerStore()

const activeKey = ref<string | null>(null)

const showProjectBaseHint = computed(() => {
  const projectBase = props.projectBaseCurrency?.trim().toUpperCase()
  return (
    Boolean(projectBase) &&
    projectBase !== props.baseCurrency.trim().toUpperCase()
  )
})

const projectBaseStats = computed(() => {
  if (!showProjectBaseHint.value || !props.projectBaseCurrency) return null
  return calculateCategoryStats(
    props.rawTransactions ?? props.transactions,
    props.projectBaseCurrency,
  )
})

const projectBaseAmountMap = computed<Map<string, number>>(() => {
  const map = new Map<string, number>()
  if (!projectBaseStats.value) return map
  for (const item of projectBaseStats.value.items) {
    map.set(item.categoryKey, item.amount)
  }
  return map
})

function resolveCategoryLabel(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

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

const stats = computed(() =>
  calculateCategoryStats(props.transactions, props.baseCurrency),
)

const CHART_RADIUS = 54
const CHART_CIRCUMFERENCE = 2 * Math.PI * CHART_RADIUS

interface ChartSlice {
  categoryKey: string
  label: string
  color: string
  icon?: string
  amount: number
  projectBaseAmount?: number
  percentage: number
  count: number
  dashLength: number
  dashOffset: number
}

const slices = computed<ChartSlice[]>(() => {
  const total = stats.value.positiveChartTotal
  if (total <= 0 || stats.value.items.length === 0) return []

  let accumulatedFraction = 0
  const itemCount = stats.value.items.length
  const gap = itemCount > 1 ? 2.2 : 0

  return stats.value.items.map((item) => {
    const fraction = item.amount / total
    const rawLength = fraction * CHART_CIRCUMFERENCE
    const dashLength = Math.max(2, rawLength - gap)
    const dashOffset = -accumulatedFraction * CHART_CIRCUMFERENCE
    accumulatedFraction += fraction

    return {
      categoryKey: item.categoryKey,
      label: getCategoryLabel(item.categoryKey),
      color: getCategoryColor(item.categoryKey),
      icon: getCategoryIcon(item.categoryKey),
      amount: item.amount,
      projectBaseAmount: projectBaseAmountMap.value.get(item.categoryKey),
      percentage: item.percentage,
      count: item.count,
      dashLength,
      dashOffset,
    }
  })
})

const focusedSlice = computed(() =>
  activeKey.value
    ? slices.value.find((s) => s.categoryKey === activeKey.value) ?? null
    : null,
)

function toggleFocus(key: string) {
  activeKey.value = activeKey.value === key ? null : key
}

function fmt(amount: number, currency = props.baseCurrency): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}
</script>

<template>
  <section
    class="rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]"
  >
    <div class="mb-3 flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">
        <PieChart class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span>{{ t('stats.title') }}</span>
      </div>
      <span
        v-if="slices.length > 0"
        class="text-[11px] font-medium text-slate-400 dark:text-slate-500"
      >
        {{ t('stats.categoryCount', { count: slices.length }) }}
      </span>
    </div>

    <p
      v-if="slices.length === 0"
      class="py-6 text-center text-xs text-slate-400 dark:text-slate-500"
    >
      {{ t('stats.empty') }}
    </p>

    <div
      v-else
      class="flex flex-col items-center gap-4 sm:flex-row sm:items-center"
    >
      <!-- SVG 甜甜圈圓餅圖（互動點擊高亮對應分類） -->
      <div class="relative flex h-40 w-40 shrink-0 items-center justify-center">
        <svg
          viewBox="0 0 140 140"
          class="h-full w-full -rotate-90"
          role="img"
          :aria-label="t('stats.title')"
        >
          <!-- 底環 -->
          <circle
            cx="70"
            cy="70"
            :r="CHART_RADIUS"
            fill="none"
            class="stroke-slate-100 dark:stroke-slate-800"
            stroke-width="18"
          />

          <!-- 各分類扇形圓弧 -->
          <circle
            v-for="slice in slices"
            :key="slice.categoryKey"
            cx="70"
            cy="70"
            :r="CHART_RADIUS"
            fill="none"
            :stroke="slice.color"
            :stroke-width="activeKey === slice.categoryKey ? 22 : 18"
            :stroke-dasharray="`${slice.dashLength} ${CHART_CIRCUMFERENCE}`"
            :stroke-dashoffset="slice.dashOffset"
            stroke-linecap="butt"
            class="cursor-pointer transition-all duration-200"
            :class="
              activeKey && activeKey !== slice.categoryKey
                ? 'opacity-35'
                : 'opacity-100'
            "
            @click="toggleFocus(slice.categoryKey)"
            @mouseenter="activeKey = slice.categoryKey"
            @mouseleave="activeKey = null"
          />
        </svg>

        <!-- 中心摘要（預設總支出；hover / 點擊時顯示該分類金額與佔比） -->
        <div
          class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-5 text-center"
        >
          <template v-if="focusedSlice">
            <span class="max-w-full truncate text-[10px] font-semibold text-slate-500 dark:text-slate-400">
              {{ focusedSlice.label }}
            </span>
            <span class="mt-0.5 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {{ focusedSlice.percentage }}%
            </span>
            <span class="max-w-full truncate text-[10px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {{ fmt(focusedSlice.amount) }}
            </span>
          </template>
          <template v-else>
            <span class="text-[10px] font-medium text-slate-400 dark:text-slate-500">
              {{ t('stats.totalLabel') }}
            </span>
            <span class="mt-0.5 max-w-full truncate text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {{ fmt(stats.totalNetExpense) }}
            </span>
            <span
              v-if="showProjectBaseHint && projectBaseStats && projectBaseCurrency"
              class="max-w-full truncate text-[9px] font-bold tabular-nums text-amber-700 dark:text-amber-300"
            >
              {{ fmt(projectBaseStats.totalNetExpense, projectBaseCurrency) }}
            </span>
          </template>
        </div>
      </div>

      <!-- 右側分類佔比明細清單（Apple 純白分組清單，無斑馬紋） -->
      <ul class="w-full min-w-0 flex-1 divide-y divide-slate-100 dark:divide-white/10">
        <li
          v-for="slice in slices"
          :key="slice.categoryKey"
        >
          <button
            type="button"
            class="w-full rounded-xl px-2 py-2 text-left transition"
            :class="
              activeKey === slice.categoryKey
                ? 'bg-emerald-500/10'
                : 'hover:bg-slate-50 dark:hover:bg-[#2C2C2E]'
            "
            @click="toggleFocus(slice.categoryKey)"
            @mouseenter="activeKey = slice.categoryKey"
            @mouseleave="activeKey = null"
          >
            <div class="flex items-center justify-between gap-2 text-xs">
              <div class="flex min-w-0 items-center gap-2">
                <CategoryIconBadge
                  :icon="slice.icon"
                  :category-key="slice.categoryKey"
                  :color="slice.color"
                  size="xs"
                />
                <span class="truncate font-semibold text-slate-800 dark:text-slate-100">
                  {{ slice.label }}
                </span>
                <span class="shrink-0 text-[10px] text-slate-500 dark:text-slate-400">
                  {{ t('stats.entryCount', { count: slice.count }) }}
                </span>
              </div>
              <div class="flex shrink-0 flex-col items-end tabular-nums">
                <div class="flex items-center gap-1.5">
                  <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    {{ slice.percentage }}%
                  </span>
                  <span class="font-bold text-slate-900 dark:text-white">
                    {{ fmt(slice.amount) }}
                  </span>
                </div>
                <span
                  v-if="showProjectBaseHint && projectBaseCurrency && slice.projectBaseAmount !== undefined"
                  class="text-[9px] font-semibold text-amber-700/90 dark:text-amber-300/90"
                >
                  {{ fmt(slice.projectBaseAmount, projectBaseCurrency) }}
                </span>
              </div>
            </div>
            <!-- 迷你比例進度條 -->
            <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800">
              <div
                class="h-full rounded-full transition-all duration-300"
                :style="{
                  width: `${Math.min(100, Math.max(2, slice.percentage))}%`,
                  backgroundColor: slice.color,
                }"
              />
            </div>
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
