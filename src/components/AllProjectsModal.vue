<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Plus,
  X,
} from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useModalLayer } from '@/composables/useModalLayer'
import { formatCurrencyAmount } from '@/core/currency'
import MemberAvatar from '@/components/MemberAvatar.vue'

interface Props {
  open: boolean
  isTouchDevice?: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'selectProject', projectId: string): void
  (e: 'createProject'): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => props.open,
  () => emit('close'),
  dialogRef,
)

function getHumanMembers(proj: { members: Array<{ id: string; name: string; avatarColor?: string; avatarImage?: string; isPool?: boolean }> }) {
  const humans = proj.members.filter((m) => !m.isPool)
  return humans.length > 0 ? humans : proj.members
}

const showArchived = ref(false)

async function handleUnarchive(projectId: string) {
  const updated = await store.toggleArchiveProject(projectId)
  if (updated) {
    emit('toast', t('project.unarchivedToast', { name: updated.name }))
  }
}

function fmtProjectTotal(projectId: string, currency: string): string {
  return formatCurrencyAmount(
    store.getProjectTotalExpense(projectId),
    currency,
    locale.value,
  )
}

const draggingProjectId = ref<string | null>(null)
const dragOverProjectId = ref<string | null>(null)

function onDragStart(projectId: string, event: DragEvent) {
  draggingProjectId.value = projectId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', projectId)
  }
}

function onDragOver(projectId: string, event: DragEvent) {
  event.preventDefault()
  if (draggingProjectId.value && draggingProjectId.value !== projectId) {
    dragOverProjectId.value = projectId
  }
}

function onDrop(targetId: string, event: DragEvent) {
  event.preventDefault()
  const sourceId =
    draggingProjectId.value || event.dataTransfer?.getData('text/plain') || ''
  if (sourceId && sourceId !== targetId) {
    store.reorderProjects(sourceId, targetId)
  }
  draggingProjectId.value = null
  dragOverProjectId.value = null
}

