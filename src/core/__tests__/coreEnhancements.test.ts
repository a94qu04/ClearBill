import { describe, expect, it } from 'vitest'
import {
  evaluateAmountExpression,
  hasMathExpression,
} from '@/core/expressionEvaluator'
import { calculateCategoryStats } from '@/core/categoryStats'
import { buildProjectExcelBytes } from '@/core/excelExporter'
import { computeCrossRateFromUsdTable } from '@/services/exchangeRateService'
import {
  createSingleProjectBackupPayload,
  parseAndMergeLedgerBackup,
} from '@/core/backupMergeEngine'
import { buildProjectSettlementShareText } from '@/core/shareFormatter'
import { calculateSettleUp } from '@/core/settleUpEngine'
import type { Project, Transaction } from '@/schemas/ledgerSchema'

const sampleProject: Project = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  schemaVersion: 1,
  name: '2026 大阪美食團',
  baseCurrency: 'TWD',
  members: [
    { id: 'me', name: '我', avatarColor: '#10b981' },
    { id: 'amy', name: '小美', avatarColor: '#ec4899' },
  ],
  defaultSplitMode: 'equal',
  defaultPayerId: 'me',
  isActive: true,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
}

const sampleTxs: Transaction[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    schemaVersion: 1,
    projectId: sampleProject.id,
    vaultLevel: 'normal',
    type: 'expense',
    amount: 10000,
    currency: 'JPY',
    exchangeRateToBase: 0.21,
    categoryKey: 'cat_food',
    date: '2026-11-20',
    time: '19:30',
    updatedAt: 1700000002000,
    note: '道頓堀燒肉',
    splitConfig: {
      payerId: 'me',
      mode: 'equal',
      shares: [
        { memberId: 'me', finalAmount: 5000 },
        { memberId: 'amy', finalAmount: 5000 },
      ],
    },
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    schemaVersion: 1,
    projectId: sampleProject.id,
    vaultLevel: 'normal',
    type: 'expense',
    amount: 5000,
    currency: 'JPY',
    exchangeRateToBase: 0.21,
    categoryKey: 'custom_souvenir',
    date: '2026-11-21',
    time: '15:00',
    updatedAt: 1700000003000,
    note: '藥妝伴手禮',
    splitConfig: {
      payerId: 'amy',
      mode: 'equal',
      shares: [
        { memberId: 'me', finalAmount: 2500 },
        { memberId: 'amy', finalAmount: 2500 },
      ],
    },
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    schemaVersion: 1,
    projectId: sampleProject.id,
    vaultLevel: 'normal',
    type: 'refund',
    amount: 1000,
    currency: 'JPY',
    exchangeRateToBase: 0.21,
    categoryKey: 'custom_souvenir',
    date: '2026-11-21',
    time: '15:10',
    updatedAt: 1700000004000,
    note: '藥妝退稅',
    splitConfig: {
      payerId: 'amy',
      mode: 'equal',
      shares: [
        { memberId: 'me', finalAmount: 500 },
        { memberId: 'amy', finalAmount: 500 },
      ],
    },
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    schemaVersion: 1,
    projectId: sampleProject.id,
    vaultLevel: 'normal',
    type: 'transfer',
    amount: 500,
    currency: 'TWD',
    exchangeRateToBase: 1,
    categoryKey: 'cat_settlement',
    date: '2026-11-22',
    time: '00:00',
    updatedAt: 1700000005000,
    note: '先還部分',
    splitConfig: {
      payerId: 'amy',
      mode: 'custom_plus_equal',
      shares: [{ memberId: 'me', finalAmount: 500 }],
    },
  },
]

describe('expressionEvaluator - 安全簡易算式與服務費百分比計算器', () => {
  it('支援加減乘除、括號與全形運算符號', () => {
    expect(hasMathExpression('350+180')).toBe(true)
    expect(hasMathExpression('1,200')).toBe(false)
    expect(evaluateAmountExpression('350+180', 0)).toBe(530)
    expect(evaluateAmountExpression('1,200 × 1.1', 0)).toBe(1320)
    expect(evaluateAmountExpression('(500 + 300) / 2', 2)).toBe(400)
  })

  it('支援百分比語法（+10% 服務費與折扣）', () => {
    expect(evaluateAmountExpression('1200+10%', 0)).toBe(1320)
    expect(evaluateAmountExpression('1000-15%', 0)).toBe(850)
    expect(evaluateAmountExpression('125+10%', 2)).toBe(137.5)
    expect(evaluateAmountExpression('125+10%', 0)).toBe(138)
  })

  it('拒絕非法字元、除以零與負數結果', () => {
    expect(evaluateAmountExpression('100/0', 0)).toBeNull()
    expect(evaluateAmountExpression('100-500', 0)).toBeNull()
    expect(evaluateAmountExpression('alert(1)', 0)).toBeNull()
    expect(evaluateAmountExpression('100+', 0)).toBeNull()
  })
})

describe('categoryStats - 專案消費結構分類統計', () => {
  it('扣除同分類退款並忽略還款 transfer，金額與 settleUp 完全一致', () => {
    const stats = calculateCategoryStats(sampleTxs, 'TWD')
    const settleUp = calculateSettleUp(sampleTxs, 'TWD', ['me', 'amy'])

    // 餐飲：10000*0.21 = 2100；伴手禮：(5000-1000)*0.21 = 840；總淨額 = 2940
    expect(stats.totalNetExpense).toBe(2940)
    expect(stats.totalNetExpense).toBe(settleUp.totalProjectExpense)
    expect(stats.items).toHaveLength(2)
    expect(stats.items[0]).toMatchObject({
      categoryKey: 'cat_food',
      amount: 2100,
      count: 1,
    })
    expect(stats.items[1]).toMatchObject({
      categoryKey: 'custom_souvenir',
      amount: 840,
      count: 2,
    })
    expect(stats.items[0].percentage + stats.items[1].percentage).toBeCloseTo(100, 0)
  })
})

