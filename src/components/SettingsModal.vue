<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudDownload,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  Loader2,
  Moon,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sun,
  Tag,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-vue-next'
import { SUPPORTED_LOCALES, setAppLocale, type SupportedLocale } from '@/i18n'
import {
  AVATAR_PALETTE,
  useLedgerStore,
  type ManagedCategory,
} from '@/stores/ledgerStore'
import { searchCurrencyCatalog } from '@/core/currencyCatalog'
import { formatCurrencyAmount } from '@/core/currency'
import { getTodayIso } from '@/core/ledgerHelpers'
import {
  disconnectGoogleDrive,
  downloadBackupFromGoogleDrive,
  getBuiltInGoogleClientId,
  getCustomGoogleClientId,
  getLastGoogleSyncAt,
  GoogleDriveSyncError,
  hasBuiltInGoogleClientId,
  isGoogleDriveConnected,
  saveGoogleClientId,
  syncWithGoogleDrive,
} from '@/services/googleDriveSync'

interface Props {
  open: boolean
  isDark: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'setTheme', dark: boolean): void
  (e: 'toast', message: string): void
  (e: 'restored', projectId?: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

type SettingsTab = 'general' | 'categories' | 'currencies' | 'backup' | 'trash'
const activeTab = ref<SettingsTab>('general')

// 分類新增與編輯狀態
const newCategoryName = ref('')
const newCategoryColor = ref<string>(AVATAR_PALETTE[0])
const editingCatKey = ref<string | null>(null)
const editingCatName = ref('')
const editingCatColor = ref<string>(AVATAR_PALETTE[0])

// 幣別搜尋新增狀態
const currencySearchQuery = ref('')

// Google 雲端備份狀態（優先讀取建置期內建 VITE_GOOGLE_CLIENT_ID，使用者無需手動輸入）
const builtInGoogleClientId = getBuiltInGoogleClientId()
const hasBuiltInClientId = hasBuiltInGoogleClientId()
const customGoogleClientId = ref(getCustomGoogleClientId())
const showAdvancedGoogleConfig = ref(false)
const showGoogleGuide = ref(false)
const currentOrigin =
  typeof window !== 'undefined' ? window.location.origin : ''
const googleLastSyncAt = ref<number | null>(getLastGoogleSyncAt())
const googleConnected = ref(isGoogleDriveConnected())
const isGoogleBusy = ref(false)

const effectiveGoogleClientId = computed(
  () => customGoogleClientId.value.trim() || builtInGoogleClientId,
)

const filteredCurrencySuggestions = computed(() =>
  searchCurrencyCatalog(currencySearchQuery.value, store.availableCurrencies),
)

const canAddCustomIsoCode = computed(() => {
  const code = currencySearchQuery.value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return false
  if (store.availableCurrencies.includes(code)) return false
  return !filteredCurrencySuggestions.value.some((item) => item.code === code)
})

const formattedGoogleLastSync = computed(() => {
  if (!googleLastSyncAt.value) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(googleLastSyncAt.value))
  } catch {
    return new Date(googleLastSyncAt.value).toLocaleString()
  }
})

