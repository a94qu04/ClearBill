<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeftRight,
  ArrowUpDown,
  ChevronRight,
  Coins,
  Copy,
  FileSpreadsheet,
  ImageDown,
  Loader2,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
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
import { formatCurrencyAmount } from '@/core/currency'
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
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const includeDetailsInShare = ref(false)
const isGeneratingImage = ref(false)
const customSettleRateDrafts = ref<Record<string, string>>({})
const selectedMemberDetailId = ref<string | null>(null)
const memberSortMode = ref<'project' | 'net_desc'>('project')
const transferPlanMode = ref<'min_transfers' | 'hub'>('min_transfers')
const hubMemberId = ref<string>('')
const onlyMyTransfers = ref(false)

const poolMembers = computed(() => props.project.members.filter((m) => m.isPool))
const poolMemberIds = computed(() => new Set(poolMembers.value.map((m) => m.id)))

const poolBalances = computed(() =>
  props.settleUp.balances.filter((b) => poolMemberIds.value.has(b.memberId)),
)

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
  selectedMemberDetailId.value =
    selectedMemberDetailId.value === memberId ? null : memberId
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

const currentRateMode = computed<'per_tx' | 'live' | 'custom'>(
  () => props.project.settlementRateMode ?? 'per_tx',
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
    props.project.settlementCurrency,
    props.project.baseCurrency,
    props.project.settlementRateMode,
    JSON.stringify(props.project.settlementCustomRates ?? {}),
    JSON.stringify(props.project.settlementCustomRatesByCurrency ?? {}),
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

function getMemberName(memberId: string): string {
  return props.project.members.find((m) => m.id === memberId)?.name ?? memberId
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
      },
      typeNames: {
        expense: t('project.typeExpense'),
        refund: t('project.typeRefund'),
        transfer: t('home.settlementBadge'),
        income: t('daily.typeIncome'),
        card_repayment: 'card_repayment',
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
  }
}
</script>

