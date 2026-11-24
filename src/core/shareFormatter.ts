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
  transferLine: (from: string, to: string, amountText: string) => string
  paidHistoryLine: (from: string, to: string, amountText: string, date: string) => string
  footerTagline: string
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
): string {
  const memberNameMap = new Map<string, string>()
  for (const member of project.members) {
    memberNameMap.set(member.id, member.name)
  }
  const nameOf = (id: string) => memberNameMap.get(id) ?? id
  const fmt = (amount: number, currency = project.baseCurrency) =>
    formatCurrencyAmount(amount, currency, locale)

  const lines: string[] = []
  lines.push(`${labels.headerPrefix} ${project.name}`)
  lines.push(
    `${labels.totalSpendLabel}: ${fmt(settleUp.totalProjectExpense, project.baseCurrency)}`,
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
