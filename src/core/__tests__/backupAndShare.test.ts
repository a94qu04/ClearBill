import { describe, expect, it } from 'vitest'
import {
  createLedgerBackupPayload,
  parseAndMergeLedgerBackup,
} from '@/core/backupMergeEngine'
import { buildProjectSettlementShareText } from '@/core/shareFormatter'
import { calculateSettleUp } from '@/core/settleUpEngine'
import type { Project, Transaction } from '@/schemas/ledgerSchema'

const projectA: Project = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  schemaVersion: 1,
  name: '2026 東京自由行',
  baseCurrency: 'JPY',
  members: [
    { id: 'me', name: '我', avatarColor: '#10b981' },
    { id: 'lin', name: '小林', avatarColor: '#ec4899' },
  ],
  defaultSplitMode: 'equal',
  defaultPayerId: 'me',
  isActive: true,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
}

const txLocalOld: Transaction = {
  id: '11111111-1111-4111-8111-111111111111',
  schemaVersion: 1,
  projectId: projectA.id,
  vaultLevel: 'normal',
  type: 'expense',
  amount: 2000,
  currency: 'JPY',
  exchangeRateToBase: 1,
  categoryKey: 'cat_food',
  date: '2026-11-24',
  time: '12:00',
  updatedAt: 1700000002000,
  note: '拉麵（舊版）',
  splitConfig: {
    payerId: 'me',
    mode: 'equal',
    shares: [
      { memberId: 'me', finalAmount: 1000 },
      { memberId: 'lin', finalAmount: 1000 },
    ],
  },
}

describe('backupMergeEngine - JSON 備份匯出與 UUID + updatedAt 合併', () => {
  it('能輸出 schemaVersion: 1 備份並精準比對 UUID 與 updatedAt 進行合併', () => {
    const incomingBackup = createLedgerBackupPayload(
      [
        // 相同 UUID 但時間戳較新 -> 應覆寫更新
        { ...projectA, name: '2026 東京賞楓行', updatedAt: 1700000009000 },
      ],
      [
        // 相同 UUID 但時間戳較舊 -> 應保留本地版本（skip）
        { ...txLocalOld, amount: 1500, updatedAt: 1700000001000 },
        // 新 UUID -> 應新增
        {
          ...txLocalOld,
          id: '22222222-2222-4222-8222-222222222222',
          amount: 4000,
          note: '燒肉',
          updatedAt: 1700000005000,
        },
      ],
    )

    expect(incomingBackup.schemaVersion).toBe(1)

    const merged = parseAndMergeLedgerBackup(
      { projects: [projectA], transactions: [txLocalOld] },
      JSON.stringify(incomingBackup),
    )

    expect(merged.stats).toEqual({
      projectsAdded: 0,
      projectsUpdated: 1,
      projectsSkipped: 0,
      transactionsAdded: 1,
      transactionsUpdated: 0,
      transactionsSkipped: 1,
    })

    expect(merged.projects[0].name).toBe('2026 東京賞楓行')
    const keptOld = merged.transactions.find((t) => t.id === txLocalOld.id)
    expect(keptOld?.amount).toBe(2000)
    expect(merged.transactions).toHaveLength(2)
  })
})

describe('shareFormatter - 一鍵分享結算摘要文字產生器', () => {
  it('產生含總支出、各成員支出與待還款建議的清晰文字', () => {
    const settleUp = calculateSettleUp([txLocalOld], 'JPY', ['me', 'lin'])
    const text = buildProjectSettlementShareText(
      projectA,
      settleUp,
      [],
      {
        headerPrefix: '【ClearBill 結算】',
        totalSpendLabel: '專案總支出',
        memberSummaryTitle: '各成員總支出與淨收支：',
        spentLabel: '總支出',
        paidLabel: '已墊付',
        pendingTitle: '待還款建議：',
        allSettledText: '所有人已結清',
        historyTitle: '已記錄還款：',
        transferLine: (from, to, amt) => `${from} ➔ ${to}：${amt}`,
        paidHistoryLine: (from, to, amt, date) => `${date} ${from} 已付給 ${to} ${amt}`,
        footerTagline: '— 由 ClearBill 清帳產生',
      },
      'zh-TW',
    )

    expect(text).toContain('2026 東京自由行')
    expect(text).toContain('2,000')
    expect(text).toContain('小林 ➔ 我')
    expect(text).toContain('1,000')
  })
})
