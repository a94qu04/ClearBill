<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Plus,
  X,
} from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'

interface Props {
  open: boolean
  isTouchDevice?: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'selectProject', projectId: string): void
  (e: 'createProject'): void
}>()

const { t } = useI18n()
const store = useLedgerStore()

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
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
      @click.self="emit('close')"
    >
      <div
        class="max-h-[82vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl"
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
                <div class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('project.memberCount', { count: proj.members.length }) }} · {{ proj.baseCurrency }}
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
