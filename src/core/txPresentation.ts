import type { Transaction } from '@/schemas/ledgerSchema'

export interface TxPayerEntry {
  memberId: string
  amount: number
}

export interface DescribePayersOptions {
  /** 多人墊付時的串接符號（一般模式預設 `'+'`，`includeAmounts: true` 時預設 `' / '`） */
  separator?: string
  /** 多人墊付時是否附上各別墊付金額（例：`Alice: 100 / Bob: 200`） */
  includeAmounts?: boolean
  /** `includeAmounts: true` 時的名稱與金額分隔符號（預設 `': '`） */
  amountSeparator?: string
  /** `includeAmounts: true` 時的自訂金額格式化函式（預設 `String(amount)`） */
  formatAmount?: (amount: number) => string
  /** 多人墊付時的自訂摘要文案（如 `3 人共同墊付`），設定時優先於清單串接 */
  formatMultiPayer?: (count: number, payers: TxPayerEntry[]) => string
  /** 無付款人資訊（缺 splitConfig 或 payerId 為空）時的回退字串（預設 `''`） */
  emptyFallback?: string
}

/**
 * 擷取單筆交易之有效付款人清單（已過濾 amount <= 0 之無效多人墊付項目）。
 * - 多人墊付（有效 payers 筆數 > 1）：回傳所有有效付款人與金額
 * - 單人墊付：優先取唯一有效 payer，否則回退至 `splitConfig.payerId`
 */
export function getTxPayerEntries(
  tx: Pick<Transaction, 'splitConfig'>,
): TxPayerEntry[] {
  const split = tx.splitConfig
  if (!split) return []

  const positivePayers = (split.payers ?? []).filter((p) => p.amount > 0)
  if (positivePayers.length > 1) {
    return positivePayers.map((p) => ({
      memberId: p.memberId,
      amount: p.amount,
    }))
  }

  if (positivePayers.length === 1) {
    const single = positivePayers[0]
    const id = single.memberId || split.payerId
    return id ? [{ memberId: id, amount: single.amount }] : []
  }

  return split.payerId ? [{ memberId: split.payerId, amount: 0 }] : []
}

/**
 * 擷取單筆交易之有效付款人成員 ID 陣列。
 */
export function getTxPayerIds(
  tx: Pick<Transaction, 'splitConfig'>,
): string[] {
  return getTxPayerEntries(tx).map((p) => p.memberId)
}

/**
 * 將單筆交易之付款人統一格式化為呈現標籤。
 * 供 LINE 結算分享、Excel 匯出、長圖報表與結算頁還款明細共用。
 */
export function describePayers(
  tx: Pick<Transaction, 'splitConfig'>,
  nameOf: (memberId: string) => string,
  options: DescribePayersOptions = {},
): string {
  const payers = getTxPayerEntries(tx)
  if (payers.length === 0) {
    return options.emptyFallback ?? ''
  }

  if (payers.length === 1) {
    return nameOf(payers[0].memberId)
  }

  if (options.formatMultiPayer) {
    return options.formatMultiPayer(payers.length, payers)
  }

  if (options.includeAmounts) {
    const sep = options.separator ?? ' / '
    const kvSep = options.amountSeparator ?? ': '
    const fmtAmount = options.formatAmount ?? ((amount: number) => String(amount))
    return payers
      .map((p) => `${nameOf(p.memberId)}${kvSep}${fmtAmount(p.amount)}`)
      .join(sep)
  }

  const sep = options.separator ?? '+'
  return payers.map((p) => nameOf(p.memberId)).join(sep)
}
