<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Percent, RotateCcw } from 'lucide-vue-next'
import {
  formatGroupedNumberInput,
  getCurrencyDecimals,
  parseGroupedNumberInput,
} from '@/core/currency'
import {
  evaluateAmountExpression,
  hasMathExpression,
} from '@/core/expressionEvaluator'
import {
  applyPercentFees,
  computeEffectiveCompoundFeePercent,
} from '@/core/ledgerHelpers'
import { parseCustomFeeRatesJson } from '@/schemas/userPrefsSchema'

const FEE_RATES_STORAGE_KEY = 'clearbill_custom_fee_rates_v1'

function loadSavedFeeRates(): { service: number; fx: number } {
  const defaults = { service: 10, fx: 1.5 }
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(FEE_RATES_STORAGE_KEY)
    return parseCustomFeeRatesJson(raw, defaults)
  } catch {
    return defaults
  }
}

function persistFeeRates(service: number, fx: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      FEE_RATES_STORAGE_KEY,
      JSON.stringify({ service, fx }),
    )
  } catch {
    // 忽略受限儲存環境
  }
}

interface Props {
  modelValue: number | null
  currency?: string
  currencies?: string[]
  currencyLabels?: Record<string, string>
  showCurrencySelect?: boolean
  allowDecimals?: boolean
  enableExpression?: boolean
  showServiceFeeButton?: boolean
  showFxFeeButton?: boolean
  showMathToolbar?: boolean
  placeholder?: string
  size?: 'sm' | 'md' | 'lg'
  autofocus?: boolean
  align?: 'left' | 'right'
}

const props = withDefaults(defineProps<Props>(), {
  currency: 'TWD',
  currencies: undefined,
  currencyLabels: undefined,
  showCurrencySelect: false,
  allowDecimals: undefined,
  enableExpression: false,
  showServiceFeeButton: false,
  showFxFeeButton: false,
  showMathToolbar: false,
  placeholder: '0',
  size: 'md',
  autofocus: false,
  align: 'right',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: number | null): void
  (e: 'update:currency', value: string): void
}>()

const { t } = useI18n()

const savedRates = loadSavedFeeRates()
const inputElRef = ref<HTMLInputElement | null>(null)
const isFocused = ref(false)

/** 可反悔的加成原價基數與各自獨立的開關／自訂百分比（可分開或同時疊加套用） */
const feeBase = ref<number | null>(null)
const serviceFeeEnabled = ref(false)
const fxFeeEnabled = ref(false)
const feePanelExpanded = ref(false)
const feeAutoClearedNotice = ref(false)
let feeNoticeTimer: ReturnType<typeof setTimeout> | null = null
const serviceFeePercentInput = ref<string>(String(savedRates.service))
const fxFeePercentInput = ref<string>(String(savedRates.fx))

const parsedServiceFeePercent = computed<number>(() => {
  const n = Number(serviceFeePercentInput.value)
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0
})

const parsedFxFeePercent = computed<number>(() => {
  const n = Number(fxFeePercentInput.value)
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0
})

const effectiveAllowDecimals = computed(() => {
  if (props.allowDecimals !== undefined) return props.allowDecimals
  return getCurrencyDecimals(props.currency) > 0
})

const targetDecimals = computed(() =>
  effectiveAllowDecimals.value ? Math.max(2, getCurrencyDecimals(props.currency)) : 0,
)

const displayValue = ref(
  props.modelValue !== null && props.modelValue !== undefined
    ? formatGroupedNumberInput(props.modelValue, effectiveAllowDecimals.value)
    : '',
)

const isExpressionInput = computed(
  () => props.enableExpression && hasMathExpression(displayValue.value),
)

const evaluatedExpressionValue = computed<number | null>(() => {
  if (!isExpressionInput.value) return null
  return evaluateAmountExpression(displayValue.value, targetDecimals.value)
})

const formattedExpressionPreview = computed(() => {
  if (evaluatedExpressionValue.value === null) return ''
  return formatGroupedNumberInput(
    evaluatedExpressionValue.value,
    effectiveAllowDecimals.value,
  )
})

const formattedFeeBase = computed(() => {
  if (feeBase.value === null) return ''
  return formatGroupedNumberInput(feeBase.value, effectiveAllowDecimals.value)
})

const isAnyFeeApplied = computed(
  () => feeBase.value !== null && (serviceFeeEnabled.value || fxFeeEnabled.value),
)

