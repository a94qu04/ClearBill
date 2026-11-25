<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  ArrowLeft,
  Check,
  Cloud,
  CloudOff,
  GripVertical,
  LayoutGrid,
  Loader2,
  Plus,
  Receipt,
  Settings,
  Sparkles,
  Undo2,
  Users,
  X,
} from 'lucide-vue-next'
import { AVATAR_PALETTE, useLedgerStore } from '@/stores/ledgerStore'
import { formatCurrencyAmount } from '@/core/currency'
import { parseGoogleConnectHash } from '@/core/googleConnectLink'
import { parseShareInviteHash } from '@/core/realtimeSyncEngine'
import { refreshLiveExchangeRates } from '@/services/exchangeRateService'
import {
  GoogleDriveSyncError,
  saveGoogleClientId,
} from '@/services/googleDriveSync'
import {
  parseQuickIntake,
  type ParsedQuickIntakeResult,
} from '@/core/quickIntakeParser'
import type {
  ShareInviteParams,
  SplitMode,
  Transaction,
} from '@/schemas/ledgerSchema'
import AllProjectsModal from '@/components/AllProjectsModal.vue'
import JoinSharedProjectModal from '@/components/JoinSharedProjectModal.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'
import PhotoLightboxModal from '@/components/PhotoLightboxModal.vue'
import ProjectExpenseModal from '@/components/ProjectExpenseModal.vue'
import ProjectSettleTab from '@/components/ProjectSettleTab.vue'
import ProjectSettingsTab from '@/components/ProjectSettingsTab.vue'
import ProjectShareModal from '@/components/ProjectShareModal.vue'
import SettingsModal, { type SettingsTab } from '@/components/SettingsModal.vue'
import SettlementPaymentModal from '@/components/SettlementPaymentModal.vue'
import SyncDeletionGuardModal from '@/components/SyncDeletionGuardModal.vue'
import TransactionListSection from '@/components/TransactionListSection.vue'

type ActiveView = 'home' | 'project_create' | 'project_workspace'
type ProjectTab = 'expenses' | 'settle' | 'settings'

const { t, locale } = useI18n()
const store = useLedgerStore()

// 視圖與全域 UI 狀態
const activeView = ref<ActiveView>('home')
const projectTab = ref<ProjectTab>('expenses')
const settingsOpen = ref(false)
const settingsInitialTab = ref<SettingsTab>('general')
const allProjectsSheetOpen = ref(false)
const shareModalOpen = ref(false)
const pendingJoinInvite = ref<ShareInviteParams | null>(null)
const isDark = ref(false)
const isTouchDevice = ref(false)
const previewPhotos = ref<string[]>([])
const previewPhotoIndex = ref(0)

function openSettingsModal(tab: SettingsTab = 'general') {
  settingsInitialTab.value = tab
  settingsOpen.value = true
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
      const code =
        err instanceof GoogleDriveSyncError ? err.code : 'ERR_UNKNOWN'
      const key = `backup.errors.${code}`
      const translated = t(key)
      showToast(
        t('backup.googleSyncError', {
          reason: translated === key ? t('backup.errors.ERR_UNKNOWN') : translated,
        }),
      )
      openSettingsModal('backup')
    }
    return
  }

  openSettingsModal('backup')
}

function openPhotoLightbox(payload: { photos: string[]; index: number }) {
  previewPhotos.value = payload.photos
  previewPhotoIndex.value = payload.index
}

function closePhotoLightbox() {
  previewPhotos.value = []
  previewPhotoIndex.value = 0
}

function copyMembersFromProject(sourceProjectId: string) {
  const source = store.getProjectById(sourceProjectId)
  if (!source) return
  projectMembersList.value = source.members.map((m) => m.name)
  newProjectMemberInput.value = ''
  showToast(
    t('project.membersCopiedToast', {
      name: source.name,
      count: source.members.length,
    }),
  )
}

// Toast 與即時刪除復原狀態
const toastMessage = ref('')
const undoDeletedTxId = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

// 專案網格拖曳排序狀態（桌機）
const draggingProjectId = ref<string | null>(null)
const dragOverProjectId = ref<string | null>(null)

// 建立新專案表單狀態（現代成員膠囊 Tag Chip）
const projectName = ref('')
const projectCurrency = ref(store.defaultCurrency)
const projectDefaultSplitMode = ref<SplitMode>('equal')
const projectMembersList = ref<string[]>([])
const newProjectMemberInput = ref('')
const projectFormError = ref('')

