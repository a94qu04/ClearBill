<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeftRight,
  ChevronDown,
  Info,
  RefreshCw,
  Share2,
} from 'lucide-vue-next'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import type { SettleUpResult } from '@/core/settleUpEngine'
import type { SettlementRateSource } from '@/core/settlementRateResolver'
import { formatCurrencyNumber } from '@/core/currency'
import { useLedgerStore } from '@/stores/ledgerStore'

interface Props {
  project: Project
  settleUp: SettleUpResult
  baseSettleUp?: SettleUpResult | null
  expenses: Transaction[]
  rawExpenses: Transaction[]
  settlements: Transaction[]
  settlementCurrency: string
  isCrossCurrencySettlement: boolean
  baseToSettlementRate: number | null
  baseToSettlementRateSource: SettlementRateSource
}

const props = withDefaults(defineProps<Props>(), {
  baseSettleUp: null,
})

const emit = defineEmits<{
  (e: 'openShareSheet'): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const rateSettingsExpanded = ref(false)
const currencyGuideOpen = ref(false)
const customSettleRateDrafts = ref<Record<string, string>>({})

const currentRateMode = computed<'per_tx' | 'live' | 'custom'>(() =>
  store.getProjectSettlementRateMode(props.project),
)

const currentRateModeLabel = computed(() => {
  if (currentRateMode.value === 'live') return t('rates.modeLive')
  if (currentRateMode.value === 'custom') return t('rates.modeCustom')
  return t('rates.modePerTx')
})

const settlementCurrencyChoices = computed<string[]>(() => {
  const set = new Set<string>(store.availableCurrencies)
  set.add(props.project.baseCurrency.trim().toUpperCase())
  set.add(props.settlementCurrency)
  for (const tx of props.expenses) {
    if (tx.currency) set.add(tx.currency.trim().toUpperCase())
  }
  return Array.from(set)
})

const foreignCurrenciesInProject = computed<string[]>(() => {
  const target = props.settlementCurrency
  const set = new Set<string>()
  for (const tx of [...props.expenses, ...props.settlements]) {
    const cur = tx.currency.trim().toUpperCase()
    if (cur && cur !== target) set.add(cur)
  }
  return Array.from(set)
})

/** 各外幣於原始交易中實際記錄的匯率範圍（供「各筆原匯率」模式清楚呈現保留的原匯率資料） */
const originalRatesSummary = computed<Array<{ currency: string; text: string }>>(() => {
  const base = props.project.baseCurrency.trim().toUpperCase()
  const byCur = new Map<string, number[]>()
  for (const tx of [...props.rawExpenses, ...props.settlements]) {
    if (tx.isDeleted) continue
    const cur = tx.currency.trim().toUpperCase()
    if (!cur || cur === base) continue
    const r = tx.exchangeRateToBase
    if (Number.isFinite(r) && r > 0) {
      const list = byCur.get(cur)
      if (list) list.push(r)
      else byCur.set(cur, [r])
    }
  }
  const result: Array<{ currency: string; text: string }> = []
  for (const [cur, rates] of byCur.entries()) {
    const min = Math.min(...rates)
    const max = Math.max(...rates)
    const text =
      Math.abs(max - min) < 0.00001
        ? `1 ${cur} = ${min} ${base}`
        : `1 ${cur} = ${min} ~ ${max} ${base}`
    result.push({ currency: cur, text })
  }
  return result
})

const formattedLiveRatesFetchedAt = computed(() => {
  const ts = store.liveRatesFetchedAt
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts))
  } catch {
    return ''
  }
})

function fmtNum(amount: number, currency: string): string {
  return formatCurrencyNumber(amount, currency, locale.value)
}

function syncSettleRateDrafts() {
  const target = props.settlementCurrency
  const base = props.project.baseCurrency.trim().toUpperCase()
  const savedBucket = store.getProjectCustomRatesForTarget(props.project, target)
  const next: Record<string, string> = {}
  for (const cur of foreignCurrenciesInProject.value) {
    const saved = savedBucket?.[cur]
    const live = store.getLiveExchangeRate(cur, target)
    // 僅當結帳幣別等同記帳主幣別時，才從「原始未覆寫交易」取回原記帳匯率，避免讀取覆寫副本
    const fallbackTx =
      target === base
        ? props.rawExpenses.find(
            (tx) =>
              tx.currency.trim().toUpperCase() === cur &&
              tx.exchangeRateToBase > 0,
          )?.exchangeRateToBase
        : undefined
    const val =
      saved ?? live ?? fallbackTx ?? store.getEffectiveExchangeRate(cur, target)
    next[cur] = val !== undefined && val !== null ? String(val) : ''
  }
  customSettleRateDrafts.value = next
}

