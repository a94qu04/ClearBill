import type { Transaction } from '@/schemas/ledgerSchema'

export interface DuplicateTxCandidate {
  projectId: string
  type: Transaction['type']
  date: string
  currency: string
  amount: number
  categoryKey: string
  note?: string
}

export interface DuplicateDetectionOptions {
  /** 金額比較容差，預設 0.005（對應小數點後兩位四捨五入邊界） */
  amountTolerance?: number
  /** 編輯既有帳目時可排除自身 ID */
  excludeTransactionId?: string
}

const DEFAULT_AMOUNT_TOLERANCE = 0.005

/**
 * 判斷既有帳目是否與即將新增之帳目疑似重複：
 * - 忽略已軟刪除之帳目與指定排除之 ID
 * - 須符合同專案、同類型、同日期、同幣別（不分大小寫）且金額差距小於容差
 * - 若兩筆皆有填寫不同備註，視為不同消費不誤報
 * - 若兩筆皆無備註，須分類相同才視為疑似重複
 */
export function isPotentialDuplicateTransaction(
  existing: Transaction,
  incoming: DuplicateTxCandidate,
  options: DuplicateDetectionOptions = {},
): boolean {
  if (existing.isDeleted) return false
  if (
    options.excludeTransactionId &&
    existing.id === options.excludeTransactionId
  ) {
    return false
  }

  const tolerance = options.amountTolerance ?? DEFAULT_AMOUNT_TOLERANCE
  if (
    existing.projectId !== incoming.projectId ||
    existing.type !== incoming.type ||
    existing.date !== incoming.date ||
    existing.currency.trim().toUpperCase() !==
      incoming.currency.trim().toUpperCase() ||
    Math.abs(existing.amount - incoming.amount) >= tolerance
  ) {
    return false
  }

  const incomingNote = (incoming.note ?? '').trim().toLowerCase()
  const existingNote = (existing.note ?? '').trim().toLowerCase()

  if (incomingNote && existingNote && incomingNote !== existingNote) {
    return false
  }
  if (
    !incomingNote &&
    !existingNote &&
    existing.categoryKey !== incoming.categoryKey
  ) {
    return false
  }

  return true
}

/**
 * 於帳目清單中尋找第一筆疑似重複的既有帳目，查無回傳 null
 */
export function findPotentialDuplicateTransaction(
  transactions: readonly Transaction[],
  incoming: DuplicateTxCandidate,
  options: DuplicateDetectionOptions = {},
): Transaction | null {
  for (const existing of transactions) {
    if (isPotentialDuplicateTransaction(existing, incoming, options)) {
      return existing
    }
  }
  return null
}
