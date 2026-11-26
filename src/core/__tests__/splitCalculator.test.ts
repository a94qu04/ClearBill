import { describe, expect, it } from 'vitest'
import {
  calculateSplit,
  SplitCalculationError,
} from '@/core/splitCalculator'

describe('splitCalculator - 雙模式拆帳計算機', () => {
  it('equal 模式：TWD 整數均攤且精準分配尾差給前 N 位成員（1000 / 3 = 334, 333, 333）', () => {
    const result = calculateSplit({
      totalAmount: 1000,
      currency: 'TWD',
      mode: 'equal',
      members: [
        { memberId: 'alice', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'bob', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'charlie', customAmount: 0, isIncludedInRemainder: true },
      ],
    })

    expect(result.totalAmount).toBe(1000)
    expect(result.customTotal).toBe(0)
    expect(result.remainderPool).toBe(1000)
    expect(result.shares.map((s) => s.finalAmount)).toEqual([334, 333, 333])

    const sum = result.shares.reduce((acc, s) => acc + s.finalAmount, 0)
    expect(sum).toBe(1000)
  })

  it('equal 模式：JPY / KRW 零小數幣別尾差依序分給前 N 位（1000 / 3 餘 1、1001 / 3 餘 2）', () => {
    const jpyResult = calculateSplit({
      totalAmount: 1001,
      currency: 'JPY',
      mode: 'equal',
      members: [
        { memberId: 'm1', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'm2', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'm3', customAmount: 0, isIncludedInRemainder: true },
      ],
    })

    expect(jpyResult.shares.map((s) => s.finalAmount)).toEqual([334, 334, 333])

    const krwResult = calculateSplit({
      totalAmount: 5000,
      currency: 'KRW',
      mode: 'equal',
      members: [
        { memberId: 'm1', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'm2', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'm3', customAmount: 0, isIncludedInRemainder: true },
      ],
    })

    expect(krwResult.shares.map((s) => s.finalAmount)).toEqual([1667, 1667, 1666])
  })

  it('equal 模式：USD 兩位小數精準分配 0.01 尾差（100 / 3 = 33.34, 33.33, 33.33）', () => {
    const result = calculateSplit({
      totalAmount: 100,
      currency: 'USD',
      mode: 'equal',
      members: [
        { memberId: 'alice', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'bob', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'charlie', customAmount: 0, isIncludedInRemainder: true },
      ],
    })

    expect(result.shares.map((s) => s.finalAmount)).toEqual([33.34, 33.33, 33.33])
    const sumCents = result.shares.reduce((acc, s) => acc + Math.round(s.finalAmount * 100), 0)
    expect(sumCents).toBe(10000)
  })

  it('custom_plus_equal 模式：先扣除指定金額，剩餘僅由勾選均攤者平分', () => {
    // 總額 1500 TWD：Alice 單點 300 且參與均攤，Bob 單點 200 但不參與均攤，Charlie 0 且參與均攤
    // remainderPool = 1500 - 500 = 1000，由 Alice 與 Charlie 兩人平分各 500
    const result = calculateSplit({
      totalAmount: 1500,
      currency: 'TWD',
      mode: 'custom_plus_equal',
      members: [
        { memberId: 'alice', customAmount: 300, isIncludedInRemainder: true },
        { memberId: 'bob', customAmount: 200, isIncludedInRemainder: false },
        { memberId: 'charlie', customAmount: 0, isIncludedInRemainder: true },
      ],
    })

    expect(result.customTotal).toBe(500)
    expect(result.remainderPool).toBe(1000)
    expect(result.remainderMemberCount).toBe(2)
    expect(result.shares).toEqual([
      {
        memberId: 'alice',
        customAmount: 300,
        remainderShare: 500,
        finalAmount: 800,
        isIncludedInRemainder: true,
      },
      {
        memberId: 'bob',
        customAmount: 200,
        remainderShare: 0,
        finalAmount: 200,
        isIncludedInRemainder: false,
      },
      {
        memberId: 'charlie',
        customAmount: 0,
        remainderShare: 500,
        finalAmount: 500,
        isIncludedInRemainder: true,
      },
    ])
  })

  it('custom_plus_equal 模式：當剩餘金額恰好為 0 時，即使無人勾選均攤剩餘仍合法', () => {
    const result = calculateSplit({
      totalAmount: 500,
      currency: 'TWD',
      mode: 'custom_plus_equal',
      members: [
        { memberId: 'alice', customAmount: 300, isIncludedInRemainder: false },
        { memberId: 'bob', customAmount: 200, isIncludedInRemainder: false },
      ],
    })

    expect(result.remainderPool).toBe(0)
    expect(result.shares.map((s) => s.finalAmount)).toEqual([300, 200])
  })

  it('custom_plus_equal 模式：指定金額總和超過總額應拋出 ERR_CUSTOM_EXCEEDS_TOTAL', () => {
    expect(() =>
      calculateSplit({
        totalAmount: 500,
        currency: 'TWD',
        mode: 'custom_plus_equal',
        members: [
          { memberId: 'alice', customAmount: 350, isIncludedInRemainder: true },
          { memberId: 'bob', customAmount: 200, isIncludedInRemainder: true },
        ],
      }),
    ).toThrowError(/ERR_CUSTOM_EXCEEDS_TOTAL/)

    try {
      calculateSplit({
        totalAmount: 500,
        currency: 'TWD',
        mode: 'custom_plus_equal',
        members: [
          { memberId: 'alice', customAmount: 600, isIncludedInRemainder: true },
        ],
      })
    } catch (error) {
      expect(error).toBeInstanceOf(SplitCalculationError)
      expect((error as SplitCalculationError).code).toBe('ERR_CUSTOM_EXCEEDS_TOTAL')
    }
  })

  it('custom_plus_equal 模式：剩餘金額 > 0 但勾選均攤人數為 0 應拋出 ERR_UNALLOCATED_REMAINDER', () => {
    expect(() =>
      calculateSplit({
        totalAmount: 1000,
        currency: 'TWD',
        mode: 'custom_plus_equal',
        members: [
          { memberId: 'alice', customAmount: 300, isIncludedInRemainder: false },
          { memberId: 'bob', customAmount: 200, isIncludedInRemainder: false },
        ],
      }),
    ).toThrowError(/ERR_UNALLOCATED_REMAINDER/)
  })

  it('equal 模式會忽略 customAmount，專注於全額均攤', () => {
    const result = calculateSplit({
      totalAmount: 900,
      currency: 'TWD',
      mode: 'equal',
      members: [
        { memberId: 'alice', customAmount: 400, isIncludedInRemainder: true },
        { memberId: 'bob', customAmount: 0, isIncludedInRemainder: true },
        { memberId: 'charlie', customAmount: 0, isIncludedInRemainder: true },
      ],
    })

    expect(result.customTotal).toBe(0)
    expect(result.shares.map((s) => s.finalAmount)).toEqual([300, 300, 300])
  })

  it('邊界防呆：負總額、空成員或重複成員皆應拋出對應錯誤碼', () => {
    expect(() =>
      calculateSplit({
        totalAmount: -100,
        currency: 'TWD',
        mode: 'equal',
        members: [{ memberId: 'alice', customAmount: 0, isIncludedInRemainder: true }],
      }),
    ).toThrowError(/ERR_INVALID_TOTAL_AMOUNT/)

    expect(() =>
      calculateSplit({
        totalAmount: 100,
        currency: 'TWD',
        mode: 'equal',
        members: [],
      }),
    ).toThrowError(/ERR_EMPTY_MEMBERS/)

    expect(() =>
      calculateSplit({
        totalAmount: 100,
        currency: 'TWD',
        mode: 'equal',
        members: [
          { memberId: 'alice', customAmount: 0, isIncludedInRemainder: true },
          { memberId: 'alice', customAmount: 0, isIncludedInRemainder: true },
        ],
      }),
    ).toThrowError(/ERR_DUPLICATE_MEMBER/)
  })

  it('weight 模式：按份數比例（含小數 0.5 與 0 份）採最大餘數法精準分配且無誤差', () => {
    // 總額 1000 TWD：Alice 2 份、Bob 1.5 份、Charlie 0.5 份、Dave 0 份 -> 共 4 份
    // Alice = 500, Bob = 375, Charlie = 125, Dave = 0
    const exact = calculateSplit({
      totalAmount: 1000,
      currency: 'TWD',
      mode: 'weight',
      members: [
        { memberId: 'alice', weight: 2 },
        { memberId: 'bob', weight: 1.5 },
        { memberId: 'charlie', weight: 0.5 },
        { memberId: 'dave', weight: 0 },
      ],
    })
    expect(exact.totalWeight).toBe(4)
    expect(exact.shares.map((s) => s.finalAmount)).toEqual([500, 375, 125, 0])

    // 含尾差：1000 / (1+1+1) = 334, 333, 333，總和嚴格等於 1000
    const withRemainder = calculateSplit({
      totalAmount: 1000,
      currency: 'TWD',
      mode: 'weight',
      members: [
        { memberId: 'a', weight: 1 },
        { memberId: 'b', weight: 1 },
        { memberId: 'c', weight: 1 },
      ],
    })
    expect(withRemainder.shares.reduce((sum, s) => sum + s.finalAmount, 0)).toBe(1000)

    expect(() =>
      calculateSplit({
        totalAmount: 500,
        currency: 'TWD',
        mode: 'weight',
        members: [
          { memberId: 'a', weight: 0 },
          { memberId: 'b', weight: 0 },
        ],
      }),
    ).toThrowError(/ERR_INVALID_WEIGHTS/)
  })

  it('percentage 模式：依百分比精準分配且攔截總和非 100% 錯誤', () => {
    const result = calculateSplit({
      totalAmount: 100,
      currency: 'USD',
      mode: 'percentage',
      members: [
        { memberId: 'alice', percent: 55.5 },
        { memberId: 'bob', percent: 44.5 },
      ],
    })
    expect(result.totalPercent).toBe(100)
    expect(result.shares.map((s) => s.finalAmount)).toEqual([55.5, 44.5])

    expect(() =>
      calculateSplit({
        totalAmount: 1000,
        currency: 'TWD',
        mode: 'percentage',
        members: [
          { memberId: 'alice', percent: 60 },
          { memberId: 'bob', percent: 30 },
        ],
      }),
    ).toThrowError(/ERR_PERCENT_TOTAL_INVALID/)
  })

  it('weight 模式：極大與極小正權重皆正常比例分配不產生 NaN，超高金額會被安全擋下', () => {
    const bigWeights = calculateSplit({
      totalAmount: 100,
      currency: 'USD',
      mode: 'weight',
      members: [
        { memberId: 'a', weight: 1e6 },
        { memberId: 'b', weight: 1e6 },
      ],
    })
    expect(bigWeights.shares.map((s) => s.finalAmount)).toEqual([50, 50])

    const tinyWeights = calculateSplit({
      totalAmount: 100,
      currency: 'TWD',
      mode: 'weight',
      members: [
        { memberId: 'a', weight: 0.00001 },
        { memberId: 'b', weight: 0.00001 },
      ],
    })
    expect(tinyWeights.shares.map((s) => s.finalAmount)).toEqual([50, 50])

    expect(() =>
      calculateSplit({
        totalAmount: 1e15,
        currency: 'TWD',
        mode: 'equal',
        members: [{ memberId: 'a', customAmount: 0, isIncludedInRemainder: true }],
      }),
    ).toThrowError(/ERR_INVALID_TOTAL_AMOUNT/)
  })
})
