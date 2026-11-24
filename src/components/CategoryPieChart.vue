<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PieChart } from 'lucide-vue-next'
import type { Transaction } from '@/schemas/ledgerSchema'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import { calculateCategoryStats } from '@/core/categoryStats'
import { formatCurrencyAmount } from '@/core/currency'

interface Props {
  transactions: Transaction[]
  baseCurrency: string
}

const props = defineProps<Props>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const activeKey = ref<string | null>(null)

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

const stats = computed(() =>
  calculateCategoryStats(props.transactions, props.baseCurrency),
)

const CHART_RADIUS = 54
const CHART_CIRCUMFERENCE = 2 * Math.PI * CHART_RADIUS

interface ChartSlice {
  categoryKey: string
  label: string
  color: string
  amount: number
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
      amount: item.amount,
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

function fmt(amount: number): string {
  return formatCurrencyAmount(amount, props.baseCurrency, locale.value)
}
</script>

<template>
  <section
    class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
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
          </template>
        </div>
      </div>

      <!-- 右側分類佔比明細清單 -->
      <ul class="w-full min-w-0 flex-1 space-y-2">
        <li v-for="slice in slices" :key="slice.categoryKey">
          <button
            type="button"
            class="w-full rounded-xl px-2.5 py-1.5 text-left transition"
            :class="
              activeKey === slice.categoryKey
                ? 'bg-slate-100 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700'
                : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
            "
            @click="toggleFocus(slice.categoryKey)"
            @mouseenter="activeKey = slice.categoryKey"
            @mouseleave="activeKey = null"
          >
            <div class="flex items-center justify-between gap-2 text-xs">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  :style="{ backgroundColor: slice.color }"
                />
                <span class="truncate font-semibold text-slate-800 dark:text-slate-100">
                  {{ slice.label }}
                </span>
                <span class="shrink-0 text-[10px] text-slate-400">
                  {{ t('stats.entryCount', { count: slice.count }) }}
                </span>
              </div>
              <div class="flex shrink-0 items-center gap-2 tabular-nums">
                <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  {{ slice.percentage }}%
                </span>
                <span class="font-bold text-slate-900 dark:text-white">
                  {{ fmt(slice.amount) }}
                </span>
              </div>
            </div>
            <!-- 迷你比例進度條 -->
            <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
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
