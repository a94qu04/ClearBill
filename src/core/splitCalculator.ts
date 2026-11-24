import {
  CurrencyCodeSchema,
  MemberSplitInputSchema,
  SplitModeSchema,
  type MemberSplitInput,
  type SplitMode,
} from '@/schemas/ledgerSchema'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'

export type SplitErrorCode =
  | 'ERR_INVALID_TOTAL_AMOUNT'
  | 'ERR_EMPTY_MEMBERS'
  | 'ERR_DUPLICATE_MEMBER'
  | 'ERR_CUSTOM_EXCEEDS_TOTAL'
  | 'ERR_UNALLOCATED_REMAINDER'

export class SplitCalculationError extends Error {
  public readonly code: SplitErrorCode

  constructor(code: SplitErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'SplitCalculationError'
    this.code = code
  }
}

export interface SplitCalculationInput {
  totalAmount: number
  currency: string
  mode: SplitMode
  members: MemberSplitInput[]
}

export interface ComputedMemberShare {
  memberId: string
  customAmount: number
  remainderShare: number
  finalAmount: number
  isIncludedInRemainder: boolean
}

export interface SplitCalculationResult {
  mode: SplitMode
  currency: string
  totalAmount: number
  customTotal: number
  remainderPool: number
  remainderMemberCount: number
  remainderBasePerMember: number
  shares: ComputedMemberShare[]
}

/**
 * 雙模式拆帳計算機（純 TypeScript 函式）
 * - equal：全員（或勾選參與者）均攤總金額
 * - custom_plus_equal：先扣除各成員指定金額，剩餘池由勾選「均攤剩餘」的成員平分
 * - 除法尾差依幣別最小精度（TWD/JPY/KRW 為 1，其餘為 0.01）依序分給前 N 位參與均攤者，
 *   確保所有分攤總和 100% 等於 totalAmount。
 */
export function calculateSplit(input: SplitCalculationInput): SplitCalculationResult {
  const { totalAmount, members } = input

  if (typeof totalAmount !== 'number' || !Number.isFinite(totalAmount) || totalAmount < 0) {
    throw new SplitCalculationError(
      'ERR_INVALID_TOTAL_AMOUNT',
      '總金額必須為大於或等於 0 的有效數字',
    )
  }

  if (!Array.isArray(members) || members.length === 0) {
    throw new SplitCalculationError('ERR_EMPTY_MEMBERS', '至少需要一位分帳成員')
  }

  const currency = CurrencyCodeSchema.parse(input.currency)
  const mode = SplitModeSchema.parse(input.mode)

  // 使用 Zod 正規化每位成員輸入並檢查重複成員 ID
  const seenIds = new Set<string>()
  const normalizedMembers = members.map((member) => {
    const parsed = MemberSplitInputSchema.parse(member)
    if (seenIds.has(parsed.memberId)) {
      throw new SplitCalculationError(
        'ERR_DUPLICATE_MEMBER',
        `成員 ID 重複：${parsed.memberId}`,
      )
    }
    seenIds.add(parsed.memberId)
    return parsed
  })

  const totalUnits = toMinorUnits(totalAmount, currency)

  // 計算各成員的指定金額（equal 模式下一律為 0）
  const customUnitsList = normalizedMembers.map((member) =>
    mode === 'custom_plus_equal' ? toMinorUnits(member.customAmount, currency) : 0,
  )

  const customTotalUnits = customUnitsList.reduce((acc, units) => acc + units, 0)
  const remainderPoolUnits = totalUnits - customTotalUnits

  if (remainderPoolUnits < 0) {
    throw new SplitCalculationError(
      'ERR_CUSTOM_EXCEEDS_TOTAL',
      '指定金額總和超過消費總金額',
    )
  }

  // 找出勾選參與均攤剩餘金額的成員索引
  const includedIndices: number[] = []
  normalizedMembers.forEach((member, index) => {
    if (member.isIncludedInRemainder) {
      includedIndices.push(index)
    }
  })

  if (includedIndices.length === 0 && remainderPoolUnits > 0) {
    throw new SplitCalculationError(
      'ERR_UNALLOCATED_REMAINDER',
      '尚有未分配的剩餘金額，但無人勾選均攤剩餘',
    )
  }

  const remainderUnitsList = new Array<number>(normalizedMembers.length).fill(0)
  let baseShareUnits = 0

  if (includedIndices.length > 0 && remainderPoolUnits > 0) {
    const count = includedIndices.length
    baseShareUnits = Math.floor(remainderPoolUnits / count)
    const leftoverUnits = remainderPoolUnits % count

    // 除法尾差依最小幣別單位（+1 minor unit）依序輪流分給前 N 位參與均攤者
    includedIndices.forEach((memberIdx, rank) => {
      const extraUnit = rank < leftoverUnits ? 1 : 0
      remainderUnitsList[memberIdx] = baseShareUnits + extraUnit
    })
  }

  const shares: ComputedMemberShare[] = normalizedMembers.map((member, index) => {
    const customUnits = customUnitsList[index]
    const remainderUnits = remainderUnitsList[index]
    const finalUnits = customUnits + remainderUnits

    return {
      memberId: member.memberId,
      customAmount: fromMinorUnits(customUnits, currency),
      remainderShare: fromMinorUnits(remainderUnits, currency),
      finalAmount: fromMinorUnits(finalUnits, currency),
      isIncludedInRemainder: member.isIncludedInRemainder,
    }
  })

  return {
    mode,
    currency,
    totalAmount: fromMinorUnits(totalUnits, currency),
    customTotal: fromMinorUnits(customTotalUnits, currency),
    remainderPool: fromMinorUnits(remainderPoolUnits, currency),
    remainderMemberCount: includedIndices.length,
    remainderBasePerMember: fromMinorUnits(baseShareUnits, currency),
    shares,
  }
}
