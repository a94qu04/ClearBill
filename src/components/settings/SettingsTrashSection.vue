<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Archive, ArchiveRestore, Trash2, Undo2 } from 'lucide-vue-next'
import MemberAvatar from '@/components/MemberAvatar.vue'
import { askConfirm } from '@/composables/useConfirm'
import { formatCurrencyAmount } from '@/core/currency'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'

const emit = defineEmits<{
  (e: 'toast', message: string): void
  (e: 'restored', projectId?: string): void
  (e: 'selectProject', projectId: string): void
  (e: 'close'): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const totalTrashCount = computed(
  () => store.deletedProjects.length + store.deletedTransactions.length,
)

function resolveCategoryDisplayName(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

function getCategoryLabelByKey(key: string): string {
  const found = store.categories.find((c) => c.key === key)
  if (found) return resolveCategoryDisplayName(found)
  const translated = t(`categories.${key}`)
  return translated === `categories.${key}` ? key : translated
}

function getHumanMembers(proj: {
  members: Array<{
    id: string
    name: string
    avatarColor?: string
    avatarImage?: string
    isPool?: boolean
  }>
}) {
  const humans = proj.members.filter((m) => !m.isPool)
  return humans.length > 0 ? humans : proj.members
}

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}

// 已封存專案管理
async function handleUnarchiveProject(projectId: string) {
  const updated = await store.toggleArchiveProject(projectId)
  if (updated) {
    emit('toast', t('project.unarchivedToast', { name: updated.name }))
  }
}

function handleOpenArchivedProject(projectId: string) {
  emit('selectProject', projectId)
  emit('close')
}

// 回收桶復原與一鍵清空
async function handleRestoreProject(projectId: string) {
  const res = await store.restoreProject(projectId)
  if (res.ok) {
    emit(
      'toast',
      t('trash.projectRestoredToast', {
        name: res.projectName ?? '',
        count: res.restoredTxCount,
      }),
    )
    emit('restored', projectId)
    emit('close')
  }
}

async function handlePermanentDeleteProject(projectId: string, name: string) {
  const confirmed = await askConfirm({
    title: t('trash.deleteForever'),
    message: t('trash.permanentDeleteProjectConfirm', { name }),
    confirmText: t('trash.deleteForever'),
    tone: 'danger',
  })
  if (!confirmed) return
  await store.permanentlyDeleteProject(projectId)
  emit('toast', t('trash.permanentlyDeletedToast'))
}

async function handleRestoreTx(id: string) {
  const res = await store.restoreTransaction(id)
  if (res.ok) {
    emit('toast', t('trash.restoredToast'))
    emit('restored', res.projectId)
  }
}

async function handlePermanentDeleteTx(id: string) {
  const confirmed = await askConfirm({
    title: t('trash.deleteForever'),
    message: t('trash.emptyAllConfirm', { count: 1 }),
    confirmText: t('trash.deleteForever'),
    tone: 'danger',
  })
  if (!confirmed) return
  await store.permanentlyDeleteTransaction(id)
  emit('toast', t('trash.permanentlyDeletedToast'))
}

async function handleEmptyTrash() {
  const count = totalTrashCount.value
  if (count === 0) return
  const confirmed = await askConfirm({
    title: t('trash.emptyAll'),
    message: t('trash.emptyAllConfirm', { count }),
    confirmText: t('trash.emptyAll'),
    tone: 'danger',
  })
  if (!confirmed) return
  const removed = await store.emptyTrash()
  if (removed > 0) {
    emit('toast', t('trash.emptiedToast', { count: removed }))
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- 已封存專案（點擊可檢視或一鍵取消封存還原） -->
    <section
      class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50"
    >
      <div
        class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100"
      >
        <Archive class="h-4 w-4 text-amber-500" />
        <span>{{
          t('project.archivedSectionTitle', {
            count: store.archivedProjects.length,
          })
        }}</span>
      </div>

      <p
        v-if="store.archivedProjects.length === 0"
        class="py-3 text-center text-xs text-slate-400 dark:text-slate-500"
      >
        {{ t('project.archivedEmpty') }}
      </p>

      <ul v-else class="divide-y divide-slate-200/70 dark:divide-slate-800">
        <li
          v-for="proj in store.archivedProjects"
          :key="proj.id"
          class="flex items-center justify-between gap-2 py-2.5"
        >
          <button
            type="button"
            class="min-w-0 flex-1 text-left transition hover:opacity-80"
            @click="handleOpenArchivedProject(proj.id)"
          >
            <div
              class="truncate text-xs font-bold text-slate-800 dark:text-slate-100"
            >
              {{ proj.name }}
            </div>
            <div
              class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400"
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
              </span>
              <span>{{
                t('project.memberCount', {
                  count: getHumanMembers(proj).length,
                })
              }}</span>
              <span>·</span>
              <span
                class="font-bold tabular-nums text-slate-600 dark:text-slate-300"
              >
                {{ fmt(store.getProjectTotalExpense(proj.id), proj.baseCurrency) }}
              </span>
            </div>
          </button>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300"
            @click="handleUnarchiveProject(proj.id)"
          >
            <ArchiveRestore class="h-3.5 w-3.5" />
            <span>{{ t('project.unarchiveButton') }}</span>
          </button>
        </li>
      </ul>
    </section>

    <!-- 最近刪除（回收桶：支援已刪除專案整批復原與個別帳目復原） -->
    <section
      class="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50"
    >
      <div class="flex items-center justify-between gap-2">
        <div
          class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100"
        >
          <Trash2 class="h-4 w-4 text-rose-500" />
          <span>{{ t('trash.title') }}</span>
          <span
            v-if="totalTrashCount > 0"
            class="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950/70 dark:text-rose-300"
          >
            {{ totalTrashCount }}
          </span>
        </div>
        <button
          v-if="totalTrashCount > 0"
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1 text-[11px] font-bold text-rose-600 transition hover:bg-rose-100 dark:bg-rose-950/60 dark:text-rose-300"
          @click="handleEmptyTrash"
        >
          <Trash2 class="h-3 w-3" />
          <span>{{ t('trash.emptyAll') }}</span>
        </button>
      </div>

      <p
        v-if="totalTrashCount === 0"
        class="py-4 text-center text-xs text-slate-400 dark:text-slate-500"
      >
        {{ t('trash.empty') }}
      </p>

      <div v-else class="space-y-3">
        <!-- 已刪除專案（可一鍵連同底下帳目完整救回） -->
        <div v-if="store.deletedProjects.length > 0" class="space-y-1.5">
          <div class="text-[11px] font-bold text-slate-500 dark:text-slate-400">
            {{ t('trash.deletedProjectsLabel') }} ({{
              store.deletedProjects.length
            }})
          </div>
          <ul
            class="divide-y divide-slate-200/70 rounded-xl border border-slate-200/80 bg-white px-3 dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
          >
            <li
              v-for="proj in store.deletedProjects"
              :key="proj.id"
              class="flex items-center justify-between gap-2 py-2.5"
            >
              <div class="min-w-0">
                <div
                  class="truncate text-xs font-bold text-slate-800 dark:text-slate-100"
                >
                  {{ proj.name }}
                </div>
                <div class="text-[11px] text-slate-400">
                  {{
                    t('project.memberCount', {
                      count: getHumanMembers(proj).length,
                    })
                  }}
                  · {{ proj.baseCurrency }}
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300"
                  @click="handleRestoreProject(proj.id)"
                >
                  <Undo2 class="h-3.5 w-3.5" />
                  <span>{{ t('trash.restore') }}</span>
                </button>
                <button
                  type="button"
                  :title="t('trash.deleteForever')"
                  class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
                  @click="handlePermanentDeleteProject(proj.id, proj.name)"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          </ul>
        </div>

        <!-- 已刪除帳目 -->
        <ul
          v-if="store.deletedTransactions.length > 0"
          class="divide-y divide-slate-200/70 dark:divide-slate-800"
        >
          <li
            v-for="tx in store.deletedTransactions"
            :key="tx.id"
            class="flex items-center justify-between gap-2 py-2.5"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5">
                <span
                  class="truncate text-xs font-semibold text-slate-800 dark:text-slate-100"
                >
                  {{ tx.note || getCategoryLabelByKey(tx.categoryKey) }}
                </span>
                <span
                  v-if="store.getAnyProjectById(tx.projectId)"
                  class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300"
                >
                  {{ store.getAnyProjectById(tx.projectId)?.name }}
                </span>
              </div>
              <div class="text-[11px] text-slate-400">
                {{ fmt(tx.amount, tx.currency) }} · {{ tx.date }}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300"
                @click="handleRestoreTx(tx.id)"
              >
                <Undo2 class="h-3.5 w-3.5" />
                <span>{{ t('trash.restore') }}</span>
              </button>
              <button
                type="button"
                :title="t('trash.deleteForever')"
                class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
                @click="handlePermanentDeleteTx(tx.id)"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
