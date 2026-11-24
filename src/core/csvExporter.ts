import type { Project, Transaction } from '@/schemas/ledgerSchema'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'

export interface CsvExportLabels {
  headers: {
    date: string
    time: string
    type: string
    category: string
    note: string
    originalAmount: string
    currency: string
    exchangeRate: string
    baseAmount: string
    baseCurrency: string
    payers: string
    shares: string
  }
  typeNames: {
    expense: string
    refund: string
    transfer: string
    income: string
    card_repayment: string
  }
  resolveCategoryLabel: (categoryKey: string) => string
}

/**
 * 轉義 CSV 儲存格，並防止試算表公式注入（CSV Formula Injection）
 * 純有限數字直接保留數值格式（方便 Excel SUM 加總負數退款），文字欄位若以公式前綴開頭則加上單引號中性化
 */
export function escapeCsvCell(raw: string | number | undefined | null): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : ''
  }
  const str = String(raw)
  const neutralized = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str
  if (/[",\r\n]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`
  }
  return neutralized
}

/**
 * 將單一專案所有有效明細輸出為帶 UTF-8 BOM 的標準 CSV 字串（Excel 開啟中文不亂碼）
 */
export function buildProjectCsvContent(
  project: Project,
  transactions: Transaction[],
  labels: CsvExportLabels,
): string {
  const memberMap = new Map<string, string>()
  for (const m of project.members) {
    memberMap.set(m.id, m.name)
  }
  const nameOf = (id: string) => memberMap.get(id) ?? id

  const headerRow = [
    labels.headers.date,
    labels.headers.time,
    labels.headers.type,
    labels.headers.category,
    labels.headers.note,
    labels.headers.originalAmount,
    labels.headers.currency,
    labels.headers.exchangeRate,
    labels.headers.baseAmount,
    labels.headers.baseCurrency,
    labels.headers.payers,
    labels.headers.shares,
  ]
    .map(escapeCsvCell)
    .join(',')

  const sortedTxs = transactions
    .filter((tx) => !tx.isDeleted && tx.projectId === project.id)
    .sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date)
      if (dateCmp !== 0) return dateCmp
      const timeCmp = a.time.localeCompare(b.time)
      if (timeCmp !== 0) return timeCmp
      return a.updatedAt - b.updatedAt
    })

  const rows: string[] = [headerRow]

  for (const tx of sortedTxs) {
    const sign = tx.type === 'refund' ? -1 : 1
    const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
    const baseUnits = toMinorUnits(tx.amount * rate, project.baseCurrency)
    const signedBaseAmount = sign * fromMinorUnits(baseUnits, project.baseCurrency)
    const signedOriginalAmount = sign * tx.amount

    let payersText = ''
    let sharesText = ''

    if (tx.splitConfig) {
      const multi = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
      if (multi.length > 1) {
        payersText = multi
          .map((p) => `${nameOf(p.memberId)}: ${p.amount}`)
          .join(' / ')
      } else {
        payersText = nameOf(tx.splitConfig.payerId)
      }

      sharesText = tx.splitConfig.shares
        .filter((s) => s.finalAmount > 0)
        .map((s) => `${nameOf(s.memberId)}: ${s.finalAmount}`)
        .join(' / ')
    }

    const row = [
      tx.date,
      tx.time !== '00:00' ? tx.time : '',
      labels.typeNames[tx.type] ?? tx.type,
      labels.resolveCategoryLabel(tx.categoryKey),
      tx.note ?? '',
      signedOriginalAmount,
      tx.currency,
      rate,
      signedBaseAmount,
      project.baseCurrency,
      payersText,
      sharesText,
    ]
      .map(escapeCsvCell)
      .join(',')

    rows.push(row)
  }

  // 前綴 UTF-8 BOM（\uFEFF）確保 Windows Excel 直接開啟繁中／日文零亂碼
  return `\uFEFF${rows.join('\r\n')}`
}
