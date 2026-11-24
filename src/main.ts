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

registerSW({ immediate: true })
void requestPersistentStorage()

app.mount('#app')