const hasPositiveInput = computed(() => {
  if (isAnyFeeApplied.value) return true
  const val = isExpressionInput.value
    ? evaluatedExpressionValue.value
    : parseGroupedNumberInput(displayValue.value)
  return val !== null && val > 0
})

const appliedFeeSummary = computed(() => {
  const parts: string[] = []
  const s = serviceFeeEnabled.value && parsedServiceFeePercent.value > 0 ? parsedServiceFeePercent.value : null
  const f = fxFeeEnabled.value && parsedFxFeePercent.value > 0 ? parsedFxFeePercent.value : null
  if (s !== null) {
    parts.push(`${t('project.serviceFeeShort')} +${s}%`)
  }
  if (f !== null) {
    parts.push(`${t('project.fxFeeShort')} +${f}%`)
  }
  if (s !== null && f !== null) {
    const compoundPct = computeEffectiveCompoundFeePercent(s, f)
    return `${parts.join(' × ')} (= +${compoundPct}%)`
  }
  return parts.join('、')
})

function clearFeeNotice() {
  feeAutoClearedNotice.value = false
  if (feeNoticeTimer) {
    clearTimeout(feeNoticeTimer)
    feeNoticeTimer = null
  }
}

function showFeeAutoClearedNotice() {
  clearFeeNotice()
  feeAutoClearedNotice.value = true
  feeNoticeTimer = setTimeout(() => {
    feeAutoClearedNotice.value = false
    feeNoticeTimer = null
  }, 3200)
}

function resetFeeState(notifyIfCleared = false) {
  const hadAppliedFee =
    feeBase.value !== null && (serviceFeeEnabled.value || fxFeeEnabled.value)
  feeBase.value = null
  serviceFeeEnabled.value = false
  fxFeeEnabled.value = false
  if (notifyIfCleared && hadAppliedFee) {
    showFeeAutoClearedNotice()
  }
}

onBeforeUnmount(() => {
  clearFeeNotice()
})

function recalculateWithCurrentFees() {
  if (feeBase.value === null) return
  if (!serviceFeeEnabled.value && !fxFeeEnabled.value) {
    const original = feeBase.value
    feeBase.value = null
    displayValue.value = formatGroupedNumberInput(
      original,
      effectiveAllowDecimals.value,
    )
    emit('update:modelValue', original)
    return
  }

  const nextVal = applyPercentFees(
    feeBase.value,
    serviceFeeEnabled.value ? parsedServiceFeePercent.value : null,
    fxFeeEnabled.value ? parsedFxFeePercent.value : null,
    targetDecimals.value,
  )
  displayValue.value = formatGroupedNumberInput(
    nextVal,
    effectiveAllowDecimals.value,
  )
  emit('update:modelValue', nextVal)
}

watch(
  () => [props.modelValue, effectiveAllowDecimals.value] as const,
  ([nextVal, allowDec]) => {
    if (nextVal === null || nextVal === undefined) {
      resetFeeState()
      if (displayValue.value !== '') {
        displayValue.value = ''
      }
      return
    }
    const currentParsed = isExpressionInput.value
      ? evaluatedExpressionValue.value
      : parseGroupedNumberInput(displayValue.value)
    if (currentParsed !== nextVal) {
      resetFeeState()
      displayValue.value = formatGroupedNumberInput(nextVal, allowDec)
    }
  },
)

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement
  const raw = target.value
  // 手動修改主金額時自動解除加成鎖定，若先前已勾選費用則明確提示使用者避免漏算
  resetFeeState(true)

  if (props.enableExpression && hasMathExpression(raw)) {
    const sanitized = raw.replace(/[^\d.,+\-*/()%×÷＋－（）％xX\s]/g, '')
    displayValue.value = sanitized
    if (target.value !== sanitized) {
      target.value = sanitized
    }
    const evaluated = evaluateAmountExpression(sanitized, targetDecimals.value)
    emit('update:modelValue', evaluated)
    return
  }

  const formatted = formatGroupedNumberInput(raw, effectiveAllowDecimals.value)
  displayValue.value = formatted
  if (target.value !== formatted) {
    target.value = formatted
  }
  const parsed = parseGroupedNumberInput(formatted)
  emit('update:modelValue', parsed)
}

function commitExpressionIfValid() {
  if (!isExpressionInput.value) return
  if (evaluatedExpressionValue.value !== null) {
    const formatted = formatGroupedNumberInput(
      evaluatedExpressionValue.value,
      effectiveAllowDecimals.value,
    )
    displayValue.value = formatted
    emit('update:modelValue', evaluatedExpressionValue.value)
  }
}

