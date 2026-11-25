<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  ArrowLeft,
  Check,
  Cloud,
  CloudOff,
  Copy,
  ExternalLink,
  GripVertical,
  ImagePlus,
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
import {
  AVATAR_PALETTE,
  PROJECT_CARD_PALETTE,
  useLedgerStore,
} from '@/stores/ledgerStore'
import { formatCurrencyAmount } from '@/core/currency'
import { parseGoogleConnectHash } from '@/core/googleConnectLink'
import { compressCoverImageFileToDataUrl } from '@/core/imageCompressor'
import { detectInAppBrowser } from '@/core/inAppBrowser'
import { parseShareInviteHash } from '@/core/realtimeSyncEngine'
import { LIVE_RATES_CACHE_TTL_MS } from '@/services/exchangeRateService'
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
import type { SettingsTab } from '@/components/SettingsModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import CurrencyQuickAddPicker from '@/components/CurrencyQuickAddPicker.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'
import ProjectExpenseModal from '@/components/ProjectExpenseModal.vue'
import ProjectSettleTab from '@/components/ProjectSettleTab.vue'
import ProjectSettingsTab from '@/components/ProjectSettingsTab.vue'
import SettlementPaymentModal from '@/components/SettlementPaymentModal.vue'
import TransactionListSection from '@/components/TransactionListSection.vue'
import { askConfirm } from '@/composables/useConfirm'

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
type ProjectTab = 'expenses' | 'settle' | 'settings'

const { t, locale } = useI18n()
const store = useLedgerStore()

// 視圖與全域 UI 狀態
const activeView = ref<ActiveView>('home')
const projectTab = ref<ProjectTab>('expenses')
const settingsOpen = ref(false)
const settingsInitialTab = ref<SettingsTab>('profile')
const allProjectsSheetOpen = ref(false)
const shareModalOpen = ref(false)
const poolCollectModalOpen = ref(false)
const pendingJoinInvite = ref<ShareInviteParams | null>(null)
const isDark = ref(false)
const isTouchDevice = ref(false)
const inAppBrowser = ref(detectInAppBrowser())
const inAppBannerDismissed = ref(false)
const previewPhotos = ref<string[]>([])
const previewPhotoIndex = ref(0)
let hourlyRatesTimer: ReturnType<typeof setInterval> | null = null

async function handleCopyCurrentPageUrl() {
  if (typeof window === 'undefined') return
  const url = window.location.href
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
      showToast(t('inApp.copiedUrlToast'))
      return
    }
  } catch {
    // 降級複製
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = url
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    showToast(t('inApp.copiedUrlToast'))
  } catch {
    showToast(t('share.failedToast'))
  }
}

