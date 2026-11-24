<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  ArchiveRestore,
  FileJson,
  FileSpreadsheet,
  ImageDown,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  X,
} from 'lucide-vue-next'
import {
  AVATAR_PALETTE,
  useLedgerStore,
  type ManagedCategory,
} from '@/stores/ledgerStore'
import { calculateSettleUp } from '@/core/settleUpEngine'
import { buildProjectExcelBytes } from '@/core/excelExporter'
import { generateProjectReportPngBlob } from '@/core/reportImageGenerator'
import {
  getTodayIso,
  sanitizeExportFilename,
  triggerBinaryFileDownload,
  triggerTextFileDownload,
} from '@/core/ledgerHelpers'
import type { Project, ProjectMember, SplitMode } from '@/schemas/ledgerSchema'

interface Props {
  project: Project
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'createProject'): void
  (e: 'projectDeleted'): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()
const isGeneratingImage = ref(false)

const editProjectName = ref(props.project.name)
const editProjectCurrency = ref(props.project.baseCurrency)
const editProjectDefaultSplitMode = ref<SplitMode>(props.project.defaultSplitMode)
const editProjectDefaultPayerId = ref(
  props.project.defaultPayerId || props.project.members[0]?.id || '',
)

const newMemberName = ref('')
const editingMemberId = ref<string | null>(null)
const editingMemberName = ref('')
const editingMemberColor = ref<string>(AVATAR_PALETTE[0])

watch(
  () => props.project,
  (proj) => {
    editProjectName.value = proj.name
    editProjectCurrency.value = proj.baseCurrency
    editProjectDefaultSplitMode.value = proj.defaultSplitMode
    editProjectDefaultPayerId.value =
      proj.defaultPayerId || proj.members[0]?.id || ''
  },
  { deep: true },
)

