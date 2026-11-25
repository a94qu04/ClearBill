<script setup lang="ts">
import { computed } from 'vue'
import { resolveCategoryIconComponent } from '@/core/categoryIcons'

interface Props {
  icon?: string
  categoryKey?: string
  color?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  plain?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  icon: undefined,
  categoryKey: undefined,
  color: '#059669',
  size: 'md',
  plain: false,
})

const iconComponent = computed(() =>
  resolveCategoryIconComponent(props.icon, props.categoryKey),
)

const boxSizeClass = computed(() => {
  switch (props.size) {
    case 'xs':
      return 'h-5 w-5 rounded-md'
    case 'sm':
      return 'h-7 w-7 rounded-lg'
    case 'lg':
      return 'h-10 w-10 rounded-xl'
    default:
      return 'h-8 w-8 rounded-xl'
  }
})

const iconSizeClass = computed(() => {
  switch (props.size) {
    case 'xs':
      return 'h-3 w-3'
    case 'sm':
      return 'h-3.5 w-3.5'
    case 'lg':
      return 'h-5 w-5'
    default:
      return 'h-4 w-4'
  }
})
</script>

<template>
  <component
    :is="iconComponent"
    v-if="plain"
    class="shrink-0"
    :class="iconSizeClass"
  />
  <span
    v-else
    class="inline-flex shrink-0 items-center justify-center text-white shadow-xs"
    :class="boxSizeClass"
    :style="{ backgroundColor: color || '#059669' }"
  >
    <component :is="iconComponent" :class="iconSizeClass" />
  </span>
</template>
