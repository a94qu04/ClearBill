import { CurrencyCodeSchema, type Transaction } from '@/schemas/ledgerSchema'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'

export interface MemberNetBalance {
  memberId: string
  /** 該成員實際應負擔之消費總支出（不含還款轉帳，已扣除退款） */
  totalExpense: number
  /** 該成員實際墊付之總金額（不含還款轉帳，已扣除退款） */
  totalPaid: number
  /** 正值表示應收回款項（債權人），負值表示應支付款項（債務人），已計入所有已付還款 */
  netAmount: number
}

export interface SettlementTransfer {
  fromMemberId: string
  toMemberId: string
  amount: number
  currency: string
}

export interface SettleUpResult {
  currency: string
  /** 專案所有消費總金額（不含還款轉帳） */
  totalProjectExpense: number
  balances: MemberNetBalance[]
  transfers: SettlementTransfer[]
}

interface UnitBalanceEntry {
  memberId: string
  units: number
}

/**
 * 依據多位成員的最小單位淨餘額，執行 Greedy Debt Simplification 最小化轉帳次數
 * 前提：所有成員淨額總和為 0
 */
function simplifyDebtFromUnits(
  netUnitMap: Map<string, number>,
  expenseUnitMap: Map<string, number>,
  paidUnitMap: Map<string, number>,
  totalProjectExpenseUnits: number,
  currency: string,
): SettleUpResult {
  const sortedMemberIds = Array.from(netUnitMap.keys()).sort((a, b) =>
    a.localeCompare(b),
  )

  const balances: MemberNetBalance[] = sortedMemberIds.map((memberId) => ({
    memberId,
    totalExpense: fromMinorUnits(expenseUnitMap.get(memberId) ?? 0, currency),
    totalPaid: fromMinorUnits(paidUnitMap.get(memberId) ?? 0, currency),
    netAmount: fromMinorUnits(netUnitMap.get(memberId) ?? 0, currency),
  }))

  const creditors: UnitBalanceEntry[] = []
  const debtors: UnitBalanceEntry[] = []

  for (const memberId of sortedMemberIds) {
    const units = netUnitMap.get(memberId) ?? 0
    if (units > 0) {
      creditors.push({ memberId, units })
    } else if (units < 0) {
      debtors.push({ memberId, units: -units })
    }
  }

  const transfers: SettlementTransfer[] = []

  const sortDesc = (a: UnitBalanceEntry, b: UnitBalanceEntry) => {
    if (b.units !== a.units) {
      return b.units - a.units
    }
    return a.memberId.localeCompare(b.memberId)
  }

  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort(sortDesc)
    debtors.sort(sortDesc)

    const topCreditor = creditors[0]
    const topDebtor = debtors[0]
    const transferUnits = Math.min(topCreditor.units, topDebtor.units)

    if (transferUnits > 0) {
      transfers.push({
        fromMemberId: topDebtor.memberId,
        toMemberId: topCreditor.memberId,
        amount: fromMinorUnits(transferUnits, currency),
        currency,
      })
    }

    topCreditor.units -= transferUnits
    topDebtor.units -= transferUnits

    if (topCreditor.units === 0) {
      creditors.shift()
    }
    if (topDebtor.units === 0) {
      debtors.shift()
    }
  }

  return {
    currency,
    totalProjectExpense: fromMinorUnits(totalProjectExpenseUnits, currency),
    balances,
    transfers,
  }
}

/**
 * 多人債務最小化結算演算法（Greedy Debt Simplification）
 * - 自動忽略已軟刪除（isDeleted）與不含 splitConfig 的交易
 * - 支援 expense（單人或多人墊付支出）、refund（退款返還）與 transfer（專案內已付還款沖銷）
 * - 同步計算每位成員的個人消費總支出（totalExpense）、總墊付（totalPaid）與淨收支（netAmount）
 * - 支援跨幣別交易：自動依 exchangeRateToBase 換算至專案基準幣別，並確保系統總淨額恆等於 0
 */
