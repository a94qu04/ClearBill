import { describe, expect, it } from 'vitest'
import type { Transaction } from '@/schemas/ledgerSchema'
import {
  describePayers,
  getTxPayerEntries,
  getTxPayerIds,
} from '@/core/txPresentation'

function makeTx(
  splitConfig?: Transaction['splitConfig'],
): Pick<Transaction, 'splitConfig'> {
  return { splitConfig }
}

const NAMES: Record<string, string> = {
  m1: '小明',
  m2: '小華',
  m3: '小美',
}
const nameOf = (id: string) => NAMES[id] ?? id

describe('core/txPresentation', () => {
  describe('getTxPayerEntries / getTxPayerIds', () => {
    it('無 splitConfig 或空 payerId 時回傳空陣列', () => {
      expect(getTxPayerEntries(makeTx(undefined))).toEqual([])
      expect(getTxPayerIds(makeTx(undefined))).toEqual([])
      expect(
        getTxPayerIds(
          makeTx({
            mode: 'equal',
            payerId: '',
            shares: [],
          }),
        ),
      ).toEqual([])
    })

    it('單人墊付未設 payers 時回退至 payerId', () => {
      const tx = makeTx({
        mode: 'equal',
        payerId: 'm1',
        shares: [{ memberId: 'm1', finalAmount: 100 }],
      })
      expect(getTxPayerIds(tx)).toEqual(['m1'])
      expect(getTxPayerEntries(tx)).toEqual([{ memberId: 'm1', amount: 0 }])
    })

    it('多人墊付時過濾 amount <= 0 之無效項目', () => {
      const tx = makeTx({
        mode: 'equal',
        payerId: 'm1',
        payers: [
          { memberId: 'm1', amount: 300 },
          { memberId: 'm2', amount: 0 },
          { memberId: 'm3', amount: 200 },
        ],
        shares: [],
      })
      expect(getTxPayerEntries(tx)).toEqual([
        { memberId: 'm1', amount: 300 },
        { memberId: 'm3', amount: 200 },
      ])
      expect(getTxPayerIds(tx)).toEqual(['m1', 'm3'])
    })

    it('payers 中僅有 1 位金額 > 0 時視為單人墊付', () => {
      const tx = makeTx({
        mode: 'equal',
        payerId: 'm1',
        payers: [
          { memberId: 'm1', amount: 0 },
          { memberId: 'm2', amount: 500 },
        ],
        shares: [],
      })
      expect(getTxPayerIds(tx)).toEqual(['m2'])
    })
  })

  describe('describePayers', () => {
    it('無付款人資訊時回傳空字串或自訂 emptyFallback', () => {
      expect(describePayers(makeTx(undefined), nameOf)).toBe('')
      expect(
        describePayers(makeTx(undefined), nameOf, { emptyFallback: '—' }),
      ).toBe('—')
    })

    it('單人墊付回傳單一成員名稱，不受多人選項影響', () => {
      const tx = makeTx({
        mode: 'equal',
        payerId: 'm1',
        shares: [],
      })
      expect(describePayers(tx, nameOf)).toBe('小明')
      expect(
        describePayers(tx, nameOf, {
          separator: '、',
          includeAmounts: true,
          formatMultiPayer: (n) => `${n}人共同墊付`,
        }),
      ).toBe('小明')
    })

    it('多人墊付預設以 + 串接，亦可自訂分隔符（如頓號）', () => {
      const tx = makeTx({
        mode: 'equal',
        payerId: 'm1',
        payers: [
          { memberId: 'm1', amount: 400 },
          { memberId: 'm2', amount: 600 },
        ],
        shares: [],
      })
      expect(describePayers(tx, nameOf)).toBe('小明+小華')
      expect(describePayers(tx, nameOf, { separator: '、' })).toBe('小明、小華')
    })

    it('多人墊付支援 includeAmounts（Excel 匯出格式）與自訂 formatAmount', () => {
      const tx = makeTx({
        mode: 'equal',
        payerId: 'm1',
        payers: [
          { memberId: 'm1', amount: 1200 },
          { memberId: 'm3', amount: 800 },
        ],
        shares: [],
      })
      expect(
        describePayers(tx, nameOf, { includeAmounts: true }),
      ).toBe('小明: 1200 / 小美: 800')
      expect(
        describePayers(tx, nameOf, {
          includeAmounts: true,
          separator: ', ',
          amountSeparator: '=',
          formatAmount: (amt) => `$${amt}`,
        }),
      ).toBe('小明=$1200, 小美=$800')
    })

    it('多人墊付設定 formatMultiPayer 時優先回傳自訂摘要', () => {
      const tx = makeTx({
        mode: 'equal',
        payerId: 'm1',
        payers: [
          { memberId: 'm1', amount: 100 },
          { memberId: 'm2', amount: 200 },
          { memberId: 'm3', amount: 300 },
        ],
        shares: [],
      })
      expect(
        describePayers(tx, nameOf, {
          formatMultiPayer: (count) => `${count} 人共同墊付`,
        }),
      ).toBe('3 人共同墊付')
    })

    it('查無成員名稱時透過 nameOf 回退原 ID', () => {
      const tx = makeTx({
        mode: 'equal',
        payerId: 'm1',
        payers: [
          { memberId: 'm1', amount: 100 },
          { memberId: 'ghost_1', amount: 100 },
        ],
        shares: [],
      })
      expect(describePayers(tx, nameOf)).toBe('小明+ghost_1')
    })
  })
})
