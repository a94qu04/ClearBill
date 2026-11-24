<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Coins,
  FileSpreadsheet,
  ImageDown,
  Loader2,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-vue-next'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import type { SettleUpResult } from '@/core/settleUpEngine'
import { formatCurrencyAmount } from '@/core/currency'
import { buildProjectSettlementShareText } from '@/core/shareFormatter'
import { buildProjectExcelBytes } from '@/core/excelExporter'
import { generateProjectReportPngBlob } from '@/core/reportImageGenerator'
import {
  getTodayIso,
  sanitizeExportFilename,
  triggerBinaryFileDownload,
} from '@/core/ledgerHelpers'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import CategoryPieChart from '@/components/CategoryPieChart.vue'

interface Props {
  project: Project
  settleUp: SettleUpResult
  expenses: Transaction[]
  settlements: Transaction[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'recordPayment', payload: { fromMemberId: string; toMemberId: string; amount: number }): void
  (e: 'editSettlement', tx: Transaction): void
  (e: 'deleteSettlement', id: string): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const includeDetailsInShare = ref(false)
const isGeneratingImage = ref(false)

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}

function getMemberName(memberId: string): string {
  return props.project.members.find((m) => m.id === memberId)?.name ?? memberId
}

function getMemberColor(memberId: string): string {
  return (
    props.project.members.find((m) => m.id === memberId)?.avatarColor ??
    '#10b981'
  )
}

function resolveCategoryLabel(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

function getCategoryLabel(key: string): string {
  const found = store.categories.find((c) => c.key === key)
  if (found) return resolveCategoryLabel(found)
  const translated = t(`categories.${key}`)
  return translated === `categories.${key}` ? key : translated
}

async function handleShareSettlement() {
  const summaryText = buildProjectSettlementShareText(
    props.project,
    props.settleUp,
    props.settlements,
    {
      headerPrefix: t('share.headerPrefix'),
      totalSpendLabel: t('share.totalSpendLabel'),
      memberSummaryTitle: t('share.memberSummaryTitle'),
      spentLabel: t('share.spentLabel'),
      paidLabel: t('share.paidLabel'),
      pendingTitle: t('share.pendingTitle'),
      allSettledText: t('settle.allSettled'),
      historyTitle: t('share.historyTitle'),
      detailsTitle: t('share.detailsTitle'),
      refundTag: t('project.refundBadge'),
      transferLine: (from, to, amount) =>
        t('share.transferLine', { from, to, amount }),
      paidHistoryLine: (from, to, amount, date) =>
        t('share.paidHistoryLine', { from, to, amount, date }),
      detailItemLine: ({ date, title, amountText, payerText }) =>
        payerText
          ? t('share.detailItemLine', {
              date,
              title,
              amount: amountText,
              payer: payerText,
            })
          : `${date} ${title} ${amountText}`,
      footerTagline: t('share.footerTagline'),
    },
    locale.value,
    {
      includeDetails: includeDetailsInShare.value,
      expenses: props.expenses,
      resolveCategoryLabel: getCategoryLabel,
      formatMultiPayer: (count) => t('project.multiPayerBadge', { count }),
    },
  )

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({
        title: `${t('share.headerPrefix')} ${props.project.name}`,
        text: summaryText,
      })
      emit('toast', t('share.sharedToast'))
      return
    }
  } catch (err) {
    // 若使用者主動取消原生分享則靜默結束；其餘錯誤改走剪貼簿降級
    if (err instanceof Error && err.name === 'AbortError') {
      return
    }
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(summaryText)
      emit('toast', t('share.copiedToast'))
      return
    }
  } catch {
    // 走最後一層文字複製降級
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = summaryText
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    emit('toast', t('share.copiedToast'))
  } catch {
    emit('toast', t('share.failedToast'))
  }
}

function getCategoryColor(key: string): string {
  return store.categories.find((c) => c.key === key)?.color ?? '#64748b'
}

