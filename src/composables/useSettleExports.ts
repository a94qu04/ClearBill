import { ref, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import {
  applySettlementRatesToTransactions,
  type SettleUpResult,
} from '@/core/settleUpEngine'
import {
  buildMemberStatementShareText,
  buildProjectSettlementShareText,
} from '@/core/shareFormatter'
import {
  getTodayIso,
  sanitizeExportFilename,
} from '@/core/ledgerHelpers'
import { triggerBinaryFileDownload } from '@/platform/download'
import { useClipboardShare } from '@/composables/useClipboardShare'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'

export interface SettleMemberStatementEntry {
  tx: Transaction
  title: string
  shareInSettle: number
  paidInSettle: number
  shareInBase: number
  paidInBase: number
  isRefund: boolean
}

export interface UseSettleExportsOptions {
  project: ComputedRef<Project>
  effectiveSettleUp: ComputedRef<SettleUpResult>
  expenses: ComputedRef<Transaction[]>
  settlements: ComputedRef<Transaction[]>
  getMemberName: (memberId: string) => string
  onToast: (message: string) => void
  onCloseShareSheet?: () => void
}

/**
 * 集中管理結算頁之文字分享、個人對帳單複製、Excel 匯出與 PNG 長截圖匯出流程。
 */
export function useSettleExports(options: UseSettleExportsOptions) {
  const { t, locale } = useI18n()
  const store = useLedgerStore()
  const { copyText, shareOrCopyText, shareFiles } = useClipboardShare()

  const isGeneratingImage = ref(false)

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

  function getCategoryColor(key: string): string {
    return store.categories.find((c) => c.key === key)?.color ?? '#64748b'
  }

  async function shareMemberStatement(
    memberId: string,
    entries: SettleMemberStatementEntry[],
  ): Promise<void> {
    const memberName = options.getMemberName(memberId)
    const text = buildMemberStatementShareText(
      options.project.value,
      memberId,
      options.effectiveSettleUp.value,
      entries.map((item) => ({
        date: item.tx.date,
        title: item.title,
        isRefund: item.isRefund,
        shareInSettle: item.shareInSettle,
        paidInSettle: item.paidInSettle,
      })),
      {
        headerPrefix: t('share.headerPrefix'),
        statementTitle: t('settle.memberStatementTitle', { name: memberName }),
        spentLabel: t('share.spentLabel'),
        paidLabel: t('share.paidLabel'),
        netLabel: t('export.excelNetAmount'),
        shouldReceive: t('settle.shouldReceive'),
        shouldPay: t('settle.shouldPay'),
        settled: t('settle.settled'),
        transfersTitle: t('share.pendingTitle'),
        allSettledText: t('settle.allSettled'),
        entriesTitle: t('share.detailsTitle'),
        refundTag: t('project.refundBadge'),
        transferLine: (from, to, amount) =>
          t('share.transferLine', { from, to, amount }),
        footerTagline: t('share.footerTagline'),
      },
      locale.value,
    )

    const copied = await copyText(text)
    options.onToast(
      copied
        ? t('settle.memberStatementCopiedToast', { name: memberName })
        : t('share.failedToast'),
    )
  }

  const isSharingSummary = ref(false)
  const isExportingExcel = ref(false)

  async function shareSettlementText(includeDetails: boolean): Promise<void> {
    if (isSharingSummary.value) return
    isSharingSummary.value = true
    options.onCloseShareSheet?.()
    try {
      const project = options.project.value
    const summaryText = buildProjectSettlementShareText(
      project,
      options.effectiveSettleUp.value,
      options.settlements.value,
      {
        headerPrefix: t('share.headerPrefix'),
        totalSpendLabel: t('share.totalSpendLabel'),
        memberSummaryTitle: t('share.memberSummaryTitle'),
        spentLabel: t('share.spentLabel'),
        paidLabel: t('share.paidLabel'),
        pendingTitle: t('share.pendingTitle'),
        allSettledText: t('settle.allSettled'),
        historyTitle: t('share.historyTitle'),
        poolSectionTitle: t('pool.cardTitle'),
        poolPaidLabel: t('pool.paidOutLabel'),
        poolRemainingLabel: t('pool.remainingCashLabel'),
        poolOverdrawnLabel: t('pool.overdrawnLabel'),
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
        includeDetails,
        expenses: options.expenses.value,
        resolveCategoryLabel: getCategoryLabel,
        formatMultiPayer: (count) => t('project.multiPayerBadge', { count }),
      },
    )

    const result = await shareOrCopyText({
      title: `${t('share.headerPrefix')} ${project.name}`,
      text: summaryText,
    })
    if (result === 'shared') {
      options.onToast(t('share.sharedToast'))
    } else if (result === 'copied') {
      options.onToast(t('share.copiedToast'))
    } else if (result === 'failed') {
      options.onToast(t('share.failedToast'))
    }
    } finally {
      isSharingSummary.value = false
    }
  }

  async function exportExcel(): Promise<void> {
    if (isExportingExcel.value) return
    isExportingExcel.value = true
    options.onCloseShareSheet?.()
    try {
      const project = options.project.value
    const expenses = options.expenses.value
    const settlements = options.settlements.value
    const { buildProjectExcelBytes } = await import('@/core/excelExporter')
    const { settlementCurrency: targetCur, options: settleOptions } =
      store.getProjectSettlementOptions(project, [...expenses, ...settlements])
    const effectiveSettlements = applySettlementRatesToTransactions(
      settlements,
      targetCur,
      settleOptions.overrideRatesByCurrency,
      settleOptions.projectBaseCurrency,
      settleOptions.baseToSettlementRate,
    )
    const allProjectTxs = [...expenses, ...effectiveSettlements]
    const bytes = buildProjectExcelBytes(
      project,
      allProjectTxs,
      options.effectiveSettleUp.value,
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
          poolSectionTitle: t('pool.cardTitle'),
          poolPaidLabel: t('pool.paidOutLabel'),
          poolRemainingLabel: t('pool.remainingCashLabel'),
        },
        typeNames: {
          expense: t('project.typeExpense'),
          refund: t('project.typeRefund'),
          transfer: t('home.settlementBadge'),
          income: t('daily.typeIncome'),
          card_repayment: t('daily.typeCardRepayment'),
        },
        resolveCategoryLabel: getCategoryLabel,
      },
    )
    const safeName = sanitizeExportFilename(project.name)
    triggerBinaryFileDownload(
      bytes,
      `clearbill-${safeName}-${getTodayIso()}.xlsx`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    options.onToast(t('export.excelExportedToast'))
    } finally {
      isExportingExcel.value = false
    }
  }

  async function exportLongImage(includeDetails: boolean): Promise<void> {
    if (isGeneratingImage.value) return
    isGeneratingImage.value = true
    const project = options.project.value
    try {
      const { generateProjectReportPngBlob } = await import(
        '@/platform/reportImageGenerator'
      )
      const blob = await generateProjectReportPngBlob(
        project,
        options.effectiveSettleUp.value,
        options.expenses.value,
        {
          brandTitle: t('app.name'),
          totalSpendLabel: t('settle.projectTotalSpend'),
          memberCountLabel: t('project.memberCount', {
            count:
              project.members.filter((m) => !m.isPool).length ||
              project.members.length,
          }),
          categorySectionTitle: t('stats.title'),
          memberSectionTitle: t('settle.balancesTitle'),
          poolSectionTitle: t('pool.cardTitle'),
          poolPaidLabel: t('pool.paidOutLabel'),
          poolRemainingLabel: t('pool.remainingCashLabel'),
          poolOverdrawnLabel: t('pool.overdrawnLabel'),
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
          omittedEntriesNotice: (count) =>
            t('export.longImageOmittedNotice', { count }),
          resolveCategoryLabel: getCategoryLabel,
          resolveCategoryColor: getCategoryColor,
        },
        locale.value,
        {
          includeEntries: includeDetails,
        },
      )

      const safeName = sanitizeExportFilename(project.name)
      const filename = `clearbill-${safeName}-${getTodayIso()}.png`

      // 行動端優先使用原生分享圖片檔（直接丟進 LINE 群組）；不支援則自動下載 PNG
      if (typeof File !== 'undefined') {
        const file = new File([blob], filename, { type: 'image/png' })
        const shareResult = await shareFiles({
          title: `${t('share.headerPrefix')} ${project.name}`,
          files: [file],
        })
        if (shareResult === 'shared') {
          options.onToast(t('share.sharedToast'))
          return
        }
        if (shareResult === 'cancelled') {
          return
        }
      }

      triggerBinaryFileDownload(blob, filename, 'image/png')
      options.onToast(t('export.longImageExportedToast'))
    } catch {
      options.onToast(t('export.longImageFailedToast'))
    } finally {
      isGeneratingImage.value = false
      options.onCloseShareSheet?.()
    }
  }

  return {
    isGeneratingImage,
    getCategoryLabel,
    getCategoryColor,
    shareMemberStatement,
    shareSettlementText,
    exportExcel,
    exportLongImage,
  }
}
