<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  ArchiveRestore,
  Camera,
  FileJson,
  ImagePlus,
  Pencil,
  Trash2,
  UserPlus,
  X,
} from 'lucide-vue-next'
import MemberAvatar from '@/components/MemberAvatar.vue'
import {
  compressAvatarImageFileToDataUrl,
  compressCoverImageFileToDataUrl,
} from '@/core/imageCompressor'
import {
  AVATAR_PALETTE,
  PROJECT_CARD_PALETTE,
  useLedgerStore,
} from '@/stores/ledgerStore'
import { askConfirm } from '@/composables/useConfirm'
import {
  getTodayIso,
  sanitizeExportFilename,
  triggerTextFileDownload,
} from '@/core/ledgerHelpers'
import type { Project, ProjectMember, SplitMode } from '@/schemas/ledgerSchema'

interface Props {
  project: Project
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'projectDeleted'): void
  (e: 'toast', message: string): void
}>()

const { t } = useI18n()
const store = useLedgerStore()

const editProjectName = ref(props.project.name)
const editProjectCurrency = ref(props.project.baseCurrency)
const editProjectDefaultSplitMode = ref<SplitMode>(props.project.defaultSplitMode)
const editProjectDefaultPayerId = ref(
  props.project.defaultPayerId || props.project.members[0]?.id || '',
)
const editProjectCardColor = ref<string | undefined>(props.project.cardColor)
const editProjectCardCoverImage = ref<string | undefined>(
  props.project.cardCoverImage,
)

const newMemberName = ref('')
const editingMemberId = ref<string | null>(null)
const editingMemberName = ref('')
const editingMemberColor = ref<string>(AVATAR_PALETTE[0])
const editingMemberAvatarImage = ref<string | undefined>(undefined)
const editingMemberPaymentInfo = ref('')

watch(
  () => props.project,
  (proj) => {
    editProjectName.value = proj.name
    editProjectCurrency.value = proj.baseCurrency
    editProjectDefaultSplitMode.value = proj.defaultSplitMode
    editProjectDefaultPayerId.value =
      proj.defaultPayerId || proj.members[0]?.id || ''
    editProjectCardColor.value = proj.cardColor
    editProjectCardCoverImage.value = proj.cardCoverImage
  },
  { deep: true },
)

async function handleProjectCoverUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    editProjectCardCoverImage.value = await compressCoverImageFileToDataUrl(file)
  } catch {
    emit('toast', t('photo.uploadError'))
  } finally {
    input.value = ''
  }
}