describe('單一專案備份匯出與含明細分享文字', () => {
  it('單一專案匯出自動夾帶使用到的自訂分類，並於另一裝置無損合併', () => {
    const singleBackup = createSingleProjectBackupPayload(
      sampleProject,
      sampleTxs,
      [
        { key: 'cat_food', color: '#f97316', isBuiltin: true },
        {
          key: 'custom_souvenir',
          customLabel: '日本伴手禮',
          color: '#ec4899',
          isBuiltin: false,
        },
      ],
    )

    expect(singleBackup.projects).toHaveLength(1)
    expect(singleBackup.transactions).toHaveLength(4)
    expect(singleBackup.categories?.some((c) => c.key === 'custom_souvenir')).toBe(
      true,
    )

    const merged = parseAndMergeLedgerBackup(
      {
        projects: [],
        transactions: [],
        categories: [{ key: 'cat_food', color: '#f97316', isBuiltin: true }],
      },
      JSON.stringify(singleBackup),
    )

    expect(merged.stats.projectsAdded).toBe(1)
    expect(merged.stats.transactionsAdded).toBe(4)
    expect(merged.stats.categoriesAdded).toBe(1)
    expect(
      merged.categories.find((c) => c.key === 'custom_souvenir')?.customLabel,
    ).toBe('日本伴手禮')
  })

  it('分享文字開啟 includeDetails 時應附帶消費與退款明細', () => {
    const settleUp = calculateSettleUp(sampleTxs, 'TWD', ['me', 'amy'])
    const text = buildProjectSettlementShareText(
      sampleProject,
      settleUp,
      sampleTxs.filter((tx) => tx.type === 'transfer'),
      {
        headerPrefix: '【ClearBill 結算】',
        totalSpendLabel: '專案總支出',
        memberSummaryTitle: '▎各成員總支出',
        spentLabel: '總支出',
        paidLabel: '已墊付',
        pendingTitle: '▎待還款建議',
        allSettledText: '已結清',
        historyTitle: '▎已記錄還款',
        detailsTitle: '▎消費與退款明細',
        refundTag: '退款',
        transferLine: (from, to, amt) => `${from} ➔ ${to}：${amt}`,
        paidHistoryLine: (from, to, amt, date) => `${date} ${from} 已付 ${to} ${amt}`,
        footerTagline: '— ClearBill',
      },
      'zh-TW',
      {
        includeDetails: true,
        expenses: sampleTxs.filter((tx) => tx.type !== 'transfer'),
        resolveCategoryLabel: (k) => k,
      },
    )

    expect(text).toContain('▎消費與退款明細')
    expect(text).toContain('道頓堀燒肉')
    expect(text).toContain('[退款] 藥妝退稅')
  })
})

describe('excelExporter & exchangeRateService - 標準 .xlsx 匯出與即時匯率換算', () => {
  it('能產生有效 ZIP/OOXML 結構之雙工作表 Excel (.xlsx) 位元組陣列', () => {
    const settleUp = calculateSettleUp(sampleTxs, 'TWD', ['me', 'amy'])
    const bytes = buildProjectExcelBytes(sampleProject, sampleTxs, settleUp, {
      sheets: { entries: '消費明細', summary: '結算總表' },
      headers: {
        date: '日期',
        time: '時間',
        type: '類型',
        category: '分類',
        note: '備註',
        originalAmount: '原始金額',
        currency: '幣別',
        exchangeRate: '匯率',
        baseAmount: '折合主幣別',
        baseCurrency: '主幣別',
        payers: '墊付人',
        shares: '分攤明細',
      },
      summaryHeaders: {
        member: '成員',
        totalExpense: '總支出',
        totalPaid: '已墊付',
        netAmount: '淨收支',
        transferFrom: '付款人',
        transferTo: '收款人',
        transferAmount: '金額',
        projectTotal: '專案總支出',
        transfersTitle: '待還款建議',
      },
      typeNames: {
        expense: '消費',
        refund: '退款',
        transfer: '還款',
        income: '收入',
        card_repayment: '卡費',
      },
      resolveCategoryLabel: (k) => k,
    })

    // 檢查標準 ZIP Local File Header（PK\x03\x04）
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes[2]).toBe(0x03)
    expect(bytes[3]).toBe(0x04)

    const decoded = new TextDecoder().decode(bytes)
    expect(decoded).toContain('xl/worksheets/sheet1.xml')
    expect(decoded).toContain('xl/worksheets/sheet2.xml')
    expect(decoded).toContain('道頓堀燒肉')
    expect(decoded).toContain('<v>-1000</v>')
    expect(decoded).toContain('<v>2940</v>')
  })

  it('依 USD 基準匯率表正確交叉換算任意兩幣別（JPY -> TWD）', () => {
    const table = { USD: 1, TWD: 32, JPY: 150, KRW: 1380 }
    expect(computeCrossRateFromUsdTable(table, 'TWD', 'TWD')).toBe(1)
    expect(computeCrossRateFromUsdTable(table, 'JPY', 'TWD')).toBe(0.2133)
    expect(computeCrossRateFromUsdTable(table, 'USD', 'JPY')).toBe(150)
    expect(computeCrossRateFromUsdTable(table, 'XXX', 'TWD')).toBeNull()
  })
})
