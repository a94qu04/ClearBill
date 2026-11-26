<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft,
  Check,
  Cloud,
  CloudOff,
  Copy,
  ExternalLink,
  LayoutGrid,
  Loader2,
  Receipt,
  Settings,
  Undo2,
  X,
} from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useClipboardShare } from '@/composables/useClipboardShare'
import { useHashRoute } from '@/composables/useHashRoute'
import { usePwaLifecycle } from '@/composables/usePwaLifecycle'
import type { ParsedQuickIntakeResult } from '@/core/quickIntakeParser'
import type {
  ShareInviteParams,
  Transaction,
} from '@/schemas/ledgerSchema'
import type { SettingsTab } from '@/components/SettingsModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { EntryMode } from '@/components/EntryModeSelector.vue'
import ProjectExpenseModal from '@/components/ProjectExpenseModal.vue'
import SettlementPaymentModal from '@/components/SettlementPaymentModal.vue'
import HomeView from '@/views/HomeView.vue'
import ProjectCreateView from '@/views/ProjectCreateView.vue'
import ProjectView, { type ProjectTab } from '@/views/ProjectView.vue'

// 懶載入大型彈窗與輔助抽屜，大幅縮小首屏初始載入體積
const AllProjectsModal = defineAsyncComponent(
  () => import('@/components/AllProjectsModal.vue'),
)
const JoinSharedProjectModal = defineAsyncComponent(
  () => import('@/components/JoinSharedProjectModal.vue'),
)
const PhotoLightboxModal = defineAsyncComponent(
  () => import('@/components/PhotoLightboxModal.vue'),
)
const PoolCollectModal = defineAsyncComponent(
  () => import('@/components/PoolCollectModal.vue'),
)
const ProjectShareModal = defineAsyncComponent(
  () => import('@/components/ProjectShareModal.vue'),
)
const SettingsModal = defineAsyncComponent(
  () => import('@/components/SettingsModal.vue'),
)
const SyncDeletionGuardModal = defineAsyncComponent(
  () => import('@/components/SyncDeletionGuardModal.vue'),
)

type ActiveView = 'home' | 'project_create' | 'project_workspace'

const { t } = useI18n()
const store = useLedgerStore()
const { copyText } = useClipboardShare()

// 視圖與全域 UI 狀態
const activeView = ref<ActiveView>('home')
const projectTab = ref<ProjectTab>('expenses')
const settingsOpen = ref(false)
const settingsInitialTab = ref<SettingsTab>('profile')
const allProjectsSheetOpen = ref(false)
const shareModalOpen = ref(false)
const poolCollectModalOpen = ref(false)
const editingPoolTx = ref<Transaction | null>(null)
const pendingJoinInvite = ref<ShareInviteParams | null>(null)
const previewPhotos = ref<string[]>([])
const previewPhotoIndex = ref(0)

// 視圖元件 ref（用於復原時清除篩選與建立專案防誤離）
const homeViewRef = ref<InstanceType<typeof HomeView> | null>(null)
const projectCreateViewRef = ref<InstanceType<typeof ProjectCreateView> | null>(null)
const projectViewRef = ref<InstanceType<typeof ProjectView> | null>(null)

// Toast 與即時刪除復原狀態（支援 6 秒內連刪多筆全部一鍵復原，不再覆蓋遺失）
const toastMessage = ref('')
const undoDeletedTxIds = ref<string[]>([])
let toastTimer: ReturnType<typeof setTimeout> | null = null
let undoClearTimer: ReturnType<typeof setTimeout> | null = null

// 支出與還款彈窗狀態
const expenseModalFromHome = ref(false)
const expenseInitialTxType = ref<'expense' | 'refund'>('expense')
const projExpenseSheetOpen = ref(false)
const editingExpenseTx = ref<Transaction | null>(null)
const duplicateExpenseTx = ref<Transaction | null>(null)
const quickIntakePrefill = ref<ParsedQuickIntakeResult | null>(null)

