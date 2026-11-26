<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Cloud,
  GripVertical,
  LayoutGrid,
  Plus,
  Sparkles,
} from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import type { Transaction } from '@/schemas/ledgerSchema'
import MemberAvatar from '@/components/MemberAvatar.vue'
import MoneyText from '@/components/MoneyText.vue'
import TransactionListSection from '@/components/TransactionListSection.vue'
import {
  getHumanMembers,
  getProjectCardStyle,
  hasCustomProjectCardBg,
} from '@/views/projectCardHelpers'

defineProps<{
  isTouchDevice: boolean
}>()

const emit = defineEmits<{
  openProject: [projectId: string]
  openCreateProject: []
  openAllProjects: []
  openQuickAdd: []
  demoCreated: []
  editTx: [tx: Transaction]
  duplicateTx: [tx: Transaction]
  deleteTx: [id: string]
  previewPhotos: [payload: { photos: string[]; index: number }]
  toast: [message: string]
}>()

const { t } = useI18n()
const store = useLedgerStore()

// 專案網格拖曳排序狀態（桌機）
const draggingProjectId = ref<string | null>(null)
const dragOverProjectId = ref<string | null>(null)

const homeTxListRef = ref<InstanceType<typeof TransactionListSection> | null>(null)

const homeProjectTransactions = computed(() =>
  store.visibleTransactions.filter((tx) => {
    if (!tx.projectId) return false
    const proj = store.getProjectById(tx.projectId)
    return Boolean(proj && !proj.isArchived)
  }),
)

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
    emit('demoCreated')
    emit('toast', t('demo.createdToast'))
  } catch {
    emit('toast', t('home.saveFailed'))
  }
}

function resetFilters() {
  homeTxListRef.value?.resetFilters()
}

defineExpose({
  resetFilters,
})
</script>

<template>
  <!-- 極簡首頁（桌機雙欄／平板寬版／手機精簡） -->
  <div class="space-y-5 lg:grid lg:grid-cols-12 lg:items-start lg:gap-5 lg:space-y-0">
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
              @click="emit('openAllProjects')"
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
              @click="emit('openCreateProject')"
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
          @click="emit('openCreateProject')"
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
            @click="emit('openProject', proj.id)"
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
              <MoneyText
                :amount="store.getProjectTotalExpense(proj.id)"
                :currency="proj.baseCurrency"
              />
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
        @click="emit('openAllProjects')"
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
      @edit="emit('editTx', $event)"
      @duplicate="emit('duplicateTx', $event)"
      @delete="emit('deleteTx', $event)"
      @open-project="emit('openProject', $event)"
      @preview-photos="emit('previewPhotos', $event)"
      @toast="emit('toast', $event)"
    />

    <!-- 首頁浮動「+」按鈕（自動帶入最後一筆之專案、幣別與分攤明細） -->
    <div
      v-if="store.activeProjects.length > 0"
      class="safe-fab-bottom pointer-events-none fixed inset-x-0 z-40"
    >
      <div class="mx-auto flex max-w-xl justify-end px-4 md:max-w-3xl lg:max-w-5xl">
        <button
          type="button"
          :aria-label="t('project.fabAdd')"
          :title="t('project.fabAdd')"
          class="pointer-events-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-xl transition hover:scale-105 active:scale-95 dark:bg-emerald-500 dark:text-slate-950"
          @click="emit('openQuickAdd')"
        >
          <Plus class="h-6 w-6" />
        </button>
      </div>
    </div>
  </div>
</template>
