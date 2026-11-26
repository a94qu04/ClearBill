<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Receipt,
  RotateCcw,
  Wallet,
} from 'lucide-vue-next'

export type EntryMode = 'expense' | 'transfer' | 'refund' | 'pool'

interface Props {
  modelValue: EntryMode
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'select', mode: EntryMode): void
}>()

const { t } = useI18n()
const menuOpen = ref(false)
const rootRef = ref<HTMLElement | null>(null)

const options: Array<{
  value: EntryMode
  labelKey: string
  icon: typeof Receipt
  badgeClass: string
}> = [
  {
    value: 'expense',
    labelKey: 'project.entryTypeExpense',
    icon: Receipt,
    badgeClass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  {
    value: 'transfer',
    labelKey: 'project.entryTypeTransfer',
    icon: ArrowLeftRight,
    badgeClass: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  },
  {
    value: 'refund',
    labelKey: 'project.entryTypeRefund',
    icon: RotateCcw,
    badgeClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  {
    value: 'pool',
    labelKey: 'project.entryTypePool',
    icon: Wallet,
    badgeClass: 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
  },
]

function getOption(value: EntryMode) {
  return options.find((opt) => opt.value === value) ?? options[0]
}

function handleSelect(mode: EntryMode) {
  menuOpen.value = false
  emit('select', mode)
}

function handleDocumentClick(event: MouseEvent) {
  if (!menuOpen.value || !rootRef.value) return
  if (!rootRef.value.contains(event.target as Node)) {
    menuOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})
</script>

<template>
  <div ref="rootRef" class="relative inline-flex">
    <button
      type="button"
      :aria-expanded="menuOpen"
      :aria-label="t('project.switchEntryTypeAria')"
      aria-haspopup="listbox"
      class="inline-flex items-center gap-1.5 rounded-full border border-slate-200/90 bg-slate-100/90 px-3 py-1.5 text-sm font-bold text-slate-900 shadow-xs transition hover:border-emerald-400 hover:bg-white active:scale-95 dark:border-white/15 dark:bg-[#2C2C2E] dark:text-white dark:hover:border-emerald-400/60 dark:hover:bg-[#3A3A3C]"
      @click.stop="menuOpen = !menuOpen"
    >
      <span
        class="inline-flex h-5 w-5 items-center justify-center rounded-full"
        :class="getOption(modelValue).badgeClass"
      >
        <component :is="getOption(modelValue).icon" class="h-3 w-3" />
      </span>
      <span>{{ t(getOption(modelValue).labelKey) }}</span>
      <ChevronDown
        class="h-3.5 w-3.5 text-slate-500 transition-transform dark:text-slate-300"
        :class="menuOpen ? 'rotate-180' : ''"
      />
    </button>

    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 scale-95 -translate-y-1"
      enter-to-class="opacity-100 scale-100 translate-y-0"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 scale-100 translate-y-0"
      leave-to-class="opacity-0 scale-95 -translate-y-1"
    >
      <div
        v-if="menuOpen"
        role="listbox"
        class="absolute left-1/2 top-full z-30 mt-2 w-44 -translate-x-1/2 overflow-hidden rounded-2xl border border-slate-200/90 bg-white p-1.5 shadow-xl ring-1 ring-black/5 dark:border-white/15 dark:bg-[#2C2C2E]"
      >
        <button
          v-for="opt in options"
          :key="opt.value"
          type="button"
          role="option"
          :aria-selected="modelValue === opt.value"
          class="flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-semibold transition"
          :class="
            modelValue === opt.value
              ? 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
              : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/10'
          "
          @click.stop="handleSelect(opt.value)"
        >
          <span class="flex items-center gap-2">
            <span
              class="inline-flex h-6 w-6 items-center justify-center rounded-lg"
              :class="opt.badgeClass"
            >
              <component :is="opt.icon" class="h-3.5 w-3.5" />
            </span>
            <span>{{ t(opt.labelKey) }}</span>
          </span>
          <Check
            v-if="modelValue === opt.value"
            class="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
        </button>
      </div>
    </Transition>
  </div>
</template>
