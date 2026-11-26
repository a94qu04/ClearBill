/** 零小數點精度之幣別清單（最小幣別單位為 1） */
export const ZERO_DECIMAL_CURRENCIES = new Set<string>([
  'TWD',
  'JPY',
  'KRW',
  'VND',
  'IDR',
])

/** 實務上多以整數交易、但偶有小數的旅遊幣別（整數時省略 .00，小數時保留精度） */
const SMART_INTEGER_CURRENCIES = new Set<string>(['THB', 'HKD', 'CNY', 'PHP', 'MYR'])

/**
 * 取得指定幣別的小數位數（TWD / JPY / KRW 為 0，其餘預設為 2）
 */
export function getCurrencyDecimals(currency: string): number {
  const normalized = currency.trim().toUpperCase()
  return ZERO_DECIMAL_CURRENCIES.has(normalized) ? 0 : 2
}

/**
 * 取得指定幣別的最小單位步進值（TWD / JPY / KRW 為 1，其餘為 0.01）
 */
export function getCurrencyMinorUnitStep(currency: string): number {
  const decimals = getCurrencyDecimals(currency)
  return decimals === 0 ? 1 : 0.01
}

/**
 * 取得指定幣別的整數縮放因子（1 或 100），用於避免浮點數誤差
 */
export function getCurrencyScaleFactor(currency: string): number {
  return 10 ** getCurrencyDecimals(currency)
}

/**
 * 將金額精準轉換為最小幣別整數單位
 */
export function toMinorUnits(amount: number, currency: string): number {
  const factor = getCurrencyScaleFactor(currency)
  return Math.round(amount * factor)
}

/**
 * 將最小幣別整數單位轉回標準金額數字（消除 -0 與尾數誤差）
 */
export function fromMinorUnits(units: number, currency: string): number {
  const decimals = getCurrencyDecimals(currency)
  const factor = 10 ** decimals
  const value = units / factor
  if (Object.is(value, -0) || value === 0) {
    return 0
  }
  return Number(value.toFixed(decimals))
}

/**
 * 將純數字或輸入字串格式化為帶千分位逗號的字串（保留輸入中的尾隨小數點或小數零，並安全展開極小／極大科學記號）
 */
export function formatGroupedNumberInput(
  raw: string | number | null | undefined,
  allowDecimals = true,
  maxDecimals = 4,
): string {
  if (raw === null || raw === undefined || raw === '') return ''
  const clampedMaxDecimals = Math.max(0, Math.min(8, Math.floor(maxDecimals)))

  let rawStr: string
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return ''
    const numStr = String(raw)
    if (/e/i.test(numStr)) {
      if (Math.abs(raw) >= 1e15) return ''
      rawStr = allowDecimals
        ? raw.toFixed(clampedMaxDecimals).replace(/\.?0+$/, '')
        : Math.round(raw).toFixed(0)
    } else {
      rawStr = numStr
    }
  } else {
    rawStr = String(raw)
  }

  const str = rawStr.replace(/,/g, '').replace(/[^\d.]/g, '')
  if (!str) return ''

  if (!allowDecimals || clampedMaxDecimals === 0) {
    const intOnly = str.split('.')[0] ?? ''
    if (!intOnly) return ''
    const normalized = intOnly.replace(/^0+(?=\d)/, '')
    return normalized.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  const firstDotIdx = str.indexOf('.')
  const intRaw = firstDotIdx === -1 ? str : str.slice(0, firstDotIdx)
  const decRaw =
    firstDotIdx === -1
      ? ''
      : str
          .slice(firstDotIdx + 1)
          .replace(/\./g, '')
          .slice(0, clampedMaxDecimals)

  const normalizedInt = (intRaw || '0').replace(/^0+(?=\d)/, '')
  const groupedInt = normalizedInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  if (firstDotIdx !== -1) {
    return `${groupedInt}.${decRaw}`
  }
  return groupedInt
}

/**
 * 將帶千分位逗號的輸入字串解析為有限數字（空值回傳 null）
 */
export function parseGroupedNumberInput(
  raw: string | number | null | undefined,
): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null
  }
  const cleaned = raw.replace(/,/g, '').trim()
  if (!cleaned || cleaned === '.') return null
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

/**
 * 嚴格使用 Intl.NumberFormat 格式化幣別金額（遵守多國語言鐵律）
 */
export function formatCurrencyAmount(
  amount: number,
  currency: string,
  locale = 'zh-TW',
): string {
  const normalizedCurrency = currency.trim().toUpperCase()
  const decimals = getCurrencyDecimals(normalizedCurrency)
  const isCleanInt =
    decimals > 0 &&
    SMART_INTEGER_CURRENCIES.has(normalizedCurrency) &&
    Number.isInteger(Number(amount.toFixed(decimals)))
  const minFractionDigits = isCleanInt ? 0 : decimals

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: minFractionDigits,
      maximumFractionDigits: decimals,
    }).format(amount)
  } catch {
    const numberText = new Intl.NumberFormat(locale, {
      minimumFractionDigits: minFractionDigits,
      maximumFractionDigits: decimals,
    }).format(amount)
    return `${normalizedCurrency} ${numberText}`
  }
}

/**
 * 嚴格使用 Intl.NumberFormat 格式化純金額數字（不含幣別符號，方便搭配醒目的 ISO 幣別代碼顯示「{幣別} 金額」）
 */
export function formatCurrencyNumber(
  amount: number,
  currency: string,
  locale = 'zh-TW',
): string {
  const normalizedCurrency = currency.trim().toUpperCase()
  const decimals = getCurrencyDecimals(normalizedCurrency)
  const isCleanInt =
    decimals > 0 &&
    SMART_INTEGER_CURRENCIES.has(normalizedCurrency) &&
    Number.isInteger(Number(amount.toFixed(decimals)))
  const minFractionDigits = isCleanInt ? 0 : decimals

  return new Intl.NumberFormat(locale, {
    style: 'decimal',
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: decimals,
  }).format(amount)
}

export interface CurrencyDisplayPart {
  type: 'currency' | 'text'
  value: string
}

/**
 * 嚴格使用 Intl.NumberFormat.formatToParts 拆解幣別符號與數字，
 * 讓 UI 可將幣別文字獨立縮小為金額數字的一半（0.5em）
 */
export function formatCurrencyParts(
  amount: number,
  currency: string,
  locale = 'zh-TW',
): CurrencyDisplayPart[] {
  const normalizedCurrency = currency.trim().toUpperCase()
  const decimals = getCurrencyDecimals(normalizedCurrency)
  const isCleanInt =
    decimals > 0 &&
    SMART_INTEGER_CURRENCIES.has(normalizedCurrency) &&
    Number.isInteger(Number(amount.toFixed(decimals)))
  const minFractionDigits = isCleanInt ? 0 : decimals

  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: minFractionDigits,
      maximumFractionDigits: decimals,
    })
    return formatter.formatToParts(amount).map((part) => ({
      type: part.type === 'currency' ? 'currency' : 'text',
      value: part.value,
    }))
  } catch {
    const numberText = new Intl.NumberFormat(locale, {
      minimumFractionDigits: minFractionDigits,
      maximumFractionDigits: decimals,
    }).format(amount)
    return [
      { type: 'currency', value: normalizedCurrency },
      { type: 'text', value: ` ${numberText}` },
    ]
  }
}
