/**
 * 免費公開即時匯率快取服務（Local-First 離線降級設計）：
 * - 連網時每小時自動從免費公開匯率資料庫抓取最新匯率，並快取於 localStorage
 * - 多重免費備援（open.er-api.com -> fawazahmed0 currency-api CDN -> frankfurter.app）
 * - 離線或請求失敗時靜默退回最近快取匯率，絕不阻塞操作
 */

const LIVE_RATES_STORAGE_KEY = 'clearbill_live_rates_v1'
/** 每小時自動重新抓取一次最新免費即時匯率 */
export const LIVE_RATES_CACHE_TTL_MS = 60 * 60 * 1000

export interface LiveRatesCache {
  /** 以 USD 為基準（1 USD = N 該幣別）的匯率表 */
  ratesPerUsd: Record<string, number>
  fetchedAt: number
  source: string
}

let memoryCache: LiveRatesCache | null = null
let inFlightPromise: Promise<LiveRatesCache | null> | null = null

export function loadCachedLiveRates(): LiveRatesCache | null {
  if (memoryCache) return memoryCache
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LIVE_RATES_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LiveRatesCache>
    if (
      parsed &&
      typeof parsed.fetchedAt === 'number' &&
      parsed.ratesPerUsd &&
      typeof parsed.ratesPerUsd === 'object'
    ) {
      memoryCache = {
        ratesPerUsd: parsed.ratesPerUsd,
        fetchedAt: parsed.fetchedAt,
        source: typeof parsed.source === 'string' ? parsed.source : 'cache',
      }
      return memoryCache
    }
  } catch {
    // 忽略儲存受限環境
  }
  return null
}

function saveLiveRatesCache(cache: LiveRatesCache): void {
  memoryCache = cache
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LIVE_RATES_STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // 忽略儲存受限環境
  }
}

/**
 * 依據 USD 基準匯率表計算任意兩幣別換算率（1 from = ? to）
 */
export function computeCrossRateFromUsdTable(
  ratesPerUsd: Record<string, number>,
  from: string,
  to: string,
): number | null {
  const f = from.trim().toUpperCase()
  const t = to.trim().toUpperCase()
  if (!f || !t) return null
  if (f === t) return 1

  const fromPerUsd = f === 'USD' ? 1 : ratesPerUsd[f]
  const toPerUsd = t === 'USD' ? 1 : ratesPerUsd[t]
  if (
    typeof fromPerUsd !== 'number' ||
    typeof toPerUsd !== 'number' ||
    !Number.isFinite(fromPerUsd) ||
    !Number.isFinite(toPerUsd) ||
    fromPerUsd <= 0 ||
    toPerUsd <= 0
  ) {
    return null
  }

  const rawRate = toPerUsd / fromPerUsd
  if (!Number.isFinite(rawRate) || rawRate <= 0) return null
  // 針對 VND / IDR 對 USD / EUR 等極小匯率（< 0.01）保留 6 位有效數字，避免四捨五入歸零或大幅失真
  const rounded =
    rawRate < 0.01 ? Number(rawRate.toPrecision(6)) : Number(rawRate.toFixed(4))
  if (!Number.isFinite(rounded) || rounded <= 0) return null
  return rounded
}

/**
 * 從已快取的即時匯率表查詢任意兩幣別換算率（離線亦可使用最近快取）
 */
export function getCachedLiveExchangeRate(
  from: string,
  to: string,
): { rate: number; fetchedAt: number; source: string } | null {
  const cache = loadCachedLiveRates()
  if (!cache) return null
  const rate = computeCrossRateFromUsdTable(cache.ratesPerUsd, from, to)
  if (rate === null) return null
  return { rate, fetchedAt: cache.fetchedAt, source: cache.source }
}

async function fetchFromOpenErApi(): Promise<LiveRatesCache | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      result?: string
      rates?: Record<string, number>
    }
    if (
      data.rates &&
      typeof data.rates === 'object' &&
      Object.keys(data.rates).length > 10
    ) {
      return {
        ratesPerUsd: { ...data.rates, USD: 1 },
        fetchedAt: Date.now(),
        source: 'open.er-api.com',
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchFromFawazCurrencyApi(): Promise<LiveRatesCache | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      { signal: controller.signal },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      usd?: Record<string, number>
    }
    if (!data.usd || typeof data.usd !== 'object') return null
    const normalized: Record<string, number> = { USD: 1 }
    for (const [k, v] of Object.entries(data.usd)) {
      if (/^[a-z]{3}$/i.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) {
        normalized[k.toUpperCase()] = v
      }
    }
    if (Object.keys(normalized).length > 10) {
      return {
        ratesPerUsd: normalized,
        fetchedAt: Date.now(),
        source: 'currency-api',
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchFromFrankfurter(): Promise<LiveRatesCache | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD', {
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      rates?: Record<string, number>
    }
    if (
      data.rates &&
      typeof data.rates === 'object' &&
      Object.keys(data.rates).length > 10
    ) {
      return {
        ratesPerUsd: { ...data.rates, USD: 1 },
        fetchedAt: Date.now(),
        source: 'frankfurter.app',
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 連網靜默更新即時參考匯率（預設每小時快取一次；force=true 時強制重抓）
 */
export async function refreshLiveExchangeRates(
  force = false,
): Promise<LiveRatesCache | null> {
  const existing = loadCachedLiveRates()
  if (!force && existing && Date.now() - existing.fetchedAt < LIVE_RATES_CACHE_TTL_MS) {
    return existing
  }
  if (typeof fetch === 'undefined') return existing
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return existing
  }

  if (inFlightPromise) return inFlightPromise

  inFlightPromise = (async () => {
    const primary = await fetchFromOpenErApi()
    const secondary = primary ?? (await fetchFromFawazCurrencyApi())
    const fresh = secondary ?? (await fetchFromFrankfurter())
    if (fresh) {
      saveLiveRatesCache(fresh)
      return fresh
    }
    return existing
  })().finally(() => {
    inFlightPromise = null
  })

  return inFlightPromise
}
