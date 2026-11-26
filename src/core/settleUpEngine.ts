import { CurrencyCodeSchema, type Transaction } from '@/schemas/ledgerSchema'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'
import { computeTxLedgerBreakdown } from '@/core/memberLedger'
import { validateSplitInvariant } from '@/core/splitInvariant'

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

export interface SettleUpAnomaly {
  transactionId: string
  code: 'SHARE_SUM_MISMATCH' | 'PAYER_SUM_MISMATCH' | 'MISSING_SETTLEMENT_RATE'
  /** 差異的最小幣別單位數（超出容許尾差；匯率缺失時為 0） */
  diffUnits: number
  /** 容許的最小幣別單位數上限 */
  toleranceUnits: number
  /** 換算為對應幣別的差額（匯率缺失時為 0） */
  diffAmount: number
  currency: string
  /** 匯率缺失異常（MISSING_SETTLEMENT_RATE）時，記錄原始交易幣別 */
  sourceCurrency?: string
}

export interface MissingSettlementRateInfo {
  transactionId: string
  sourceCurrency: string
  projectBaseCurrency: string
  settlementCurrency: string
}

export interface ApplySettlementRatesOptions {
  /** 設為 true 時，跨幣結算且缺乏有效覆寫匯率與 baseToSettlementRate 將直接拋出 ERR_SETTLEMENT_RATE_INVALID */
  strict?: boolean
  /** 當有效交易因缺乏有效匯率而無法換算至結帳幣別時觸發回呼 */
  onMissingRate?: (info: MissingSettlementRateInfo) => void
}

export interface SettleUpResult {
  currency: string
  /** 專案所有消費總金額（不含還款轉帳） */
  totalProjectExpense: number
  balances: MemberNetBalance[]
  transfers: SettlementTransfer[]
  /** 偵測到拆帳不守恆或超出容許尾差之異常交易清單（正常為空陣列） */
  anomalies: SettleUpAnomaly[]
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
  anomalies: SettleUpAnomaly[] = [],
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
    anomalies,
  }
}

export interface SettleUpOptions {
  /** 選填：依幣別覆寫該幣別折合「結帳幣別」之匯率（例如統一套用即時匯率或自訂結算匯率） */
  overrideRatesByCurrency?: Record<string, number>
  /** 選填：專案原本的記帳主幣別（當結帳幣別 ≠ 記帳主幣別時，用於將原匯率換算至結帳幣別） */
  projectBaseCurrency?: string
  /** 選填：1 記帳主幣別 = ? 結帳幣別（於 per_tx 模式下跨結帳幣別換算使用） */
  baseToSettlementRate?: number
  /** 選填：設為 true 時，跨幣結算缺乏有效匯率會直接拋出 ERR_SETTLEMENT_RATE_INVALID；預設 false（改於 anomalies 回報 MISSING_SETTLEMENT_RATE） */
  strictRates?: boolean
}

/**
 * 依據指定的結帳幣別與覆寫匯率表，產出供圓餅圖、報表匯出與結算共用之交易清單副本（不修改原始資料）
 * - 跨幣別結算（settlementCurrency ≠ projectBaseCurrency）且交易幣別 ≠ settlementCurrency 時：
 *   1. 若提供有效 overrideRatesByCurrency[tx.currency]，直接套用覆寫匯率；
 *   2. 否則須以有效 baseToSettlementRate（> 0 且為有限數）乘以交易原對主幣別匯率；
 *   3. 若兩者皆無效，strict=true 時拋出 ERR_SETTLEMENT_RATE_INVALID；否則透過 onMissingRate 標記，絕不靜默當作 1:1 忽略異常。
 */