<template>
  <div class="space-y-4 lg:grid lg:grid-cols-12 lg:items-start lg:gap-5 lg:space-y-0">
    <!-- 左欄：結帳幣別匯率設定 ＋ 各成員總支出與展開明細 -->
    <div class="space-y-4 lg:col-span-7">
    <!-- 結帳幣別與匯率設定卡片（可自行選擇要結帳的幣別，並於含外幣時切換各筆原匯率／即時匯率／自訂結算匯率；原匯率資料永久保留） -->
    <section
      class="space-y-2.5 rounded-2xl border border-amber-300/90 bg-amber-50/70 p-3.5 shadow-sm dark:border-amber-800/70 dark:bg-amber-950/30"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <div class="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">
            <ArrowLeftRight class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            <span>{{ t('rates.settlementCurrencyLabel') }}</span>
          </div>
          <select
            :value="settlementCurrency"
            :aria-label="t('rates.settlementCurrencyLabel')"
            class="rounded-lg border border-amber-300/80 bg-white px-2.5 py-1 text-xs font-extrabold text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-amber-800 dark:bg-slate-900 dark:text-white"
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
          <span
            v-if="isCrossCurrencySettlement"
            class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
          >
            {{ t('rates.settlementCurrencyNote', { base: project.baseCurrency }) }}
          </span>
        </div>

        <button
          v-if="foreignCurrenciesInProject.length > 0"
          type="button"
          :disabled="store.isRefreshingLiveRates"
          class="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 hover:underline disabled:opacity-50 dark:text-amber-300"
          @click="handleRefreshRatesInSettle"
        >
          <RefreshCw
            class="h-3 w-3"
            :class="store.isRefreshingLiveRates ? 'animate-spin' : ''"
          />
          <span>
            {{
              formattedLiveRatesFetchedAt
                ? t('rates.updatedAtShort', { time: formattedLiveRatesFetchedAt })
                : t('rates.refreshNow')
            }}
          </span>
        </button>
      </div>

      <template v-if="foreignCurrenciesInProject.length > 0">
        <div class="grid grid-cols-3 gap-1 rounded-xl bg-white/80 p-1 text-[11px] font-bold dark:bg-slate-900/80">
          <button
            type="button"
            class="rounded-lg py-1.5 transition"
            :class="
              currentRateMode === 'per_tx'
                ? 'bg-slate-900 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
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
                ? 'bg-slate-900 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
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
                ? 'bg-slate-900 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
            "
            @click="handleSelectSettleRateMode('custom')"
          >
            {{ t('rates.modeCustom') }}
          </button>
        </div>

        <!-- 各筆原匯率模式：顯示完整保留之各外幣原始記帳匯率 -->
        <div
          v-if="currentRateMode === 'per_tx'"
          class="space-y-1.5 text-[11px] text-amber-900 dark:text-amber-200"
        >
          <div
            v-if="originalRatesSummary.length > 0"
            class="flex flex-wrap items-center gap-1.5"
          >
            <span
              v-for="item in originalRatesSummary"
              :key="item.currency"
              class="inline-flex items-center rounded-lg border border-amber-200/90 bg-white/95 px-2.5 py-1 font-bold tabular-nums shadow-sm dark:border-amber-800/60 dark:bg-slate-900"
            >
              {{ item.text }}
            </span>
          </div>
          <p class="text-[10px] font-medium text-amber-800/80 dark:text-amber-300/80">
            {{ t('rates.perTxPreservedHint') }}
          </p>
        </div>

        <!-- 即時匯率對照顯示 -->
        <div
          v-else-if="currentRateMode === 'live'"
          class="flex flex-wrap items-center gap-2 text-[11px] text-amber-900 dark:text-amber-200"
        >
          <span
            v-for="cur in foreignCurrenciesInProject"
            :key="cur"
            class="inline-flex items-center gap-1 rounded-lg bg-white/90 px-2.5 py-1 font-bold tabular-nums shadow-sm dark:bg-slate-900"
          >
            <span>1 {{ cur }} =</span>
            <span class="text-emerald-700 dark:text-emerald-400">
              {{ store.getEffectiveExchangeRate(cur, settlementCurrency) }}
            </span>
            <span>{{ settlementCurrency }}</span>
          </span>
        </div>

        <!-- 自訂結算匯率輸入列 -->
        <div v-else-if="currentRateMode === 'custom'" class="space-y-1.5">
          <div
            v-for="cur in foreignCurrenciesInProject"
            :key="cur"
            class="flex items-center gap-1.5 rounded-xl bg-white/90 px-2.5 py-1.5 text-xs dark:bg-slate-900"
          >
            <span class="shrink-0 font-bold text-slate-700 dark:text-slate-200">
              1 {{ cur }} =
            </span>
            <input
              v-model="customSettleRateDrafts[cur]"
              type="number"
              step="any"
              min="0"
              inputmode="decimal"
              class="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-bold tabular-nums text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              @keyup.enter="handleSaveCustomSettleRates"
            />
            <span class="shrink-0 text-[11px] font-bold text-slate-500">
              {{ settlementCurrency }}
            </span>
            <button
              type="button"
              class="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300"
              @click="handleFillLiveToCustomSettleRate(cur)"
            >
              {{ t('rates.useLiveShort') }}
            </button>
          </div>
          <button
            type="button"
            class="w-full rounded-xl bg-slate-900 py-1.5 text-[11px] font-bold text-white hover:bg-slate-800 dark:bg-emerald-500 dark:text-slate-950"
            @click="handleSaveCustomSettleRates"
          >
            {{ t('rates.applySettleCustomButton') }}
          </button>
        </div>
      </template>
    </section>

    <!-- 公費袋（公積金）專屬餘額卡（啟用公費袋時獨立呈現，不混亂真人成員對帳） -->
    <section
      v-if="poolBalances.length > 0"
      class="space-y-2 rounded-2xl border border-teal-300/90 bg-teal-50/70 p-3.5 shadow-sm dark:border-teal-800/70 dark:bg-teal-950/30"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 text-xs font-bold text-teal-900 dark:text-teal-200">
          <Wallet class="h-4 w-4 text-teal-600 dark:text-teal-400" />
          <span>{{ t('pool.cardTitle') }}</span>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-teal-700 dark:bg-teal-500 dark:text-slate-950"
          @click="emit('openPoolCollect')"
        >
          <span>+ {{ t('pool.collectButtonShort') }}</span>
        </button>
      </div>

      <div
        v-for="pb in poolBalances"
        :key="pb.memberId"
        class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-teal-200/80 bg-white/95 px-3 py-2.5 shadow-sm dark:border-teal-900/60 dark:bg-slate-900/90"
      >
        <div class="min-w-0">
          <div class="text-xs font-bold text-slate-800 dark:text-slate-100">
            {{ getMemberName(pb.memberId) }}
          </div>
          <div class="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {{ t('pool.paidOutLabel') }} {{ fmt(pb.totalPaid, settlementCurrency) }}
            <span
              v-if="isCrossCurrencySettlement && getBaseBalance(pb.memberId)"
              class="ml-1 text-[10px] font-medium text-amber-700 dark:text-amber-300"
            >
              ({{ fmt(getBaseBalance(pb.memberId)!.totalPaid, project.baseCurrency) }})
            </span>
          </div>
        </div>
        <div class="text-right">
          <div
            class="text-base font-extrabold tabular-nums"
            :class="
              pb.netAmount <= 0
                ? 'text-teal-700 dark:text-teal-300'
                : 'text-rose-600 dark:text-rose-400'
            "
          >
            {{ fmt(Math.abs(pb.netAmount), settlementCurrency) }}
          </div>
          <div
            v-if="isCrossCurrencySettlement && getBaseBalance(pb.memberId)"
            class="text-[10px] font-semibold tabular-nums text-amber-700 dark:text-amber-300"
          >
            {{ fmt(Math.abs(getBaseBalance(pb.memberId)!.netAmount), project.baseCurrency) }}
          </div>
          <div class="text-[10px] font-semibold text-slate-400">
            {{
              pb.netAmount < 0
                ? t('pool.remainingCashLabel')
                : pb.netAmount > 0
                  ? t('pool.overdrawnLabel')
                  : t('settle.settled')
            }}
          </div>
        </div>
      </div>
    </section>

    <!-- 各成員總支出與結算總覽（含主幣別小標示、一鍵分享精簡／明細切換、排序與報表匯出） -->
    <section
      class="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xs font-bold text-slate-700 dark:text-slate-200">
              {{ t('settle.balancesTitle') }}
            </h3>
            <button
              v-if="displayedMemberBalances.length >= 5"
              type="button"
              class="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 transition hover:border-emerald-400 hover:text-emerald-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
              @click="
                memberSortMode =
                  memberSortMode === 'project' ? 'net_desc' : 'project'
              "
            >
              <ArrowUpDown class="h-2.5 w-2.5" />
              <span>{{
                memberSortMode === 'project'
                  ? t('settle.sortByMemberOrder')
                  : t('settle.sortByNetAmount')
              }}</span>
            </button>
          </div>
          <div class="mt-0.5 flex flex-wrap items-baseline gap-1.5 text-[11px] font-semibold tabular-nums text-slate-500 dark:text-slate-400">
            <span>{{ t('settle.projectTotalSpend') }}:</span>
            <strong class="text-slate-900 dark:text-white">{{
              fmt(settleUp.totalProjectExpense, settlementCurrency)
            }}</strong>
            <span
              v-if="isCrossCurrencySettlement && baseSettleUp"
              class="rounded-md bg-amber-100/80 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              {{ t('rates.baseAmountTag', { amount: fmt(baseSettleUp.totalProjectExpense, project.baseCurrency) }) }}
            </span>
          </div>
        </div>

        <div class="flex flex-col items-end gap-1.5">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-slate-800 active:scale-95 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
            @click="handleShareSettlement"
          >
            <Share2 class="h-3.5 w-3.5" />
            <span>{{ t('share.button') }}</span>
          </button>

          <label
            v-if="expenses.length > 0"
            class="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400"
          >
            <input
              v-model="includeDetailsInShare"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800"
            />
            <span>{{ t('share.includeDetailsToggle') }}</span>
          </label>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <button
          v-for="bal in displayedMemberBalances"
          :key="bal.memberId"
          type="button"
          class="overflow-hidden rounded-xl border text-left transition hover:brightness-[0.98] active:scale-[0.99]"
          :class="
            selectedMemberDetailId === bal.memberId
              ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/25 dark:border-emerald-400 dark:bg-emerald-950/50'
              : bal.netAmount > 0
                ? 'border-emerald-200/90 bg-emerald-50/55 dark:border-emerald-900/60 dark:bg-emerald-950/25'
                : bal.netAmount < 0
                  ? 'border-rose-200/90 bg-rose-50/55 dark:border-rose-900/60 dark:bg-rose-950/25'
                  : 'border-slate-200 bg-slate-100/75 dark:border-slate-700/80 dark:bg-slate-800/70'
          "
          :style="{
            borderLeftWidth: '4px',
            borderLeftColor: getMemberColor(bal.memberId),
          }"
          @click="toggleMemberDetail(bal.memberId)"
        >
          <div class="p-3">
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                <MemberAvatar
                  :name="getMemberName(bal.memberId)"
                  :color="getMemberColor(bal.memberId)"
                  :image="project.members.find((m) => m.id === bal.memberId)?.avatarImage"
                  size="sm"
                />
                <span class="truncate text-sm font-bold text-slate-800 dark:text-slate-100">
                  {{ getMemberName(bal.memberId) }}
                </span>
                <span
                  v-if="myMemberId && bal.memberId === myMemberId"
                  class="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300"
                >
                  {{ t('settle.meBadge') }}
                </span>
              </div>

              <div class="text-right">
                <div
                  class="text-sm font-extrabold tabular-nums"
                  :class="
                    bal.netAmount > 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : bal.netAmount < 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-slate-500'
                  "
                >
                  {{ bal.netAmount > 0 ? '+' : '' }}{{ fmt(bal.netAmount, settlementCurrency) }}
                </div>
                <div
                  v-if="isCrossCurrencySettlement && getBaseBalance(bal.memberId)"
                  class="text-[10px] font-semibold tabular-nums text-amber-700/90 dark:text-amber-300/90"
                >
                  {{ getBaseBalance(bal.memberId)!.netAmount > 0 ? '+' : '' }}{{ fmt(getBaseBalance(bal.memberId)!.netAmount, project.baseCurrency) }}
                </div>
                <div class="text-[10px] font-medium text-slate-500 dark:text-slate-400">
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

            <div
              class="mt-2.5 grid grid-cols-2 gap-2 border-t border-slate-200/80 pt-2 text-[11px] dark:border-slate-700/70"
            >
              <div>
                <span class="text-slate-500 dark:text-slate-400">{{ t('settle.memberTotalExpense') }}</span>
                <div class="font-bold tabular-nums text-slate-900 dark:text-slate-100">
                  {{ fmt(bal.totalExpense, settlementCurrency) }}
                </div>
                <div
                  v-if="isCrossCurrencySettlement && getBaseBalance(bal.memberId)"
                  class="text-[10px] font-medium tabular-nums text-slate-500 dark:text-slate-400"
                >
                  {{ fmt(getBaseBalance(bal.memberId)!.totalExpense, project.baseCurrency) }}
                </div>
              </div>
              <div class="text-right">
                <span class="text-slate-500 dark:text-slate-400">{{ t('settle.memberTotalPaid') }}</span>
                <div class="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                  {{ fmt(bal.totalPaid, settlementCurrency) }}
                </div>
                <div
                  v-if="isCrossCurrencySettlement && getBaseBalance(bal.memberId)"
                  class="text-[10px] font-medium tabular-nums text-slate-500 dark:text-slate-400"
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
          </div>
        </button>
      </div>

      <!-- 點擊成員卡片展開之個人分攤與墊付明細（一鍵核對帳目） -->
      <div
        v-if="selectedMemberDetailId"
        class="mt-3 space-y-2 rounded-2xl border border-emerald-200/80 bg-emerald-50/40 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/20"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
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
          <div class="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
              @click="handleShareMemberStatement(selectedMemberDetailId)"
            >
              <Copy class="h-3 w-3" />
              <span>{{ t('settle.copyMemberStatementButton') }}</span>
            </button>
            <button
              type="button"
              class="text-[11px] font-bold text-emerald-700 hover:underline dark:text-emerald-400"
              @click="emit('inspectMember', selectedMemberDetailId)"
            >
              {{ t('settle.openInEntriesButton') }}
            </button>
            <button
              type="button"
              :aria-label="t('settings.close')"
              class="rounded-full p-1 text-slate-400 hover:bg-white dark:hover:bg-slate-800"
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
          class="max-h-64 divide-y divide-slate-200/80 overflow-y-auto rounded-xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
        >
          <li
            v-for="item in selectedMemberStatement"
            :key="item.tx.id"
            class="flex items-center justify-between gap-2 px-2.5 py-2 text-xs odd:bg-white even:bg-slate-50/85 dark:odd:bg-slate-900 dark:even:bg-slate-800/45"
          >
            <button
              type="button"
              class="min-w-0 flex-1 text-left transition hover:opacity-80"
              @click="emit('editExpense', item.tx)"
            >
              <div class="flex items-center gap-1.5">
                <span
                  v-if="item.isRefund"
                  class="rounded bg-teal-50 px-1 py-0.5 text-[9px] font-bold text-teal-700 dark:bg-teal-950/70 dark:text-teal-300"
                >
                  {{ t('project.refundBadge') }}
                </span>
                <span class="truncate font-semibold text-slate-800 dark:text-slate-100">
                  {{ item.title }}
                </span>
              </div>
              <div class="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                {{ item.tx.date }} · {{ fmt(item.tx.amount, item.tx.currency) }}
              </div>
            </button>
            <div class="shrink-0 text-right tabular-nums">
              <div
                v-if="item.shareInSettle !== 0"
                class="text-[11px] font-bold text-slate-800 dark:text-slate-100"
              >
                {{ t('settle.memberTotalExpense') }}
                {{ fmt(item.shareInSettle, settlementCurrency) }}
                <span
                  v-if="isCrossCurrencySettlement"
                  class="block text-[9px] font-medium text-amber-700/90 dark:text-amber-300/90"
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
                  class="ml-1 text-[9px] font-medium text-amber-700/80 dark:text-amber-300/80"
                >
                  ({{ fmt(item.paidInBase, project.baseCurrency) }})
                </span>
              </div>
            </div>
          </li>
        </ul>
      </div>

      <!-- 匯出報表列：標準 Excel (.xlsx) 與高解析長截圖報表 (PNG) -->
      <div
        class="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 dark:border-slate-800"
      >
        <button
          type="button"
          class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] font-bold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200 dark:hover:bg-slate-800"
          @click="handleExportExcel"
        >
          <FileSpreadsheet class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          <span class="truncate">{{ t('export.excelButton') }}</span>
        </button>
        <button
          type="button"
          :disabled="isGeneratingImage"
          class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200 dark:hover:bg-slate-800"
          @click="handleExportLongImage"
        >
          <Loader2 v-if="isGeneratingImage" class="h-3.5 w-3.5 animate-spin text-sky-600" />
          <ImageDown v-else class="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
          <span class="truncate">{{ t('export.longImageButton') }}</span>
        </button>
      </div>
    </section>
    </div>

    <!-- 右欄：消費結構圓餅圖 ＋ 待還款結算 ＋ 已記錄還款明細 -->
    <div class="space-y-4 lg:col-span-5">
    <!-- 消費結構圓餅圖統計（跨幣別結帳時同步小標示主幣別金額） -->
    <CategoryPieChart
      :transactions="expenses"
      :raw-transactions="sourceRawExpenses"
      :base-currency="settlementCurrency"
      :project-base-currency="project.baseCurrency"
    />

    <!-- 待還款結算（支援「最少轉帳」vs「財務長集中收付」、只看我濾鏡與一鍵收公費） -->
    <section
      class="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">
          <Coins class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span>{{ t('settle.suggestionsTitle') }}</span>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50/70 px-2 py-1 text-[11px] font-bold text-teal-800 transition hover:bg-teal-100 dark:border-teal-800/70 dark:bg-teal-950/40 dark:text-teal-300"
          @click="emit('openPoolCollect')"
        >
          <Wallet class="h-3 w-3" />
          <span>{{ t('pool.collectButtonShort') }}</span>
        </button>
      </div>

      <!-- 大團結算模式切換列：最少轉帳 / 集中收付 ＋ 只看我濾鏡 -->
      <div
        v-if="effectiveTransfers.length > 0"
        class="space-y-2"
      >
        <div class="flex flex-wrap items-center justify-between gap-1.5">
          <div class="inline-flex rounded-xl bg-slate-100 p-0.5 text-[11px] font-bold dark:bg-slate-800">
            <button
              type="button"
              class="rounded-lg px-2.5 py-1 transition"
              :class="
                transferPlanMode === 'min_transfers'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
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
                  ? 'bg-white text-emerald-700 shadow-sm dark:bg-slate-950 dark:text-emerald-400'
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
            class="rounded-full border px-2.5 py-1 text-[11px] font-semibold transition"
            :class="
              onlyMyTransfers
                ? 'border-emerald-500 bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
            "
            @click="onlyMyTransfers = !onlyMyTransfers"
          >
            {{ t('settle.onlyMyTransfersButton') }}
          </button>
        </div>

        <!-- 集中收付模式時可自選收付窗口（財務長 / 公費袋） -->
        <div
          v-if="transferPlanMode === 'hub'"
          class="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-1.5 text-[11px] dark:bg-slate-800/70"
        >
          <span class="shrink-0 font-semibold text-slate-500 dark:text-slate-400">
            {{ t('settle.hubMemberLabel') }}
          </span>
          <select
            :value="resolvedHubMemberId"
            class="min-w-0 max-w-[180px] rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-800 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
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
        class="rounded-xl bg-emerald-50 px-3.5 py-3 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
      >
        {{ t('settle.allSettled') }}
      </p>

      <p
        v-else-if="visibleTransfers.length === 0"
        class="rounded-xl bg-slate-50 px-3.5 py-3 text-xs font-medium text-slate-500 dark:bg-slate-800/70 dark:text-slate-400"
      >
        {{ t('settle.noMyTransfers') }}
      </p>

      <ul v-else class="space-y-2">
        <li
          v-for="(transfer, idx) in visibleTransfers"
          :key="idx"
          class="flex items-center justify-between gap-2 rounded-xl border border-sky-200/90 bg-sky-50/50 px-3.5 py-2.5 dark:border-sky-900/60 dark:bg-sky-950/25"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <span class="inline-flex items-center gap-1">
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  :style="{ backgroundColor: getMemberColor(transfer.fromMemberId) }"
                />
                <span>{{ getMemberName(transfer.fromMemberId) }}</span>
              </span>
              <span class="text-slate-400">→</span>
              <span class="inline-flex items-center gap-1">
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  :style="{ backgroundColor: getMemberColor(transfer.toMemberId) }"
                />
                <span>{{ getMemberName(transfer.toMemberId) }}</span>
              </span>
            </div>
            <div class="mt-0.5 flex flex-wrap items-baseline gap-1.5 tabular-nums">
              <span class="text-sm font-extrabold text-emerald-700 dark:text-emerald-400">
                {{ fmt(transfer.amount, transfer.currency) }}
              </span>
              <span
                v-if="isCrossCurrencySettlement"
                class="rounded bg-amber-100/80 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
              >
                ≈ {{ fmt(convertSettleAmountToBase(transfer.amount), project.baseCurrency) }}
              </span>
            </div>
            <button
              v-if="getMemberPaymentInfo(transfer.toMemberId)"
              type="button"
              class="mt-1 inline-flex max-w-full items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 transition hover:border-emerald-400 hover:text-emerald-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              @click="copyPaymentInfo(transfer.toMemberId)"
            >
              <Copy class="h-2.5 w-2.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span class="truncate">{{ getMemberPaymentInfo(transfer.toMemberId) }}</span>
            </button>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
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

    <!-- 已記錄之還款明細 -->
    <section
      class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <h3 class="mb-3 text-xs font-bold text-slate-700 dark:text-slate-200">
        {{ t('settle.historyTitle') }}
      </h3>

      <p
        v-if="settlements.length === 0"
        class="py-4 text-center text-xs text-slate-400 dark:text-slate-500"
      >
        {{ t('settle.noHistory') }}
      </p>

      <ul v-else class="divide-y divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/80 dark:divide-slate-800 dark:border-slate-800">
        <li
          v-for="tx in settlements"
          :key="tx.id"
          class="flex items-center justify-between gap-2 px-3 py-2.5 odd:bg-white even:bg-slate-50/85 dark:odd:bg-slate-900 dark:even:bg-slate-800/45"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <span class="inline-flex items-center gap-1">
                <span
                  class="h-2 w-2 rounded-full"
                  :style="{
                    backgroundColor: getMemberColor(tx.splitConfig?.payerId ?? ''),
                  }"
                />
                <span>{{ getMemberName(tx.splitConfig?.payerId ?? '') }}</span>
              </span>
              <span class="text-slate-400">→</span>
              <span class="inline-flex items-center gap-1">
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
            <div class="mt-0.5 text-[11px] text-slate-400">
              {{ tx.date }}
              <span v-if="tx.note"> · {{ tx.note }}</span>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <span class="mr-1 text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {{ fmt(tx.amount, tx.currency) }}
            </span>
            <button
              type="button"
              :aria-label="t('home.editTx')"
              class="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/60"
              @click="emit('editSettlement', tx)"
            >
              <Pencil class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              :aria-label="t('home.deleteTx')"
              class="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60"
              @click="emit('deleteSettlement', tx.id)"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </div>
        </li>
      </ul>
    </section>
    </div>
  </div>
</template>
