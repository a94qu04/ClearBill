<script setup lang="ts">
import { computed } from 'vue'
import { getFirstGrapheme } from '@/core/ledgerHelpers'

interface Props {
  name: string
  color?: string
  image?: string
  size?: 'micro' | 'xxs' | 'xs' | 'sm' | 'md' | 'lg'
  ring?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  color: '#10b981',
  image: undefined,
  size: 'sm',
  ring: false,
})

const sizeClasses = computed(() => {
  switch (props.size) {
    case 'micro':
      return 'h-3 w-3 text-[7px]'
    case 'xxs':
      return 'h-3.5 w-3.5 text-[8px]'
    case 'xs':
      return 'h-4 w-4 text-[9px]'
    case 'md':
      return 'h-7 w-7 text-xs'
    case 'lg':
      return 'h-12 w-12 text-base'
    default:
      return 'h-6 w-6 text-[11px]'
  }
})

const initial = computed(() => getFirstGrapheme(props.name, '?'))
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white select-none"
    :class="[
      sizeClasses,
      ring ? 'ring-1 ring-white dark:ring-[#1C1C1E]' : '',
    ]"
    :style="image ? undefined : { backgroundColor: color || '#10b981' }"
  >
    <img
      v-if="image"
      :src="image"
      :alt="name"
      class="h-full w-full object-cover"
    />
    <span v-else>{{ initial }}</span>
  </span>
</template>
