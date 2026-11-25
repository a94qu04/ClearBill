<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, HelpCircle } from 'lucide-vue-next'
import { useConfirmDialogState } from '@/composables/useConfirm'
import { useModalLayer } from '@/composables/useModalLayer'

const { t } = useI18n()
const { state, resolveConfirm } = useConfirmDialogState()
const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => state.open,
  () => resolveConfirm(false),
  dialogRef,
)
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="state.open"
        ref="dialogRef"
        role="alertdialog"
        aria-modal="true"
        class="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
        @click.self="resolveConfirm(false)"
      >
        <div
          class="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        >
          <div class="flex items-start gap-3">
            <span
              class="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl"
              :class="
                state.tone === 'danger'
                  ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400'
                  : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400'
              "
            >
              <AlertTriangle v-if="state.tone === 'danger'" class="h-5 w-5" />
              <HelpCircle v-else class="h-5 w-5" />
            </span>

            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-bold text-slate-900 dark:text-white">
                {{ state.title || t('confirm.defaultTitle') }}
              </h3>
              <p class="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                {{ state.message }}
              </p>
            </div>
          </div>

          <div class="mt-5 grid grid-cols-2 gap-2.5">
            <button
              type="button"
              class="rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              @click="resolveConfirm(false)"
            >
              {{ state.cancelText || t('confirm.cancelButton') }}
            </button>
            <button
              type="button"
              class="rounded-xl py-2.5 text-xs font-bold text-white shadow-sm transition active:scale-[0.98]"
              :class="
                state.tone === 'danger'
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950'
              "
              @click="resolveConfirm(true)"
            >
              {{ state.confirmText || t('confirm.confirmButton') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
