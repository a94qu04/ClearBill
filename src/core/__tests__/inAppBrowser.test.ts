import { describe, expect, it } from 'vitest'
import { detectInAppBrowser } from '@/core/inAppBrowser'
import { applyPercentFees } from '@/core/ledgerHelpers'
import { buildProjectSettlementShareText } from '@/core/shareFormatter'
import { calculateSettleUp } from '@/core/settleUpEngine'
import type { Project, Transaction } from '@/schemas/ledgerSchema'

describe('inAppBrowser - LINE / 社群內建瀏覽器偵測', () => {
  it('能正確辨識 LINE、Facebook、Instagram、WeChat 與 Threads 內建瀏覽器', () => {
    expect(
      detectInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.8.0',
      ),
    ).toEqual({ isInApp: true, kind: 'line', appName: 'LINE' })

    expect(
      detectInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0]',
      ),
    ).toEqual({ isInApp: true, kind: 'facebook', appName: 'Facebook' })

    expect(
      detectInAppBrowser('Mozilla/5.0 (Linux; Android 14) Instagram 320.0.0.0'),
    ).toEqual({ isInApp: true, kind: 'instagram', appName: 'Instagram' })

    expect(
      detectInAppBrowser('Mozilla/5.0 MicroMessenger/8.0.48'),
    ).toEqual({ isInApp: true, kind: 'wechat', appName: 'WeChat' })

    expect(
      detectInAppBrowser('Mozilla/5.0 Barcelona 310.0'),
    ).toEqual({ isInApp: true, kind: 'threads', appName: 'Threads' })
  })

  it('一般 Safari / Chrome 瀏覽器不應誤判為內建瀏覽器', () => {
    expect(
      detectInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ).isInApp,
    ).toBe(false)

    expect(
      detectInAppBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      ).isInApp,
    ).toBe(false)
  })
})

describe('shareFormatter - 結算分享文字附帶收款帳號', () => {
  it('當收款成員有設定 paymentInfo 時，分享文字於轉帳建議下方自動附帶收款資訊', () => {
    const project: Project = {
      id: '11111111-1111-4111-8111-111111111111',
      schemaVersion: 1,
      name: '沖繩之旅',
      baseCurrency: 'TWD',
      members: [
        { id: 'alice', name: 'Alice', paymentInfo: '國泰世華(013) 0123-4567-8901' },
        { id: 'bob', name: 'Bob' },
      ],
      defaultSplitMode: 'equal',
      isActive: true,
      createdAt: 1732400000000,
      updatedAt: 1732400000000,
    }
    const txs: Transaction[] = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        schemaVersion: 1,
        projectId: project.id,
        vaultLevel: 'normal',
        type: 'expense',
        amount: 2000,
        currency: 'TWD',
        exchangeRateToBase: 1,
        categoryKey: 'cat_food',
        date: '2026-11-25',
        time: '12:00',
        updatedAt: 1732400000000,
        lastEditedBy: 'Alice',
        splitConfig: {
          payerId: 'alice',
          mode: 'equal',
          shares: [
            { memberId: 'alice', finalAmount: 1000 },
            { memberId: 'bob', finalAmount: 1000 },
          ],
        },
      },
    ]

    const settle = calculateSettleUp(txs, 'TWD', ['alice', 'bob'])
    const text = buildProjectSettlementShareText(
      project,
      settle,
      [],
      {
        headerPrefix: '【ClearBill】',
        totalSpendLabel: '總支出',
        memberSummaryTitle: '成員',
        spentLabel: '支出',
        paidLabel: '墊付',
        pendingTitle: '待還款',
        allSettledText: '已結清',
        historyTitle: '還款紀錄',
        transferLine: (from, to, amt) => `${from} -> ${to}: ${amt}`,
        paidHistoryLine: (from, to, amt, date) => `${date} ${from} ${to} ${amt}`,
        footerTagline: 'ClearBill',
      },
      'zh-TW',
    )

    expect(text).toContain('國泰世華(013) 0123-4567-8901')
  })
})

describe('ledgerHelpers - 自訂服務費 % 與刷卡手續費 % 計算', () => {
  it('支援單獨或同時疊加自訂服務費與刷卡手續費，並依幣別精度精準四捨五入', () => {
    expect(applyPercentFees(1000, 10, null, 0)).toBe(1100)
    expect(applyPercentFees(1000, null, 1.5, 0)).toBe(1015)
    // 1000 * 1.1 * 1.015 = 1116.5 -> TWD 取整 1117，USD 取兩位小數 1116.5
    expect(applyPercentFees(1000, 10, 1.5, 0)).toBe(1117)
    expect(applyPercentFees(1000, 10, 1.5, 2)).toBe(1116.5)
    // 自訂任意費率（例如 5% 服務費 + 2.2% 手續費）
    expect(applyPercentFees(2000, 5, 2.2, 2)).toBe(2146.2)
  })
})
