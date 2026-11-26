<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil, Trash2 } from 'lucide-vue-next'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import {
  buildHubSettlementTransfers,
  type MemberNetBalance,
  type SettleUpResult,
} from '@/core/settleUpEngine'
import { computeMemberTxContribution } from '@/core/memberLedger'
import {
  findLatestPoolCollectBatch,
  isPoolMemberId,
  partitionPoolAndHumanBalances,
  type PoolCollectBatchSummary,
} from '@/core/poolFund'
import { formatCurrencyAmount } from '@/core/currency'
import { describePayers, getTxPayerIds } from '@/core/txPresentation'
import { useLedgerStore } from '@/stores/ledgerStore'
import { askConfirm } from '@/composables/useConfirm'
import {
  useSettleExports,
  type SettleMemberStatementEntry,
} from '@/composables/useSettleExports'
import CategoryPieChart from '@/components/CategoryPieChart.vue'
import SettleRatePanel from '@/components/settle/SettleRatePanel.vue'
import PoolSummaryCard from '@/components/settle/PoolSummaryCard.vue'
import TransferPlanCard from '@/components/settle/TransferPlanCard.vue'
import MemberBalanceList from '@/components/settle/MemberBalanceList.vue'
import MemberStatementPanel from '@/components/settle/MemberStatementPanel.vue'
import SettleShareSheet from '@/components/settle/SettleShareSheet.vue'

interface Props {
  project: Project
  settleUp: SettleUpResult
  baseSettleUp?: SettleUpResult | null
  expenses: Transaction[]
  rawExpenses?: Transaction[]
  settlements: Transaction[]
  myMemberId?: string
}

const props = withDefaults(defineProps<Props>(), {
  baseSettleUp: null,
  rawExpenses: undefined,
  myMemberId: undefined,
})

const emit = defineEmits<{
  (
    e: 'recordPayment',
    payload: {
      fromMemberId: string
      toMemberId: string
      amount: number
      currency: string
    },
  ): void
  (e: 'openPoolCollect'): void
  (e: 'editSettlement', tx: Transaction): void
  (e: 'editExpense', tx: Transaction): void
  (e: 'inspectMember', memberId: string): void
  (e: 'deleteSettlement', id: string): void
  (e: 'deleteSettlementsBatch', ids: string[]): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const includeDetailsInShare = ref(false)
const shareSheetOpen = ref(false)
const selectedMemberDetailId = ref<string | null>(null)
const memberSortMode = ref<'project' | 'net_desc'>('project')
const transferPlanMode = ref<'min_transfers' | 'hub'>('min_transfers')
const hubMemberId = ref<string>('')
const onlyMyTransfers = ref(false)

const sourceRawExpenses = computed<Transaction[]>(
  () => props.rawExpenses ?? props.expenses,
)

const settlementCurrency = computed<string>(() =>
  store.getProjectSettlementCurrency(props.project),
)

const isCrossCurrencySettlement = computed<boolean>(
  () =>
    settlementCurrency.value !== props.project.baseCurrency.trim().toUpperCase(),
)

/** 透過共用的 settlementRateResolver 一次解析結帳幣別、模式與互為倒數的雙向匯率 */
const resolvedSettlement = computed(() =>
  store.getProjectSettlementOptions(props.project, [
    ...props.expenses,
    ...props.settlements,
  ]),
)

const poolMembers = computed(() => props.project.members.filter((m) => m.isPool))
const partitionedBalances = computed(() =>
  partitionPoolAndHumanBalances(props.settleUp.balances, props.project.members),
)
const poolMemberIds = computed(() => partitionedBalances.value.poolMemberIds)
const poolBalances = computed(() => partitionedBalances.value.poolBalances)

/** 辨識最近一次「批次收公費」的轉帳（相容單筆合併多人公費帳目與舊版多筆同批帳目），方便打錯金額時一鍵撤銷 */
const latestPoolCollectBatch = computed<PoolCollectBatchSummary | null>(() =>
  findLatestPoolCollectBatch(props.settlements, poolMemberIds.value),
)

const baseBalanceMap = computed<Map<string, MemberNetBalance>>(() => {
  const map = new Map<string, MemberNetBalance>()
  if (!props.baseSettleUp) return map
  for (const b of props.baseSettleUp.balances) {
    map.set(b.memberId, b)
  }
  return map
})

function getBaseBalance(memberId: string): MemberNetBalance | null {
  return baseBalanceMap.value.get(memberId) ?? null
}

const poolBalanceRows = computed(() =>
  poolBalances.value.map((balance) => ({
    balance,
    baseBalance: getBaseBalance(balance.memberId),
  })),
)

const displayedMemberBalances = computed(() => {
  const list = partitionedBalances.value.humanBalances
  if (memberSortMode.value === 'net_desc') {
    return [...list].sort((a, b) => b.netAmount - a.netAmount)
  }
  return list
})

const displayedMemberBalanceRows = computed(() =>
  displayedMemberBalances.value.map((balance) => ({
    balance,
    baseBalance: getBaseBalance(balance.memberId),
  })),
)

const resolvedHubMemberId = computed<string>(() => {
  if (
    hubMemberId.value &&
    props.project.members.some((m) => m.id === hubMemberId.value)
  ) {
    return hubMemberId.value
  }
  // 預設優先選應收回金額最高之真人債權人（財務長），無真人時才回退公費袋
  const humanBalances = props.settleUp.balances.filter(
    (b) => !poolMemberIds.value.has(b.memberId),
  )
  const topHumanCreditor = [...humanBalances].sort(
    (a, b) => b.netAmount - a.netAmount,
  )[0]
  if (topHumanCreditor) {
    return topHumanCreditor.memberId
  }
  if (poolMembers.value.length > 0) {
    return poolMembers.value[0].id
  }
  const topCreditor = [...props.settleUp.balances].sort(
    (a, b) => b.netAmount - a.netAmount,
  )[0]
  return topCreditor?.memberId || props.project.members[0]?.id || ''
})

const effectiveTransfers = computed(() => {
  if (transferPlanMode.value === 'hub' && resolvedHubMemberId.value) {
    return buildHubSettlementTransfers(
      props.settleUp.balances,
      resolvedHubMemberId.value,
      settlementCurrency.value,
    )
  }
  return props.settleUp.transfers
})

const visibleTransfers = computed(() => {
  if (!onlyMyTransfers.value || !props.myMemberId) {
    return effectiveTransfers.value
  }
  return effectiveTransfers.value.filter(
    (tr) =>
      tr.fromMemberId === props.myMemberId || tr.toMemberId === props.myMemberId,
  )
})

const effectiveSettleUp = computed<SettleUpResult>(() => ({
  ...props.settleUp,
  transfers: effectiveTransfers.value,
}))

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}

