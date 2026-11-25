import type { Project, Transaction } from '@/schemas/ledgerSchema'
import type { SettleUpResult } from '@/core/settleUpEngine'
import { formatCurrencyAmount } from '@/core/currency'

export interface ShareSummaryLabels {
  headerPrefix: string
  totalSpendLabel: string
  memberSummaryTitle: string
  spentLabel: string
  paidLabel: string
  pendingTitle: string
  allSettledText: string
  historyTitle: string
  detailsTitle?: string
  refundTag?: string
  transferLine: (from: string, to: string, amountText: string) => string
  paidHistoryLine: (from: string, to: string, amountText: string, date: string) => string
  detailItemLine?: (params: {
    date: string
    title: string
    amountText: string
    payerText: string
  }) => string
  footerTagline: string
}

export interface ShareSummaryOptions {
  /** 是否附帶消費／退款明細清單 */
  includeDetails?: boolean
  /** 專案內消費與退款清單（includeDetails 為 true 時輸出） */
  expenses?: Transaction[]
  /** 消費分類鍵值轉顯示文字 */
  resolveCategoryLabel?: (categoryKey: string) => string
  /** 多人墊付顯示文案 */
  formatMultiPayer?: (count: number) => string
}

/**
 * 產生乾淨易讀、適合貼至 LINE / Messenger / WhatsApp 的分帳結算分享文字（純 TypeScript 函式）
 * 嚴格遵守多國語言規範：文案由呼叫端 i18n 注入，金額全數透過 Intl.NumberFormat 格式化
 */
export function buildProjectSettlementShareText(
  project: Project,
  settleUp: SettleUpResult,
  settlements: Transaction[],
  labels: ShareSummaryLabels,
  locale = 'zh-TW',
  options: ShareSummaryOptions = {},
): string {
  const memberNameMap = new Map<string, string>()
  for (const member of project.members) {
    memberNameMap.set(member.id, member.name)
  }
  const targetCurrency = settleUp.currency || project.baseCurrency
  const nameOf = (id: string) => memberNameMap.get(id) ?? id
  const fmt = (amount: number, currency = targetCurrency) =>
    formatCurrencyAmount(amount, currency, locale)

  const lines: string[] = []
  lines.push(`${labels.headerPrefix} ${project.name}`)
  lines.push(
    `${labels.totalSpendLabel}: ${fmt(settleUp.totalProjectExpense, targetCurrency)}`,
  )
  lines.push('')

  // 各成員總支出與已墊付匯總
  lines.push(labels.memberSummaryTitle)
  for (const bal of settleUp.balances) {
    const sign = bal.netAmount > 0 ? '+' : ''
    lines.push(
      `• ${nameOf(bal.memberId)}｜${labels.spentLabel} ${fmt(bal.totalExpense)}｜${labels.paidLabel} ${fmt(bal.totalPaid)}（${sign}${fmt(bal.netAmount)}）`,
    )
  }
  lines.push('')

  // 待還款結算方案
  lines.push(labels.pendingTitle)
  if (settleUp.transfers.length === 0) {
    lines.push(`• ${labels.allSettledText}`)
  } else {
    for (const transfer of settleUp.transfers) {
      lines.push(
        `• ${labels.transferLine(
          nameOf(transfer.fromMemberId),
          nameOf(transfer.toMemberId),
          fmt(transfer.amount, transfer.currency),
        )}`,
      )
    }
  }

  // 選填：附帶消費／退款明細（方便群組成員核對）
  if (options.includeDetails && options.expenses && options.expenses.length > 0) {
    const validExpenses = options.expenses
      .filter((tx) => !tx.isDeleted && (tx.type === 'expense' || tx.type === 'refund'))
      .sort((a, b) => {
        const d = a.date.localeCompare(b.date)
        if (d !== 0) return d
        return a.time.localeCompare(b.time)
      })

    if (validExpenses.length > 0) {
      lines.push('')
      lines.push(labels.detailsTitle ?? '▎Details')
      for (const tx of validExpenses) {
        const titleBase =
          tx.note?.trim() ||
          options.resolveCategoryLabel?.(tx.categoryKey) ||
          tx.categoryKey
        const title =
          tx.type === 'refund' && labels.refundTag
            ? `[${labels.refundTag}] ${titleBase}`
            : titleBase

        const sign = tx.type === 'refund' ? '-' : ''
        const originalText = `${sign}${fmt(tx.amount, tx.currency)}`
        const amountText =
          tx.currency !== targetCurrency
            ? `${originalText} (≈ ${sign}${fmt(tx.amount * tx.exchangeRateToBase, targetCurrency)})`
            : originalText

        let payerText = ''
        if (tx.splitConfig) {
          const multi = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
          if (multi.length > 1) {
            payerText = options.formatMultiPayer
              ? options.formatMultiPayer(multi.length)
              : multi.map((p) => nameOf(p.memberId)).join('+')
          } else {
            payerText = nameOf(tx.splitConfig.payerId)
          }
        }

        const formattedLine = labels.detailItemLine
          ? labels.detailItemLine({
              date: tx.date,
              title,
              amountText,
              payerText,
            })
          : `${tx.date} ${title} ${amountText}${payerText ? ` (${payerText})` : ''}`

        lines.push(`• ${formattedLine}`)
      }
    }
  }

  // 已記錄之還款明細
  if (settlements.length > 0) {
    lines.push('')
    lines.push(labels.historyTitle)
    for (const tx of settlements) {
      const fromId = tx.splitConfig?.payerId ?? ''
      const toId = tx.splitConfig?.shares[0]?.memberId ?? ''
      lines.push(
        `• ${labels.paidHistoryLine(
          nameOf(fromId),
          nameOf(toId),
          fmt(tx.amount, tx.currency),
          tx.date,
        )}`,
      )
    }
  }

  lines.push('')
  lines.push(labels.footerTagline)

  return lines.join('\n')
}
