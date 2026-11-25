<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  ArchiveRestore,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  Link2,
  Loader2,
  Moon,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sun,
  Tag,
  Trash2,
  Undo2,
  Upload,
  User,
  X,
} from 'lucide-vue-next'
import CategoryIconBadge from '@/components/CategoryIconBadge.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'
import { askConfirm } from '@/composables/useConfirm'
import { useModalLayer } from '@/composables/useModalLayer'
import {
  isValidCategoryIconKey,
  resolveDefaultCategoryIcon,
  SELECTABLE_CATEGORY_ICONS,
  type CategoryIconKey,
} from '@/core/categoryIcons'
import { compressAvatarImageFileToDataUrl } from '@/core/imageCompressor'
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
  buildGoogleConnectLink,
  GoogleClientIdSchema,
} from '@/core/googleConnectLink'
import {
  getBuiltInGoogleClientId,
  getCustomGoogleClientId,
  GoogleDriveSyncError,
  hasBuiltInGoogleClientId,
  saveGoogleClientId,
} from '@/services/googleDriveSync'

export type SettingsTab = 'profile' | 'rates' | 'categories' | 'data'

interface Props {
  open: boolean
  isDark: boolean
  initialTab?: SettingsTab
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'profile',
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'setTheme', dark: boolean): void
  (e: 'toast', message: string): void
  (e: 'restored', projectId?: string): void
  (e: 'selectProject', projectId: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => props.open,
  () => emit('close'),
  dialogRef,
)

const activeTab = ref<SettingsTab>(props.initialTab)

// 分類新增與編輯狀態（顏色與圖案皆預設收合，點擊後再展開挑選面板）
const newCategoryName = ref('')
const newCategoryColor = ref<string>(AVATAR_PALETTE[0])
const newCategoryIcon = ref<CategoryIconKey>('tag')
const newCategoryPicker = ref<'color' | 'icon' | null>(null)
const editingCatKey = ref<string | null>(null)
const editingCatName = ref('')
const editingCatColor = ref<string>(AVATAR_PALETTE[0])
const editingCatIcon = ref<CategoryIconKey>('tag')
const editingCatPicker = ref<'color' | 'icon' | null>(null)

// 我的成員檔案（預設成員名稱、大頭貼與收款帳號）
const profileDisplayName = ref(store.userProfile.displayName)
const profileAvatarColor = ref(store.userProfile.avatarColor || AVATAR_PALETTE[0])
const profileAvatarImage = ref<string | undefined>(store.userProfile.avatarImage)
const profilePaymentInfo = ref(store.userProfile.paymentInfo ?? '')
const applyProfileToExisting = ref(true)
const isSavingProfile = ref(false)

// 幣別搜尋與自訂匯率輸入狀態
const currencySearchQuery = ref('')
const customRateDrafts = ref<Record<string, string>>({})

const foreignEnabledCurrencies = computed(() =>
  store.availableCurrencies.filter((c) => c !== store.defaultCurrency),
)

const formattedLiveRatesTime = computed(() => {
  const ts = store.liveRatesFetchedAt
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toLocaleString()
  }
})

function syncCustomRateDrafts() {
  const base = store.defaultCurrency
  const next: Record<string, string> = {}
  for (const cur of foreignEnabledCurrencies.value) {
    const custom = store.getRememberedExchangeRate(cur, base)
    const live = store.getLiveExchangeRate(cur, base)
    const val = custom ?? live
    next[cur] = val !== null ? String(val) : ''
  }
  customRateDrafts.value = next
}

async function handleManualRefreshRates() {
  const res = await store.refreshExchangeRates(true)
  syncCustomRateDrafts()
  if (res) {
    emit('toast', t('rates.refreshedToast'))
  } else {
    emit('toast', t('project.liveRateUnavailableToast'))
  }
}

function handleSaveCustomRate(currencyCode: string) {
  const raw = (customRateDrafts.value[currencyCode] ?? '').trim()
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    syncCustomRateDrafts()
    emit('toast', t('validation.exchangeRateRequired'))
    return
  }
  store.rememberExchangeRate(currencyCode, store.defaultCurrency, parsed)
  emit(
    'toast',
    t('rates.customSavedToast', {
      from: currencyCode,
      to: store.defaultCurrency,
      rate: parsed,
    }),
  )
}

function handleUseLiveRateForCurrency(currencyCode: string) {
  store.clearRememberedExchangeRate(currencyCode, store.defaultCurrency)
  const live = store.getLiveExchangeRate(currencyCode, store.defaultCurrency)
  customRateDrafts.value = {
    ...customRateDrafts.value,
    [currencyCode]: live !== null ? String(live) : '',
  }
  emit('toast', t('rates.appliedLiveToast', { code: currencyCode }))
}

// Google 雲端跨裝置同步狀態（優先讀取建置期內建 VITE_GOOGLE_CLIENT_ID，使用者無需手動輸入）
const builtInGoogleClientId = getBuiltInGoogleClientId()
const hasBuiltInClientId = hasBuiltInGoogleClientId()
const customGoogleClientId = ref(getCustomGoogleClientId())
const showAdvancedGoogleConfig = ref(false)
const showGoogleGuide = ref(false)
const currentOrigin =
  typeof window !== 'undefined' ? window.location.origin : ''

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      activeTab.value = props.initialTab
      customGoogleClientId.value = getCustomGoogleClientId()
      profileDisplayName.value = store.userProfile.displayName
      profileAvatarColor.value =
        store.userProfile.avatarColor || AVATAR_PALETTE[0]
      profileAvatarImage.value = store.userProfile.avatarImage
      profilePaymentInfo.value = store.userProfile.paymentInfo ?? ''
      syncCustomRateDrafts()
      void store.refreshExchangeRates(false).then(() => syncCustomRateDrafts())
    }
  },
)