function getMemberName(memberId: string): string {
  const found = props.project.members.find((m) => m.id === memberId)
  if (found) return found.name
  if (isPoolMemberId(memberId)) return t('pool.defaultName')
  return memberId
}

function getMemberColor(memberId: string): string {
  return (
    props.project.members.find((m) => m.id === memberId)?.avatarColor ??
    '#10b981'
  )
}

function getSettlementPayerIds(tx: Transaction): string[] {
  return getTxPayerIds(tx)
}

function getSettlementFromLabel(tx: Transaction): string {
  return describePayers(tx, getMemberName, { separator: '、' })
}

const {
  isGeneratingImage,
  getCategoryLabel,
  shareMemberStatement,
  shareSettlementText,
  exportExcel,
  exportLongImage,
} = useSettleExports({
  project: computed(() => props.project),
  effectiveSettleUp,
  expenses: computed(() => props.expenses),
  settlements: computed(() => props.settlements),
  getMemberName,
  onToast: (message) => emit('toast', message),
  onCloseShareSheet: () => {
    shareSheetOpen.value = false
  },
})

const selectedMemberStatement = computed<SettleMemberStatementEntry[]>(() => {
  const memberId = selectedMemberDetailId.value
  if (!memberId) return []
  const list: SettleMemberStatementEntry[] = []

  const rawById = new Map<string, Transaction>()
  for (const rtx of sourceRawExpenses.value) {
    rawById.set(rtx.id, rtx)
  }

  const sorted = [...props.expenses]
    .filter((tx) => !tx.isDeleted && (tx.type === 'expense' || tx.type === 'refund'))
    .sort((a, b) => {
      const d = b.date.localeCompare(a.date)
      if (d !== 0) return d
      return b.time.localeCompare(a.time)
    })

  for (const tx of sorted) {
    if (!tx.splitConfig) continue
    const rawTx = rawById.get(tx.id) ?? tx
    const settleContrib = computeMemberTxContribution(
      tx,
      memberId,
      settlementCurrency.value,
    )
    const baseContrib = computeMemberTxContribution(
      rawTx,
      memberId,
      props.project.baseCurrency,
    )

    if (
      settleContrib.shareUnits === 0 &&
      settleContrib.paidUnits === 0 &&
      baseContrib.shareUnits === 0 &&
      baseContrib.paidUnits === 0
    ) {
      continue
    }
    list.push({
      tx: rawTx,
      title: tx.note?.trim() || getCategoryLabel(tx.categoryKey),
      shareInSettle: settleContrib.share,
      paidInSettle: settleContrib.paid,
      shareInBase: baseContrib.share,
      paidInBase: baseContrib.paid,
      isRefund: tx.type === 'refund',
    })
  }
  return list
})

