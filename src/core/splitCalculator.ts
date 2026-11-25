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
  | 'ERR_INVALID_WEIGHTS'
  | 'ERR_PERCENT_TOTAL_INVALID'

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
  weight?: number
  percent?: number
}

export interface SplitCalculationResult {
  mode: SplitMode
  currency: string
  totalAmount: number
  customTotal: number
  remainderPool: number
  remainderMemberCount: number
  remainderBasePerMember: number
  totalWeight?: number
  totalPercent?: number
  shares: ComputedMemberShare[]
}

/**
 * 最大餘數法（Largest Remainder Method）：依各成員正權重將 totalUnits 精準分配為整數單位，
 * 確保所有成員總和 100% 等於 totalUnits，無浮點誤差。
 */
function allocateUnitsByWeights(totalUnits: number, weights: number[]): number[] {
  const result = new Array<number>(weights.length).fill(0)
  if (totalUnits <= 0 || !Number.isFinite(totalUnits)) return result

  // 先依最大正權重正規化，徹底防止極端大權重（如 1e308）相加溢位成 Infinity / Infinity = NaN
  let maxWeight = 0
  for (const w of weights) {
    if (Number.isFinite(w) && w > maxWeight) {
      maxWeight = w
    }
  }
  if (maxWeight <= 0) return result

  const normalizedWeights = weights.map((w) =>
    Number.isFinite(w) && w > 0 ? w / maxWeight : 0,
  )
  const sum = normalizedWeights.reduce((acc, w) => acc + w, 0)
  if (!Number.isFinite(sum) || sum <= 0) return result

  const remainders: Array<{ idx: number; frac: number }> = []
  let allocated = 0

  for (let i = 0; i < normalizedWeights.length; i += 1) {
    const w = normalizedWeights[i]
    if (w <= 0) {
      remainders.push({ idx: i, frac: -1 })
      continue
    }
    const exact = totalUnits * (w / sum)
    const floored = Math.floor(exact)
    result[i] = floored
    allocated += floored
    remainders.push({ idx: i, frac: exact - floored })
  }

  let leftover = totalUnits - allocated
  if (leftover > 0) {
    remainders.sort((a, b) => {
      if (b.frac !== a.frac) return b.frac - a.frac
      return a.idx - b.idx
    })
    for (const entry of remainders) {
      if (leftover <= 0) break
      if (entry.frac < 0) continue
      result[entry.idx] += 1
      leftover -= 1
    }
  }

  return result
}

/**
 * 四模式拆帳計算機（純 TypeScript 函式）
 * - equal：全員（或勾選參與者）均攤總金額
 * - custom_plus_equal：先扣除各成員指定金額，剩餘池由勾選「均攤剩餘」的成員平分
 * - weight：依各成員份數權重（如 1、2、0.5）按最大餘數法比例分配
 * - percentage：依各成員百分比（總和須為 100%）按最大餘數法比例分配
 * - 除法尾差依幣別最小精度（TWD/JPY/KRW 為 1，其餘為 0.01）分配，確保總和 100% 等於 totalAmount。
 */
export function calculateSplit(input: SplitCalculationInput): SplitCalculationResult {
  const { totalAmount, members } = input

  if (
    typeof totalAmount !== 'number' ||
    !Number.isFinite(totalAmount) ||
    totalAmount < 0 ||
    totalAmount > 1e12
  ) {
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

  // 模式 3：份數比例（weight）
  if (mode === 'weight') {
    const weights = normalizedMembers.map((m) =>
      typeof m.weight === 'number' && Number.isFinite(m.weight) && m.weight >= 0
        ? m.weight
        : m.isIncludedInRemainder
          ? 1
          : 0,
    )
    const rawTotalWeight = weights.reduce((acc, w) => acc + w, 0)
    if (totalUnits > 0 && rawTotalWeight <= 0) {
      throw new SplitCalculationError(
        'ERR_INVALID_WEIGHTS',
        '所有成員份數總和必須大於 0',
      )
    }
    const totalWeight =
      rawTotalWeight > 0 && rawTotalWeight < 0.0001
        ? Number(rawTotalWeight.toPrecision(4))
        : Number(rawTotalWeight.toFixed(4))
    const allocatedUnits = allocateUnitsByWeights(totalUnits, weights)
    const activeCount = weights.filter((w) => w > 0).length
    const perUnitBase =
      totalWeight > 0 ? Math.floor(totalUnits / totalWeight) : 0

    const shares: ComputedMemberShare[] = normalizedMembers.map((member, index) => {
      const units = allocatedUnits[index]
      const w = weights[index]
      return {
        memberId: member.memberId,
        customAmount: 0,
        remainderShare: fromMinorUnits(units, currency),
        finalAmount: fromMinorUnits(units, currency),
        isIncludedInRemainder: w > 0,
        weight: w,
      }
    })

    return {
      mode,
      currency,
      totalAmount: fromMinorUnits(totalUnits, currency),
      customTotal: 0,
      remainderPool: fromMinorUnits(totalUnits, currency),
      remainderMemberCount: activeCount,
      remainderBasePerMember: fromMinorUnits(perUnitBase, currency),
      totalWeight,
      shares,
    }
  }

  // 模式 4：百分比（percentage）
  if (mode === 'percentage') {
    const percents = normalizedMembers.map((m) =>
      typeof m.percent === 'number' && Number.isFinite(m.percent) && m.percent >= 0
        ? m.percent
        : 0,
    )
    const totalPercent = Number(percents.reduce((acc, p) => acc + p, 0).toFixed(2))
    if (totalUnits > 0 && Math.abs(totalPercent - 100) > 0.01) {
      throw new SplitCalculationError(
        'ERR_PERCENT_TOTAL_INVALID',
        `百分比總和須為 100%（目前為 ${totalPercent}%）`,
      )
    }
    const allocatedUnits = allocateUnitsByWeights(totalUnits, percents)
    const activeCount = percents.filter((p) => p > 0).length

    const shares: ComputedMemberShare[] = normalizedMembers.map((member, index) => {
      const units = allocatedUnits[index]
      const pct = percents[index]
      return {
        memberId: member.memberId,
        customAmount: 0,
        remainderShare: fromMinorUnits(units, currency),
        finalAmount: fromMinorUnits(units, currency),
        isIncludedInRemainder: pct > 0,
        percent: pct,
      }
    })

    return {
      mode,
      currency,
      totalAmount: fromMinorUnits(totalUnits, currency),
      customTotal: 0,
      remainderPool: fromMinorUnits(totalUnits, currency),
      remainderMemberCount: activeCount,
      remainderBasePerMember: 0,
      totalPercent,
      shares,
    }
  }

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