function handleBlur() {
  isFocused.value = false
  commitExpressionIfValid()
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && isExpressionInput.value) {
    event.preventDefault()
    commitExpressionIfValid()
  }
}

function appendOperator(op: '+' | '-' | '×' | '÷') {
  if (!props.enableExpression) return
  resetFeeState()
  const current = displayValue.value.trim()
  if (!current) return

  // 若尾端已是運算子，直接替換避免出現 "100+×"
  const replaced = /[+\-×÷*/]$/.test(current)
    ? `${current.slice(0, -1)}${op}`
    : `${current}${op}`

  displayValue.value = replaced
  const evaluated = evaluateAmountExpression(replaced, targetDecimals.value)
  if (evaluated !== null) {
    emit('update:modelValue', evaluated)
  }
  inputElRef.value?.focus()
}

function ensureFeeBase(): boolean {
  if (feeBase.value !== null) return true
  const currentVal = isExpressionInput.value
    ? evaluatedExpressionValue.value
    : parseGroupedNumberInput(displayValue.value)
  if (currentVal === null || currentVal <= 0) return false
  feeBase.value = currentVal
  return true
}

function toggleServiceFee() {
  clearFeeNotice()
  if (serviceFeeEnabled.value) {
    serviceFeeEnabled.value = false
    recalculateWithCurrentFees()
    return
  }
  if (parsedServiceFeePercent.value <= 0) return
  if (!ensureFeeBase()) return
  serviceFeeEnabled.value = true
  persistFeeRates(
    parsedServiceFeePercent.value || savedRates.service,
    parsedFxFeePercent.value || savedRates.fx,
  )
  recalculateWithCurrentFees()
}

function toggleFxFee() {
  clearFeeNotice()
  if (fxFeeEnabled.value) {
    fxFeeEnabled.value = false
    recalculateWithCurrentFees()
    return
  }
  if (parsedFxFeePercent.value <= 0) return
  if (!ensureFeeBase()) return
  fxFeeEnabled.value = true
  persistFeeRates(
    parsedServiceFeePercent.value || savedRates.service,
    parsedFxFeePercent.value || savedRates.fx,
  )
  recalculateWithCurrentFees()
}

function handleServiceFeeRateChange() {
  if (parsedServiceFeePercent.value > 0) {
    persistFeeRates(
      parsedServiceFeePercent.value,
      parsedFxFeePercent.value || savedRates.fx,
    )
  }
  if (serviceFeeEnabled.value) {
    if (parsedServiceFeePercent.value <= 0) {
      serviceFeeEnabled.value = false
    }
    recalculateWithCurrentFees()
  }
}

function handleFxFeeRateChange() {
  if (parsedFxFeePercent.value > 0) {
    persistFeeRates(
      parsedServiceFeePercent.value || savedRates.service,
      parsedFxFeePercent.value,
    )
  }
  if (fxFeeEnabled.value) {
    if (parsedFxFeePercent.value <= 0) {
      fxFeeEnabled.value = false
    }
    recalculateWithCurrentFees()
  }
}

function cancelAllFees() {
  if (feeBase.value === null) return
  serviceFeeEnabled.value = false
  fxFeeEnabled.value = false
  recalculateWithCurrentFees()
}

function handleCurrencyChange(event: Event) {
  const target = event.target as HTMLSelectElement
  emit('update:currency', target.value)
}

const sizeClasses = computed(() => {
  if (props.size === 'lg') {
    return {
      wrapper: 'rounded-2xl',
      select: 'w-[86px] py-3 pl-2.5 pr-1 text-xs font-bold',
      input: 'px-3.5 py-3 text-xl font-bold',
    }
  }
  if (props.size === 'sm') {
    return {
      wrapper: 'rounded-lg',
      select: 'w-[76px] py-1.5 pl-2 pr-1 text-[11px] font-bold',
      input: 'px-2.5 py-1.5 text-sm font-medium',
    }
  }
  return {
    wrapper: 'rounded-xl',
    select: 'w-[82px] py-2.5 pl-2 pr-1 text-xs font-bold',
    input: 'px-3 py-2.5 text-base font-bold',
  }
})
</script>