function resolveCategoryDisplayName(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

function getCatalogName(item: {
  names: { 'zh-TW': string; en: string; ja: string }
}): string {
  if (locale.value === 'ja') return item.names.ja
  if (locale.value === 'en') return item.names.en
  return item.names['zh-TW']
}

function handleLocale(code: SupportedLocale) {
  setAppLocale(code)
}

function handleAddCategory() {
  const name = newCategoryName.value.trim()
  if (!name) return
  store.addCategory(name, newCategoryColor.value)
  newCategoryName.value = ''
  emit('toast', t('settings.categoryAddedToast'))
}

function startEditCategory(cat: ManagedCategory) {
  editingCatKey.value = cat.key
  editingCatName.value = resolveCategoryDisplayName(cat)
  editingCatColor.value = cat.color || AVATAR_PALETTE[0]
}

function handleSaveCategoryEdit() {
  if (!editingCatKey.value) return
  const trimmed = editingCatName.value.trim()
  if (!trimmed) return
  store.updateCategory(editingCatKey.value, {
    customLabel: trimmed,
    color: editingCatColor.value,
  })
  editingCatKey.value = null
  emit('toast', t('settings.categoryUpdatedToast'))
}

function handleDeleteCategory(key: string) {
  const ok = store.removeCategory(key)
  if (!ok) {
    emit('toast', t('settings.categoryMinOneError'))
    return
  }
  if (editingCatKey.value === key) {
    editingCatKey.value = null
  }
  emit('toast', t('settings.categoryDeletedToast'))
}

function handleAddCurrency(code: string) {
  try {
    const added = store.addCurrency(code)
    currencySearchQuery.value = ''
    emit('toast', t('settings.currencyAddedToast', { code: added }))
  } catch {
    emit('toast', t('settings.invalidCurrencyCode'))
  }
}

function handleRemoveCurrency(code: string) {
  const ok = store.removeCurrency(code)
  if (!ok) {
    emit('toast', t('settings.cannotDeleteDefaultCurrency'))
    return
  }
  emit('toast', t('settings.currencyRemovedToast', { code }))
}

// ==================== 本地 JSON 備份匯出與合併匯入 ====================
function handleExportLocalJson() {
  const backup = store.exportLedgerBackup()
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `clearbill-backup-${getTodayIso()}.json`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  emit('toast', t('backup.exportedToast'))
}

async function handleImportLocalJson(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  try {
    const text = await file.text()
    const stats = await store.importAndMergeLedgerBackup(text)
    emit(
      'toast',
      t('backup.mergedToast', {
        pAdd: stats.projectsAdded,
        pUpd: stats.projectsUpdated,
        tAdd: stats.transactionsAdded,
        tUpd: stats.transactionsUpdated,
      }),
    )
  } catch {
    emit('toast', t('backup.importError'))
  } finally {
    input.value = ''
  }
}

// ==================== Google 雲端硬碟無損同步（Pull ➔ Merge ➔ Push） ====================
function resolveGoogleErrorReason(err: unknown): string {
  if (err instanceof GoogleDriveSyncError) {
    const key = `backup.errors.${err.code}`
    const translated = t(key)
    return translated === key ? t('backup.errors.ERR_UNKNOWN') : translated
  }
  return t('backup.errors.ERR_UNKNOWN')
}

function handleSaveGoogleClientId() {
  const trimmed = customGoogleClientId.value.trim()
  saveGoogleClientId(trimmed)
  if (!trimmed && hasBuiltInClientId) {
    emit('toast', t('backup.googleResetBuiltInToast'))
    return
  }
  emit('toast', t('backup.googleClientIdSavedToast'))
}

function handleResetBuiltInClientId() {
  customGoogleClientId.value = ''
  saveGoogleClientId('')
  emit('toast', t('backup.googleResetBuiltInToast'))
}

async function handleCopyCurrentOrigin() {
  if (!currentOrigin) return
  try {
    await navigator.clipboard.writeText(currentOrigin)
    emit('toast', t('backup.googleOriginCopiedToast'))
  } catch {
    // 若瀏覽器未授權剪貼簿則忽略
  }
}

async function handleGoogleUpload() {
  const activeClientId = effectiveGoogleClientId.value
  if (!activeClientId) {
    emit('toast', t('backup.googleNeedClientId'))
    return
  }
  if (customGoogleClientId.value.trim()) {
    saveGoogleClientId(customGoogleClientId.value.trim())
  }
  isGoogleBusy.value = true
  try {
    const res = await syncWithGoogleDrive({
      clientId: activeClientId,
      onMergeRemote: (rawJson) => store.importAndMergeLedgerBackup(rawJson),
      getMergedBackup: () => store.exportLedgerBackup(),
    })
    googleLastSyncAt.value = res.syncedAt
    googleConnected.value = isGoogleDriveConnected()

    if (res.hadRemoteFile && res.mergeStats) {
      emit(
        'toast',
        t('backup.googleSyncMergedSuccess', {
          pAdd: res.mergeStats.projectsAdded,
          pUpd: res.mergeStats.projectsUpdated,
          tAdd: res.mergeStats.transactionsAdded,
          tUpd: res.mergeStats.transactionsUpdated,
        }),
      )
    } else {
      emit('toast', t('backup.googleUploadSuccess'))
    }
  } catch (err) {
    emit(
      'toast',
      t('backup.googleSyncError', { reason: resolveGoogleErrorReason(err) }),
    )
  } finally {
    isGoogleBusy.value = false
  }
}

async function handleGoogleDownloadMerge() {
  const activeClientId = effectiveGoogleClientId.value
  if (!activeClientId) {
    emit('toast', t('backup.googleNeedClientId'))
    return
  }
  if (customGoogleClientId.value.trim()) {
    saveGoogleClientId(customGoogleClientId.value.trim())
  }
  isGoogleBusy.value = true
  try {
    const downloaded = await downloadBackupFromGoogleDrive(activeClientId, false)
    if (!downloaded) {
      throw new GoogleDriveSyncError('ERR_DRIVE_NOT_FOUND')
    }
    const stats = await store.importAndMergeLedgerBackup(downloaded.rawJson)
    googleLastSyncAt.value = downloaded.syncedAt
    googleConnected.value = isGoogleDriveConnected()
    emit(
      'toast',
      t('backup.mergedToast', {
        pAdd: stats.projectsAdded,
        pUpd: stats.projectsUpdated,
        tAdd: stats.transactionsAdded,
        tUpd: stats.transactionsUpdated,
      }),
    )
  } catch (err) {
    emit(
      'toast',
      t('backup.googleSyncError', { reason: resolveGoogleErrorReason(err) }),
    )
  } finally {
    isGoogleBusy.value = false
  }
}

function handleGoogleDisconnect() {
  disconnectGoogleDrive()
  googleConnected.value = false
  emit('toast', t('backup.googleDisconnectedToast'))
}

// ==================== 回收桶復原與一鍵清空 ====================
async function handleRestoreTx(id: string) {
  const res = await store.restoreTransaction(id)
  if (res.ok) {
    emit('toast', t('trash.restoredToast'))
    emit('restored', res.projectId)
  }
}

async function handlePermanentDeleteTx(id: string) {
  await store.permanentlyDeleteTransaction(id)
  emit('toast', t('trash.permanentlyDeletedToast'))
}

async function handleEmptyTrash() {
  const count = store.deletedTransactions.length
  if (count === 0) return
  if (
    typeof window !== 'undefined' &&
    !window.confirm(t('trash.emptyAllConfirm', { count }))
  ) {
    return
  }
  const removed = await store.emptyTrash()
  if (removed > 0) {
    emit('toast', t('trash.emptiedToast', { count: removed }))
  }
}

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex justify-start bg-slate-950/50 backdrop-blur-sm"
        @click.self="emit('close')"
      >
        <aside
          class="flex h-full w-full max-w-sm flex-col border-r border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        >
          <!-- 標題列 -->
          <div
            class="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800"
          >
            <div>
              <h2 class="text-base font-bold text-slate-900 dark:text-white">
                {{ t('settings.title') }}
              </h2>
              <p class="text-[11px] text-slate-400">
                {{ t('app.tagline') }}
              </p>
            </div>
            <button
              type="button"
              :aria-label="t('settings.close')"
              class="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              @click="emit('close')"
            >
              <X class="h-5 w-5" />
            </button>
          </div>

          <!-- 五分頁導覽：一般 / 分類 / 幣別 / 備份 / 復原 -->
          <nav
            class="grid grid-cols-5 gap-1 border-b border-slate-100 bg-slate-50 p-1.5 text-[11px] font-semibold dark:border-slate-800 dark:bg-slate-950/60"
          >
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'general'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'general'"
            >
              {{ t('settings.tabGeneral') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'categories'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'categories'"
            >
              {{ t('settings.tabCategories') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'currencies'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'currencies'"
            >
              {{ t('settings.tabCurrencies') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'backup'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'backup'"
            >
              {{ t('settings.tabBackup') }}
            </button>
            <button
              type="button"
              class="relative rounded-lg py-1.5 transition"
              :class="
                activeTab === 'trash'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'trash'"
            >
              <span>{{ t('settings.tabTrash') }}</span>
              <span
                v-if="store.deletedTransactions.length > 0"
                class="ml-0.5 inline-flex h-4 min-w-[14px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white"
              >
                {{ store.deletedTransactions.length }}
              </span>
            </button>
          </nav>

          <!-- 分頁內容區 -->
          <div class="flex-1 overflow-y-auto p-5">
            <!-- 分頁 1：一般（外觀深淺色 ＋ 介面語言） -->
            <div v-if="activeTab === 'general'" class="space-y-6">
              <section>
                <div
                  class="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400"
                >
                  <Palette class="h-3.5 w-3.5" />
                  <span>{{ t('settings.appearance') }}</span>
                </div>
                <div class="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    class="flex items-center justify-center gap-2 rounded-xl border py-3 text-xs font-semibold transition"
                    :class="
                      !isDark
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-200'
                        : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    "
                    @click="emit('setTheme', false)"
                  >
                    <Sun class="h-4 w-4" />
                    <span>{{ t('settings.themeLight') }}</span>
                  </button>
                  <button
                    type="button"
                    class="flex items-center justify-center gap-2 rounded-xl border py-3 text-xs font-semibold transition"
                    :class="
                      isDark
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-200'
                        : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    "
                    @click="emit('setTheme', true)"
                  >
                    <Moon class="h-4 w-4" />
                    <span>{{ t('settings.themeDark') }}</span>
                  </button>
                </div>
              </section>

              <section>
                <div
                  class="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400"
                >
                  <Globe class="h-3.5 w-3.5" />
                  <span>{{ t('settings.language') }}</span>
                </div>
                <div class="grid grid-cols-3 gap-2">
                  <button
                    v-for="item in SUPPORTED_LOCALES"
                    :key="item.code"
                    type="button"
                    class="rounded-xl border py-2.5 text-xs font-semibold transition"
                    :class="
                      locale === item.code
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-200'
                        : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    "
                    @click="handleLocale(item.code)"
                  >
                    {{ item.label }}
                  </button>
                </div>
              </section>
            </div>

            <!-- 分頁 2：消費分類管理 -->
            <div v-else-if="activeTab === 'categories'" class="space-y-4">
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <span
                    class="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400"
                  >
                    <Tag class="h-3.5 w-3.5" />
                    <span>{{ t('settings.customCategories') }}</span>
                  </span>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-emerald-600 dark:text-slate-400"
                    @click="
                      store.resetDefaultCategories();
                      emit('toast', t('settings.categoriesResetToast'))
                    "
                  >
                    <RotateCcw class="h-3 w-3" />
                    <span>{{ t('settings.resetCategories') }}</span>
                  </button>
                </div>

                <div class="flex gap-2">
                  <input
                    v-model="newCategoryName"
                    type="text"
                    maxlength="24"
                    :placeholder="t('settings.addCategoryPlaceholder')"
                    class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                    @keyup.enter="handleAddCategory"
                  />
                  <button
                    type="button"
                    :disabled="!newCategoryName.trim()"
                    class="inline-flex shrink-0 items-center gap-1 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
                    @click="handleAddCategory"
                  >
                    <Plus class="h-3.5 w-3.5" />
                    <span>{{ t('settings.add') }}</span>
                  </button>
                </div>

                <div class="flex items-center gap-1.5">
                  <button
                    v-for="color in AVATAR_PALETTE"
                    :key="color"
                    type="button"
                    class="h-5 w-5 rounded-full transition"
                    :style="{ backgroundColor: color }"
                    :class="
                      newCategoryColor === color
                        ? 'ring-2 ring-slate-900 ring-offset-2 dark:ring-white dark:ring-offset-slate-900'
                        : 'opacity-70 hover:opacity-100'
                    "
                    @click="newCategoryColor = color"
                  />
                </div>
              </div>

              <ul class="divide-y divide-slate-100 dark:divide-slate-800">
                <li
                  v-for="cat in store.categories"
                  :key="cat.key"
                  class="py-2.5"
                >
                  <div
                    v-if="editingCatKey === cat.key"
                    class="space-y-2 rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/70"
                  >
                    <div class="flex gap-1.5">
                      <input
                        v-model="editingCatName"
                        type="text"
                        maxlength="24"
                        class="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                        @keyup.enter="handleSaveCategoryEdit"
                      />
                      <button
                        type="button"
                        class="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white"
                        @click="handleSaveCategoryEdit"
                      >
                        <Check class="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        class="rounded-lg border border-slate-200 px-2 py-1.5 text-slate-500 dark:border-slate-700"
                        @click="editingCatKey = null"
                      >
                        <X class="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <button
                        v-for="color in AVATAR_PALETTE"
                        :key="color"
                        type="button"
                        class="h-4 w-4 rounded-full"
                        :style="{ backgroundColor: color }"
                        :class="
                          editingCatColor === color
                            ? 'ring-2 ring-slate-900 ring-offset-1 dark:ring-white'
                            : 'opacity-70'
                        "
                        @click="editingCatColor = color"
                      />
                    </div>
                  </div>

                  <div v-else class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2.5">
                      <span
                        class="h-3 w-3 rounded-full"
                        :style="{ backgroundColor: cat.color || '#10b981' }"
                      />
                      <span class="text-sm font-medium text-slate-800 dark:text-slate-100">
                        {{ resolveCategoryDisplayName(cat) }}
                      </span>
                    </div>
                    <div class="flex items-center gap-1">
                      <button
                        type="button"
                        :aria-label="t('home.editTx')"
                        class="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/60"
                        @click="startEditCategory(cat)"
                      >
                        <Pencil class="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        :aria-label="t('home.deleteTx')"
                        class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
                        @click="handleDeleteCategory(cat.key)"
                      >
                        <Trash2 class="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </li>
              </ul>
            </div>

            <!-- 分頁 3：幣別管理 -->
            <div v-else-if="activeTab === 'currencies'" class="space-y-5">
              <section>
                <div class="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {{ t('settings.enabledCurrenciesTitle') }}
                </div>
                <p class="mb-2.5 text-[11px] text-slate-400">
                  {{ t('settings.defaultCurrencyHint') }}
                </p>
                <div class="flex flex-wrap gap-2">
                  <div
                    v-for="code in store.availableCurrencies"
                    :key="code"
                    class="inline-flex items-center overflow-hidden rounded-xl border text-xs font-semibold transition"
                    :class="
                      store.defaultCurrency === code
                        ? 'border-emerald-500 bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                        : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                    "
                  >
                    <button
                      type="button"
                      class="px-2.5 py-1.5"
                      @click="store.setDefaultCurrency(code)"
                    >
                      <span>{{ code }}</span>
                      <span
                        v-if="store.defaultCurrency === code"
                        class="ml-1 rounded bg-black/15 px-1 py-0.5 text-[9px]"
                      >
                        {{ t('settings.defaultTag') }}
                      </span>
                    </button>
                    <button
                      v-if="store.defaultCurrency !== code"
                      type="button"
                      :aria-label="t('home.deleteTx')"
                      class="border-l border-slate-200 px-2 py-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                      @click="handleRemoveCurrency(code)"
                    >
                      <X class="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </section>

              <section class="space-y-2.5 border-t border-slate-100 pt-4 dark:border-slate-800">
                <div class="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {{ t('settings.searchCurrencyTitle') }}
                </div>
                <div class="relative">
                  <Search
                    class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    v-model="currencySearchQuery"
                    type="text"
                    :placeholder="t('settings.searchCurrencyPlaceholder')"
                    class="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>

                <button
                  v-if="canAddCustomIsoCode"
                  type="button"
                  class="flex w-full items-center justify-between rounded-xl border border-dashed border-emerald-400 bg-emerald-50/70 px-3 py-2 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
                  @click="handleAddCurrency(currencySearchQuery)"
                >
                  <span>
                    {{
                      t('settings.addCustomCodeDirect', {
                        code: currencySearchQuery.trim().toUpperCase(),
                      })
                    }}
                  </span>
                  <Plus class="h-4 w-4" />
                </button>

                <ul
                  class="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800"
                >
                  <li
                    v-for="item in filteredCurrencySuggestions"
                    :key="item.code"
                    class="flex items-center justify-between px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <div>
                      <span class="text-xs font-bold text-slate-900 dark:text-white">
                        {{ item.code }}
                      </span>
                      <span class="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                        {{ getCatalogName(item) }} ({{ item.symbol }})
                      </span>
                    </div>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300"
                      @click="handleAddCurrency(item.code)"
                    >
                      <Plus class="h-3 w-3" />
                      <span>{{ t('settings.add') }}</span>
                    </button>
                  </li>
                  <li
                    v-if="filteredCurrencySuggestions.length === 0 && !canAddCustomIsoCode"
                    class="px-3 py-5 text-center text-xs text-slate-400"
                  >
                    {{ t('settings.noCurrencyMatches') }}
                  </li>
                </ul>
              </section>
            </div>

            <!-- 分頁 4：本地 JSON 備份匯出入 ＋ Google 雲端硬碟備份 -->
            <div v-else-if="activeTab === 'backup'" class="space-y-6">
              <!-- 本地 JSON 備份 -->
              <section class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">
                  <HardDrive class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>{{ t('backup.localTitle') }}</span>
                </div>
                <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {{ t('backup.localDesc') }}
                </p>

                <div class="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
                    @click="handleExportLocalJson"
                  >
                    <Download class="h-4 w-4" />
                    <span>{{ t('backup.exportButton') }}</span>
                  </button>

                  <label
                    class="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <Upload class="h-4 w-4" />
                    <span>{{ t('backup.importButton') }}</span>
                    <input
                      type="file"
                      accept="application/json,.json"
                      class="hidden"
                      @change="handleImportLocalJson"
                    />
                  </label>
                </div>
              </section>

              <!-- Google 雲端硬碟備份 -->
              <section class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">
                    <Cloud class="h-4 w-4 text-sky-500" />
                    <span>{{ t('backup.googleTitle') }}</span>
                  </div>
                  <button
                    v-if="googleConnected"
                    type="button"
                    class="text-[11px] font-semibold text-rose-500 hover:underline"
                    @click="handleGoogleDisconnect"
                  >
                    {{ t('backup.googleDisconnect') }}
                  </button>
                </div>

                <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {{ t('backup.googleDesc') }}
                </p>

                <!-- 已內建官方共用 Client ID：預設隱藏輸入框，一鍵即可同步 -->
                <div v-if="hasBuiltInClientId" class="space-y-2">
                  <div
                    class="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-[11px] font-medium text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200"
                  >
                    <CheckCircle2 class="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span>{{ t('backup.googleBuiltInReady') }}</span>
                  </div>

                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400 transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                    @click="showAdvancedGoogleConfig = !showAdvancedGoogleConfig"
                  >
                    <ChevronUp v-if="showAdvancedGoogleConfig" class="h-3.5 w-3.5" />
                    <ChevronDown v-else class="h-3.5 w-3.5" />
                    <span>{{ t('backup.googleAdvancedToggle') }}</span>
                  </button>

                  <div v-if="showAdvancedGoogleConfig" class="space-y-1.5 pt-0.5">
                    <div class="flex gap-1.5">
                      <input
                        v-model="customGoogleClientId"
                        type="text"
                        :placeholder="t('backup.googleClientIdPlaceholder')"
                        class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                      />
                      <button
                        type="button"
                        class="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        @click="handleSaveGoogleClientId"
                      >
                        {{ t('backup.googleSaveClientId') }}
                      </button>
                    </div>
                    <button
                      v-if="customGoogleClientId.trim()"
                      type="button"
                      class="text-[11px] font-semibold text-sky-600 hover:underline dark:text-sky-400"
                      @click="handleResetBuiltInClientId"
                    >
                      {{ t('backup.googleResetBuiltIn') }}
                    </button>
                  </div>
                </div>

                <!-- 尚未內建環境變數時：顯示 Client ID 輸入欄與 3 步驟快速引導連結 -->
                <div v-else class="space-y-2">
                  <div class="space-y-1.5">
                    <label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                      {{ t('backup.googleClientIdLabel') }}
                    </label>
                    <div class="flex gap-1.5">
                      <input
                        v-model="customGoogleClientId"
                        type="text"
                        :placeholder="t('backup.googleClientIdPlaceholder')"
                        class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                      />
                      <button
                        type="button"
                        class="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        @click="handleSaveGoogleClientId"
                      >
                        {{ t('backup.googleSaveClientId') }}
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-600 transition hover:underline dark:text-sky-400"
                    @click="showGoogleGuide = !showGoogleGuide"
                  >
                    <ChevronUp v-if="showGoogleGuide" class="h-3.5 w-3.5" />
                    <ChevronDown v-else class="h-3.5 w-3.5" />
                    <span>{{ t('backup.googleGuideToggle') }}</span>
                  </button>

                  <div
                    v-if="showGoogleGuide"
                    class="space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                  >
                    <ul class="space-y-1.5">
                      <li>
                        <a
                          href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="inline-flex items-center gap-1 font-semibold text-sky-600 hover:underline dark:text-sky-400"
                        >
                          <span>{{ t('backup.googleGuideStep1') }}</span>
                          <ExternalLink class="h-3 w-3 shrink-0" />
                        </a>
                      </li>
                      <li>
                        <a
                          href="https://console.cloud.google.com/apis/credentials/consent"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="inline-flex items-center gap-1 font-semibold text-sky-600 hover:underline dark:text-sky-400"
                        >
                          <span>{{ t('backup.googleGuideStep2') }}</span>
                          <ExternalLink class="h-3 w-3 shrink-0" />
                        </a>
                      </li>
                      <li>
                        <a
                          href="https://console.cloud.google.com/apis/credentials"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="inline-flex items-center gap-1 font-semibold text-sky-600 hover:underline dark:text-sky-400"
                        >
                          <span>{{ t('backup.googleGuideStep3') }}</span>
                          <ExternalLink class="h-3 w-3 shrink-0" />
                        </a>
                      </li>
                    </ul>

                    <div
                      v-if="currentOrigin"
                      class="space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800"
                    >
                      <div class="text-[10px] font-semibold text-slate-400">
                        {{ t('backup.googleOriginLabel') }}
                      </div>
                      <button
                        type="button"
                        class="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-700 transition hover:border-sky-400 hover:bg-sky-50/60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-sky-500"
                        @click="handleCopyCurrentOrigin"
                      >
                        <span class="truncate">{{ currentOrigin }}</span>
                        <Copy class="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      </button>
                    </div>
                  </div>
                </div>

                <div class="text-[11px] text-slate-400">
                  {{
                    formattedGoogleLastSync
                      ? t('backup.googleLastSync', { time: formattedGoogleLastSync })
                      : t('backup.googleNotSyncedYet')
                  }}
                </div>

                <div class="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    :disabled="isGoogleBusy"
                    class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-sky-600 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-sky-700 disabled:opacity-50"
                    @click="handleGoogleUpload"
                  >
                    <Loader2 v-if="isGoogleBusy" class="h-4 w-4 animate-spin" />
                    <CloudUpload v-else class="h-4 w-4" />
                    <span>{{ t('backup.googleUploadButton') }}</span>
                  </button>

                  <button
                    type="button"
                    :disabled="isGoogleBusy"
                    class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-sky-200 bg-white px-3 py-2.5 text-xs font-bold text-sky-700 transition hover:bg-sky-50 disabled:opacity-50 dark:border-sky-800 dark:bg-slate-900 dark:text-sky-300 dark:hover:bg-sky-950/40"
                    @click="handleGoogleDownloadMerge"
                  >
                    <Loader2 v-if="isGoogleBusy" class="h-4 w-4 animate-spin" />
                    <CloudDownload v-else class="h-4 w-4" />
                    <span>{{ t('backup.googleDownloadButton') }}</span>
                  </button>
                </div>
              </section>
            </div>

            <!-- 分頁 5：最近刪除（回收桶／一鍵復原與清空回收桶） -->
            <div v-else-if="activeTab === 'trash'" class="space-y-3">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {{ t('trash.title') }}
                </span>
                <button
                  v-if="store.deletedTransactions.length > 0"
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1 text-[11px] font-bold text-rose-600 transition hover:bg-rose-100 dark:bg-rose-950/60 dark:text-rose-300"
                  @click="handleEmptyTrash"
                >
                  <Trash2 class="h-3 w-3" />
                  <span>{{ t('trash.emptyAll') }}</span>
                </button>
              </div>

              <p
                v-if="store.deletedTransactions.length === 0"
                class="py-10 text-center text-xs text-slate-400 dark:text-slate-500"
              >
                {{ t('trash.empty') }}
              </p>

              <ul v-else class="divide-y divide-slate-100 dark:divide-slate-800">
                <li
                  v-for="tx in store.deletedTransactions"
                  :key="tx.id"
                  class="flex items-center justify-between gap-2 py-2.5"
                >
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {{ tx.note || tx.categoryKey }}
                      </span>
                      <span
                        v-if="store.getAnyProjectById(tx.projectId)"
                        class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300"
                      >
                        {{ store.getAnyProjectById(tx.projectId)?.name }}
                      </span>
                    </div>
                    <div class="text-[11px] text-slate-400">
                      {{ fmt(tx.amount, tx.currency) }} · {{ tx.date }}
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300"
                      @click="handleRestoreTx(tx.id)"
                    >
                      <Undo2 class="h-3.5 w-3.5" />
                      <span>{{ t('trash.restore') }}</span>
                    </button>
                    <button
                      type="button"
                      :title="t('trash.deleteForever')"
                      class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
                      @click="handlePermanentDeleteTx(tx.id)"
                    >
                      <Trash2 class="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>
