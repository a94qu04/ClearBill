<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Calendar, Loader2, RefreshCw, X } from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useModalLayer } from '@/composables/useModalLayer'
import {
  formatCurrencyAmount,
  formatCurrencyNumber,
  fromMinorUnits,
  toMinorUnits,
} from '@/core/currency'
import {
  buildOrderedCurrencyOptions,
  formatCompactHeaderDate,
  getTodayIso,
} from '@/core/ledgerHelpers'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'
import EntryModeSelector, { type EntryMode } from '@/components/EntryModeSelector.vue'

interface Props {
  open: boolean
  project: Project | null
  editingTx: Transaction | null
  allowProjectSwitch?: boolean
  initialFromId?: string
  initialToId?: string
  suggestedAmount?: number | null
  currency?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  allowProjectSwitch: false,
  initialFromId: '',
  initialToId: '',
  suggestedAmount: null,
  currency: null,
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', message: string): void
  (e: 'switchProject', projectId: string): void
  (e: 'switchEntryMode', mode: EntryMode): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => Boolean(props.open && props.project),
  () => emit('close'),
  dialogRef,
)

let lastAutoFilledAmount: number | null = null
const fromId = ref('')
const toId = ref('')
const amount = ref<number | null>(null)
const payCurrency = ref('TWD')
const exchangeRate = ref<number | null>(1)
const exchangeRateSource = ref<
  'same' | 'live' | 'remembered' | 'estimated' | 'saved' | 'missing'
>('same')
const isFetchingRate = ref(false)
const isSubmitting = ref(false)
const date = ref(getTodayIso())
const datePanelExpanded = ref(false)
const note = ref('')
const errorText = ref('')

const headerDateLabel = computed(() =>
  formatCompactHeaderDate(date.value, getTodayIso(), t('project.todayShort')),
)

const suggestedCurrency = computed<string>(() => {
  if (props.currency) return props.currency.trim().toUpperCase()
  if (props.project) return store.getProjectSettlementCurrency(props.project)
  return store.defaultCurrency
})

const projectSettlementCurrency = computed<string>(() => {
  if (props.project) return store.getProjectSettlementCurrency(props.project)
  return suggestedCurrency.value
})

const projectBaseCurrency = computed<string>(() =>
  props.project?.baseCurrency.trim().toUpperCase() || store.defaultCurrency,
)

/** 優先置頂排列：1. 記帳幣別、2. 結帳幣別、3. 目前選中／其餘常用幣別 */
const orderedCurrencies = computed(() =>
  buildOrderedCurrencyOptions({
    baseCurrency: projectBaseCurrency.value,
    settlementCurrency: projectSettlementCurrency.value,
    availableCurrencies: store.availableCurrencies,
    extraCurrencies: [suggestedCurrency.value, payCurrency.value],
    tags: {
      base: t('settle.currencyTagBaseShort'),
      settlement: t('settle.currencyTagSettlementShort'),
      both: t('settle.currencyTagBothShort'),
    },
  }),
)

const currencyOptions = computed<string[]>(() => orderedCurrencies.value.currencies)
const currencyOptionLabels = computed<Record<string, string>>(
  () => orderedCurrencies.value.labels,
)

const needsExchangeRate = computed(() => {
  if (!props.project) return false
  return (
    payCurrency.value.trim().toUpperCase() !==
    props.project.baseCurrency.trim().toUpperCase()
  )
})

const convertedBasePreview = computed(() => {
  const amt = amount.value ?? 0
  const rate = exchangeRate.value ?? 0
  if (amt <= 0 || rate <= 0) return 0
  return amt * rate
})

const resolvedSettlement = computed(() =>
  props.project ? store.getProjectSettlementOptions(props.project) : null,
)

