<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  formatGroupedNumberInput,
  getCurrencyDecimals,
  parseGroupedNumberInput,
} from '@/core/currency'
import {
  evaluateAmountExpression,
  hasMathExpression,
} from '@/core/expressionEvaluator'

interface Props {
  modelValue: number | null
  currency?: string
  currencies?: string[]
  showCurrencySelect?: boolean
  allowDecimals?: boolean
  enableExpression?: boolean
  showServiceFeeButton?: boolean
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

const inputElRef = ref<HTMLInputElement | null>(null)
const isFocused = ref(false)
/** 可反悔的 +10% 服務費原始基數：非 null 代表目前已套用 +10%，再點一次還原原價 */
const serviceFeeBase = ref<number | null>(null)

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

const formattedServiceFeeBase = computed(() => {
  if (serviceFeeBase.value === null) return ''
  return formatGroupedNumberInput(
    serviceFeeBase.value,
    effectiveAllowDecimals.value,
  )
})

const isServiceFeeApplied = computed(() => serviceFeeBase.value !== null)

watch(
  () => [props.modelValue, effectiveAllowDecimals.value] as const,
  ([nextVal, allowDec]) => {
    if (nextVal === null || nextVal === undefined) {
      serviceFeeBase.value = null
      if (displayValue.value !== '') {
        displayValue.value = ''
      }
      return
    }
    const currentParsed = isExpressionInput.value
      ? evaluatedExpressionValue.value
      : parseGroupedNumberInput(displayValue.value)
    if (currentParsed !== nextVal) {
      serviceFeeBase.value = null
      displayValue.value = formatGroupedNumberInput(nextVal, allowDec)
    }
  },
)

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement
  const raw = target.value
  // 手動修改數值時自動解除 +10% 狀態鎖定，避免原價基準與當前數字脫鉤
  serviceFeeBase.value = null

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
  serviceFeeBase.value = null
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

function toggleServiceFeeTenPercent() {
  // 若已套用 +10%，再點一次直接還原原價（防誤觸連點變 +21%）
  if (serviceFeeBase.value !== null) {
    const original = serviceFeeBase.value
    serviceFeeBase.value = null
    displayValue.value = formatGroupedNumberInput(
      original,
      effectiveAllowDecimals.value,
    )
    emit('update:modelValue', original)
    return
  }

  const baseVal = isExpressionInput.value
    ? evaluatedExpressionValue.value
    : parseGroupedNumberInput(displayValue.value)
  if (baseVal === null || baseVal <= 0) return

  serviceFeeBase.value = baseVal
  const factor = 10 ** targetDecimals.value
  const withFee = Math.round(baseVal * 1.1 * factor) / factor
  displayValue.value = formatGroupedNumberInput(
    withFee,
    effectiveAllowDecimals.value,
  )
  emit('update:modelValue', withFee)
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
      feeBtn: 'px-2.5 text-xs',
    }
  }
  if (props.size === 'sm') {
    return {
      wrapper: 'rounded-lg',
      select: 'w-[62px] py-1.5 pl-2 pr-1 text-[11px] font-bold',
      input: 'px-2.5 py-1.5 text-sm font-medium',
      feeBtn: 'px-1.5 text-[10px]',
    }
  }
  return {
    wrapper: 'rounded-xl',
    select: 'w-[68px] py-2.5 pl-2 pr-1 text-xs font-bold',
    input: 'px-3 py-2.5 text-base font-bold',
    feeBtn: 'px-2 text-[11px]',
  }
})
</script>

<template>
  <div class="space-y-1.5">
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

      <!-- 可反悔之 +10% 服務費開關（已套用時高亮，再點一下還原原價） -->
      <button
        v-if="showServiceFeeButton"
        type="button"
        :disabled="!isServiceFeeApplied && (modelValue ?? 0) <= 0"
        :aria-pressed="isServiceFeeApplied"
        :title="
          isServiceFeeApplied
            ? t('project.serviceFeeUndoTitle')
            : t('project.serviceFeeTitle')
        "
        class="shrink-0 border-l border-slate-200 font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700"
        :class="[
          sizeClasses.feeBtn,
          isServiceFeeApplied
            ? 'bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950'
            : 'bg-emerald-50/80 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-950/80',
        ]"
        @mousedown.prevent
        @click="toggleServiceFeeTenPercent"
      >
        {{ isServiceFeeApplied ? '+10% ✓' : '+10%' }}
      </button>
    </div>

    <!-- 手機友善迷你運算按鈕列（不犧牲數字鍵盤，也能一指點加減乘除） -->
    <div
      v-if="enableExpression && (showMathToolbar || isFocused || isExpressionInput)"
      class="flex flex-wrap items-center justify-between gap-1.5 px-0.5"
    >
      <div class="flex items-center gap-1">
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
        <span
          v-else-if="isServiceFeeApplied"
          class="font-semibold text-emerald-700 dark:text-emerald-400"
        >
          {{ t('project.serviceFeeAppliedHint', { base: formattedServiceFeeBase }) }}
        </span>
      </div>
    </div>

    <!-- 若未顯示運算列但已套用 +10% 服務費，仍顯示可還原提示 -->
    <div
      v-else-if="isServiceFeeApplied"
      class="px-1 text-right text-[11px] font-semibold text-emerald-700 dark:text-emerald-400"
    >
      {{ t('project.serviceFeeAppliedHint', { base: formattedServiceFeeBase }) }}
    </div>
  </div>
</template>
