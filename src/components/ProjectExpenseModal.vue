<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Calendar,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Users,
  Wallet,
  X,
} from 'lucide-vue-next'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import { askConfirm } from '@/composables/useConfirm'
import { useModalLayer } from '@/composables/useModalLayer'
import { formatCurrencyAmount } from '@/core/currency'
import { compressImageFileToDataUrl } from '@/core/imageCompressor'
import {
  getCurrentTimeHHmm,
  getSuggestedExchangeRate,
  getTodayIso,
} from '@/core/ledgerHelpers'
import type { ParsedQuickIntakeResult } from '@/core/quickIntakeParser'
import type {
  Project,
  ProjectMember,
  SplitConfig,
  Transaction,
} from '@/schemas/ledgerSchema'
import CategoryIconBadge from '@/components/CategoryIconBadge.vue'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'
import CurrencyQuickAddPicker from '@/components/CurrencyQuickAddPicker.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'
import QuickSplitPanel from '@/components/QuickSplitPanel.vue'

interface Props {
  open: boolean
  project: Project | null
  editingTx: Transaction | null
  duplicateTx?: Transaction | null
  prefill?: ParsedQuickIntakeResult | null
  allowProjectSwitch?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  duplicateTx: null,
  prefill: null,
  allowProjectSwitch: false,
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', message: string): void
  (e: 'previewPhotos', payload: { photos: string[]; index: number }): void
  (e: 'toast', message: string): void
  (e: 'switchProject', projectId: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const txType = ref<'expense' | 'refund'>('expense')
const splitPreset = ref<SplitConfig | null>(null)
const splitDraftPreview = ref<SplitConfig | null>(null)
const splitResetKey = ref(0)
const amount = ref<number | null>(null)
const currency = ref('TWD')
const exchangeRate = ref<number | null>(1)
const exchangeRateSource = ref<'remembered' | 'live' | 'estimated' | 'saved' | 'custom'>('estimated')
const isFetchingLiveRate = ref(false)
const categoryKey = ref<string>(store.categories[0]?.key ?? 'cat_food')
const note = ref('')
const date = ref(getTodayIso())
const time = ref('')
const links = ref<string[]>([])
const receiptImages = ref<string[]>([])
const splitConfig = ref<SplitConfig | null>(null)
const splitValid = ref(false)
const splitErrorText = ref<string | null>(null)
const errorText = ref('')
const errorBoxRef = ref<HTMLElement | null>(null)
const dialogRef = ref<HTMLElement | null>(null)
const categoryScrollRef = ref<HTMLElement | null>(null)
const isDraggingCategoryBar = ref(false)
const canScrollCatLeft = ref(false)
const canScrollCatRight = ref(false)

let catDragStartX = 0
let catDragStartScrollLeft = 0
let catDragMoved = false
let catSuppressNextClick = false

function updateCategoryScrollButtons() {
  const el = categoryScrollRef.value
  if (!el) {
    canScrollCatLeft.value = false
    canScrollCatRight.value = false
    return
  }
  canScrollCatLeft.value = el.scrollLeft > 4
  canScrollCatRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
}

function handleCategoryPointerDown(event: PointerEvent) {
  if (event.pointerType !== 'mouse' || event.button !== 0) return
  const el = categoryScrollRef.value
  if (!el) return
  isDraggingCategoryBar.value = true
  catDragStartX = event.clientX
  catDragStartScrollLeft = el.scrollLeft
  catDragMoved = false
  catSuppressNextClick = false
}

function handleCategoryPointerMove(event: PointerEvent) {
  if (!isDraggingCategoryBar.value) return
  const el = categoryScrollRef.value
  if (!el) return
  const dx = event.clientX - catDragStartX
  if (Math.abs(dx) > 5) {
    catDragMoved = true
    catSuppressNextClick = true
  }
  if (catDragMoved) {
    el.scrollLeft = catDragStartScrollLeft - dx
    updateCategoryScrollButtons()
  }
}

function handleCategoryPointerUp() {
  isDraggingCategoryBar.value = false
  catDragMoved = false
}

function handleCategoryClickCapture(event: MouseEvent) {
  if (catSuppressNextClick) {
    catSuppressNextClick = false
    event.preventDefault()
    event.stopPropagation()
  }
}

function handleCategoryWheel(event: WheelEvent) {
  const el = categoryScrollRef.value
  if (!el || el.scrollWidth <= el.clientWidth) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (delta !== 0) {
    event.preventDefault()
    el.scrollLeft += delta
    updateCategoryScrollButtons()
  }
}

function scrollCategoryBar(direction: 'left' | 'right') {
  const el = categoryScrollRef.value
  if (!el) return
  el.scrollBy({
    left: direction === 'right' ? 180 : -180,
    behavior: 'smooth',
  })
}

const inlineNewCategoryOpen = ref(false)
const inlineNewCategoryName = ref('')
const inlineNewCurrencyOpen = ref(false)
const ratePanelExpanded = ref(false)
const dateTimePanelExpanded = ref(false)
const photoPanelExpanded = ref(false)
const splitPanelExpanded = ref(false)
const isSubmitting = ref(false)
const isCompressingImages = ref(false)
let formSessionId = 0
const initialSnapshot = ref('')
const snapshotReady = ref(false)

/** 收合拆帳面板時顯示的結構化摘要（墊付者小圈圈＋墊付文案＋拆帳模式＋分攤成員小圈圈） */
const splitSummaryMeta = computed(() => {
  if (!props.project) {
    return {
      payers: [] as ProjectMember[],
      payerLabel: '',
      modeLabel: '',
      shareMembers: [] as ProjectMember[],
    }
  }
  const members = props.project.members
  const memberById = new Map(members.map((m) => [m.id, m]))
  const cfg = splitConfig.value ?? splitDraftPreview.value ?? splitPreset.value

  let payers: ProjectMember[] = []
  if (cfg?.payers && cfg.payers.length > 0) {
    const activePayers = cfg.payers.filter((p) => p.amount > 0)
    const sourcePayers = activePayers.length > 0 ? activePayers : cfg.payers
    payers = sourcePayers
      .map((p) => memberById.get(p.memberId))
      .filter((m): m is ProjectMember => Boolean(m))
  }
  if (payers.length === 0) {
    const singlePayer =
      (cfg ? memberById.get(cfg.payerId) : undefined) ??
      (props.project.defaultPayerId
        ? memberById.get(props.project.defaultPayerId)
        : undefined) ??
      members[0]
    if (singlePayer) payers = [singlePayer]
  }

  const payerLabel =
    payers.length > 1
      ? t('project.multiPayerBadge', { count: payers.length })
      : t('project.paidByLabel', { name: payers[0]?.name ?? '' })

  let shareMembers: ProjectMember[] = []
  if (cfg) {
    const positiveShares = cfg.shares.filter((s) => s.finalAmount > 0)
    const activeShares =
      positiveShares.length > 0
        ? positiveShares
        : cfg.shares.filter((s) => {
            if (cfg.mode === 'weight') return (s.weight ?? 0) > 0
            if (cfg.mode === 'percentage') return (s.percent ?? 0) > 0
            return (
              (s.customAmount ?? 0) > 0 || s.isIncludedInRemainder === true
            )
          })
    shareMembers = activeShares
      .map((s) => memberById.get(s.memberId))
      .filter((m): m is ProjectMember => Boolean(m))
  }
  if (shareMembers.length === 0) {
    const nonPool = members.filter((m) => !m.isPool)
    shareMembers = nonPool.length > 0 ? nonPool : members
  }

  const modeLabel =
    cfg?.mode === 'custom_plus_equal'
      ? t('split.tabCustomShort')
      : cfg?.mode === 'weight'
        ? t('split.tabWeightShort')
        : cfg?.mode === 'percentage'
          ? t('split.tabPercentShort')
          : t('split.tabEqualShort')

  return {
    payers,
    payerLabel,
    modeLabel,
    shareMembers,
  }
})

const quickRatePresets = computed(() => {
  if (!props.project || !needsExchangeRate.value) return {}
  return store.getQuickExchangeRatePresets(
    currency.value,
    props.project.baseCurrency,
  )
})

function handleSaveQuickRatePreset(slot: 'cash' | 'card') {
  if (!props.project || !needsExchangeRate.value) return
  const val = exchangeRate.value ?? 0
  if (!Number.isFinite(val) || val <= 0) {
    emit('toast', t('validation.exchangeRateRequired'))
    return
  }
  store.saveQuickExchangeRatePreset(
    currency.value,
    props.project.baseCurrency,
    slot,
    val,
  )
  emit(
    'toast',
    slot === 'cash'
      ? t('rates.cashPresetSavedToast', { rate: val })
      : t('rates.cardPresetSavedToast', { rate: val }),
  )
}

function handleApplyQuickRatePreset(val: number) {
  exchangeRate.value = val
  exchangeRateSource.value = 'custom'
}

function handleUserCurrencyChange(nextCurrency: string) {
  currency.value = nextCurrency
  if (!props.project) return
  const resolved = resolveExchangeRateForCurrency(
    nextCurrency,
    props.project.baseCurrency,
  )
  exchangeRate.value = resolved.rate
  exchangeRateSource.value = resolved.source
}

function handleInlineCurrencyAdded(code: string) {
  handleUserCurrencyChange(code)
  inlineNewCurrencyOpen.value = false
}

async function handleSaveSplitGroup(payload: { name: string; memberIds: string[] }) {
  if (!props.project) return
  const saved = await store.saveProjectSplitGroup(
    props.project.id,
    payload.name,
    payload.memberIds,
  )
  if (saved) {
    emit('toast', t('split.groupSavedToast', { name: saved.name }))
  }
}

async function handleRemoveSplitGroup(groupId: string) {
  if (!props.project) return
  await store.removeProjectSplitGroup(props.project.id, groupId)
  emit('toast', t('split.groupRemovedToast'))
}

function captureFormSnapshot(): string {
  return JSON.stringify({
    txType: txType.value,
    amount: amount.value ?? null,
    currency: currency.value,
    exchangeRate: exchangeRate.value ?? null,
    categoryKey: categoryKey.value,
    note: note.value.trim(),
    date: date.value,
    time: time.value,
    links: links.value,
    receiptCount: receiptImages.value.length,
    splitConfig: splitConfig.value,
  })
}

const isDirty = computed(() => {
  if (!props.open || !snapshotReady.value) return false
  if (captureFormSnapshot() !== initialSnapshot.value) {
    return true
  }
  if (!props.editingTx) {
    return (
      (amount.value !== null && amount.value > 0) ||
      note.value.trim().length > 0 ||
      receiptImages.value.length > 0
    )
  }
  return false
})

async function requestClose() {
  if (isDirty.value) {
    const confirmed = await askConfirm({
      title: t('project.discardChangesTitle'),
      message: t('project.discardChangesMessage'),
      confirmText: t('project.discardButton'),
      tone: 'danger',
    })
    if (!confirmed) return
  }
  emit('close')
}

function resolveCategoryLabel(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

const allCategories = computed(() =>
  store.categories.map((cat) => ({
    key: cat.key,
    label: resolveCategoryLabel(cat),
    color: cat.color,
    icon: cat.icon,
  })),
)

/** 確保目前表單幣別（例如來自快速入帳預填的外幣）一定存在於下拉選單中 */
const currencyOptions = computed(() => {
  const list = [...store.availableCurrencies]
  if (currency.value && !list.includes(currency.value)) {
    list.unshift(currency.value)
  }
  return list
})

const needsExchangeRate = computed(() => {
  if (!props.project) return false
  return currency.value !== props.project.baseCurrency
})

const convertedPreviewAmount = computed(() => {
  const amt = amount.value ?? 0
  const rate = exchangeRate.value ?? 0
  if (amt <= 0 || rate <= 0) return 0
  return amt * rate
})

function cloneSplitConfig(config: SplitConfig | undefined): SplitConfig | null {
  if (!config) return null
  return {
    payerId: config.payerId,
    payers: config.payers ? config.payers.map((p) => ({ ...p })) : undefined,
    mode: config.mode,
    shares: config.shares.map((s) => ({ ...s })),
  }
}

const currentLiveRateValue = computed(() => {
  if (!props.project || !needsExchangeRate.value) return null
  return store.getLiveExchangeRate(currency.value, props.project.baseCurrency)
})

const formattedRateFetchedTime = computed(() => {
  const ts = store.liveRatesFetchedAt
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts))
  } catch {
    return ''
  }
})

