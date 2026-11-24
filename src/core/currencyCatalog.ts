export interface CurrencyCatalogItem {
  code: string
  symbol: string
  names: {
    'zh-TW': string
    en: string
    ja: string
  }
}

/** 常用世界 ISO 4217 幣別目錄（供設定頁搜尋與新增使用） */
export const CURRENCY_CATALOG: CurrencyCatalogItem[] = [
  { code: 'TWD', symbol: 'NT$', names: { 'zh-TW': '新台幣', en: 'Taiwan Dollar', ja: '台湾ドル' } },
  { code: 'JPY', symbol: '¥', names: { 'zh-TW': '日圓', en: 'Japanese Yen', ja: '日本円' } },
  { code: 'USD', symbol: '$', names: { 'zh-TW': '美元', en: 'US Dollar', ja: '米ドル' } },
  { code: 'KRW', symbol: '₩', names: { 'zh-TW': '韓元', en: 'Korean Won', ja: '韓国ウォン' } },
  { code: 'EUR', symbol: '€', names: { 'zh-TW': '歐元', en: 'Euro', ja: 'ユーロ' } },
  { code: 'HKD', symbol: 'HK$', names: { 'zh-TW': '港幣', en: 'Hong Kong Dollar', ja: '香港ドル' } },
  { code: 'GBP', symbol: '£', names: { 'zh-TW': '英鎊', en: 'British Pound', ja: '英ポンド' } },
  { code: 'AUD', symbol: 'A$', names: { 'zh-TW': '澳幣', en: 'Australian Dollar', ja: '豪ドル' } },
  { code: 'CAD', symbol: 'C$', names: { 'zh-TW': '加幣', en: 'Canadian Dollar', ja: 'カナダドル' } },
  { code: 'SGD', symbol: 'S$', names: { 'zh-TW': '新加坡幣', en: 'Singapore Dollar', ja: 'シンガポールドル' } },
  { code: 'CNY', symbol: '¥', names: { 'zh-TW': '人民幣', en: 'Chinese Yuan', ja: '人民元' } },
  { code: 'THB', symbol: '฿', names: { 'zh-TW': '泰銖', en: 'Thai Baht', ja: 'タイバーツ' } },
  { code: 'VND', symbol: '₫', names: { 'zh-TW': '越南盾', en: 'Vietnamese Dong', ja: 'ベトナムドン' } },
  { code: 'MYR', symbol: 'RM', names: { 'zh-TW': '馬來西亞令吉', en: 'Malaysian Ringgit', ja: 'マレーシアリンギット' } },
  { code: 'PHP', symbol: '₱', names: { 'zh-TW': '菲律賓披索', en: 'Philippine Peso', ja: 'フィリピンペソ' } },
  { code: 'IDR', symbol: 'Rp', names: { 'zh-TW': '印尼盾', en: 'Indonesian Rupiah', ja: 'インドネシアルピア' } },
  { code: 'NZD', symbol: 'NZ$', names: { 'zh-TW': '紐西蘭幣', en: 'New Zealand Dollar', ja: 'ニュージーランドドル' } },
  { code: 'CHF', symbol: 'CHF', names: { 'zh-TW': '瑞士法郎', en: 'Swiss Franc', ja: 'スイスフラン' } },
  { code: 'MOP', symbol: 'MOP$', names: { 'zh-TW': '澳門幣', en: 'Macanese Pataca', ja: 'マカオパタカ' } },
  { code: 'INR', symbol: '₹', names: { 'zh-TW': '印度盧比', en: 'Indian Rupee', ja: 'インドルピー' } },
  { code: 'SEK', symbol: 'kr', names: { 'zh-TW': '瑞典克朗', en: 'Swedish Krona', ja: 'スウェーデンクローナ' } },
  { code: 'NOK', symbol: 'kr', names: { 'zh-TW': '挪威克朗', en: 'Norwegian Krone', ja: 'ノルウェークローネ' } },
  { code: 'MXN', symbol: 'MX$', names: { 'zh-TW': '墨西哥披索', en: 'Mexican Peso', ja: 'メキシコペソ' } },
  { code: 'TRY', symbol: '₺', names: { 'zh-TW': '土耳其里拉', en: 'Turkish Lira', ja: 'トルコリラ' } },
]

/**
 * 依代碼或任一語系名稱模糊搜尋幣別清單
 */
export function searchCurrencyCatalog(
  query: string,
  excludeCodes: string[] = [],
): CurrencyCatalogItem[] {
  const excluded = new Set(excludeCodes.map((c) => c.toUpperCase()))
  const normalized = query.trim().toLowerCase()

  return CURRENCY_CATALOG.filter((item) => {
    if (excluded.has(item.code)) return false
    if (!normalized) return true
    return (
      item.code.toLowerCase().includes(normalized) ||
      item.symbol.toLowerCase().includes(normalized) ||
      item.names['zh-TW'].toLowerCase().includes(normalized) ||
      item.names.en.toLowerCase().includes(normalized) ||
      item.names.ja.toLowerCase().includes(normalized)
    )
  })
}