function resolvePayCurrencyRateToBase(
  fromCurrency: string,
): {
  rate: number | null
  source: 'same' | 'live' | 'remembered' | 'estimated' | 'saved' | 'missing'
} {
  if (!props.project) return { rate: null, source: 'missing' }
  const cur = fromCurrency.trim().toUpperCase()
  const base = props.project.baseCurrency.trim().toUpperCase()
  if (cur === base) return { rate: 1, source: 'same' }
  const resolved = resolvedSettlement.value
  if (
    resolved &&
    cur === resolved.settlementCurrency &&
    resolved.settlementToBase.rate !== null
  ) {
    return {
      rate: resolved.settlementToBase.rate,
      source:
        resolved.settlementToBase.source === 'custom'
          ? 'saved'
          : resolved.settlementToBase.source,
    }
  }
  return store.getEffectiveExchangeRateWithSource(cur, base)
}

function computeConvertedSuggestedForCurrency(targetCurrency: string): number | null {
  if (props.editingTx || props.suggestedAmount === null || props.suggestedAmount <= 0) {
    return null
  }
  const origCur = suggestedCurrency.value
  const targetCur = targetCurrency.trim().toUpperCase()
  if (origCur === targetCur) {
    return props.suggestedAmount
  }
  const resolved = resolvedSettlement.value
  let rate: number | null = null
  if (
    resolved &&
    origCur === resolved.settlementCurrency &&
    targetCur === resolved.projectBaseCurrency &&
    resolved.settlementToBase.rate !== null
  ) {
    rate = resolved.settlementToBase.rate
  } else if (
    resolved &&
    origCur === resolved.projectBaseCurrency &&
    targetCur === resolved.settlementCurrency &&
    resolved.baseToSettlement.rate !== null
  ) {
    rate = resolved.baseToSettlement.rate
  } else {
    rate = store.getEffectiveExchangeRate(origCur, targetCur)
  }
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null
  const units = toMinorUnits(props.suggestedAmount * rate, targetCur)
  return fromMinorUnits(units, targetCur)
}

const equivalentSuggestedInSelectedCurrency = computed<number | null>(() => {
  if (props.editingTx || props.suggestedAmount === null || props.suggestedAmount <= 0) {
    return null
  }
  const origCur = suggestedCurrency.value
  const targetCur = payCurrency.value.trim().toUpperCase()
  if (origCur === targetCur) return null
  return computeConvertedSuggestedForCurrency(targetCur)
})

function applyEquivalentSuggestedAmount() {
  const converted = equivalentSuggestedInSelectedCurrency.value
  if (converted === null || converted <= 0) return
  amount.value = converted
  lastAutoFilledAmount = converted
}

watch(
  () =>
    [
      props.open,
      props.project?.id,
      props.editingTx?.id,
      props.initialFromId,
      props.initialToId,
      props.suggestedAmount,
      props.currency,
    ] as const,
  ([isOpen]) => {
    if (!isOpen || !props.project) return
    errorText.value = ''
    datePanelExpanded.value = false

    if (props.editingTx && props.editingTx.splitConfig) {
      fromId.value = props.editingTx.splitConfig.payerId
      toId.value = props.editingTx.splitConfig.shares[0]?.memberId ?? ''
      amount.value = props.editingTx.amount
      payCurrency.value = props.editingTx.currency.trim().toUpperCase()
      if (payCurrency.value === props.project.baseCurrency.trim().toUpperCase()) {
        exchangeRate.value = 1
        exchangeRateSource.value = 'same'
      } else if (props.editingTx.exchangeRateToBase > 0) {
        exchangeRate.value = props.editingTx.exchangeRateToBase
        exchangeRateSource.value = 'saved'
      } else {
        const resolved = store.getEffectiveExchangeRateWithSource(
          payCurrency.value,
          props.project.baseCurrency,
        )
        exchangeRate.value = resolved.rate
        exchangeRateSource.value = resolved.source
      }
      date.value = props.editingTx.date
      note.value = props.editingTx.note ?? ''
      lastAutoFilledAmount = null
      return
    }

    fromId.value = props.initialFromId || props.project.members[0]?.id || ''
    toId.value = props.initialToId || props.project.members[1]?.id || ''
    payCurrency.value = suggestedCurrency.value
    const initialResolved = resolvePayCurrencyRateToBase(payCurrency.value)
    exchangeRate.value = initialResolved.rate
    exchangeRateSource.value = initialResolved.source
    amount.value = props.suggestedAmount ?? null
    lastAutoFilledAmount = props.suggestedAmount ?? null
    date.value = getTodayIso()
    note.value = ''
  },
  { immediate: true },
)

