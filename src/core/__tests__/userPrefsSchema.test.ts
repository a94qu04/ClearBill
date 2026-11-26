import { describe, expect, it } from 'vitest'
import {
  createDefaultUserPrefs,
  parseCustomFeeRatesJson,
  parseGoogleDriveAccountInfoJson,
  parseGoogleSessionTokenJson,
  parseLiveRatesCacheJson,
  parseUserPrefsV1Json,
  parseUserPrefsV2,
  parseUserPrefsV2Json,
  sanitizeUsdRatesMap,
  type UserPrefsParseDefaults,
} from '@/schemas/userPrefsSchema'

const TEST_DEFAULTS: UserPrefsParseDefaults = {
  initialCurrencies: ['TWD', 'JPY', 'USD'],
  defaultCategories: [
    { key: 'cat_food', color: '#ea580c', icon: 'utensils', isBuiltin: true },
    { key: 'cat_other', color: '#475569', icon: 'tag', isBuiltin: true },
  ],
  defaultAvatarColor: '#059669',
}

describe('userPrefsSchema — localStorage 與快取安全解析', () => {
  describe('parseUserPrefsV2 / parseUserPrefsV2Json', () => {
    it('語法損壞或非物件頂層值（null、陣列、原始型別）會安全回退完整預設', () => {
      const expected = createDefaultUserPrefs(TEST_DEFAULTS)
      expect(parseUserPrefsV2Json('{bad json', TEST_DEFAULTS)).toEqual(expected)
      expect(parseUserPrefsV2Json('', TEST_DEFAULTS)).toEqual(expected)
      expect(parseUserPrefsV2Json('null', TEST_DEFAULTS)).toEqual(expected)
      expect(parseUserPrefsV2Json('["TWD"]', TEST_DEFAULTS)).toEqual(expected)
      expect(parseUserPrefsV2(12345, TEST_DEFAULTS)).toEqual(expected)
    })

    it('欄位級容錯：僅單一欄位或陣列／字典項目損壞時，保留其餘有效設定', () => {
      const raw = {
        defaultCurrency: 'jpy', // 應自動正規化大寫
        enabledCurrencies: ['TWD', 'INVALID', 123, 'usd', 'KRW'],
        categories: [
          null,
          { key: '   ' },
          {
            key: 'cat_custom',
            customLabel: ' 咖啡 ',
            color: '',
            icon: 'not_exist_icon',
            isBuiltin: false,
          },
        ],
        projectOrder: ['p1', 999, 'p2', null],
        projectOrderUpdatedAt: 1700000000.9,
        exchangeRates: {
          JPY_TWD: 0.215,
          INVALID_KEY: 1.5,
          USD_TWD: -32,
          EUR_TWD: Number.NaN,
          KRW_TWD: '0.023',
        },
        quickExchangeRates: {
          JPY_TWD: { cash: 0.22, card: -1 },
          USD_TWD: { cash: 0, card: 'bad' },
          BAD: { cash: 1 },
        },
        lastExpenseProjectId: '  p1  ',
        lastCurrencyByProject: {
          p1: 'eur',
          p2: 'INVALID',
          '   ': 'TWD',
        },
        lastSplitByProject: {
          p1: {
            payerId: 'm1',
            mode: 'equal',
            shares: [{ memberId: 'm1', finalAmount: 100 }],
          },
          p2: { payerId: '', mode: 'unknown', shares: [] },
        },
        settlementViewByProject: {
          p1: {
            settlementCurrency: 'twd',
            settlementRateMode: 'custom',
            settlementCustomRates: { jpy: 0.21, invalid: 1, usd: -30 },
            settlementCustomRatesByCurrency: {
              twd: { jpy: 0.21, krw: 0 },
              not_cur: { jpy: 0.2 },
            },
          },
          p2: {
            settlementCurrency: 'INVALID',
            settlementRateMode: 'invalid_mode',
          },
        },
        userProfile: {
          displayName: '  Alice  ',
          avatarColor: '',
          avatarImage: 'https://evil.example/a.png', // 非 data:image/ 應剔除
          paymentInfo: '  822-12345  ',
          updatedAt: -5, // 負數應剔除
        },
      }

      const result = parseUserPrefsV2(raw, TEST_DEFAULTS)

      expect(result.defaultCurrency).toBe('JPY')
      expect(result.enabledCurrencies).toEqual(['TWD', 'USD', 'KRW', 'JPY'])
      expect(result.categories).toEqual([
        {
          key: 'cat_custom',
          customLabel: '咖啡',
          color: '#10b981',
          icon: 'tag',
          isBuiltin: false,
        },
      ])
      expect(result.projectOrder).toEqual(['p1', 'p2'])
      expect(result.projectOrderUpdatedAt).toBe(1700000000)
      expect(result.exchangeRates).toEqual({ JPY_TWD: 0.215 })
      expect(result.quickExchangeRates).toEqual({ JPY_TWD: { cash: 0.22 } })
      expect(result.lastExpenseProjectId).toBe('p1')
      expect(result.lastCurrencyByProject).toEqual({ p1: 'EUR' })
      expect(Object.keys(result.lastSplitByProject ?? {})).toEqual(['p1'])
      expect(result.settlementViewByProject).toEqual({
        p1: {
          settlementCurrency: 'TWD',
          settlementRateMode: 'custom',
          settlementCustomRates: { JPY: 0.21 },
          settlementCustomRatesByCurrency: { TWD: { JPY: 0.21 } },
        },
      })
      expect(result.userProfile).toEqual({
        displayName: 'Alice',
        avatarColor: '#059669',
        avatarImage: undefined,
        paymentInfo: '822-12345',
        updatedAt: undefined,
      })
    })

    it('categories 全部無效或空陣列時回退預設分類；defaultCurrency 無效回退 TWD', () => {
      const result = parseUserPrefsV2(
        {
          defaultCurrency: 'NOT_A_CURRENCY',
          enabledCurrencies: 'not-an-array',
          categories: [{ key: '' }, null],
        },
        TEST_DEFAULTS,
      )

      expect(result.defaultCurrency).toBe('TWD')
      expect(result.enabledCurrencies).toEqual(['TWD', 'JPY', 'USD'])
      expect(result.categories).toEqual(TEST_DEFAULTS.defaultCategories)
    })

    it('userProfile 保留合法的 data:image/ 頭像並截斷超長暱稱與收款資訊', () => {
      const result = parseUserPrefsV2(
        {
          userProfile: {
            displayName: 'A'.repeat(80),
            avatarColor: '#2563eb',
            avatarImage: 'data:image/webp;base64,AAAA',
            paymentInfo: 'B'.repeat(200),
            updatedAt: 1700000123.7,
          },
        },
        TEST_DEFAULTS,
      )
      expect(result.userProfile?.displayName).toHaveLength(50)
      expect(result.userProfile?.avatarColor).toBe('#2563eb')
      expect(result.userProfile?.avatarImage).toBe('data:image/webp;base64,AAAA')
      expect(result.userProfile?.paymentInfo).toHaveLength(120)
      expect(result.userProfile?.updatedAt).toBe(1700000123)
    })
  })

  describe('parseUserPrefsV1Json', () => {
    it('向下相容遷移 v1 並剔除無效幣別與損壞分類', () => {
      const raw = JSON.stringify({
        defaultCurrency: 'USD',
        customCurrencies: ['EUR', 'BAD1', 42],
        customCategories: [
          { key: 'cat_coffee', label: '咖啡', color: '#92400e' },
          { key: '', label: '無效' },
          null,
        ],
      })
      const result = parseUserPrefsV1Json(raw, TEST_DEFAULTS)
      expect(result.defaultCurrency).toBe('USD')
      expect(result.enabledCurrencies).toEqual(['TWD', 'JPY', 'USD', 'EUR'])
      expect(result.categories).toHaveLength(3)
      expect(result.categories[2]).toMatchObject({
        key: 'cat_coffee',
        customLabel: '咖啡',
        color: '#92400e',
        isBuiltin: false,
      })
    })

    it('v1 JSON 損壞時回退預設', () => {
      expect(parseUserPrefsV1Json('{broken', TEST_DEFAULTS)).toEqual(
        createDefaultUserPrefs(TEST_DEFAULTS),
      )
    })
  })

  describe('parseLiveRatesCacheJson 與 sanitizeUsdRatesMap', () => {
    it('合法快取可解析並過濾壞匯率項目，空來源回退 cache', () => {
      const raw = JSON.stringify({
        ratesPerUsd: { USD: 1, TWD: 32.5, jpy: 150, INVALID: 1, EUR: -1, KRW: null },
        fetchedAt: 1700000000000,
        source: '  ',
      })
      expect(parseLiveRatesCacheJson(raw)).toEqual({
        ratesPerUsd: { USD: 1, TWD: 32.5, JPY: 150 },
        fetchedAt: 1700000000000,
        source: 'cache',
      })
    })

    it('壞 JSON、負數 fetchedAt 或完全無有效匯率時回傳 null', () => {
      expect(parseLiveRatesCacheJson('{bad')).toBeNull()
      expect(
        parseLiveRatesCacheJson(
          JSON.stringify({ ratesPerUsd: { TWD: 32 }, fetchedAt: -1 }),
        ),
      ).toBeNull()
      expect(
        parseLiveRatesCacheJson(
          JSON.stringify({ ratesPerUsd: { TWD: 0, INVALID: 1 }, fetchedAt: 100 }),
        ),
      ).toBeNull()
      expect(parseLiveRatesCacheJson('[]')).toBeNull()
    })

    it('sanitizeUsdRatesMap 過濾無效幣別並自動保證 USD=1', () => {
      expect(sanitizeUsdRatesMap({ twd: 32.1, invalid: 10, jpy: -5 })).toEqual({
        USD: 1,
        TWD: 32.1,
      })
      expect(sanitizeUsdRatesMap(null)).toBeNull()
      expect(sanitizeUsdRatesMap({ invalid: 1 })).toBeNull()
    })
  })

  describe('Google Drive 快取解析（Token 與 Account）', () => {
    it('parseGoogleSessionTokenJson 驗證 token 與 expiresAt', () => {
      const valid = JSON.stringify({ token: 'ya29.abc', expiresAt: 1800000000000 })
      expect(parseGoogleSessionTokenJson(valid)).toEqual({
        token: 'ya29.abc',
        expiresAt: 1800000000000,
      })
      expect(parseGoogleSessionTokenJson('{bad')).toBeNull()
      expect(
        parseGoogleSessionTokenJson(JSON.stringify({ token: '  ', expiresAt: 100 })),
      ).toBeNull()
      expect(
        parseGoogleSessionTokenJson(JSON.stringify({ token: 'abc', expiresAt: '100' })),
      ).toBeNull()
      expect(
        parseGoogleSessionTokenJson(JSON.stringify({ token: 'abc', expiresAt: 0 })),
      ).toBeNull()
    })

    it('parseGoogleDriveAccountInfoJson 缺少 displayName 時以 email 補齊，壞資料回傳 null', () => {
      expect(
        parseGoogleDriveAccountInfoJson(
          JSON.stringify({ email: ' user@example.com ', displayName: ' ' }),
        ),
      ).toEqual({
        email: 'user@example.com',
        displayName: 'user@example.com',
      })
      expect(
        parseGoogleDriveAccountInfoJson(
          JSON.stringify({ email: 'user@example.com', displayName: 'User Name' }),
        ),
      ).toEqual({
        email: 'user@example.com',
        displayName: 'User Name',
      })
      expect(parseGoogleDriveAccountInfoJson('{bad')).toBeNull()
      expect(
        parseGoogleDriveAccountInfoJson(JSON.stringify({ displayName: 'Only Name' })),
      ).toBeNull()
    })
  })

  describe('parseCustomFeeRatesJson', () => {
    it('單欄超出範圍或型別錯誤時僅該欄回退預設', () => {
      expect(parseCustomFeeRatesJson('{"service":12,"fx":999}')).toEqual({
        service: 12,
        fx: 1.5,
      })
      expect(parseCustomFeeRatesJson('{"service":-5,"fx":2.5}')).toEqual({
        service: 10,
        fx: 2.5,
      })
      expect(parseCustomFeeRatesJson('{bad')).toEqual({
        service: 10,
        fx: 1.5,
      })
    })
  })
})
