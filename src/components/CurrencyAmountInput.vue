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

watch(
  () => [props.modelValue, effectiveAllowDecimals.value] as const,
  ([nextVal, allowDec]) => {
    if (nextVal === null || nextVal === undefined) {
      if (displayValue.value !== '') {
        displayValue.value = ''
      }
      return
    }
    const currentParsed = isExpressionInput.value
      ? evaluatedExpressionValue.value
      : parseGroupedNumberInput(displayValue.value)
    if (currentParsed !== nextVal) {
      displayValue.value = formatGroupedNumberInput(nextVal, allowDec)
    }
  },
)

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement
  const raw = target.value

  if (props.enableExpression && hasMathExpression(raw)) {
    // 允許數字、小數點、千分位逗號與常用加減乘除括號百分比符號
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

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && isExpressionInput.value) {
    event.preventDefault()
    commitExpressionIfValid()
  }
}

function applyServiceFeeTenPercent() {
  const baseVal = isExpressionInput.value
    ? evaluatedExpressionValue.value
    : parseGroupedNumberInput(displayValue.value)
  if (baseVal === null || baseVal <= 0) return

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
  <div class="space-y-1">
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

      <input
        :value="displayValue"
        type="text"
        :inputmode="enableExpression ? 'text' : 'decimal'"
        autocomplete="off"
        :autofocus="autofocus"
        :placeholder="placeholder"
        class="min-w-0 flex-1 bg-transparent tabular-nums text-slate-900 placeholder-slate-400 focus:outline-none dark:text-white dark:placeholder-slate-500"
        :class="[
          sizeClasses.input,
          align === 'right' ? 'text-right' : 'text-left',
        ]"
        @input="handleInput"
        @blur="commitExpressionIfValid"
        @keydown="handleKeydown"
      />

      <button
        v-if="showServiceFeeButton"
        type="button"
        :disabled="(modelValue ?? 0) <= 0"
        :title="t('project.serviceFeeTitle')"
        class="shrink-0 border-l border-slate-200 bg-emerald-50/80 font-bold text-emerald-700 transition hover:bg-emerald-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-950/80"
        :class="sizeClasses.feeBtn"
        @click="applyServiceFeeTenPercent"
      >
        +10%
      </button>
    </div>

    <!-- 算式即時運算結果預覽列 -->
    <div
      v-if="isExpressionInput"
      class="flex items-center justify-between px-1 text-[11px]"
    >
      <span class="text-slate-400 dark:text-slate-500">
        {{ t('project.expressionHint') }}
      </span>
      <span
        v-if="evaluatedExpressionValue !== null"
        class="font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
      >
        = {{ formattedExpressionPreview }}
      </span>
      <span v-else class="font-medium text-amber-600 dark:text-amber-400">
        {{ t('project.expressionIncomplete') }}
      </span>
    </div>
  </div>
</template>
