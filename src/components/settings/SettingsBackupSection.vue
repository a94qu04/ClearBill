<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Download, HardDrive, Upload } from 'lucide-vue-next'
import { getTodayIso } from '@/core/ledgerHelpers'
import { useLedgerStore } from '@/stores/ledgerStore'

const emit = defineEmits<{
  (e: 'toast', message: string): void
}>()

const { t } = useI18n()
const store = useLedgerStore()

function formatBytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// 本地 JSON 備份匯出與合併匯入
function handleExportLocalJson(omitReceiptImages = false) {
  const backup = store.exportLedgerBackup({ omitReceiptImages })
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = omitReceiptImages
    ? `clearbill-backup-lite-${getTodayIso()}.json`
    : `clearbill-backup-${getTodayIso()}.json`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  emit(
    'toast',
    omitReceiptImages ? t('backup.exportedLiteToast') : t('backup.exportedToast'),
  )
}

async function handleImportLocalJson(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  try {
    const text = await file.text()
    const stats = await store.importAndMergeLedgerBackup(text)
    emit(
      'toast',
      t('backup.mergedToast', {
        pAdd: stats.projectsAdded,
        pUpd: stats.projectsUpdated,
        tAdd: stats.transactionsAdded,
        tUpd: stats.transactionsUpdated,
      }),
    )
  } catch {
    emit('toast', t('backup.importError'))
  } finally {
    input.value = ''
  }
}
</script>

<template>
  <!-- 本地備份 -->
  <section
    class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50"
  >
    <div
      class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100"
    >
      <HardDrive class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
      <span>{{ t('backup.localTitle') }}</span>
    </div>
    <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
      {{ t('backup.localDesc') }}
    </p>

    <!-- 本機資料與圖片占用空間概覽 -->
    <div
      class="grid grid-cols-3 gap-2 rounded-xl border border-slate-200/80 bg-white px-3 py-2 text-center dark:border-slate-800 dark:bg-slate-900"
    >
      <div>
        <div class="text-[10px] text-slate-400">
          {{ t('backup.storageProjectsLabel') }}
        </div>
        <div
          class="text-xs font-extrabold tabular-nums text-slate-900 dark:text-white"
        >
          {{ store.storageUsageStats.projectCount }}
        </div>
      </div>
      <div class="border-x border-slate-100 dark:border-slate-800">
        <div class="text-[10px] text-slate-400">
          {{ t('backup.storageEntriesLabel') }}
        </div>
        <div
          class="text-xs font-extrabold tabular-nums text-slate-900 dark:text-white"
        >
          {{ store.storageUsageStats.transactionCount }}
        </div>
      </div>
      <div>
        <div class="text-[10px] text-slate-400">
          {{ t('backup.storageImagesLabel') }}
        </div>
        <div
          class="text-xs font-extrabold tabular-nums text-emerald-700 dark:text-emerald-400"
        >
          {{ formatBytesLabel(store.storageUsageStats.totalImageBytes) }}
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-2">
      <button
        type="button"
        class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
        @click="handleExportLocalJson(false)"
      >
        <Download class="h-4 w-4" />
        <span>{{ t('backup.exportButton') }}</span>
      </button>

      <button
        v-if="store.storageUsageStats.receiptImageCount > 0"
        type="button"
        class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs font-bold text-emerald-800 transition hover:bg-emerald-100 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-300"
        @click="handleExportLocalJson(true)"
      >
        <Download class="h-3.5 w-3.5" />
        <span>{{ t('backup.exportLiteButton') }}</span>
      </button>

      <label
        class="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <Upload class="h-4 w-4" />
        <span>{{ t('backup.importButton') }}</span>
        <input
          type="file"
          accept="application/json,.json"
          class="hidden"
          @change="handleImportLocalJson"
        />
      </label>
    </div>
  </section>
</template>
