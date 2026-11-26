<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
} from 'lucide-vue-next'
import { useClipboardShare } from '@/composables/useClipboardShare'
import {
  buildGoogleConnectLink,
  GoogleClientIdSchema,
} from '@/core/googleConnectLink'
import { useLedgerStore } from '@/stores/ledgerStore'

const emit = defineEmits<{
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()
const { copyText } = useClipboardShare()

// Google 雲端跨裝置同步狀態（優先讀取建置期內建 VITE_GOOGLE_CLIENT_ID，使用者無需手動輸入）
const builtInGoogleClientId = store.getBuiltInGoogleClientId()
const hasBuiltInClientId = store.hasBuiltInGoogleClientId()
const customGoogleClientId = ref(store.getCustomGoogleClientId())
const showAdvancedGoogleConfig = ref(false)
const showGoogleGuide = ref(false)
const currentOrigin =
  typeof window !== 'undefined' ? window.location.origin : ''

const effectiveGoogleClientId = computed(
  () => customGoogleClientId.value.trim() || builtInGoogleClientId,
)

const canShareGoogleConnectLink = computed(() =>
  GoogleClientIdSchema.safeParse(effectiveGoogleClientId.value).success,
)

const isGoogleBusy = computed(() => store.googleDriveStatus === 'syncing')

const googleAccountInitial = computed(() => {
  const name =
    store.googleDriveAccount?.displayName ||
    store.googleDriveAccount?.email ||
    'G'
  const trimmed = name.trim()
  return (Array.from(trimmed)[0] ?? 'G').toUpperCase()
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

function resolveGoogleErrorReason(err: unknown): string {
  const code = store.getGoogleDriveErrorCode(err)
  if (code) {
    const key = `backup.errors.${code}`
    const translated = t(key)
    return translated === key ? t('backup.errors.ERR_UNKNOWN') : translated
  }
  return t('backup.errors.ERR_UNKNOWN')
}

function handleSaveGoogleClientId() {
  const trimmed = customGoogleClientId.value.trim()
  store.saveGoogleClientId(trimmed)
  if (!trimmed && hasBuiltInClientId) {
    emit('toast', t('backup.googleResetBuiltInToast'))
    return
  }
  emit('toast', t('backup.googleClientIdSavedToast'))
}

function handleResetBuiltInClientId() {
  customGoogleClientId.value = ''
  store.saveGoogleClientId('')
  emit('toast', t('backup.googleResetBuiltInToast'))
}

async function handleCopyCurrentOrigin() {
  if (!currentOrigin) return
  const copied = await copyText(currentOrigin)
  if (copied) {
    emit('toast', t('backup.googleOriginCopiedToast'))
  }
}

async function handleCopyGoogleConnectLink() {
  if (!canShareGoogleConnectLink.value || typeof window === 'undefined') return
  const baseUrl = `${window.location.origin}${window.location.pathname}`
  const link = buildGoogleConnectLink(baseUrl, effectiveGoogleClientId.value)
  const copied = await copyText(link)
  emit(
    'toast',
    copied ? t('backup.googlePairLinkCopiedToast') : t('share.failedToast'),
  )
}

async function handleGoogleUpload(selectAccount = false) {
  const activeClientId = effectiveGoogleClientId.value
  if (!activeClientId) {
    emit('toast', t('backup.googleNeedClientId'))
    return
  }
  if (customGoogleClientId.value.trim()) {
    store.saveGoogleClientId(customGoogleClientId.value.trim())
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
    store.saveGoogleClientId(customGoogleClientId.value.trim())
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
    next
      ? t('backup.googleAutoSyncEnabledToast')
      : t('backup.googleAutoSyncDisabledToast'),
  )
}

function handleGoogleDisconnect() {
  store.disconnectGoogleDriveAccount()
  emit('toast', t('backup.googleDisconnectedToast'))
}
</script>

<template>
  <!-- Google 帳號與跨裝置自動同步 -->
  <section
    class="space-y-3 rounded-2xl border border-sky-200/80 bg-sky-50/40 p-4 dark:border-sky-900/60 dark:bg-sky-950/20"
  >
    <div class="flex items-center justify-between gap-2">
      <div
        class="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white"
      >
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
          <div
            class="truncate text-xs font-bold text-slate-900 dark:text-white"
          >
            {{ store.googleDriveAccount.displayName }}
          </div>
          <div
            class="truncate text-[10px] text-slate-500 dark:text-slate-400"
          >
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
        <p
          class="mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400"
        >
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
            store.googleDriveAutoSync ? 'translate-x-[18px]' : 'translate-x-0.5'
          "
        />
      </button>
    </div>

    <!-- 已內建官方共用 Client ID：預設隱藏輸入框，一鍵即可同步 -->
    <div v-if="hasBuiltInClientId" class="space-y-2">
      <div
        class="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-[11px] font-medium text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200"
      >
        <CheckCircle2
          class="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        />
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
        <label
          class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
        >
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

    <div
      class="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400"
    >
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
            : store.googleDriveLastErrorDetail || t('backup.errors.ERR_UNKNOWN'),
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
        <RefreshCw v-else-if="store.googleDriveAccount" class="h-4 w-4" />
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
</template>
