<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useModalLayer } from '@/composables/useModalLayer'
import { formatCurrencyAmount } from '@/core/currency'

const emit = defineEmits<{
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const isHandling = ref(false)
const guard = computed(() => store.pendingDeletionGuard)
const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(() => Boolean(guard.value), undefined, dialogRef)

const ratioPercent = computed(() => {
  if (!guard.value) return 0
  return Math.round(guard.value.deletionRatio * 100)
})

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}

function resolveCategoryLabel(categoryKey: string): string {
  const found = store.categories.find((c) => c.key === categoryKey)
  if (found?.customLabel) return found.customLabel
  const translated = t(`categories.${categoryKey}`)
  return translated === `categories.${categoryKey}` ? categoryKey : translated
}

async function handleRejectAndProtect() {
  if (isHandling.value) return
  isHandling.value = true
  try {
    const count = await store.rejectPendingRemoteDeletes()
    emit('toast', t('realtime.guardRejectedToast', { count }))
  } catch {
    emit('toast', t('home.saveFailed'))
  } finally {
    isHandling.value = false
  }
}

async function handleApproveDeletes() {
  if (isHandling.value) return
  isHandling.value = true
  try {
    const count = await store.approvePendingRemoteDeletes()
    emit('toast', t('realtime.guardApprovedToast', { count }))
  } catch {
    emit('toast', t('home.saveFailed'))
  } finally {
    isHandling.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="guard"
      ref="dialogRef"
      role="alertdialog"
      aria-modal="true"
      :aria-label="t('realtime.guardTitle')"
      class="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/70 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div
        class="w-full max-w-md rounded-t-3xl border border-rose-200 bg-white p-5 shadow-2xl dark:border-rose-800/70 dark:bg-slate-900 sm:rounded-3xl"
      >
        <div class="flex items-start gap-3">
          <span
            class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-rose-100 text-rose-600 dark:bg-rose-950/80 dark:text-rose-400"
          >
            <ShieldAlert class="h-5 w-5" />
          </span>
          <div>
            <h2 class="text-sm font-extrabold text-rose-700 dark:text-rose-300">
              {{ t('realtime.guardTitle') }}
            </h2>
            <p class="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {{
                t('realtime.guardDesc', {
                  project: guard.projectName,
                  count: guard.newlyDeletedCount,
                  percent: ratioPercent,
                })
              }}
            </p>
          </div>
        </div>

        <!-- 預覽受影響之前 5 筆明細 -->
        <ul
          class="mt-3 max-h-40 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-950/60"
        >
          <li
            v-for="tx in guard.pendingDeletes.slice(0, 5)"
            :key="tx.id"
            class="flex items-center justify-between gap-2 py-1.5"
          >
            <span class="truncate font-medium text-slate-700 dark:text-slate-200">
              {{ tx.date }} · {{ tx.note || resolveCategoryLabel(tx.categoryKey) }}
            </span>
            <span class="shrink-0 font-bold tabular-nums text-rose-600 dark:text-rose-400">
              {{ fmt(tx.amount, tx.currency) }}
            </span>
          </li>
          <li
            v-if="guard.pendingDeletes.length > 5"
            class="py-1 text-center text-[11px] text-slate-400"
          >
            +{{ guard.pendingDeletes.length - 5 }} ...
          </li>
        </ul>

        <div class="mt-4 space-y-2">
          <button
            type="button"
            :disabled="isHandling"
            class="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-emerald-600 py-3 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:text-slate-950"
            @click="handleRejectAndProtect"
          >
            <Loader2 v-if="isHandling" class="h-4 w-4 animate-spin" />
            <AlertTriangle v-else class="h-4 w-4" />
            <span>{{ t('realtime.guardRejectButton') }}</span>
          </button>

          <button
            type="button"
            :disabled="isHandling"
            class="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-rose-200 bg-rose-50 py-2.5 text-xs font-bold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800/70 dark:bg-rose-950/40 dark:text-rose-300"
            @click="handleApproveDeletes"
          >
            <Loader2 v-if="isHandling" class="h-3.5 w-3.5 animate-spin" />
            <span>{{ t('realtime.guardApproveButton') }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
