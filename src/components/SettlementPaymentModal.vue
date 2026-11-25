<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, X } from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useModalLayer } from '@/composables/useModalLayer'
import {
  formatCurrencyAmount,
  formatCurrencyNumber,
  fromMinorUnits,
  toMinorUnits,
} from '@/core/currency'
import { getTodayIso } from '@/core/ledgerHelpers'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'

interface Props {
  open: boolean
  project: Project | null
  editingTx: Transaction | null
  initialFromId?: string
  initialToId?: string
  suggestedAmount?: number | null
  currency?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  initialFromId: '',
  initialToId: '',
  suggestedAmount: null,
  currency: null,
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => Boolean(props.open && props.project),
  () => emit('close'),
  dialogRef,
)

let isHydrating = false
let lastAutoFilledAmount: number | null = null
const fromId = ref('')
const toId = ref('')
const amount = ref<number | null>(null)
const payCurrency = ref('TWD')
const exchangeRate = ref<number | null>(1)
const isFetchingRate = ref(false)
const date = ref(getTodayIso())
const note = ref('')
const errorText = ref('')

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

/** 優先置頂排列：1. 結帳幣別、2. 記帳幣別、3. 目前選中／其餘常用幣別 */
const currencyOptions = computed<string[]>(() => {
  const ordered: string[] = []
  const pushUnique = (code: string | undefined | null) => {
    if (!code) return
    const normalized = code.trim().toUpperCase()
    if (normalized && !ordered.includes(normalized)) {
      ordered.push(normalized)
    }
  }
  pushUnique(projectSettlementCurrency.value)
  pushUnique(projectBaseCurrency.value)
  pushUnique(suggestedCurrency.value)
  pushUnique(payCurrency.value)
  for (const code of store.availableCurrencies) {
    pushUnique(code)
  }
  return ordered
})

/** 下拉選單內針對置頂的結帳幣別／記帳幣別顯示明確標記 */
const currencyOptionLabels = computed<Record<string, string>>(() => {
  const labels: Record<string, string> = {}
  const settleCur = projectSettlementCurrency.value
  const baseCur = projectBaseCurrency.value
  for (const code of currencyOptions.value) {
    if (code === settleCur && code === baseCur) {
      labels[code] = `${code} · ${t('settle.currencyTagBothShort')}`
    } else if (code === settleCur) {
      labels[code] = `${code} · ${t('settle.currencyTagSettlementShort')}`
    } else if (code === baseCur) {
      labels[code] = `${code} · ${t('settle.currencyTagBaseShort')}`
    } else {
      labels[code] = code
    }
  }
  return labels
})

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

function computeConvertedSuggestedForCurrency(targetCurrency: string): number | null {
  if (props.editingTx || props.suggestedAmount === null || props.suggestedAmount <= 0) {
    return null
  }
  const origCur = suggestedCurrency.value
  const targetCur = targetCurrency.trim().toUpperCase()
  if (origCur === targetCur) {
    return props.suggestedAmount
  }
  const rate = store.getEffectiveExchangeRate(origCur, targetCur)
  if (!Number.isFinite(rate) || rate <= 0) return null
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
      props.editingTx?.id,
      props.initialFromId,
      props.initialToId,
      props.suggestedAmount,
      props.currency,
    ] as const,
  ([isOpen]) => {
    if (!isOpen || !props.project) return
    isHydrating = true
    errorText.value = ''

    if (props.editingTx && props.editingTx.splitConfig) {
      fromId.value = props.editingTx.splitConfig.payerId
      toId.value = props.editingTx.splitConfig.shares[0]?.memberId ?? ''
      amount.value = props.editingTx.amount
      payCurrency.value = props.editingTx.currency.trim().toUpperCase()
      exchangeRate.value =
        payCurrency.value === props.project.baseCurrency.trim().toUpperCase()
          ? 1
          : props.editingTx.exchangeRateToBase > 0
            ? props.editingTx.exchangeRateToBase
            : store.getEffectiveExchangeRate(
                payCurrency.value,
                props.project.baseCurrency,
              )
      date.value = props.editingTx.date
      note.value = props.editingTx.note ?? ''
      lastAutoFilledAmount = null
      isHydrating = false
      return
    }

    fromId.value = props.initialFromId || props.project.members[0]?.id || ''
    toId.value = props.initialToId || props.project.members[1]?.id || ''
    payCurrency.value = suggestedCurrency.value
    exchangeRate.value =
      payCurrency.value === props.project.baseCurrency.trim().toUpperCase()
        ? 1
        : store.getEffectiveExchangeRate(
            payCurrency.value,
            props.project.baseCurrency,
          )
    amount.value = props.suggestedAmount ?? null
    lastAutoFilledAmount = props.suggestedAmount ?? null
    date.value = getTodayIso()
    note.value = ''
    isHydrating = false
  },
  { immediate: true },
)

