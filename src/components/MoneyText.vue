<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCurrencyParts } from '@/core/currency'

interface Props {
  amount: number
  currency: string
  /** 選填：於金額前加上正負號（如 '+' 或 '-'） */
  prefix?: string
}

const props = withDefaults(defineProps<Props>(), {
  prefix: '',
})

const { locale } = useI18n()

const parts = computed(() =>
  formatCurrencyParts(props.amount, props.currency, locale.value),
)
</script>

<template>
  <span class="inline-flex items-baseline tabular-nums">
    <span v-if="prefix">{{ prefix }}</span>
    <template v-for="(part, idx) in parts" :key="idx">
      <span
        v-if="part.type === 'currency'"
        class="text-[0.5em] font-semibold leading-none tracking-tight opacity-85"
      >{{ part.value }}</span>
      <span v-else>{{ part.value }}</span>
    </template>
  </span>
</template>
