<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  Check,
  CloudOff,
  Plus,
  Users,
  Wallet,
} from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import MemberAvatar from '@/components/MemberAvatar.vue'
import MoneyText from '@/components/MoneyText.vue'
import ProjectSettleTab from '@/components/ProjectSettleTab.vue'
import ProjectSettingsTab from '@/components/ProjectSettingsTab.vue'
import TransactionListSection from '@/components/TransactionListSection.vue'
import {
  getHumanMembers,
  getProjectCardStyle,
} from '@/views/projectCardHelpers'

export type ProjectTab = 'expenses' | 'settle' | 'settings'

const props = defineProps<{
  project: Project
  activeTab: ProjectTab
}>()

const emit = defineEmits<{
  'update:activeTab': [tab: ProjectTab]
  openShare: []
  openPoolCollect: []
  openAddExpense: []
  recordPayment: [
    payload: {
      fromMemberId: string
      toMemberId: string
      amount: number
      currency?: string
    },
  ]
  editTx: [tx: Transaction]
  duplicateTx: [tx: Transaction]
  deleteTx: [id: string]
  deleteTxBatch: [ids: string[]]
  previewPhotos: [payload: { photos: string[]; index: number }]
  projectDeleted: []
  toast: [message: string]
}>()

const { t } = useI18n()
const store = useLedgerStore()

const projectTxListRef = ref<InstanceType<typeof TransactionListSection> | null>(null)

const activeProjectTotalSpent = computed(() =>
  store.getProjectTotalExpense(props.project.id),
)

const activeProjectMyMemberId = computed<string | undefined>(() => {
  return props.project.syncMeta?.myMemberId || props.project.defaultPayerId || undefined
})

/** 當前即時共享專案中本裝置認領的成員（成員若遭遠端移除時安全回傳 null） */
const activeProjectMyMember = computed(() => {
  if (props.project.syncMeta?.mode !== 'firestore') return null
  const myMemberId = props.project.syncMeta.myMemberId
  if (!myMemberId) return null
  return props.project.members.find((m) => m.id === myMemberId) ?? null
})

/** 當前專案公費袋餘額摘要（常駐顯示於專案頂部主卡，即使尚未收公費或餘額為 0 元亦明確顯示） */
const activeProjectPoolSummary = computed<{
  poolMemberId: string
  netAmount: number
  currency: string
  preferPoolPayer: boolean
}>(() => {
  const proj = props.project
  const baseSettle = store.activeProjectBaseSettleUp
  const poolMember = proj.members.find((m) => m.isPool)
  const poolBal = baseSettle?.balances.find(
    (b) => (poolMember && b.memberId === poolMember.id) || b.memberId.startsWith('pool_'),
  )
  const resolvedId = poolMember?.id || poolBal?.memberId || ''
  return {
    poolMemberId: resolvedId,
    netAmount: poolBal?.netAmount ?? 0,
    currency: proj.baseCurrency,
    preferPoolPayer: Boolean(resolvedId && proj.defaultPayerId === resolvedId),
  }
})

async function handleTogglePreferPoolPayer() {
  const res = await store.togglePreferPoolPayer(
    props.project.id,
    t('pool.defaultName'),
  )
  if (!res) return
  emit(
    'toast',
    res.enabled
      ? t('pool.preferPayEnabledToast')
      : t('pool.preferPayDisabledToast'),
  )
}

function handleInspectMemberInExpenses(memberId: string) {
  emit('update:activeTab', 'expenses')
  void nextTick(() => {
    projectTxListRef.value?.setMemberFilter(memberId)
  })
}

function resetFilters() {
  projectTxListRef.value?.resetFilters()
}

defineExpose({
  resetFilters,
})
</script>