const settleSheetOpen = ref(false)
const editingSettleTx = ref<Transaction | null>(null)
const settleInitialFromId = ref('')
const settleInitialToId = ref('')
const settleSuggestedAmount = ref<number | null>(null)
const settleCurrency = ref<string | null>(null)

function showToast(message: string, undoTxId: string | null = null) {
  toastMessage.value = message
  if (undoTxId) {
    if (!undoDeletedTxIds.value.includes(undoTxId)) {
      undoDeletedTxIds.value = [...undoDeletedTxIds.value, undoTxId]
    }
    if (undoClearTimer) clearTimeout(undoClearTimer)
    undoClearTimer = setTimeout(() => {
      undoDeletedTxIds.value = []
      undoClearTimer = null
    }, 6000)
  }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(
    () => {
      toastMessage.value = ''
    },
    undoDeletedTxIds.value.length > 0 ? 6000 : 2800,
  )
}

function openSettingsModal(tab: SettingsTab = 'profile') {
  settingsInitialTab.value = tab
  settingsOpen.value = true
}

async function handleCopyCurrentPageUrl() {
  if (typeof window === 'undefined') return
  const copied = await copyText(window.location.href)
  showToast(copied ? t('inApp.copiedUrlToast') : t('share.failedToast'))
}

const googleCloudButtonTitle = computed(() => {
  switch (store.googleDriveStatus) {
    case 'syncing':
      return t('backup.googleStatusSyncing')
    case 'synced':
      return t('backup.googleQuickSyncTip')
    case 'pending':
      return t('backup.googleStatusPending')
    case 'needs_auth':
      return t('backup.googleReconnectButton')
    case 'offline':
      return t('backup.googleStatusOffline')
    case 'error':
      return t('backup.googleStatusError')
    default:
      return t('backup.googleQuickConnectTip')
  }
})

async function handleTopBarGoogleCloudClick() {
  if (store.googleDriveStatus === 'syncing') return
  if (
    store.googleDriveStatus === 'synced' ||
    store.googleDriveStatus === 'pending' ||
    store.googleDriveStatus === 'needs_auth'
  ) {
    try {
      const res = await store.syncGoogleDriveNow({
        enableAutoSyncOnSuccess: true,
      })
      if (!res) return
      if (res.skippedNoChanges) {
        showToast(t('backup.googleAlreadyUpToDate'))
      } else if (res.hadRemoteFile && res.mergeStats) {
        showToast(
          t('backup.googleSyncMergedSuccess', {
            pAdd: res.mergeStats.projectsAdded,
            pUpd: res.mergeStats.projectsUpdated,
            tAdd: res.mergeStats.transactionsAdded,
            tUpd: res.mergeStats.transactionsUpdated,
          }),
        )
      } else {
        showToast(t('backup.googleUploadSuccess'))
      }
    } catch (err) {
      const code = store.getGoogleDriveErrorCode(err) ?? 'ERR_UNKNOWN'
      const key = `backup.errors.${code}`
      const translated = t(key)
      showToast(
        t('backup.googleSyncError', {
          reason: translated === key ? t('backup.errors.ERR_UNKNOWN') : translated,
        }),
      )
      openSettingsModal('profile')
    }
    return
  }

  openSettingsModal('profile')
}

function openPhotoLightbox(payload: { photos: string[]; index: number }) {
  previewPhotos.value = payload.photos
  previewPhotoIndex.value = payload.index
}

function closePhotoLightbox() {
  previewPhotos.value = []
  previewPhotoIndex.value = 0
}

const topBarTitle = computed(() => {
  if (activeView.value === 'project_create') return t('project.createTitle')
  if (activeView.value === 'project_workspace' && store.activeProject) {
    return store.activeProject.name
  }
  return t('app.name')
})

