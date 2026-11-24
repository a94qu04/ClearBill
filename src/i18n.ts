import { createI18n } from 'vue-i18n'
import zhTW from '@/locales/zh-TW.json'
import en from '@/locales/en.json'
import ja from '@/locales/ja.json'

export type SupportedLocale = 'zh-TW' | 'en' | 'ja'

export const SUPPORTED_LOCALES: Array<{ code: SupportedLocale; label: string }> = [
  { code: 'zh-TW', label: '繁中' },
  { code: 'en', label: 'EN' },
  { code: 'ja', label: '日本語' },
]

function detectInitialLocale(): SupportedLocale {
  if (typeof window === 'undefined') {
    return 'zh-TW'
  }
  const saved = window.localStorage.getItem('clearbill_locale')
  if (saved === 'zh-TW' || saved === 'en' || saved === 'ja') {
    return saved
  }
  const browserLang = window.navigator.language.toLowerCase()
  if (browserLang.startsWith('ja')) return 'ja'
  if (browserLang.startsWith('en')) return 'en'
  return 'zh-TW'
}

export const i18n = createI18n({
  legacy: false,
  locale: detectInitialLocale(),
  fallbackLocale: 'zh-TW',
  messages: {
    'zh-TW': zhTW,
    en,
    ja,
  },
})

export function setAppLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('clearbill_locale', locale)
    document.documentElement.lang = locale === 'zh-TW' ? 'zh-Hant-TW' : locale
  }
}
