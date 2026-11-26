<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  FileSpreadsheet,
  ImageDown,
  Loader2,
  Share2,
} from 'lucide-vue-next'
import { useModalLayer } from '@/composables/useModalLayer'

interface Props {
  open: boolean
  hasExpenses: boolean
  includeDetails: boolean
  isGeneratingImage: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'update:includeDetails', value: boolean): void
  (e: 'shareText'): void
  (e: 'exportLongImage'): void
  (e: 'exportExcel'): void
}>()

const { t } = useI18n()
const shareSheetRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => props.open,
  () => {
    emit('close')
  },
  shareSheetRef,
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 p-3 backdrop-blur-[2px] sm:items-center"
      @click.self="emit('close')"
    >
      <div
        ref="shareSheetRef"
        role="dialog"
        aria-modal="true"
        :aria-label="t('share.sheetTitle')"
        tabindex="-1"
        class="w-full max-w-sm space-y-2 pb-[env(safe-area-inset-bottom)] focus:outline-none"
      >
        <div class="overflow-hidden rounded-2xl bg-white/95 shadow-2xl backdrop-blur-xl dark:bg-[#1C1C1E]">
          <div class="border-b border-slate-100 px-4 py-3 text-center dark:border-white/10">
            <div class="text-xs font-semibold text-slate-500 dark:text-slate-400">
              {{ t('share.sheetTitle') }}
            </div>
          </div>

          <!-- iOS Switch 開關：是否附帶完整消費明細 -->
          <div
            v-if="hasExpenses"
            class="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-white/10"
          >
            <span class="text-xs font-medium text-slate-700 dark:text-slate-200">
              {{ t('share.includeDetailsToggle') }}
            </span>
            <button
              type="button"
              role="switch"
              :aria-checked="includeDetails"
              class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
              :class="
                includeDetails
                  ? 'bg-emerald-500'
                  : 'bg-slate-200 dark:bg-slate-700'
              "
              @click="emit('update:includeDetails', !includeDetails)"
            >
              <span
                class="inline-block h-5 w-5 rounded-full bg-white shadow transition-transform"
                :class="includeDetails ? 'translate-x-5.5' : 'translate-x-0.5'"
              />
            </button>
          </div>

          <div class="divide-y divide-slate-100 dark:divide-white/10">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-semibold text-slate-900 transition hover:bg-slate-50 active:bg-slate-100 dark:text-white dark:hover:bg-white/5"
              @click="emit('shareText')"
            >
              <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <Share2 class="h-4 w-4" />
              </span>
              <span>{{ t('share.textSummaryAction') }}</span>
            </button>

            <button
              type="button"
              :disabled="isGeneratingImage"
              class="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-semibold text-slate-900 transition hover:bg-slate-50 active:bg-slate-100 disabled:opacity-50 dark:text-white dark:hover:bg-white/5"
              @click="emit('exportLongImage')"
            >
              <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400">
                <Loader2 v-if="isGeneratingImage" class="h-4 w-4 animate-spin" />
                <ImageDown v-else class="h-4 w-4" />
              </span>
              <span>{{ t('export.longImageButton') }}</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-semibold text-slate-900 transition hover:bg-slate-50 active:bg-slate-100 dark:text-white dark:hover:bg-white/5"
              @click="emit('exportExcel')"
            >
              <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-500/15 text-teal-600 dark:text-teal-400">
                <FileSpreadsheet class="h-4 w-4" />
              </span>
              <span>{{ t('export.excelButton') }}</span>
            </button>
          </div>
        </div>

        <button
          type="button"
          class="w-full rounded-2xl bg-white py-3.5 text-center text-sm font-bold text-slate-900 shadow-lg transition hover:bg-slate-50 active:scale-[0.99] dark:bg-[#1C1C1E] dark:text-white dark:hover:bg-[#2C2C2E]"
          @click="emit('close')"
        >
          {{ t('confirm.cancelButton') }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