// ==================== 視圖與專案導覽 ====================
async function requestNavigateHome() {
  if (activeView.value === 'project_create') {
    const canLeave =
      (await projectCreateViewRef.value?.confirmLeaveIfDirty()) ?? true
    if (!canLeave) return
  }
  activeView.value = 'home'
}

function openProjectWorkspace(
  projectId?: string,
  initialTab: ProjectTab = 'expenses',
) {
  allProjectsSheetOpen.value = false
  if (projectId) {
    store.selectProject(projectId)
  }
  if (store.activeProject) {
    projectTab.value = initialTab
    activeView.value = 'project_workspace'
  } else {
    openCreateProjectView()
  }
}

function openCreateProjectView() {
  allProjectsSheetOpen.value = false
  activeView.value = 'project_create'
}

function handleProjectCreated() {
  projectTab.value = 'expenses'
  activeView.value = 'project_workspace'
}

/** 刪除專案後一律返回首頁並重設分頁，避免原地切到下一個專案的設定頁造成連環誤刪 */
function handleProjectDeleted() {
  projectTab.value = 'expenses'
  activeView.value = 'home'
}

// 遠端同步或備份合併導致目前專案不存在時，自動退回首頁防止空白主畫面
watch(
  () => store.activeProject,
  (proj) => {
    if (!proj && activeView.value === 'project_workspace') {
      projectTab.value = 'expenses'
      activeView.value = 'home'
    }
  },
)

function handleJoinedSharedProject(projectId: string) {
  pendingJoinInvite.value = null
  store.selectProject(projectId)
  projectTab.value = 'expenses'
  activeView.value = 'project_workspace'
}

// ==================== 支出／還款新增、修改、刪除與復原 ====================
function openHomeQuickAddExpense() {
  const targetProject = store.getLastExpenseProject()
  if (!targetProject) {
    openCreateProjectView()
    return
  }
  store.selectProject(targetProject.id)
  expenseModalFromHome.value = true
  expenseInitialTxType.value = 'expense'
  editingExpenseTx.value = null
  duplicateExpenseTx.value = null
  quickIntakePrefill.value = null
  projExpenseSheetOpen.value = true
}

function openAddProjectExpenseSheet() {
  expenseModalFromHome.value = false
  expenseInitialTxType.value = 'expense'
  editingExpenseTx.value = null
  duplicateExpenseTx.value = null
  quickIntakePrefill.value = null
  projExpenseSheetOpen.value = true
}

function handleSwitchEntryMode(mode: EntryMode) {
  if (mode === 'expense' || mode === 'refund') {
    settleSheetOpen.value = false
    poolCollectModalOpen.value = false
    editingPoolTx.value = null
    editingExpenseTx.value = null
    duplicateExpenseTx.value = null
    quickIntakePrefill.value = null
    expenseInitialTxType.value = mode
    projExpenseSheetOpen.value = true
    return
  }
  if (mode === 'transfer') {
    projExpenseSheetOpen.value = false
    poolCollectModalOpen.value = false
    editingPoolTx.value = null
    editingSettleTx.value = null
    settleInitialFromId.value = ''
    settleInitialToId.value = ''
    settleSuggestedAmount.value = null
    settleCurrency.value = null
    settleSheetOpen.value = true
    return
  }
  if (mode === 'pool') {
    projExpenseSheetOpen.value = false
    settleSheetOpen.value = false
    editingPoolTx.value = null
    poolCollectModalOpen.value = true
  }
}

function closeProjectExpenseSheet() {
  projExpenseSheetOpen.value = false
  expenseModalFromHome.value = false
  editingExpenseTx.value = null
  duplicateExpenseTx.value = null
  quickIntakePrefill.value = null
}

function startDuplicateTransaction(tx: Transaction) {
  const originalTx =
    store.visibleTransactions.find((item) => item.id === tx.id) ?? tx
  const targetProject = store.getProjectById(originalTx.projectId)
  if (!targetProject || originalTx.type === 'transfer') return
  store.selectProject(targetProject.id)
  editingExpenseTx.value = null
  quickIntakePrefill.value = null
  duplicateExpenseTx.value = originalTx
  projExpenseSheetOpen.value = true
}

