<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft,
  Check,
  GripVertical,
  LayoutGrid,
  Plus,
  Receipt,
  Undo2,
} from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import { formatCurrencyAmount } from '@/core/currency'
import {
  parseQuickIntake,
  type ParsedQuickIntakeResult,
} from '@/core/quickIntakeParser'
import type { SplitMode, Transaction } from '@/schemas/ledgerSchema'
import AllProjectsModal from '@/components/AllProjectsModal.vue'
import PhotoLightboxModal from '@/components/PhotoLightboxModal.vue'
import ProjectExpenseModal from '@/components/ProjectExpenseModal.vue'
import ProjectSettleTab from '@/components/ProjectSettleTab.vue'
import ProjectSettingsTab from '@/components/ProjectSettingsTab.vue'
import SettingsModal from '@/components/SettingsModal.vue'
import SettlementPaymentModal from '@/components/SettlementPaymentModal.vue'
import TransactionListSection from '@/components/TransactionListSection.vue'

type ActiveView = 'home' | 'project_create' | 'project_workspace'
type ProjectTab = 'expenses' | 'settle' | 'settings'

const { t, locale } = useI18n()
const store = useLedgerStore()

// 視圖與全域 UI 狀態
const activeView = ref<ActiveView>('home')
const projectTab = ref<ProjectTab>('expenses')
const settingsOpen = ref(false)
const allProjectsSheetOpen = ref(false)
const isDark = ref(false)
const isTouchDevice = ref(false)
const previewPhotos = ref<string[]>([])
const previewPhotoIndex = ref(0)

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
  projectMembersText.value = source.members.map((m) => m.name).join(', ')
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

// 建立新專案表單狀態
const projectName = ref('')
const projectCurrency = ref(store.defaultCurrency)
const projectDefaultSplitMode = ref<SplitMode>('equal')
const projectMembersText = ref('')
const projectFormError = ref('')

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
  store.visibleTransactions.filter(
    (tx) => Boolean(tx.projectId) && Boolean(store.getProjectById(tx.projectId)),
  ),
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
  projectMembersText.value = [
    t('project.defaultMember1'),
    t('project.defaultMember2'),
    t('project.defaultMember3'),
  ].join(', ')
  activeView.value = 'project_create'
}

async function handleCreateProject() {
  projectFormError.value = ''
  const trimmedName = projectName.value.trim()
  if (!trimmedName) {
    projectFormError.value = t('validation.projectNameRequired')
    return
  }

  const members = projectMembersText.value
    .split(/[,，\n]+/)
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

// 保留 iOS 捷徑 / Web Share Target Hash 網址接收能力
function handleHashQuickAdd() {
  if (typeof window === 'undefined') return
  const hash = window.location.hash
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

onMounted(async () => {
  initTheme()
  detectTouchDevice()
  await store.initFromIndexedDb()
  handleHashQuickAdd()
  window.addEventListener('hashchange', handleHashQuickAdd)
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', handleHashQuickAdd)
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <div
    class="min-h-screen bg-slate-50 pb-24 text-slate-900 transition-colors duration-200 dark:bg-slate-950 dark:text-slate-100"
  >
    <!-- 極簡 App 頂部導覽列（設定由左上 App Icon 點擊開啟） -->
    <header
      class="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur-md transition-colors dark:border-slate-800/80 dark:bg-slate-950/90"
    >
      <div class="mx-auto flex h-14 max-w-xl items-center justify-between px-4">
        <div class="flex min-w-0 items-center gap-2">
          <button
            v-if="activeView !== 'home'"
            type="button"
            :aria-label="t('home.backToHome')"
            class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            @click="activeView = 'home'"
          >
            <ArrowLeft class="h-5 w-5" />
          </button>

          <button
            type="button"
            :aria-label="t('app.openSettings')"
            :title="t('app.openSettings')"
            class="relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-emerald-400 shadow-sm transition hover:scale-105 active:scale-95 dark:bg-emerald-500/15 dark:ring-1 dark:ring-emerald-500/40"
            @click="settingsOpen = true"
          >
            <Receipt class="h-4 w-4" />
            <span
              v-if="store.deletedTransactions.length > 0"
              class="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white dark:ring-slate-950"
            />
          </button>

          <h1 class="truncate text-base font-bold tracking-tight text-slate-900 dark:text-white">
            {{ topBarTitle }}
          </h1>
        </div>

        <button
          v-if="activeView === 'project_workspace' && store.activeProjects.length > 0"
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          @click="allProjectsSheetOpen = true"
        >
          <LayoutGrid class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          <span>{{ t('home.viewAllProjects', { count: store.activeProjects.length }) }}</span>
        </button>
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
                v-if="store.activeProjects.length >= 2"
                type="button"
                class="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"
                @click="allProjectsSheetOpen = true"
              >
                <LayoutGrid class="h-3 w-3" />
                <span>{{ t('home.viewAllProjects', { count: store.activeProjects.length }) }}</span>
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

          <button
            v-if="store.activeProjects.length === 0"
            type="button"
            class="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm font-semibold text-emerald-600 transition hover:border-emerald-400 hover:bg-emerald-50/40 dark:border-slate-700 dark:bg-slate-900 dark:text-emerald-400"
            @click="openCreateProjectView"
          >
            <Plus class="h-4 w-4" />
            <span>{{ t('home.createFirstProject') }}</span>
          </button>

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
                  <span class="truncate text-xs font-bold">{{ proj.name }}</span>
                  <span class="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {{ proj.baseCurrency }}
                  </span>
                </div>
                <div class="flex w-full items-baseline justify-between gap-1">
                  <span class="truncate text-sm font-extrabold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {{ fmt(store.getProjectTotalExpense(proj.id), proj.baseCurrency) }}
                  </span>
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
                v-if="store.activeProjects.length > 0"
                class="space-y-1"
              >
                <div class="text-[11px] font-medium text-slate-400 dark:text-slate-500">
                  {{ t('project.copyMembersFromProject') }}
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="existingProj in store.activeProjects.slice(0, 6)"
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

              <textarea
                v-model="projectMembersText"
                rows="3"
                :placeholder="t('project.membersPlaceholder')"
                class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
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
          class="flex items-center justify-between rounded-2xl bg-slate-900 px-5 py-4 text-white dark:border dark:border-slate-800"
        >
          <div>
            <div class="text-xs font-medium text-emerald-400">
              {{ t('project.memberCount', { count: store.activeProject.members.length }) }}
              · {{ store.activeProject.baseCurrency }}
            </div>
            <div class="mt-0.5 text-lg font-bold">{{ store.activeProject.name }}</div>
          </div>
          <div class="text-right">
            <div class="text-[11px] text-slate-400">{{ t('project.totalSpent') }}</div>
            <div class="text-xl font-extrabold tabular-nums text-emerald-400">
              {{ fmt(activeProjectTotalSpent, store.activeProject.baseCurrency) }}
            </div>
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

    <!-- 側邊設定抽屜（一般／分類／幣別／本地＋Google 雲端備份／復原與清空） -->
    <SettingsModal
      :open="settingsOpen"
      :is-dark="isDark"
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
  </div>
</template>
