<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeftRight,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Coins,
  Copy,
  FileSpreadsheet,
  ImageDown,
  Info,
  Loader2,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
  Undo2,
  Wallet,
  X,
} from 'lucide-vue-next'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import {
  applySettlementRatesToTransactions,
  buildHubSettlementTransfers,
  type MemberNetBalance,
  type SettleUpResult,
} from '@/core/settleUpEngine'
import { formatCurrencyAmount, formatCurrencyNumber } from '@/core/currency'
import {
  buildMemberStatementShareText,
  buildProjectSettlementShareText,
} from '@/core/shareFormatter'
import {
  getTodayIso,
  sanitizeExportFilename,
  triggerBinaryFileDownload,
} from '@/core/ledgerHelpers'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import { askConfirm } from '@/composables/useConfirm'
import { useModalLayer } from '@/composables/useModalLayer'
import CategoryPieChart from '@/components/CategoryPieChart.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'

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
  (e: 'recordPayment', payload: { fromMemberId: string; toMemberId: string; amount: number; currency: string }): void
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
const isGeneratingImage = ref(false)
const rateSettingsExpanded = ref(false)
const shareSheetOpen = ref(false)
const shareSheetRef = ref<HTMLElement | null>(null)
const customSettleRateDrafts = ref<Record<string, string>>({})
const selectedMemberDetailId = ref<string | null>(null)
const memberDetailSectionRef = ref<HTMLElement | null>(null)
const memberSortMode = ref<'project' | 'net_desc'>('project')
const transferPlanMode = ref<'min_transfers' | 'hub'>('min_transfers')
const hubMemberId = ref<string>('')
const onlyMyTransfers = ref(false)
const currencyGuideOpen = ref(false)

useModalLayer(
  () => shareSheetOpen.value,
  () => {
    shareSheetOpen.value = false
  },
  shareSheetRef,
)

const currentRateModeLabel = computed(() => {
  if (currentRateMode.value === 'live') return t('rates.modeLive')
  if (currentRateMode.value === 'custom') return t('rates.modeCustom')
  return t('rates.modePerTx')
})

const poolMembers = computed(() => props.project.members.filter((m) => m.isPool))
const poolMemberIds = computed(() => {
  const ids = new Set(poolMembers.value.map((m) => m.id))
  for (const b of props.settleUp.balances) {
    if (b.memberId.startsWith('pool_')) {
      ids.add(b.memberId)
    }
  }
  return ids
})

const poolBalances = computed(() =>
  props.settleUp.balances.filter((b) => poolMemberIds.value.has(b.memberId)),
)