watch(
  () => [store.defaultCurrency, store.availableCurrencies.join(','), store.liveRatesFetchedAt],
  () => {
    syncCustomRateDrafts()
  },
)

watch(
  () => store.userProfile,
  (next) => {
    profileDisplayName.value = next.displayName
    profileAvatarColor.value = next.avatarColor || AVATAR_PALETTE[0]
    profileAvatarImage.value = next.avatarImage
    profilePaymentInfo.value = next.paymentInfo ?? ''
  },
  { deep: true },
)

async function handleProfileAvatarUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    profileAvatarImage.value = await compressAvatarImageFileToDataUrl(file, 160, 0.78)
  } catch {
    emit('toast', t('photo.uploadError'))
  } finally {
    input.value = ''
  }
}

function handleRemoveProfileAvatar() {
  profileAvatarImage.value = undefined
}

async function handleSaveProfile() {
  if (isSavingProfile.value) return
  isSavingProfile.value = true
  try {
    await store.updateUserProfile(
      {
        displayName: profileDisplayName.value,
        avatarColor: profileAvatarColor.value,
        avatarImage: profileAvatarImage.value ?? null,
        paymentInfo: profilePaymentInfo.value.trim() || null,
      },
      { applyToExistingProjects: applyProfileToExisting.value },
    )
    emit('toast', t('profile.savedToast'))
  } finally {
    isSavingProfile.value = false
  }
}

const effectiveGoogleClientId = computed(
  () => customGoogleClientId.value.trim() || builtInGoogleClientId,
)

const canShareGoogleConnectLink = computed(() =>
  GoogleClientIdSchema.safeParse(effectiveGoogleClientId.value).success,
)

const isGoogleBusy = computed(() => store.googleDriveStatus === 'syncing')

const googleAccountInitial = computed(() => {
  const name =
    store.googleDriveAccount?.displayName || store.googleDriveAccount?.email || 'G'
  return name.trim().charAt(0).toUpperCase() || 'G'
})

const googleStatusBadge = computed(() => {
  switch (store.googleDriveStatus) {
    case 'syncing':
      return {
        label: t('backup.googleStatusSyncing'),
        className:
          'bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300',
      }
    case 'synced':
      return {
        label: t('backup.googleStatusSynced'),
        className:
          'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300',
      }
    case 'pending':
      return {
        label: t('backup.googleStatusPending'),
        className:
          'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300',
      }
    case 'needs_auth':
      return {
        label: t('backup.googleStatusNeedsAuth'),
        className:
          'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300',
      }
    case 'offline':
      return {
        label: t('backup.googleStatusOffline'),
        className:
          'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
      }
    case 'error':
      return {
        label: t('backup.googleStatusError'),
        className:
          'bg-rose-100 text-rose-700 dark:bg-rose-950/70 dark:text-rose-300',
      }
    default:
      return {
        label: t('backup.googleStatusDisconnected'),
        className:
          'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
      }
  }
})

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
  const ts = store.googleDriveLastSyncAt
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toLocaleString()
  }
})

