import {
  QuickIntakeParamsSchema,
  type Project,
  type QuickIntakeParams,
  type SplitConfig,
} from '@/schemas/ledgerSchema'
import { calculateSplit } from '@/core/splitCalculator'

export interface ParsedQuickIntakeResult {
  amount: number | null
  currency: string
  merchant: string
  sourceApp: string
  sanitizedNote: string
  date: string
  time: string
  links: string[]
  projectId?: string
  defaultSplitConfig?: SplitConfig
}

const CURRENCY_SYMBOL_TO_ISO: Array<{ pattern: RegExp; currency: string }> = [
  { pattern: /\b(?:NT\$|NTD|TWD)\b|新台幣|台幣|NT\$/i, currency: 'TWD' },
  { pattern: /\b(?:JPY|JP¥)\b|日圓|日幣|¥|￥/i, currency: 'JPY' },
  { pattern: /\b(?:USD|US\$)\b|美金|美元|US\$/i, currency: 'USD' },
  { pattern: /\b(?:KRW)\b|韓元|韓幣|₩/i, currency: 'KRW' },
  { pattern: /\b(?:EUR)\b|歐元|€/i, currency: 'EUR' },
  { pattern: /\b(?:HKD|HK\$)\b|港幣|HK\$/i, currency: 'HKD' },
  { pattern: /\b(?:GBP)\b|英鎊|£/i, currency: 'GBP' },
]

/**
 * 對剪貼簿或通知原始文字進行敏感資訊脫敏：
 * - 遮罩完整卡號、卡號末四碼、台灣身分證字號、手機號碼、OTP 驗證碼、銀行帳號
 */
export function sanitizeNotificationText(rawText: string): string {
  let text = rawText.trim()
  if (!text) return ''

  // 1. 遮罩 13~19 碼信用卡號（允許空白或連字號）
  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_CARD]')

  // 2. 遮罩卡號末四碼（如：卡號末四碼1234、卡號*1234、尾號 5678、ending in 4321）
  text = text.replace(
    /(卡號(?:末四碼|後四碼|尾號|\*{1,4})?|尾號|末四碼|ending in)\s*[:：]?\s*\*?(\d{4})\b/gi,
    '$1****',
  )

  // 3. 遮罩台灣身分證字號（1 碼大寫英文字母 + 9 碼數字）
  text = text.replace(/\b[A-Z][12]\d{8}\b/g, '[REDACTED_ID]')

  // 4. 遮罩手機號碼（09xx-xxx-xxx 或 09xxxxxxxx）
  text = text.replace(/\b09\d{2}[- ]?\d{3}[- ]?\d{3}\b/g, '[REDACTED_PHONE]')

  // 5. 遮罩 OTP / 動態驗證碼
  text = text.replace(
    /((?:驗證碼|動態密碼|OTP|一次性密碼)\s*[:：為是]?\s*)\d{4,8}\b/gi,
    '$1******',
  )

  // 6. 遮罩帳號資訊
  text = text.replace(
    /((?:帳號|帳戶)\s*[:：]?\s*)[\d-]{8,18}\b/gi,
    '$1[REDACTED_ACCOUNT]',
  )

  // 7. 移除餘額與可用額度敏感數字描述
  text = text.replace(
    /((?:可用餘額|剩餘額度|帳戶餘額|餘額)\s*[:：]?\s*(?:NT\$|TWD|NTD|USD|JPY|\$)?\s*)[\d,]+(?:\.\d{1,2})?/gi,
    '$1[REDACTED_BALANCE]',
  )

  return text.replace(/\s+/g, ' ').trim()
}

function parseNumericAmount(raw: string | number | undefined): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null
  }
  if (typeof raw !== 'string') return null

  const cleaned = raw.replace(/[,\s]/g, '').replace(/^(?:NT\$|US\$|HK\$|JP¥|TWD|NTD|JPY|USD|KRW|EUR|[$¥￥₩€£])/i, '')
  if (!cleaned) return null

  const num = Number(cleaned)
  return Number.isFinite(num) && num >= 0 ? num : null
}

function detectCurrency(text: string, fallbackCurrency: string): string {
  for (const rule of CURRENCY_SYMBOL_TO_ISO) {
    if (rule.pattern.test(text)) {
      return rule.currency
    }
  }
  return fallbackCurrency.toUpperCase()
}