function getPreviewCardStyle(): Record<string, string> | undefined {
  if (editProjectCardCoverImage.value) {
    return {
      backgroundImage: `url(${editProjectCardCoverImage.value})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
  }
  if (editProjectCardColor.value) {
    return {
      backgroundColor: editProjectCardColor.value,
      backgroundImage:
        'linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(0,0,0,0.22) 100%)',
    }
  }
  return undefined
}

async function handleSaveProjectSettings() {
  if (!editProjectName.value.trim()) return

  const currencyChanged =
    editProjectCurrency.value.trim().toUpperCase() !==
    props.project.baseCurrency.trim().toUpperCase()
  const existingTxCount = store.getProjectTransactionCount(props.project.id)

  if (currencyChanged && existingTxCount > 0) {
    const confirmed = await askConfirm({
      title: t('project.currencyLabel'),
      message: t('project.changeCurrencyConfirm', {
        from: props.project.baseCurrency,
        to: editProjectCurrency.value,
        count: existingTxCount,
      }),
      tone: 'primary',
    })
    if (!confirmed) {
      editProjectCurrency.value = props.project.baseCurrency
      return
    }
  }

  try {
    await store.updateProject(props.project.id, {
      name: editProjectName.value,
      baseCurrency: editProjectCurrency.value,
      defaultSplitMode: editProjectDefaultSplitMode.value,
      defaultPayerId: editProjectDefaultPayerId.value,
      cardColor: editProjectCardColor.value ?? null,
      cardCoverImage: editProjectCardCoverImage.value ?? null,
    })
    emit('toast', t('project.projectUpdatedToast'))
  } catch {
    emit('toast', t('home.saveFailed'))
  }
}

async function handleAddMember() {
  const name = newMemberName.value.trim()
  if (!name) return
  try {
    const updated = await store.addProjectMember(props.project.id, name)
    if (updated) {
      newMemberName.value = ''
      emit('toast', t('project.memberAddedToast', { name }))
    }
  } catch {
    emit('toast', t('home.saveFailed'))
  }
}

function startEditMember(member: ProjectMember) {
  editingMemberId.value = member.id
  editingMemberName.value = member.name
  editingMemberColor.value = member.avatarColor || AVATAR_PALETTE[0]
  editingMemberAvatarImage.value = member.avatarImage
  editingMemberPaymentInfo.value = member.paymentInfo ?? ''
}

async function handleMemberAvatarUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    editingMemberAvatarImage.value = await compressAvatarImageFileToDataUrl(
      file,
      160,
      0.78,
    )
  } catch {
    emit('toast', t('photo.uploadError'))
  } finally {
    input.value = ''
  }
}

function handleApplyMyProfileToEditingMember() {
  if (store.userProfile.displayName) {
    editingMemberName.value = store.userProfile.displayName
  }
  editingMemberColor.value =
    store.userProfile.avatarColor || editingMemberColor.value
  editingMemberAvatarImage.value = store.userProfile.avatarImage
  if (store.userProfile.paymentInfo !== undefined) {
    editingMemberPaymentInfo.value = store.userProfile.paymentInfo
  }
}

async function handleSaveMemberEdit() {
  if (!editingMemberId.value) return
  const trimmed = editingMemberName.value.trim()
  if (!trimmed) return
  await store.updateProjectMember(props.project.id, editingMemberId.value, {
    name: trimmed,
    avatarColor: editingMemberColor.value,
    avatarImage: editingMemberAvatarImage.value ?? null,
    paymentInfo: editingMemberPaymentInfo.value.trim() || null,
  })
  editingMemberId.value = null
  emit('toast', t('project.memberUpdatedToast'))
}

async function handleRemoveMember(member: ProjectMember) {
  const res = await store.removeProjectMember(props.project.id, member.id)
  if (!res.ok) {
    if (res.reason === 'last_member') {
      emit('toast', t('project.memberDeleteLastError'))
    } else if (res.reason === 'in_use') {
      emit('toast', t('project.memberDeleteInUseError'))
    }
    return
  }
  if (editingMemberId.value === member.id) {
    editingMemberId.value = null
  }
  emit('toast', t('project.memberDeletedToast'))
}

async function handleToggleArchive() {
  const updated = await store.toggleArchiveProject(props.project.id)
  if (!updated) return
  if (updated.isArchived) {
    emit('toast', t('project.archivedToast', { name: updated.name }))
  } else {
    emit('toast', t('project.unarchivedToast', { name: updated.name }))
  }
}

async function handleDeleteProject() {
  const confirmed = await askConfirm({
    title: t('project.deleteProject'),
    message: t('project.deleteProjectConfirm', { name: props.project.name }),
    confirmText: t('home.deleteTx'),
    tone: 'danger',
  })
  if (!confirmed) return
  await store.softDeleteProject(props.project.id)
  emit('toast', t('project.projectDeletedToast'))
  emit('projectDeleted')
}

function handleExportProjectJson() {
  const backup = store.exportProjectBackup(props.project.id)
  if (!backup) return
  const safeName = sanitizeExportFilename(props.project.name)
  triggerTextFileDownload(
    JSON.stringify(backup, null, 2),
    `clearbill-${safeName}-${getTodayIso()}.json`,
    'application/json;charset=utf-8',
  )
  emit('toast', t('export.projectJsonExportedToast'))
}
</script>

<template>
  <div class="space-y-4 lg:grid lg:grid-cols-12 lg:items-start lg:gap-5 lg:space-y-0">
    <!-- 成員管理（桌機左欄） -->
    <section
      class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 lg:col-span-5"
    >
      <h3 class="mb-3 text-xs font-bold text-slate-700 dark:text-slate-200">
        {{ t('project.membersManageTitle') }}
      </h3>

      <ul class="divide-y divide-slate-100 dark:divide-slate-800">
        <li
          v-for="member in project.members"
          :key="member.id"
          class="py-2.5"
        >
          <div
            v-if="editingMemberId === member.id"
            class="space-y-2.5 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/70"
          >
            <div class="flex items-center gap-2.5">
              <div class="relative shrink-0">
                <MemberAvatar
                  :name="editingMemberName || member.name"
                  :color="editingMemberColor"
                  :image="editingMemberAvatarImage"
                  size="md"
                />
                <label
                  class="absolute -bottom-1 -right-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-slate-900 text-white shadow dark:bg-emerald-500 dark:text-slate-950"
                  :title="t('profile.uploadAvatar')"
                >
                  <Camera class="h-2.5 w-2.5" />
                  <input
                    type="file"
                    accept="image/*"
                    class="hidden"
                    @change="handleMemberAvatarUpload"
                  />
                </label>
              </div>
              <input
                v-model="editingMemberName"
                type="text"
                class="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                @keyup.enter="handleSaveMemberEdit"
              />
              <button
                type="button"
                class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white"
                @click="handleSaveMemberEdit"
              >
                {{ t('daily.saveButton') }}
              </button>
              <button
                type="button"
                class="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 dark:border-slate-700"
                @click="editingMemberId = null"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-1.5">
                <button
                  v-for="color in AVATAR_PALETTE"
                  :key="color"
                  type="button"
                  class="h-5 w-5 rounded-full"
                  :style="{ backgroundColor: color }"
                  :class="
                    editingMemberColor === color
                      ? 'ring-2 ring-slate-900 ring-offset-1 dark:ring-white'
                      : 'opacity-70'
                  "
                  @click="editingMemberColor = color"
                />
              </div>
              <div class="flex items-center gap-2 text-[11px] font-semibold">
                <button
                  v-if="
                    store.userProfile.displayName ||
                    store.userProfile.avatarImage ||
                    store.userProfile.paymentInfo
                  "
                  type="button"
                  class="text-emerald-600 hover:underline dark:text-emerald-400"
                  @click="handleApplyMyProfileToEditingMember"
                >
                  {{ t('profile.useMyProfile') }}
                </button>
                <button
                  v-if="editingMemberAvatarImage"
                  type="button"
                  class="text-rose-500 hover:underline"
                  @click="editingMemberAvatarImage = undefined"
                >
                  {{ t('profile.removeAvatar') }}
                </button>
              </div>
            </div>
            <input
              v-model="editingMemberPaymentInfo"
              type="text"
              maxlength="120"
              :placeholder="t('profile.paymentInfoPlaceholder')"
              class="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-800 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              @keyup.enter="handleSaveMemberEdit"
            />
          </div>

          <div v-else class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2.5">
              <MemberAvatar
                :name="member.name"
                :color="member.avatarColor"
                :image="member.avatarImage"
                size="md"
              />
              <div class="min-w-0">
                <div class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                  {{ member.name }}
                </div>
                <div
                  v-if="member.paymentInfo"
                  class="truncate text-[10px] text-slate-400 dark:text-slate-500"
                >
                  {{ member.paymentInfo }}
                </div>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <button
                type="button"
                :aria-label="t('home.editTx')"
                class="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/60"
                @click="startEditMember(member)"
              >
                <Pencil class="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                :aria-label="t('home.deleteTx')"
                class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
                @click="handleRemoveMember(member)"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </li>
      </ul>

      <div class="mt-3 flex gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <input
          v-model="newMemberName"
          type="text"
          :placeholder="t('project.addMemberPlaceholder')"
          class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          @keyup.enter="handleAddMember"
        />
        <button
          type="button"
          :disabled="!newMemberName.trim()"
          class="inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
          @click="handleAddMember"
        >
          <UserPlus class="h-3.5 w-3.5" />
          <span>{{ t('project.addMemberButton') }}</span>
        </button>
      </div>
    </section>

    <!-- 右欄：專案基本設定 ＋ 單一專案本地備份 -->
    <div class="space-y-4 lg:col-span-7">
    <!-- 專案基本設定 -->
    <section
      class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <h3 class="mb-3 text-xs font-bold text-slate-700 dark:text-slate-200">
        {{ t('project.projectSettingsTitle') }}
      </h3>
      <form class="space-y-3" @submit.prevent="handleSaveProjectSettings">
        <div>
          <label class="mb-1 block text-[11px] font-semibold text-slate-500">
            {{ t('project.nameLabel') }}
          </label>
          <input
            v-model="editProjectName"
            type="text"
            class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
        </div>

        <div class="grid grid-cols-2 gap-2.5">
          <div>
            <label class="mb-1 block text-[11px] font-semibold text-slate-500">
              {{ t('project.currencyLabel') }}
            </label>
            <select
              v-model="editProjectCurrency"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
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
            <label class="mb-1 block text-[11px] font-semibold text-slate-500">
              {{ t('project.defaultPayerLabel') }}
            </label>
            <select
              v-model="editProjectDefaultPayerId"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              <option
                v-for="m in project.members"
                :key="m.id"
                :value="m.id"
              >
                {{ m.name }}
              </option>
            </select>
          </div>
        </div>

        <div>
          <label class="mb-1 block text-[11px] font-semibold text-slate-500">
            {{ t('project.defaultSplitModeLabel') }}
          </label>
          <select
            v-model="editProjectDefaultSplitMode"
            class="w-full rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          >
            <option value="equal">{{ t('split.tabEqual') }}</option>
            <option value="custom_plus_equal">{{ t('split.tabCustomPlusEqual') }}</option>
            <option value="weight">{{ t('split.tabWeight') }}</option>
            <option value="percentage">{{ t('split.tabPercent') }}</option>
          </select>
        </div>

        <!-- 專案卡片背景（自訂色票或上傳封面照片） -->
        <div class="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div class="flex items-center justify-between">
            <label class="text-[11px] font-semibold text-slate-500">
              {{ t('project.cardBgLabel') }}
            </label>
            <button
              v-if="editProjectCardColor || editProjectCardCoverImage"
              type="button"
              class="text-[11px] font-semibold text-slate-400 hover:text-rose-500"
              @click="
                editProjectCardColor = undefined;
                editProjectCardCoverImage = undefined
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
                !editProjectCardCoverImage && editProjectCardColor === color
                  ? 'ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-slate-900'
                  : 'opacity-80 hover:opacity-100'
              "
              @click="
                editProjectCardColor = color;
                editProjectCardCoverImage = undefined
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
                @change="handleProjectCoverUpload"
              />
            </label>
          </div>

          <div
            v-if="editProjectCardColor || editProjectCardCoverImage"
            class="relative h-20 overflow-hidden rounded-2xl border border-white/15 px-3.5 py-2.5 text-white shadow-sm"
            :style="getPreviewCardStyle()"
          >
            <div
              v-if="editProjectCardCoverImage"
              class="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/80 via-slate-950/40 to-slate-950/30"
            />
            <div class="relative z-10 flex h-full flex-col justify-between">
              <div class="flex items-center justify-between text-xs font-bold">
                <span class="truncate">{{ editProjectName || project.name }}</span>
                <span class="rounded bg-black/35 px-1.5 py-0.5 text-[10px]">
                  {{ editProjectCurrency }}
                </span>
              </div>
              <div class="text-[11px] font-semibold text-emerald-300">
                {{ t('project.cardBgPreviewHint') }}
              </div>
            </div>
          </div>
        </div>

        <button
          type="submit"
          class="w-full rounded-xl bg-slate-900 py-2.5 text-xs font-bold text-white dark:bg-emerald-500 dark:text-slate-950"
        >
          {{ t('project.saveProjectSettings') }}
        </button>
      </form>

      <div class="mt-4 flex flex-wrap items-center justify-end gap-4 border-t border-slate-100 pt-3 dark:border-slate-800">
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 hover:underline dark:text-amber-400"
          @click="handleToggleArchive"
        >
          <ArchiveRestore v-if="project.isArchived" class="h-3.5 w-3.5" />
          <Archive v-else class="h-3.5 w-3.5" />
          <span>{{
            project.isArchived
              ? t('project.unarchiveButton')
              : t('project.archiveButton')
          }}</span>
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:underline dark:text-rose-400"
          @click="handleDeleteProject"
        >
          <Trash2 class="h-3.5 w-3.5" />
          <span>{{ t('project.deleteProject') }}</span>
        </button>
      </div>
    </section>

    <!-- 單一專案本地 JSON 備份（報表 Excel 與長截圖統一收斂於「結算」分頁） -->
    <section
      class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div class="min-w-0 flex-1">
        <h3 class="text-xs font-bold text-slate-700 dark:text-slate-200">
          {{ t('export.projectBackupTitle') }}
        </h3>
        <p class="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          {{ t('export.projectBackupDesc') }}
        </p>
      </div>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        @click="handleExportProjectJson"
      >
        <FileJson class="h-4 w-4 text-sky-600 dark:text-sky-400" />
        <span>{{ t('export.projectJsonButton') }}</span>
      </button>
    </section>
    </div>
  </div>
</template>