function resolveExchangeRateForCurrency(
  fromCurrency: string,
  baseCurrency: string,
): { rate: number; source: 'remembered' | 'live' | 'estimated' } {
  if (fromCurrency.toUpperCase() === baseCurrency.toUpperCase()) {
    return { rate: 1, source: 'estimated' }
  }
  const remembered = store.getRememberedExchangeRate(fromCurrency, baseCurrency)
  if (remembered !== null) {
    return { rate: remembered, source: 'remembered' }
  }
  const live = store.getLiveExchangeRate(fromCurrency, baseCurrency)
  if (live !== null) {
    return { rate: live, source: 'live' }
  }
  return {
    rate: getSuggestedExchangeRate(fromCurrency, baseCurrency),
    source: 'estimated',
  }
}

async function handleApplyLiveRate() {
  if (!props.project || !needsExchangeRate.value || isFetchingLiveRate.value) return
  isFetchingLiveRate.value = true
  try {
    await store.refreshExchangeRates(true)
    const live = store.getLiveExchangeRate(currency.value, props.project.baseCurrency)
    if (live !== null) {
      exchangeRate.value = live
      exchangeRateSource.value = 'live'
      emit('toast', t('project.liveRateAppliedToast', { rate: live }))
    } else {
      emit('toast', t('project.liveRateUnavailableToast'))
    }
  } finally {
    isFetchingLiveRate.value = false
  }
}