/** 編輯交易：一律從資料庫正本讀取（避免結算匯率副本覆寫原匯率），維持當前頁面不跳轉 */
function startEditTransaction(tx: Transaction) {
  const originalTx =
    store.visibleTransactions.find((item) => item.id === tx.id) ?? tx
  const targetProject = store.getProjectById(originalTx.projectId)
  if (!targetProject) return

  store.selectProject(targetProject.id)
  duplicateExpenseTx.value = null
  quickIntakePrefill.value = null

  if (originalTx.type === 'transfer') {
    if (store.isPoolCollectionTransaction(originalTx, targetProject)) {
      editingPoolTx.value = originalTx
      poolCollectModalOpen.value = true
      return
    }
    editingSettleTx.value = originalTx
    settleInitialFromId.value = ''
    settleInitialToId.value = ''
    settleSuggestedAmount.value = null
    settleCurrency.value = originalTx.currency
    settleSheetOpen.value = true
    return
  }

  editingExpenseTx.value = originalTx
  projExpenseSheetOpen.value = true
}

function openRecordSettlementModal(payload: {
  fromMemberId: string
  toMemberId: string
  amount: number
  currency?: string
}) {
  editingSettleTx.value = null
  settleInitialFromId.value = payload.fromMemberId
  settleInitialToId.value = payload.toMemberId
  settleSuggestedAmount.value = payload.amount
  settleCurrency.value = payload.currency ?? null
  settleSheetOpen.value = true
}

function openPoolCollectModal() {
  editingPoolTx.value = null
  poolCollectModalOpen.value = true
}

async function handleDeleteTransaction(id: string) {
  await store.softDeleteTransaction(id)
  showToast(t('trash.deletedUndoToast'), id)
}

async function handleDeleteTransactionsBatch(ids: string[]) {
  const deletedIds = await store.softDeleteTransactionsBatch(ids)
  if (deletedIds.length === 0) return
  undoDeletedTxIds.value = Array.from(
    new Set([...undoDeletedTxIds.value, ...deletedIds]),
  )
  toastMessage.value = t('pool.batchUndoneToast', { count: deletedIds.length })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = ''
    undoDeletedTxIds.value = []
  }, 6000)
}

async function handleUndoDelete() {
  if (undoDeletedTxIds.value.length === 0) return
  const targetIds = [...undoDeletedTxIds.value]
  undoDeletedTxIds.value = []
  let restoredCount = 0
  let lastProjectId: string | undefined
  for (const id of targetIds) {
    const res = await store.restoreTransaction(id)
    if (res.ok) {
      restoredCount += 1
      if (res.projectId) lastProjectId = res.projectId
    }
  }
  if (restoredCount > 0) {
    if (lastProjectId) {
      store.selectProject(lastProjectId)
    }
    homeViewRef.value?.resetFilters()
    projectViewRef.value?.resetFilters()
    showToast(
      restoredCount > 1
        ? t('trash.restoredMultiToast', { count: restoredCount })
        : t('trash.restoredToast'),
    )
  }
}

function handleRestoredFromSettings(projectId?: string) {
  homeViewRef.value?.resetFilters()
  projectViewRef.value?.resetFilters()
  if (projectId) {
    store.selectProject(projectId)
    projectTab.value = 'expenses'
    activeView.value = 'project_workspace'
  }
}

