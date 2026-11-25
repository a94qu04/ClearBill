<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, RotateCcw } from 'lucide-vue-next'
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

const FEE_RATES_STORAGE_KEY = 'clearbill_custom_fee_rates_v1'

function loadSavedFeeRates(): { service: number; fx: number } {
  const defaults = { service: 10, fx: 1.5 }
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(FEE_RATES_STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<{ service: number; fx: number }>
    return {
      service:
        typeof parsed.service === 'number' &&
        Number.isFinite(parsed.service) &&
        parsed.service > 0 &&
        parsed.service <= 100
          ? parsed.service
          : 10,
      fx:
        typeof parsed.fx === 'number' &&
        Number.isFinite(parsed.fx) &&
        parsed.fx > 0 &&
        parsed.fx <= 100
          ? parsed.fx
          : 1.5,
    }
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

function resetFeeState() {
  feeBase.value = null
  serviceFeeEnabled.value = false
  fxFeeEnabled.value = false
}

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
  // 手動修改主金額時自動解除加成鎖定，避免原價基準與當前數字脫鉤
  resetFeeState()

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
      select: 'w-[72px] py-3 pl-2.5 pr-1 text-xs font-bold',
      input: 'px-3.5 py-3 text-xl font-bold',
    }
  }
  if (props.size === 'sm') {
    return {
      wrapper: 'rounded-lg',
      select: 'w-[62px] py-1.5 pl-2 pr-1 text-[11px] font-bold',
      input: 'px-2.5 py-1.5 text-sm font-medium',
    }
  }
  return {
    wrapper: 'rounded-xl',
    select: 'w-[68px] py-2.5 pl-2 pr-1 text-xs font-bold',
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
        class="shrink-0 border-r border-slate-200 bg-slate-100/80 text-slate-700 focus:outline-none dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-200"
        :class="sizeClasses.select"
        @change="handleCurrencyChange"
      >
        <option v-for="code in currencies" :key="code" :value="code">
          {{ code }}
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

    <!-- 手機友善迷你運算按鈕列（不犧牲數字鍵盤，也能一指點加減乘除） -->
    <div
      v-if="enableExpression && (showMathToolbar || isFocused || isExpressionInput)"
      class="flex flex-wrap items-center justify-between gap-1.5 px-0.5"
    >
      <div class="flex flex-wrap items-center gap-1">
        <button
          v-for="op in (['+', '-', '×', '÷'] as const)"
          :key="op"
          type="button"
          class="inline-flex h-6 min-w-[28px] items-center justify-center rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-100 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          @mousedown.prevent
          @click="appendOperator(op)"
        >
          {{ op }}
        </button>
        <button
          v-if="isExpressionInput && evaluatedExpressionValue !== null"
          type="button"
          class="inline-flex h-6 items-center justify-center rounded-lg bg-emerald-600 px-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:text-slate-950"
          @mousedown.prevent
          @click="commitExpressionIfValid"
        >
          =
        </button>
      </div>

      <div class="text-[11px]">
        <span
          v-if="isExpressionInput && evaluatedExpressionValue !== null"
          class="font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
        >
          = {{ formattedExpressionPreview }}
        </span>
        <span
          v-else-if="isExpressionInput"
          class="font-medium text-amber-600 dark:text-amber-400"
        >
          {{ t('project.expressionIncomplete') }}
        </span>
      </div>
    </div>

    <!-- 數字下方：可自訂 % 數之「服務費」與「刷卡手續費」互動開關列（點一下確認套用／再點取消） -->
    <div
      v-if="showServiceFeeButton || showFxFeeButton"
      class="space-y-1.5"
    >
      <div
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
              class="w-9 bg-transparent text-right text-[11px] font-bold tabular-nums text-slate-900 focus:outline-none dark:text-white"
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
              class="w-9 bg-transparent text-right text-[11px] font-bold tabular-nums text-slate-900 focus:outline-none dark:text-white"
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
    </div>
  </div>
</template>