function commitNewMemberChips() {
  const raw = newProjectMemberInput.value
  if (!raw.trim()) return
  const parts = raw
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length > 0) {
    projectMembersList.value = [...projectMembersList.value, ...parts]
  }
  newProjectMemberInput.value = ''
}

function handleMemberInputKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
    event.preventDefault()
    commitNewMemberChips()
  } else if (
    event.key === 'Backspace' &&
    !newProjectMemberInput.value &&
    projectMembersList.value.length > 0
  ) {
    projectMembersList.value = projectMembersList.value.slice(0, -1)
  }
}

function removeMemberChip(index: number) {
  projectMembersList.value = projectMembersList.value.filter(
    (_, idx) => idx !== index,
  )
}

async function handleCreateDemoProject() {
  try {
    await store.createDemoProject({
      projectName: t('demo.projectName'),
      members: [t('demo.member1'), t('demo.member2'), t('demo.member3')],
      hotelNote: t('demo.hotelNote'),
      dinnerNote: t('demo.dinnerNote'),
      shoppingNote: t('demo.shoppingNote'),
      taxRefundNote: t('demo.taxRefundNote'),
      repaymentNote: t('demo.repaymentNote'),
    })
    projectTab.value = 'expenses'
    activeView.value = 'project_workspace'
    showToast(t('demo.createdToast'))
  } catch {
    showToast(t('home.saveFailed'))
  }
}

// 支出與還款彈窗狀態
const projExpenseSheetOpen = ref(false)
const editingExpenseTx = ref<Transaction | null>(null)
const quickIntakePrefill = ref<ParsedQuickIntakeResult | null>(null)

const settleSheetOpen = ref(false)
const editingSettleTx = ref<Transaction | null>(null)
const settleInitialFromId = ref('')
const settleInitialToId = ref('')
const settleSuggestedAmount = ref<number | null>(null)

// 列表元件 ref（用於復原時清除遮蔽篩選）
const homeTxListRef = ref<InstanceType<typeof TransactionListSection> | null>(null)
const projectTxListRef = ref<InstanceType<typeof TransactionListSection> | null>(null)

function syncThemeToDom(dark: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', dark)
  const themeMeta = document.querySelector('meta[name="theme-color"]')
  if (themeMeta) {
    themeMeta.setAttribute('content', dark ? '#020617' : '#ffffff')
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

function detectTouchDevice() {
  if (typeof window === 'undefined') return
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const touchPoints = navigator.maxTouchPoints ?? 0
  isTouchDevice.value = coarsePointer || touchPoints > 0
}

function setTheme(dark: boolean) {
  isDark.value = dark
  syncThemeToDom(dark)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('clearbill_theme', dark ? 'dark' : 'light')
  }
}

function showToast(message: string, undoTxId: string | null = null) {
  toastMessage.value = message
  undoDeletedTxId.value = undoTxId
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(
    () => {
      toastMessage.value = ''
      undoDeletedTxId.value = null
    },
    undoTxId ? 6000 : 2800,
  )
}

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}

const homeProjectTransactions = computed(() =>
  store.visibleTransactions.filter((tx) => {
    if (!tx.projectId) return false
    const proj = store.getProjectById(tx.projectId)
    return Boolean(proj && !proj.isArchived)
  }),
)

const activeProjectTotalSpent = computed(
  () => store.activeProjectSettleUp?.totalProjectExpense ?? 0,
)

const topBarTitle = computed(() => {
  if (activeView.value === 'project_create') return t('project.createTitle')
  if (activeView.value === 'project_workspace' && store.activeProject) {
    return store.activeProject.name
  }
  return t('app.name')
})

// ==================== 專案導覽與拖曳排序 ====================
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
  projectFormError.value = ''
  projectName.value = ''
  projectCurrency.value = store.defaultCurrency
  projectDefaultSplitMode.value = 'equal'
  projectMembersList.value = [
    store.userProfile.displayName || t('project.defaultMember1'),
    t('project.defaultMember2'),
    t('project.defaultMember3'),
  ]
  newProjectMemberInput.value = ''
  activeView.value = 'project_create'
}