function openSettingsModal(tab: SettingsTab = 'profile') {
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

function getHumanMembers(proj: { members: Array<{ id: string; name: string; avatarColor?: string; avatarImage?: string; isPool?: boolean }> }) {
  const humans = proj.members.filter((m) => !m.isPool)
  return humans.length > 0 ? humans : proj.members
}

function copyMembersFromProject(sourceProjectId: string) {
  const source = store.getProjectById(sourceProjectId)
  if (!source) return
  const humans = getHumanMembers(source)
  projectMembersList.value = humans.map((m) => m.name)
  newProjectMemberInput.value = ''
  showToast(
    t('project.membersCopiedToast', {
      name: source.name,
      count: humans.length,
    }),
  )
}

// Toast 與即時刪除復原狀態（支援 6 秒內連刪多筆全部一鍵復原，不再覆蓋遺失）
const toastMessage = ref('')
const undoDeletedTxIds = ref<string[]>([])
let toastTimer: ReturnType<typeof setTimeout> | null = null

// 專案網格拖曳排序狀態（桌機）
const draggingProjectId = ref<string | null>(null)
const dragOverProjectId = ref<string | null>(null)

// 建立新專案表單狀態（現代成員膠囊 Tag Chip + 自訂小卡背景色/封面圖）
const projectName = ref('')
const projectCurrency = ref(store.defaultCurrency)
const projectDefaultSplitMode = ref<SplitMode>('equal')
const projectMembersList = ref<string[]>([])
const newProjectMemberInput = ref('')
const projectCardColor = ref<string | undefined>(undefined)
const projectCardCoverImage = ref<string | undefined>(undefined)
const projectFormError = ref('')
const createNewCurrencyOpen = ref(false)
const createProjectInitialSnapshot = ref('')

function captureCreateProjectSnapshot(): string {
  return JSON.stringify({
    name: projectName.value.trim(),
    currency: projectCurrency.value,
    splitMode: projectDefaultSplitMode.value,
    members: projectMembersList.value,
    pendingMemberInput: newProjectMemberInput.value.trim(),
    cardColor: projectCardColor.value ?? null,
    cardCoverImage: projectCardCoverImage.value ?? null,
  })
}

const isCreateProjectDirty = computed(() => {
  if (activeView.value !== 'project_create') return false
  return captureCreateProjectSnapshot() !== createProjectInitialSnapshot.value
})

async function requestNavigateHome() {
  if (activeView.value === 'project_create' && isCreateProjectDirty.value) {
    const confirmed = await askConfirm({
      title: t('project.discardCreateTitle'),
      message: t('project.discardCreateMessage'),
      confirmText: t('project.discardButton'),
      tone: 'danger',
    })
    if (!confirmed) return
  }
  activeView.value = 'home'
}

function handleCreateProjectCurrencyAdded(code: string) {
  projectCurrency.value = code
  createNewCurrencyOpen.value = false
}

async function handleCreateProjectCoverUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    projectCardCoverImage.value = await compressCoverImageFileToDataUrl(file)
  } catch {
    showToast(t('photo.uploadError'))
  } finally {
    input.value = ''
  }
}