/** 辨識最近一次「批次收公費」的轉帳（相容單筆合併多人公費帳目與舊版多筆同批帳目），方便打錯金額時一鍵撤銷 */
const latestPoolCollectBatch = computed<{
  ids: string[]
  count: number
  amountPerPerson: number
  totalAmount: number
  currency: string
  date: string
} | null>(() => {
  if (poolMemberIds.value.size === 0) return null
  const poolDeposits = props.settlements
    .filter((tx) => {
      const toId = tx.splitConfig?.shares[0]?.memberId
      return Boolean(toId && poolMemberIds.value.has(toId))
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const latest = poolDeposits[0]
  if (!latest) return null

  const multiPayers = (latest.splitConfig?.payers ?? []).filter((p) => p.amount > 0)
  if (multiPayers.length > 1) {
    return {
      ids: [latest.id],
      count: multiPayers.length,
      amountPerPerson: multiPayers[0].amount,
      totalAmount: latest.amount,
      currency: latest.currency,
      date: latest.date,
    }
  }

  const targetPoolId = latest.splitConfig?.shares[0]?.memberId
  const latestNote = (latest.note ?? '').trim()
  const batch = poolDeposits.filter(
    (tx) =>
      tx.splitConfig?.shares[0]?.memberId === targetPoolId &&
      tx.date === latest.date &&
      tx.currency === latest.currency &&
      Math.abs(tx.amount - latest.amount) < 0.005 &&
      (tx.note ?? '').trim() === latestNote,
  )
  if (batch.length === 0) return null
  return {
    ids: batch.map((tx) => tx.id),
    count: batch.length,
    amountPerPerson: latest.amount,
    totalAmount: latest.amount * batch.length,
    currency: latest.currency,
    date: latest.date,
  }
})

async function handleUndoLatestPoolBatch() {
  const batch = latestPoolCollectBatch.value
  if (!batch) return
  const confirmed = await askConfirm({
    title: t('pool.undoBatchTitle'),
    message: t('pool.undoBatchConfirm', {
      count: batch.count,
      amount: fmt(batch.amountPerPerson, batch.currency),
      total: fmt(batch.totalAmount, batch.currency),
    }),
    confirmText: t('pool.undoBatchConfirmButton'),
    tone: 'danger',
  })
  if (!confirmed) return
  emit('deleteSettlementsBatch', batch.ids)
}

function getSettlementPayerIds(tx: Transaction): string[] {
  const multi = (tx.splitConfig?.payers ?? []).filter((p) => p.amount > 0)
  if (multi.length > 1) {
    return multi.map((p) => p.memberId)
  }
  return tx.splitConfig?.payerId ? [tx.splitConfig.payerId] : []
}

function getSettlementFromLabel(tx: Transaction): string {
  const payerIds = getSettlementPayerIds(tx)
  if (payerIds.length <= 1) {
    return getMemberName(payerIds[0] ?? '')
  }
  return payerIds.map((id) => getMemberName(id)).join('、')
}

const displayedMemberBalances = computed(() => {
  const list = props.settleUp.balances.filter(
    (b) => !poolMemberIds.value.has(b.memberId),
  )
  if (memberSortMode.value === 'net_desc') {
    return [...list].sort((a, b) => b.netAmount - a.netAmount)
  }
  return list
})

const resolvedHubMemberId = computed<string>(() => {
  if (
    hubMemberId.value &&
    props.project.members.some((m) => m.id === hubMemberId.value)
  ) {
    return hubMemberId.value
  }
  // 預設優先選公費袋，其次選應收回金額最高之大債權人（財務長）
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

function toggleMemberDetail(memberId: string) {
  const nextId = selectedMemberDetailId.value === memberId ? null : memberId
  selectedMemberDetailId.value = nextId
  if (nextId) {
    void nextTick(() => {
      memberDetailSectionRef.value?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    })
  }
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

const sourceRawExpenses = computed<Transaction[]>(
  () => props.rawExpenses ?? props.expenses,
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

/** 當前結帳幣別折回專案主幣別之參考匯率（供待還款金額小標示主幣別金額使用） */
const settlementToBaseRate = computed<number>(() => {
  const settle = settlementCurrency.value
  const base = props.project.baseCurrency.trim().toUpperCase()
  if (settle === base) return 1
  if (currentRateMode.value === 'custom') {
    const savedCustom = store.getProjectCustomRatesForTarget(props.project, settle)
    const baseToSettle = savedCustom?.[base]
    if (typeof baseToSettle === 'number' && Number.isFinite(baseToSettle) && baseToSettle > 0) {
      return 1 / baseToSettle
    }
  }
  return store.getEffectiveExchangeRate(settle, base)
})

const baseToSettlementRate = computed<number>(() => {
  const base = props.project.baseCurrency.trim().toUpperCase()
  const settle = settlementCurrency.value
  if (base === settle) return 1
  return store.getEffectiveExchangeRate(base, settle)
})

function convertSettleAmountToBase(amount: number): number {
  return amount * settlementToBaseRate.value
}

/** 各外幣於原始交易中實際記錄的匯率範圍（供「各筆原匯率」模式清楚呈現保留的原匯率資料） */
const originalRatesSummary = computed<Array<{ currency: string; text: string }>>(() => {
  const base = props.project.baseCurrency.trim().toUpperCase()
  const byCur = new Map<string, number[]>()
  for (const tx of [...sourceRawExpenses.value, ...props.settlements]) {
    if (tx.isDeleted) continue
    const cur = tx.currency.trim().toUpperCase()
    if (!cur || cur === base) continue
    const r = tx.exchangeRateToBase
    if (Number.isFinite(r) && r > 0) {
      const list = byCur.get(cur)
      if (list) list.push(r)
      else byCur.set(cur, [r])
    }
  }
  const result: Array<{ currency: string; text: string }> = []
  for (const [cur, rates] of byCur.entries()) {
    const min = Math.min(...rates)
    const max = Math.max(...rates)
    const text =
      Math.abs(max - min) < 0.00001
        ? `1 ${cur} = ${min} ${base}`
        : `1 ${cur} = ${min} ~ ${max} ${base}`
    result.push({ currency: cur, text })
  }
  return result
})

interface MemberStatementEntry {
  tx: Transaction
  title: string
  shareInSettle: number
  paidInSettle: number
  shareInBase: number
  paidInBase: number
  isRefund: boolean
}

const selectedMemberStatement = computed<MemberStatementEntry[]>(() => {
  const memberId = selectedMemberDetailId.value
  if (!memberId) return []
  const list: MemberStatementEntry[] = []

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
    const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
    const rawRate = rawTx.exchangeRateToBase > 0 ? rawTx.exchangeRateToBase : 1
    const sign = tx.type === 'refund' ? -1 : 1
    const shareObj = tx.splitConfig.shares.find((s) => s.memberId === memberId)
    const shareAmt = shareObj ? shareObj.finalAmount : 0

    let paidAmt = 0
    const multiPayers = (tx.splitConfig.payers ?? []).filter((p) => p.amount > 0)
    if (multiPayers.length > 0) {
      paidAmt = multiPayers.find((p) => p.memberId === memberId)?.amount ?? 0
    } else if (tx.splitConfig.payerId === memberId) {
      paidAmt = tx.amount
    }

    if (shareAmt <= 0 && paidAmt <= 0) continue
    list.push({
      tx: rawTx,
      title: tx.note?.trim() || getCategoryLabel(tx.categoryKey),
      shareInSettle: sign * shareAmt * rate,
      paidInSettle: sign * paidAmt * rate,
      shareInBase: sign * shareAmt * rawRate,
      paidInBase: sign * paidAmt * rawRate,
      isRefund: tx.type === 'refund',
    })
  }
  return list
})

const settlementCurrency = computed<string>(() =>
  store.getProjectSettlementCurrency(props.project),
)

const isCrossCurrencySettlement = computed<boolean>(
  () =>
    settlementCurrency.value !== props.project.baseCurrency.trim().toUpperCase(),
)

const settlementCurrencyChoices = computed<string[]>(() => {
  const set = new Set<string>(store.availableCurrencies)
  set.add(props.project.baseCurrency.trim().toUpperCase())
  set.add(settlementCurrency.value)
  for (const tx of props.expenses) {
    if (tx.currency) set.add(tx.currency.trim().toUpperCase())
  }
  return Array.from(set)
})

const foreignCurrenciesInProject = computed<string[]>(() => {
  const target = settlementCurrency.value
  const set = new Set<string>()
  for (const tx of [...props.expenses, ...props.settlements]) {
    const cur = tx.currency.trim().toUpperCase()
    if (cur && cur !== target) set.add(cur)
  }
  return Array.from(set)
})

const currentRateMode = computed<'per_tx' | 'live' | 'custom'>(() =>
  store.getProjectSettlementRateMode(props.project),
)

const formattedLiveRatesFetchedAt = computed(() => {
  const ts = store.liveRatesFetchedAt
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts))
  } catch {
    return ''
  }
})

function syncSettleRateDrafts() {
  const target = settlementCurrency.value
  const base = props.project.baseCurrency.trim().toUpperCase()
  const savedBucket = store.getProjectCustomRatesForTarget(props.project, target)
  const next: Record<string, string> = {}
  for (const cur of foreignCurrenciesInProject.value) {
    const saved = savedBucket?.[cur]
    const live = store.getLiveExchangeRate(cur, target)
    // 僅當結帳幣別等同記帳主幣別時，才從「原始未覆寫交易」取回原記帳匯率，避免讀取覆寫副本
    const fallbackTx =
      target === base
        ? sourceRawExpenses.value.find(
            (tx) =>
              tx.currency.trim().toUpperCase() === cur &&
              tx.exchangeRateToBase > 0,
          )?.exchangeRateToBase
        : undefined
    const val = saved ?? live ?? fallbackTx ?? store.getEffectiveExchangeRate(cur, target)
    next[cur] = val !== undefined && val !== null ? String(val) : ''
  }
  customSettleRateDrafts.value = next
}

watch(
  () => [
    props.project.id,
    settlementCurrency.value,
    props.project.baseCurrency,
    currentRateMode.value,
    JSON.stringify(
      store.getProjectCustomRatesForTarget(props.project, settlementCurrency.value) ?? {},
    ),
    foreignCurrenciesInProject.value.join(','),
    store.liveRatesFetchedAt,
  ],
  () => {
    syncSettleRateDrafts()
  },
  { immediate: true },
)

async function handleChangeSettlementCurrency(event: Event) {
  const nextCurrency = (event.target as HTMLSelectElement).value
  if (!nextCurrency || nextCurrency === settlementCurrency.value) return
  if (!store.liveRatesFetchedAt) {
    void store.refreshExchangeRates(false)
  }
  await store.updateProjectSettlementCurrency(props.project.id, nextCurrency)
  emit('toast', t('rates.settlementCurrencyChangedToast', { currency: nextCurrency }))
}

async function handleSelectSettleRateMode(mode: 'per_tx' | 'live' | 'custom') {
  if (mode === 'live' && !store.liveRatesFetchedAt) {
    await store.refreshExchangeRates(false)
  }
  if (mode === 'custom') {
    const parsedMap: Record<string, number> = {}
    for (const cur of foreignCurrenciesInProject.value) {
      const val = Number(customSettleRateDrafts.value[cur])
      if (Number.isFinite(val) && val > 0) {
        parsedMap[cur] = val
      }
    }
    await store.updateProjectSettlementRateConfig(props.project.id, 'custom', parsedMap)
  } else {
    await store.updateProjectSettlementRateConfig(props.project.id, mode)
  }
}

async function handleSaveCustomSettleRates() {
  const parsedMap: Record<string, number> = {}
  for (const cur of foreignCurrenciesInProject.value) {
    const val = Number(customSettleRateDrafts.value[cur])
    if (!Number.isFinite(val) || val <= 0) {
      emit('toast', t('validation.exchangeRateRequired'))
      return
    }
    parsedMap[cur] = val
  }
  await store.updateProjectSettlementRateConfig(props.project.id, 'custom', parsedMap)
  emit('toast', t('rates.settleCustomAppliedToast'))
}

async function handleFillLiveToCustomSettleRate(cur: string) {
  let live = store.getLiveExchangeRate(cur, settlementCurrency.value)
  if (live === null) {
    await store.refreshExchangeRates(true)
    live = store.getLiveExchangeRate(cur, settlementCurrency.value)
  }
  if (live === null) {
    emit('toast', t('project.liveRateUnavailableToast'))
    return
  }
  customSettleRateDrafts.value = {
    ...customSettleRateDrafts.value,
    [cur]: String(live),
  }
  await handleSaveCustomSettleRates()
}

async function handleRefreshRatesInSettle() {
  const res = await store.refreshExchangeRates(true)
  if (res) {
    emit('toast', t('rates.refreshedToast'))
  } else {
    emit('toast', t('project.liveRateUnavailableToast'))
  }
}

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}

function fmtNum(amount: number, currency: string): string {
  return formatCurrencyNumber(amount, currency, locale.value)
}

function getMemberName(memberId: string): string {
  const found = props.project.members.find((m) => m.id === memberId)
  if (found) return found.name
  if (memberId.startsWith('pool_')) return t('pool.defaultName')
  return memberId
}

function getMemberColor(memberId: string): string {
  return (
    props.project.members.find((m) => m.id === memberId)?.avatarColor ??
    '#10b981'
  )
}

function getMemberPaymentInfo(memberId: string): string {
  return (
    props.project.members.find((m) => m.id === memberId)?.paymentInfo?.trim() ??
    ''
  )
}

async function copyPaymentInfo(memberId: string) {
  const info = getMemberPaymentInfo(memberId)
  if (!info) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(info)
      emit('toast', t('profile.paymentInfoCopiedToast'))
      return
    }
  } catch {
    // 降級複製
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = info
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    emit('toast', t('profile.paymentInfoCopiedToast'))
  } catch {
    emit('toast', t('share.failedToast'))
  }
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

