<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  ArchiveRestore,
  Camera,
  FileJson,
  ImagePlus,
  Info,
  Pencil,
  Trash2,
  UserPlus,
  Wallet,
  X,
} from 'lucide-vue-next'
import MemberAvatar from '@/components/MemberAvatar.vue'
import {
  compressAvatarImageFileToDataUrl,
  compressCoverImageFileToDataUrl,
} from '@/platform/imageCompressor'
import {
  AVATAR_PALETTE,
  PROJECT_CARD_PALETTE,
  useLedgerStore,
} from '@/stores/ledgerStore'
import { askConfirm } from '@/composables/useConfirm'
import {
  getTodayIso,
  sanitizeExportFilename,
} from '@/core/ledgerHelpers'
import { triggerTextFileDownload } from '@/platform/download'
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

function captureSettingsDraft(): string {
  return JSON.stringify({
    name: editProjectName.value,
    baseCurrency: editProjectCurrency.value,
    defaultSplitMode: editProjectDefaultSplitMode.value,
    defaultPayerId: editProjectDefaultPayerId.value,
    cardColor: editProjectCardColor.value ?? null,
    cardCoverImage: editProjectCardCoverImage.value ?? null,
  })
}

let syncedProjectId = props.project.id
let lastSyncedDraftSnapshot = captureSettingsDraft()

function hydrateSettingsFromProject(proj: Project) {
  editProjectName.value = proj.name
  editProjectCurrency.value = proj.baseCurrency
  editProjectDefaultSplitMode.value = proj.defaultSplitMode
  editProjectDefaultPayerId.value =
    proj.defaultPayerId || proj.members[0]?.id || ''
  editProjectCardColor.value = proj.cardColor
  editProjectCardCoverImage.value = proj.cardCoverImage
  syncedProjectId = proj.id
  lastSyncedDraftSnapshot = captureSettingsDraft()
}