/** 僅由使用者主動切換幣別時重算匯率與建議金額，避免編輯開啟時覆寫歷史匯率 */
function handleUserCurrencyChange(nextCur: string) {
  const cur = nextCur.trim().toUpperCase()
  if (!cur || !props.project) return
  if (payCurrency.value === cur) return
  payCurrency.value = cur
  const resolved = resolvePayCurrencyRateToBase(cur)
  exchangeRate.value = resolved.rate
  exchangeRateSource.value = resolved.source

  // 新增還款切換幣別時，若使用者尚未手動修改金額則自動依匯率折算金額，避免誤把台幣數字當日幣送出
  if (!props.editingTx) {
    const shouldAutoUpdate =
      amount.value === null ||
      (lastAutoFilledAmount !== null &&
        Math.abs(amount.value - lastAutoFilledAmount) < 0.0001)
    if (shouldAutoUpdate) {
      const converted = computeConvertedSuggestedForCurrency(cur)
      if (converted !== null && converted > 0) {
        amount.value = converted
        lastAutoFilledAmount = converted
      }
    }
  }
}

async function handleRefreshRate() {
  if (!props.project || !needsExchangeRate.value || isFetchingRate.value) return
  isFetchingRate.value = true
  try {
    await store.refreshExchangeRates(true)
    const live = store.getLiveExchangeRate(
      payCurrency.value,
      props.project.baseCurrency,
    )
    if (live !== null && live > 0) {
      exchangeRate.value = live
      exchangeRateSource.value = 'live'
    }
  } finally {
    isFetchingRate.value = false
  }
}

function handleEntryModeSelect(mode: EntryMode) {
  if (mode === 'transfer') return
  emit('switchEntryMode', mode)
}

function fmt(val: number, cur: string): string {
  return formatCurrencyAmount(val, cur, locale.value)
}

function fmtWithCode(val: number, cur: string): string {
  return `${cur.trim().toUpperCase()} ${formatCurrencyNumber(val, cur, locale.value)}`
}

