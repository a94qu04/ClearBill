import { onBeforeUnmount, onMounted, ref } from 'vue'
import { detectInAppBrowser } from '@/core/inAppBrowser'
import { useLedgerStore } from '@/stores/ledgerStore'

export interface UsePwaLifecycleOptions {
  /** IndexedDB 初始化並啟動背景同步後呼叫（通常用於處理初次 Hash 路由） */
  onReady?: () => void
}

/**
 * 管理 App 的主題切換、裝置觸控偵測、內建瀏覽器提醒、
 * PWA 線上／前景喚醒同步、每小時匯率刷新與 IndexedDB 啟動流程。
 */
export function usePwaLifecycle(options: UsePwaLifecycleOptions = {}) {
  const store = useLedgerStore()

  const isDark = ref(false)
  const isTouchDevice = ref(false)
  const inAppBrowser = ref(detectInAppBrowser())
  const inAppBannerDismissed = ref(false)

  let hourlyRatesTimer: ReturnType<typeof setInterval> | null = null

  function syncThemeToDom(dark: boolean) {
    if (typeof document === 'undefined') return
    document.documentElement.classList.toggle('dark', dark)
    const themeMeta = document.querySelector('meta[name="theme-color"]')
    if (themeMeta) {
      themeMeta.setAttribute('content', dark ? '#000000' : '#F2F2F7')
    }
  }

  function initTheme() {
    if (typeof window === 'undefined') return
    const saved = window.localStorage.getItem('clearbill_theme')
    if (saved === 'dark' || saved === 'light') {
      isDark.value = saved === 'dark'
    } else {
      isDark.value = document.documentElement.classList.contains('dark')
    }
    syncThemeToDom(isDark.value)
  }

  function setTheme(dark: boolean) {
    isDark.value = dark
    syncThemeToDom(dark)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('clearbill_theme', dark ? 'dark' : 'light')
    }
  }

  function detectTouchDevice() {
    if (typeof window === 'undefined') return
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
    const touchPoints = navigator.maxTouchPoints ?? 0
    isTouchDevice.value = coarsePointer || touchPoints > 0
  }

  function handleNetworkOnline() {
    void store.startAllSharedProjectListeners()
    void store.flushAllSharedProjectsOutbox()
    void store.tryBackgroundGoogleDriveSync(true)
    void store.refreshExchangeRates(false)
  }

  function handleVisibilityChange() {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void store.tryBackgroundGoogleDriveSync(false)
      void store.refreshExchangeRates(false)
    }
  }

  onMounted(async () => {
    initTheme()
    detectTouchDevice()
    void store.refreshExchangeRates(false)
    if (typeof window !== 'undefined') {
      hourlyRatesTimer = setInterval(() => {
        void store.refreshExchangeRates(false)
      }, store.liveRatesCacheTtlMs)
    }
    await store.initFromIndexedDb()
    void store.startAllSharedProjectListeners()
    void store.flushAllSharedProjectsOutbox()
    void store.tryBackgroundGoogleDriveSync(false)
    options.onReady?.()
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleNetworkOnline)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleNetworkOnline)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    store.stopAllSharedProjectListeners()
    if (hourlyRatesTimer) {
      clearInterval(hourlyRatesTimer)
      hourlyRatesTimer = null
    }
  })

  return {
    isDark,
    setTheme,
    isTouchDevice,
    inAppBrowser,
    inAppBannerDismissed,
  }
}
