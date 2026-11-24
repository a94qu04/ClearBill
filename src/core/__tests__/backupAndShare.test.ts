import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import {
  createLedgerBackupPayload,
  parseAndMergeLedgerBackup,
} from '@/core/backupMergeEngine'
import {
  buildGoogleConnectLink,
  parseGoogleConnectHash,
} from '@/core/googleConnectLink'
import { SchemaMigrationError } from '@/core/migrationEngine'
import { buildProjectSettlementShareText } from '@/core/shareFormatter'
import { calculateSettleUp } from '@/core/settleUpEngine'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import zhTW from '@/locales/zh-TW.json'
import en from '@/locales/en.json'
import ja from '@/locales/ja.json'

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

const sampleShareLabels = {
  headerPrefix: '【ClearBill 結算】',
  totalSpendLabel: '專案總支出',
  memberSummaryTitle: '各成員總支出與淨收支：',
  spentLabel: '總支出',
  paidLabel: '已墊付',
  pendingTitle: '待還款建議：',
  allSettledText: '所有人已結清',
  historyTitle: '已記錄還款：',
  transferLine: (from: string, to: string, amt: string) => `${from} ➔ ${to}：${amt}`,
  paidHistoryLine: (from: string, to: string, amt: string, date: string) =>
    `${date} ${from} 已付給 ${to} ${amt}`,
  footerTagline: '— 由 ClearBill 清帳產生',
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
      categoriesAdded: 0,
    })

    expect(merged.projects[0].name).toBe('2026 東京賞楓行')
    const keptOld = merged.transactions.find((t) => t.id === txLocalOld.id)
    expect(keptOld?.amount).toBe(2000)
    expect(merged.transactions).toHaveLength(2)
  })

  it('能容錯遷移空陣列 links / receiptImages 與空備註之雲端備份檔', () => {
    const legacyCloudPayload = {
      schemaVersion: 1,
      exportedAt: Date.now(),
      projects: [projectA],
      transactions: [
        {
          ...txLocalOld,
          id: '55555555-5555-4555-8555-555555555555',
          note: '',
          links: [],
          receiptImages: [],
          updatedAt: 1700000010000,
        },
      ],
    }

    const merged = parseAndMergeLedgerBackup(
      { projects: [projectA], transactions: [txLocalOld] },
      legacyCloudPayload,
    )

    expect(merged.stats.transactionsAdded).toBe(1)
    const added = merged.transactions.find(
      (t) => t.id === '55555555-5555-4555-8555-555555555555',
    )
    expect(added?.links).toBeUndefined()
    expect(added?.receiptImages).toBeUndefined()
    expect(added?.note).toBeUndefined()
  })

  it('拒絕無效的 JSON 字串與結構損毀之備份資料', () => {
    expect(() =>
      parseAndMergeLedgerBackup(
        { projects: [projectA], transactions: [txLocalOld] },
        '{ invalid json !!!',
      ),
    ).toThrow()

    expect(() =>
      parseAndMergeLedgerBackup(
        { projects: [projectA], transactions: [txLocalOld] },
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: Date.now(),
          projects: [{ id: 'not-a-uuid' }],
          transactions: [],
        }),
      ),
    ).toThrow()
  })

  it('拒絕高於當前支援版本（schemaVersion: 99）的外部備份檔', () => {
    const futureBackup = JSON.stringify({
      schemaVersion: 99,
      exportedAt: Date.now(),
      projects: [],
      transactions: [],
    })

    expect(() =>
      parseAndMergeLedgerBackup(
        { projects: [projectA], transactions: [txLocalOld] },
        futureBackup,
      ),
    ).toThrowError(SchemaMigrationError)

    expect(() =>
      parseAndMergeLedgerBackup(
        { projects: [projectA], transactions: [txLocalOld] },
        futureBackup,
      ),
    ).toThrowError(/ERR_UNSUPPORTED_SCHEMA_VERSION/)
  })
})

