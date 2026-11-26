import type { Transaction } from '@/schemas/ledgerSchema'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'
import { getSettlementRoundingToleranceUnits } from '@/core/splitInvariant'

export interface TxPayerSumMismatch {
  diffUnits: number
  toleranceUnits: number
  diffAmount: number
  currency: string
}

export interface TxLedgerBreakdown {
  transactionId: string
  currency: string
  /** expense / transfer 為 +1；refund 為 -1 */
  direction: 1 | -1
  /** 是否為消費／退款交易（transfer 為 false，不計入 totalExpense / totalPaid） */
  isSpendingTx: boolean
  /** 該筆交易全部 shares 換算為目標幣別後的最小單位總和（未乘 direction） */
  totalShareUnits: number
  /** 各成員分攤之最小單位（已合併同成員重複項目，忽略 0 單位，未乘 direction） */
  shareUnitsByMember: Map<string, number>
  /** 各成員墊付／付款之最小單位（單人墊付以 totalShareUnits 計、多人墊付含容許尾差吸收，未乘 direction） */
  paidUnitsByMember: Map<string, number>
  /** 多人墊付換算後超出容許尾差時回報之異常資訊 */
  payerSumMismatch: TxPayerSumMismatch | null
}

export interface MemberTxContribution {
  /** 該成員於此筆交易之帶符號應負擔支出（expense 為正、refund 為負、transfer 為 0） */
  share: number
  /** 該成員於此筆交易之帶符號實際墊付（expense 為正、refund 為負、transfer 為 0） */
  paid: number
  /** 該成員於此筆交易之淨收支影響（含 transfer 還款沖銷；正數代表應收回、負數代表應支付） */
  net: number
  shareUnits: number
  paidUnits: number
  netUnits: number
  isSpendingTx: boolean
}

export interface MemberTransactionsSummary {
  currency: string
  totalExpense: number
  totalPaid: number
  netAmount: number
  totalExpenseUnits: number
  totalPaidUnits: number
  netAmountUnits: number
}

const ZERO_CONTRIBUTION: MemberTxContribution = {
  share: 0,
  paid: 0,
  net: 0,
  shareUnits: 0,
  paidUnits: 0,
  netUnits: 0,
  isSpendingTx: false,
}

/** 最大餘數法非負整數分配：確保所有項目皆 >= 0 且總和 100% 等於 totalUnits */
function allocateNonNegativeUnits(
  totalUnits: number,
  weights: number[],
): number[] {
  const out = new Array<number>(weights.length).fill(0)
  if (totalUnits <= 0 || !Number.isFinite(totalUnits)) return out
  let maxW = 0
  for (const w of weights) {
    if (Number.isFinite(w) && w > maxW) maxW = w
  }
  if (maxW <= 0) return out
  const norm = weights.map((w) => (Number.isFinite(w) && w > 0 ? w / maxW : 0))
  const sum = norm.reduce((acc, w) => acc + w, 0)
  if (!Number.isFinite(sum) || sum <= 0) return out
  const rems: Array<{ idx: number; frac: number }> = []
  let allocated = 0
  for (let i = 0; i < norm.length; i += 1) {
    if (norm[i] <= 0) {
      rems.push({ idx: i, frac: -1 })
      continue
    }
    const exact = totalUnits * (norm[i] / sum)
    const floored = Math.floor(exact)
    out[i] = floored
    allocated += floored
    rems.push({ idx: i, frac: exact - floored })
  }
  let leftover = totalUnits - allocated
  if (leftover > 0) {
    rems.sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.idx - b.idx))
    for (const r of rems) {
      if (leftover <= 0) break
      if (r.frac < 0) continue
      out[r.idx] += 1
      leftover -= 1
    }
  }
  return out
}

/**
 * 將單筆交易依結算引擎同一套規則拆解為目標幣別之最小單位（minor units）分攤與墊付明細：
 * - 自動忽略已軟刪除（isDeleted）、無 splitConfig 或非 expense/refund/transfer 之交易
 * - 採最大餘數法將總基準單位非負分配給各分攤成員，確保小額外幣消費不蒸發歸 0
 * - 單人墊付統一以 Σshares（totalShareUnits）記入墊付方，避免跨幣別四捨五入造成系統不守恆與口徑不一
 * - 多人墊付（splitConfig.payers）於容許尾差內以最大餘數法非負分配確保總和守恆且絕不出現負值，超出容許尾差則標記 payerSumMismatch
 */
