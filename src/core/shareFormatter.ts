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
  poolSectionTitle?: string
  poolPaidLabel?: string
  poolRemainingLabel?: string
  poolOverdrawnLabel?: string
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
  const memberPaymentMap = new Map<string, string>()
  for (const member of project.members) {
    memberNameMap.set(member.id, member.name)
    if (member.paymentInfo?.trim()) {
      memberPaymentMap.set(member.id, member.paymentInfo.trim())
    }
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

  const poolIds = new Set(
    project.members.filter((m) => m.isPool).map((m) => m.id),
  )
  const poolBalances = settleUp.balances.filter((b) => poolIds.has(b.memberId))
  const humanBalances = settleUp.balances.filter((b) => !poolIds.has(b.memberId))

  // 公費袋獨立摘要（若有啟用公費袋，不與真人成員支出混列）
  if (poolBalances.length > 0) {
    lines.push(labels.poolSectionTitle ?? '▎Pool Fund')
    for (const pb of poolBalances) {
      const statusText =
        pb.netAmount < 0
          ? (labels.poolRemainingLabel ?? 'Remaining')
          : pb.netAmount > 0
            ? (labels.poolOverdrawnLabel ?? 'Overdrawn')
            : labels.allSettledText
      const paidLbl = labels.poolPaidLabel ?? labels.paidLabel
      lines.push(
        `• ${nameOf(pb.memberId)}｜${paidLbl} ${fmt(pb.totalPaid)}｜${statusText} ${fmt(Math.abs(pb.netAmount))}`,
      )
    }
    lines.push('')
  }

  // 各成員總支出與已墊付匯總
  lines.push(labels.memberSummaryTitle)
  for (const bal of humanBalances) {
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
      const recipientPayment = memberPaymentMap.get(transfer.toMemberId)
      if (recipientPayment) {
        lines.push(`  ↳ ${recipientPayment}`)
      }
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

export interface MemberStatementShareLabels {
  headerPrefix: string
  statementTitle: string
  spentLabel: string
  paidLabel: string
  netLabel: string
  shouldReceive: string
  shouldPay: string
  settled: string
  transfersTitle: string
  allSettledText: string
  entriesTitle: string
  refundTag: string
  transferLine: (from: string, to: string, amountText: string) => string
  footerTagline: string
}

export interface MemberStatementShareEntry {
  date: string
  title: string
  isRefund: boolean
  shareInSettle: number
  paidInSettle: number
}

/**
 * 產生「單一成員專屬對帳單」文字，方便大團直接私訊特定團員核對每一筆分攤與收款帳號
 */
export function buildMemberStatementShareText(
  project: Project,
  memberId: string,
  settleUp: SettleUpResult,
  entries: MemberStatementShareEntry[],
  labels: MemberStatementShareLabels,
  locale = 'zh-TW',
): string {
  const memberNameMap = new Map<string, string>()
  const memberPaymentMap = new Map<string, string>()
  for (const m of project.members) {
    memberNameMap.set(m.id, m.name)
    if (m.paymentInfo?.trim()) {
      memberPaymentMap.set(m.id, m.paymentInfo.trim())
    }
  }
  const targetCurrency = settleUp.currency || project.baseCurrency
  const nameOf = (id: string) => memberNameMap.get(id) ?? id
  const fmt = (amount: number, cur = targetCurrency) =>
    formatCurrencyAmount(amount, cur, locale)

  const bal = settleUp.balances.find((b) => b.memberId === memberId) ?? {
    memberId,
    totalExpense: 0,
    totalPaid: 0,
    netAmount: 0,
  }
  const netSign = bal.netAmount > 0 ? '+' : ''
  const statusText =
    bal.netAmount > 0
      ? labels.shouldReceive
      : bal.netAmount < 0
        ? labels.shouldPay
        : labels.settled

  const lines: string[] = []
  lines.push(`${labels.headerPrefix} ${project.name}`)
  lines.push(labels.statementTitle)
  lines.push(
    `${labels.spentLabel}: ${fmt(bal.totalExpense)} ｜ ${labels.paidLabel}: ${fmt(bal.totalPaid)}`,
  )
  lines.push(`${labels.netLabel}: ${netSign}${fmt(bal.netAmount)}（${statusText}）`)
  lines.push('')

  const relatedTransfers = settleUp.transfers.filter(
    (tr) => tr.fromMemberId === memberId || tr.toMemberId === memberId,
  )
  lines.push(labels.transfersTitle)
  if (relatedTransfers.length === 0) {
    lines.push(`• ${labels.allSettledText}`)
  } else {
    for (const tr of relatedTransfers) {
      lines.push(
        `• ${labels.transferLine(
          nameOf(tr.fromMemberId),
          nameOf(tr.toMemberId),
          fmt(tr.amount, tr.currency),
        )}`,
      )
      const recipientPayment = memberPaymentMap.get(tr.toMemberId)
      if (recipientPayment && tr.fromMemberId === memberId) {
        lines.push(`  ↳ ${recipientPayment}`)
      }
    }
  }

  if (entries.length > 0) {
    lines.push('')
    lines.push(`${labels.entriesTitle} (${entries.length})`)
    for (const item of entries) {
      const title = item.isRefund ? `[${labels.refundTag}] ${item.title}` : item.title
      const parts: string[] = []
      if (item.shareInSettle !== 0) {
        parts.push(`${labels.spentLabel} ${fmt(item.shareInSettle)}`)
      }
      if (item.paidInSettle !== 0) {
        parts.push(`${labels.paidLabel} ${fmt(item.paidInSettle)}`)
      }
      lines.push(`• ${item.date} ${title}｜${parts.join(' / ')}`)
    }
  }

  lines.push('')
  lines.push(labels.footerTagline)
  return lines.join('\n')
}