function toggleMemberDetail(memberId: string) {
  selectedMemberDetailId.value =
    selectedMemberDetailId.value === memberId ? null : memberId
}

async function handleRequestDeleteSettlement(tx: Transaction) {
  const fromName = getSettlementFromLabel(tx)
  const toName = getMemberName(tx.splitConfig?.shares[0]?.memberId ?? '')
  const confirmed = await askConfirm({
    title: t('settle.deletePaymentTitle'),
    message: t('settle.deletePaymentConfirm', {
      from: fromName,
      to: toName,
      amount: fmt(tx.amount, tx.currency),
    }),
    confirmText: t('home.deleteTx'),
    tone: 'danger',
  })
  if (!confirmed) return
  emit('deleteSettlement', tx.id)
}
</script>

<template>
  <div class="space-y-4">
    <!-- 頂部極簡總覽與操作列：總支出 ＋ 單一分享選單 ＋ 緊湊單行結帳幣別／按需展開匯率設定 -->
    <SettleRatePanel
      :project="project"
      :settle-up="settleUp"
      :base-settle-up="baseSettleUp"
      :expenses="expenses"
      :raw-expenses="sourceRawExpenses"
      :settlements="settlements"
      :settlement-currency="settlementCurrency"
      :is-cross-currency-settlement="isCrossCurrencySettlement"
      :base-to-settlement-rate="resolvedSettlement.baseToSettlement.rate"
      :base-to-settlement-rate-source="resolvedSettlement.baseToSettlement.source"
      @open-share-sheet="shareSheetOpen = true"
      @toast="emit('toast', $event)"
    />

    <!-- 雙欄響應式主區：公費袋優先顯眼呈現，接續待還款與還款紀錄 -->
    <div class="space-y-4 lg:grid lg:grid-cols-12 lg:items-start lg:gap-5 lg:space-y-0">
      <!-- 行動欄（手機置頂／桌機左欄 5 格）：公費袋（啟用時置頂） ＋ 待還款建議 ＋ 已記錄還款 -->
      <div class="space-y-4 lg:col-span-5">
        <!-- 1. 公費袋專屬卡片 -->
        <PoolSummaryCard
          :project="project"
          :pool-balance-rows="poolBalanceRows"
          :latest-pool-collect-batch="latestPoolCollectBatch"
          :settlement-currency="settlementCurrency"
          :is-cross-currency-settlement="isCrossCurrencySettlement"
          @open-pool-collect="emit('openPoolCollect')"
          @delete-settlements-batch="emit('deleteSettlementsBatch', $event)"
        />

        <!-- 2. 待還款結算（Action First） -->
        <TransferPlanCard
          v-model:transfer-plan-mode="transferPlanMode"
          v-model:only-my-transfers="onlyMyTransfers"
          :project="project"
          :effective-transfers="effectiveTransfers"
          :visible-transfers="visibleTransfers"
          :is-cross-currency-settlement="isCrossCurrencySettlement"
          :settlement-to-base-rate="resolvedSettlement.settlementToBase.rate"
          :my-member-id="myMemberId"
          :has-pool-balances="poolBalances.length > 0"
          :resolved-hub-member-id="resolvedHubMemberId"
          @update:hub-member-id="hubMemberId = $event"
          @open-pool-collect="emit('openPoolCollect')"
          @record-payment="emit('recordPayment', $event)"
          @toast="emit('toast', $event)"
        />

        <!-- 3. 已記錄之還款明細（Inset Grouped List，無斑馬紋） -->
        <section class="rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]">
          <h3 class="mb-2.5 text-sm font-bold text-slate-900 dark:text-white">
            {{ t('settle.historyTitle') }}
          </h3>

          <p
            v-if="settlements.length === 0"
            class="py-4 text-center text-xs text-slate-400 dark:text-slate-500"
          >
            {{ t('settle.noHistory') }}
          </p>

          <ul v-else class="divide-y divide-slate-100 dark:divide-white/10">
            <li
              v-for="tx in settlements"
              :key="tx.id"
              class="flex items-center justify-between gap-2 py-2.5 first:pt-1 last:pb-0"
            >
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                  <span class="inline-flex min-w-0 items-center gap-1.5">
                    <span class="inline-flex shrink-0 items-center -space-x-1">
                      <span
                        v-for="pid in getSettlementPayerIds(tx).slice(0, 4)"
                        :key="pid"
                        class="h-2 w-2 rounded-full ring-1 ring-white dark:ring-[#1C1C1E]"
                        :style="{
                          backgroundColor: getMemberColor(pid),
                        }"
                      />
                    </span>
                    <span class="truncate">{{ getSettlementFromLabel(tx) }}</span>
                  </span>
                  <span class="text-slate-400">→</span>
                  <span class="inline-flex shrink-0 items-center gap-1.5">
                    <span
                      class="h-2 w-2 rounded-full"
                      :style="{
                        backgroundColor: getMemberColor(
                          tx.splitConfig?.shares[0]?.memberId ?? '',
                        ),
                      }"
                    />
                    <span>{{
                      getMemberName(tx.splitConfig?.shares[0]?.memberId ?? '')
                    }}</span>
                  </span>
                </div>
                <div class="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                  {{ tx.date }}
                  <span v-if="tx.note"> · {{ tx.note }}</span>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <div class="mr-1 text-right tabular-nums">
                  <div class="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                    {{ fmt(tx.amount, tx.currency) }}
                  </div>
                  <div
                    v-if="
                      tx.currency.trim().toUpperCase() !==
                      project.baseCurrency.trim().toUpperCase()
                    "
                    class="text-[10px] font-medium text-slate-400 dark:text-slate-500"
                  >
                    ≈ {{ fmt(tx.amount * (tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1), project.baseCurrency) }}
                    · {{ tx.exchangeRateToBase }}
                  </div>
                </div>
                <button
                  type="button"
                  :aria-label="t('home.editTx')"
                  class="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-emerald-600 dark:hover:bg-white/10"
                  @click="emit('editSettlement', tx)"
                >
                  <Pencil class="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  :aria-label="t('home.deleteTx')"
                  class="rounded-full p-1.5 text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-500"
                  @click="handleRequestDeleteSettlement(tx)"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- 總覽欄（手機接續於下／桌機右欄 7 格）：各成員總支出與展開明細 ＋ 消費結構圓餅圖 -->
      <div class="space-y-4 lg:col-span-7">
        <MemberBalanceList
          v-model:member-sort-mode="memberSortMode"
          :project="project"
          :member-balance-rows="displayedMemberBalanceRows"
          :selected-member-detail-id="selectedMemberDetailId"
          :settlement-currency="settlementCurrency"
          :is-cross-currency-settlement="isCrossCurrencySettlement"
          :my-member-id="myMemberId"
          @toggle-member-detail="toggleMemberDetail"
        >
          <template #statement>
            <MemberStatementPanel
              v-if="selectedMemberDetailId"
              :project="project"
              :member-id="selectedMemberDetailId"
              :entries="selectedMemberStatement"
              :settlement-currency="settlementCurrency"
              :is-cross-currency-settlement="isCrossCurrencySettlement"
              @copy-statement="shareMemberStatement($event, selectedMemberStatement)"
              @inspect-member="emit('inspectMember', $event)"
              @edit-expense="emit('editExpense', $event)"
              @close="selectedMemberDetailId = null"
            />
          </template>
        </MemberBalanceList>

        <!-- 消費結構圓餅圖 -->
        <CategoryPieChart
          :transactions="expenses"
          :raw-transactions="sourceRawExpenses"
          :base-currency="settlementCurrency"
          :project-base-currency="project.baseCurrency"
        />
      </div>
    </div>

    <!-- Apple Action Sheet：統一整合文字分享、PNG 長截圖、Excel 匯出與明細開關 -->
    <SettleShareSheet
      v-model:include-details="includeDetailsInShare"
      :open="shareSheetOpen"
      :has-expenses="expenses.length > 0"
      :is-generating-image="isGeneratingImage"
      @close="shareSheetOpen = false"
      @share-text="shareSettlementText(includeDetailsInShare)"
      @export-long-image="exportLongImage(includeDetailsInShare)"
      @export-excel="exportExcel()"
    />
  </div>
</template>