watch(payCurrency, (nextCur) => {
  if (isHydrating || !props.project) return
  const base = props.project.baseCurrency.trim().toUpperCase()
  const cur = nextCur.trim().toUpperCase()
  exchangeRate.value =
    cur === base ? 1 : store.getEffectiveExchangeRate(cur, base)

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
})

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
    }
  } finally {
    isFetchingRate.value = false
  }
}

function fmt(val: number, cur: string): string {
  return formatCurrencyAmount(val, cur, locale.value)
}

function fmtWithCode(val: number, cur: string): string {
  return `${cur.trim().toUpperCase()} ${formatCurrencyNumber(val, cur, locale.value)}`
}

async function handleSubmit() {
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

  try {
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
        class="safe-sheet-pb w-full max-w-md rounded-t-3xl border border-slate-200 bg-white px-5 pt-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl sm:pb-5"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-bold text-slate-900 dark:text-white">
            {{
              editingTx
                ? t('settle.editModalTitle')
                : t('settle.recordModalTitle')
            }}
          </h2>
          <button
            type="button"
            :aria-label="t('settings.close')"
            class="rounded-full p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            @click="emit('close')"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <form class="space-y-4" @submit.prevent="handleSubmit">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-1 block text-xs font-semibold text-slate-500">
                {{ t('settle.fromLabel') }}
              </label>
              <select
                v-model="fromId"
                class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
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
              <label class="mb-1 block text-xs font-semibold text-slate-500">
                {{ t('settle.toLabel') }}
              </label>
              <select
                v-model="toId"
                class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
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

          <div class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-1.5">
              <label class="block text-xs font-semibold text-slate-500">
                {{ t('settle.paidAmountLabel') }} ({{ payCurrency }})
              </label>

              <!-- 優先置頂快捷切換：結帳幣別（翡翠綠）、記帳幣別（天藍）醒目標記 -->
              <div class="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold transition"
                  :class="
                    payCurrency === projectSettlementCurrency
                      ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
                      : 'bg-emerald-500/12 text-emerald-700 ring-1 ring-emerald-500/35 hover:bg-emerald-500/20 dark:bg-emerald-500/15 dark:text-emerald-300'
                  "
                  @click="payCurrency = projectSettlementCurrency"
                >
                  <span>
                    {{
                      projectSettlementCurrency === projectBaseCurrency
                        ? t('settle.currencyTagBoth')
                        : t('settle.currencyTagSettlement')
                    }}
                  </span>
                  <span class="tabular-nums">{{ projectSettlementCurrency }}</span>
                </button>

                <button
                  v-if="projectBaseCurrency !== projectSettlementCurrency"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold transition"
                  :class="
                    payCurrency === projectBaseCurrency
                      ? 'bg-sky-600 text-white shadow-sm dark:bg-sky-400 dark:text-slate-950'
                      : 'bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/35 hover:bg-sky-500/20 dark:bg-sky-500/15 dark:text-sky-300'
                  "
                  @click="payCurrency = projectBaseCurrency"
                >
                  <span>{{ t('settle.currencyTagBase') }}</span>
                  <span class="tabular-nums">{{ projectBaseCurrency }}</span>
                </button>
              </div>
            </div>
            <CurrencyAmountInput
              v-model="amount"
              v-model:currency="payCurrency"
              :currencies="currencyOptions"
              :currency-labels="currencyOptionLabels"
              show-currency-select
              size="lg"
              autofocus
              placeholder="0"
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
                  size="sm"
                  placeholder="1"
                  class="w-24"
                />
                <span class="font-semibold text-amber-900 dark:text-amber-200">
                  {{ project.baseCurrency }}
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
                v-if="convertedBasePreview > 0"
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

          <div class="grid grid-cols-2 gap-2.5">
            <input
              v-model="date"
              type="date"
              class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
            <input
              v-model="note"
              type="text"
              :placeholder="t('daily.notePlaceholder')"
              class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
          </div>

          <p v-if="errorText" class="text-xs font-medium text-rose-500">
            {{ errorText }}
          </p>

          <button
            type="submit"
            class="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
          >
            {{
              editingTx
                ? t('settle.updatePayment')
                : t('settle.savePayment')
            }}
          </button>
        </form>
      </div>
    </div>
  </Teleport>
</template>