// 多人協作推送遠端更新時，僅於切換專案或本機表單尚未修改（非 dirty）時才同步覆寫，避免輸入到一半被洗白
watch(
  () => props.project,
  (proj) => {
    const switchedProject = proj.id !== syncedProjectId
    const isFormClean = captureSettingsDraft() === lastSyncedDraftSnapshot
    if (switchedProject || isFormClean) {
      hydrateSettingsFromProject(proj)
      return
    }
    // 使用者正在編輯設定時保留草稿，僅在預設墊付人已被遠端刪除時安全回退
    if (
      editProjectDefaultPayerId.value &&
      !proj.members.some((m) => m.id === editProjectDefaultPayerId.value)
    ) {
      editProjectDefaultPayerId.value =
        proj.defaultPayerId || proj.members[0]?.id || ''
    }
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

/** 確保下拉選單一律包含專案目前主幣別（即使為非常用共享幣別也不空白） */
const currencyOptions = computed<string[]>(() => {
  const list = [...store.availableCurrencies]
  const currentBase = props.project.baseCurrency.trim().toUpperCase()
  if (currentBase && !list.includes(currentBase)) {
    list.unshift(currentBase)
  }
  return list
})

/** 偵測是否正從「公費優先墊付」切換為指定真人成員 */
const switchingFromPoolPayer = computed<ProjectMember | null>(() => {
  const currentDefault = props.project.members.find(
    (m) => m.id === props.project.defaultPayerId,
  )
  if (!currentDefault?.isPool) return null
  const nextSelected = props.project.members.find(
    (m) => m.id === editProjectDefaultPayerId.value,
  )
  if (!nextSelected || nextSelected.isPool) return null
  return nextSelected
})

async function handleSaveProjectSettings() {
  if (!editProjectName.value.trim()) {
    emit('toast', t('validation.projectNameRequired'))
    return
  }

  const switchedToMember = switchingFromPoolPayer.value
  const currencyChanged =
    editProjectCurrency.value.trim().toUpperCase() !==
    props.project.baseCurrency.trim().toUpperCase()
  const existingTxCount = store.getProjectTransactionCount(props.project.id)

  if (currencyChanged && existingTxCount > 0) {
    if (
      store.getLiveExchangeRate(
        props.project.baseCurrency,
        editProjectCurrency.value,
      ) === null
    ) {
      await store.refreshExchangeRates(false)
    }
    const rate = store.getEffectiveExchangeRate(
      props.project.baseCurrency,
      editProjectCurrency.value,
    )
    const confirmed = await askConfirm({
      title: t('project.currencyLabel'),
      message:
        rate !== null
          ? t('project.changeCurrencyConfirm', {
              from: props.project.baseCurrency,
              to: editProjectCurrency.value,
              count: existingTxCount,
              rate,
            })
          : t('project.changeCurrencyNoRateConfirm', {
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
    const saved = await store.updateProject(props.project.id, {
      name: editProjectName.value,
      baseCurrency: editProjectCurrency.value,
      defaultSplitMode: editProjectDefaultSplitMode.value,
      defaultPayerId: editProjectDefaultPayerId.value,
      cardColor: editProjectCardColor.value ?? null,
      cardCoverImage: editProjectCardCoverImage.value ?? null,
    })
    if (saved) {
      hydrateSettingsFromProject(saved)
    }
    emit(
      'toast',
      switchedToMember
        ? t('pool.switchedFromPoolToast', { name: switchedToMember.name })
        : t('project.projectUpdatedToast'),
    )
  } catch {
    emit('toast', t('home.saveFailed'))
  }
}

async function handleAddMember() {
  const name = newMemberName.value.trim()
  if (!name) return
  if (store.hasDuplicateMemberName(props.project.id, name)) {
    emit('toast', t('validation.duplicateMemberName', { name }))
    return
  }
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
  if (store.hasDuplicateMemberName(props.project.id, trimmed, editingMemberId.value)) {
    emit('toast', t('validation.duplicateMemberName', { name: trimmed }))
    return
  }
  const updated = await store.updateProjectMember(props.project.id, editingMemberId.value, {
    name: trimmed,
    avatarColor: editingMemberColor.value,
    avatarImage: editingMemberAvatarImage.value ?? null,
    paymentInfo: editingMemberPaymentInfo.value.trim() || null,
  })
  if (!updated) {
    emit('toast', t('home.saveFailed'))
    return
  }
  editingMemberId.value = null
  emit('toast', t('project.memberUpdatedToast'))
}

async function handleRemoveMember(member: ProjectMember) {
  const confirmed = await askConfirm({
    title: t('home.deleteTx'),
    message: `${t('home.deleteTx')}「${member.name}」？`,
    confirmText: t('home.deleteTx'),
    tone: 'danger',
  })
  if (!confirmed) return
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

const projectVisibleTransactions = computed(() =>
  store.visibleTransactions.filter((tx) => tx.projectId === props.project.id),
)

const isDeletingAllTx = ref(false)

async function handleDeleteAllTransactions() {
  const txs = projectVisibleTransactions.value
  if (txs.length === 0 || isDeletingAllTx.value) return
  const confirmed = await askConfirm({
    title: t('project.deleteAllTxTitle'),
    message: t('project.deleteAllTxConfirm', {
      name: props.project.name,
      count: txs.length,
    }),
    confirmText: t('project.deleteAllTxButton'),
    tone: 'danger',
  })
  if (!confirmed) return
  isDeletingAllTx.value = true
  try {
    const deletedIds = await store.softDeleteTransactionsBatch(
      txs.map((tx) => tx.id),
    )
    if (deletedIds.length > 0) {
      emit(
        'toast',
        t('project.deleteAllTxSuccessToast', { count: deletedIds.length }),
      )
    }
  } finally {
    isDeletingAllTx.value = false
  }
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
      class="rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E] lg:col-span-5"
    >
      <h3 class="mb-3 text-xs font-bold text-slate-700 dark:text-slate-200">
        {{ t('project.membersManageTitle') }}
      </h3>

      <ul class="divide-y divide-slate-100 dark:divide-white/10">
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
              <span
                v-if="member.isPool"
                class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-700 text-white"
              >
                <Wallet class="h-4 w-4" />
              </span>
              <MemberAvatar
                v-else
                :name="member.name"
                :color="member.avatarColor"
                :image="member.avatarImage"
                size="md"
              />
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {{ member.name }}
                  </span>
                  <span
                    v-if="member.isPool"
                    class="shrink-0 rounded-full bg-teal-100 px-1.5 py-0.5 text-[9px] font-bold text-teal-800 dark:bg-teal-950/70 dark:text-teal-300"
                  >
                    {{ t('pool.badgeLabel') }}
                  </span>
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
      class="rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]"
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
            maxlength="100"
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
                v-for="code in currencyOptions"
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

        <p class="text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
          {{ t('project.baseCurrencyHint') }}
        </p>

        <div
          v-if="switchingFromPoolPayer"
          role="status"
          class="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <Info class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            {{ t('pool.switchedFromPoolNotice', { name: switchingFromPoolPayer.name }) }}
          </span>
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
      class="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]"
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

    <!-- 刪除全部明細（保留專案與成員設定，明細移至回收桶可復原） -->
    <section
      class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200/70 bg-white p-4 shadow-sm dark:border-rose-900/40 dark:bg-[#1C1C1E]"
    >
      <div class="min-w-0 flex-1">
        <h3 class="text-xs font-bold text-rose-600 dark:text-rose-400">
          {{ t('project.deleteAllTxTitle') }}
        </h3>
        <p class="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          {{
            projectVisibleTransactions.length > 0
              ? t('project.deleteAllTxDesc', {
                  count: projectVisibleTransactions.length,
                })
              : t('project.deleteAllTxEmptyDesc')
          }}
        </p>
      </div>
      <button
        type="button"
        :disabled="projectVisibleTransactions.length === 0 || isDeletingAllTx"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-600 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-rose-800/70 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70"
        @click="handleDeleteAllTransactions"
      >
        <Trash2 class="h-4 w-4" />
        <span>{{ t('project.deleteAllTxButton') }}</span>
      </button>
    </section>
    </div>
  </div>
</template>