<template>
  <div class="space-y-2">
    <div
      class="flex items-stretch overflow-hidden border border-slate-200 bg-slate-50 transition focus-within:border-emerald-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-emerald-500/20 dark:border-slate-700 dark:bg-slate-800 dark:focus-within:bg-slate-950"
      :class="sizeClasses.wrapper"
    >
      <select
        v-if="showCurrencySelect && currencies && currencies.length > 0"
        :value="currency"
        class="max-w-[140px] shrink-0 truncate border-r border-slate-200 bg-slate-100/80 text-slate-700 focus:outline-none dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-200"
        :class="sizeClasses.select"
        @change="handleCurrencyChange"
      >
        <option v-for="code in currencies" :key="code" :value="code">
          {{ currencyLabels?.[code] ?? code }}
        </option>
      </select>

      <!-- 始終保留手機友善數字鍵盤 inputmode="decimal"，搭配下方迷你運算按鈕列支援算式 -->
      <input
        ref="inputElRef"
        :value="displayValue"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        :autofocus="autofocus"
        :placeholder="placeholder"
        class="min-w-0 flex-1 bg-transparent tabular-nums text-slate-900 placeholder-slate-400 focus:outline-none dark:text-white dark:placeholder-slate-500"
        :class="[
          sizeClasses.input,
          align === 'right' ? 'text-right' : 'text-left',
        ]"
        @focus="isFocused = true"
        @input="handleInput"
        @blur="handleBlur"
        @keydown="handleKeydown"
      />
    </div>

    <!-- 同一排整合：加減乘除算式按鈕 ＋ 服務費／刷卡費按需展開膠囊 -->
    <div
      v-if="
        (enableExpression && (showMathToolbar || isFocused || isExpressionInput)) ||
        showServiceFeeButton ||
        showFxFeeButton
      "
      class="space-y-1.5"
    >
      <div class="flex flex-wrap items-center justify-between gap-1.5 px-0.5">
        <div
          v-if="enableExpression && (showMathToolbar || isFocused || isExpressionInput)"
          class="flex items-center gap-1"
        >
          <button
            v-for="op in (['+', '-', '×', '÷'] as const)"
            :key="op"
            type="button"
            class="inline-flex h-7 min-w-[30px] items-center justify-center rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 shadow-xs transition hover:bg-slate-100 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            @mousedown.prevent
            @click="appendOperator(op)"
          >
            {{ op }}
          </button>
          <button
            v-if="isExpressionInput && evaluatedExpressionValue !== null"
            type="button"
            class="inline-flex h-7 items-center justify-center rounded-lg bg-emerald-600 px-2.5 text-xs font-bold text-white shadow-xs transition hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:text-slate-950"
            @mousedown.prevent
            @click="commitExpressionIfValid"
          >
            =
          </button>
        </div>

        <button
          v-if="showServiceFeeButton || showFxFeeButton"
          type="button"
          class="ml-auto inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold transition active:scale-95"
          :class="
            isAnyFeeApplied
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
              : feePanelExpanded
                ? 'border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
                : 'border-slate-200 bg-slate-50 text-slate-500 hover:border-emerald-400 hover:text-emerald-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-400 dark:hover:text-emerald-300'
          "
          @mousedown.prevent
          @click="feePanelExpanded = !feePanelExpanded"
        >
          <Percent class="h-3 w-3 shrink-0" />
          <span>{{ t('project.feePanelToggle') }}</span>
          <ChevronDown
            class="h-3 w-3 shrink-0 transition-transform duration-200"
            :class="feePanelExpanded ? 'rotate-180' : ''"
          />
        </button>
      </div>

      <!-- 算式即時求值預覽（僅於輸入算式時顯示） -->
      <div
        v-if="enableExpression && isExpressionInput"
        class="px-0.5 text-right text-[11px]"
      >
        <span
          v-if="evaluatedExpressionValue !== null"
          class="font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
        >
          = {{ formattedExpressionPreview }}
        </span>
        <span
          v-else
          class="font-medium text-amber-600 dark:text-amber-400"
        >
          {{ t('project.expressionIncomplete') }}
        </span>
      </div>

      <div
        v-if="(showServiceFeeButton || showFxFeeButton) && feePanelExpanded"
        class="grid gap-1.5"
        :class="showServiceFeeButton && showFxFeeButton ? 'grid-cols-2' : 'grid-cols-1'"
      >
        <!-- 服務費自訂 % 與確認／取消鈕 -->
        <div
          v-if="showServiceFeeButton"
          class="flex items-center justify-between gap-1 rounded-xl border px-1.5 py-1.5 transition sm:px-2"
          :class="
            serviceFeeEnabled
              ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500/80 dark:bg-emerald-950/50 dark:text-emerald-200'
              : 'border-slate-200 bg-slate-50/80 text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200'
          "
        >
          <button
            type="button"
            :disabled="!serviceFeeEnabled && (!hasPositiveInput || parsedServiceFeePercent <= 0)"
            :aria-pressed="serviceFeeEnabled"
            class="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-45"
            @mousedown.prevent
            @click="toggleServiceFee"
          >
            <span
              class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition"
              :class="
                serviceFeeEnabled
                  ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-slate-950'
                  : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900'
              "
            >
              <Check v-if="serviceFeeEnabled" class="h-3 w-3" />
            </span>
            <span class="truncate">{{ t('project.serviceFeeShort') }}</span>
          </button>

          <div
            class="flex shrink-0 items-center rounded-lg border border-slate-200 bg-white px-1 py-0.5 dark:border-slate-700 dark:bg-slate-900 sm:px-1.5"
          >
            <input
              v-model="serviceFeePercentInput"
              type="number"
              min="0"
              max="100"
              step="any"
              inputmode="decimal"
              :aria-label="t('project.serviceFeeShort')"
              class="w-14 bg-transparent text-right text-[11px] font-bold tabular-nums text-slate-900 focus:outline-none dark:text-white sm:w-11"
              @input="handleServiceFeeRateChange"
              @keyup.enter.prevent="!serviceFeeEnabled && toggleServiceFee()"
            />
            <span class="ml-0.5 text-[10px] font-bold text-slate-400">%</span>
          </div>
        </div>

        <!-- 刷卡手續費自訂 % 與確認／取消鈕 -->
        <div
          v-if="showFxFeeButton"
          class="flex items-center justify-between gap-1 rounded-xl border px-1.5 py-1.5 transition sm:px-2"
          :class="
            fxFeeEnabled
              ? 'border-amber-500 bg-amber-50 text-amber-950 dark:border-amber-500/80 dark:bg-amber-950/50 dark:text-amber-200'
              : 'border-slate-200 bg-slate-50/80 text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200'
          "
        >
          <button
            type="button"
            :disabled="!fxFeeEnabled && (!hasPositiveInput || parsedFxFeePercent <= 0)"
            :aria-pressed="fxFeeEnabled"
            class="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-45"
            @mousedown.prevent
            @click="toggleFxFee"
          >
            <span
              class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition"
              :class="
                fxFeeEnabled
                  ? 'border-amber-500 bg-amber-500 text-slate-950'
                  : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900'
              "
            >
              <Check v-if="fxFeeEnabled" class="h-3 w-3" />
            </span>
            <span class="truncate">{{ t('project.fxFeeShort') }}</span>
          </button>

          <div
            class="flex shrink-0 items-center rounded-lg border border-slate-200 bg-white px-1 py-0.5 dark:border-slate-700 dark:bg-slate-900 sm:px-1.5"
          >
            <input
              v-model="fxFeePercentInput"
              type="number"
              min="0"
              max="100"
              step="any"
              inputmode="decimal"
              :aria-label="t('project.fxFeeShort')"
              class="w-14 bg-transparent text-right text-[11px] font-bold tabular-nums text-slate-900 focus:outline-none dark:text-white sm:w-11"
              @input="handleFxFeeRateChange"
              @keyup.enter.prevent="!fxFeeEnabled && toggleFxFee()"
            />
            <span class="ml-0.5 text-[10px] font-bold text-slate-400">%</span>
          </div>
        </div>
      </div>

      <!-- 已套用費用時顯示於下方的「點一下取消還原」按鈕條 -->
      <button
        v-if="isAnyFeeApplied"
        type="button"
        class="flex w-full items-center justify-between gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/70 px-3 py-1.5 text-[11px] font-semibold text-emerald-800 transition hover:bg-emerald-100/80 active:scale-[0.99] dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200"
        @mousedown.prevent
        @click="cancelAllFees"
      >
        <span class="truncate">
          {{
            t('project.feeAppliedTapToCancel', {
              base: formattedFeeBase,
              summary: appliedFeeSummary,
            })
          }}
        </span>
        <span class="inline-flex shrink-0 items-center gap-1 font-bold text-rose-600 dark:text-rose-400">
          <RotateCcw class="h-3 w-3" />
          <span>{{ t('project.feeCancelShort') }}</span>
        </span>
      </button>
      <!-- 手動改動主金額自動解除服務費／刷卡費時的輕量提醒 -->
      <p
        v-else-if="feeAutoClearedNotice"
        class="rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-1.5 text-[11px] font-medium text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200"
      >
        {{ t('project.feeAutoClearedHint') }}
      </p>
    </div>
  </div>
</template>