function hydrateForm() {
  if (!props.project) return
  errorText.value = ''
  inlineNewCategoryOpen.value = false
  inlineNewCurrencyOpen.value = false
  ratePanelExpanded.value = false
  dateTimePanelExpanded.value = false
  photoPanelExpanded.value = false
  splitPanelExpanded.value = false

  if (props.editingTx) {
    const tx = props.editingTx
    txType.value = tx.type === 'refund' ? 'refund' : 'expense'
    amount.value = tx.amount
    currency.value = tx.currency
    exchangeRate.value = tx.exchangeRateToBase ?? 1
    exchangeRateSource.value = 'saved'
    categoryKey.value = tx.categoryKey
    note.value = tx.note ?? ''
    date.value = tx.date
    time.value = tx.time || '00:00'
    links.value = tx.links ? [...tx.links] : []
    receiptImages.value = tx.receiptImages ? [...tx.receiptImages] : []
    photoPanelExpanded.value = receiptImages.value.length > 0
    dateTimePanelExpanded.value = tx.date !== getTodayIso() || (Boolean(tx.time) && tx.time !== '00:00')
    splitPreset.value = cloneSplitConfig(tx.splitConfig)
    splitPanelExpanded.value = Boolean(
      tx.splitConfig &&
        (tx.splitConfig.mode !== 'equal' ||
          (tx.splitConfig.payers && tx.splitConfig.payers.length > 1)),
    )
  } else if (props.duplicateTx) {
    // 複製既有帳目再記一筆：保留類型、金額、幣別、匯率、分類、備註與拆帳配置，日期重設為今天且不帶舊收據
    const src = props.duplicateTx
    txType.value = src.type === 'refund' ? 'refund' : 'expense'
    amount.value = src.amount
    currency.value = src.currency
    const resolved = resolveExchangeRateForCurrency(
      src.currency,
      props.project.baseCurrency,
    )
    exchangeRate.value =
      src.currency === props.project.baseCurrency
        ? 1
        : src.exchangeRateToBase || resolved.rate
    exchangeRateSource.value = 'saved'
    categoryKey.value = src.categoryKey
    note.value = src.note ?? ''
    date.value = getTodayIso()
    time.value = ''
    links.value = []
    receiptImages.value = []
    splitPreset.value = cloneSplitConfig(src.splitConfig)
  } else if (props.prefill) {
    // 來自 #/quick-add（iOS 捷徑 / Web Share）之快速入帳自動預填
    const pf = props.prefill
    txType.value = 'expense'
    amount.value = pf.amount
    const prefillCurrency = pf.currency?.trim().toUpperCase() || props.project.baseCurrency
    currency.value = prefillCurrency
    const resolved = resolveExchangeRateForCurrency(
      prefillCurrency,
      props.project.baseCurrency,
    )
    exchangeRate.value = resolved.rate
    exchangeRateSource.value = resolved.source
    categoryKey.value = store.categories[0]?.key ?? 'cat_food'
    note.value = pf.merchant || pf.sanitizedNote || ''
    date.value = pf.date || getTodayIso()
    time.value = pf.time && pf.time !== '00:00' ? pf.time : ''
    links.value = pf.links ? [...pf.links] : []
    receiptImages.value = []
    splitPreset.value = cloneSplitConfig(pf.defaultSplitConfig)
  } else {
    txType.value = 'expense'
    amount.value = null
    // 按專案自動記憶上次記帳使用之幣別（出國連續記當地幣別不必每筆重選）
    const lastCur = store.getProjectLastCurrency(
      props.project.id,
      props.project.baseCurrency,
    )
    currency.value = lastCur
    const resolved = resolveExchangeRateForCurrency(
      lastCur,
      props.project.baseCurrency,
    )
    exchangeRate.value = resolved.rate
    exchangeRateSource.value = resolved.source
    categoryKey.value = store.categories[0]?.key ?? 'cat_food'
    note.value = ''
    date.value = getTodayIso()
    time.value = ''
    links.value = []
    receiptImages.value = []
    splitDraftPreview.value = null
    // 按專案自動帶入上一筆記憶之分攤明細（墊付人、拆帳模式與分攤成員）
    splitPreset.value = cloneSplitConfig(
      store.getProjectLastSplitConfig(props.project.id) ?? undefined,
    )
  }

  snapshotReady.value = false
  formSessionId += 1
  splitResetKey.value += 1
  void nextTick(() => {
    initialSnapshot.value = captureFormSnapshot()
    snapshotReady.value = true
    updateCategoryScrollButtons()
  })
}