function extractAmountFromText(sanitizedText: string): number | null {
  if (!sanitizedText) return null

  // 優先匹配帶有「消費/付款/刷卡/Paid/Charged/金額」語意前綴的金額
  const contextualPatterns = [
    /(?:消費金額|刷卡金額|交易金額|付款金額|實付金額|消費|刷卡|付款完成|付款|支出|Paid|Charged|Spent)\s*[:：]?\s*(?:NT\$|US\$|HK\$|JP¥|TWD|NTD|JPY|USD|KRW|EUR|[$¥￥₩€£])?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:NT\$|US\$|HK\$|JP¥|TWD|NTD|JPY|USD|KRW|EUR|[$¥￥₩€£])\s*([\d,]+(?:\.\d{1,2})?)/i,
    /([\d,]+(?:\.\d{1,2})?)\s*(?:元|圓|円|塊|TWD|NTD|JPY|USD|KRW|EUR)/i,
  ]

  for (const pattern of contextualPatterns) {
    const match = sanitizedText.match(pattern)
    if (match?.[1]) {
      const value = parseNumericAmount(match[1])
      if (value !== null && value > 0) {
        return value
      }
    }
  }

  return null
}

function extractMerchantFromText(sanitizedText: string): string {
  if (!sanitizedText) return ''

  // 移除網址以免誤判為商家名稱
  const withoutUrls = sanitizedText.replace(/https?:\/\/\S+/gi, ' ').trim()

  const merchantPatterns = [
    /(?:特店名稱|特約商店|消費商店|特店|商店|商家|門市|通路)\s*[:：]\s*([^\s,，。；;]+)/i,
    /(?:特店名稱|特約商店|消費商店|特店|商店|商家)\s+([^\s,，。；;]+)/i,
    /\bat\s+([A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff &'._-]{1,40}?)(?:[.,;!?]|$|\s+on\s|\s+via\s)/i,
    /(?:付款完成|消費)\s*(?:NT\$|US\$|TWD|JPY|[$¥￥])?\s*[\d,]+(?:\.\d{1,2})?\s*元?\s+([^\s,，。；;]{2,30})/i,
  ]

  for (const pattern of merchantPatterns) {
    const match = withoutUrls.match(pattern)
    if (match?.[1]) {
      return match[1].trim()
    }
  }

  return ''
}

function extractLinks(sourceUrl: string | undefined, rawText: string): string[] {
  const candidates: string[] = []
  if (sourceUrl) {
    candidates.push(sourceUrl.trim())
  }
  const urlMatches = rawText.match(/https?:\/\/[^\s"'<>）)]+/gi) ?? []
  candidates.push(...urlMatches)

  const uniqueValidUrls: string[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const href = parsed.toString()
        if (!seen.has(href)) {
          seen.add(href)
          uniqueValidUrls.push(href)
        }
      }
    } catch {
      // 忽略無效網址
    }
    if (uniqueValidUrls.length >= 3) {
      break
    }
  }

  return uniqueValidUrls
}

function extractTime(rawText: string, explicitTime?: string): string {
  const timeRegex = /\b([01]\d|2[0-3]):([0-5]\d)\b/
  const explicitMatch = explicitTime?.trim().match(timeRegex)
  if (explicitMatch) {
    return explicitMatch[0]
  }
  const match = rawText.match(timeRegex)
  if (match) {
    return match[0]
  }
  // 規格鐵律：未指定時間一律預設 '00:00'
  return '00:00'
}

function formatTodayDate(referenceDate: Date): string {
  const year = referenceDate.getFullYear()
  const month = String(referenceDate.getMonth() + 1).padStart(2, '0')
  const day = String(referenceDate.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function extractDate(
  rawText: string,
  explicitDate: string | undefined,
  referenceDate: Date,
): string {
  const isoRegex = /\b(\d{4})[-/](\d{2})[-/](\d{2})\b/
  const explicitMatch = explicitDate?.trim().match(isoRegex)
  if (explicitMatch) {
    const [, y, m, d] = explicitMatch
    return `${y}-${m}-${d}`
  }

  const fullMatch = rawText.match(isoRegex)
  if (fullMatch) {
    return `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]}`
  }

  const shortMatch = rawText.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\b/)
  if (shortMatch) {
    const year = referenceDate.getFullYear()
    const month = shortMatch[1].padStart(2, '0')
    const day = shortMatch[2].padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  return formatTodayDate(referenceDate)
}

/**
 * 從完整 URL、hash 路由（/#/quick-add?...）或純查詢字串中擷取並驗證參數
 */
export function parseQuickIntakeUrl(urlOrHash: string): QuickIntakeParams {
  const trimmed = urlOrHash.trim()
  let queryString = ''

  if (trimmed.includes('?')) {
    const hashIndex = trimmed.indexOf('#')
    if (hashIndex !== -1) {
      const hashPart = trimmed.slice(hashIndex + 1)
      const qIndex = hashPart.indexOf('?')
      if (qIndex !== -1) {
        queryString = hashPart.slice(qIndex + 1)
      }
    }
    if (!queryString) {
      const qIndex = trimmed.indexOf('?')
      const afterQ = trimmed.slice(qIndex + 1)
      const trailingHash = afterQ.indexOf('#')
      queryString = trailingHash === -1 ? afterQ : afterQ.slice(0, trailingHash)
    }
  } else if (trimmed.includes('=')) {
    queryString = trimmed.replace(/^[?#]/, '')
  }

  const searchParams = new URLSearchParams(queryString)
  const rawParams: Record<string, string> = {}

  const allowedKeys = [
    'amount',
    'merchant',
    'sourceApp',
    'rawText',
    'currency',
    'sourceUrl',
    'categoryKey',
    'date',
    'time',
  ] as const

  for (const key of allowedKeys) {
    const value = searchParams.get(key)
    if (value !== null && value.trim() !== '') {
      rawParams[key] = value
    }
  }

  // 所有外部輸入皆強制通過 Zod 驗證
  return QuickIntakeParamsSchema.parse(rawParams)
}

export interface QuickIntakeOptions {
  activeProject?: Project | null
  defaultCurrency?: string
  referenceDate?: Date
}

/**
 * 無感自動化入口解析主函式
 * - 接受 iOS 捷徑 URL 字串或已拆解的 QuickIntakeParams 物件
 * - 自動脫敏剪貼簿/刷卡通知並提取金額、幣別、商家、日期與時間
 * - 若存在進行中旅遊/分帳專案，自動歸入該專案並套用專案預設拆帳規則
 */
export function parseQuickIntake(
  input: string | QuickIntakeParams,
  options: QuickIntakeOptions = {},
): ParsedQuickIntakeResult {
  const params =
    typeof input === 'string'
      ? parseQuickIntakeUrl(input)
      : QuickIntakeParamsSchema.parse(input)

  const referenceDate = options.referenceDate ?? new Date()
  const activeProject =
    options.activeProject && options.activeProject.isActive && !options.activeProject.isDeleted
      ? options.activeProject
      : null

  const fallbackCurrency = activeProject?.baseCurrency ?? options.defaultCurrency ?? 'TWD'

  const rawText = params.rawText ?? ''
  const sanitizedNote = sanitizeNotificationText(rawText)

  const explicitAmount = parseNumericAmount(params.amount)
  const parsedAmount = explicitAmount ?? extractAmountFromText(sanitizedNote)

  const currencyHint = `${params.currency ?? ''} ${typeof params.amount === 'string' ? params.amount : ''} ${sanitizedNote}`
  const explicitCurrencyValid =
    params.currency && /^[A-Za-z]{3}$/.test(params.currency.trim())
      ? params.currency.trim().toUpperCase()
      : null
  const currency = explicitCurrencyValid ?? detectCurrency(currencyHint, fallbackCurrency)

  const merchant =
    params.merchant?.trim() ||
    extractMerchantFromText(sanitizedNote) ||
    ''

  const sourceApp = params.sourceApp?.trim() || 'manual'
  const date = extractDate(rawText, params.date, referenceDate)
  const time = extractTime(rawText, params.time)
  const links = extractLinks(params.sourceUrl, rawText)

  let projectId: string | undefined
  let defaultSplitConfig: SplitConfig | undefined

  if (activeProject) {
    projectId = activeProject.id

    if (parsedAmount !== null && parsedAmount > 0 && activeProject.members.length > 0) {
      const payerId =
        activeProject.defaultPayerId &&
        activeProject.members.some((m) => m.id === activeProject.defaultPayerId)
          ? activeProject.defaultPayerId
          : activeProject.members[0].id

      const humanMembers = activeProject.members.filter((m) => !m.isPool)
      const splitMembers =
        humanMembers.length > 0 ? humanMembers : activeProject.members
      const effectiveMode =
        activeProject.defaultSplitMode === 'percentage'
          ? 'equal'
          : activeProject.defaultSplitMode

      const splitResult = calculateSplit({
        totalAmount: parsedAmount,
        currency,
        mode: effectiveMode,
        members: splitMembers.map((member) => ({
          memberId: member.id,
          customAmount: 0,
          isIncludedInRemainder: true,
        })),
      })

      defaultSplitConfig = {
        payerId,
        mode: effectiveMode,
        shares: splitResult.shares.map((share) => ({
          memberId: share.memberId,
          finalAmount: share.finalAmount,
        })),
      }
    }
  }

  return {
    amount: parsedAmount,
    currency,
    merchant,
    sourceApp,
    sanitizedNote,
    date,
    time,
    links,
    projectId,
    defaultSplitConfig,
  }
}
