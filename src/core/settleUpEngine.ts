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
  orderedMemberIds: string[] = [],
): SettleUpResult {
  // 優先保留專案原始成員順序（不再以 UUID 隨機排序），未在清單中的成員依字母順序補於後方
  const orderedSet = new Set<string>()
  const finalMemberIds: string[] = []
  for (const id of orderedMemberIds) {
    if (netUnitMap.has(id) && !orderedSet.has(id)) {
      orderedSet.add(id)
      finalMemberIds.push(id)
    }
  }
  const extraIds = Array.from(netUnitMap.keys())
    .filter((id) => !orderedSet.has(id))
    .sort((a, b) => a.localeCompare(b))
  finalMemberIds.push(...extraIds)

  const balances: MemberNetBalance[] = finalMemberIds.map((memberId) => ({
    memberId,
    totalExpense: fromMinorUnits(expenseUnitMap.get(memberId) ?? 0, currency),
    totalPaid: fromMinorUnits(paidUnitMap.get(memberId) ?? 0, currency),
    netAmount: fromMinorUnits(netUnitMap.get(memberId) ?? 0, currency),
  }))

  const creditors: UnitBalanceEntry[] = []
  const debtors: UnitBalanceEntry[] = []

  for (const memberId of finalMemberIds) {
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

export interface SettleUpOptions {
  /** 選填：依幣別覆寫該幣別折合「結帳幣別」之匯率（例如統一套用即時匯率或自訂結算匯率） */
  overrideRatesByCurrency?: Record<string, number>
  /** 選填：專案原本的記帳主幣別（當結帳幣別 ≠ 記帳主幣別時，用於將原匯率換算至結帳幣別） */
  projectBaseCurrency?: string
  /** 選填：1 記帳主幣別 = ? 結帳幣別（於 per_tx 模式下跨結帳幣別換算使用） */
  baseToSettlementRate?: number
}

/**
 * 依據指定的結帳幣別與覆寫匯率表，產出供圓餅圖、報表匯出與結算共用之交易清單副本（不修改原始資料）
 */
export function applySettlementRatesToTransactions(
  transactions: Transaction[],
  settlementCurrency: string,
  overrideRatesByCurrency?: Record<string, number>,
  projectBaseCurrency?: string,
  baseToSettlementRate?: number,
): Transaction[] {
  const target = settlementCurrency.trim().toUpperCase()
  const projBase = (projectBaseCurrency || target).trim().toUpperCase()
  const hasOverrides = Boolean(
    overrideRatesByCurrency && Object.keys(overrideRatesByCurrency).length > 0,
  )
  const crossCurrencySettlement = target !== projBase

  if (!hasOverrides && !crossCurrencySettlement) {
    return transactions
  }

  const validBaseToTarget =
    typeof baseToSettlementRate === 'number' &&
    Number.isFinite(baseToSettlementRate) &&
    baseToSettlementRate > 0
      ? baseToSettlementRate
      : null

  return transactions.map((tx) => {
    const txCur = tx.currency.trim().toUpperCase()
    if (txCur === target) {
      return tx.exchangeRateToBase === 1
        ? tx
        : {
            ...tx,
            exchangeRateToBase: 1,
          }
    }

    const override = overrideRatesByCurrency?.[txCur]
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return {
        ...tx,
        exchangeRateToBase: override,
      }
    }

    if (crossCurrencySettlement && validBaseToTarget !== null) {
      const originalToBase = txCur === projBase ? 1 : tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
      const convertedRate = Number((originalToBase * validBaseToTarget).toFixed(6))
      if (Number.isFinite(convertedRate) && convertedRate > 0) {
        return {
          ...tx,
          exchangeRateToBase: convertedRate,
        }
      }
    }

    return tx
  })
}

/**
 * 多人債務最小化結算演算法（Greedy Debt Simplification）
 * - 自動忽略已軟刪除（isDeleted）與不含 splitConfig 的交易
 * - 支援 expense（單人或多人墊付支出）、refund（退款返還）與 transfer（專案內已付還款沖銷）
 * - 同步計算每位成員的個人消費總支出（totalExpense）、總墊付（totalPaid）與淨收支（netAmount）
 * - 支援跨幣別交易與獨立結帳幣別：可依各筆原匯率、即時匯率或自訂匯率換算至結帳幣別，並確保系統總淨額恆等於 0
 */
export function calculateSettleUp(
  transactions: Transaction[],
  settlementCurrency = 'TWD',
  knownMemberIds: string[] = [],
  options?: SettleUpOptions,
): SettleUpResult {
  const currency = CurrencyCodeSchema.parse(settlementCurrency)
  const effectiveTransactions = applySettlementRatesToTransactions(
    transactions,
    currency,
    options?.overrideRatesByCurrency,
    options?.projectBaseCurrency,
    options?.baseToSettlementRate,
  )
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

  for (const tx of effectiveTransactions) {
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
    knownMemberIds,
  )
}

/**
 * 集中收付模式（財務長統一窗口）：
 * - 所有負債成員統一轉帳給指定的 hubMemberId（財務長 / 公費袋）
 * - hubMemberId 再統一轉帳給所有債權成員
 * - 若系統總淨額守恆，則所有轉帳完成後全體淨額必精準歸零
 */
export function buildHubSettlementTransfers(
  balances: MemberNetBalance[],
  hubMemberId: string,
  currency = 'TWD',
): SettlementTransfer[] {
  const normalizedCurrency = CurrencyCodeSchema.parse(currency)
  if (!hubMemberId) return []

  const inbound: SettlementTransfer[] = []
  const outbound: SettlementTransfer[] = []

  for (const bal of balances) {
    if (bal.memberId === hubMemberId) continue
    const units = toMinorUnits(bal.netAmount, normalizedCurrency)
    if (units < 0) {
      inbound.push({
        fromMemberId: bal.memberId,
        toMemberId: hubMemberId,
        amount: fromMinorUnits(-units, normalizedCurrency),
        currency: normalizedCurrency,
      })
    } else if (units > 0) {
      outbound.push({
        fromMemberId: hubMemberId,
        toMemberId: bal.memberId,
        amount: fromMinorUnits(units, normalizedCurrency),
        currency: normalizedCurrency,
      })
    }
  }

  // 先列「大家繳給財務長」（金額高到低），再列「財務長發給大家」（金額高到低）
  inbound.sort((a, b) => b.amount - a.amount)
  outbound.sort((a, b) => b.amount - a.amount)
  return [...inbound, ...outbound]
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