async function handleCreateProject() {
  projectFormError.value = ''
  if (newProjectMemberInput.value.trim()) {
    commitNewMemberChips()
  }

  const trimmedName = projectName.value.trim()
  if (!trimmedName) {
    projectFormError.value = t('validation.projectNameRequired')
    return
  }

  const members = projectMembersList.value
    .map((m) => m.trim())
    .filter(Boolean)

  if (members.length < 2) {
    projectFormError.value = t('validation.membersRequired')
    return
  }

  try {
    await store.createProject({
      name: trimmedName,
      baseCurrency: projectCurrency.value,
      memberNames: members,
      defaultSplitMode: projectDefaultSplitMode.value,
    })
    projectTab.value = 'expenses'
    activeView.value = 'project_workspace'
  } catch {
    projectFormError.value = t('home.saveFailed')
  }
}

function handleProjectDeleted() {
  if (!store.activeProject) {
    activeView.value = 'home'
  }
}

function onProjectDragStart(projectId: string, event: DragEvent) {
  draggingProjectId.value = projectId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', projectId)
  }
}

function onProjectDragOver(projectId: string, event: DragEvent) {
  event.preventDefault()
  if (draggingProjectId.value && draggingProjectId.value !== projectId) {
    dragOverProjectId.value = projectId
  }
}

function onProjectDrop(targetId: string, event: DragEvent) {
  event.preventDefault()
  const sourceId =
    draggingProjectId.value || event.dataTransfer?.getData('text/plain') || ''
  if (sourceId && sourceId !== targetId) {
    store.reorderProjects(sourceId, targetId)
  }
  draggingProjectId.value = null
  dragOverProjectId.value = null
}

function onProjectDragEnd() {
  draggingProjectId.value = null
  dragOverProjectId.value = null
}

// ==================== 支出／還款新增、修改、刪除與復原 ====================
function openAddProjectExpenseSheet() {
  editingExpenseTx.value = null
  quickIntakePrefill.value = null
  projExpenseSheetOpen.value = true
}

function closeProjectExpenseSheet() {
  projExpenseSheetOpen.value = false
  quickIntakePrefill.value = null
}

/** 編輯交易：維持當前頁面不跳轉，在首頁修改完成或關閉皆留在首頁 */
function startEditTransaction(tx: Transaction) {
  const targetProject = store.getProjectById(tx.projectId)
  if (!targetProject) return

  store.selectProject(targetProject.id)
  quickIntakePrefill.value = null

  if (tx.type === 'transfer') {
    editingSettleTx.value = tx
    settleInitialFromId.value = ''
    settleInitialToId.value = ''
    settleSuggestedAmount.value = null
    settleSheetOpen.value = true
    return
  }

  editingExpenseTx.value = tx
  projExpenseSheetOpen.value = true
}

function openRecordSettlementModal(payload: {
  fromMemberId: string
  toMemberId: string
  amount: number
}) {
  editingSettleTx.value = null
  settleInitialFromId.value = payload.fromMemberId
  settleInitialToId.value = payload.toMemberId
  settleSuggestedAmount.value = payload.amount
  settleSheetOpen.value = true
}

async function handleDeleteTransaction(id: string) {
  await store.softDeleteTransaction(id)
  showToast(t('trash.deletedUndoToast'), id)
}

async function handleUndoDelete() {
  if (!undoDeletedTxId.value) return
  const targetId = undoDeletedTxId.value
  undoDeletedTxId.value = null
  const res = await store.restoreTransaction(targetId)
  if (res.ok) {
    if (res.projectId) {
      store.selectProject(res.projectId)
    }
    homeTxListRef.value?.resetFilters()
    projectTxListRef.value?.resetFilters()
    showToast(t('trash.restoredToast'))
  }
}

function handleRestoredFromSettings(projectId?: string) {
  homeTxListRef.value?.resetFilters()
  projectTxListRef.value?.resetFilters()
  if (projectId) {
    store.selectProject(projectId)
    projectTab.value = 'expenses'
    activeView.value = 'project_workspace'
  }
}