watch(
  () => [
    props.project.id,
    props.settlementCurrency,
    props.project.baseCurrency,
    currentRateMode.value,
    JSON.stringify(
      store.getProjectCustomRatesForTarget(
        props.project,
        props.settlementCurrency,
      ) ?? {},
    ),
    foreignCurrenciesInProject.value.join(','),
  ],
  () => {
    syncSettleRateDrafts()
  },
  { immediate: true },
)

async function handleChangeSettlementCurrency(event: Event) {
  const nextCurrency = (event.target as HTMLSelectElement).value
  if (!nextCurrency || nextCurrency === props.settlementCurrency) return
  if (!store.liveRatesFetchedAt) {
    void store.refreshExchangeRates(false)
  }
  await store.updateProjectSettlementCurrency(props.project.id, nextCurrency)
  emit(
    'toast',
    t('rates.settlementCurrencyChangedToast', { currency: nextCurrency }),
  )
}

async function handleSelectSettleRateMode(mode: 'per_tx' | 'live' | 'custom') {
  if (mode === 'live' && !store.liveRatesFetchedAt) {
    await store.refreshExchangeRates(false)
  }
  if (mode === 'custom') {
    const parsedMap: Record<string, number> = {}
    for (const cur of foreignCurrenciesInProject.value) {
      const val = Number(customSettleRateDrafts.value[cur])
      if (Number.isFinite(val) && val > 0) {
        parsedMap[cur] = val
      }
    }
    await store.updateProjectSettlementRateConfig(
      props.project.id,
      'custom',
      parsedMap,
    )
  } else {
    await store.updateProjectSettlementRateConfig(props.project.id, mode)
  }
}

async function handleSaveCustomSettleRates() {
  const parsedMap: Record<string, number> = {}
  for (const cur of foreignCurrenciesInProject.value) {
    const val = Number(customSettleRateDrafts.value[cur])
    if (!Number.isFinite(val) || val <= 0) {
      emit('toast', t('validation.exchangeRateRequired'))
      return
    }
    parsedMap[cur] = val
  }
  await store.updateProjectSettlementRateConfig(
    props.project.id,
    'custom',
    parsedMap,
  )
  emit('toast', t('rates.settleCustomAppliedToast'))
}

async function handleFillLiveToCustomSettleRate(cur: string) {
  let live = store.getLiveExchangeRate(cur, props.settlementCurrency)
  if (live === null) {
    await store.refreshExchangeRates(true)
    live = store.getLiveExchangeRate(cur, props.settlementCurrency)
  }
  if (live === null) {
    emit('toast', t('project.liveRateUnavailableToast'))
    return
  }
  customSettleRateDrafts.value = {
    ...customSettleRateDrafts.value,
    [cur]: String(live),
  }
  await handleSaveCustomSettleRates()
}

async function handleRefreshRatesInSettle() {
  const res = await store.refreshExchangeRates(true)
  if (res) {
    emit('toast', t('rates.refreshedToast'))
  } else {
    emit('toast', t('project.liveRateUnavailableToast'))
  }
}
</script>