describe('shareFormatter - 一鍵分享結算摘要文字產生器', () => {
  it('產生含總支出、各成員支出與待還款建議的清晰文字', () => {
    const settleUp = calculateSettleUp([txLocalOld], 'JPY', ['me', 'lin'])
    const text = buildProjectSettlementShareText(
      projectA,
      settleUp,
      [],
      sampleShareLabels,
      'zh-TW',
    )

    expect(text).toContain('2026 東京自由行')
    expect(text).toContain('2,000')
    expect(text).toContain('小林 ➔ 我')
    expect(text).toContain('1,000')
  })

  it('同時包含 refund（退款／退稅）與 transfer（已記錄還款）時，總支出與待還款輸出皆準確', () => {
    const txRefund: Transaction = {
      id: '33333333-3333-4333-8333-333333333333',
      schemaVersion: 1,
      projectId: projectA.id,
      vaultLevel: 'normal',
      type: 'refund',
      amount: 400,
      currency: 'JPY',
      exchangeRateToBase: 1,
      categoryKey: 'cat_shopping',
      date: '2026-11-24',
      time: '15:00',
      updatedAt: 1700000003000,
      note: '藥妝退稅',
      splitConfig: {
        payerId: 'me',
        mode: 'equal',
        shares: [
          { memberId: 'me', finalAmount: 200 },
          { memberId: 'lin', finalAmount: 200 },
        ],
      },
    }

    const txTransfer: Transaction = {
      id: '44444444-4444-4444-8444-444444444444',
      schemaVersion: 1,
      projectId: projectA.id,
      vaultLevel: 'normal',
      type: 'transfer',
      amount: 300,
      currency: 'JPY',
      exchangeRateToBase: 1,
      categoryKey: 'cat_settlement',
      date: '2026-11-25',
      time: '00:00',
      updatedAt: 1700000004000,
      note: '現金先還部分',
      splitConfig: {
        payerId: 'lin',
        mode: 'custom_plus_equal',
        shares: [{ memberId: 'me', finalAmount: 300 }],
      },
    }

    // 原消費 2000 - 退稅 400 = 專案總支出 1600（兩人各負擔 800）
    // 小林原本欠我 800，已還 300 -> 剩餘待還款 500
    const allTxs = [txLocalOld, txRefund, txTransfer]
    const settleUp = calculateSettleUp(allTxs, 'JPY', ['me', 'lin'])

    expect(settleUp.totalProjectExpense).toBe(1600)
    expect(settleUp.transfers).toEqual([
      { fromMemberId: 'lin', toMemberId: 'me', amount: 500, currency: 'JPY' },
    ])

    const text = buildProjectSettlementShareText(
      projectA,
      settleUp,
      [txTransfer],
      sampleShareLabels,
      'zh-TW',
    )

    expect(text).toContain('專案總支出')
    expect(text).toContain('1,600')
    expect(text).toContain('總支出')
    expect(text).toContain('800')
    expect(text).toContain('小林 ➔ 我')
    expect(text).toContain('500')
    expect(text).toContain('已記錄還款：')
    expect(text).toContain('2026-11-25 小林 已付給 我')
    expect(text).toContain('300')
  })
})

describe('googleConnectLink - Google 雲端跨裝置快速連線連結', () => {
  it('能產生並解析合法的 Google OAuth Client ID 跨裝置配對連結', () => {
    const clientId = '1234567890-abcdefg12345.apps.googleusercontent.com'
    const url = buildGoogleConnectLink(
      'https://example.github.io/ClearBill/',
      clientId,
    )
    expect(url).toContain('#/connect-google?cid=')

    const hash = url.slice(url.indexOf('#'))
    const parsed = parseGoogleConnectHash(hash)
    expect(parsed).toEqual({ clientId })
  })

  it('拒絕偽造或非 apps.googleusercontent.com 格式的惡意參數', () => {
    expect(parseGoogleConnectHash('#/connect-google?cid=evil.com')).toBeNull()
    expect(parseGoogleConnectHash('#/connect-google?cid=')).toBeNull()
    expect(parseGoogleConnectHash('#/other?cid=123.apps.googleusercontent.com')).toBeNull()
    expect(() =>
      buildGoogleConnectLink('https://example.com/', 'not-a-valid-client-id'),
    ).toThrow()
  })
})

describe('i18n locales - 全站三語系鍵值對齊與 vue-i18n 實機編譯健檢', () => {
  const flattenKeys = (obj: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? flattenKeys(v as Record<string, unknown>, prefix ? `${prefix}.${k}` : k)
        : [prefix ? `${prefix}.${k}` : k],
    )

  it('zh-TW / en / ja 三語系鍵值 100% 一致且全部可被 vue-i18n 零錯誤編譯', () => {
    const zhKeys = flattenKeys(zhTW).sort()
    const enKeys = flattenKeys(en).sort()
    const jaKeys = flattenKeys(ja).sort()

    expect(enKeys).toEqual(zhKeys)
    expect(jaKeys).toEqual(zhKeys)

    const i18n = createI18n({
      legacy: false,
      locale: 'zh-TW',
      messages: { 'zh-TW': zhTW, en, ja },
    })

    for (const loc of ['zh-TW', 'en', 'ja'] as const) {
      i18n.global.locale.value = loc
      for (const key of zhKeys) {
        const rendered = i18n.global.t(key)
        expect(typeof rendered).toBe('string')
        expect(rendered.length).toBeGreaterThan(0)
      }
    }
  })
})