// 處理外部 Hash 路由：支援 #/join（多人共享）、#/connect-google（Google 雲端跨裝置配對）與 #/quick-add（iOS 捷徑）
function handleHashQuickAdd() {
  if (typeof window === 'undefined') return
  const hash = window.location.hash

  if (hash.startsWith('#/connect-google')) {
    const parsedConnect = parseGoogleConnectHash(hash)
    window.history.replaceState(null, '', window.location.pathname)
    if (parsedConnect) {
      saveGoogleClientId(parsedConnect.clientId)
      openSettingsModal('backup')
      showToast(t('backup.googlePairLinkAppliedToast'))
    } else {
      showToast(t('backup.errors.ERR_MISSING_CLIENT_ID'))
    }
    return
  }

  if (hash.startsWith('#/join')) {
    const invite = parseShareInviteHash(hash)
    window.history.replaceState(null, '', window.location.pathname)
    if (invite) {
      pendingJoinInvite.value = invite
    } else {
      showToast(t('realtime.errors.ERR_PERMISSION_DENIED'))
    }
    return
  }

  if (!hash.startsWith('#/quick-add')) return

  const parsed = parseQuickIntake(window.location.href, {
    activeProject: store.activeProject,
    defaultCurrency: store.defaultCurrency,
  })
  window.history.replaceState(null, '', window.location.pathname)

  if (parsed.projectId && store.activeProject) {
    editingExpenseTx.value = null
    quickIntakePrefill.value = parsed
    activeView.value = 'project_workspace'
    projectTab.value = 'expenses'
    projExpenseSheetOpen.value = true
    showToast(t('home.quickIntakeApplied', { source: parsed.sourceApp }))
  } else if (parsed.amount !== null || parsed.merchant) {
    showToast(t('home.quickIntakeNeedProject'))
    openCreateProjectView()
  }
}

function handleJoinedSharedProject(projectId: string) {
  pendingJoinInvite.value = null
  store.selectProject(projectId)
  projectTab.value = 'expenses'
  activeView.value = 'project_workspace'
}

function handleNetworkOnline() {
  void store.startAllSharedProjectListeners()
  void store.flushAllSharedProjectsOutbox()
  void store.tryBackgroundGoogleDriveSync(true)
  void refreshLiveExchangeRates()
}

function handleVisibilityChange() {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    void store.tryBackgroundGoogleDriveSync(false)
  }
}