function getProjectCardStyle(proj: {
  cardColor?: string
  cardCoverImage?: string
}): Record<string, string> | undefined {
  if (proj.cardCoverImage) {
    return {
      backgroundImage: `url(${proj.cardCoverImage})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
  }
  if (proj.cardColor) {
    return {
      backgroundColor: proj.cardColor,
      backgroundImage:
        'linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(0,0,0,0.22) 100%)',
    }
  }
  return undefined
}

function hasCustomProjectCardBg(proj: {
  cardColor?: string
  cardCoverImage?: string
}): boolean {
  return Boolean(proj.cardCoverImage || proj.cardColor)
}

function commitNewMemberChips() {
  const raw = newProjectMemberInput.value
  if (!raw.trim()) return
  const parts = raw
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const existingKeys = new Set(
    projectMembersList.value.map((name) => name.trim().toLowerCase()),
  )
  const accepted: string[] = []
  let firstDuplicate = ''
  for (const name of parts) {
    const key = name.toLowerCase()
    if (existingKeys.has(key)) {
      if (!firstDuplicate) firstDuplicate = name
      continue
    }
    existingKeys.add(key)
    accepted.push(name)
  }
  if (accepted.length > 0) {
    projectMembersList.value = [...projectMembersList.value, ...accepted]
  }
  if (firstDuplicate) {
    showToast(t('validation.duplicateMemberName', { name: firstDuplicate }))
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
const duplicateExpenseTx = ref<Transaction | null>(null)
const quickIntakePrefill = ref<ParsedQuickIntakeResult | null>(null)

const settleSheetOpen = ref(false)
const editingSettleTx = ref<Transaction | null>(null)
const settleInitialFromId = ref('')
const settleInitialToId = ref('')
const settleSuggestedAmount = ref<number | null>(null)
const settleCurrency = ref<string | null>(null)

// 列表元件 ref（用於復原時清除遮蔽篩選）
const homeTxListRef = ref<InstanceType<typeof TransactionListSection> | null>(null)
const projectTxListRef = ref<InstanceType<typeof TransactionListSection> | null>(null)

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
  if (undoTxId) {
    if (!undoDeletedTxIds.value.includes(undoTxId)) {
      undoDeletedTxIds.value = [...undoDeletedTxIds.value, undoTxId]
    }
  } else {
    undoDeletedTxIds.value = []
  }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(
    () => {
      toastMessage.value = ''
      undoDeletedTxIds.value = []
    },
    undoDeletedTxIds.value.length > 0 ? 6000 : 2800,
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

const activeProjectTotalSpent = computed(() =>
  store.activeProject ? store.getProjectTotalExpense(store.activeProject.id) : 0,
)

const activeProjectMyMemberId = computed<string | undefined>(() => {
  const proj = store.activeProject
  if (!proj) return undefined
  return proj.syncMeta?.myMemberId || proj.defaultPayerId || undefined
})

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
  projectCardColor.value = undefined
  projectCardCoverImage.value = undefined
  createNewCurrencyOpen.value = false
  activeView.value = 'project_create'
  createProjectInitialSnapshot.value = captureCreateProjectSnapshot()
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

  const seenNames = new Set<string>()
  for (const name of members) {
    const key = name.toLowerCase()
    if (seenNames.has(key)) {
      projectFormError.value = t('validation.duplicateMemberName', { name })
      return
    }
    seenNames.add(key)
  }

  try {
    await store.createProject({
      name: trimmedName,
      baseCurrency: projectCurrency.value,
      memberNames: members,
      defaultSplitMode: projectDefaultSplitMode.value,
      cardColor: projectCardColor.value,
      cardCoverImage: projectCardCoverImage.value,
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
  duplicateExpenseTx.value = null
  quickIntakePrefill.value = null
  projExpenseSheetOpen.value = true
}

function closeProjectExpenseSheet() {
  projExpenseSheetOpen.value = false
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

function handleInspectMemberInExpenses(memberId: string) {
  projectTab.value = 'expenses'
  void nextTick(() => {
    projectTxListRef.value?.setMemberFilter(memberId)
  })
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
    homeTxListRef.value?.resetFilters()
    projectTxListRef.value?.resetFilters()
    showToast(
      restoredCount > 1
        ? t('trash.restoredMultiToast', { count: restoredCount })
        : t('trash.restoredToast'),
    )
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
      openSettingsModal('profile')
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
    }, LIVE_RATES_CACHE_TTL_MS)
  }
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
  if (hourlyRatesTimer) clearInterval(hourlyRatesTimer)
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
        role="status"
        class="safe-toast-bottom fixed left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-2xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white shadow-xl dark:bg-slate-100 dark:text-slate-950 sm:rounded-full sm:px-4"
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

      <!-- ==================== 視圖 1：極簡首頁（桌機雙欄／平板寬版／手機精簡） ==================== -->
      <div
        v-if="activeView === 'home'"
        class="space-y-5 lg:grid lg:grid-cols-12 lg:items-start lg:gap-5 lg:space-y-0"
      >
        <!-- 分帳專案區（依裝置調整排序提示，提供「全部 (N)」開啟上移/下移與拖曳排序） -->
        <section class="space-y-2.5 lg:col-span-5">
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <h2 class="whitespace-nowrap text-xs font-semibold text-slate-500 dark:text-slate-400">
                {{ t('home.myProjects', { count: store.activeProjects.length }) }}
              </h2>

              <div class="flex shrink-0 items-center gap-2">
                <button
                  v-if="
                    store.activeProjects.length >= 2 ||
                    store.archivedProjects.length > 0
                  "
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"
                  @click="allProjectsSheetOpen = true"
                >
                  <LayoutGrid class="h-3 w-3 shrink-0" />
                  <span>{{
                    t('home.viewAllProjects', {
                      count: store.allNonDeletedProjects.length,
                    })
                  }}</span>
                </button>
                <button
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
                  @click="openCreateProjectView"
                >
                  <Plus class="h-3.5 w-3.5 shrink-0" />
                  <span>{{ t('home.addProjectShort') }}</span>
                </button>
              </div>
            </div>

            <p
              v-if="store.activeProjects.length > 1"
              class="text-[10px] text-slate-400 dark:text-slate-500"
            >
              {{
                isTouchDevice
                  ? t('home.dragProjectHintTouch')
                  : t('home.dragProjectHint')
              }}
            </p>
          </div>

          <div v-if="store.activeProjects.length === 0" class="space-y-2.5">
            <button
              type="button"
              class="flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-6 text-sm font-semibold text-emerald-600 shadow-sm transition hover:bg-white/80 dark:bg-[#1C1C1E] dark:text-emerald-400"
              @click="openCreateProjectView"
            >
              <Plus class="h-4 w-4" />
              <span>{{ t('home.createFirstProject') }}</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-emerald-500/12 px-4 py-3 text-xs font-bold text-emerald-700 transition hover:bg-emerald-500/20 dark:bg-emerald-500/15 dark:text-emerald-300"
              @click="handleCreateDemoProject"
            >
              <Sparkles class="h-4 w-4" />
              <span>{{ t('demo.tryButton') }}</span>
            </button>
          </div>

          <div v-else class="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-2">
            <div
              v-for="(proj, idx) in store.activeProjects.slice(0, 6)"
              :key="proj.id"
              draggable="true"
              :data-project-id="proj.id"
              class="relative items-start gap-1.5 overflow-hidden rounded-2xl px-3 py-3 text-left shadow-sm transition"
              :style="getProjectCardStyle(proj)"
              :class="[
                idx >= 4 ? 'hidden md:flex' : 'flex',
                hasCustomProjectCardBg(proj)
                  ? store.activeProject?.id === proj.id
                    ? 'text-white ring-2 ring-emerald-400/70'
                    : 'text-white hover:brightness-105'
                  : store.activeProject?.id === proj.id
                    ? 'bg-white text-slate-900 ring-2 ring-emerald-500/60 dark:bg-[#1C1C1E] dark:text-white'
                    : 'bg-white text-slate-800 hover:bg-slate-50/90 dark:bg-[#1C1C1E] dark:text-slate-100 dark:hover:bg-[#2C2C2E]',
                dragOverProjectId === proj.id
                  ? 'ring-2 ring-dashed ring-emerald-500'
                  : '',
                draggingProjectId === proj.id ? 'opacity-50' : '',
              ]"
              @dragstart="onProjectDragStart(proj.id, $event)"
              @dragover="onProjectDragOver(proj.id, $event)"
              @drop="onProjectDrop(proj.id, $event)"
              @dragend="onProjectDragEnd"
            >
              <!-- 封面照片暗色漸層遮罩，確保白色字體清晰可讀 -->
              <div
                v-if="proj.cardCoverImage"
                class="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/45 to-slate-950/35"
              />
              <span
                class="relative z-10 mt-0.5 shrink-0 cursor-grab active:cursor-grabbing"
                :class="
                  hasCustomProjectCardBg(proj)
                    ? 'text-white/55'
                    : 'text-slate-300 dark:text-slate-600'
                "
                :title="t('home.dragProjectHint')"
              >
                <GripVertical class="h-3.5 w-3.5" />
              </span>
              <button
                type="button"
                class="relative z-10 flex min-w-0 flex-1 flex-col gap-1.5 text-left"
                @click="openProjectWorkspace(proj.id)"
              >
                <div class="flex w-full items-center justify-between gap-1.5">
                  <span class="flex min-w-0 items-center gap-1">
                    <Cloud
                      v-if="proj.syncMeta?.mode === 'firestore'"
                      class="h-3 w-3 shrink-0"
                      :class="
                        hasCustomProjectCardBg(proj)
                          ? 'text-emerald-300'
                          : 'text-emerald-600 dark:text-emerald-400'
                      "
                    />
                    <span class="truncate text-xs font-bold">{{ proj.name }}</span>
                  </span>
                  <span
                    class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                    :class="
                      hasCustomProjectCardBg(proj)
                        ? 'bg-black/35 text-white/90 backdrop-blur-sm'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                    "
                  >
                    {{ proj.baseCurrency }}
                  </span>
                </div>
                <div
                  class="truncate text-sm font-extrabold tabular-nums"
                  :class="
                    hasCustomProjectCardBg(proj)
                      ? 'text-emerald-300 drop-shadow-sm'
                      : 'text-emerald-700 dark:text-emerald-400'
                  "
                >
                  {{ fmt(store.getProjectTotalExpense(proj.id), proj.baseCurrency) }}
                </div>
                <div
                  class="flex w-full items-center justify-between gap-1.5"
                  :title="getHumanMembers(proj).map((m) => m.name).join('、')"
                >
                  <div class="flex items-center -space-x-1">
                    <MemberAvatar
                      v-for="m in getHumanMembers(proj).slice(0, 4)"
                      :key="m.id"
                      :name="m.name"
                      :color="m.avatarColor"
                      :image="m.avatarImage"
                      size="xxs"
                      ring
                    />
                    <span
                      v-if="getHumanMembers(proj).length > 4"
                      class="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-slate-200 px-1 text-[8px] font-bold text-slate-700 ring-1 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-900"
                    >
                      +{{ getHumanMembers(proj).length - 4 }}
                    </span>
                  </div>
                  <span
                    class="shrink-0 text-[10px] font-medium"
                    :class="
                      hasCustomProjectCardBg(proj)
                        ? 'text-white/85'
                        : 'text-slate-400 dark:text-slate-500'
                    "
                  >
                    {{ t('project.memberCount', { count: getHumanMembers(proj).length }) }}
                  </span>
                </div>
              </button>
            </div>
          </div>

          <!-- 手機超過 4 個（或平板以上超過 6 個）專案時於卡片下方給明確入口，避免以為專案不見 -->
          <button
            v-if="store.activeProjects.length > 4"
            type="button"
            class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-white/80 py-2 text-xs font-semibold text-slate-600 transition hover:border-emerald-400 hover:text-emerald-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:text-emerald-400"
            :class="store.activeProjects.length <= 6 ? 'md:hidden' : ''"
            @click="allProjectsSheetOpen = true"
          >
            <LayoutGrid class="h-3.5 w-3.5" />
            <span class="md:hidden">
              {{
                t('home.moreProjectsHint', {
                  count: store.activeProjects.length - 4,
                })
              }}
            </span>
            <span class="hidden md:inline">
              {{
                t('home.moreProjectsHint', {
                  count: store.activeProjects.length - 6,
                })
              }}
            </span>
          </button>
        </section>

        <!-- 首頁近期帳目（支援專案快速篩選、左滑修改／右滑刪除，完成或關閉皆留在首頁） -->
        <TransactionListSection
          ref="homeTxListRef"
          class="lg:col-span-7"
          context="home"
          :title="t('home.recentTransactions')"
          :transactions="homeProjectTransactions"
          :filter-projects="store.activeProjects"
          :empty-text="t('home.noTransactionsYet')"
          :collapsible-limit="8"
          @edit="startEditTransaction"
          @duplicate="startDuplicateTransaction"
          @delete="handleDeleteTransaction"
          @open-project="openProjectWorkspace($event)"
          @preview-photos="openPhotoLightbox"
          @toast="showToast($event)"
        />
      </div>

      <!-- ==================== 視圖 2：建立旅遊 / 分帳專案 ==================== -->
      <div v-else-if="activeView === 'project_create'" class="mx-auto max-w-xl">
        <section
          class="rounded-3xl bg-white p-5 shadow-sm dark:bg-[#1C1C1E]"
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
                <div class="mb-1.5 flex items-center justify-between gap-1">
                  <label class="block text-xs font-semibold text-slate-600 dark:text-slate-300">
                    {{ t('project.currencyLabel') }}
                  </label>
                  <button
                    type="button"
                    class="text-[11px] font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
                    @click="createNewCurrencyOpen = !createNewCurrencyOpen"
                  >
                    + {{ t('project.quickAddCurrencyShort') }}
                  </button>
                </div>
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
                  <option value="weight">{{ t('split.tabWeight') }}</option>
                  <option value="percentage">{{ t('split.tabPercent') }}</option>
                </select>
              </div>
            </div>

            <!-- 建專案現場中文搜尋新增幣別（不必跳離頁面遺失已輸入之成員名單） -->
            <CurrencyQuickAddPicker
              v-if="createNewCurrencyOpen"
              @added="handleCreateProjectCurrencyAdded"
              @close="createNewCurrencyOpen = false"
              @toast="showToast($event)"
            />

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
                      ({{ getHumanMembers(existingProj).length }})
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

            <!-- 專案小卡背景自訂（選色或上傳封面照片） -->
            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <label class="text-xs font-semibold text-slate-600 dark:text-slate-300">
                  {{ t('project.cardBgLabel') }}
                </label>
                <button
                  v-if="projectCardColor || projectCardCoverImage"
                  type="button"
                  class="text-[11px] font-semibold text-slate-400 hover:text-rose-500"
                  @click="
                    projectCardColor = undefined;
                    projectCardCoverImage = undefined
                  "
                >
                  {{ t('project.cardBgReset') }}
                </button>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-for="color in PROJECT_CARD_PALETTE"
                  :key="color"
                  type="button"
                  class="h-6 w-6 rounded-full transition"
                  :style="{ backgroundColor: color }"
                  :class="
                    !projectCardCoverImage && projectCardColor === color
                      ? 'ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-slate-900'
                      : 'opacity-80 hover:opacity-100'
                  "
                  @click="
                    projectCardColor = color;
                    projectCardCoverImage = undefined
                  "
                />
                <label
                  class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-slate-300 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >
                  <ImagePlus class="h-3.5 w-3.5" />
                  <span>{{ t('project.cardBgUploadPhoto') }}</span>
                  <input
                    type="file"
                    accept="image/*"
                    class="hidden"
                    @change="handleCreateProjectCoverUpload"
                  />
                </label>
              </div>

              <div
                v-if="projectCardColor || projectCardCoverImage"
                class="relative h-20 overflow-hidden rounded-2xl border border-white/15 px-3.5 py-2.5 text-white shadow-sm"
                :style="
                  getProjectCardStyle({
                    cardColor: projectCardColor,
                    cardCoverImage: projectCardCoverImage,
                  })
                "
              >
                <div
                  v-if="projectCardCoverImage"
                  class="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/80 via-slate-950/40 to-slate-950/30"
                />
                <div class="relative z-10 flex h-full flex-col justify-between">
                  <div class="flex items-center justify-between text-xs font-bold">
                    <span class="truncate">{{ projectName || t('project.namePlaceholder') }}</span>
                    <span class="rounded bg-black/35 px-1.5 py-0.5 text-[10px]">
                      {{ projectCurrency }}
                    </span>
                  </div>
                  <div class="text-[11px] font-semibold text-emerald-300">
                    {{ t('project.cardBgPreviewHint') }}
                  </div>
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
          class="relative space-y-3 overflow-hidden rounded-3xl bg-slate-900 px-5 py-4 text-white shadow-sm dark:bg-[#1C1C1E]"
          :style="getProjectCardStyle(store.activeProject)"
        >
          <div
            v-if="store.activeProject.cardCoverImage"
            class="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/55 to-slate-950/45"
          />
          <div class="relative z-10 flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2 text-xs font-medium text-emerald-400">
                <button
                  type="button"
                  :title="getHumanMembers(store.activeProject).map((m) => m.name).join('、')"
                  class="inline-flex items-center gap-1.5 rounded-full transition hover:opacity-90"
                  @click="projectTab = 'settings'"
                >
                  <span class="inline-flex items-center -space-x-1">
                    <MemberAvatar
                      v-for="m in getHumanMembers(store.activeProject).slice(0, 6)"
                      :key="m.id"
                      :name="m.name"
                      :color="m.avatarColor"
                      :image="m.avatarImage"
                      size="xs"
                      ring
                    />
                    <span
                      v-if="getHumanMembers(store.activeProject).length > 6"
                      class="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-slate-700 px-1 text-[9px] font-bold text-slate-100 ring-1 ring-slate-900"
                    >
                      +{{ getHumanMembers(store.activeProject).length - 6 }}
                    </span>
                  </span>
                  <span>
                    {{ t('project.memberCount', { count: getHumanMembers(store.activeProject).length }) }}
                    · {{ store.activeProject.baseCurrency }}
                  </span>
                </button>
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
              <div class="text-[11px] text-slate-300">{{ t('project.totalSpent') }}</div>
              <div class="text-xl font-extrabold tabular-nums text-emerald-400">
                {{ fmt(activeProjectTotalSpent, store.activeProject.baseCurrency) }}
              </div>
            </div>
          </div>

          <!-- 多人即時協作共享狀態與邀請入口 -->
          <div class="relative z-10 flex items-center justify-between gap-2 border-t border-white/15 pt-2.5">
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
                store.activeProject.syncMeta.myMemberId &&
                store.activeProject.members.find(
                  (m) => m.id === store.activeProject?.syncMeta?.myMemberId,
                )
              "
              class="inline-flex max-w-[140px] items-center gap-1.5 truncate text-[11px] text-slate-300"
            >
              <MemberAvatar
                :name="
                  store.activeProject.members.find(
                    (m) => m.id === store.activeProject?.syncMeta?.myMemberId,
                  )!.name
                "
                :color="
                  store.activeProject.members.find(
                    (m) => m.id === store.activeProject?.syncMeta?.myMemberId,
                  )?.avatarColor
                "
                :image="
                  store.activeProject.members.find(
                    (m) => m.id === store.activeProject?.syncMeta?.myMemberId,
                  )?.avatarImage
                "
                size="xxs"
              />
              <span class="truncate">
                {{
                  store.activeProject.members.find(
                    (m) => m.id === store.activeProject?.syncMeta?.myMemberId,
                  )?.name
                }}
              </span>
            </span>
          </div>
        </section>

        <nav
          class="grid grid-cols-3 rounded-xl bg-black/[0.06] p-1 text-xs font-semibold dark:bg-[#1C1C1E]"
        >
          <button
            v-for="tab in (['expenses', 'settle', 'settings'] as const)"
            :key="tab"
            type="button"
            class="rounded-lg py-2 transition"
            :class="
              projectTab === tab
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#2C2C2E] dark:text-white'
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
          :project-members="store.activeProject.members"
          :my-member-id="activeProjectMyMemberId"
          @edit="startEditTransaction"
          @duplicate="startDuplicateTransaction"
          @delete="handleDeleteTransaction"
          @preview-photos="openPhotoLightbox"
          @toast="showToast($event)"
        />

        <!-- 分頁 B：結算、圓餅圖統計、結算匯率切換與一鍵分享 -->
        <ProjectSettleTab
          v-else-if="projectTab === 'settle' && store.activeProjectSettleUp"
          :project="store.activeProject"
          :settle-up="store.activeProjectSettleUp"
          :base-settle-up="store.activeProjectBaseSettleUp"
          :expenses="store.activeProjectEffectiveExpenses"
          :raw-expenses="store.activeProjectExpenses"
          :settlements="store.activeProjectSettlements"
          :my-member-id="activeProjectMyMemberId"
          @record-payment="openRecordSettlementModal"
          @open-pool-collect="poolCollectModalOpen = true"
          @edit-settlement="startEditTransaction"
          @edit-expense="startEditTransaction"
          @inspect-member="handleInspectMemberInExpenses"
          @delete-settlement="handleDeleteTransaction"
          @delete-settlements-batch="handleDeleteTransactionsBatch"
          @toast="showToast($event)"
        />

        <!-- 分頁 C：成員與專案設定 -->
        <ProjectSettingsTab
          v-else-if="projectTab === 'settings'"
          :project="store.activeProject"
          @project-deleted="handleProjectDeleted"
          @toast="showToast($event)"
        />

        <!-- 浮動「+ 記一筆」按鈕（僅於明細頁顯示，避免在結算頁遮擋右下角「記錄已付」與刪除按鈕） -->
        <div
          v-if="projectTab === 'expenses'"
          class="safe-fab-bottom pointer-events-none fixed inset-x-0 z-40"
        >
          <div class="mx-auto flex max-w-xl justify-end px-4 md:max-w-3xl lg:max-w-5xl">
            <button
              type="button"
              class="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3.5 text-sm font-bold text-white shadow-xl transition hover:scale-105 active:scale-95 dark:bg-emerald-500 dark:text-slate-950"
              @click="openAddProjectExpenseSheet"
            >
              <Plus class="h-5 w-5" />
              <span>{{ t('project.fabAdd') }}</span>
            </button>
          </div>
        </div>
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
      :currency="settleCurrency"
      @close="settleSheetOpen = false"
      @saved="showToast($event)"
    />

    <!-- 大團公費袋／批次收公費彈窗 -->
    <PoolCollectModal
      :open="poolCollectModalOpen"
      :project="store.activeProject"
      @close="poolCollectModalOpen = false"
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

    <!-- 全域自製確認對話框（完全取代原生 window.confirm） -->
    <ConfirmDialog />
  </div>
</template>