/** 彈窗已開啟時切換目標專案：保留已填金額、備註、分類、日期與收據照，僅更新新專案的幣別匯率與記憶拆帳配置 */
function applyProjectSwitchPreservingDraft() {
  if (!props.project) return
  errorText.value = ''
  const nextCur = store.getProjectLastCurrency(
    props.project.id,
    props.project.baseCurrency,
  )
  // 若尚未填金額，自動切換為新專案上次使用幣別；若已填金額則保留原幣別並針對新專案主幣別重算匯率
  if ((amount.value ?? 0) <= 0) {
    currency.value = nextCur
  }
  const resolved = resolveExchangeRateForCurrency(
    currency.value,
    props.project.baseCurrency,
  )
  exchangeRate.value = resolved.rate
  exchangeRateSource.value = resolved.source
  splitDraftPreview.value = null
  splitPreset.value = cloneSplitConfig(
    store.getProjectLastSplitConfig(props.project.id) ?? undefined,
  )
  splitResetKey.value += 1
}

watch(
  () =>
    [
      props.open,
      props.editingTx?.id,
      props.duplicateTx?.id,
      props.prefill,
      props.project?.id,
    ] as const,
  (
    [isOpen, editId, dupId, prefillVal, projId],
    prev,
  ) => {
    const wasOpen = prev?.[0] ?? false
    const sameModeOnlyProjectChanged =
      wasOpen &&
      isOpen &&
      !editId &&
      !dupId &&
      !prefillVal &&
      prev?.[1] === editId &&
      prev?.[2] === dupId &&
      prev?.[3] === prefillVal &&
      prev?.[4] !== projId

    if (isOpen) {
      if (sameModeOnlyProjectChanged) {
        applyProjectSwitchPreservingDraft()
      } else {
        hydrateForm()
      }
    } else {
      formSessionId += 1
      snapshotReady.value = false
    }
  },
  { immediate: true },
)

useModalLayer(
  () => Boolean(props.open && props.project),
  () => {
    void requestClose()
  },
  dialogRef,
)

function fmt(val: number, cur: string): string {
  return formatCurrencyAmount(val, cur, locale.value)
}

function confirmInlineAddCategory() {
  const trimmed = inlineNewCategoryName.value.trim()
  if (!trimmed) return
  const created = store.addCategory(trimmed)
  categoryKey.value = created.key
  inlineNewCategoryName.value = ''
  inlineNewCategoryOpen.value = false
  emit('toast', t('settings.categoryAddedToast'))
}

async function handleImageFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return

  const remainingSlots = Math.max(0, 3 - receiptImages.value.length)
  if (remainingSlots === 0) {
    input.value = ''
    return
  }

  const capturedSession = formSessionId
  isCompressingImages.value = true
  try {
    const selected = Array.from(files).slice(0, remainingSlots)
    const compressed = await Promise.all(
      selected.map((file) => compressImageFileToDataUrl(file)),
    )
    // 若壓縮期間已關閉彈窗或進入下一筆，直接丟棄避免圖片錯貼
    if (capturedSession !== formSessionId || !props.open) return
    receiptImages.value = [...receiptImages.value, ...compressed].slice(0, 3)
  } catch {
    if (capturedSession === formSessionId) {
      emit('toast', t('photo.uploadError'))
    }
  } finally {
    isCompressingImages.value = false
    input.value = ''
  }
}

function removeImage(index: number) {
  receiptImages.value = receiptImages.value.filter((_, idx) => idx !== index)
}

