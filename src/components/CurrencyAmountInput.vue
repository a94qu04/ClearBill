<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  formatGroupedNumberInput,
  getCurrencyDecimals,
  parseGroupedNumberInput,
} from '@/core/currency'

interface Props {
  modelValue: number | null
  currency?: string
  currencies?: string[]
  showCurrencySelect?: boolean
  allowDecimals?: boolean
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
  placeholder: '0',
  size: 'md',
  autofocus: false,
  align: 'right',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: number | null): void
  (e: 'update:currency', value: string): void
}>()

const effectiveAllowDecimals = computed(() => {
  if (props.allowDecimals !== undefined) return props.allowDecimals
  return getCurrencyDecimals(props.currency) > 0
})

const displayValue = ref(
  props.modelValue !== null && props.modelValue !== undefined
    ? formatGroupedNumberInput(props.modelValue, effectiveAllowDecimals.value)
    : '',
)

watch(
  () => [props.modelValue, effectiveAllowDecimals.value] as const,
  ([nextVal, allowDec]) => {
    const currentParsed = parseGroupedNumberInput(displayValue.value)
    if (nextVal === null || nextVal === undefined) {
      if (displayValue.value !== '') {
        displayValue.value = ''
      }
      return
    }
    if (currentParsed !== nextVal) {
      displayValue.value = formatGroupedNumberInput(nextVal, allowDec)
    }
  },
)

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement
  const formatted = formatGroupedNumberInput(
    target.value,
    effectiveAllowDecimals.value,
  )
  displayValue.value = formatted
  if (target.value !== formatted) {
    target.value = formatted
  }
  const parsed = parseGroupedNumberInput(formatted)
  emit('update:modelValue', parsed)
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
      inputmode="decimal"
      autocomplete="off"
      :autofocus="autofocus"
      :placeholder="placeholder"
      class="min-w-0 flex-1 bg-transparent tabular-nums text-slate-900 placeholder-slate-400 focus:outline-none dark:text-white dark:placeholder-slate-500"
      :class="[
        sizeClasses.input,
        align === 'right' ? 'text-right' : 'text-left',
      ]"
      @input="handleInput"
    />
  </div>
</template>
