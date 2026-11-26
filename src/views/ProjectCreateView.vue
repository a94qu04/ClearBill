<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ImagePlus, Plus, X } from 'lucide-vue-next'
import {
  AVATAR_PALETTE,
  PROJECT_CARD_PALETTE,
  useLedgerStore,
} from '@/stores/ledgerStore'
import { compressCoverImageFileToDataUrl } from '@/platform/imageCompressor'
import type { SplitMode } from '@/schemas/ledgerSchema'
import CurrencyQuickAddPicker from '@/components/CurrencyQuickAddPicker.vue'
import { askConfirm } from '@/composables/useConfirm'
import {
  getHumanMembers,
  getProjectCardStyle,
} from '@/views/projectCardHelpers'

const emit = defineEmits<{
  created: []
  toast: [message: string]
}>()

const { t } = useI18n()
const store = useLedgerStore()

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

function captureSnapshot(): string {
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

function resetForm() {
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
  createProjectInitialSnapshot.value = captureSnapshot()
}

onMounted(() => {
  resetForm()
})

const isDirty = computed(() => {
  return captureSnapshot() !== createProjectInitialSnapshot.value
})

async function confirmLeaveIfDirty(): Promise<boolean> {
  if (!isDirty.value) return true
  return askConfirm({
    title: t('project.discardCreateTitle'),
    message: t('project.discardCreateMessage'),
    confirmText: t('project.discardButton'),
    tone: 'danger',
  })
}

function handleCurrencyAdded(code: string) {
  projectCurrency.value = code
  createNewCurrencyOpen.value = false
}

async function handleCoverUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    projectCardCoverImage.value = await compressCoverImageFileToDataUrl(file)
  } catch {
    emit('toast', t('photo.uploadError'))
  } finally {
    input.value = ''
  }
}

function copyMembersFromProject(sourceProjectId: string) {
  const source = store.getProjectById(sourceProjectId)
  if (!source) return
  const humans = getHumanMembers(source)
  projectMembersList.value = humans.map((m) => m.name)
  newProjectMemberInput.value = ''
  emit(
    'toast',
    t('project.membersCopiedToast', {
      name: source.name,
      count: humans.length,
    }),
  )
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
    emit('toast', t('validation.duplicateMemberName', { name: firstDuplicate }))
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
    emit('created')
  } catch {
    projectFormError.value = t('home.saveFailed')
  }
}

defineExpose({
  confirmLeaveIfDirty,
})
</script>

<template>
  <!-- 建立旅遊 / 分帳專案 -->
  <div class="mx-auto max-w-xl">
    <section class="rounded-3xl bg-white p-5 shadow-sm dark:bg-[#1C1C1E]">
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

        <p class="-mt-1.5 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
          {{ t('project.baseCurrencyHint') }}
        </p>

        <!-- 建專案現場中文搜尋新增幣別（不必跳離頁面遺失已輸入之成員名單） -->
        <CurrencyQuickAddPicker
          v-if="createNewCurrencyOpen"
          @added="handleCurrencyAdded"
          @close="createNewCurrencyOpen = false"
          @toast="emit('toast', $event)"
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
                @change="handleCoverUpload"
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
</template>