onMounted(async () => {
  initTheme()
  detectTouchDevice()
  void refreshLiveExchangeRates()
  await store.initFromIndexedDb()
  void store.startAllSharedProjectListeners()
  void store.flushAllSharedProjectsOutbox()
  void store.tryBackgroundGoogleDriveSync(false)
  handleHashQuickAdd()
  window.addEventListener('hashchange', handleHashQuickAdd)
  window.addEventListener('online', handleNetworkOnline)
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', handleHashQuickAdd)
  window.removeEventListener('online', handleNetworkOnline)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  store.stopAllSharedProjectListeners()
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <div
    class="min-h-screen bg-slate-50 pb-24 text-slate-900 transition-colors duration-200 dark:bg-slate-950 dark:text-slate-100"
  >
    <!-- 極簡 App 頂部導覽列（左上小收據 Icon 回首頁，右上同水平線放明確設定齒輪） -->
    <header
      class="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur-md transition-colors dark:border-slate-800/80 dark:bg-slate-950/90"
    >
      <div class="mx-auto flex h-13 max-w-xl items-center justify-between gap-2 px-4 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <button
            v-if="activeView !== 'home'"
            type="button"
            :aria-label="t('home.backToHome')"
            class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            @click="activeView = 'home'"
          >
            <ArrowLeft class="h-4 w-4" />
          </button>

          <button
            type="button"
            :aria-label="t('home.backToHome')"
            :title="t('app.name')"
            class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-emerald-400 shadow-sm transition hover:scale-105 active:scale-95 dark:bg-emerald-500/15 dark:ring-1 dark:ring-emerald-500/40"
            @click="activeView = 'home'"
          >
            <Receipt class="h-3.5 w-3.5" />
          </button>

          <h1 class="truncate text-sm font-bold tracking-tight text-slate-900 dark:text-white sm:text-base">
            {{ topBarTitle }}
          </h1>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <button
            v-if="
              activeView === 'project_workspace' &&
              store.allNonDeletedProjects.length > 0
            "
            type="button"
            class="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            @click="allProjectsSheetOpen = true"
          >
            <LayoutGrid class="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
            <span>{{
              t('home.viewAllProjects', {
                count: store.allNonDeletedProjects.length,
              })
            }}</span>
          </button>

          <!-- Google 雲端跨裝置同步快捷按鈕（與設定齒輪同水平線） -->
          <button
            type="button"
            :aria-label="googleCloudButtonTitle"
            :title="googleCloudButtonTitle"
            class="relative inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-semibold transition active:scale-95"
            :class="
              store.googleDriveStatus === 'synced'
                ? 'border-sky-200 bg-sky-50/80 text-sky-700 hover:bg-sky-100 dark:border-sky-900/70 dark:bg-sky-950/50 dark:text-sky-300'
                : store.googleDriveStatus === 'pending' ||
                    store.googleDriveStatus === 'needs_auth'
                  ? 'border-amber-200 bg-amber-50/90 text-amber-800 hover:bg-amber-100 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-300'
                  : store.googleDriveStatus === 'error'
                    ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-300'
                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
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

          <!-- 右上角明確設定齒輪按鈕（與左上 Icon 同水平線、精緻小尺寸） -->
          <button
            type="button"
            :aria-label="t('settings.title')"
            :title="t('settings.title')"
            class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            @click="openSettingsModal('general')"
          >
            <Settings class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>

    <!-- 輕量提示 Toast（含即時復原鈕） -->
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
        class="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-xl dark:bg-slate-100 dark:text-slate-950"
      >
        <Check class="h-3.5 w-3.5 text-emerald-400 dark:text-emerald-600" />
        <span>{{ toastMessage }}</span>
        <button
          v-if="undoDeletedTxId"
          type="button"
          class="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-0.5 text-[11px] font-bold text-slate-950 transition hover:bg-emerald-400"
          @click="handleUndoDelete"
        >
          <Undo2 class="h-3 w-3" />
          <span>{{ t('trash.restore') }}</span>
        </button>
      </div>
    </Transition>

    <main class="mx-auto max-w-xl px-4 pt-5">
      <!-- ==================== 視圖 1：極簡首頁 ==================== -->
      <div v-if="activeView === 'home'" class="space-y-5">
        <!-- 分帳專案區（依裝置調整排序提示，提供「全部 (N)」開啟上移/下移與拖曳排序） -->
        <section class="space-y-2.5">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <h2 class="text-xs font-semibold text-slate-500 dark:text-slate-400">
                {{ t('home.myProjects', { count: store.activeProjects.length }) }}
              </h2>
              <span
                v-if="store.activeProjects.length > 1"
                class="text-[10px] text-slate-400 dark:text-slate-500"
              >
                {{
                  isTouchDevice
                    ? t('home.dragProjectHintTouch')
                    : t('home.dragProjectHint')
                }}
              </span>
            </div>

            <div class="flex items-center gap-2">
              <button
                v-if="
                  store.activeProjects.length >= 2 ||
                  store.archivedProjects.length > 0
                "
                type="button"
                class="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"
                @click="allProjectsSheetOpen = true"
              >
                <LayoutGrid class="h-3 w-3" />
                <span>{{
                  t('home.viewAllProjects', {
                    count: store.allNonDeletedProjects.length,
                  })
                }}</span>
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
                @click="openCreateProjectView"
              >
                <Plus class="h-3.5 w-3.5" />
                <span>{{ t('home.addProjectShort') }}</span>
              </button>
            </div>
          </div>

          <div v-if="store.activeProjects.length === 0" class="space-y-2.5">
            <button
              type="button"
              class="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm font-semibold text-emerald-600 transition hover:border-emerald-400 hover:bg-emerald-50/40 dark:border-slate-700 dark:bg-slate-900 dark:text-emerald-400"
              @click="openCreateProjectView"
            >
              <Plus class="h-4 w-4" />
              <span>{{ t('home.createFirstProject') }}</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-xs font-bold text-emerald-800 transition hover:bg-emerald-100 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
              @click="handleCreateDemoProject"
            >
              <Sparkles class="h-4 w-4" />
              <span>{{ t('demo.tryButton') }}</span>
            </button>
          </div>

          <div v-else class="grid grid-cols-2 gap-2.5">
            <div
              v-for="proj in store.activeProjects.slice(0, 4)"
              :key="proj.id"
              draggable="true"
              :data-project-id="proj.id"
              class="flex items-start gap-1.5 rounded-2xl border px-2.5 py-3 text-left transition"
              :class="[
                store.activeProject?.id === proj.id
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-500/70 dark:bg-emerald-950/60 dark:text-emerald-200'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200',
                dragOverProjectId === proj.id
                  ? 'border-dashed border-emerald-500 ring-2 ring-emerald-500/30'
                  : '',
                draggingProjectId === proj.id ? 'opacity-50' : '',
              ]"
              @dragstart="onProjectDragStart(proj.id, $event)"
              @dragover="onProjectDragOver(proj.id, $event)"
              @drop="onProjectDrop(proj.id, $event)"
              @dragend="onProjectDragEnd"
            >
              <span
                class="mt-0.5 shrink-0 cursor-grab text-slate-300 active:cursor-grabbing dark:text-slate-600"
                :title="t('home.dragProjectHint')"
              >
                <GripVertical class="h-3.5 w-3.5" />
              </span>
              <button
                type="button"
                class="flex min-w-0 flex-1 flex-col gap-1.5 text-left"
                @click="openProjectWorkspace(proj.id)"
              >
                <div class="flex w-full items-center justify-between gap-1.5">
                  <span class="flex min-w-0 items-center gap-1">
                    <Cloud
                      v-if="proj.syncMeta?.mode === 'firestore'"
                      class="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400"
                    />
                    <span class="truncate text-xs font-bold">{{ proj.name }}</span>
                  </span>
                  <span class="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {{ proj.baseCurrency }}
                  </span>
                </div>
                <div class="truncate text-sm font-extrabold tabular-nums text-emerald-700 dark:text-emerald-400">
                  {{ fmt(store.getProjectTotalExpense(proj.id), proj.baseCurrency) }}
                </div>
                <div
                  class="flex w-full items-center justify-between gap-1.5"
                  :title="proj.members.map((m) => m.name).join('、')"
                >
                  <div class="flex items-center -space-x-1">
                    <MemberAvatar
                      v-for="m in proj.members.slice(0, 4)"
                      :key="m.id"
                      :name="m.name"
                      :color="m.avatarColor"
                      :image="m.avatarImage"
                      size="xxs"
                      ring
                    />
                    <span
                      v-if="proj.members.length > 4"
                      class="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-slate-200 px-1 text-[8px] font-bold text-slate-700 ring-1 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-900"
                    >
                      +{{ proj.members.length - 4 }}
                    </span>
                  </div>
                  <span class="shrink-0 text-[10px] font-medium text-slate-400 dark:text-slate-500">
                    {{ t('project.memberCount', { count: proj.members.length }) }}
                  </span>
                </div>
              </button>
            </div>
          </div>
        </section>

        <!-- 首頁近期帳目（左滑修改／深滑漸層刪除，完成或關閉皆留在首頁） -->
        <TransactionListSection
          ref="homeTxListRef"
          context="home"
          :title="t('home.recentTransactions')"
          :transactions="homeProjectTransactions"
          :empty-text="t('home.noTransactionsYet')"
          :collapsible-limit="8"
          @edit="startEditTransaction"
          @delete="handleDeleteTransaction"
          @open-project="openProjectWorkspace($event)"
          @preview-photos="openPhotoLightbox"
          @toast="showToast($event)"
        />
      </div>

      <!-- ==================== 視圖 2：建立旅遊 / 分帳專案 ==================== -->
      <div v-else-if="activeView === 'project_create'">
        <section
          class="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <form class="space-y-4" @submit.prevent="handleCreateProject">
            <div>
              <label class="mb-1.5 block text-xs font-semibold text-slate-600 dark:text-slate-300">
                {{ t('project.nameLabel') }}
              </label>
              <input
                v-model="projectName"
                type="text"
                autofocus
                :placeholder="t('project.namePlaceholder')"
                class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm font-medium text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1.5 block text-xs font-semibold text-slate-600 dark:text-slate-300">
                  {{ t('project.currencyLabel') }}
                </label>
                <select
                  v-model="projectCurrency"
                  class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                >
                  <option
                    v-for="code in store.availableCurrencies"
                    :key="code"
                    :value="code"
                  >
                    {{ code }}
                  </option>
                </select>
              </div>
              <div>
                <label class="mb-1.5 block text-xs font-semibold text-slate-600 dark:text-slate-300">
                  {{ t('project.defaultSplitModeLabel') }}
                </label>
                <select
                  v-model="projectDefaultSplitMode"
                  class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                >
                  <option value="equal">{{ t('split.tabEqual') }}</option>
                  <option value="custom_plus_equal">{{ t('split.tabCustomPlusEqual') }}</option>
                </select>
              </div>
            </div>

            <div class="space-y-2">
              <label class="block text-xs font-semibold text-slate-600 dark:text-slate-300">
                {{ t('project.membersLabel') }}
              </label>

              <!-- 快速從既有專案帶入成員班底 -->
              <div
                v-if="store.allNonDeletedProjects.length > 0"
                class="space-y-1"
              >
                <div class="text-[11px] font-medium text-slate-400 dark:text-slate-500">
                  {{ t('project.copyMembersFromProject') }}
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="existingProj in store.allNonDeletedProjects.slice(0, 6)"
                    :key="existingProj.id"
                    type="button"
                    class="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-emerald-500 dark:hover:text-emerald-300"
                    @click="copyMembersFromProject(existingProj.id)"
                  >
                    <span class="max-w-[120px] truncate">{{ existingProj.name }}</span>
                    <span class="text-[10px] text-slate-400">
                      ({{ existingProj.members.length }})
                    </span>
                  </button>
                </div>
              </div>

              <!-- 現代成員膠囊（Tag Chip）輸入盒 -->
              <div
                class="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/80"
              >
                <div v-if="projectMembersList.length > 0" class="flex flex-wrap gap-1.5">
                  <span
                    v-for="(memberName, idx) in projectMembersList"
                    :key="`${memberName}-${idx}`"
                    class="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1 pl-2.5 pr-1.5 text-xs font-semibold text-slate-800 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <span
                      class="h-2 w-2 rounded-full"
                      :style="{
                        backgroundColor:
                          AVATAR_PALETTE[idx % AVATAR_PALETTE.length],
                      }"
                    />
                    <span>{{ memberName }}</span>
                    <button
                      type="button"
                      :aria-label="t('home.deleteTx')"
                      class="rounded-full p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/60"
                      @click="removeMemberChip(idx)"
                    >
                      <X class="h-3 w-3" />
                    </button>
                  </span>
                </div>

                <div class="flex gap-1.5">
                  <input
                    v-model="newProjectMemberInput"
                    type="text"
                    :placeholder="t('project.memberChipPlaceholder')"
                    class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                    @keydown="handleMemberInputKeydown"
                  />
                  <button
                    type="button"
                    :disabled="!newProjectMemberInput.trim()"
                    class="inline-flex shrink-0 items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
                    @click="commitNewMemberChips"
                  >
                    <Plus class="h-3.5 w-3.5" />
                    <span>{{ t('project.addMemberButton') }}</span>
                  </button>
                </div>
              </div>
            </div>

            <p v-if="projectFormError" class="text-xs font-medium text-rose-500">
              {{ projectFormError }}
            </p>

            <button
              type="submit"
              class="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
            >
              {{ t('project.createButton') }}
            </button>
          </form>
        </section>
      </div>

      <!-- ==================== 視圖 3：分帳專案工作區 ==================== -->
      <div
        v-else-if="activeView === 'project_workspace' && store.activeProject"
        class="space-y-4"
      >
        <section
          class="space-y-3 rounded-2xl bg-slate-900 px-5 py-4 text-white dark:border dark:border-slate-800"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5 text-xs font-medium text-emerald-400">
                <span>
                  {{ t('project.memberCount', { count: store.activeProject.members.length }) }}
                  · {{ store.activeProject.baseCurrency }}
                </span>
                <span
                  v-if="store.activeProject.isArchived"
                  class="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300"
                >
                  <Archive class="h-3 w-3" />
                  <span>{{ t('project.archivedBadge') }}</span>
                </span>
              </div>
              <div class="mt-0.5 truncate text-lg font-bold">{{ store.activeProject.name }}</div>
            </div>
            <div class="shrink-0 text-right">
              <div class="text-[11px] text-slate-400">{{ t('project.totalSpent') }}</div>
              <div class="text-xl font-extrabold tabular-nums text-emerald-400">
                {{ fmt(activeProjectTotalSpent, store.activeProject.baseCurrency) }}
              </div>
            </div>
          </div>

          <!-- 多人即時協作共享狀態與邀請入口 -->
          <div class="flex items-center justify-between gap-2 border-t border-white/10 pt-2.5">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition"
              :class="
                store.activeProject.syncMeta?.mode === 'firestore'
                  ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                  : 'bg-white/10 text-slate-200 hover:bg-white/20'
              "
              @click="shareModalOpen = true"
            >
              <template v-if="store.activeProject.syncMeta?.mode === 'firestore'">
                <CloudOff
                  v-if="store.syncStatusByProject[store.activeProject.id] === 'offline'"
                  class="h-3.5 w-3.5 text-amber-300"
                />
                <span
                  v-else
                  class="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]"
                />
                <span>
                  {{
                    (store.outboxCountByProject[store.activeProject.id] ?? 0) > 0
                      ? t('realtime.entryOfflineBadge', {
                          count: store.outboxCountByProject[store.activeProject.id],
                        })
                      : t('realtime.entrySyncedBadge')
                  }}
                </span>
              </template>
              <template v-else>
                <Users class="h-3.5 w-3.5 text-emerald-400" />
                <span>{{ t('realtime.entryInviteButton') }}</span>
              </template>
            </button>

            <span
              v-if="
                store.activeProject.syncMeta?.mode === 'firestore' &&
                store.activeProject.syncMeta.myMemberId
              "
              class="truncate text-[11px] text-slate-400"
            >
              {{
                store.activeProject.members.find(
                  (m) => m.id === store.activeProject?.syncMeta?.myMemberId,
                )?.name
              }}
            </span>
          </div>
        </section>

        <nav
          class="grid grid-cols-3 rounded-xl bg-slate-200/70 p-1 text-xs font-semibold dark:bg-slate-900"
        >
          <button
            v-for="tab in (['expenses', 'settle', 'settings'] as const)"
            :key="tab"
            type="button"
            class="rounded-lg py-2 transition"
            :class="
              projectTab === tab
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            "
            @click="projectTab = tab"
          >
            {{
              tab === 'expenses'
                ? t('project.tabExpenses')
                : tab === 'settle'
                  ? t('project.tabSettle')
                  : t('project.tabSettings')
            }}
          </button>
        </nav>

        <!-- 分頁 A：專案明細 -->
        <TransactionListSection
          v-if="projectTab === 'expenses'"
          ref="projectTxListRef"
          context="project"
          :transactions="store.activeProjectExpenses"
          :empty-text="t('project.noProjectTransactions')"
          :project-base-currency="store.activeProject.baseCurrency"
          @edit="startEditTransaction"
          @delete="handleDeleteTransaction"
          @preview-photos="openPhotoLightbox"
          @toast="showToast($event)"
        />

        <!-- 分頁 B：結算、圓餅圖統計與一鍵分享 -->
        <ProjectSettleTab
          v-else-if="projectTab === 'settle' && store.activeProjectSettleUp"
          :project="store.activeProject"
          :settle-up="store.activeProjectSettleUp"
          :expenses="store.activeProjectExpenses"
          :settlements="store.activeProjectSettlements"
          @record-payment="openRecordSettlementModal"
          @edit-settlement="startEditTransaction"
          @delete-settlement="handleDeleteTransaction"
          @toast="showToast($event)"
        />

        <!-- 分頁 C：成員與專案設定 -->
        <ProjectSettingsTab
          v-else-if="projectTab === 'settings'"
          :project="store.activeProject"
          @create-project="openCreateProjectView"
          @project-deleted="handleProjectDeleted"
          @toast="showToast($event)"
        />

        <!-- 浮動「+ 記一筆」按鈕 -->
        <button
          v-if="projectTab !== 'settings'"
          type="button"
          class="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3.5 text-sm font-bold text-white shadow-xl transition hover:scale-105 active:scale-95 dark:bg-emerald-500 dark:text-slate-950"
          @click="openAddProjectExpenseSheet"
        >
          <Plus class="h-5 w-5" />
          <span>{{ t('project.fabAdd') }}</span>
        </button>
      </div>
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
      :prefill="quickIntakePrefill"
      @close="closeProjectExpenseSheet"
      @saved="showToast($event)"
      @preview-photos="openPhotoLightbox"
      @toast="showToast($event)"
    />

    <!-- 還款記錄／修改彈窗 -->
    <SettlementPaymentModal
      :open="settleSheetOpen"
      :project="store.activeProject"
      :editing-tx="editingSettleTx"
      :initial-from-id="settleInitialFromId"
      :initial-to-id="settleInitialToId"
      :suggested-amount="settleSuggestedAmount"
      @close="settleSheetOpen = false"
      @saved="showToast($event)"
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
  </div>
</template>
