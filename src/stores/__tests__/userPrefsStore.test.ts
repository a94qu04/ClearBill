import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUserPrefsStore } from '@/stores/userPrefsStore'

describe('userPrefsStore - 使用者偏好、幣別、分類與匯率記憶', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('預設幣別切換與常用幣別新增／移除（不可刪到空或刪預設幣別）', () => {
    const prefs = useUserPrefsStore()

    expect(prefs.defaultCurrency).toBe('TWD')
    expect(prefs.addCurrency('aud')).toBe('AUD')
    expect(prefs.enabledCurrencies).toContain('AUD')
    const countAfterAdd = prefs.enabledCurrencies.length
    expect(prefs.addCurrency('AUD')).toBe('AUD')
    expect(prefs.enabledCurrencies.length).toBe(countAfterAdd) // 不重複新增

    prefs.setDefaultCurrency('AUD')
    expect(prefs.defaultCurrency).toBe('AUD')
    // 預設幣別不可直接移除
    expect(prefs.removeCurrency('AUD')).toBe(false)
    // 非預設幣別可移除
    expect(prefs.removeCurrency('HKD')).toBe(true)
    expect(prefs.enabledCurrencies).not.toContain('HKD')
  })

  it('分類新增、編輯、刪除防呆與重置預設分類（保留自訂分類並通知 Drive dirty）', () => {
    const prefs = useUserPrefsStore()
    const dirtySpy = vi.fn()
    prefs.bindDriveDirtyHook(dirtySpy)
    const initialCount = prefs.categories.length

    const created = prefs.addCategory('滑雪裝備', '#0ea5e9', 'shopping')
    expect(created).not.toBeNull()
    expect(prefs.categories.length).toBe(initialCount + 1)
    expect(dirtySpy).toHaveBeenCalled()

    prefs.updateCategory(created!.key, {
      customLabel: '北海道滑雪',
      color: '#2563eb',
    })
    expect(
      prefs.categories.find((c) => c.key === created!.key)?.customLabel,
    ).toBe('北海道滑雪')

    // 移除所有內建分類後再重置，自訂分類應被保留且內建分類恢復
    const builtinKeys = prefs.categories
      .filter((c) => c.isBuiltin)
      .map((c) => c.key)
    for (const key of builtinKeys) {
      prefs.removeCategory(key)
    }
    expect(prefs.categories.length).toBe(1)
    // 僅剩最後一個分類時禁止刪除
    expect(prefs.removeCategory(created!.key)).toBe(false)

    prefs.resetDefaultCategories()
    expect(prefs.categories.some((c) => c.key === created!.key)).toBe(true)
    expect(prefs.categories.filter((c) => c.isBuiltin).length).toBe(7)
  })

  it('匯率記憶、快捷匯率與 getEffectiveExchangeRateWithSource 來源優先序', () => {
    const prefs = useUserPrefsStore()

    // 同幣別直接回傳 1 (same)
    expect(prefs.getEffectiveExchangeRateWithSource('TWD', 'TWD')).toEqual({
      rate: 1,
      source: 'same',
    })

    // 未知幣別無記憶無快取時回傳 missing（不得靜默 1:1）
    expect(prefs.getEffectiveExchangeRateWithSource('VND', 'TWD')).toEqual({
      rate: null,
      source: 'missing',
    })

    // 離線已知幣別在無記憶與無 live 快取時回傳 estimated
    const est = prefs.getEffectiveExchangeRateWithSource('JPY', 'TWD')
    expect(est.source).toBe('estimated')
    expect(est.rate).toBeGreaterThan(0)

    // 寫入記憶匯率後，優先權應高於 estimated
    prefs.rememberExchangeRate('JPY', 'TWD', 0.218)
    expect(prefs.getRememberedExchangeRate('JPY', 'TWD')).toBe(0.218)
    expect(prefs.getEffectiveExchangeRateWithSource('JPY', 'TWD')).toEqual({
      rate: 0.218,
      source: 'remembered',
    })

    // 清除記憶匯率後恢復 estimated
    prefs.clearRememberedExchangeRate('JPY', 'TWD')
    expect(prefs.getRememberedExchangeRate('JPY', 'TWD')).toBeNull()
    expect(prefs.getEffectiveExchangeRateWithSource('JPY', 'TWD').source).toBe(
      'estimated',
    )

    // 快捷匯率（現金／刷卡價）可獨立保存與讀取
    prefs.saveQuickExchangeRatePreset('JPY', 'TWD', 'cash', 0.22)
    prefs.saveQuickExchangeRatePreset('JPY', 'TWD', 'card', 0.214)
    expect(prefs.getQuickExchangeRatePresets('JPY', 'TWD')).toEqual({
      cash: 0.22,
      card: 0.214,
    })
  })
})