async function handleSaveProjectSettings() {
  if (!editProjectName.value.trim()) return

  const currencyChanged =
    editProjectCurrency.value.trim().toUpperCase() !==
    props.project.baseCurrency.trim().toUpperCase()
  const existingTxCount = store.getProjectTransactionCount(props.project.id)

  if (
    currencyChanged &&
    existingTxCount > 0 &&
    typeof window !== 'undefined' &&
    !window.confirm(
      t('project.changeCurrencyConfirm', {
        from: props.project.baseCurrency,
        to: editProjectCurrency.value,
        count: existingTxCount,
      }),
    )
  ) {
    editProjectCurrency.value = props.project.baseCurrency
    return
  }

  try {
    await store.updateProject(props.project.id, {
      name: editProjectName.value,
      baseCurrency: editProjectCurrency.value,
      defaultSplitMode: editProjectDefaultSplitMode.value,
      defaultPayerId: editProjectDefaultPayerId.value,
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
}

async function handleSaveMemberEdit() {
  if (!editingMemberId.value) return
  const trimmed = editingMemberName.value.trim()
  if (!trimmed) return
  await store.updateProjectMember(props.project.id, editingMemberId.value, {
    name: trimmed,
    avatarColor: editingMemberColor.value,
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
  if (
    typeof window !== 'undefined' &&
    !window.confirm(
      t('project.deleteProjectConfirm', { name: props.project.name }),
    )
  ) {
    return
  }
  await store.softDeleteProject(props.project.id)
  emit('toast', t('project.projectDeletedToast'))
  emit('projectDeleted')
}

function resolveCategoryLabel(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

function getCategoryLabel(key: string): string {
  const found = store.categories.find((c) => c.key === key)
  if (found) return resolveCategoryLabel(found)
  const translated = t(`categories.${key}`)
  return translated === `categories.${key}` ? key : translated
}

function getCategoryColor(key: string): string {
  return store.categories.find((c) => c.key === key)?.color ?? '#64748b'
}

function handleExportProjectExcel() {
  const projectTxs = store.visibleTransactions.filter(
    (tx) => tx.projectId === props.project.id,
  )
  const settleUp = calculateSettleUp(
    projectTxs,
    props.project.baseCurrency,
    props.project.members.map((m) => m.id),
  )
  const bytes = buildProjectExcelBytes(props.project, projectTxs, settleUp, {
    sheets: {
      entries: t('export.excelSheetEntries'),
      summary: t('export.excelSheetSummary'),
    },
    headers: {
      date: t('export.csvDate'),
      time: t('export.csvTime'),
      type: t('export.csvType'),
      category: t('export.csvCategory'),
      note: t('export.csvNote'),
      originalAmount: t('export.csvOriginalAmount'),
      currency: t('export.csvCurrency'),
      exchangeRate: t('export.csvExchangeRate'),
      baseAmount: t('export.csvBaseAmount'),
      baseCurrency: t('export.csvBaseCurrency'),
      payers: t('export.csvPayers'),
      shares: t('export.csvShares'),
    },
    summaryHeaders: {
      member: t('export.excelMember'),
      totalExpense: t('settle.memberTotalExpense'),
      totalPaid: t('settle.memberTotalPaid'),
      netAmount: t('export.excelNetAmount'),
      transferFrom: t('settle.fromLabel'),
      transferTo: t('settle.toLabel'),
      transferAmount: t('daily.amountLabel'),
      projectTotal: t('settle.projectTotalSpend'),
      transfersTitle: t('settle.suggestionsTitle'),
    },
    typeNames: {
      expense: t('project.typeExpense'),
      refund: t('project.typeRefund'),
      transfer: t('home.settlementBadge'),
      income: t('daily.typeIncome'),
      card_repayment: 'card_repayment',
    },
    resolveCategoryLabel: getCategoryLabel,
  })
  const safeName = sanitizeExportFilename(props.project.name)
  triggerBinaryFileDownload(
    bytes,
    `clearbill-${safeName}-${getTodayIso()}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  emit('toast', t('export.excelExportedToast'))
}

async function handleExportProjectLongImage() {
  if (isGeneratingImage.value) return
  isGeneratingImage.value = true
  try {
    const projectTxs = store.visibleTransactions.filter(
      (tx) => tx.projectId === props.project.id,
    )
    const expenses = projectTxs.filter((tx) => tx.type !== 'transfer')
    const settleUp = calculateSettleUp(
      projectTxs,
      props.project.baseCurrency,
      props.project.members.map((m) => m.id),
    )
    const blob = await generateProjectReportPngBlob(
      props.project,
      settleUp,
      expenses,
      {
        brandTitle: t('app.name'),
        totalSpendLabel: t('settle.projectTotalSpend'),
        memberCountLabel: t('project.memberCount', {
          count: props.project.members.length,
        }),
        categorySectionTitle: t('stats.title'),
        memberSectionTitle: t('settle.balancesTitle'),
        spentLabel: t('settle.memberTotalExpense'),
        paidLabel: t('settle.memberTotalPaid'),
        shouldReceive: t('settle.shouldReceive'),
        shouldPay: t('settle.shouldPay'),
        settled: t('settle.settled'),
        transfersSectionTitle: t('settle.suggestionsTitle'),
        allSettledText: t('settle.allSettled'),
        entriesSectionTitle: t('share.detailsTitle'),
        refundBadge: t('project.refundBadge'),
        footerTagline: t('share.footerTagline'),
        resolveCategoryLabel: getCategoryLabel,
        resolveCategoryColor: getCategoryColor,
      },
      locale.value,
    )
    const safeName = sanitizeExportFilename(props.project.name)
    triggerBinaryFileDownload(
      blob,
      `clearbill-${safeName}-${getTodayIso()}.png`,
      'image/png',
    )
    emit('toast', t('export.longImageExportedToast'))
  } catch {
    emit('toast', t('export.longImageFailedToast'))
  } finally {
    isGeneratingImage.value = false
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
  <div class="space-y-4">
    <!-- 成員管理 -->
    <section
      class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
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
            class="space-y-2 rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/70"
          >
            <div class="flex gap-2">
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
          </div>

          <div v-else class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5">
              <span
                class="inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold text-white"
                :style="{ backgroundColor: member.avatarColor || '#0f172a' }"
              >
                {{ member.name.slice(0, 1).toUpperCase() }}
              </span>
              <span class="text-sm font-medium text-slate-800 dark:text-slate-100">
                {{ member.name }}
              </span>
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
          </select>
        </div>

        <button
          type="submit"
          class="w-full rounded-xl bg-slate-900 py-2.5 text-xs font-bold text-white dark:bg-emerald-500 dark:text-slate-950"
        >
          {{ t('project.saveProjectSettings') }}
        </button>
      </form>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
          @click="emit('createProject')"
        >
          <Plus class="h-3.5 w-3.5" />
          <span>{{ t('project.newProject') }}</span>
        </button>

        <div class="flex items-center gap-3">
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
      </div>
    </section>

    <!-- 單一專案報表匯出：Excel (.xlsx) 與高解析長截圖報表 (PNG) -->
    <section
      class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <h3 class="text-xs font-bold text-slate-700 dark:text-slate-200">
        {{ t('export.sectionTitle') }}
      </h3>
      <p class="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        {{ t('export.sectionDescExcelImage') }}
      </p>
      <div class="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          @click="handleExportProjectExcel"
        >
          <FileSpreadsheet class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span>{{ t('export.excelButton') }}</span>
        </button>
        <button
          type="button"
          :disabled="isGeneratingImage"
          class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          @click="handleExportProjectLongImage"
        >
          <Loader2 v-if="isGeneratingImage" class="h-4 w-4 animate-spin text-sky-600" />
          <ImageDown v-else class="h-4 w-4 text-sky-600 dark:text-sky-400" />
          <span>{{ t('export.longImageButton') }}</span>
        </button>
      </div>
      <div class="mt-2.5 text-right">
        <button
          type="button"
          class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400 transition hover:text-sky-600 dark:text-slate-500 dark:hover:text-sky-400"
          @click="handleExportProjectJson"
        >
          <FileJson class="h-3.5 w-3.5" />
          <span>{{ t('export.projectJsonButton') }}</span>
        </button>
      </div>
    </section>
  </div>
</template>