function showValidationError(message: string) {
  errorText.value = message
  void nextTick(() => {
    errorBoxRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

async function handleSubmit(continueAdding = false) {
  if (isSubmitting.value || isCompressingImages.value) return
  errorText.value = ''
  if (!props.project) return

  const numericAmount = amount.value ?? 0
  if (numericAmount <= 0) {
    showValidationError(t('validation.amountRequired'))
    return
  }

  const rate = needsExchangeRate.value ? (exchangeRate.value ?? 0) : 1
  if (needsExchangeRate.value && rate <= 0) {
    showValidationError(t('validation.exchangeRateRequired'))
    return
  }

  if (!splitValid.value || !splitConfig.value) {
    splitPanelExpanded.value = true
    showValidationError(splitErrorText.value || t('split.errInvalidAmount'))
    return
  }

  const payload = {
    projectId: props.project.id,
    type: txType.value,
    amount: numericAmount,
    currency: currency.value,
    exchangeRateToBase: rate,
    categoryKey: categoryKey.value,
    date: date.value || getTodayIso(),
    time: time.value.trim() || '00:00',
    note: note.value,
    links: links.value.length > 0 ? links.value : undefined,
    receiptImages:
      receiptImages.value.length > 0 ? [...receiptImages.value] : undefined,
    splitConfig: splitConfig.value,
  }

  isSubmitting.value = true
  try {
    // 多人協作疑似重複記帳防呆：略過主動「複製再記」，且若兩筆均有填寫不同備註則不誤報重複
    if (!props.editingTx && !props.duplicateTx) {
      const incomingNote = payload.note.trim().toLowerCase()
      const duplicate = store.visibleTransactions.find((existing) => {
        if (
          existing.projectId !== props.project!.id ||
          existing.type !== payload.type ||
          existing.date !== payload.date ||
          existing.currency.trim().toUpperCase() !== payload.currency.trim().toUpperCase() ||
          Math.abs(existing.amount - payload.amount) >= 0.005
        ) {
          return false
        }
        const existingNote = (existing.note ?? '').trim().toLowerCase()
        if (incomingNote && existingNote && incomingNote !== existingNote) {
          return false
        }
        if (!incomingNote && !existingNote && existing.categoryKey !== payload.categoryKey) {
          return false
        }
        return true
      })
      if (duplicate) {
        const dupLabel =
          duplicate.note?.trim() ||
          allCategories.value.find((c) => c.key === duplicate.categoryKey)?.label ||
          duplicate.categoryKey
        const confirmed = await askConfirm({
          title: t('project.duplicateWarnTitle'),
          message: t('project.duplicateWarnMessage', {
            note: dupLabel,
            amount: fmt(duplicate.amount, duplicate.currency),
          }),
          confirmText: t('project.duplicateWarnConfirm'),
          tone: 'primary',
        })
        if (!confirmed) return
      }
    }

    store.rememberLastExpenseProject(props.project.id)
    store.rememberProjectLastCurrency(props.project.id, currency.value)
    store.rememberProjectLastSplitConfig(props.project.id, splitConfig.value)
    if (needsExchangeRate.value && rate > 0) {
      store.rememberExchangeRate(currency.value, props.project.baseCurrency, rate)
    }
    if (props.editingTx) {
      await store.updateTransaction(props.editingTx.id, payload)
      emit('saved', t('daily.updatedToast'))
      emit('close')
      return
    }
    await store.addTransaction(payload)
    if (continueAdding) {
      // 存並續記：保留幣別、匯率、分類、日期與分攤明細，清空金額、備註與收據立刻記下一筆
      amount.value = null
      note.value = ''
      time.value = ''
      links.value = []
      receiptImages.value = []
      splitDraftPreview.value = null
      splitPreset.value = cloneSplitConfig(
        store.getProjectLastSplitConfig(props.project.id) ?? undefined,
      )
      formSessionId += 1
      snapshotReady.value = false
      splitResetKey.value += 1
      void nextTick(() => {
        initialSnapshot.value = captureFormSnapshot()
        snapshotReady.value = true
      })
      emit('toast', t('project.savedAndContinueToast'))
      return
    }
    emit('saved', t('daily.savedToast'))
    emit('close')
  } catch {
    errorText.value = t('home.saveFailed')
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open && project"
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        :aria-label="editingTx ? t('project.editExpenseTitle') : t('project.addExpenseTitle')"
        class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
        @click.self="requestClose"
      >
        <div
          class="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-[#F2F2F7] shadow-2xl dark:bg-[#0D0D0F] sm:rounded-3xl"
        >
          <!-- Apple 風格頂部 Sheet 標題列（左取消、中標題、右關閉） -->
          <div
            class="flex shrink-0 items-center justify-between border-b border-black/5 bg-white/90 px-4 py-3 backdrop-blur-md dark:border-white/10 dark:bg-[#1C1C1E]/95"
          >
            <button
              type="button"
              class="rounded-lg px-2 py-1 text-sm font-medium text-slate-500 transition hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              @mousedown.prevent
              @click.stop="requestClose"
            >
              {{ t('confirm.cancelButton') }}
            </button>
            <h2 class="text-[15px] font-bold text-slate-900 dark:text-white">
              {{
                editingTx
                  ? t('project.editExpenseTitle')
                  : txType === 'refund'
                    ? t('project.typeRefund')
                    : t('project.addExpenseTitle')
              }}
            </h2>
            <button
              type="button"
              :aria-label="t('settings.close')"
              class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300"
              @mousedown.prevent
              @click.stop="requestClose"
            >
              <X class="h-4 w-4" />
            </button>
          </div>

          <!-- 中間可捲動表單主體（Apple 分組卡片：3 秒一屏記完，進階項目按需展開） -->
          <form
            id="project-expense-form"
            class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5"
            @submit.prevent="handleSubmit(false)"
          >
            <!-- 首頁快速記一筆時顯示目標專案並支援即時切換（自動帶入該專案上次幣別與分攤明細） -->
            <div
              v-if="allowProjectSwitch && !editingTx && store.activeProjects.length > 0"
              class="flex items-center justify-between gap-2 rounded-2xl bg-white px-3.5 py-2.5 shadow-sm dark:bg-[#1C1C1E]"
            >
              <span class="shrink-0 text-xs font-semibold text-slate-500 dark:text-slate-400">
                {{ t('project.targetProjectLabel') }}
              </span>
              <select
                :value="project.id"
                class="min-w-0 max-w-[230px] truncate rounded-xl bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:bg-[#2C2C2E] dark:text-white"
                @change="emit('switchProject', ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="p in store.activeProjects"
                  :key="p.id"
                  :value="p.id"
                >
                  {{ p.name }} ({{ p.baseCurrency }})
                </option>
              </select>
            </div>

            <!-- 分組 1：金額英雄卡 ＋ 幣別快速新增 ＋ 單行可展開匯率 -->
            <div class="space-y-2.5 rounded-2xl bg-white p-3.5 shadow-sm dark:bg-[#1C1C1E]">
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <CurrencyAmountInput
                    v-model="amount"
                    :currency="currency"
                    :currencies="currencyOptions"
                    show-currency-select
                    enable-expression
                    show-math-toolbar
                    show-service-fee-button
                    show-fx-fee-button
                    size="lg"
                    :autofocus="!editingTx"
                    placeholder="0"
                    @update:currency="handleUserCurrencyChange"
                  />
                </div>
                <button
                  type="button"
                  :title="t('project.quickAddCurrencyButton')"
                  :aria-label="t('project.quickAddCurrencyButton')"
                  class="mt-1 inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-600 dark:bg-[#2C2C2E] dark:text-slate-300"
                  @click="inlineNewCurrencyOpen = !inlineNewCurrencyOpen"
                >
                  <Plus class="h-4 w-4" />
                </button>
              </div>

              <CurrencyQuickAddPicker
                v-if="inlineNewCurrencyOpen"
                @added="handleInlineCurrencyAdded"
                @close="inlineNewCurrencyOpen = false"
                @toast="emit('toast', $event)"
              />

              <!-- 外幣匯率預設精簡為 1 行摘要列，點開才顯示即時參考與現金／刷卡價預設 -->
              <div
                v-if="needsExchangeRate"
                class="border-t border-slate-100 pt-2.5 dark:border-white/10"
              >
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-2 text-left text-xs"
                  @click="ratePanelExpanded = !ratePanelExpanded"
                >
                  <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span class="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                      1 {{ currency }} = {{ exchangeRate ?? 0 }} {{ project.baseCurrency }}
                    </span>
                    <span
                      v-if="convertedPreviewAmount > 0"
                      class="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                    >
                      · {{ t('project.convertedPreview', { amount: fmt(convertedPreviewAmount, project.baseCurrency) }) }}
                    </span>
                  </div>
                  <span class="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                    <span>{{ t('project.adjustShort') }}</span>
                    <ChevronDown
                      class="h-3.5 w-3.5 transition-transform"
                      :class="ratePanelExpanded ? 'rotate-180' : ''"
                    />
                  </span>
                </button>

                <div
                  v-if="ratePanelExpanded"
                  class="mt-2.5 space-y-2 rounded-xl bg-[#F2F2F7]/90 p-2.5 text-xs dark:bg-[#2C2C2E]"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold text-slate-600 dark:text-slate-300">
                      {{ t('project.exchangeRateLabel', { from: currency }) }}
                    </span>
                    <CurrencyAmountInput
                      v-model="exchangeRate"
                      :allow-decimals="true"
                      :max-decimals="8"
                      size="sm"
                      placeholder="1"
                      class="w-28"
                    />
                    <span class="font-semibold text-slate-600 dark:text-slate-300">
                      {{ project.baseCurrency }}
                    </span>
                    <button
                      type="button"
                      :disabled="isFetchingLiveRate"
                      class="ml-auto inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50 disabled:opacity-50 dark:bg-[#1C1C1E] dark:text-emerald-400"
                      @click="handleApplyLiveRate"
                    >
                      <RefreshCw
                        class="h-3 w-3"
                        :class="isFetchingLiveRate ? 'animate-spin' : ''"
                      />
                      <span>{{ t('project.refreshLiveRateButton') }}</span>
                    </button>
                  </div>

                  <div class="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                    <template v-if="currentLiveRateValue !== null">
                      {{
                        t('rates.inlineLiveRef', {
                          rate: currentLiveRateValue,
                          time: formattedRateFetchedTime || '--:--',
                        })
                      }}
                    </template>
                    <template v-else-if="exchangeRateSource !== 'saved'">
                      {{
                        exchangeRateSource === 'remembered'
                          ? t('project.exchangeRateRememberedHint')
                          : exchangeRateSource === 'live'
                            ? t('project.exchangeRateLiveHint')
                            : t('project.exchangeRateEstimatedHint')
                      }}
                    </template>
                  </div>

                  <!-- 現金價／刷卡價雙快捷匯率膠囊 -->
                  <div class="no-scrollbar flex flex-nowrap items-center gap-1.5 overflow-x-auto pt-1 text-[10px]">
                    <button
                      v-if="quickRatePresets.cash"
                      type="button"
                      class="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 font-bold tabular-nums transition"
                      :class="
                        exchangeRate === quickRatePresets.cash
                          ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                          : 'bg-white text-slate-700 dark:bg-[#1C1C1E] dark:text-slate-200'
                      "
                      @click="handleApplyQuickRatePreset(quickRatePresets.cash)"
                    >
                      {{ t('rates.cashPresetLabel', { rate: quickRatePresets.cash }) }}
                    </button>
                    <button
                      v-if="quickRatePresets.card"
                      type="button"
                      class="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 font-bold tabular-nums transition"
                      :class="
                        exchangeRate === quickRatePresets.card
                          ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                          : 'bg-white text-slate-700 dark:bg-[#1C1C1E] dark:text-slate-200'
                      "
                      @click="handleApplyQuickRatePreset(quickRatePresets.card)"
                    >
                      {{ t('rates.cardPresetLabel', { rate: quickRatePresets.card }) }}
                    </button>
                    <button
                      type="button"
                      class="shrink-0 whitespace-nowrap rounded-full border border-dashed border-slate-300 px-2 py-0.5 font-semibold text-slate-600 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-600 dark:text-slate-300"
                      @click="handleSaveQuickRatePreset('cash')"
                    >
                      {{ t('rates.saveAsCashPreset') }}
                    </button>
                    <button
                      type="button"
                      class="shrink-0 whitespace-nowrap rounded-full border border-dashed border-slate-300 px-2 py-0.5 font-semibold text-slate-600 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-600 dark:text-slate-300"
                      @click="handleSaveQuickRatePreset('card')"
                    >
                      {{ t('rates.saveAsCardPreset') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 分組 2：項目備註 ＋ 單行橫滑分類膠囊 -->
            <div class="divide-y divide-slate-100 rounded-2xl bg-white shadow-sm dark:divide-white/10 dark:bg-[#1C1C1E]">
              <input
                v-model="note"
                type="text"
                :placeholder="
                  txType === 'refund'
                    ? t('project.refundTitlePlaceholder')
                    : t('project.expenseTitlePlaceholder')
                "
                class="w-full rounded-t-2xl bg-transparent px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none dark:text-white dark:placeholder-slate-500"
              />

              <div class="space-y-2 px-3.5 py-2.5">
                <div class="relative flex items-center gap-1">
                  <button
                    v-if="canScrollCatLeft"
                    type="button"
                    :aria-label="t('photo.prev')"
                    class="hidden h-7 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 hover:text-slate-900 dark:bg-[#2C2C2E] dark:text-slate-300 sm:inline-flex"
                    @click="scrollCategoryBar('left')"
                  >
                    <ChevronLeft class="h-3.5 w-3.5" />
                  </button>

                  <div
                    ref="categoryScrollRef"
                    class="no-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 select-none"
                    :class="isDraggingCategoryBar ? 'cursor-grabbing' : 'cursor-grab'"
                    @pointerdown="handleCategoryPointerDown"
                    @pointermove="handleCategoryPointerMove"
                    @pointerup="handleCategoryPointerUp"
                    @pointerleave="handleCategoryPointerUp"
                    @pointercancel="handleCategoryPointerUp"
                    @click.capture="handleCategoryClickCapture"
                    @wheel="handleCategoryWheel"
                    @scroll="updateCategoryScrollButtons"
                  >
                    <button
                      v-for="cat in allCategories"
                      :key="cat.key"
                      type="button"
                      class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full py-1 pl-1.5 pr-3 text-xs font-semibold transition"
                      :style="
                        categoryKey === cat.key
                          ? { backgroundColor: cat.color }
                          : undefined
                      "
                      :class="
                        categoryKey === cat.key
                          ? 'text-white shadow-xs'
                          : 'bg-slate-100 text-slate-600 dark:bg-[#2C2C2E] dark:text-slate-300'
                      "
                      @click="categoryKey = cat.key"
                    >
                      <CategoryIconBadge
                        v-if="categoryKey === cat.key"
                        :icon="cat.icon"
                        :category-key="cat.key"
                        size="xs"
                        plain
                      />
                      <CategoryIconBadge
                        v-else
                        :icon="cat.icon"
                        :category-key="cat.key"
                        :color="cat.color"
                        size="xs"
                      />
                      <span>{{ cat.label }}</span>
                    </button>
                    <button
                      type="button"
                      class="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-600"
                      @click="inlineNewCategoryOpen = !inlineNewCategoryOpen"
                    >
                      <Plus class="h-3 w-3" />
                      <span>{{ t('search.addCategoryInline') }}</span>
                    </button>
                  </div>

                  <button
                    v-if="canScrollCatRight"
                    type="button"
                    :aria-label="t('photo.next')"
                    class="hidden h-7 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 hover:text-slate-900 dark:bg-[#2C2C2E] dark:text-slate-300 sm:inline-flex"
                    @click="scrollCategoryBar('right')"
                  >
                    <ChevronRight class="h-3.5 w-3.5" />
                  </button>
                </div>
                <div v-if="inlineNewCategoryOpen" class="flex gap-1.5">
                  <input
                    v-model="inlineNewCategoryName"
                    type="text"
                    maxlength="24"
                    :placeholder="t('search.newCategoryPlaceholder')"
                    class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs dark:border-slate-700 dark:bg-[#2C2C2E] dark:text-white"
                    @keydown.enter.prevent.stop="confirmInlineAddCategory"
                  />
                  <button
                    type="button"
                    class="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white"
                    @click="confirmInlineAddCategory"
                  >
                    {{ t('settings.add') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Apple 提醒事項風格單行快捷工具列（日期時間 / 收據照片 / 退款切換，按需展開不佔位） -->
            <div class="space-y-2">
              <div class="no-scrollbar flex flex-nowrap items-center gap-2 overflow-x-auto px-0.5">
                <button
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm transition"
                  :class="
                    dateTimePanelExpanded || date !== getTodayIso() || time
                      ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                      : 'bg-white text-slate-600 dark:bg-[#1C1C1E] dark:text-slate-300'
                  "
                  @click="dateTimePanelExpanded = !dateTimePanelExpanded"
                >
                  <Calendar class="h-3.5 w-3.5" />
                  <span>{{ date === getTodayIso() && !time ? t('project.todayShort') : `${date}${time ? ` ${time}` : ''}` }}</span>
                </button>

                <button
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm transition"
                  :class="
                    photoPanelExpanded || receiptImages.length > 0
                      ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                      : 'bg-white text-slate-600 dark:bg-[#1C1C1E] dark:text-slate-300'
                  "
                  @click="photoPanelExpanded = !photoPanelExpanded"
                >
                  <Camera class="h-3.5 w-3.5" />
                  <span>
                    {{
                      receiptImages.length > 0
                        ? `${t('photo.addButton')} (${receiptImages.length})`
                        : t('photo.addButton')
                    }}
                  </span>
                </button>

                <button
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm transition"
                  :class="
                    txType === 'refund'
                      ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                      : 'bg-white text-slate-600 dark:bg-[#1C1C1E] dark:text-slate-300'
                  "
                  @click="txType = txType === 'refund' ? 'expense' : 'refund'"
                >
                  <RotateCcw class="h-3.5 w-3.5" />
                  <span>{{ t('project.typeRefund') }}</span>
                </button>
              </div>

              <!-- 展開：日期與時間 -->
              <div
                v-if="dateTimePanelExpanded"
                class="grid grid-cols-1 gap-2 rounded-2xl bg-white p-3 shadow-sm dark:bg-[#1C1C1E] sm:grid-cols-2"
              >
                <input
                  v-model="date"
                  type="date"
                  class="w-full min-w-0 rounded-xl bg-[#F2F2F7] px-3 py-2 text-xs text-slate-800 dark:bg-[#2C2C2E] dark:text-slate-200"
                />
                <div class="flex min-w-0 items-center gap-1.5">
                  <input
                    v-model="time"
                    type="time"
                    class="min-w-0 flex-1 rounded-xl bg-[#F2F2F7] px-2.5 py-2 text-xs text-slate-800 dark:bg-[#2C2C2E] dark:text-slate-200"
                  />
                  <button
                    type="button"
                    class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-xl bg-emerald-500/15 px-2.5 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
                    @click="time = getCurrentTimeHHmm()"
                  >
                    <Clock class="h-3.5 w-3.5 shrink-0" />
                    <span>{{ t('daily.useNowTime') }}</span>
                  </button>
                </div>
              </div>

              <!-- 展開：收據照片 -->
              <div
                v-if="photoPanelExpanded || receiptImages.length > 0"
                class="space-y-2 rounded-2xl bg-white p-3 shadow-sm dark:bg-[#1C1C1E]"
              >
                <div class="flex items-center justify-between">
                  <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    {{ t('photo.title') }}
                  </span>
                  <label
                    v-if="receiptImages.length < 3"
                    class="inline-flex cursor-pointer items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
                  >
                    <Camera class="h-3.5 w-3.5" />
                    <span>{{ t('photo.addButton') }}</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      class="hidden"
                      @change="handleImageFilesSelected"
                    />
                  </label>
                </div>
                <div v-if="receiptImages.length > 0" class="flex gap-2">
                  <div
                    v-for="(img, idx) in receiptImages"
                    :key="idx"
                    class="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-[#2C2C2E]"
                  >
                    <img
                      :src="img"
                      alt="receipt preview"
                      class="h-full w-full cursor-pointer object-cover"
                      @click="
                        emit('previewPhotos', { photos: receiptImages, index: idx })
                      "
                    />
                    <button
                      type="button"
                      :aria-label="t('photo.remove')"
                      class="absolute right-0.5 top-0.5 rounded-full bg-black/75 p-0.5 text-white"
                      @click="removeImage(idx)"
                    >
                      <X class="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 分組 3：誰先付與拆帳（預設精簡為 1 行視覺化摘要列，點「調整」才展開四模式面板，用 v-show 維持即時試算） -->
            <div
              class="overflow-hidden rounded-2xl border bg-white shadow-sm transition dark:bg-[#1C1C1E]"
              :class="
                splitPanelExpanded
                  ? 'border-emerald-500/40 dark:border-emerald-400/35'
                  : 'border-slate-200/80 dark:border-white/15'
              "
            >
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2.5 px-3.5 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-[#2C2C2E]"
                @click="splitPanelExpanded = !splitPanelExpanded"
              >
                <div class="flex min-w-0 flex-1 items-center gap-2.5">
                  <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    <Users class="h-4 w-4" />
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-bold text-slate-900 dark:text-white">
                      {{ t('project.splitBreakdownLabel') }}
                    </div>
                    <div class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]">
                      <!-- 墊付者小圈圈＋先付文案 -->
                      <span
                        class="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-1 pr-2 font-semibold text-slate-800 dark:bg-white/10 dark:text-slate-100"
                      >
                        <span class="inline-flex items-center -space-x-1">
                          <template
                            v-for="payer in splitSummaryMeta.payers.slice(0, 3)"
                            :key="payer.id"
                          >
                            <span
                              v-if="payer.isPool"
                              class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-teal-600 text-white ring-1 ring-white dark:ring-[#1C1C1E]"
                            >
                              <Wallet class="h-2.5 w-2.5" />
                            </span>
                            <MemberAvatar
                              v-else
                              :name="payer.name"
                              :color="payer.avatarColor"
                              :image="payer.avatarImage"
                              size="xs"
                              ring
                            />
                          </template>
                        </span>
                        <span class="truncate">{{ splitSummaryMeta.payerLabel }}</span>
                      </span>

                      <span class="text-slate-300 dark:text-slate-600">·</span>

                      <!-- 分攤方式＋均攤／分攤成員小圈圈放後面 -->
                      <span class="inline-flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-300">
                        <span>{{ splitSummaryMeta.modeLabel }}</span>
                        <span class="inline-flex items-center -space-x-1">
                          <template
                            v-for="member in splitSummaryMeta.shareMembers.slice(0, 5)"
                            :key="member.id"
                          >
                            <span
                              v-if="member.isPool"
                              class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-teal-600 text-white ring-1 ring-white dark:ring-[#1C1C1E]"
                            >
                              <Wallet class="h-2.5 w-2.5" />
                            </span>
                            <MemberAvatar
                              v-else
                              :name="member.name"
                              :color="member.avatarColor"
                              :image="member.avatarImage"
                              size="xs"
                              ring
                            />
                          </template>
                          <span
                            v-if="splitSummaryMeta.shareMembers.length > 5"
                            class="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-slate-200 px-1 text-[9px] font-bold text-slate-700 ring-1 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-[#1C1C1E]"
                          >
                            +{{ splitSummaryMeta.shareMembers.length - 5 }}
                          </span>
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
                <span class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-500/12 px-2.5 py-1 text-xs font-semibold text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                  <span>{{ splitPanelExpanded ? t('home.showLess') : t('project.adjustShort') }}</span>
                  <ChevronRight
                    class="h-3.5 w-3.5 transition-transform"
                    :class="splitPanelExpanded ? 'rotate-90' : ''"
                  />
                </span>
              </button>

              <div
                v-show="splitPanelExpanded"
                class="border-t border-slate-100 p-2 dark:border-white/10"
              >
                <QuickSplitPanel
                  :total-amount="amount ?? 0"
                  :currency="currency"
                  :members="project.members"
                  :split-groups="project.splitGroups"
                  :default-payer-id="project.defaultPayerId"
                  :initial-mode="project.defaultSplitMode"
                  :initial-split-config="splitPreset"
                  :reset-key="splitResetKey"
                  @update:split-config="splitConfig = $event"
                  @update:split-preview="splitDraftPreview = $event"
                  @validity-change="splitValid = $event"
                  @error-change="splitErrorText = $event"
                  @save-split-group="handleSaveSplitGroup"
                  @remove-split-group="handleRemoveSplitGroup"
                />
              </div>
            </div>

            <p
              v-if="errorText"
              ref="errorBoxRef"
              role="alert"
              class="rounded-2xl bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-600 dark:bg-rose-950/50 dark:text-rose-300"
            >
              {{ errorText }}
            </p>
          </form>

          <!-- Sticky 固定底部儲存按鈕列 -->
          <div
            class="safe-sticky-pb shrink-0 border-t border-black/5 bg-white/95 px-4 pt-3 backdrop-blur-md dark:border-white/10 dark:bg-[#1C1C1E]/95 sm:pb-3"
          >
            <div class="flex items-center gap-2">
              <button
                v-if="!editingTx"
                type="button"
                :disabled="isSubmitting"
                class="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-2xl bg-slate-100 px-3.5 py-3 text-xs font-bold text-slate-700 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#2C2C2E] dark:text-slate-200"
                :class="!splitValid || (amount ?? 0) <= 0 ? 'opacity-65' : ''"
                @click="handleSubmit(true)"
              >
                <Loader2 v-if="isSubmitting" class="h-3.5 w-3.5 animate-spin" />
                <span>{{ t('project.saveAndContinueButton') }}</span>
              </button>
              <button
                type="submit"
                form="project-expense-form"
                :disabled="isSubmitting"
                class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-500 dark:text-slate-950"
                :class="!splitValid || (amount ?? 0) <= 0 ? 'opacity-70' : ''"
              >
                <Loader2 v-if="isSubmitting" class="h-4 w-4 animate-spin" />
                <span>
                  {{
                    editingTx
                      ? t('project.updateExpenseButton')
                      : txType === 'refund'
                        ? t('project.saveRefundButton')
                        : t('project.saveExpenseButton')
                  }}
                </span>
                <span
                  v-if="(amount ?? 0) > 0"
                  class="tabular-nums opacity-90"
                >
                  · {{ fmt(amount ?? 0, currency) }}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