async function handleSubmit() {
  if (isSubmitting.value) return
  errorText.value = ''
  if (!props.project) return

  const numericAmount = amount.value ?? 0
  if (numericAmount <= 0) {
    errorText.value = t('validation.amountRequired')
    return
  }
  if (!fromId.value || !toId.value || fromId.value === toId.value) {
    errorText.value = t('validation.sameMemberSettlement')
    return
  }

  const normalizedPayCurrency = payCurrency.value.trim().toUpperCase()
  const rateToBase = needsExchangeRate.value ? (exchangeRate.value ?? 0) : 1
  if (needsExchangeRate.value && rateToBase <= 0) {
    errorText.value = t('validation.exchangeRateRequired')
    return
  }

  isSubmitting.value = true
  try {
    store.rememberLastExpenseProject(props.project.id)
    if (needsExchangeRate.value && rateToBase > 0) {
      store.rememberExchangeRate(
        normalizedPayCurrency,
        props.project.baseCurrency,
        rateToBase,
      )
    }

    if (props.editingTx) {
      await store.updateTransaction(props.editingTx.id, {
        projectId: props.project.id,
        type: 'transfer',
        amount: numericAmount,
        currency: normalizedPayCurrency,
        exchangeRateToBase: rateToBase,
        categoryKey: 'cat_settlement',
        date: date.value || getTodayIso(),
        time: '00:00',
        note: note.value,
        splitConfig: {
          payerId: fromId.value,
          mode: 'custom_plus_equal',
          shares: [
            {
              memberId: toId.value,
              finalAmount: numericAmount,
              customAmount: numericAmount,
              isIncludedInRemainder: false,
            },
          ],
        },
      })
      emit('saved', t('daily.updatedToast'))
      emit('close')
      return
    }

    await store.recordSettlementPayment({
      projectId: props.project.id,
      fromMemberId: fromId.value,
      toMemberId: toId.value,
      amount: numericAmount,
      currency: normalizedPayCurrency,
      exchangeRateToBase: rateToBase,
      date: date.value || getTodayIso(),
      note: note.value,
    })
    emit('saved', t('settle.paymentRecordedToast'))
    emit('close')
  } catch {
    errorText.value = t('home.saveFailed')
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && project"
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      :aria-label="editingTx ? t('settle.editModalTitle') : t('settle.recordModalTitle')"
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
      @click.self="emit('close')"
    >
      <div
        class="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-[#F2F2F7] shadow-2xl dark:bg-[#0D0D0F] sm:rounded-3xl"
      >
        <!-- Apple 風格頂部 Sheet 標題列（左日期膠囊、中模式切換／標題、右關閉） -->
        <div
          class="relative z-20 flex shrink-0 items-center justify-between gap-2 border-b border-black/5 bg-white/90 px-4 py-3 backdrop-blur-md dark:border-white/10 dark:bg-[#1C1C1E]/95"
        >
          <button
            type="button"
            :aria-expanded="datePanelExpanded"
            class="inline-flex max-w-[116px] shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-semibold transition active:scale-95"
            :class="
              datePanelExpanded || date !== getTodayIso()
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
            "
            @mousedown.prevent
            @click="datePanelExpanded = !datePanelExpanded"
          >
            <Calendar class="h-3.5 w-3.5 shrink-0" />
            <span class="truncate tabular-nums">{{ headerDateLabel }}</span>
          </button>
          <h2
            v-if="editingTx"
            class="truncate text-[15px] font-bold text-slate-900 dark:text-white"
          >
            {{ t('settle.editModalTitle') }}
          </h2>
          <EntryModeSelector
            v-else
            model-value="transfer"
            @select="handleEntryModeSelect"
          />
          <button
            type="button"
            :aria-label="t('settings.close')"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300"
            @mousedown.prevent
            @click="emit('close')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- 展開：日期選擇 -->
        <div
          v-if="datePanelExpanded"
          class="shrink-0 border-b border-black/5 bg-white px-4 py-2.5 dark:border-white/10 dark:bg-[#1C1C1E]"
        >
          <input
            v-model="date"
            type="date"
            class="w-full min-w-0 rounded-xl bg-[#F2F2F7] px-3 py-2 text-xs text-slate-800 dark:bg-[#2C2C2E] dark:text-slate-200"
          />
        </div>

        <form
          id="settlement-payment-form"
          class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5"
          @submit.prevent="handleSubmit"
        >
          <!-- 首頁快速記一筆時顯示目標專案並支援即時切換 -->
          <div
            v-if="allowProjectSwitch && !editingTx && store.activeProjects.length > 0"
            class="flex items-center justify-between gap-2 rounded-2xl bg-white px-3.5 py-2.5 shadow-sm dark:bg-[#1C1C1E]"
          >
            <span class="shrink-0 text-xs font-semibold text-slate-500 dark:text-slate-400">
              {{ t('project.targetProjectLabel') }}
            </span>
            <select
              :value="project.id"
              class="min-w-0 max-w-[230px] truncate rounded-xl bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:bg-[#2C2C2E] dark:text-white"
              @change="emit('switchProject', ($event.target as HTMLSelectElement).value)"
            >
              <option
                v-for="p in store.activeProjects"
                :key="p.id"
                :value="p.id"
              >
                {{ p.name }} ({{ p.baseCurrency }})
              </option>
            </select>
          </div>

          <!-- 分組 1：付款人與收款人 -->
          <div class="grid grid-cols-2 gap-3 rounded-2xl bg-white p-3.5 shadow-sm dark:bg-[#1C1C1E]">
            <div>
              <label class="mb-1 block text-xs font-semibold text-slate-500 dark:text-slate-400">
                {{ t('settle.fromLabel') }}
              </label>
              <select
                v-model="fromId"
                class="w-full rounded-xl bg-[#F2F2F7] px-3 py-2 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:bg-[#2C2C2E] dark:text-white"
              >
                <option
                  v-for="m in project.members"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.name }}
                </option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-xs font-semibold text-slate-500 dark:text-slate-400">
                {{ t('settle.toLabel') }}
              </label>
              <select
                v-model="toId"
                class="w-full rounded-xl bg-[#F2F2F7] px-3 py-2 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:bg-[#2C2C2E] dark:text-white"
              >
                <option
                  v-for="m in project.members"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.name }}
                </option>
              </select>
            </div>
          </div>

          <!-- 分組 2：金額與幣別 -->
          <div class="space-y-2.5 rounded-2xl bg-white p-3.5 shadow-sm dark:bg-[#1C1C1E]">
            <div class="flex flex-wrap items-center justify-between gap-1.5">
              <label class="block text-xs font-semibold text-slate-500 dark:text-slate-400">
                {{ t('settle.paidAmountLabel') }} ({{ payCurrency }})
              </label>

              <!-- 優先置頂快捷切換：記帳幣別第一、結帳幣別第二 -->
              <div class="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold transition"
                  :class="
                    payCurrency === projectBaseCurrency
                      ? 'bg-sky-600 text-white shadow-sm dark:bg-sky-400 dark:text-slate-950'
                      : 'bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/35 hover:bg-sky-500/20 dark:bg-sky-500/15 dark:text-sky-300'
                  "
                  @click="handleUserCurrencyChange(projectBaseCurrency)"
                >
                  <span>
                    {{
                      projectBaseCurrency === projectSettlementCurrency
                        ? t('settle.currencyTagBoth')
                        : t('settle.currencyTagBase')
                    }}
                  </span>
                  <span class="tabular-nums">{{ projectBaseCurrency }}</span>
                </button>

                <button
                  v-if="projectSettlementCurrency !== projectBaseCurrency"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold transition"
                  :class="
                    payCurrency === projectSettlementCurrency
                      ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
                      : 'bg-emerald-500/12 text-emerald-700 ring-1 ring-emerald-500/35 hover:bg-emerald-500/20 dark:bg-emerald-500/15 dark:text-emerald-300'
                  "
                  @click="handleUserCurrencyChange(projectSettlementCurrency)"
                >
                  <span>{{ t('settle.currencyTagSettlement') }}</span>
                  <span class="tabular-nums">{{ projectSettlementCurrency }}</span>
                </button>
              </div>
            </div>
            <CurrencyAmountInput
              v-model="amount"
              :currency="payCurrency"
              :currencies="currencyOptions"
              :currency-labels="currencyOptionLabels"
              show-currency-select
              size="lg"
              autofocus
              placeholder="0"
              @update:currency="handleUserCurrencyChange"
            />
            <p
              v-if="!editingTx && suggestedAmount !== null"
              class="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400"
            >
              <span>
                {{
                  t('settle.remainingHint', {
                    amount: fmtWithCode(suggestedAmount, suggestedCurrency),
                  })
                }}
              </span>
              <span
                v-if="equivalentSuggestedInSelectedCurrency !== null"
                class="inline-flex items-center gap-1 font-bold text-amber-700 dark:text-amber-300"
              >
                <span>
                  ({{
                    t('project.convertedPreview', {
                      amount: fmtWithCode(equivalentSuggestedInSelectedCurrency, payCurrency),
                    })
                  }})
                </span>
                <button
                  v-if="
                    amount === null ||
                    Math.abs(amount - equivalentSuggestedInSelectedCurrency) >= 0.005
                  "
                  type="button"
                  class="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900 transition hover:bg-amber-200 dark:bg-amber-900/60 dark:text-amber-200"
                  @click="applyEquivalentSuggestedAmount"
                >
                  {{ t('settle.applyConvertedAmountButton') }}
                </button>
              </span>
            </p>

            <!-- 還款使用外幣時顯示匯率折算列（例如以當地剩餘現金直接折抵） -->
            <div
              v-if="needsExchangeRate"
              class="space-y-1 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs dark:border-amber-800/60 dark:bg-amber-950/30"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold text-amber-900 dark:text-amber-200">
                  {{ t('project.exchangeRateLabel', { from: payCurrency }) }}
                </span>
                <CurrencyAmountInput
                  v-model="exchangeRate"
                  :allow-decimals="true"
                  :max-decimals="8"
                  size="sm"
                  :placeholder="t('rates.needInputShort')"
                  class="w-28"
                />
                <span class="font-semibold text-amber-900 dark:text-amber-200">
                  {{ project.baseCurrency }}
                </span>
                <span
                  v-if="exchangeRateSource === 'estimated' && exchangeRate !== null && exchangeRate > 0"
                  class="rounded-md bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200"
                >
                  {{ t('rates.sourceEstimatedTag') }}
                </span>
                <button
                  type="button"
                  :disabled="isFetchingRate"
                  class="ml-auto inline-flex items-center gap-1 rounded-md bg-amber-200/70 px-2 py-0.5 text-[10px] font-bold text-amber-900 hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/60 dark:text-amber-200"
                  @click="handleRefreshRate"
                >
                  <RefreshCw
                    class="h-3 w-3"
                    :class="isFetchingRate ? 'animate-spin' : ''"
                  />
                  <span>{{ t('project.refreshLiveRateButton') }}</span>
                </button>
              </div>
              <div
                v-if="exchangeRate === null || exchangeRate <= 0"
                class="text-[11px] font-semibold text-amber-800 dark:text-amber-300"
              >
                {{ t('project.exchangeRateMissingHint') }}
              </div>
              <div
                v-else-if="convertedBasePreview > 0"
                class="text-[11px] font-semibold text-amber-800 dark:text-amber-300"
              >
                {{
                  t('project.convertedPreview', {
                    amount: fmt(convertedBasePreview, project.baseCurrency),
                  })
                }}
              </div>
            </div>
          </div>

          <!-- 分組 3：備註 -->
          <div class="rounded-2xl bg-white px-3.5 py-2 shadow-sm dark:bg-[#1C1C1E]">
            <input
              v-model="note"
              type="text"
              maxlength="1000"
              :placeholder="t('daily.notePlaceholder')"
              class="w-full bg-transparent py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none dark:text-white dark:placeholder-slate-500"
            />
          </div>

          <p
            v-if="errorText"
            role="alert"
            class="rounded-2xl bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-600 dark:bg-rose-950/50 dark:text-rose-300"
          >
            {{ errorText }}
          </p>
        </form>

        <!-- Sticky 固定底部儲存按鈕列 -->
        <div
          class="safe-sticky-pb shrink-0 border-t border-black/5 bg-white/95 px-4 pt-3 backdrop-blur-md dark:border-white/10 dark:bg-[#1C1C1E]/95 sm:pb-3"
        >
          <button
            type="submit"
            form="settlement-payment-form"
            :disabled="isSubmitting"
            class="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-500 dark:text-slate-950"
          >
            <Loader2 v-if="isSubmitting" class="h-4 w-4 animate-spin" />
            <span>
              {{
                editingTx
                  ? t('settle.updatePayment')
                  : t('settle.savePayment')
              }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
