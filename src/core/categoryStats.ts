import type { Transaction } from '@/schemas/ledgerSchema'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'

export interface CategoryStatItem {
  categoryKey: string
  /** 換算為專案基準幣別後之淨支出金額（已扣除退款） */
  amount: number
  /** 佔總正淨支出之百分比（0 ~ 100，保留一位小數） */
  percentage: number
  /** 該分類之交易筆數（含支出與退款） */
  count: number
}

export interface CategoryStatsResult {
  currency: string
  /** 扣除退款後之專案淨消費總額 */
  totalNetExpense: number
  /** 供圓餅圖顯示之正值分類加總 */
  positiveChartTotal: number
  /** 依金額由高到低排序之分類統計（僅含淨額 > 0 之分類供圓餅圖繪製） */
  items: CategoryStatItem[]
}

/**
 * 計算專案各消費分類的淨支出結構（純 TypeScript 函式）
 * - 自動忽略已軟刪除（isDeleted）與還款轉帳（transfer）
 * - 依 exchangeRateToBase 換算為專案基準幣別之最小整數單位，確保與結算引擎零誤差
 * - 支援退款（refund）沖銷同分類支出
 */
export function calculateCategoryStats(
  transactions: Transaction[],
  baseCurrency = 'TWD',
): CategoryStatsResult {
  const currency = baseCurrency.trim().toUpperCase()
  const unitByCategory = new Map<string, number>()
  const countByCategory = new Map<string, number>()
  let totalNetUnits = 0

  for (const tx of transactions) {
    if (tx.isDeleted) continue
    if (tx.type !== 'expense' && tx.type !== 'refund') continue

    const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
    const direction = tx.type === 'refund' ? -1 : 1

    // 若有拆帳明細則與 settleUpEngine 相同以各分攤單位加總，確保完全一致
    let txBaseUnits = 0
    if (tx.splitConfig && tx.splitConfig.shares.length > 0) {
      for (const share of tx.splitConfig.shares) {
        txBaseUnits += toMinorUnits(share.finalAmount * rate, currency)
      }
    } else {
      txBaseUnits = toMinorUnits(tx.amount * rate, currency)
    }

    const signedUnits = direction * txBaseUnits
    totalNetUnits += signedUnits
    unitByCategory.set(
      tx.categoryKey,
      (unitByCategory.get(tx.categoryKey) ?? 0) + signedUnits,
    )
    countByCategory.set(
      tx.categoryKey,
      (countByCategory.get(tx.categoryKey) ?? 0) + 1,
    )
  }

  const positiveEntries: Array<{
    categoryKey: string
    units: number
    count: number
  }> = []
  let positiveTotalUnits = 0

  for (const [categoryKey, units] of unitByCategory.entries()) {
    if (units > 0) {
      positiveTotalUnits += units
      positiveEntries.push({
        categoryKey,
        units,
        count: countByCategory.get(categoryKey) ?? 0,
      })
    }
  }

  positiveEntries.sort((a, b) => {
    if (b.units !== a.units) return b.units - a.units
    return a.categoryKey.localeCompare(b.categoryKey)
  })

  const items: CategoryStatItem[] = positiveEntries.map((entry) => ({
    categoryKey: entry.categoryKey,
    amount: fromMinorUnits(entry.units, currency),
    percentage:
      positiveTotalUnits > 0
        ? Number(((entry.units / positiveTotalUnits) * 100).toFixed(1))
        : 0,
    count: entry.count,
  }))

  return {
    currency,
    totalNetExpense: fromMinorUnits(totalNetUnits, currency),
    positiveChartTotal: fromMinorUnits(positiveTotalUnits, currency),
    items,
  }
}
