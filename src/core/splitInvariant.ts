import { TransactionSchema, type Transaction } from '@/schemas/ledgerSchema'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'

export type SplitInvariantViolationCode =
  | 'SHARE_SUM_MISMATCH'
  | 'PAYER_SUM_MISMATCH'

export interface SplitInvariantViolation {
  code: SplitInvariantViolationCode
  expectedUnits: number
  actualUnits: number
  /** expectedUnits - actualUnits（正數表示少分/少付，負數表示多分/多付） */
  diffUnits: number
  expectedAmount: number
  actualAmount: number
  diffAmount: number
  currency: string
  message: string
}

export interface SplitInvariantResult {
  valid: boolean
  currency: string
  amountUnits: number
  sharesSumUnits: number | null
  payersSumUnits: number | null
  violations: SplitInvariantViolation[]
}

export interface SplitInvariantOptions {
  /** 容許的最小幣別單位誤差上限（預設為 0，即嚴格精準相等） */
  toleranceUnits?: number
}

export type SplitInvariantTarget = Pick<
  Transaction,
  'amount' | 'currency' | 'splitConfig'
> & {
  id?: string
  type?: Transaction['type']
}

export class SplitInvariantError extends Error {
  public readonly code = 'ERR_SPLIT_INVARIANT_VIOLATION'
  public readonly violations: SplitInvariantViolation[]
  public readonly transactionId?: string

  constructor(violations: SplitInvariantViolation[], transactionId?: string) {
    const summary = violations.map((v) => v.message).join('；')
    super(`ERR_SPLIT_INVARIANT_VIOLATION: ${summary}`)
    this.name = 'SplitInvariantError'
    this.violations = violations
    this.transactionId = transactionId
  }
}

/**
 * 驗證交易拆帳金額守恆不變式（以最小幣別整數單位 minor units 比對，杜絕浮點誤差）：
 * 1. Σ(shares.finalAmount) === tx.amount
 * 2. 若有多人墊付（splitConfig.payers），Σ(payers.amount) === tx.amount
 * 適用於 expense、refund、transfer 等所有附帶 splitConfig 的交易。
 */
export function validateSplitInvariant(
  tx: SplitInvariantTarget,
  options?: SplitInvariantOptions,
): SplitInvariantResult {
  const currency = tx.currency.trim().toUpperCase()
  const tolerance = Math.max(0, Math.floor(options?.toleranceUnits ?? 0))
  const amountUnits = toMinorUnits(tx.amount, currency)

  if (!tx.splitConfig) {
    return {
      valid: true,
      currency,
      amountUnits,
      sharesSumUnits: null,
      payersSumUnits: null,
      violations: [],
    }
  }

  const violations: SplitInvariantViolation[] = []
  const sharesSumUnits = tx.splitConfig.shares.reduce(
    (acc, share) => acc + toMinorUnits(share.finalAmount, currency),
    0,
  )
  const shareDiffUnits = amountUnits - sharesSumUnits

  if (Math.abs(shareDiffUnits) > tolerance) {
    const expectedAmount = fromMinorUnits(amountUnits, currency)
    const actualAmount = fromMinorUnits(sharesSumUnits, currency)
    const diffAmount = fromMinorUnits(shareDiffUnits, currency)
    violations.push({
      code: 'SHARE_SUM_MISMATCH',
      expectedUnits: amountUnits,
      actualUnits: sharesSumUnits,
      diffUnits: shareDiffUnits,
      expectedAmount,
      actualAmount,
      diffAmount,
      currency,
      message: `分攤總額（${actualAmount} ${currency}）與交易總額（${expectedAmount} ${currency}）不符，差額 ${diffAmount} ${currency}`,
    })
  }

  let payersSumUnits: number | null = null
  if (tx.splitConfig.payers && tx.splitConfig.payers.length > 0) {
    payersSumUnits = tx.splitConfig.payers.reduce(
      (acc, payer) => acc + toMinorUnits(payer.amount, currency),
      0,
    )
    const payerDiffUnits = amountUnits - payersSumUnits
    if (Math.abs(payerDiffUnits) > tolerance) {
      const expectedAmount = fromMinorUnits(amountUnits, currency)
      const actualAmount = fromMinorUnits(payersSumUnits, currency)
      const diffAmount = fromMinorUnits(payerDiffUnits, currency)
      violations.push({
        code: 'PAYER_SUM_MISMATCH',
        expectedUnits: amountUnits,
        actualUnits: payersSumUnits,
        diffUnits: payerDiffUnits,
        expectedAmount,
        actualAmount,
        diffAmount,
        currency,
        message: `多人墊付總額（${actualAmount} ${currency}）與交易總額（${expectedAmount} ${currency}）不符，差額 ${diffAmount} ${currency}`,
      })
    }
  }

  return {
    valid: violations.length === 0,
    currency,
    amountUnits,
    sharesSumUnits,
    payersSumUnits,
    violations,
  }
}

/**
 * 斷言交易拆帳符合金額守恆不變式，違反時拋出 SplitInvariantError
 */
export function assertSplitInvariant(
  tx: SplitInvariantTarget,
  options?: SplitInvariantOptions,
): void {
  const result = validateSplitInvariant(tx, options)
  if (!result.valid) {
    throw new SplitInvariantError(result.violations, tx.id)
  }
}

/**
 * 計算跨幣別結算換算時，單筆交易容許的四捨五入尾差上限（≤ 參與成員數個 minor unit，至少為 1）
 */
export function getSettlementRoundingToleranceUnits(
  tx: Pick<Transaction, 'splitConfig'>,
): number {
  if (!tx.splitConfig) return 1
  const memberIds = new Set<string>()
  for (const share of tx.splitConfig.shares) {
    if (share.finalAmount > 0) {
      memberIds.add(share.memberId)
    }
  }
  const activePayers = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
  if (activePayers.length > 0) {
    for (const payer of activePayers) {
      memberIds.add(payer.memberId)
    }
  } else if (tx.splitConfig.payerId) {
    memberIds.add(tx.splitConfig.payerId)
  }
  return Math.max(1, memberIds.size)
}

/**
 * 附帶拆帳金額守恆不變式驗證的嚴格交易 Schema（供新資料寫入與嚴格驗證使用；舊資料遷移維持使用寬鬆模式）
 */
export const StrictTransactionSchema = TransactionSchema.superRefine(
  (tx, ctx) => {
    const result = validateSplitInvariant(tx)
    if (result.valid) return
    for (const violation of result.violations) {
      ctx.addIssue({
        code: 'custom',
        path:
          violation.code === 'PAYER_SUM_MISMATCH'
            ? ['splitConfig', 'payers']
            : ['splitConfig', 'shares'],
        message: violation.message,
      })
    }
  },
)