function handleExportExcel() {
  const allProjectTxs = [...props.expenses, ...props.settlements]
  const bytes = buildProjectExcelBytes(
    props.project,
    allProjectTxs,
    props.settleUp,
    {
      sheets: {
        entries: t('export.excelSheetEntries'),
        summary: t('export.excelSheetSummary'),
      },
      headers: {
        date: t('export.csvDate'),
        time: t('export.csvTime'),
        type: t('export.csvType'),
        category: t('export.csvCategory'),
        note: t('export.csvNote'),
        originalAmount: t('export.csvOriginalAmount'),
        currency: t('export.csvCurrency'),
        exchangeRate: t('export.csvExchangeRate'),
        baseAmount: t('export.csvBaseAmount'),
        baseCurrency: t('export.csvBaseCurrency'),
        payers: t('export.csvPayers'),
        shares: t('export.csvShares'),
      },
      summaryHeaders: {
        member: t('export.excelMember'),
        totalExpense: t('settle.memberTotalExpense'),
        totalPaid: t('settle.memberTotalPaid'),
        netAmount: t('export.excelNetAmount'),
        transferFrom: t('settle.fromLabel'),
        transferTo: t('settle.toLabel'),
        transferAmount: t('daily.amountLabel'),
        projectTotal: t('settle.projectTotalSpend'),
        transfersTitle: t('settle.suggestionsTitle'),
      },
      typeNames: {
        expense: t('project.typeExpense'),
        refund: t('project.typeRefund'),
        transfer: t('home.settlementBadge'),
        income: t('daily.typeIncome'),
        card_repayment: 'card_repayment',
      },
      resolveCategoryLabel: getCategoryLabel,
    },
  )
  const safeName = sanitizeExportFilename(props.project.name)
  triggerBinaryFileDownload(
    bytes,
    `clearbill-${safeName}-${getTodayIso()}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  emit('toast', t('export.excelExportedToast'))
}

async function handleExportLongImage() {
  if (isGeneratingImage.value) return
  isGeneratingImage.value = true
  try {
    const blob = await generateProjectReportPngBlob(
      props.project,
      props.settleUp,
      props.expenses,
      {
        brandTitle: t('app.name'),
        totalSpendLabel: t('settle.projectTotalSpend'),
        memberCountLabel: t('project.memberCount', {
          count: props.project.members.length,
        }),
        categorySectionTitle: t('stats.title'),
        memberSectionTitle: t('settle.balancesTitle'),
        spentLabel: t('settle.memberTotalExpense'),
        paidLabel: t('settle.memberTotalPaid'),
        shouldReceive: t('settle.shouldReceive'),
        shouldPay: t('settle.shouldPay'),
        settled: t('settle.settled'),
        transfersSectionTitle: t('settle.suggestionsTitle'),
        allSettledText: t('settle.allSettled'),
        entriesSectionTitle: t('share.detailsTitle'),
        refundBadge: t('project.refundBadge'),
        footerTagline: t('share.footerTagline'),
        resolveCategoryLabel: getCategoryLabel,
        resolveCategoryColor: getCategoryColor,
      },
      locale.value,
    )

    const safeName = sanitizeExportFilename(props.project.name)
    const filename = `clearbill-${safeName}-${getTodayIso()}.png`

    // 行動端優先使用原生分享圖片檔（直接丟進 LINE 群組）；不支援則自動下載 PNG
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      typeof File !== 'undefined'
    ) {
      const file = new File([blob], filename, { type: 'image/png' })
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: `${t('share.headerPrefix')} ${props.project.name}`,
            files: [file],
          })
          emit('toast', t('share.sharedToast'))
          return
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return
        }
      }
    }

    triggerBinaryFileDownload(blob, filename, 'image/png')
    emit('toast', t('export.longImageExportedToast'))
  } catch {
    emit('toast', t('export.longImageFailedToast'))
  } finally {
    isGeneratingImage.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- 各成員總支出與結算總覽（含一鍵分享精簡／明細切換與報表匯出） -->
    <section
      class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 class="text-xs font-bold text-slate-700 dark:text-slate-200">
            {{ t('settle.balancesTitle') }}
          </h3>
          <div class="mt-0.5 text-[11px] font-semibold tabular-nums text-slate-500 dark:text-slate-400">
            {{ t('settle.projectTotalSpend') }}:
            <strong class="text-slate-900 dark:text-white">{{
              fmt(settleUp.totalProjectExpense, project.baseCurrency)
            }}</strong>
          </div>
        </div>

        <div class="flex flex-col items-end gap-1.5">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-slate-800 active:scale-95 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
            @click="handleShareSettlement"
          >
            <Share2 class="h-3.5 w-3.5" />
            <span>{{ t('share.button') }}</span>
          </button>

          <label
            v-if="expenses.length > 0"
            class="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400"
          >
            <input
              v-model="includeDetailsInShare"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800"
            />
            <span>{{ t('share.includeDetailsToggle') }}</span>
          </label>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div
          v-for="bal in settleUp.balances"
          :key="bal.memberId"
          class="overflow-hidden rounded-xl border border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/60"
          :style="{
            borderLeftWidth: '4px',
            borderLeftColor: getMemberColor(bal.memberId),
          }"
        >
          <div class="p-3">
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  :style="{ backgroundColor: getMemberColor(bal.memberId) }"
                >
                  {{ getMemberName(bal.memberId).slice(0, 1).toUpperCase() }}
                </span>
                <span class="truncate text-sm font-bold text-slate-800 dark:text-slate-100">
                  {{ getMemberName(bal.memberId) }}
                </span>
              </div>

              <div class="text-right">
                <div
                  class="text-sm font-extrabold tabular-nums"
                  :class="
                    bal.netAmount > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : bal.netAmount < 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-slate-400'
                  "
                >
                  {{ bal.netAmount > 0 ? '+' : '' }}{{ fmt(bal.netAmount, project.baseCurrency) }}
                </div>
                <div class="text-[10px] text-slate-400">
                  {{
                    bal.netAmount > 0
                      ? t('settle.shouldReceive')
                      : bal.netAmount < 0
                        ? t('settle.shouldPay')
                        : t('settle.settled')
                  }}
                </div>
              </div>
            </div>

            <div
              class="mt-2.5 grid grid-cols-2 gap-2 border-t border-slate-200/70 pt-2 text-[11px] dark:border-slate-700/70"
            >
              <div>
                <span class="text-slate-400">{{ t('settle.memberTotalExpense') }}</span>
                <div class="font-bold tabular-nums text-slate-800 dark:text-slate-100">
                  {{ fmt(bal.totalExpense, project.baseCurrency) }}
                </div>
              </div>
              <div class="text-right">
                <span class="text-slate-400">{{ t('settle.memberTotalPaid') }}</span>
                <div class="font-semibold tabular-nums text-slate-600 dark:text-slate-300">
                  {{ fmt(bal.totalPaid, project.baseCurrency) }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 匯出報表列：標準 Excel (.xlsx) 與高解析長截圖報表 (PNG) -->
      <div
        class="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 dark:border-slate-800"
      >
        <button
          type="button"
          class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] font-bold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200 dark:hover:bg-slate-800"
          @click="handleExportExcel"
        >
          <FileSpreadsheet class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          <span class="truncate">{{ t('export.excelButton') }}</span>
        </button>
        <button
          type="button"
          :disabled="isGeneratingImage"
          class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200 dark:hover:bg-slate-800"
          @click="handleExportLongImage"
        >
          <Loader2 v-if="isGeneratingImage" class="h-3.5 w-3.5 animate-spin text-sky-600" />
          <ImageDown v-else class="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
          <span class="truncate">{{ t('export.longImageButton') }}</span>
        </button>
      </div>
    </section>

    <!-- 消費結構圓餅圖統計 -->
    <CategoryPieChart
      :transactions="expenses"
      :base-currency="project.baseCurrency"
    />

    <!-- 待還款結算 -->
    <section
      class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div class="mb-3 flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">
        <Coins class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span>{{ t('settle.suggestionsTitle') }}</span>
      </div>

      <p
        v-if="settleUp.transfers.length === 0"
        class="rounded-xl bg-emerald-50 px-3.5 py-3 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
      >
        {{ t('settle.allSettled') }}
      </p>

      <ul v-else class="space-y-2">
        <li
          v-for="(transfer, idx) in settleUp.transfers"
          :key="idx"
          class="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-800/70"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <span class="inline-flex items-center gap-1">
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  :style="{ backgroundColor: getMemberColor(transfer.fromMemberId) }"
                />
                <span>{{ getMemberName(transfer.fromMemberId) }}</span>
              </span>
              <span class="text-slate-400">→</span>
              <span class="inline-flex items-center gap-1">
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  :style="{ backgroundColor: getMemberColor(transfer.toMemberId) }"
                />
                <span>{{ getMemberName(transfer.toMemberId) }}</span>
              </span>
            </div>
            <div class="mt-0.5 text-sm font-extrabold tabular-nums text-emerald-700 dark:text-emerald-400">
              {{ fmt(transfer.amount, transfer.currency) }}
            </div>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
            @click="
              emit('recordPayment', {
                fromMemberId: transfer.fromMemberId,
                toMemberId: transfer.toMemberId,
                amount: transfer.amount,
              })
            "
          >
            {{ t('settle.recordButton') }}
          </button>
        </li>
      </ul>
    </section>

    <!-- 已記錄之還款明細 -->
    <section
      class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <h3 class="mb-3 text-xs font-bold text-slate-700 dark:text-slate-200">
        {{ t('settle.historyTitle') }}
      </h3>

      <p
        v-if="settlements.length === 0"
        class="py-4 text-center text-xs text-slate-400 dark:text-slate-500"
      >
        {{ t('settle.noHistory') }}
      </p>

      <ul v-else class="divide-y divide-slate-100 dark:divide-slate-800">
        <li
          v-for="tx in settlements"
          :key="tx.id"
          class="flex items-center justify-between gap-2 py-2.5"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <span class="inline-flex items-center gap-1">
                <span
                  class="h-2 w-2 rounded-full"
                  :style="{
                    backgroundColor: getMemberColor(tx.splitConfig?.payerId ?? ''),
                  }"
                />
                <span>{{ getMemberName(tx.splitConfig?.payerId ?? '') }}</span>
              </span>
              <span class="text-slate-400">→</span>
              <span class="inline-flex items-center gap-1">
                <span
                  class="h-2 w-2 rounded-full"
                  :style="{
                    backgroundColor: getMemberColor(
                      tx.splitConfig?.shares[0]?.memberId ?? '',
                    ),
                  }"
                />
                <span>{{
                  getMemberName(tx.splitConfig?.shares[0]?.memberId ?? '')
                }}</span>
              </span>
            </div>
            <div class="mt-0.5 text-[11px] text-slate-400">
              {{ tx.date }}
              <span v-if="tx.note"> · {{ tx.note }}</span>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <span class="mr-1 text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {{ fmt(tx.amount, tx.currency) }}
            </span>
            <button
              type="button"
              :aria-label="t('home.editTx')"
              class="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/60"
              @click="emit('editSettlement', tx)"
            >
              <Pencil class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              :aria-label="t('home.deleteTx')"
              class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
              @click="emit('deleteSettlement', tx.id)"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