export function calculateSettleUp(
  transactions: Transaction[],
  baseCurrency = 'TWD',
  knownMemberIds: string[] = [],
): SettleUpResult {
  const currency = CurrencyCodeSchema.parse(baseCurrency)
  const netUnitMap = new Map<string, number>()
  const expenseUnitMap = new Map<string, number>()
  const paidUnitMap = new Map<string, number>()
  let totalProjectExpenseUnits = 0

  const ensureMember = (memberId: string) => {
    if (!netUnitMap.has(memberId)) netUnitMap.set(memberId, 0)
    if (!expenseUnitMap.has(memberId)) expenseUnitMap.set(memberId, 0)
    if (!paidUnitMap.has(memberId)) paidUnitMap.set(memberId, 0)
  }

  for (const memberId of knownMemberIds) {
    ensureMember(memberId)
  }

  const addUnits = (map: Map<string, number>, memberId: string, delta: number) => {
    ensureMember(memberId)
    map.set(memberId, (map.get(memberId) ?? 0) + delta)
  }

  for (const tx of transactions) {
    if (tx.isDeleted || !tx.splitConfig) {
      continue
    }
    if (tx.type !== 'expense' && tx.type !== 'refund' && tx.type !== 'transfer') {
      continue
    }

    const { payerId, payers, shares } = tx.splitConfig
    const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
    // expense / transfer：付款方 (+)，分攤/收款方 (-)；refund 方向相反
    const direction = tx.type === 'refund' ? -1 : 1
    const isSpendingTx = tx.type === 'expense' || tx.type === 'refund'

    let totalShareUnitsInBase = 0

    for (const share of shares) {
      const shareBaseUnits = toMinorUnits(share.finalAmount * rate, currency)
      totalShareUnitsInBase += shareBaseUnits
      addUnits(netUnitMap, share.memberId, -direction * shareBaseUnits)
      if (isSpendingTx) {
        addUnits(expenseUnitMap, share.memberId, direction * shareBaseUnits)
      }
    }

    if (isSpendingTx) {
      totalProjectExpenseUnits += direction * totalShareUnitsInBase
    }

    // 支援多人墊付（splitConfig.payers），若未提供則向下相容使用單一 payerId
    const activePayers = (payers ?? []).filter((p) => p.amount > 0)
    if (activePayers.length > 0) {
      const payerBaseUnitsList = activePayers.map((p) => ({
        memberId: p.memberId,
        units: toMinorUnits(p.amount * rate, currency),
      }))
      const payerSum = payerBaseUnitsList.reduce((acc, p) => acc + p.units, 0)
      const roundingDiff = totalShareUnitsInBase - payerSum
      if (roundingDiff !== 0) {
        payerBaseUnitsList[0].units += roundingDiff
      }
      for (const entry of payerBaseUnitsList) {
        addUnits(netUnitMap, entry.memberId, direction * entry.units)
        if (isSpendingTx) {
          addUnits(paidUnitMap, entry.memberId, direction * entry.units)
        }
      }
    } else {
      addUnits(netUnitMap, payerId, direction * totalShareUnitsInBase)
      if (isSpendingTx) {
        addUnits(paidUnitMap, payerId, direction * totalShareUnitsInBase)
      }
    }
  }

  return simplifyDebtFromUnits(
    netUnitMap,
    expenseUnitMap,
    paidUnitMap,
    totalProjectExpenseUnits,
    currency,
  )
}

/**
 * 直接由已知各成員淨餘額計算最小化轉帳方案（方便獨立呼叫與測試）
 */
export function simplifyNetBalances(
  netBalances: Record<string, number>,
  currency = 'TWD',
): SettleUpResult {
  const normalizedCurrency = CurrencyCodeSchema.parse(currency)
  const netUnitMap = new Map<string, number>()
  const emptyMap = new Map<string, number>()

  for (const [memberId, amount] of Object.entries(netBalances)) {
    netUnitMap.set(memberId, toMinorUnits(amount, normalizedCurrency))
    emptyMap.set(memberId, 0)
  }

  return simplifyDebtFromUnits(
    netUnitMap,
    emptyMap,
    emptyMap,
    0,
    normalizedCurrency,
  )
}
