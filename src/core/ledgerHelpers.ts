const APPROX_RATE_TO_TWD: Record<string, number> = {
  TWD: 1,
  JPY: 0.21,
  USD: 32,
  KRW: 0.023,
  EUR: 34.5,
  HKD: 4.1,
  AUD: 21,
  GBP: 40.5,
  SGD: 24,
  THB: 0.93,
  CNY: 4.45,
  CAD: 23.2,
  VND: 0.00126,
  IDR: 0.002,
  PHP: 0.55,
  MYR: 7.2,
  CHF: 36.5,
  NZD: 19.2,
  MOP: 3.98,
  INR: 0.38,
}

export function getSuggestedExchangeRate(from: string, to: string): number | null {
  const f = from.trim().toUpperCase()
  const tCode = to.trim().toUpperCase()
  if (!f || !tCode) return null
  if (f === tCode) return 1
  const fromInTwd = APPROX_RATE_TO_TWD[f]
  const toInTwd = APPROX_RATE_TO_TWD[tCode]
  if (fromInTwd && toInTwd) {
    const ratio = fromInTwd / toInTwd
    const rounded =
      ratio < 0.01 ? Number(ratio.toPrecision(6)) : Number(ratio.toFixed(4))
    return Number.isFinite(rounded) && rounded > 0 ? rounded : 1
  }
  return null
}

/**
 * 依據原價套用選填之服務費 % 與刷卡手續費 %（兩者可獨立套用或依序疊加），
 * 並按目標幣別小數位數四捨五入，確保反覆切換 % 數時永遠從原價精準重算。
 */
export function applyPercentFees(
  baseAmount: number,
  serviceFeePercent: number | null,
  fxFeePercent: number | null,
  decimals = 0,
): number {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return 0
  let total = baseAmount
  if (
    typeof serviceFeePercent === 'number' &&
    Number.isFinite(serviceFeePercent) &&
    serviceFeePercent > 0
  ) {
    total *= 1 + serviceFeePercent / 100
  }
  if (
    typeof fxFeePercent === 'number' &&
    Number.isFinite(fxFeePercent) &&
    fxFeePercent > 0
  ) {
    total *= 1 + fxFeePercent / 100
  }
  const factor = 10 ** Math.max(0, decimals)
  return Math.round(total * factor) / factor
}

/**
 * 計算兩項百分比依商業複利依序疊加後的有效總加成百分比
 * 例如：服務費 10% ＋ 泰國 VAT 7% ➔ (1.10 × 1.07 - 1) × 100 = 17.7%
 */
export function computeEffectiveCompoundFeePercent(
  serviceFeePercent: number | null,
  fxFeePercent: number | null,
): number {
  let multiplier = 1
  if (
    typeof serviceFeePercent === 'number' &&
    Number.isFinite(serviceFeePercent) &&
    serviceFeePercent > 0
  ) {
    multiplier *= 1 + serviceFeePercent / 100
  }
  if (
    typeof fxFeePercent === 'number' &&
    Number.isFinite(fxFeePercent) &&
    fxFeePercent > 0
  ) {
    multiplier *= 1 + fxFeePercent / 100
  }
  return Number(((multiplier - 1) * 100).toFixed(2))
}

export function getTodayIso(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getCurrentTimeHHmm(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/** 萬用日期比對：搜尋輸入中的 "-"、"/"、"."、全形符號與不補零日期全部通用 */
export function matchesDateQuery(isoDate: string, rawQuery: string): boolean {
  const normalizedQuery = rawQuery
    .trim()
    .toLowerCase()
    .replace(/[/.．／－]/g, '-')

  if (!normalizedQuery) return false

  const [y = '', m = '', d = ''] = isoDate.split('-')
  const mNoZero = m ? String(Number(m)) : ''
  const dNoZero = d ? String(Number(d)) : ''

  const variants = [
    isoDate,
    `${y}-${mNoZero}-${dNoZero}`,
    `${m}-${d}`,
    `${mNoZero}-${dNoZero}`,
    `${y}${m}${d}`,
    `${m}${d}`,
  ]

  return variants.some((variant) => variant.toLowerCase().includes(normalizedQuery))
}

/** 清理檔名中的不安全字元（供匯出 JSON / CSV 使用） */
export function sanitizeExportFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 48)
  return cleaned || 'clearbill-project'
}