function resolveCategoryDisplayName(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

function getCategoryLabelByKey(key: string): string {
  const found = store.categories.find((c) => c.key === key)
  if (found) return resolveCategoryDisplayName(found)
  const translated = t(`categories.${key}`)
  return translated === `categories.${key}` ? key : translated
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
  store.addCategory(name, newCategoryColor.value, newCategoryIcon.value)
  newCategoryName.value = ''
  newCategoryPicker.value = null
  emit('toast', t('settings.categoryAddedToast'))
}

function toggleNewCategoryPicker(mode: 'color' | 'icon') {
  newCategoryPicker.value = newCategoryPicker.value === mode ? null : mode
}

function toggleEditingCategoryPicker(mode: 'color' | 'icon') {
  editingCatPicker.value = editingCatPicker.value === mode ? null : mode
}

function startEditCategory(
  cat: ManagedCategory,
  initialPicker: 'color' | 'icon' | null = null,
) {
  newCategoryPicker.value = null
  editingCatKey.value = cat.key
  editingCatName.value = resolveCategoryDisplayName(cat)
  editingCatColor.value = cat.color || AVATAR_PALETTE[0]
  editingCatIcon.value = isValidCategoryIconKey(cat.icon)
    ? cat.icon
    : resolveDefaultCategoryIcon(cat.key)
  editingCatPicker.value = initialPicker
}

function handleSaveCategoryEdit() {
  if (!editingCatKey.value) return
  const trimmed = editingCatName.value.trim()
  if (!trimmed) return
  store.updateCategory(editingCatKey.value, {
    customLabel: trimmed,
    color: editingCatColor.value,
    icon: editingCatIcon.value,
  })
  editingCatKey.value = null
  editingCatPicker.value = null
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
    editingCatPicker.value = null
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

function formatBytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// ==================== 本地 JSON 備份匯出與合併匯入 ====================
function handleExportLocalJson(omitReceiptImages = false) {
  const backup = store.exportLedgerBackup({ omitReceiptImages })
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = omitReceiptImages
    ? `clearbill-backup-lite-${getTodayIso()}.json`
    : `clearbill-backup-${getTodayIso()}.json`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  emit(
    'toast',
    omitReceiptImages ? t('backup.exportedLiteToast') : t('backup.exportedToast'),
  )
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

async function handleCopyGoogleConnectLink() {
  if (!canShareGoogleConnectLink.value || typeof window === 'undefined') return
  try {
    const baseUrl = `${window.location.origin}${window.location.pathname}`
    const link = buildGoogleConnectLink(baseUrl, effectiveGoogleClientId.value)
    await navigator.clipboard.writeText(link)
    emit('toast', t('backup.googlePairLinkCopiedToast'))
  } catch {
    emit('toast', t('share.failedToast'))
  }
}

async function handleGoogleUpload(selectAccount = false) {
  const activeClientId = effectiveGoogleClientId.value
  if (!activeClientId) {
    emit('toast', t('backup.googleNeedClientId'))
    return
  }
  if (customGoogleClientId.value.trim()) {
    saveGoogleClientId(customGoogleClientId.value.trim())
  }
  try {
    const res = await store.syncGoogleDriveNow({
      clientId: activeClientId,
      selectAccount,
      enableAutoSyncOnSuccess: true,
    })
    if (!res) return

    if (res.skippedNoChanges) {
      emit('toast', t('backup.googleAlreadyUpToDate'))
    } else if (res.hadRemoteFile && res.mergeStats) {
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
  try {
    const { stats } = await store.pullGoogleDriveNow(activeClientId)
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
  }
}

function handleToggleAutoSync() {
  const next = !store.googleDriveAutoSync
  store.setGoogleDriveAutoSync(next)
  emit(
    'toast',
    next ? t('backup.googleAutoSyncEnabledToast') : t('backup.googleAutoSyncDisabledToast'),
  )
}

function handleGoogleDisconnect() {
  store.disconnectGoogleDriveAccount()
  emit('toast', t('backup.googleDisconnectedToast'))
}

// ==================== 已封存專案管理 ====================
async function handleUnarchiveProject(projectId: string) {
  const updated = await store.toggleArchiveProject(projectId)
  if (updated) {
    emit('toast', t('project.unarchivedToast', { name: updated.name }))
  }
}

function handleOpenArchivedProject(projectId: string) {
  emit('selectProject', projectId)
  emit('close')
}

// ==================== 回收桶復原與一鍵清空 ====================
const totalTrashCount = computed(
  () => store.deletedProjects.length + store.deletedTransactions.length,
)

function getHumanMembers(proj: {
  members: Array<{
    id: string
    name: string
    avatarColor?: string
    avatarImage?: string
    isPool?: boolean
  }>
}) {
  const humans = proj.members.filter((m) => !m.isPool)
  return humans.length > 0 ? humans : proj.members
}

async function handleRestoreProject(projectId: string) {
  const res = await store.restoreProject(projectId)
  if (res.ok) {
    emit(
      'toast',
      t('trash.projectRestoredToast', {
        name: res.projectName ?? '',
        count: res.restoredTxCount,
      }),
    )
    emit('restored', projectId)
    emit('close')
  }
}

async function handlePermanentDeleteProject(projectId: string, name: string) {
  const confirmed = await askConfirm({
    title: t('trash.deleteForever'),
    message: t('trash.permanentDeleteProjectConfirm', { name }),
    confirmText: t('trash.deleteForever'),
    tone: 'danger',
  })
  if (!confirmed) return
  await store.permanentlyDeleteProject(projectId)
  emit('toast', t('trash.permanentlyDeletedToast'))
}

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
  const count = totalTrashCount.value
  if (count === 0) return
  const confirmed = await askConfirm({
    title: t('trash.emptyAll'),
    message: t('trash.emptyAllConfirm', { count }),
    confirmText: t('trash.emptyAll'),
    tone: 'danger',
  })
  if (!confirmed) return
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
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        :aria-label="t('settings.title')"
        class="fixed inset-0 z-50 flex justify-end bg-slate-950/50 backdrop-blur-sm"
        @click.self="emit('close')"
      >
        <aside
          class="safe-top flex h-full w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        >
          <!-- 標題列 -->
          <div
            class="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800"
          >
            <h2 class="text-base font-bold text-slate-900 dark:text-white">
              {{ t('settings.title') }}
            </h2>
            <button
              type="button"
              :aria-label="t('settings.close')"
              class="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              @click="emit('close')"
            >
              <X class="h-5 w-5" />
            </button>
          </div>

          <!-- 四大同級分頁導覽：個人 / 匯率 / 分類 / 資料 -->
          <nav
            class="grid grid-cols-4 gap-1 border-b border-slate-100 bg-slate-50 p-1.5 text-xs font-semibold dark:border-slate-800 dark:bg-slate-950/60"
          >
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'profile'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'profile'"
            >
              {{ t('settings.tabProfile') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                activeTab === 'rates'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'rates'"
            >
              {{ t('settings.tabRates') }}
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
                activeTab === 'data'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="activeTab = 'data'"
            >
              {{ t('settings.tabData') }}
            </button>
          </nav>

          <!-- 分頁內容區 -->
          <div class="safe-sheet-pb flex-1 overflow-y-auto px-5 pt-5">
            <!-- 分頁 1：個人（我的成員檔案 ＋ 外觀深淺色 ＋ 介面語言） -->
            <div v-if="activeTab === 'profile'" class="space-y-6">
              <!-- 我的成員名稱與大頭貼設定 -->
              <section class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">
                  <User class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>{{ t('profile.sectionTitle') }}</span>
                </div>
                <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {{ t('profile.sectionDesc') }}
                </p>

                <div class="flex items-center gap-3.5">
                  <div class="relative shrink-0">
                    <MemberAvatar
                      :name="profileDisplayName || t('project.defaultMember1')"
                      :color="profileAvatarColor"
                      :image="profileAvatarImage"
                      size="lg"
                    />
                    <label
                      class="absolute -bottom-1 -right-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-2 border-white bg-slate-900 text-white shadow transition hover:bg-emerald-600 dark:border-slate-900 dark:bg-emerald-500 dark:text-slate-950"
                      :title="t('profile.uploadAvatar')"
                    >
                      <Camera class="h-3 w-3" />
                      <input
                        type="file"
                        accept="image/*"
                        class="hidden"
                        @change="handleProfileAvatarUpload"
                      />
                    </label>
                  </div>

                  <div class="min-w-0 flex-1 space-y-1.5">
                    <input
                      v-model="profileDisplayName"
                      type="text"
                      maxlength="32"
                      :placeholder="t('profile.namePlaceholder')"
                      class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                      @keyup.enter="handleSaveProfile"
                    />
                    <div class="flex items-center gap-2">
                      <label
                        class="cursor-pointer text-[11px] font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
                      >
                        <span>{{ t('profile.uploadAvatar') }}</span>
                        <input
                          type="file"
                          accept="image/*"
                          class="hidden"
                          @change="handleProfileAvatarUpload"
                        />
                      </label>
                      <button
                        v-if="profileAvatarImage"
                        type="button"
                        class="text-[11px] font-semibold text-rose-500 hover:underline"
                        @click="handleRemoveProfileAvatar"
                      >
                        {{ t('profile.removeAvatar') }}
                      </button>
                    </div>
                  </div>
                </div>

                <!-- 頭像預設色票 -->
                <div class="flex items-center gap-1.5 pt-0.5">
                  <button
                    v-for="color in AVATAR_PALETTE"
                    :key="color"
                    type="button"
                    class="h-5 w-5 rounded-full transition"
                    :style="{ backgroundColor: color }"
                    :class="
                      profileAvatarColor === color
                        ? 'ring-2 ring-slate-900 ring-offset-2 dark:ring-white dark:ring-offset-slate-900'
                        : 'opacity-70 hover:opacity-100'
                    "
                    @click="profileAvatarColor = color"
                  />
                </div>

                <!-- 選填：我的收款帳號／轉帳資訊（結算與一鍵分享時自動帶出） -->
                <div class="space-y-1">
                  <label class="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    {{ t('profile.paymentInfoLabel') }}
                  </label>
                  <input
                    v-model="profilePaymentInfo"
                    type="text"
                    maxlength="120"
                    :placeholder="t('profile.paymentInfoPlaceholder')"
                    class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                    @keyup.enter="handleSaveProfile"
                  />
                </div>

                <label
                  v-if="store.allNonDeletedProjects.length > 0"
                  class="flex cursor-pointer items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300"
                >
                  <input
                    v-model="applyProfileToExisting"
                    type="checkbox"
                    class="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800"
                  />
                  <span>{{ t('profile.applyToExistingProjects') }}</span>
                </label>

                <button
                  type="button"
                  :disabled="isSavingProfile"
                  class="w-full rounded-xl bg-slate-900 py-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:opacity-50 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
                  @click="handleSaveProfile"
                >
                  {{ t('profile.saveButton') }}
                </button>
              </section>

              <!-- Google 帳號與跨裝置自動同步 -->
              <section class="space-y-3 rounded-2xl border border-sky-200/80 bg-sky-50/40 p-4 dark:border-sky-900/60 dark:bg-sky-950/20">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                    <CloudOff
                      v-if="store.googleDriveStatus === 'offline'"
                      class="h-4 w-4 text-slate-400"
                    />
                    <Cloud v-else class="h-4 w-4 text-sky-500" />
                    <span>{{ t('backup.googleTitle') }}</span>
                  </div>
                  <span
                    class="rounded-full px-2 py-0.5 text-[10px] font-bold"
                    :class="googleStatusBadge.className"
                  >
                    {{ googleStatusBadge.label }}
                  </span>
                </div>

                <p class="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                  {{ t('backup.googleDesc') }}
                </p>

                <p
                  v-if="store.googleDriveAccount || store.googleDriveAutoSync"
                  class="rounded-xl bg-white/70 px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-500 dark:bg-slate-900/60 dark:text-slate-400"
                >
                  {{ t('backup.googleHourlySessionNote') }}
                </p>

                <!-- 已連結 Google 帳號卡片 -->
                <div
                  v-if="store.googleDriveAccount"
                  class="flex items-center justify-between gap-2 rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900"
                >
                  <div class="flex min-w-0 items-center gap-2.5">
                    <div
                      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white"
                    >
                      {{ googleAccountInitial }}
                    </div>
                    <div class="min-w-0">
                      <div class="truncate text-xs font-bold text-slate-900 dark:text-white">
                        {{ store.googleDriveAccount.displayName }}
                      </div>
                      <div class="truncate text-[10px] text-slate-500 dark:text-slate-400">
                        {{ store.googleDriveAccount.email }}
                      </div>
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      :disabled="isGoogleBusy"
                      class="text-[11px] font-semibold text-sky-600 hover:underline disabled:opacity-40 dark:text-sky-400"
                      @click="handleGoogleUpload(true)"
                    >
                      {{ t('backup.googleSwitchAccount') }}
                    </button>
                    <button
                      type="button"
                      class="text-[11px] font-semibold text-rose-500 hover:underline"
                      @click="handleGoogleDisconnect"
                    >
                      {{ t('backup.googleDisconnect') }}
                    </button>
                  </div>
                </div>

                <!-- 自動跨裝置同步開關（連結後或已設定 Client ID 時可用） -->
                <div
                  v-if="store.googleDriveAccount || effectiveGoogleClientId"
                  class="flex items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-white/90 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900/80"
                >
                  <div class="min-w-0">
                    <div class="text-xs font-bold text-slate-800 dark:text-slate-100">
                      {{ t('backup.googleAutoSyncTitle') }}
                    </div>
                    <p class="mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
                      {{ t('backup.googleAutoSyncDesc') }}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    :aria-checked="store.googleDriveAutoSync"
                    class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition"
                    :class="
                      store.googleDriveAutoSync
                        ? 'bg-emerald-500'
                        : 'bg-slate-300 dark:bg-slate-700'
                    "
                    @click="handleToggleAutoSync"
                  >
                    <span
                      class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200"
                      :class="
                        store.googleDriveAutoSync
                          ? 'translate-x-[18px]'
                          : 'translate-x-0.5'
                      "
                    />
                  </button>
                </div>

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

                <div class="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <span>
                    {{
                      formattedGoogleLastSync
                        ? t('backup.googleLastSync', { time: formattedGoogleLastSync })
                        : t('backup.googleNotSyncedYet')
                    }}
                  </span>
                  <span
                    v-if="store.googleDriveDirty && store.googleDriveAccount"
                    class="font-semibold text-amber-600 dark:text-amber-400"
                  >
                    {{ t('backup.googleUnsyncedHint') }}
                  </span>
                </div>

                <!-- 發生同步異常時明確顯示具體錯誤原因，方便排查 -->
                <div
                  v-if="store.googleDriveStatus === 'error'"
                  class="rounded-xl border border-rose-200 bg-rose-50/90 px-3 py-2 text-[11px] leading-relaxed text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-300"
                >
                  {{
                    t('backup.googleSyncError', {
                      reason: store.googleDriveLastErrorCode
                        ? t(`backup.errors.${store.googleDriveLastErrorCode}`)
                        : store.googleDriveLastErrorDetail ||
                          t('backup.errors.ERR_UNKNOWN'),
                    })
                  }}
                </div>

                <div class="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    :disabled="isGoogleBusy"
                    class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-sky-600 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-sky-700 disabled:opacity-50"
                    @click="handleGoogleUpload(false)"
                  >
                    <Loader2 v-if="isGoogleBusy" class="h-4 w-4 animate-spin" />
                    <RefreshCw
                      v-else-if="store.googleDriveAccount"
                      class="h-4 w-4"
                    />
                    <CloudUpload v-else class="h-4 w-4" />
                    <span>
                      {{
                        store.googleDriveStatus === 'needs_auth'
                          ? t('backup.googleReconnectButton')
                          : store.googleDriveAccount
                            ? t('backup.googleUploadButton')
                            : t('backup.googleConnectButton')
                      }}
                    </span>
                  </button>

                  <div class="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      :disabled="isGoogleBusy"
                      class="flex items-center justify-center gap-1 rounded-xl border border-sky-200 bg-white px-2.5 py-2 text-[11px] font-bold text-sky-700 transition hover:bg-sky-50 disabled:opacity-50 dark:border-sky-800 dark:bg-slate-900 dark:text-sky-300 dark:hover:bg-sky-950/40"
                      @click="handleGoogleDownloadMerge"
                    >
                      <CloudDownload class="h-3.5 w-3.5" />
                      <span>{{ t('backup.googleDownloadButton') }}</span>
                    </button>

                    <button
                      v-if="canShareGoogleConnectLink"
                      type="button"
                      class="flex items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[11px] font-bold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      @click="handleCopyGoogleConnectLink"
                    >
                      <Link2 class="h-3.5 w-3.5 text-sky-500" />
                      <span>{{ t('backup.googleCopyPairLink') }}</span>
                    </button>
                  </div>
                </div>
              </section>

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

            <!-- 分頁 2：消費分類管理（顯示圖示＋自訂底色，顏色與圖案點擊後再展開挑選） -->
            <div v-else-if="activeTab === 'categories'" class="space-y-4">
              <div class="space-y-2.5">
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
                      editingCatKey = null;
                      editingCatPicker = null;
                      emit('toast', t('settings.categoriesResetToast'))
                    "
                  >
                    <RotateCcw class="h-3 w-3" />
                    <span>{{ t('settings.resetCategories') }}</span>
                  </button>
                </div>

                <!-- 新增分類卡片：左側圖示底色預覽 ＋ 名稱輸入 ＋ 點擊才展開之底色／圖案選單 -->
                <div class="space-y-2.5 rounded-2xl bg-slate-100/80 p-3 dark:bg-slate-800/70">
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      :title="t('settings.categoryIconLabel')"
                      class="shrink-0 rounded-xl transition active:scale-95"
                      @click="toggleNewCategoryPicker('icon')"
                    >
                      <CategoryIconBadge
                        :icon="newCategoryIcon"
                        :color="newCategoryColor"
                        size="md"
                      />
                    </button>
                    <input
                      v-model="newCategoryName"
                      type="text"
                      maxlength="24"
                      :placeholder="t('settings.addCategoryPlaceholder')"
                      class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
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

                  <!-- 底色／圖案觸發膠囊（預設收合，點擊後展開對應品項） -->
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
                      :class="
                        newCategoryPicker === 'color'
                          ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                          : 'bg-white text-slate-600 shadow-xs hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300'
                      "
                      @click="toggleNewCategoryPicker('color')"
                    >
                      <span
                        class="h-3 w-3 rounded-full ring-1 ring-black/15"
                        :style="{ backgroundColor: newCategoryColor }"
                      />
                      <span>{{ t('settings.categoryColorLabel') }}</span>
                      <ChevronDown
                        class="h-3 w-3 transition-transform"
                        :class="newCategoryPicker === 'color' ? 'rotate-180' : ''"
                      />
                    </button>

                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
                      :class="
                        newCategoryPicker === 'icon'
                          ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                          : 'bg-white text-slate-600 shadow-xs hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300'
                      "
                      @click="toggleNewCategoryPicker('icon')"
                    >
                      <CategoryIconBadge
                        :icon="newCategoryIcon"
                        size="xs"
                        plain
                      />
                      <span>{{ t('settings.categoryIconLabel') }}</span>
                      <ChevronDown
                        class="h-3 w-3 transition-transform"
                        :class="newCategoryPicker === 'icon' ? 'rotate-180' : ''"
                      />
                    </button>
                  </div>

                  <!-- 點擊「底色」後展開之色票與自訂調色盤 -->
                  <div
                    v-if="newCategoryPicker === 'color'"
                    class="flex flex-wrap items-center gap-2 rounded-xl bg-white p-2.5 shadow-xs dark:bg-slate-900"
                  >
                    <button
                      v-for="color in AVATAR_PALETTE"
                      :key="color"
                      type="button"
                      class="h-6 w-6 rounded-full transition"
                      :style="{ backgroundColor: color }"
                      :class="
                        newCategoryColor.toLowerCase() === color.toLowerCase()
                          ? 'scale-110 ring-2 ring-slate-900 ring-offset-2 dark:ring-white dark:ring-offset-slate-900'
                          : 'opacity-80 hover:opacity-100'
                      "
                      @click="newCategoryColor = color"
                    />
                    <label
                      class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-600 dark:text-slate-300"
                    >
                      <Palette class="h-3 w-3" />
                      <span>{{ t('settings.customColorPicker') }}</span>
                      <input
                        v-model="newCategoryColor"
                        type="color"
                        class="sr-only"
                      />
                    </label>
                  </div>

                  <!-- 點擊「圖案」後展開之 24 款圖示選單 -->
                  <div
                    v-else-if="newCategoryPicker === 'icon'"
                    class="grid grid-cols-6 gap-1.5 rounded-xl bg-white p-2.5 shadow-xs dark:bg-slate-900"
                  >
                    <button
                      v-for="iconKey in SELECTABLE_CATEGORY_ICONS"
                      :key="iconKey"
                      type="button"
                      class="flex h-9 items-center justify-center rounded-xl transition active:scale-95"
                      :style="
                        newCategoryIcon === iconKey
                          ? { backgroundColor: newCategoryColor }
                          : undefined
                      "
                      :class="
                        newCategoryIcon === iconKey
                          ? 'text-white shadow-sm'
                          : 'bg-slate-100/80 text-slate-600 hover:bg-slate-200/80 dark:bg-slate-800 dark:text-slate-300'
                      "
                      @click="newCategoryIcon = iconKey"
                    >
                      <CategoryIconBadge :icon="iconKey" size="md" plain />
                    </button>
                  </div>
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
                    class="space-y-2.5 rounded-2xl bg-slate-100/80 p-3 dark:bg-slate-800/70"
                  >
                    <div class="flex items-center gap-1.5">
                      <button
                        type="button"
                        :title="t('settings.categoryIconLabel')"
                        class="shrink-0 rounded-xl transition active:scale-95"
                        @click="toggleEditingCategoryPicker('icon')"
                      >
                        <CategoryIconBadge
                          :icon="editingCatIcon"
                          :color="editingCatColor"
                          size="md"
                        />
                      </button>
                      <input
                        v-model="editingCatName"
                        type="text"
                        maxlength="24"
                        class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                        @keyup.enter="handleSaveCategoryEdit"
                      />
                      <button
                        type="button"
                        :aria-label="t('daily.saveButton')"
                        class="rounded-xl bg-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white"
                        @click="handleSaveCategoryEdit"
                      >
                        <Check class="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        :aria-label="t('confirm.cancelButton')"
                        class="rounded-xl bg-white px-2 py-1.5 text-slate-500 shadow-xs dark:bg-slate-900 dark:text-slate-400"
                        @click="
                          editingCatKey = null;
                          editingCatPicker = null
                        "
                      >
                        <X class="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <!-- 編輯模式：點擊「底色」或「圖案」才顯示選單 -->
                    <div class="flex items-center gap-2">
                      <button
                        type="button"
                        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
                        :class="
                          editingCatPicker === 'color'
                            ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                            : 'bg-white text-slate-600 shadow-xs hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300'
                        "
                        @click="toggleEditingCategoryPicker('color')"
                      >
                        <span
                          class="h-3 w-3 rounded-full ring-1 ring-black/15"
                          :style="{ backgroundColor: editingCatColor }"
                        />
                        <span>{{ t('settings.categoryColorLabel') }}</span>
                        <ChevronDown
                          class="h-3 w-3 transition-transform"
                          :class="editingCatPicker === 'color' ? 'rotate-180' : ''"
                        />
                      </button>

                      <button
                        type="button"
                        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
                        :class="
                          editingCatPicker === 'icon'
                            ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                            : 'bg-white text-slate-600 shadow-xs hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300'
                        "
                        @click="toggleEditingCategoryPicker('icon')"
                      >
                        <CategoryIconBadge
                          :icon="editingCatIcon"
                          size="xs"
                          plain
                        />
                        <span>{{ t('settings.categoryIconLabel') }}</span>
                        <ChevronDown
                          class="h-3 w-3 transition-transform"
                          :class="editingCatPicker === 'icon' ? 'rotate-180' : ''"
                        />
                      </button>
                    </div>

                    <div
                      v-if="editingCatPicker === 'color'"
                      class="flex flex-wrap items-center gap-2 rounded-xl bg-white p-2.5 shadow-xs dark:bg-slate-900"
                    >
                      <button
                        v-for="color in AVATAR_PALETTE"
                        :key="color"
                        type="button"
                        class="h-6 w-6 rounded-full transition"
                        :style="{ backgroundColor: color }"
                        :class="
                          editingCatColor.toLowerCase() === color.toLowerCase()
                            ? 'scale-110 ring-2 ring-slate-900 ring-offset-2 dark:ring-white dark:ring-offset-slate-900'
                            : 'opacity-80 hover:opacity-100'
                        "
                        @click="editingCatColor = color"
                      />
                      <label
                        class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-600 dark:text-slate-300"
                      >
                        <Palette class="h-3 w-3" />
                        <span>{{ t('settings.customColorPicker') }}</span>
                        <input
                          v-model="editingCatColor"
                          type="color"
                          class="sr-only"
                        />
                      </label>
                    </div>

                    <div
                      v-else-if="editingCatPicker === 'icon'"
                      class="grid grid-cols-6 gap-1.5 rounded-xl bg-white p-2.5 shadow-xs dark:bg-slate-900"
                    >
                      <button
                        v-for="iconKey in SELECTABLE_CATEGORY_ICONS"
                        :key="iconKey"
                        type="button"
                        class="flex h-9 items-center justify-center rounded-xl transition active:scale-95"
                        :style="
                          editingCatIcon === iconKey
                            ? { backgroundColor: editingCatColor }
                            : undefined
                        "
                        :class="
                          editingCatIcon === iconKey
                            ? 'text-white shadow-sm'
                            : 'bg-slate-100/80 text-slate-600 hover:bg-slate-200/80 dark:bg-slate-800 dark:text-slate-300'
                        "
                        @click="editingCatIcon = iconKey"
                      >
                        <CategoryIconBadge :icon="iconKey" size="md" plain />
                      </button>
                    </div>
                  </div>

                  <div v-else class="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-3 text-left transition hover:opacity-85"
                      @click="startEditCategory(cat)"
                    >
                      <CategoryIconBadge
                        :icon="cat.icon"
                        :category-key="cat.key"
                        :color="cat.color"
                        size="md"
                      />
                      <span class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                        {{ resolveCategoryDisplayName(cat) }}
                      </span>
                    </button>
                    <div class="flex shrink-0 items-center gap-1">
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

            <!-- 分頁 2：匯率（每小時即時匯率看板 ＋ 常用幣別管理） -->
            <div v-else-if="activeTab === 'rates'" class="space-y-5">
              <!-- 每小時免費即時匯率參考與自訂覆寫 -->
              <section class="space-y-3 rounded-2xl border border-amber-200/80 bg-amber-50/40 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <div class="text-xs font-bold text-slate-900 dark:text-white">
                      {{ t('rates.boardTitle', { base: store.defaultCurrency }) }}
                    </div>
                    <div class="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                      {{
                        formattedLiveRatesTime
                          ? t('rates.fetchedAtLabel', { time: formattedLiveRatesTime })
                          : t('rates.notFetchedYet')
                      }}
                    </div>
                  </div>
                  <button
                    type="button"
                    :disabled="store.isRefreshingLiveRates"
                    class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-900 transition hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/60 dark:text-amber-200"
                    @click="handleManualRefreshRates"
                  >
                    <RefreshCw
                      class="h-3 w-3"
                      :class="store.isRefreshingLiveRates ? 'animate-spin' : ''"
                    />
                    <span>{{ t('rates.refreshNow') }}</span>
                  </button>
                </div>

                <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {{ t('rates.hourlyHint') }}
                </p>

                <ul class="divide-y divide-amber-200/50 rounded-xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                  <li
                    v-for="code in foreignEnabledCurrencies"
                    :key="code"
                    class="space-y-1.5 px-3 py-2.5"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs font-extrabold text-slate-900 dark:text-white">
                          1 {{ code }}
                        </span>
                        <span
                          class="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                          :class="
                            store.getRememberedExchangeRate(code, store.defaultCurrency) !== null
                              ? 'bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300'
                              : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300'
                          "
                        >
                          {{
                            store.getRememberedExchangeRate(code, store.defaultCurrency) !== null
                              ? t('rates.badgeCustom')
                              : t('rates.badgeLive')
                          }}
                        </span>
                      </div>
                      <span
                        v-if="store.getLiveExchangeRate(code, store.defaultCurrency) !== null"
                        class="text-[10px] tabular-nums text-slate-400"
                      >
                        {{
                          t('rates.liveRefValue', {
                            rate: store.getLiveExchangeRate(code, store.defaultCurrency),
                            base: store.defaultCurrency,
                          })
                        }}
                      </span>
                    </div>

                    <div class="flex items-center gap-1.5">
                      <span class="text-xs font-semibold text-slate-400">=</span>
                      <input
                        v-model="customRateDrafts[code]"
                        type="number"
                        step="any"
                        min="0"
                        inputmode="decimal"
                        class="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold tabular-nums text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                        @keyup.enter="handleSaveCustomRate(code)"
                      />
                      <span class="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                        {{ store.defaultCurrency }}
                      </span>
                      <button
                        type="button"
                        class="rounded-lg bg-slate-900 px-2 py-1 text-[10px] font-bold text-white hover:bg-slate-800 dark:bg-emerald-500 dark:text-slate-950"
                        @click="handleSaveCustomRate(code)"
                      >
                        {{ t('backup.googleSaveClientId') }}
                      </button>
                      <button
                        v-if="store.getRememberedExchangeRate(code, store.defaultCurrency) !== null"
                        type="button"
                        class="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300"
                        @click="handleUseLiveRateForCurrency(code)"
                      >
                        {{ t('rates.useLiveShort') }}
                      </button>
                    </div>
                  </li>
                </ul>
              </section>

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

            <!-- 分頁 4：資料（本地備份 ＋ 已封存專案 ＋ 最近刪除回收桶） -->
            <div v-else-if="activeTab === 'data'" class="space-y-6">
              <!-- 本地備份 -->
              <section class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">
                  <HardDrive class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>{{ t('backup.localTitle') }}</span>
                </div>
                <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {{ t('backup.localDesc') }}
                </p>

                <!-- 本機資料與圖片占用空間概覽 -->
                <div
                  class="grid grid-cols-3 gap-2 rounded-xl border border-slate-200/80 bg-white px-3 py-2 text-center dark:border-slate-800 dark:bg-slate-900"
                >
                  <div>
                    <div class="text-[10px] text-slate-400">
                      {{ t('backup.storageProjectsLabel') }}
                    </div>
                    <div class="text-xs font-extrabold tabular-nums text-slate-900 dark:text-white">
                      {{ store.storageUsageStats.projectCount }}
                    </div>
                  </div>
                  <div class="border-x border-slate-100 dark:border-slate-800">
                    <div class="text-[10px] text-slate-400">
                      {{ t('backup.storageEntriesLabel') }}
                    </div>
                    <div class="text-xs font-extrabold tabular-nums text-slate-900 dark:text-white">
                      {{ store.storageUsageStats.transactionCount }}
                    </div>
                  </div>
                  <div>
                    <div class="text-[10px] text-slate-400">
                      {{ t('backup.storageImagesLabel') }}
                    </div>
                    <div class="text-xs font-extrabold tabular-nums text-emerald-700 dark:text-emerald-400">
                      {{ formatBytesLabel(store.storageUsageStats.totalImageBytes) }}
                    </div>
                  </div>
                </div>

                <div class="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
                    @click="handleExportLocalJson(false)"
                  >
                    <Download class="h-4 w-4" />
                    <span>{{ t('backup.exportButton') }}</span>
                  </button>

                  <button
                    v-if="store.storageUsageStats.receiptImageCount > 0"
                    type="button"
                    class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs font-bold text-emerald-800 transition hover:bg-emerald-100 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-300"
                    @click="handleExportLocalJson(true)"
                  >
                    <Download class="h-3.5 w-3.5" />
                    <span>{{ t('backup.exportLiteButton') }}</span>
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

              <!-- 已封存專案（點擊可檢視或一鍵取消封存還原） -->
              <section class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">
                  <Archive class="h-4 w-4 text-amber-500" />
                  <span>{{
                    t('project.archivedSectionTitle', {
                      count: store.archivedProjects.length,
                    })
                  }}</span>
                </div>

                <p
                  v-if="store.archivedProjects.length === 0"
                  class="py-3 text-center text-xs text-slate-400 dark:text-slate-500"
                >
                  {{ t('project.archivedEmpty') }}
                </p>

                <ul v-else class="divide-y divide-slate-200/70 dark:divide-slate-800">
                  <li
                    v-for="proj in store.archivedProjects"
                    :key="proj.id"
                    class="flex items-center justify-between gap-2 py-2.5"
                  >
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left transition hover:opacity-80"
                      @click="handleOpenArchivedProject(proj.id)"
                    >
                      <div class="truncate text-xs font-bold text-slate-800 dark:text-slate-100">
                        {{ proj.name }}
                      </div>
                      <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                        <span class="inline-flex items-center -space-x-1">
                          <MemberAvatar
                            v-for="m in getHumanMembers(proj).slice(0, 4)"
                            :key="m.id"
                            :name="m.name"
                            :color="m.avatarColor"
                            :image="m.avatarImage"
                            size="xxs"
                            ring
                          />
                        </span>
                        <span>{{ t('project.memberCount', { count: getHumanMembers(proj).length }) }}</span>
                        <span>·</span>
                        <span class="font-bold tabular-nums text-slate-600 dark:text-slate-300">
                          {{ fmt(store.getProjectTotalExpense(proj.id), proj.baseCurrency) }}
                        </span>
                      </div>
                    </button>
                    <button
                      type="button"
                      class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300"
                      @click="handleUnarchiveProject(proj.id)"
                    >
                      <ArchiveRestore class="h-3.5 w-3.5" />
                      <span>{{ t('project.unarchiveButton') }}</span>
                    </button>
                  </li>
                </ul>
              </section>

              <!-- 最近刪除（回收桶：支援已刪除專案整批復原與個別帳目復原） -->
              <section class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">
                    <Trash2 class="h-4 w-4 text-rose-500" />
                    <span>{{ t('trash.title') }}</span>
                    <span
                      v-if="totalTrashCount > 0"
                      class="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950/70 dark:text-rose-300"
                    >
                      {{ totalTrashCount }}
                    </span>
                  </div>
                  <button
                    v-if="totalTrashCount > 0"
                    type="button"
                    class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1 text-[11px] font-bold text-rose-600 transition hover:bg-rose-100 dark:bg-rose-950/60 dark:text-rose-300"
                    @click="handleEmptyTrash"
                  >
                    <Trash2 class="h-3 w-3" />
                    <span>{{ t('trash.emptyAll') }}</span>
                  </button>
                </div>

                <p
                  v-if="totalTrashCount === 0"
                  class="py-4 text-center text-xs text-slate-400 dark:text-slate-500"
                >
                  {{ t('trash.empty') }}
                </p>

                <div v-else class="space-y-3">
                  <!-- 已刪除專案（可一鍵連同底下帳目完整救回） -->
                  <div v-if="store.deletedProjects.length > 0" class="space-y-1.5">
                    <div class="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                      {{ t('trash.deletedProjectsLabel') }} ({{ store.deletedProjects.length }})
                    </div>
                    <ul class="divide-y divide-slate-200/70 rounded-xl border border-slate-200/80 bg-white px-3 dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                      <li
                        v-for="proj in store.deletedProjects"
                        :key="proj.id"
                        class="flex items-center justify-between gap-2 py-2.5"
                      >
                        <div class="min-w-0">
                          <div class="truncate text-xs font-bold text-slate-800 dark:text-slate-100">
                            {{ proj.name }}
                          </div>
                          <div class="text-[11px] text-slate-400">
                            {{ t('project.memberCount', { count: getHumanMembers(proj).length }) }} · {{ proj.baseCurrency }}
                          </div>
                        </div>
                        <div class="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            class="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300"
                            @click="handleRestoreProject(proj.id)"
                          >
                            <Undo2 class="h-3.5 w-3.5" />
                            <span>{{ t('trash.restore') }}</span>
                          </button>
                          <button
                            type="button"
                            :title="t('trash.deleteForever')"
                            class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
                            @click="handlePermanentDeleteProject(proj.id, proj.name)"
                          >
                            <Trash2 class="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    </ul>
                  </div>

                  <!-- 已刪除帳目 -->
                  <ul
                    v-if="store.deletedTransactions.length > 0"
                    class="divide-y divide-slate-200/70 dark:divide-slate-800"
                  >
                    <li
                      v-for="tx in store.deletedTransactions"
                      :key="tx.id"
                      class="flex items-center justify-between gap-2 py-2.5"
                    >
                      <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                            {{ tx.note || getCategoryLabelByKey(tx.categoryKey) }}
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
              </section>
            </div>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>