function onDragEnd() {
  draggingProjectId.value = null
  dragOverProjectId.value = null
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      :aria-label="t('home.allProjectsModalTitle')"
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
      @click.self="emit('close')"
    >
      <div
        class="safe-sheet-pb max-h-[82vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-slate-200 bg-white px-5 pt-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl sm:pb-5"
      >
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-base font-bold text-slate-900 dark:text-white">
            {{ t('home.allProjectsModalTitle') }} ({{ store.activeProjects.length }})
          </h2>
          <button
            type="button"
            :aria-label="t('settings.close')"
            class="rounded-full p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            @click="emit('close')"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <p
          v-if="store.activeProjects.length > 1"
          class="mb-2.5 text-[11px] text-slate-400"
        >
          {{
            isTouchDevice
              ? t('home.dragProjectHintTouch')
              : t('home.dragProjectHint')
          }}
        </p>

        <ul class="space-y-2">
          <li
            v-for="(proj, idx) in store.activeProjects"
            :key="proj.id"
            draggable="true"
            :data-project-id="proj.id"
            class="flex items-center gap-2 rounded-2xl border px-3 py-2.5 transition"
            :class="[
              store.activeProject?.id === proj.id
                ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-500/70 dark:bg-emerald-950/60'
                : 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800/70',
              dragOverProjectId === proj.id
                ? 'border-dashed border-emerald-500 ring-2 ring-emerald-500/30'
                : '',
              draggingProjectId === proj.id ? 'opacity-50' : '',
            ]"
            @dragstart="onDragStart(proj.id, $event)"
            @dragover="onDragOver(proj.id, $event)"
            @drop="onDrop(proj.id, $event)"
            @dragend="onDragEnd"
          >
            <!-- 桌機拖曳把手 -->
            <span
              class="shrink-0 cursor-grab text-slate-400 active:cursor-grabbing"
              :title="t('home.dragProjectHint')"
            >
              <GripVertical class="h-4 w-4" />
            </span>

            <!-- 專案名稱與摘要 -->
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
              @click="emit('selectProject', proj.id)"
            >
              <div class="min-w-0">
                <div class="truncate text-sm font-bold text-slate-900 dark:text-white">
                  {{ proj.name }}
                </div>
                <div
                  class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
                  :title="getHumanMembers(proj).map((m) => m.name).join('、')"
                >
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
                    <span
                      v-if="getHumanMembers(proj).length > 4"
                      class="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-slate-200 px-1 text-[8px] font-bold text-slate-700 ring-1 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-900"
                    >
                      +{{ getHumanMembers(proj).length - 4 }}
                    </span>
                  </span>
                  <span>{{ t('project.memberCount', { count: getHumanMembers(proj).length }) }}</span>
                  <span>·</span>
                  <span class="font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {{ fmtProjectTotal(proj.id, proj.baseCurrency) }}
                  </span>
                </div>
              </div>
              <Check
                v-if="store.activeProject?.id === proj.id"
                class="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
            </button>

            <!-- 觸控友善「上移／下移」明確按鈕 -->
            <div
              v-if="store.activeProjects.length > 1"
              class="flex shrink-0 items-center gap-1"
            >
              <button
                type="button"
                :disabled="idx === 0"
                :aria-label="t('home.moveProjectUp')"
                :title="t('home.moveProjectUp')"
                class="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                @click.stop="store.moveProjectOrder(proj.id, 'up')"
              >
                <ChevronUp class="h-4 w-4" />
              </button>
              <button
                type="button"
                :disabled="idx === store.activeProjects.length - 1"
                :aria-label="t('home.moveProjectDown')"
                :title="t('home.moveProjectDown')"
                class="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                @click.stop="store.moveProjectOrder(proj.id, 'down')"
              >
                <ChevronDown class="h-4 w-4" />
              </button>
            </div>
          </li>
        </ul>

        <!-- 已封存專案折疊區 -->
        <div
          v-if="store.archivedProjects.length > 0"
          class="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800"
        >
          <button
            type="button"
            class="flex w-full items-center justify-between text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
            @click="showArchived = !showArchived"
          >
            <span class="inline-flex items-center gap-1.5">
              <Archive class="h-3.5 w-3.5" />
              <span>{{
                t('project.archivedSectionTitle', {
                  count: store.archivedProjects.length,
                })
              }}</span>
            </span>
            <ChevronUp v-if="showArchived" class="h-4 w-4" />
            <ChevronDown v-else class="h-4 w-4" />
          </button>

          <ul v-if="showArchived" class="mt-2 space-y-2">
            <li
              v-for="proj in store.archivedProjects"
              :key="proj.id"
              class="flex items-center justify-between gap-2 rounded-2xl border border-slate-200/80 bg-slate-50/70 px-3 py-2.5 opacity-85 transition hover:opacity-100 dark:border-slate-800 dark:bg-slate-800/40"
            >
              <button
                type="button"
                class="min-w-0 flex-1 text-left"
                @click="emit('selectProject', proj.id)"
              >
                <div class="truncate text-sm font-bold text-slate-700 dark:text-slate-200">
                  {{ proj.name }}
                </div>
                <div
                  class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400"
                  :title="getHumanMembers(proj).map((m) => m.name).join('、')"
                >
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
                    <span
                      v-if="getHumanMembers(proj).length > 4"
                      class="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-slate-200 px-1 text-[8px] font-bold text-slate-700 ring-1 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-900"
                    >
                      +{{ getHumanMembers(proj).length - 4 }}
                    </span>
                  </span>
                  <span>{{ t('project.memberCount', { count: getHumanMembers(proj).length }) }}</span>
                  <span>·</span>
                  <span class="font-bold tabular-nums text-slate-600 dark:text-slate-300">
                    {{ fmtProjectTotal(proj.id, proj.baseCurrency) }}
                  </span>
                </div>
              </button>
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-900 dark:text-emerald-400"
                @click.stop="handleUnarchive(proj.id)"
              >
                <ArchiveRestore class="h-3.5 w-3.5" />
                <span>{{ t('project.unarchiveButton') }}</span>
              </button>
            </li>
          </ul>
        </div>

        <button
          type="button"
          class="mt-4 flex w-full items-center justify-center gap-1.5 rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white dark:bg-emerald-500 dark:text-slate-950"
          @click="emit('createProject')"
        >
          <Plus class="h-4 w-4" />
          <span>{{ t('project.createTitle') }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>
