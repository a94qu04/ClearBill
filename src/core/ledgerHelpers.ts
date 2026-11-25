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
}

export function getSuggestedExchangeRate(from: string, to: string): number {
  const f = from.toUpperCase()
  const tCode = to.toUpperCase()
  if (f === tCode) return 1
  const fromInTwd = APPROX_RATE_TO_TWD[f]
  const toInTwd = APPROX_RATE_TO_TWD[tCode]
  if (fromInTwd && toInTwd) {
    return Number((fromInTwd / toInTwd).toFixed(4))
  }
  return 1
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

/** 觸發瀏覽器下載文字內容檔案 */
export function triggerTextFileDownload(
  content: string,
  filename: string,
  mimeType: string,
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  const blob = new Blob([content], { type: mimeType })
  triggerBinaryFileDownload(blob, filename, mimeType)
}

/** 觸發瀏覽器下載二進位檔案（如 .xlsx 或 .png） */
export function triggerBinaryFileDownload(
  data: Uint8Array | Blob,
  filename: string,
  mimeType: string,
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data.slice().buffer], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