export function applySettlementRatesToTransactions(
  transactions: Transaction[],
  settlementCurrency: string,
  overrideRatesByCurrency?: Record<string, number>,
  projectBaseCurrency?: string,
  baseToSettlementRate?: number,
  applyOptions?: ApplySettlementRatesOptions,
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
    if (tx.isDeleted) {
      return tx
    }

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

    if (crossCurrencySettlement) {
      if (validBaseToTarget !== null) {
        const originalToBase =
          txCur === projBase ? 1 : tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
        const convertedRate = Number((originalToBase * validBaseToTarget).toFixed(6))
        if (Number.isFinite(convertedRate) && convertedRate > 0) {
          return {
            ...tx,
            exchangeRateToBase: convertedRate,
          }
        }
      }

      const missingInfo: MissingSettlementRateInfo = {
        transactionId: tx.id,
        sourceCurrency: txCur,
        projectBaseCurrency: projBase,
        settlementCurrency: target,
      }
      if (applyOptions?.strict) {
        throw new Error(
          `ERR_SETTLEMENT_RATE_INVALID: 無法將交易 ${tx.id} (${txCur}) 換算至結帳幣別 ${target}（缺少有效覆寫匯率與 baseToSettlementRate）`,
        )
      }
      applyOptions?.onMissingRate?.(missingInfo)
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
  const missingRateByTxId = new Map<string, MissingSettlementRateInfo>()
  const effectiveTransactions = applySettlementRatesToTransactions(
    transactions,
    currency,
    options?.overrideRatesByCurrency,
    options?.projectBaseCurrency,
    options?.baseToSettlementRate,
    {
      strict: options?.strictRates,
      onMissingRate: (info) => {
        missingRateByTxId.set(info.transactionId, info)
      },
    },
  )
  const netUnitMap = new Map<string, number>()
  const expenseUnitMap = new Map<string, number>()
  const paidUnitMap = new Map<string, number>()
  const anomalies: SettleUpAnomaly[] = []
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
    const breakdown = computeTxLedgerBreakdown(tx, currency)
    if (!breakdown) {
      continue
    }

    const missingRate = missingRateByTxId.get(tx.id)
    if (missingRate) {
      anomalies.push({
        transactionId: tx.id,
        code: 'MISSING_SETTLEMENT_RATE',
        diffUnits: 0,
        toleranceUnits: 0,
        diffAmount: 0,
        currency: missingRate.settlementCurrency,
        sourceCurrency: missingRate.sourceCurrency,
      })
    }

    const invariantCheck = validateSplitInvariant(tx)
    for (const violation of invariantCheck.violations) {
      if (violation.code === 'SHARE_SUM_MISMATCH') {
        anomalies.push({
          transactionId: tx.id,
          code: 'SHARE_SUM_MISMATCH',
          diffUnits: violation.diffUnits,
          toleranceUnits: 0,
          diffAmount: violation.diffAmount,
          currency: violation.currency,
        })
      }
    }

    if (breakdown.payerSumMismatch) {
      anomalies.push({
        transactionId: tx.id,
        code: 'PAYER_SUM_MISMATCH',
        diffUnits: breakdown.payerSumMismatch.diffUnits,
        toleranceUnits: breakdown.payerSumMismatch.toleranceUnits,
        diffAmount: breakdown.payerSumMismatch.diffAmount,
        currency: breakdown.payerSumMismatch.currency,
      })
    }

    const { direction, isSpendingTx } = breakdown

    for (const [memberId, shareBaseUnits] of breakdown.shareUnitsByMember.entries()) {
      addUnits(netUnitMap, memberId, -direction * shareBaseUnits)
      if (isSpendingTx) {
        addUnits(expenseUnitMap, memberId, direction * shareBaseUnits)
      }
    }

    if (isSpendingTx) {
      totalProjectExpenseUnits += direction * breakdown.totalShareUnits
    }

    for (const [memberId, payerBaseUnits] of breakdown.paidUnitsByMember.entries()) {
      addUnits(netUnitMap, memberId, direction * payerBaseUnits)
      if (isSpendingTx) {
        addUnits(paidUnitMap, memberId, direction * payerBaseUnits)
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
    anomalies,
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