// ==================== Hash 路由與 PWA 生命週期 ====================
const hashRoute = useHashRoute({
  getActiveProject: () => store.activeProject,
  getDefaultCurrency: () => store.defaultCurrency,
  saveClientId: (clientId) => store.saveGoogleClientId(clientId),
  onGoogleConnected: () => {
    openSettingsModal('profile')
    showToast(t('backup.googlePairLinkAppliedToast'))
  },
  onGoogleConnectInvalid: () => {
    showToast(t('backup.errors.ERR_MISSING_CLIENT_ID'))
  },
  onJoinInvite: (invite) => {
    pendingJoinInvite.value = invite
  },
  onJoinInvalid: () => {
    showToast(t('realtime.errors.ERR_PERMISSION_DENIED'))
  },
  onQuickIntakeApplied: (parsed) => {
    editingExpenseTx.value = null
    quickIntakePrefill.value = parsed
    activeView.value = 'project_workspace'
    projectTab.value = 'expenses'
    projExpenseSheetOpen.value = true
    showToast(t('home.quickIntakeApplied', { source: parsed.sourceApp }))
  },
  onQuickIntakeNeedProject: () => {
    showToast(t('home.quickIntakeNeedProject'))
    openCreateProjectView()
  },
})

const { isDark, setTheme, isTouchDevice, inAppBrowser, inAppBannerDismissed } =
  usePwaLifecycle({
    onReady: () => {
      hashRoute.processCurrentHash()
      hashRoute.startListening()
    },
  })

let isSyncingFromPopstate = false

watch(activeView, (nextView, prevView) => {
  if (typeof window === 'undefined' || isSyncingFromPopstate) return
  // 從首頁進入專案工作區或建立專案頁時推入一筆瀏覽器歷史紀錄，讓手機系統返回鍵可自然退回首頁而非直接跳離 App
  if (prevView === 'home' && nextView !== 'home') {
    try {
      window.history.pushState({ clearbillView: nextView }, '')
    } catch {
      // 忽略受限環境
    }
  }
})

function handleBrowserPopState() {
  if (activeView.value === 'home') return
  isSyncingFromPopstate = true
  activeView.value = 'home'
  projectTab.value = 'expenses'
  void nextTick(() => {
    isSyncingFromPopstate = false
  })
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', handleBrowserPopState)
  }
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('popstate', handleBrowserPopState)
  }
  if (toastTimer) clearTimeout(toastTimer)
  if (undoClearTimer) {
    clearTimeout(undoClearTimer)
    undoClearTimer = null
  }
})
</script>

