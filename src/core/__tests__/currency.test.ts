import { describe, expect, it } from 'vitest'
import { formatCurrencyAmount, formatCurrencyParts } from '@/core/currency'

describe('formatCurrencyParts', () => {
  it('將 Intl.NumberFormat 輸出正確拆分為幣別符號與數字，且串接後等同 formatCurrencyAmount', () => {
    const cases: Array<[number, string, string]> = [
      [1200, 'TWD', 'zh-TW'],
      [3500, 'JPY', 'ja'],
      [42.5, 'USD', 'en'],
      [-250, 'TWD', 'zh-TW'],
      [100, 'THB', 'zh-TW'],
    ]

    for (const [amount, currency, locale] of cases) {
      const parts = formatCurrencyParts(amount, currency, locale)
      expect(parts.some((p) => p.type === 'currency')).toBe(true)
      expect(parts.some((p) => p.type === 'text')).toBe(true)
      expect(parts.map((p) => p.value).join('')).toBe(
        formatCurrencyAmount(amount, currency, locale),
      )
    }
  })

  it('遇到非標準幣別代碼時安全回退並仍分離幣別與數字', () => {
    const parts = formatCurrencyParts(1500, 'XYZ123', 'zh-TW')
    expect(parts[0]).toEqual({ type: 'currency', value: 'XYZ123' })
    expect(parts[1]?.type).toBe('text')
    expect(parts[1]?.value).toContain('1,500')
  })
})
