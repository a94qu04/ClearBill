import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
import App from '@/App.vue'
import { i18n } from '@/i18n'
import { useLedgerStore } from '@/stores/ledgerStore'
import '@/style.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)

// PWA 離線優先：啟動時靜默申請持久化儲存空間，避免系統自動清除 IndexedDB 快取
async function requestPersistentStorage(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return
  }
  try {
    const alreadyPersisted = await navigator.storage.persisted()
    const persisted = alreadyPersisted || (await navigator.storage.persist())
    const store = useLedgerStore(pinia)
    store.setStoragePersisted(persisted)
  } catch {
    // 瀏覽器不支援或拒絕時維持靜默降級
  }
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller)
  let reloadedForSwUpdate = false
  let pendingReloadForSwUpdate = false

  const isUserEditingForm = (): boolean => {
    if (typeof document === 'undefined') return false
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
      return true
    }
    const active = document.activeElement
    if (
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT')
    ) {
      return true
    }
    return false
  }

  const tryDeferredSwReload = () => {
    if (!pendingReloadForSwUpdate || reloadedForSwUpdate) return
    if (isUserEditingForm()) return
    reloadedForSwUpdate = true
    pendingReloadForSwUpdate = false
    window.location.reload()
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadedForSwUpdate) return
    pendingReloadForSwUpdate = true
    if (!isUserEditingForm()) {
      tryDeferredSwReload()
      return
    }
    // 使用者正在填寫表單或開啟彈窗時延後重整，待離開輸入或切回前景後再無縫套用新版
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        tryDeferredSwReload()
      }
    })
    window.addEventListener('focusout', () => {
      setTimeout(tryDeferredSwReload, 400)
    })
  })
}

registerSW({ immediate: true })
void requestPersistentStorage()

app.mount('#app')
