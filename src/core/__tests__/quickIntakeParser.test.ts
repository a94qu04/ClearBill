import { describe, expect, it } from 'vitest'
import {
  parseQuickIntake,
  parseQuickIntakeUrl,
  sanitizeNotificationText,
} from '@/core/quickIntakeParser'
import {
  migrateLedgerBackup,
  migrateTransaction,
  SchemaMigrationError,
} from '@/core/migrationEngine'
import type { Project } from '@/schemas/ledgerSchema'

const sampleActiveProject: Project = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  schemaVersion: 1,
  name: '2026 東京自由行',
  baseCurrency: 'JPY',
  members: [
    { id: 'me', name: '我' },
    { id: 'lin', name: '小林' },
    { id: 'chen', name: '阿陳' },
  ],
  defaultSplitMode: 'equal',
  defaultPayerId: 'me',
  isActive: true,
  createdAt: 1732400000000,
  updatedAt: 1732400000000,
}

describe('quickIntakeParser - iOS 捷徑、Web Share 與刷卡脫敏解析器', () => {
  it('解析 iOS 捷徑 hash URL 參數並套用進行中旅遊專案與預設均攤規則', () => {
    const url =
      'https://clearbill.app/#/quick-add?amount=3000&merchant=%E4%B8%80%E8%98%AD%E6%8B%89%E9%BA%B5&sourceApp=ApplePay&currency=JPY'

    const parsed = parseQuickIntake(url, {
      activeProject: sampleActiveProject,
      referenceDate: new Date('2026-11-24T10:30:00Z'),
    })

    expect(parsed.amount).toBe(3000)
    expect(parsed.currency).toBe('JPY')
    expect(parsed.merchant).toBe('一蘭拉麵')
    expect(parsed.sourceApp).toBe('ApplePay')
    // 未提供時間一律預設 00:00
    expect(parsed.time).toBe('00:00')
    expect(parsed.projectId).toBe(sampleActiveProject.id)
    expect(parsed.defaultSplitConfig).toEqual({
      payerId: 'me',
      mode: 'equal',
      shares: [
        { memberId: 'me', finalAmount: 1000 },
        { memberId: 'lin', finalAmount: 1000 },
        { memberId: 'chen', finalAmount: 1000 },
      ],
    })
  })

  it('刷卡通知脫敏：遮罩卡號末四碼、身分證、手機、OTP 與可用餘額，並精準抽取消費金額與特店', () => {
    const rawSms =
      '國泰世華通知：您卡號末四碼1234於11/24 14:25消費NT$1,280，特店：星巴克信義門市，可用餘額NT$85,000，驗證碼：998877，聯絡手機0912-345-678。'

    const sanitized = sanitizeNotificationText(rawSms)
    expect(sanitized).not.toContain('1234')
    expect(sanitized).not.toContain('85,000')
    expect(sanitized).not.toContain('998877')
    expect(sanitized).not.toContain('0912-345-678')

    const parsed = parseQuickIntake(
      {
        rawText: rawSms,
        sourceApp: 'iOS_Shortcut',
      },
      {
        referenceDate: new Date('2026-11-24T00:00:00Z'),
      },
    )

    expect(parsed.amount).toBe(1280)
    expect(parsed.currency).toBe('TWD')
    expect(parsed.merchant).toBe('星巴克信義門市')
    expect(parsed.date).toBe('2026-11-24')
    expect(parsed.time).toBe('14:25')
    expect(parsed.projectId).toBeUndefined()
  })

  it('解析 Web Share 分享文字與外部地圖/訂單 URL（最多保留 3 組有效連結）', () => {
    const parsed = parseQuickIntake({
      rawText:
        'Apple Pay: Paid ¥4,500 at Ichiran Shibuya https://maps.google.com/?q=ichiran https://example.com/order/1 https://example.com/order/2 https://example.com/order/3',
      sourceApp: 'WebShare',
    })

    expect(parsed.amount).toBe(4500)
    expect(parsed.currency).toBe('JPY')
    expect(parsed.merchant).toBe('Ichiran Shibuya')
    expect(parsed.links).toHaveLength(3)
    expect(parsed.links[0]).toBe('https://maps.google.com/?q=ichiran')
  })

  it('parseQuickIntakeUrl 支援無網域之相對 hash 路徑', () => {
    const params = parseQuickIntakeUrl('/#/quick-add?amount=NT$240&merchant=麥當勞&sourceApp=LINEPay')
    expect(params.amount).toBe('NT$240')
    expect(params.merchant).toBe('麥當勞')
    expect(params.sourceApp).toBe('LINEPay')
  })

  it('百分比模式專案與含公費袋專案在 #/quick-add 下皆安全降級均攤且排除虛擬公費袋', () => {
    const pctProject: Project = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      schemaVersion: 1,
      name: '百分比與公費測試團',
      baseCurrency: 'TWD',
      members: [
        { id: 'me', name: '我' },
        { id: 'bob', name: '小王' },
        { id: 'pool_1', name: '公費袋', isPool: true },
      ],
      defaultSplitMode: 'percentage',
      defaultPayerId: 'pool_1',
      isActive: true,
      createdAt: 1732400000000,
      updatedAt: 1732400000000,
    }
    const res = parseQuickIntake('https://clearbill.app/#/quick-add?amount=500&merchant=拉麵', {
      activeProject: pctProject,
      defaultCurrency: 'TWD',
    })
    expect(res.amount).toBe(500)
    expect(res.defaultSplitConfig?.mode).toBe('equal')
    expect(res.defaultSplitConfig?.shares.map((s) => s.memberId)).toEqual(['me', 'bob'])
  })
})

describe('migrationEngine - Schema 版本控管與向下相容', () => {
  it('將缺少 schemaVersion 與 time 的 v0 交易自動遷移至 schemaVersion: 1 與預設時間 00:00', () => {
    const migrated = migrateTransaction({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'expense',
      amount: 150,
      currency: 'twd',
      categoryKey: 'cat_food',
      date: '2026-11-24',
      updatedAt: 1732400000000,
    })

    expect(migrated.schemaVersion).toBe(1)
    expect(migrated.currency).toBe('TWD')
    expect(migrated.time).toBe('00:00')
    expect(migrated.vaultLevel).toBe('normal')
    expect(migrated.exchangeRateToBase).toBe(1)
  })

  it('遇到高於當前支援版本的資料時拋出 ERR_UNSUPPORTED_SCHEMA_VERSION', () => {
    expect(() =>
      migrateLedgerBackup({
        schemaVersion: 99,
        exportedAt: Date.now(),
        projects: [],
        transactions: [],
      }),
    ).toThrowError(SchemaMigrationError)
  })
})