export function computeTxLedgerBreakdown(
  tx: Transaction,
  currency: string,
): TxLedgerBreakdown | null {
  if (tx.isDeleted || !tx.splitConfig) {
    return null
  }
  if (tx.type !== 'expense' && tx.type !== 'refund' && tx.type !== 'transfer') {
    return null
  }

  const normalizedCurrency = currency.trim().toUpperCase()
  const { payerId, payers, shares } = tx.splitConfig
  const rate =
    Number.isFinite(tx.exchangeRateToBase) && tx.exchangeRateToBase > 0
      ? tx.exchangeRateToBase
      : 1
  const direction: 1 | -1 = tx.type === 'refund' ? -1 : 1
  const isSpendingTx = tx.type === 'expense' || tx.type === 'refund'

  const positiveShares = shares.filter(
    (s) => Number.isFinite(s.finalAmount) && s.finalAmount > 0,
  )
  const origShareTotal = positiveShares.reduce(
    (acc, s) => acc + s.finalAmount,
    0,
  )
  const totalShareUnits = toMinorUnits(
    origShareTotal * rate,
    normalizedCurrency,
  )

  const shareUnitsByMember = new Map<string, number>()
  if (totalShareUnits > 0 && positiveShares.length > 0) {
    const allocatedShareUnits = allocateNonNegativeUnits(
      totalShareUnits,
      positiveShares.map((s) => s.finalAmount),
    )
    for (let i = 0; i < positiveShares.length; i += 1) {
      const shareBaseUnits = allocatedShareUnits[i]
      if (shareBaseUnits <= 0) continue
      const memberId = positiveShares[i].memberId
      shareUnitsByMember.set(
        memberId,
        (shareUnitsByMember.get(memberId) ?? 0) + shareBaseUnits,
      )
    }
  }

  const paidUnitsByMember = new Map<string, number>()
  let payerSumMismatch: TxPayerSumMismatch | null = null

  const activePayers = (payers ?? []).filter(
    (p) => Number.isFinite(p.amount) && p.amount > 0,
  )
  if (activePayers.length > 0) {
    const payerBaseUnitsList = activePayers.map((p) => ({
      memberId: p.memberId,
      units: toMinorUnits(p.amount * rate, normalizedCurrency),
    }))
    const payerSum = payerBaseUnitsList.reduce((acc, p) => acc + p.units, 0)
    const roundingDiff = totalShareUnits - payerSum
    const toleranceUnits = getSettlementRoundingToleranceUnits(tx)

    if (roundingDiff !== 0 && Math.abs(roundingDiff) <= toleranceUnits) {
      const allocatedPayerUnits = allocateNonNegativeUnits(
        totalShareUnits,
        activePayers.map((p) => p.amount),
      )
      for (let i = 0; i < activePayers.length; i += 1) {
        const units = allocatedPayerUnits[i]
        if (units <= 0) continue
        const memberId = activePayers[i].memberId
        paidUnitsByMember.set(
          memberId,
          (paidUnitsByMember.get(memberId) ?? 0) + units,
        )
      }
    } else {
      if (roundingDiff !== 0) {
        payerSumMismatch = {
          diffUnits: roundingDiff,
          toleranceUnits,
          diffAmount: fromMinorUnits(roundingDiff, normalizedCurrency),
          currency: normalizedCurrency,
        }
      }
      for (const entry of payerBaseUnitsList) {
        paidUnitsByMember.set(
          entry.memberId,
          (paidUnitsByMember.get(entry.memberId) ?? 0) + entry.units,
        )
      }
    }
  } else {
    paidUnitsByMember.set(
      payerId,
      (paidUnitsByMember.get(payerId) ?? 0) + totalShareUnits,
    )
  }

  return {
    transactionId: tx.id,
    currency: normalizedCurrency,
    direction,
    isSpendingTx,
    totalShareUnits,
    shareUnitsByMember,
    paidUnitsByMember,
    payerSumMismatch,
  }
}

/**
 * 計算單一成員於單筆交易中的分攤（share）、墊付（paid）與淨收支（net）貢獻。
 * 供結算引擎、個人對帳單、明細成員小計共用，保證口徑 100% 一致。
 */
export function computeMemberTxContribution(
  tx: Transaction,
  memberId: string,
  currency: string,
): MemberTxContribution {
  if (!memberId) {
    return ZERO_CONTRIBUTION
  }

  const breakdown = computeTxLedgerBreakdown(tx, currency)
  if (!breakdown) {
    return ZERO_CONTRIBUTION
  }

  const rawShareUnits = breakdown.shareUnitsByMember.get(memberId) ?? 0
  const rawPaidUnits = breakdown.paidUnitsByMember.get(memberId) ?? 0
  const signedRawShare = breakdown.direction * rawShareUnits
  const signedRawPaid = breakdown.direction * rawPaidUnits

  const shareUnits = breakdown.isSpendingTx ? signedRawShare : 0
  const paidUnits = breakdown.isSpendingTx ? signedRawPaid : 0
  const netUnits = signedRawPaid - signedRawShare

  return {
    share: fromMinorUnits(shareUnits, breakdown.currency),
    paid: fromMinorUnits(paidUnits, breakdown.currency),
    net: fromMinorUnits(netUnits, breakdown.currency),
    shareUnits,
    paidUnits,
    netUnits,
    isSpendingTx: breakdown.isSpendingTx,
  }
}