<template>
  <!-- 分帳專案工作區 -->
  <div class="space-y-4">
    <section
      class="relative space-y-3 overflow-hidden rounded-3xl bg-slate-900 px-5 py-4 text-white shadow-sm dark:bg-[#1C1C1E]"
      :style="getProjectCardStyle(project)"
    >
      <div
        v-if="project.cardCoverImage"
        class="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/55 to-slate-950/45"
      />
      <div class="relative z-10 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2 text-xs font-medium text-emerald-400">
            <button
              type="button"
              :title="getHumanMembers(project).map((m) => m.name).join('、')"
              class="inline-flex items-center gap-1.5 rounded-full transition hover:opacity-90"
              @click="emit('update:activeTab', 'settings')"
            >
              <span class="inline-flex items-center -space-x-1">
                <MemberAvatar
                  v-for="m in getHumanMembers(project).slice(0, 6)"
                  :key="m.id"
                  :name="m.name"
                  :color="m.avatarColor"
                  :image="m.avatarImage"
                  size="xs"
                  ring
                />
                <span
                  v-if="getHumanMembers(project).length > 6"
                  class="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-slate-700 px-1 text-[9px] font-bold text-slate-100 ring-1 ring-slate-900"
                >
                  +{{ getHumanMembers(project).length - 6 }}
                </span>
              </span>
              <span>
                {{ t('project.memberCount', { count: getHumanMembers(project).length }) }}
                · {{ t('project.baseCurrencyBadge', { currency: project.baseCurrency }) }}
              </span>
            </button>
            <span
              v-if="project.isArchived"
              class="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300"
            >
              <Archive class="h-3 w-3" />
              <span>{{ t('project.archivedBadge') }}</span>
            </span>
          </div>
          <div class="mt-0.5 truncate text-lg font-bold">{{ project.name }}</div>
        </div>
        <div class="shrink-0 text-right">
          <div class="text-[11px] text-slate-300">{{ t('project.totalSpent') }}</div>
          <div class="text-xl font-extrabold tabular-nums text-emerald-400">
            <MoneyText
              :amount="activeProjectTotalSpent"
              :currency="project.baseCurrency"
            />
          </div>
        </div>
      </div>

      <!-- 多人即時協作共享狀態（靠左）＋ 公費餘額／優先支出合併膠囊（靠右） -->
      <div class="relative z-10 flex flex-wrap items-center justify-between gap-2 border-t border-white/15 pt-2.5">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition"
            :class="
              project.syncMeta?.mode === 'firestore'
                ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                : 'bg-white/10 text-slate-200 hover:bg-white/20'
            "
            @click="emit('openShare')"
          >
            <template v-if="project.syncMeta?.mode === 'firestore'">
              <CloudOff
                v-if="store.syncStatusByProject[project.id] === 'offline'"
                class="h-3.5 w-3.5 text-amber-300"
              />
              <span
                v-else
                class="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]"
              />
              <span>
                {{
                  (store.outboxCountByProject[project.id] ?? 0) > 0
                    ? t('realtime.entryOfflineBadge', {
                        count: store.outboxCountByProject[project.id],
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
            v-if="activeProjectMyMember"
            class="inline-flex max-w-[120px] items-center gap-1.5 truncate text-[11px] text-slate-300"
          >
            <MemberAvatar
              :name="activeProjectMyMember.name"
              :color="activeProjectMyMember.avatarColor"
              :image="activeProjectMyMember.avatarImage"
              size="xxs"
            />
            <span class="truncate">
              {{ activeProjectMyMember.name }}
            </span>
          </span>
        </div>

        <!-- 公費餘額 ＋ 優先支出單一合併膠囊（0 元一樣顯示，整體靠右對齊） -->
        <div
          class="ml-auto inline-flex items-center gap-1 rounded-full p-0.5 text-[11px] font-bold transition"
          :class="
            activeProjectPoolSummary.netAmount > 0
              ? 'bg-rose-500/20 ring-1 ring-rose-400/40'
              : activeProjectPoolSummary.netAmount < 0
                ? 'bg-teal-500/20 ring-1 ring-teal-400/35'
                : 'bg-white/10 ring-1 ring-white/20'
          "
        >
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-full py-1 pl-2.5 pr-1.5 transition hover:bg-white/10"
            :class="
              activeProjectPoolSummary.netAmount > 0
                ? 'text-rose-200'
                : 'text-teal-200'
            "
            @click="emit('openPoolCollect')"
          >
            <Wallet class="h-3.5 w-3.5 shrink-0" />
            <span>{{ t('pool.balanceShort') }}</span>
            <span class="tabular-nums">
              <MoneyText
                :amount="Math.abs(activeProjectPoolSummary.netAmount)"
                :currency="activeProjectPoolSummary.currency"
                :prefix="activeProjectPoolSummary.netAmount > 0 ? '-' : ''"
              />
            </span>
          </button>

          <button
            type="button"
            :aria-pressed="activeProjectPoolSummary.preferPoolPayer"
            class="inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold transition active:scale-95"
            :class="
              activeProjectPoolSummary.preferPoolPayer
                ? 'bg-teal-800 text-white shadow-inner ring-1 ring-teal-300/60 hover:bg-teal-700'
                : 'bg-slate-100 text-slate-700 shadow-sm hover:bg-white'
            "
            @click="handleTogglePreferPoolPayer"
          >
            <Check
              v-if="activeProjectPoolSummary.preferPoolPayer"
              class="h-3 w-3 shrink-0"
            />
            <span>
              {{
                activeProjectPoolSummary.preferPoolPayer
                  ? t('pool.preferPayActive')
                  : t('pool.preferPayInactive')
              }}
            </span>
          </button>
        </div>
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
          activeTab === tab
            ? 'bg-white text-slate-900 shadow-sm dark:bg-[#2C2C2E] dark:text-white'
            : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
        "
        @click="emit('update:activeTab', tab)"
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

    <!-- 分頁 A：專案明細（含消費、退款與統一收斂之繳公費帳目） -->
    <TransactionListSection
      v-if="activeTab === 'expenses'"
      ref="projectTxListRef"
      context="project"
      :transactions="store.activeProjectEntriesWithPool"
      :empty-text="t('project.noProjectTransactions')"
      :project-base-currency="project.baseCurrency"
      :project-members="project.members"
      :my-member-id="activeProjectMyMemberId"
      @edit="emit('editTx', $event)"
      @duplicate="emit('duplicateTx', $event)"
      @delete="emit('deleteTx', $event)"
      @preview-photos="emit('previewPhotos', $event)"
      @toast="emit('toast', $event)"
    />

    <!-- 分頁 B：結算、圓餅圖統計、結算匯率切換與一鍵分享 -->
    <ProjectSettleTab
      v-else-if="activeTab === 'settle' && store.activeProjectSettleUp"
      :project="project"
      :settle-up="store.activeProjectSettleUp"
      :base-settle-up="store.activeProjectBaseSettleUp"
      :expenses="store.activeProjectEffectiveExpenses"
      :raw-expenses="store.activeProjectExpenses"
      :settlements="store.activeProjectSettlements"
      :my-member-id="activeProjectMyMemberId"
      @record-payment="emit('recordPayment', $event)"
      @open-pool-collect="emit('openPoolCollect')"
      @edit-settlement="emit('editTx', $event)"
      @edit-expense="emit('editTx', $event)"
      @inspect-member="handleInspectMemberInExpenses"
      @delete-settlement="emit('deleteTx', $event)"
      @delete-settlements-batch="emit('deleteTxBatch', $event)"
      @toast="emit('toast', $event)"
    />

    <!-- 分頁 C：成員與專案設定 -->
    <ProjectSettingsTab
      v-else-if="activeTab === 'settings'"
      :project="project"
      @project-deleted="emit('projectDeleted')"
      @toast="emit('toast', $event)"
    />

    <!-- 浮動「+」按鈕（明細與結算分頁皆顯示） -->
    <div
      v-if="activeTab === 'expenses' || activeTab === 'settle'"
      class="safe-fab-bottom pointer-events-none fixed inset-x-0 z-40"
    >
      <div class="mx-auto flex max-w-xl justify-end px-4 md:max-w-3xl lg:max-w-5xl">
        <button
          type="button"
          :aria-label="t('project.fabAdd')"
          :title="t('project.fabAdd')"
          class="pointer-events-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-xl transition hover:scale-105 active:scale-95 dark:bg-emerald-500 dark:text-slate-950"
          @click="emit('openAddExpense')"
        >
          <Plus class="h-6 w-6" />
        </button>
      </div>
    </div>
  </div>
</template>