<template>
  <div
    class="safe-bottom-page min-h-screen bg-[#F2F2F7] text-slate-900 transition-colors duration-200 dark:bg-black dark:text-slate-100"
  >
    <!-- Apple 極簡毛玻璃頂部導覽列（支援 iOS Safe Area、工作區不重複顯示專案標題） -->
    <header
      class="safe-top sticky top-0 z-30 border-b border-black/[0.06] bg-[#F2F2F7]/85 backdrop-blur-xl transition-colors dark:border-white/10 dark:bg-black/85"
    >
      <div class="mx-auto flex h-13 max-w-xl items-center justify-between gap-2 px-4 py-2 md:max-w-3xl lg:max-w-5xl">
        <div class="flex min-w-0 items-center gap-2">
          <!-- 專案工作區：簡潔返回鍵（不與下方卡片重複專案標題） -->
          <button
            v-if="activeView === 'project_workspace'"
            type="button"
            :aria-label="t('home.backToHome')"
            class="-ml-1 inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm font-semibold text-emerald-600 transition hover:bg-black/[0.05] active:scale-95 dark:text-emerald-400 dark:hover:bg-white/10"
            @click="requestNavigateHome"
          >
            <ArrowLeft class="h-4 w-4" />
            <span>{{ t('home.backToHome') }}</span>
          </button>

          <!-- 建立專案頁：返回鍵 + 標題 -->
          <template v-else-if="activeView === 'project_create'">
            <button
              type="button"
              :aria-label="t('home.backToHome')"
              class="-ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-600 transition hover:bg-black/[0.06] active:scale-95 dark:text-slate-300 dark:hover:bg-white/10"
              @click="requestNavigateHome"
            >
              <ArrowLeft class="h-4 w-4" />
            </button>
            <h1 class="truncate text-sm font-bold tracking-tight text-slate-900 dark:text-white sm:text-base">
              {{ topBarTitle }}
            </h1>
          </template>

          <!-- 首頁：品牌收據圖示 + 名稱 -->
          <template v-else>
            <button
              type="button"
              :aria-label="t('home.backToHome')"
              :title="t('app.name')"
              class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-emerald-400 shadow-sm transition hover:scale-105 active:scale-95 dark:bg-emerald-500/20"
              @click="activeView = 'home'"
            >
              <Receipt class="h-3.5 w-3.5" />
            </button>
            <h1 class="truncate text-base font-bold tracking-tight text-slate-900 dark:text-white">
              {{ topBarTitle }}
            </h1>
          </template>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <button
            v-if="
              activeView === 'project_workspace' &&
              store.allNonDeletedProjects.length > 0
            "
            type="button"
            class="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-black/[0.05] px-2.5 text-[11px] font-semibold text-slate-700 transition hover:bg-black/[0.09] dark:bg-white/10 dark:text-slate-200 dark:hover:bg-white/15"
            @click="allProjectsSheetOpen = true"
          >
            <LayoutGrid class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>{{
              t('home.viewAllProjects', {
                count: store.allNonDeletedProjects.length,
              })
            }}</span>
          </button>

          <!-- Google 雲端跨裝置同步快捷按鈕（無框輕量圓角膠囊） -->
          <button
            type="button"
            :aria-label="googleCloudButtonTitle"
            :title="googleCloudButtonTitle"
            class="relative inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full px-2.5 text-[11px] font-semibold transition active:scale-95"
            :class="
              store.googleDriveStatus === 'synced'
                ? 'bg-sky-500/12 text-sky-700 hover:bg-sky-500/20 dark:bg-sky-400/15 dark:text-sky-300'
                : store.googleDriveStatus === 'pending' ||
                    store.googleDriveStatus === 'needs_auth'
                  ? 'bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300'
                  : store.googleDriveStatus === 'error'
                    ? 'bg-rose-500/12 text-rose-700 hover:bg-rose-500/20 dark:bg-rose-400/15 dark:text-rose-300'
                    : 'bg-black/[0.05] text-slate-600 hover:bg-black/[0.09] hover:text-slate-900 dark:bg-white/10 dark:text-slate-300 dark:hover:bg-white/15'
            "
            @click="handleTopBarGoogleCloudClick"
          >
            <Loader2
              v-if="store.googleDriveStatus === 'syncing'"
              class="h-3.5 w-3.5 animate-spin text-sky-500"
            />
            <CloudOff
              v-else-if="store.googleDriveStatus === 'offline'"
              class="h-3.5 w-3.5 text-slate-400"
            />
            <Cloud v-else class="h-3.5 w-3.5" />
            <span
              v-if="store.googleDriveStatus === 'needs_auth'"
              class="hidden sm:inline"
            >
              {{ t('backup.googleShortReconnect') }}
            </span>
            <span
              v-else-if="store.googleDriveStatus === 'synced'"
              class="h-1.5 w-1.5 rounded-full bg-emerald-500"
            />
            <span
              v-else-if="store.googleDriveStatus === 'pending'"
              class="h-1.5 w-1.5 rounded-full bg-amber-500"
            />
          </button>

          <!-- 右上角設定齒輪按鈕 -->
          <button
            type="button"
            :aria-label="t('settings.title')"
            :title="t('settings.title')"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-slate-600 transition hover:bg-black/[0.09] hover:text-slate-900 active:scale-95 dark:bg-white/10 dark:text-slate-300 dark:hover:bg-white/15 dark:hover:text-white"
            @click="openSettingsModal('profile')"
          >
            <Settings class="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>

    <!-- 輕量提示 Toast（透過 Teleport 掛載至 body 最上層 z-[80]，絕不被彈窗遮罩蓋住） -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 translate-y-2"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 translate-y-2"
      >
        <div
          v-if="toastMessage"
          role="status"
          class="safe-toast-bottom fixed left-1/2 z-[80] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-2xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white shadow-xl dark:bg-slate-100 dark:text-slate-950 sm:rounded-full sm:px-4"
        >
          <Check class="h-3.5 w-3.5 shrink-0 text-emerald-400 dark:text-emerald-600" />
          <span class="break-words leading-snug">{{ toastMessage }}</span>
          <button
            v-if="undoDeletedTxIds.length > 0"
            type="button"
            class="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-0.5 text-[11px] font-bold text-slate-950 transition hover:bg-emerald-400"
            @click="handleUndoDelete"
          >
            <Undo2 class="h-3 w-3" />
            <span>{{
              undoDeletedTxIds.length > 1
                ? `${t('trash.restore')} (${undoDeletedTxIds.length})`
                : t('trash.restore')
            }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>

    <main class="mx-auto max-w-xl px-4 pt-5 md:max-w-3xl lg:max-w-5xl">
      <!-- LINE / FB / IG / WeChat 內建瀏覽器偵測提醒橫幅 -->
      <div
        v-if="inAppBrowser.isInApp && !inAppBannerDismissed"
        class="mb-4 flex items-start justify-between gap-2.5 rounded-2xl border border-amber-300/80 bg-amber-50/90 px-3.5 py-2.5 text-xs text-amber-950 shadow-sm dark:border-amber-800/70 dark:bg-amber-950/50 dark:text-amber-100"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex items-center gap-1.5 font-bold">
            <ExternalLink class="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{{ t('inApp.title', { app: inAppBrowser.appName }) }}</span>
          </div>
          <p class="text-[11px] leading-relaxed opacity-90">
            {{ t('inApp.desc') }}
          </p>
          <button
            type="button"
            class="mt-1 inline-flex items-center gap-1 rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-amber-700"
            @click="handleCopyCurrentPageUrl"
          >
            <Copy class="h-3 w-3" />
            <span>{{ t('inApp.copyUrlButton') }}</span>
          </button>
        </div>
        <button
          type="button"
          :aria-label="t('settings.close')"
          class="rounded-lg p-1 text-amber-700/70 hover:bg-amber-200/50 dark:text-amber-300"
          @click="inAppBannerDismissed = true"
        >
          <X class="h-4 w-4" />
        </button>
      </div>

      <!-- 視圖 1：極簡首頁 -->
      <HomeView
        v-if="activeView === 'home'"
        ref="homeViewRef"
        :is-touch-device="isTouchDevice"
        @open-project="openProjectWorkspace($event)"
        @open-create-project="openCreateProjectView"
        @open-all-projects="allProjectsSheetOpen = true"
        @open-quick-add="openHomeQuickAddExpense"
        @demo-created="handleProjectCreated"
        @edit-tx="startEditTransaction"
        @duplicate-tx="startDuplicateTransaction"
        @delete-tx="handleDeleteTransaction"
        @preview-photos="openPhotoLightbox"
        @toast="showToast($event)"
      />

      <!-- 視圖 2：建立旅遊 / 分帳專案 -->
      <ProjectCreateView
        v-else-if="activeView === 'project_create'"
        ref="projectCreateViewRef"
        @created="handleProjectCreated"
        @toast="showToast($event)"
      />

      <!-- 視圖 3：分帳專案工作區 -->
      <ProjectView
        v-else-if="activeView === 'project_workspace' && store.activeProject"
        ref="projectViewRef"
        v-model:active-tab="projectTab"
        :project="store.activeProject"
        @open-share="shareModalOpen = true"
        @open-pool-collect="openPoolCollectModal"
        @open-add-expense="openAddProjectExpenseSheet"
        @record-payment="openRecordSettlementModal"
        @edit-tx="startEditTransaction"
        @duplicate-tx="startDuplicateTransaction"
        @delete-tx="handleDeleteTransaction"
        @delete-tx-batch="handleDeleteTransactionsBatch"
        @preview-photos="openPhotoLightbox"
        @project-deleted="handleProjectDeleted"
        @toast="showToast($event)"
      />
    </main>

    <!-- 側邊設定抽屜（一般／分類／幣別／Google 雲端跨裝置同步＋本地備份／復原與清空） -->
    <SettingsModal
      :open="settingsOpen"
      :is-dark="isDark"
      :initial-tab="settingsInitialTab"
      @close="settingsOpen = false"
      @set-theme="setTheme"
      @toast="showToast($event)"
      @restored="handleRestoredFromSettings"
      @select-project="openProjectWorkspace($event)"
    />

    <!-- 所有分帳專案清單（桌機拖曳＋觸控友善上移/下移排序） -->
    <AllProjectsModal
      :open="allProjectsSheetOpen"
      :is-touch-device="isTouchDevice"
      @close="allProjectsSheetOpen = false"
      @select-project="openProjectWorkspace($event)"
      @create-project="openCreateProjectView"
      @toast="showToast($event)"
    />

    <!-- 專案支出新增／修改抽屜 -->
    <ProjectExpenseModal
      :open="projExpenseSheetOpen"
      :project="store.activeProject"
      :editing-tx="editingExpenseTx"
      :duplicate-tx="duplicateExpenseTx"
      :prefill="quickIntakePrefill"
      :allow-project-switch="expenseModalFromHome"
      :initial-tx-type="expenseInitialTxType"
      @close="closeProjectExpenseSheet"
      @saved="showToast($event)"
      @preview-photos="openPhotoLightbox"
      @toast="showToast($event)"
      @switch-project="store.selectProject($event)"
      @switch-entry-mode="handleSwitchEntryMode"
    />

    <!-- 還款記錄／修改彈窗 -->
    <SettlementPaymentModal
      :open="settleSheetOpen"
      :project="store.activeProject"
      :editing-tx="editingSettleTx"
      :initial-from-id="settleInitialFromId"
      :initial-to-id="settleInitialToId"
      :suggested-amount="settleSuggestedAmount"
      :currency="settleCurrency"
      @close="settleSheetOpen = false"
      @saved="showToast($event)"
      @switch-entry-mode="handleSwitchEntryMode"
    />

    <!-- 大團公費袋／批次收公費彈窗（支援新增與編輯單筆合併公費帳目） -->
    <PoolCollectModal
      :open="poolCollectModalOpen"
      :project="store.activeProject"
      :editing-tx="editingPoolTx"
      @close="poolCollectModalOpen = false; editingPoolTx = null"
      @saved="showToast($event)"
      @switch-entry-mode="handleSwitchEntryMode"
    />

    <!-- 收據圖片全螢幕多圖預覽燈箱 -->
    <PhotoLightboxModal
      :photos="previewPhotos"
      :initial-index="previewPhotoIndex"
      @close="closePhotoLightbox"
    />

    <!-- 多人即時協作共享與邀請彈窗 -->
    <ProjectShareModal
      :open="shareModalOpen"
      :project="store.activeProject"
      @close="shareModalOpen = false"
      @toast="showToast($event)"
    />

    <!-- 旅伴透過 #/join 邀請連結入團與認領身分彈窗 -->
    <JoinSharedProjectModal
      :invite="pendingJoinInvite"
      @close="pendingJoinInvite = null"
      @joined="handleJoinedSharedProject"
      @toast="showToast($event)"
    />

    <!-- 異常大量遠端刪除熔斷保護視窗 -->
    <SyncDeletionGuardModal @toast="showToast($event)" />

    <!-- 全域自製確認對話框（完全取代原生 window.confirm） -->
    <ConfirmDialog />
  </div>
</template>