/**
 * 彙總單一成員於多筆交易中的總支出、總墊付與淨收支（採 minor units 累加，與 calculateSettleUp 精準對拍）
 */
export function summarizeMemberTransactions(
  transactions: Transaction[],
  memberId: string,
  currency: string,
): MemberTransactionsSummary {
  const normalizedCurrency = currency.trim().toUpperCase()
  let totalExpenseUnits = 0
  let totalPaidUnits = 0
  let netAmountUnits = 0

  for (const tx of transactions) {
    const contrib = computeMemberTxContribution(tx, memberId, normalizedCurrency)
    totalExpenseUnits += contrib.shareUnits
    totalPaidUnits += contrib.paidUnits
    netAmountUnits += contrib.netUnits
  }

  return {
    currency: normalizedCurrency,
    totalExpense: fromMinorUnits(totalExpenseUnits, normalizedCurrency),
    totalPaid: fromMinorUnits(totalPaidUnits, normalizedCurrency),
    netAmount: fromMinorUnits(netAmountUnits, normalizedCurrency),
    totalExpenseUnits,
    totalPaidUnits,
    netAmountUnits,
  }
}

/**
 * 加總一組交易的淨消費總額（expense 計正、refund 計負，忽略 isDeleted 與 transfer）。
 * 若交易具備 splitConfig 且有分攤明細，採與結算引擎一致之 Σshares minor units；否則回退至 tx.amount * rate。
 */
export function sumTransactionsExpense(
  transactions: Transaction[],
  currency: string,
): number {
  const normalizedCurrency = currency.trim().toUpperCase()
  let totalUnits = 0

  for (const tx of transactions) {
    if (tx.isDeleted) continue
    if (tx.type !== 'expense' && tx.type !== 'refund') continue

    if (tx.splitConfig && tx.splitConfig.shares.length > 0) {
      const breakdown = computeTxLedgerBreakdown(tx, normalizedCurrency)
      if (breakdown) {
        totalUnits += breakdown.direction * breakdown.totalShareUnits
      }
    } else {
      const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
      const direction = tx.type === 'refund' ? -1 : 1
      totalUnits += direction * toMinorUnits(tx.amount * rate, normalizedCurrency)
    }
  }

  return fromMinorUnits(totalUnits, normalizedCurrency)
}

/**
 * 計算單一專案之累計淨消費總額（明確採 per_tx 原始記帳匯率口徑，換算至專案主幣別 baseCurrency）。
 * - 僅進行輕量加總，不建構各成員 Map 亦不執行債務簡化，適用於首頁專案列表與專案標頭即時彙總。
 * - 規則與 `calculateSettleUp(transactions, baseCurrency)`（per_tx 模式）完全對拍：
 *   自動忽略已軟刪除（isDeleted）、無 splitConfig 及非 expense/refund（如 transfer）交易；
 *   expense 計正、refund 計負，以每筆交易原始 exchangeRateToBase 換算各 share 為最小單位後累加。
 */
export function sumProjectExpense(
  transactions: Transaction[],
  baseCurrency: string,
): number {
  const normalizedCurrency = baseCurrency.trim().toUpperCase()
  let totalUnits = 0

  for (const tx of transactions) {
    if (tx.isDeleted || !tx.splitConfig) continue
    if (tx.type !== 'expense' && tx.type !== 'refund') continue

    const rate =
      Number.isFinite(tx.exchangeRateToBase) && tx.exchangeRateToBase > 0
        ? tx.exchangeRateToBase
        : 1
    const direction: 1 | -1 = tx.type === 'refund' ? -1 : 1
    let origShareTotal = 0

    for (const share of tx.splitConfig.shares) {
      if (Number.isFinite(share.finalAmount) && share.finalAmount > 0) {
        origShareTotal += share.finalAmount
      }
    }

    const txShareUnits = toMinorUnits(origShareTotal * rate, normalizedCurrency)
    totalUnits += direction * txShareUnits
  }

  return fromMinorUnits(totalUnits, normalizedCurrency)
}