<template>
  <section
    class="space-y-2 rounded-2xl bg-white px-3.5 py-3 shadow-sm dark:bg-[#1C1C1E] sm:space-y-2.5 sm:p-4"
  >
    <div class="flex items-center justify-between gap-2.5">
      <div class="min-w-0">
        <div class="text-[11px] font-medium text-slate-400 dark:text-slate-500">
          {{ t('settle.projectTotalSpend') }}
        </div>
        <div class="mt-0.5 flex flex-wrap items-baseline gap-1.5">
          <span class="inline-flex items-baseline gap-1.5 tabular-nums">
            <span class="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-xs font-extrabold tracking-wide text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
              {{ settlementCurrency }}
            </span>
            <span class="text-xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-2xl">
              {{ fmtNum(settleUp.totalProjectExpense, settlementCurrency) }}
            </span>
          </span>
          <span
            v-if="isCrossCurrencySettlement && baseSettleUp"
            class="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-[#2C2C2E] dark:text-slate-300"
          >
            {{
              t('rates.baseAmountTag', {
                amount: `${project.baseCurrency} ${fmtNum(baseSettleUp.totalProjectExpense, project.baseCurrency)}`,
              })
            }}
          </span>
        </div>
      </div>

      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400 sm:px-4 sm:py-2"
        @click="emit('openShareSheet')"
      >
        <Share2 class="h-3.5 w-3.5" />
        <span>{{ t('share.button') }}</span>
      </button>
    </div>

    <!-- 緊湊單行結帳幣別選擇與按需展開匯率列（手機省空間不換行） -->
    <div class="flex items-center justify-between gap-1.5 border-t border-slate-100 pt-2 dark:border-white/10">
      <div class="flex min-w-0 items-center gap-1.5">
        <ArrowLeftRight class="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span class="shrink-0 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
          {{ t('rates.settlementCurrencyLabel') }}
        </span>
        <select
          :value="settlementCurrency"
          :aria-label="t('rates.settlementCurrencyLabel')"
          class="h-6 rounded-md bg-emerald-500/12 px-1.5 text-[11px] font-bold text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-300"
          @change="handleChangeSettlementCurrency"
        >
          <option
            v-for="code in settlementCurrencyChoices"
            :key="code"
            :value="code"
          >
            {{ code }}
          </option>
        </select>
        <button
          type="button"
          :aria-label="t('rates.currencyGuideToggle')"
          :aria-expanded="currencyGuideOpen"
          class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-200"
          :class="currencyGuideOpen ? 'bg-slate-100 text-emerald-600 dark:bg-white/10 dark:text-emerald-400' : ''"
          @click="currencyGuideOpen = !currencyGuideOpen"
        >
          <Info class="h-3.5 w-3.5" />
        </button>
      </div>

      <button
        v-if="foreignCurrenciesInProject.length > 0"
        type="button"
        class="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-200/80 dark:bg-[#2C2C2E] dark:text-slate-300 dark:hover:bg-white/15"
        @click="rateSettingsExpanded = !rateSettingsExpanded"
      >
        <span class="hidden sm:inline">{{ t('rates.settingsToggleShort') }} ·</span>
        <span>{{ currentRateModeLabel }}</span>
        <ChevronDown
          class="h-3 w-3 shrink-0 transition-transform"
          :class="rateSettingsExpanded ? 'rotate-180' : ''"
        />
      </button>
    </div>

    <!-- 記帳幣別 vs 結帳幣別 一眼對照小卡（點擊 i 圖示展開，平常不佔畫面） -->
    <div
      v-if="currencyGuideOpen"
      class="space-y-1.5 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600 dark:bg-[#2C2C2E] dark:text-slate-300"
    >
      <div class="flex items-start gap-2">
        <span class="mt-0.5 shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-white/10 dark:text-slate-200">
          {{ t('rates.guideBaseLabel', { currency: project.baseCurrency }) }}
        </span>
        <span class="min-w-0 flex-1">{{ t('rates.guideBaseDesc') }}</span>
      </div>
      <div class="flex items-start gap-2">
        <span class="mt-0.5 shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
          {{ t('rates.guideSettleLabel', { currency: settlementCurrency }) }}
        </span>
        <span class="min-w-0 flex-1">{{ t('rates.guideSettleDesc') }}</span>
      </div>
    </div>

    <!-- 按需展開之三模式結算匯率抽屜（原匯率永久保留，不佔平常畫面空間） -->
    <div
      v-if="rateSettingsExpanded && foreignCurrenciesInProject.length > 0"
      class="space-y-2.5 border-t border-slate-100 pt-3 dark:border-white/10"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="grid flex-1 grid-cols-3 gap-1 rounded-xl bg-black/[0.06] p-1 text-[11px] font-semibold dark:bg-[#2C2C2E]">
          <button
            type="button"
            class="rounded-lg py-1.5 transition"
            :class="
              currentRateMode === 'per_tx'
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#3A3A3C] dark:text-white'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
            "
            @click="handleSelectSettleRateMode('per_tx')"
          >
            {{ t('rates.modePerTx') }}
          </button>
          <button
            type="button"
            class="rounded-lg py-1.5 transition"
            :class="
              currentRateMode === 'live'
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#3A3A3C] dark:text-white'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
            "
            @click="handleSelectSettleRateMode('live')"
          >
            {{ t('rates.modeLive') }}
          </button>
          <button
            type="button"
            class="rounded-lg py-1.5 transition"
            :class="
              currentRateMode === 'custom'
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#3A3A3C] dark:text-white'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
            "
            @click="handleSelectSettleRateMode('custom')"
          >
            {{ t('rates.modeCustom') }}
          </button>
        </div>

        <button
          type="button"
          :disabled="store.isRefreshingLiveRates"
          class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-2 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-200 disabled:opacity-50 dark:bg-[#2C2C2E] dark:text-slate-300"
          @click="handleRefreshRatesInSettle"
        >
          <RefreshCw
            class="h-3 w-3"
            :class="store.isRefreshingLiveRates ? 'animate-spin' : ''"
          />
          <span class="hidden sm:inline">
            {{
              formattedLiveRatesFetchedAt
                ? t('rates.updatedAtShort', { time: formattedLiveRatesFetchedAt })
                : t('rates.refreshNow')
            }}
          </span>
        </button>
      </div>

      <!-- 各筆原匯率模式 -->
      <div
        v-if="currentRateMode === 'per_tx'"
        class="space-y-1.5 text-[11px] text-slate-600 dark:text-slate-300"
      >
        <div
          v-if="originalRatesSummary.length > 0 || isCrossCurrencySettlement"
          class="flex flex-wrap items-center gap-1.5"
        >
          <span
            v-for="item in originalRatesSummary"
            :key="item.currency"
            class="inline-flex items-center rounded-lg bg-slate-100 px-2.5 py-1 font-semibold tabular-nums text-slate-700 dark:bg-[#2C2C2E] dark:text-slate-200"
          >
            {{ item.text }}
          </span>
          <span
            v-if="isCrossCurrencySettlement && baseToSettlementRate !== null"
            class="inline-flex items-center gap-1 rounded-lg bg-emerald-500/12 px-2.5 py-1 font-semibold tabular-nums text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
          >
            <span>
              {{
                t('rates.crossBaseBridgeRate', {
                  base: project.baseCurrency,
                  rate: baseToSettlementRate,
                  target: settlementCurrency,
                })
              }}
            </span>
            <span
              v-if="baseToSettlementRateSource === 'estimated'"
              class="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold text-amber-700 dark:bg-amber-500/25 dark:text-amber-300"
            >
              {{ t('rates.sourceEstimatedTag') }}
            </span>
          </span>
          <button
            v-else-if="isCrossCurrencySettlement"
            type="button"
            class="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 py-1 font-semibold text-amber-800 transition hover:bg-amber-500/25 dark:bg-amber-500/20 dark:text-amber-300"
            @click="handleSelectSettleRateMode('custom')"
          >
            {{
              t('rates.missingRateNeedInput', {
                from: project.baseCurrency,
                to: settlementCurrency,
              })
            }}
          </button>
        </div>
        <p class="text-[10px] text-slate-400 dark:text-slate-500">
          {{ t('rates.perTxPreservedHint') }}
        </p>
      </div>

      <!-- 即時匯率對照 -->
      <div
        v-else-if="currentRateMode === 'live'"
        class="flex flex-wrap items-center gap-1.5 text-[11px]"
      >
        <template v-for="cur in foreignCurrenciesInProject" :key="cur">
          <span
            v-if="store.getEffectiveExchangeRateWithSource(cur, settlementCurrency).rate !== null"
            class="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 font-semibold tabular-nums text-slate-700 dark:bg-[#2C2C2E] dark:text-slate-200"
          >
            <span>1 {{ cur }} =</span>
            <span class="text-emerald-600 dark:text-emerald-400">
              {{ store.getEffectiveExchangeRateWithSource(cur, settlementCurrency).rate }}
            </span>
            <span>{{ settlementCurrency }}</span>
            <span
              v-if="store.getEffectiveExchangeRateWithSource(cur, settlementCurrency).source === 'estimated'"
              class="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold text-amber-700 dark:bg-amber-500/25 dark:text-amber-300"
            >
              {{ t('rates.sourceEstimatedTag') }}
            </span>
          </span>
          <button
            v-else
            type="button"
            class="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 py-1 font-semibold text-amber-800 transition hover:bg-amber-500/25 dark:bg-amber-500/20 dark:text-amber-300"
            @click="handleSelectSettleRateMode('custom')"
          >
            <span>1 {{ cur }} = ? {{ settlementCurrency }}</span>
            <span>· {{ t('rates.needInputShort') }}</span>
          </button>
        </template>
      </div>

      <!-- 自訂結算匯率 -->
      <div v-else-if="currentRateMode === 'custom'" class="space-y-2">
        <div
          v-for="cur in foreignCurrenciesInProject"
          :key="cur"
          class="flex items-center gap-2 rounded-xl bg-slate-100/80 px-3 py-2 text-xs dark:bg-[#2C2C2E]"
        >
          <span class="shrink-0 font-semibold text-slate-600 dark:text-slate-300">
            1 {{ cur }} =
          </span>
          <input
            v-model="customSettleRateDrafts[cur]"
            type="number"
            step="any"
            min="0"
            inputmode="decimal"
            :placeholder="t('rates.needInputShort')"
            class="min-w-0 flex-1 rounded-lg bg-white px-2.5 py-1 text-xs font-bold tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:bg-[#1C1C1E] dark:text-white"
            @keyup.enter="handleSaveCustomSettleRates"
          />
          <span class="shrink-0 text-[11px] font-semibold text-slate-500">
            {{ settlementCurrency }}
          </span>
          <button
            type="button"
            class="shrink-0 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 shadow-sm transition hover:text-emerald-600 dark:bg-[#1C1C1E] dark:text-slate-300"
            @click="handleFillLiveToCustomSettleRate(cur)"
          >
            {{ t('rates.useLiveShort') }}
          </button>
        </div>
        <button
          type="button"
          class="w-full rounded-xl bg-emerald-600 py-2 text-xs font-bold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
          @click="handleSaveCustomSettleRates"
        >
          {{ t('rates.applySettleCustomButton') }}
        </button>
      </div>
    </div>
  </section>
</template>