async function handleShareMemberStatement(memberId: string) {
  const memberName = getMemberName(memberId)
  const text = buildMemberStatementShareText(
    props.project,
    memberId,
    effectiveSettleUp.value,
    selectedMemberStatement.value.map((item) => ({
      date: item.tx.date,
      title: item.title,
      isRefund: item.isRefund,
      shareInSettle: item.shareInSettle,
      paidInSettle: item.paidInSettle,
    })),
    {
      headerPrefix: t('share.headerPrefix'),
      statementTitle: t('settle.memberStatementTitle', { name: memberName }),
      spentLabel: t('share.spentLabel'),
      paidLabel: t('share.paidLabel'),
      netLabel: t('export.excelNetAmount'),
      shouldReceive: t('settle.shouldReceive'),
      shouldPay: t('settle.shouldPay'),
      settled: t('settle.settled'),
      transfersTitle: t('share.pendingTitle'),
      allSettledText: t('settle.allSettled'),
      entriesTitle: t('share.detailsTitle'),
      refundTag: t('project.refundBadge'),
      transferLine: (from, to, amount) =>
        t('share.transferLine', { from, to, amount }),
      footerTagline: t('share.footerTagline'),
    },
    locale.value,
  )

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      emit('toast', t('settle.memberStatementCopiedToast', { name: memberName }))
      return
    }
  } catch {
    // 降級複製
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    emit('toast', t('settle.memberStatementCopiedToast', { name: memberName }))
  } catch {
    emit('toast', t('share.failedToast'))
  }
}

async function handleShareSettlement() {
  shareSheetOpen.value = false
  const summaryText = buildProjectSettlementShareText(
    props.project,
    effectiveSettleUp.value,
    props.settlements,
    {
      headerPrefix: t('share.headerPrefix'),
      totalSpendLabel: t('share.totalSpendLabel'),
      memberSummaryTitle: t('share.memberSummaryTitle'),
      spentLabel: t('share.spentLabel'),
      paidLabel: t('share.paidLabel'),
      pendingTitle: t('share.pendingTitle'),
      allSettledText: t('settle.allSettled'),
      historyTitle: t('share.historyTitle'),
      poolSectionTitle: t('pool.cardTitle'),
      poolPaidLabel: t('pool.paidOutLabel'),
      poolRemainingLabel: t('pool.remainingCashLabel'),
      poolOverdrawnLabel: t('pool.overdrawnLabel'),
      detailsTitle: t('share.detailsTitle'),
      refundTag: t('project.refundBadge'),
      transferLine: (from, to, amount) =>
        t('share.transferLine', { from, to, amount }),
      paidHistoryLine: (from, to, amount, date) =>
        t('share.paidHistoryLine', { from, to, amount, date }),
      detailItemLine: ({ date, title, amountText, payerText }) =>
        payerText
          ? t('share.detailItemLine', {
              date,
              title,
              amount: amountText,
              payer: payerText,
            })
          : `${date} ${title} ${amountText}`,
      footerTagline: t('share.footerTagline'),
    },
    locale.value,
    {
      includeDetails: includeDetailsInShare.value,
      expenses: props.expenses,
      resolveCategoryLabel: getCategoryLabel,
      formatMultiPayer: (count) => t('project.multiPayerBadge', { count }),
    },
  )

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({
        title: `${t('share.headerPrefix')} ${props.project.name}`,
        text: summaryText,
      })
      emit('toast', t('share.sharedToast'))
      return
    }
  } catch (err) {
    // 若使用者主動取消原生分享則靜默結束；其餘錯誤改走剪貼簿降級
    if (err instanceof Error && err.name === 'AbortError') {
      return
    }
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(summaryText)
      emit('toast', t('share.copiedToast'))
      return
    }
  } catch {
    // 走最後一層文字複製降級
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = summaryText
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    emit('toast', t('share.copiedToast'))
  } catch {
    emit('toast', t('share.failedToast'))
  }
}

function getCategoryColor(key: string): string {
  return store.categories.find((c) => c.key === key)?.color ?? '#64748b'
}