/**
 * 依字形叢集（Grapheme Cluster）安全拆字，避免將 Emoji（如 😀、🇯🇵、👨‍👩‍👧）劈成破圖亂碼
 */
export function splitGraphemes(text: string): string[] {
  if (!text) return []
  try {
    const IntlWithSeg = Intl as unknown as {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
      ) => { segment(input: string): Iterable<{ segment: string }> }
    }
    if (typeof IntlWithSeg.Segmenter === 'function') {
      const seg = new IntlWithSeg.Segmenter(undefined, { granularity: 'grapheme' })
      return Array.from(seg.segment(text), (item) => item.segment)
    }
  } catch {
    // 降級為 code point 拆字
  }
  return Array.from(text)
}

/**
 * 取得字串第一個完整字形叢集（供頭像縮寫使用，完整支援 Emoji 與多碼點字元）
 */
export function getFirstGrapheme(text: string, fallback = '?'): string {
  const trimmed = text.trim()
  if (!trimmed) return fallback
  const first = splitGraphemes(trimmed)[0]
  return first ? first.toUpperCase() : fallback
}

/**
 * 產生排序後的幣別下拉選單清單與標記文字：
 * 1. 記帳幣別固定列第一項並標記
 * 2. 結帳幣別（若與記帳幣別不同）固定列第二項並標記
 * 3. 其餘保留目前選中幣別與常用幣別清單
 */
export function buildOrderedCurrencyOptions(params: {
  baseCurrency: string
  settlementCurrency: string
  availableCurrencies: string[]
  extraCurrencies?: Array<string | null | undefined>
  tags: {
    base: string
    settlement: string
    both: string
  }
}): { currencies: string[]; labels: Record<string, string> } {
  const baseCur = params.baseCurrency.trim().toUpperCase()
  const settleCur = params.settlementCurrency.trim().toUpperCase() || baseCur
  const currencies: string[] = []

  const pushUnique = (code: string | null | undefined) => {
    if (!code) return
    const normalized = code.trim().toUpperCase()
    if (normalized && !currencies.includes(normalized)) {
      currencies.push(normalized)
    }
  }

  pushUnique(baseCur)
  pushUnique(settleCur)
  for (const extra of params.extraCurrencies ?? []) {
    pushUnique(extra)
  }
  for (const code of params.availableCurrencies) {
    pushUnique(code)
  }

  const labels: Record<string, string> = {}
  for (const code of currencies) {
    if (code === baseCur && code === settleCur) {
      labels[code] = `${code} · ${params.tags.both}`
    } else if (code === baseCur) {
      labels[code] = `${code} · ${params.tags.base}`
    } else if (code === settleCur) {
      labels[code] = `${code} · ${params.tags.settlement}`
    } else {
      labels[code] = code
    }
  }

  return { currencies, labels }
}

/** 依目前日期產生緊湊標題列日期膠囊文字（今年省去年份避免標題列擁擠） */
export function formatCompactHeaderDate(
  isoDate: string,
  todayIso: string,
  todayLabel: string,
  time?: string,
): string {
  const trimmedTime = time?.trim() && time.trim() !== '00:00' ? time.trim() : ''
  if (!isoDate || isoDate === todayIso) {
    return trimmedTime ? `${todayLabel} ${trimmedTime}` : todayLabel
  }
  const todayYear = todayIso.slice(0, 4)
  const parts = isoDate.split('-')
  const dateLabel =
    parts.length === 3 && parts[0] === todayYear
      ? `${parts[1]}/${parts[2]}`
      : isoDate.replace(/-/g, '/')
  return trimmedTime ? `${dateLabel} ${trimmedTime}` : dateLabel
}