async function handleExportExcel() {
  shareSheetOpen.value = false
  const { buildProjectExcelBytes } = await import('@/core/excelExporter')
  const { settlementCurrency: targetCur, options } =
    store.getProjectSettlementOptions(props.project, [
      ...props.expenses,
      ...props.settlements,
    ])
  const effectiveSettlements = applySettlementRatesToTransactions(
    props.settlements,
    targetCur,
    options.overrideRatesByCurrency,
    options.projectBaseCurrency,
    options.baseToSettlementRate,
  )
  const allProjectTxs = [...props.expenses, ...effectiveSettlements]
  const bytes = buildProjectExcelBytes(
    props.project,
    allProjectTxs,
    effectiveSettleUp.value,
    {
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
        poolSectionTitle: t('pool.cardTitle'),
        poolPaidLabel: t('pool.paidOutLabel'),
        poolRemainingLabel: t('pool.remainingCashLabel'),
      },
      typeNames: {
        expense: t('project.typeExpense'),
        refund: t('project.typeRefund'),
        transfer: t('home.settlementBadge'),
        income: t('daily.typeIncome'),
        card_repayment: t('daily.typeCardRepayment'),
      },
      resolveCategoryLabel: getCategoryLabel,
    },
  )
  const safeName = sanitizeExportFilename(props.project.name)
  triggerBinaryFileDownload(
    bytes,
    `clearbill-${safeName}-${getTodayIso()}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  emit('toast', t('export.excelExportedToast'))
}

async function handleExportLongImage() {
  if (isGeneratingImage.value) return
  isGeneratingImage.value = true
  try {
    const { generateProjectReportPngBlob } = await import(
      '@/core/reportImageGenerator'
    )
    const blob = await generateProjectReportPngBlob(
      props.project,
      effectiveSettleUp.value,
      props.expenses,
      {
        brandTitle: t('app.name'),
        totalSpendLabel: t('settle.projectTotalSpend'),
        memberCountLabel: t('project.memberCount', {
          count: props.project.members.filter((m) => !m.isPool).length || props.project.members.length,
        }),
        categorySectionTitle: t('stats.title'),
        memberSectionTitle: t('settle.balancesTitle'),
        poolSectionTitle: t('pool.cardTitle'),
        poolPaidLabel: t('pool.paidOutLabel'),
        poolRemainingLabel: t('pool.remainingCashLabel'),
        poolOverdrawnLabel: t('pool.overdrawnLabel'),
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
        omittedEntriesNotice: (count) =>
          t('export.longImageOmittedNotice', { count }),
        resolveCategoryLabel: getCategoryLabel,
        resolveCategoryColor: getCategoryColor,
      },
      locale.value,
      {
        includeEntries: includeDetailsInShare.value,
      },
    )

    const safeName = sanitizeExportFilename(props.project.name)
    const filename = `clearbill-${safeName}-${getTodayIso()}.png`

    // 行動端優先使用原生分享圖片檔（直接丟進 LINE 群組）；不支援則自動下載 PNG
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      typeof File !== 'undefined'
    ) {
      const file = new File([blob], filename, { type: 'image/png' })
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: `${t('share.headerPrefix')} ${props.project.name}`,
            files: [file],
          })
          emit('toast', t('share.sharedToast'))
          return
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return
        }
      }
    }

    triggerBinaryFileDownload(blob, filename, 'image/png')
    emit('toast', t('export.longImageExportedToast'))
  } catch {
    emit('toast', t('export.longImageFailedToast'))
  } finally {
    isGeneratingImage.value = false
    shareSheetOpen.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- 頂部極簡總覽與操作列：總支出 ＋ 單一分享選單 ＋ 緊湊單行結帳幣別／按需展開匯率設定 -->
    <section
      class="space-y-2 rounded-2xl bg-white px-3.5 py-3 shadow-sm dark:bg-[#1C1C1E] sm:space-y-2.5 sm:p-4"
    >
      <div class="flex items-center justify-between gap-2.5">
        <div class="min-w-0">
          <div class="text-[11px] font-medium text-slate-400 dark:text-slate-500">
            {{ t('settle.projectTotalSpend') }}
          </div>
          <div class="mt-0.5 flex flex-wrap items-baseline gap-1.5">
            <span class="inline-flex items-baseline gap-1.5 tabular-nums">
              <span class="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-xs font-extrabold tracking-wide text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                {{ settlementCurrency }}
              </span>
              <span class="text-xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-2xl">
                {{ fmtNum(settleUp.totalProjectExpense, settlementCurrency) }}
              </span>
            </span>
            <span
              v-if="isCrossCurrencySettlement && baseSettleUp"
              class="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-[#2C2C2E] dark:text-slate-300"
            >
              {{
                t('rates.baseAmountTag', {
                  amount: `${project.baseCurrency} ${fmtNum(baseSettleUp.totalProjectExpense, project.baseCurrency)}`,
                })
              }}
            </span>
          </div>
        </div>

        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400 sm:px-4 sm:py-2"
          @click="shareSheetOpen = true"
        >
          <Share2 class="h-3.5 w-3.5" />
          <span>{{ t('share.button') }}</span>
        </button>
      </div>

      <!-- 緊湊單行結帳幣別選擇與按需展開匯率列（手機省空間不換行） -->
      <div class="flex items-center justify-between gap-1.5 border-t border-slate-100 pt-2 dark:border-white/10">
        <div class="flex min-w-0 items-center gap-1.5">
          <ArrowLeftRight class="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span class="shrink-0 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            {{ t('rates.settlementCurrencyLabel') }}
          </span>
          <select
            :value="settlementCurrency"
            :aria-label="t('rates.settlementCurrencyLabel')"
            class="h-6 rounded-md bg-emerald-500/12 px-1.5 text-[11px] font-bold text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-300"
            @change="handleChangeSettlementCurrency"
          >
            <option
              v-for="code in settlementCurrencyChoices"
              :key="code"
              :value="code"
            >
              {{ code }}
            </option>
          </select>
          <button
            type="button"
            :aria-label="t('rates.currencyGuideToggle')"
            :aria-expanded="currencyGuideOpen"
            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-200"
            :class="currencyGuideOpen ? 'bg-slate-100 text-emerald-600 dark:bg-white/10 dark:text-emerald-400' : ''"
            @click="currencyGuideOpen = !currencyGuideOpen"
          >
            <Info class="h-3.5 w-3.5" />
          </button>
        </div>

        <button
          v-if="foreignCurrenciesInProject.length > 0"
          type="button"
          class="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-200/80 dark:bg-[#2C2C2E] dark:text-slate-300 dark:hover:bg-white/15"
          @click="rateSettingsExpanded = !rateSettingsExpanded"
        >
          <span class="hidden sm:inline">{{ t('rates.settingsToggleShort') }} ·</span>
          <span>{{ currentRateModeLabel }}</span>
          <ChevronDown
            class="h-3 w-3 shrink-0 transition-transform"
            :class="rateSettingsExpanded ? 'rotate-180' : ''"
          />
        </button>
      </div>

      <!-- 記帳幣別 vs 結帳幣別 一眼對照小卡（點擊 i 圖示展開，平常不佔畫面） -->
      <div
        v-if="currencyGuideOpen"
        class="space-y-1.5 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600 dark:bg-[#2C2C2E] dark:text-slate-300"
      >
        <div class="flex items-start gap-2">
          <span class="mt-0.5 shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-white/10 dark:text-slate-200">
            {{ t('rates.guideBaseLabel', { currency: project.baseCurrency }) }}
          </span>
          <span class="min-w-0 flex-1">{{ t('rates.guideBaseDesc') }}</span>
        </div>
        <div class="flex items-start gap-2">
          <span class="mt-0.5 shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            {{ t('rates.guideSettleLabel', { currency: settlementCurrency }) }}
          </span>
          <span class="min-w-0 flex-1">{{ t('rates.guideSettleDesc') }}</span>
        </div>
      </div>

      <!-- 按需展開之三模式結算匯率抽屜（原匯率永久保留，不佔平常畫面空間） -->
      <div
        v-if="rateSettingsExpanded && foreignCurrenciesInProject.length > 0"
        class="space-y-2.5 border-t border-slate-100 pt-3 dark:border-white/10"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="grid flex-1 grid-cols-3 gap-1 rounded-xl bg-black/[0.06] p-1 text-[11px] font-semibold dark:bg-[#2C2C2E]">
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                currentRateMode === 'per_tx'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-[#3A3A3C] dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="handleSelectSettleRateMode('per_tx')"
            >
              {{ t('rates.modePerTx') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                currentRateMode === 'live'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-[#3A3A3C] dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="handleSelectSettleRateMode('live')"
            >
              {{ t('rates.modeLive') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                currentRateMode === 'custom'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-[#3A3A3C] dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="handleSelectSettleRateMode('custom')"
            >
              {{ t('rates.modeCustom') }}
            </button>
          </div>

          <button
            type="button"
            :disabled="store.isRefreshingLiveRates"
            class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-2 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-200 disabled:opacity-50 dark:bg-[#2C2C2E] dark:text-slate-300"
            @click="handleRefreshRatesInSettle"
          >
            <RefreshCw
              class="h-3 w-3"
              :class="store.isRefreshingLiveRates ? 'animate-spin' : ''"
            />
            <span class="hidden sm:inline">
              {{
                formattedLiveRatesFetchedAt
                  ? t('rates.updatedAtShort', { time: formattedLiveRatesFetchedAt })
                  : t('rates.refreshNow')
              }}
            </span>
          </button>
        </div>

        <!-- 各筆原匯率模式 -->
        <div
          v-if="currentRateMode === 'per_tx'"
          class="space-y-1.5 text-[11px] text-slate-600 dark:text-slate-300"
        >
          <div
            v-if="originalRatesSummary.length > 0 || isCrossCurrencySettlement"
            class="flex flex-wrap items-center gap-1.5"
          >
            <span
              v-for="item in originalRatesSummary"
              :key="item.currency"
              class="inline-flex items-center rounded-lg bg-slate-100 px-2.5 py-1 font-semibold tabular-nums text-slate-700 dark:bg-[#2C2C2E] dark:text-slate-200"
            >
              {{ item.text }}
            </span>
            <span
              v-if="isCrossCurrencySettlement"
              class="inline-flex items-center rounded-lg bg-emerald-500/12 px-2.5 py-1 font-semibold tabular-nums text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
            >
              {{
                t('rates.crossBaseBridgeRate', {
                  base: project.baseCurrency,
                  rate: baseToSettlementRate,
                  target: settlementCurrency,
                })
              }}
            </span>
          </div>
          <p class="text-[10px] text-slate-400 dark:text-slate-500">
            {{ t('rates.perTxPreservedHint') }}
          </p>
        </div>

        <!-- 即時匯率對照 -->
        <div
          v-else-if="currentRateMode === 'live'"
          class="flex flex-wrap items-center gap-1.5 text-[11px]"
        >
          <span
            v-for="cur in foreignCurrenciesInProject"
            :key="cur"
            class="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 font-semibold tabular-nums text-slate-700 dark:bg-[#2C2C2E] dark:text-slate-200"
          >
            <span>1 {{ cur }} =</span>
            <span class="text-emerald-600 dark:text-emerald-400">
              {{ store.getEffectiveExchangeRate(cur, settlementCurrency) }}
            </span>
            <span>{{ settlementCurrency }}</span>
          </span>
        </div>

        <!-- 自訂結算匯率 -->
        <div v-else-if="currentRateMode === 'custom'" class="space-y-2">
          <div
            v-for="cur in foreignCurrenciesInProject"
            :key="cur"
            class="flex items-center gap-2 rounded-xl bg-slate-100/80 px-3 py-2 text-xs dark:bg-[#2C2C2E]"
          >
            <span class="shrink-0 font-semibold text-slate-600 dark:text-slate-300">
              1 {{ cur }} =
            </span>
            <input
              v-model="customSettleRateDrafts[cur]"
              type="number"
              step="any"
              min="0"
              inputmode="decimal"
              class="min-w-0 flex-1 rounded-lg bg-white px-2.5 py-1 text-xs font-bold tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:bg-[#1C1C1E] dark:text-white"
              @keyup.enter="handleSaveCustomSettleRates"
            />
            <span class="shrink-0 text-[11px] font-semibold text-slate-500">
              {{ settlementCurrency }}
            </span>
            <button
              type="button"
              class="shrink-0 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 shadow-sm transition hover:text-emerald-600 dark:bg-[#1C1C1E] dark:text-slate-300"
              @click="handleFillLiveToCustomSettleRate(cur)"
            >
              {{ t('rates.useLiveShort') }}
            </button>
          </div>
          <button
            type="button"
            class="w-full rounded-xl bg-emerald-600 py-2 text-xs font-bold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
            @click="handleSaveCustomSettleRates"
          >
            {{ t('rates.applySettleCustomButton') }}
          </button>
        </div>
      </div>
    </section>

    <!-- 雙欄響應式主區：公費袋優先顯眼呈現，接續待還款與還款紀錄 -->
    <div class="space-y-4 lg:grid lg:grid-cols-12 lg:items-start lg:gap-5 lg:space-y-0">
      <!-- 行動欄（手機置頂／桌機左欄 5 格）：公費袋（啟用時置頂） ＋ 待還款建議 ＋ 已記錄還款 -->
      <div class="space-y-4 lg:col-span-5">
        <!-- 1. 公費袋專屬卡片（啟用時置頂於最醒目位置，青色微外框清楚區隔） -->
        <section
          v-if="poolBalances.length > 0"
          class="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-teal-500/25 dark:bg-[#1C1C1E] dark:ring-teal-400/25"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
              <span class="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-teal-500/15 text-teal-600 dark:text-teal-400">
                <Wallet class="h-3.5 w-3.5" />
              </span>
              <span>{{ t('pool.cardTitle') }}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <button
                v-if="latestPoolCollectBatch"
                type="button"
                class="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2.5 py-1 text-[10px] font-semibold text-rose-600 transition hover:bg-rose-500/20 dark:bg-rose-500/15 dark:text-rose-400"
                @click="handleUndoLatestPoolBatch"
              >
                <Undo2 class="h-3 w-3" />
                <span>{{
                  t('pool.undoLatestBatchShort', { count: latestPoolCollectBatch.count })
                }}</span>
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full bg-teal-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-teal-700 dark:bg-teal-500 dark:text-slate-950"
                @click="emit('openPoolCollect')"
              >
                <span>+ {{ t('pool.collectButtonShort') }}</span>
              </button>
            </div>
          </div>

          <div class="divide-y divide-slate-100 dark:divide-white/10">
            <div
              v-for="pb in poolBalances"
              :key="pb.memberId"
              class="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
            >
              <div class="min-w-0">
                <div class="text-sm font-semibold text-slate-900 dark:text-white">
                  {{ getMemberName(pb.memberId) }}
                </div>
                <div class="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                  {{ t('pool.paidOutLabel') }} {{ fmt(pb.totalPaid, settlementCurrency) }}
                  <span
                    v-if="isCrossCurrencySettlement && getBaseBalance(pb.memberId)"
                    class="ml-1"
                  >
                    ({{ fmt(getBaseBalance(pb.memberId)!.totalPaid, project.baseCurrency) }})
                  </span>
                </div>
              </div>
              <div class="text-right">
                <div
                  class="text-base font-bold tabular-nums"
                  :class="
                    pb.netAmount <= 0
                      ? 'text-teal-600 dark:text-teal-400'
                      : 'text-rose-600 dark:text-rose-400'
                  "
                >
                  {{ fmt(Math.abs(pb.netAmount), settlementCurrency) }}
                </div>
                <div
                  v-if="isCrossCurrencySettlement && getBaseBalance(pb.memberId)"
                  class="text-[10px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
                >
                  {{ fmt(Math.abs(getBaseBalance(pb.memberId)!.netAmount), project.baseCurrency) }}
                </div>
                <div class="text-[10px] font-medium text-slate-400">
                  {{
                    pb.netAmount > 0
                      ? t('pool.overdrawnLabel')
                      : t('pool.remainingCashLabel')
                  }}
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 2. 待還款結算（Action First） -->
        <section
          class="space-y-3 rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
              <span class="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <Coins class="h-3.5 w-3.5" />
              </span>
              <span>{{ t('settle.suggestionsTitle') }}</span>
            </div>

            <!-- 僅於尚未建立公費袋時在此顯示「收公費」入口，避免與公費袋卡片按鈕重複 -->
            <button
              v-if="poolBalances.length === 0"
              type="button"
              class="inline-flex items-center gap-1 rounded-full bg-teal-500/12 px-2.5 py-1 text-[11px] font-semibold text-teal-700 transition hover:bg-teal-500/20 dark:bg-teal-400/15 dark:text-teal-300"
              @click="emit('openPoolCollect')"
            >
              <Wallet class="h-3 w-3" />
              <span>{{ t('pool.collectButtonShort') }}</span>
            </button>
          </div>

          <!-- 結算模式切換列：最少轉帳 / 集中收付 ＋ 只看我濾鏡 -->
          <div v-if="effectiveTransfers.length > 0" class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="inline-flex rounded-xl bg-black/[0.06] p-0.5 text-[11px] font-semibold dark:bg-[#2C2C2E]">
                <button
                  type="button"
                  class="rounded-lg px-2.5 py-1 transition"
                  :class="
                    transferPlanMode === 'min_transfers'
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-[#3A3A3C] dark:text-white'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                  "
                  @click="transferPlanMode = 'min_transfers'"
                >
                  {{ t('settle.planModeMin') }}
                </button>
                <button
                  type="button"
                  class="rounded-lg px-2.5 py-1 transition"
                  :class="
                    transferPlanMode === 'hub'
                      ? 'bg-white text-emerald-700 shadow-sm dark:bg-[#3A3A3C] dark:text-emerald-400'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                  "
                  @click="transferPlanMode = 'hub'"
                >
                  {{ t('settle.planModeHub') }}
                </button>
              </div>

              <button
                v-if="myMemberId"
                type="button"
                class="rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
                :class="
                  onlyMyTransfers
                    ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
                "
                @click="onlyMyTransfers = !onlyMyTransfers"
              >
                {{ t('settle.onlyMyTransfersButton') }}
              </button>
            </div>

            <!-- 集中收付模式窗口選擇 -->
            <div
              v-if="transferPlanMode === 'hub'"
              class="flex items-center justify-between gap-2 rounded-xl bg-slate-100/80 px-3 py-1.5 text-[11px] dark:bg-[#2C2C2E]"
            >
              <span class="shrink-0 font-medium text-slate-500 dark:text-slate-400">
                {{ t('settle.hubMemberLabel') }}
              </span>
              <select
                :value="resolvedHubMemberId"
                class="min-w-0 max-w-[180px] rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-800 focus:outline-none dark:bg-[#1C1C1E] dark:text-white"
                @change="hubMemberId = ($event.target as HTMLSelectElement).value"
              >
                <option v-for="m in project.members" :key="m.id" :value="m.id">
                  {{ m.name }}
                </option>
              </select>
            </div>
          </div>

          <p
            v-if="effectiveTransfers.length === 0"
            class="rounded-xl bg-emerald-500/10 px-3.5 py-3 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
          >
            {{ t('settle.allSettled') }}
          </p>

          <p
            v-else-if="visibleTransfers.length === 0"
            class="rounded-xl bg-slate-100/80 px-3.5 py-3 text-xs font-medium text-slate-500 dark:bg-[#2C2C2E] dark:text-slate-400"
          >
            {{ t('settle.noMyTransfers') }}
          </p>

          <ul v-else class="divide-y divide-slate-100 dark:divide-white/10">
            <li
              v-for="(transfer, idx) in visibleTransfers"
              :key="idx"
              class="flex items-center justify-between gap-2 py-3 first:pt-1 last:pb-0"
            >
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-white">
                  <span class="inline-flex items-center gap-1.5">
                    <span
                      class="h-2 w-2 rounded-full"
                      :style="{ backgroundColor: getMemberColor(transfer.fromMemberId) }"
                    />
                    <span>{{ getMemberName(transfer.fromMemberId) }}</span>
                  </span>
                  <span class="text-slate-400">→</span>
                  <span class="inline-flex items-center gap-1.5">
                    <span
                      class="h-2 w-2 rounded-full"
                      :style="{ backgroundColor: getMemberColor(transfer.toMemberId) }"
                    />
                    <span>{{ getMemberName(transfer.toMemberId) }}</span>
                  </span>
                </div>
                <div class="mt-1 flex flex-wrap items-baseline gap-1.5 tabular-nums">
                  <span class="inline-flex items-baseline gap-1">
                    <span class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-extrabold tracking-wide text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                      {{ transfer.currency }}
                    </span>
                    <span class="text-base font-bold text-emerald-700 dark:text-emerald-400">
                      {{ fmtNum(transfer.amount, transfer.currency) }}
                    </span>
                  </span>
                  <span
                    v-if="isCrossCurrencySettlement"
                    class="text-[11px] font-medium text-slate-400 dark:text-slate-500"
                  >
                    ≈ {{ project.baseCurrency }} {{ fmtNum(convertSettleAmountToBase(transfer.amount), project.baseCurrency) }}
                  </span>
                </div>
                <button
                  v-if="getMemberPaymentInfo(transfer.toMemberId)"
                  type="button"
                  class="mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-medium text-slate-600 transition hover:text-emerald-600 dark:bg-[#2C2C2E] dark:text-slate-300"
                  @click="copyPaymentInfo(transfer.toMemberId)"
                >
                  <Copy class="h-2.5 w-2.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span class="truncate">{{ getMemberPaymentInfo(transfer.toMemberId) }}</span>
                </button>
              </div>
              <button
                type="button"
                class="shrink-0 rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:text-slate-950"
                @click="
                  emit('recordPayment', {
                    fromMemberId: transfer.fromMemberId,
                    toMemberId: transfer.toMemberId,
                    amount: transfer.amount,
                    currency: transfer.currency,
                  })
                "
              >
                {{ t('settle.recordButton') }}
              </button>
            </li>
          </ul>
        </section>

        <!-- 3. 已記錄之還款明細（Inset Grouped List，無斑馬紋） -->
        <section
          class="rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]"
        >
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
        <section
          class="rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]"
        >
          <div class="mb-3 flex items-center justify-between gap-2">
            <h3 class="text-sm font-bold text-slate-900 dark:text-white">
              {{ t('settle.balancesTitle') }}
            </h3>
            <button
              v-if="displayedMemberBalances.length >= 5"
              type="button"
              class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:text-emerald-600 dark:bg-[#2C2C2E] dark:text-slate-300"
              @click="
                memberSortMode =
                  memberSortMode === 'project' ? 'net_desc' : 'project'
              "
            >
              <ArrowUpDown class="h-3 w-3" />
              <span>{{
                memberSortMode === 'project'
                  ? t('settle.sortByMemberOrder')
                  : t('settle.sortByNetAmount')
              }}</span>
            </button>
          </div>

          <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <button
              v-for="bal in displayedMemberBalances"
              :key="bal.memberId"
              type="button"
              class="overflow-hidden rounded-2xl p-3 text-left transition active:scale-[0.99]"
              :class="
                selectedMemberDetailId === bal.memberId
                  ? 'bg-emerald-500/10 ring-2 ring-emerald-500/60 dark:bg-emerald-500/15'
                  : 'bg-[#F2F2F7]/75 hover:bg-[#F2F2F7] dark:bg-[#2C2C2E]/70 dark:hover:bg-[#2C2C2E]'
              "
              @click="toggleMemberDetail(bal.memberId)"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-2">
                  <MemberAvatar
                    :name="getMemberName(bal.memberId)"
                    :color="getMemberColor(bal.memberId)"
                    :image="project.members.find((m) => m.id === bal.memberId)?.avatarImage"
                    size="sm"
                  />
                  <span class="truncate text-sm font-bold text-slate-900 dark:text-white">
                    {{ getMemberName(bal.memberId) }}
                  </span>
                  <span
                    v-if="myMemberId && bal.memberId === myMemberId"
                    class="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:text-emerald-300"
                  >
                    {{ t('settle.meBadge') }}
                  </span>
                </div>

                <div class="text-right">
                  <div
                    class="text-sm font-bold tabular-nums"
                    :class="
                      bal.netAmount > 0
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : bal.netAmount < 0
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-slate-400'
                    "
                  >
                    {{ bal.netAmount > 0 ? '+' : '' }}{{ fmt(bal.netAmount, settlementCurrency) }}
                  </div>
                  <div
                    v-if="isCrossCurrencySettlement && getBaseBalance(bal.memberId)"
                    class="text-[10px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
                  >
                    {{ getBaseBalance(bal.memberId)!.netAmount > 0 ? '+' : '' }}{{ fmt(getBaseBalance(bal.memberId)!.netAmount, project.baseCurrency) }}
                  </div>
                  <div class="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                    {{
                      bal.netAmount > 0
                        ? t('settle.shouldReceive')
                        : bal.netAmount < 0
                          ? t('settle.shouldPay')
                          : t('settle.settled')
                    }}
                  </div>
                </div>
              </div>

              <div class="mt-2.5 grid grid-cols-2 gap-2 border-t border-black/[0.06] pt-2 text-[11px] dark:border-white/10">
                <div>
                  <span class="text-slate-400 dark:text-slate-500">{{ t('settle.memberTotalExpense') }}</span>
                  <div class="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {{ fmt(bal.totalExpense, settlementCurrency) }}
                  </div>
                  <div
                    v-if="isCrossCurrencySettlement && getBaseBalance(bal.memberId)"
                    class="text-[10px] tabular-nums text-slate-400"
                  >
                    {{ fmt(getBaseBalance(bal.memberId)!.totalExpense, project.baseCurrency) }}
                  </div>
                </div>
                <div class="text-right">
                  <span class="text-slate-400 dark:text-slate-500">{{ t('settle.memberTotalPaid') }}</span>
                  <div class="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                    {{ fmt(bal.totalPaid, settlementCurrency) }}
                  </div>
                  <div
                    v-if="isCrossCurrencySettlement && getBaseBalance(bal.memberId)"
                    class="text-[10px] tabular-nums text-slate-400"
                  >
                    {{ fmt(getBaseBalance(bal.memberId)!.totalPaid, project.baseCurrency) }}
                  </div>
                </div>
              </div>

              <div class="mt-1.5 flex items-center justify-end gap-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                <span>{{
                  selectedMemberDetailId === bal.memberId
                    ? t('settle.hideMemberDetails')
                    : t('settle.viewMemberDetails')
                }}</span>
                <ChevronRight
                  class="h-3 w-3 transition-transform"
                  :class="selectedMemberDetailId === bal.memberId ? 'rotate-90' : ''"
                />
              </div>
            </button>
          </div>

          <!-- 點擊成員展開之個人對帳明細（自動捲動至視口，純淨分隔線無斑馬紋） -->
          <div
            v-if="selectedMemberDetailId"
            ref="memberDetailSectionRef"
            class="mt-3 space-y-2.5 rounded-2xl bg-[#F2F2F7]/80 p-3 dark:bg-[#2C2C2E]/70"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <MemberAvatar
                  :name="getMemberName(selectedMemberDetailId)"
                  :color="getMemberColor(selectedMemberDetailId)"
                  :image="project.members.find((m) => m.id === selectedMemberDetailId)?.avatarImage"
                  size="xs"
                />
                <span class="truncate">
                  {{
                    t('settle.memberStatementTitle', {
                      name: getMemberName(selectedMemberDetailId),
                    })
                  }}
                  ({{ selectedMemberStatement.length }})
                </span>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
                  @click="handleShareMemberStatement(selectedMemberDetailId)"
                >
                  <Copy class="h-3 w-3" />
                  <span>{{ t('settle.copyMemberStatementButton') }}</span>
                </button>
                <button
                  type="button"
                  class="text-[11px] font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
                  @click="emit('inspectMember', selectedMemberDetailId)"
                >
                  {{ t('settle.openInEntriesButton') }}
                </button>
                <button
                  type="button"
                  :aria-label="t('settings.close')"
                  class="rounded-full p-1 text-slate-400 hover:bg-white dark:hover:bg-white/10"
                  @click="selectedMemberDetailId = null"
                >
                  <X class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <p
              v-if="selectedMemberStatement.length === 0"
              class="py-3 text-center text-xs text-slate-400"
            >
              {{ t('settle.memberStatementEmpty') }}
            </p>

            <ul
              v-else
              class="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl bg-white dark:divide-white/10 dark:bg-[#1C1C1E]"
            >
              <li
                v-for="item in selectedMemberStatement"
                :key="item.tx.id"
                class="flex items-center justify-between gap-2 px-3 py-2.5 text-xs"
              >
                <button
                  type="button"
                  class="min-w-0 flex-1 text-left transition hover:opacity-80"
                  @click="emit('editExpense', item.tx)"
                >
                  <div class="flex items-center gap-1.5">
                    <span
                      v-if="item.isRefund"
                      class="rounded bg-teal-500/15 px-1.5 py-0.5 text-[9px] font-bold text-teal-700 dark:text-teal-300"
                    >
                      {{ t('project.refundBadge') }}
                    </span>
                    <span class="truncate font-semibold text-slate-900 dark:text-white">
                      {{ item.title }}
                    </span>
                  </div>
                  <div class="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                    {{ item.tx.date }} · {{ fmt(item.tx.amount, item.tx.currency) }}
                  </div>
                </button>
                <div class="shrink-0 text-right tabular-nums">
                  <div
                    v-if="item.shareInSettle !== 0"
                    class="text-[11px] font-semibold text-slate-900 dark:text-white"
                  >
                    {{ t('settle.memberTotalExpense') }}
                    {{ fmt(item.shareInSettle, settlementCurrency) }}
                    <span
                      v-if="isCrossCurrencySettlement"
                      class="block text-[9px] font-normal text-slate-400"
                    >
                      {{ fmt(item.shareInBase, project.baseCurrency) }}
                    </span>
                  </div>
                  <div
                    v-if="item.paidInSettle !== 0"
                    class="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
                  >
                    {{ t('settle.memberTotalPaid') }}
                    {{ fmt(item.paidInSettle, settlementCurrency) }}
                    <span
                      v-if="isCrossCurrencySettlement"
                      class="ml-1 text-[9px] font-normal text-slate-400"
                    >
                      ({{ fmt(item.paidInBase, project.baseCurrency) }})
                    </span>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </section>

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
    <Teleport to="body">
      <div
        v-if="shareSheetOpen"
        class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 p-3 backdrop-blur-[2px] sm:items-center"
        @click.self="shareSheetOpen = false"
      >
        <div
          ref="shareSheetRef"
          role="dialog"
          aria-modal="true"
          :aria-label="t('share.sheetTitle')"
          tabindex="-1"
          class="w-full max-w-sm space-y-2 pb-[env(safe-area-inset-bottom)] focus:outline-none"
        >
          <div class="overflow-hidden rounded-2xl bg-white/95 shadow-2xl backdrop-blur-xl dark:bg-[#1C1C1E]">
            <div class="border-b border-slate-100 px-4 py-3 text-center dark:border-white/10">
              <div class="text-xs font-semibold text-slate-500 dark:text-slate-400">
                {{ t('share.sheetTitle') }}
              </div>
            </div>

            <!-- iOS Switch 開關：是否附帶完整消費明細 -->
            <div
              v-if="expenses.length > 0"
              class="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-white/10"
            >
              <span class="text-xs font-medium text-slate-700 dark:text-slate-200">
                {{ t('share.includeDetailsToggle') }}
              </span>
              <button
                type="button"
                role="switch"
                :aria-checked="includeDetailsInShare"
                class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
                :class="
                  includeDetailsInShare
                    ? 'bg-emerald-500'
                    : 'bg-slate-200 dark:bg-slate-700'
                "
                @click="includeDetailsInShare = !includeDetailsInShare"
              >
                <span
                  class="inline-block h-5 w-5 rounded-full bg-white shadow transition-transform"
                  :class="includeDetailsInShare ? 'translate-x-5.5' : 'translate-x-0.5'"
                />
              </button>
            </div>

            <div class="divide-y divide-slate-100 dark:divide-white/10">
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-semibold text-slate-900 transition hover:bg-slate-50 active:bg-slate-100 dark:text-white dark:hover:bg-white/5"
                @click="handleShareSettlement"
              >
                <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <Share2 class="h-4 w-4" />
                </span>
                <span>{{ t('share.textSummaryAction') }}</span>
              </button>

              <button
                type="button"
                :disabled="isGeneratingImage"
                class="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-semibold text-slate-900 transition hover:bg-slate-50 active:bg-slate-100 disabled:opacity-50 dark:text-white dark:hover:bg-white/5"
                @click="handleExportLongImage"
              >
                <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400">
                  <Loader2 v-if="isGeneratingImage" class="h-4 w-4 animate-spin" />
                  <ImageDown v-else class="h-4 w-4" />
                </span>
                <span>{{ t('export.longImageButton') }}</span>
              </button>

              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-semibold text-slate-900 transition hover:bg-slate-50 active:bg-slate-100 dark:text-white dark:hover:bg-white/5"
                @click="handleExportExcel"
              >
                <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-500/15 text-teal-600 dark:text-teal-400">
                  <FileSpreadsheet class="h-4 w-4" />
                </span>
                <span>{{ t('export.excelButton') }}</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            class="w-full rounded-2xl bg-white py-3.5 text-center text-sm font-bold text-slate-900 shadow-lg transition hover:bg-slate-50 active:scale-[0.99] dark:bg-[#1C1C1E] dark:text-white dark:hover:bg-[#2C2C2E]"
            @click="shareSheetOpen = false"
          >
            {{ t('confirm.cancelButton') }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
