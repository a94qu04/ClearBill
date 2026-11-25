<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Plus,
  RotateCcw,
  Users,
  Wallet,
  X,
} from 'lucide-vue-next'
import type {
  ProjectMember,
  ProjectSplitGroup,
  SplitConfig,
  SplitMode,
  SplitPayer,
} from '@/schemas/ledgerSchema'
import {
  calculateSplit,
  SplitCalculationError,
  type SplitCalculationResult,
} from '@/core/splitCalculator'
import {
  formatCurrencyAmount,
  fromMinorUnits,
  toMinorUnits,
} from '@/core/currency'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'

interface Props {
  totalAmount: number
  currency: string
  members: ProjectMember[]
  splitGroups?: ProjectSplitGroup[]
  defaultPayerId?: string
  initialMode?: SplitMode
  initialSplitConfig?: SplitConfig | null
  resetKey?: number
}

const props = withDefaults(defineProps<Props>(), {
  splitGroups: () => [],
  defaultPayerId: undefined,
  initialMode: 'equal',
  initialSplitConfig: null,
  resetKey: 0,
})

const emit = defineEmits<{
  (e: 'update:splitConfig', value: SplitConfig | null): void
  (e: 'validityChange', isValid: boolean): void
  (e: 'errorChange', message: string | null): void
  (e: 'saveSplitGroup', payload: { name: string; memberIds: string[] }): void
  (e: 'removeSplitGroup', groupId: string): void
}>()

const { t, locale } = useI18n()

const mode = ref<SplitMode>(props.initialMode)
const payerId = ref<string>(props.defaultPayerId || props.members[0]?.id || '')
const isMultiPayer = ref(false)
const multiPayerAmounts = reactive<Record<string, number | null>>({})

interface MemberRowState {
  customAmount: number | null
  isIncludedInRemainder: boolean
  weight: number
  percent: number | null
}

const memberStateMap = reactive<Record<string, MemberRowState>>({})

function initEqualPercents(): number[] {
  const nonPoolIndices = props.members
    .map((m, idx) => (!m.isPool ? idx : -1))
    .filter((idx) => idx >= 0)
  const targetIndices =
    nonPoolIndices.length > 0
      ? nonPoolIndices
      : props.members.map((_, idx) => idx)
  const n = targetIndices.length
  const list = new Array<number>(props.members.length).fill(0)
  if (n <= 0) return list
  const base = Math.floor(10000 / n) / 100
  for (const idx of targetIndices) {
    list[idx] = base
  }
  const sumOthers = Number((base * (n - 1)).toFixed(2))
  list[targetIndices[0]] = Number((100 - sumOthers).toFixed(2))
  return list
}

function applyPresetFromConfig(config: SplitConfig | null | undefined) {
  const validIds = new Set(props.members.map((m) => m.id))
  for (const existingId of Object.keys(memberStateMap)) {
    if (!validIds.has(existingId)) {
      delete memberStateMap[existingId]
    }
  }
  for (const existingId of Object.keys(multiPayerAmounts)) {
    if (!validIds.has(existingId)) {
      delete multiPayerAmounts[existingId]
    }
  }

  for (const member of props.members) {
    multiPayerAmounts[member.id] = null
  }

  const defaultPercents = initEqualPercents()

  if (config) {
    mode.value = config.mode
    payerId.value = validIds.has(config.payerId)
      ? config.payerId
      : props.defaultPayerId || props.members[0]?.id || ''

    // 還原單人或多人墊付設定
    const activePayers = (config.payers ?? []).filter(
      (p) => p.amount > 0 && validIds.has(p.memberId),
    )
    if (activePayers.length > 1) {
      isMultiPayer.value = true
      for (const p of activePayers) {
        multiPayerAmounts[p.memberId] = p.amount
      }
    } else {
      isMultiPayer.value = false
      if (activePayers.length === 1) {
        payerId.value = activePayers[0].memberId
        multiPayerAmounts[activePayers[0].memberId] = activePayers[0].amount
      }
    }

    const shareMap = new Map(config.shares.map((s) => [s.memberId, s]))

    props.members.forEach((member, idx) => {
      const savedShare = shareMap.get(member.id)
      if (!savedShare) {
        memberStateMap[member.id] = {
          customAmount: null,
          isIncludedInRemainder: false,
          weight: 0,
          percent: 0,
        }
        return
      }

      if (config.mode === 'weight') {
        const w =
          savedShare.weight !== undefined
            ? savedShare.weight
            : savedShare.finalAmount > 0
              ? 1
              : 0
        memberStateMap[member.id] = {
          customAmount: null,
          isIncludedInRemainder: w > 0,
          weight: w,
          percent: defaultPercents[idx] ?? 0,
        }
        return
      }

      if (config.mode === 'percentage') {
        const pct =
          savedShare.percent !== undefined
            ? savedShare.percent
            : defaultPercents[idx] ?? 0
        memberStateMap[member.id] = {
          customAmount: null,
          isIncludedInRemainder: pct > 0,
          weight: pct > 0 ? 1 : 0,
          percent: pct,
        }
        return
      }

      // 優先使用保存下來的原始輸入狀態，100% 精準還原修改前資料
      if (
        savedShare.customAmount !== undefined ||
        savedShare.isIncludedInRemainder !== undefined
      ) {
        memberStateMap[member.id] = {
          customAmount:
            savedShare.customAmount && savedShare.customAmount > 0
              ? savedShare.customAmount
              : null,
          isIncludedInRemainder: savedShare.isIncludedInRemainder ?? false,
          weight: savedShare.isIncludedInRemainder ? 1 : 0,
          percent: defaultPercents[idx] ?? 0,
        }
      } else if (config.mode === 'custom_plus_equal') {
        memberStateMap[member.id] = {
          customAmount: savedShare.finalAmount > 0 ? savedShare.finalAmount : null,
          isIncludedInRemainder: false,
          weight: savedShare.finalAmount > 0 ? 1 : 0,
          percent: defaultPercents[idx] ?? 0,
        }
      } else {
        memberStateMap[member.id] = {
          customAmount: null,
          isIncludedInRemainder: savedShare.finalAmount > 0,
          weight: savedShare.finalAmount > 0 ? 1 : 0,
          percent: defaultPercents[idx] ?? 0,
        }
      }
    })
    return
  }

  mode.value = props.initialMode
  isMultiPayer.value = false
  payerId.value =
    (props.defaultPayerId && validIds.has(props.defaultPayerId)
      ? props.defaultPayerId
      : props.members[0]?.id) ?? ''

  const hasNonPoolMember = props.members.some((m) => !m.isPool)
  props.members.forEach((member, idx) => {
    // 公費袋虛擬成員預設不參與分攤消費（只當墊付人／收款池），若真需要仍可手動勾選
    const defaultIncluded = hasNonPoolMember ? !member.isPool : true
    memberStateMap[member.id] = {
      customAmount: null,
      isIncludedInRemainder: defaultIncluded,
      weight: defaultIncluded ? 1 : 0,
      percent: defaultPercents[idx] ?? 0,
    }
  })
}

// 僅於成員 ID 結構真正異動、preset 切換或外部重設時才重套拆帳預設；避免儲存／刪除子群組更新專案物件時洗掉使用者剛勾選的成員
const memberIdsSignature = computed(() =>
  props.members.map((m) => m.id).join(','),
)

watch(
  () => [memberIdsSignature.value, props.initialSplitConfig, props.resetKey] as const,
  ([, nextConfig]) => {
    applyPresetFromConfig(nextConfig)
  },
  { immediate: true, deep: true },
)

const normalizedTotal = computed(() =>
  Number.isFinite(props.totalAmount) && props.totalAmount > 0
    ? props.totalAmount
    : 0,
)

function toggleMultiPayerMode() {
  isMultiPayer.value = !isMultiPayer.value
  if (isMultiPayer.value) {
    const hasAnyAmount = props.members.some(
      (m) => (multiPayerAmounts[m.id] ?? 0) > 0,
    )
    if (!hasAnyAmount && payerId.value && normalizedTotal.value > 0) {
      multiPayerAmounts[payerId.value] = normalizedTotal.value
    }
  } else {
    // 切回單人墊付時自動以墊付金額最高者作為主墊付人
    const topPayer = props.members
      .map((m) => ({ id: m.id, amt: multiPayerAmounts[m.id] ?? 0 }))
      .sort((a, b) => b.amt - a.amt)[0]
    if (topPayer && topPayer.amt > 0) {
      payerId.value = topPayer.id
    }
  }
}

function fillRemainingToPayer(memberId: string) {
  if (normalizedTotal.value <= 0) return
  const totalUnits = toMinorUnits(normalizedTotal.value, props.currency)
  let othersUnits = 0
  for (const member of props.members) {
    if (member.id === memberId) continue
    const val = multiPayerAmounts[member.id] ?? 0
    if (val > 0) {
      othersUnits += toMinorUnits(val, props.currency)
    }
  }
  const remainUnits = Math.max(0, totalUnits - othersUnits)
  multiPayerAmounts[memberId] =
    remainUnits > 0 ? fromMinorUnits(remainUnits, props.currency) : null
}

function resetAllSharesToEqual() {
  const eqPercents = initEqualPercents()
  const hasNonPoolMember = props.members.some((m) => !m.isPool)
  props.members.forEach((member, idx) => {
    const defaultIncluded = hasNonPoolMember ? !member.isPool : true
    memberStateMap[member.id] = {
      customAmount: null,
      isIncludedInRemainder: defaultIncluded,
      weight: defaultIncluded ? 1 : 0,
      percent: eqPercents[idx] ?? 0,
    }
  })
}

// 大團一鍵快選與常用子群組操作
const saveGroupInputOpen = ref(false)
const newGroupName = ref('')
const newGroupInputRef = ref<HTMLInputElement | null>(null)

function toggleSaveGroupInput() {
  saveGroupInputOpen.value = !saveGroupInputOpen.value
  if (saveGroupInputOpen.value) {
    void nextTick(() => {
      newGroupInputRef.value?.focus()
    })
  }
}

const nonPoolMembers = computed(() =>
  props.members.filter((m) => !m.isPool),
)

const selectedSplitMemberIds = computed<string[]>(() =>
  props.members
    .filter((m) => {
      const st = memberStateMap[m.id]
      if (!st) return false
      if (mode.value === 'weight') return st.weight > 0
      if (mode.value === 'percentage') return (st.percent ?? 0) > 0
      return st.isIncludedInRemainder
    })
    .map((m) => m.id),
)

function applyMemberSelection(targetIds: Set<string>) {
  if (mode.value === 'weight') {
    for (const m of props.members) {
      const st = memberStateMap[m.id]
      if (!st) continue
      const on = targetIds.has(m.id)
      st.weight = on ? (st.weight > 0 ? st.weight : 1) : 0
      st.isIncludedInRemainder = on
    }
    return
  }
  if (mode.value === 'percentage') {
    const chosen = props.members.filter((m) => targetIds.has(m.id))
    const n = chosen.length
    const base = n > 0 ? Math.floor(10000 / n) / 100 : 0
    const firstPct = n > 0 ? Number((100 - Number((base * (n - 1)).toFixed(2))).toFixed(2)) : 0
    let seenFirst = false
    for (const m of props.members) {
      const st = memberStateMap[m.id]
      if (!st) continue
      if (targetIds.has(m.id)) {
        st.percent = !seenFirst ? firstPct : base
        seenFirst = true
        st.isIncludedInRemainder = true
      } else {
        st.percent = 0
        st.isIncludedInRemainder = false
      }
    }
    return
  }
  for (const m of props.members) {
    const st = memberStateMap[m.id]
    if (!st) continue
    st.isIncludedInRemainder = targetIds.has(m.id)
  }
}

function selectAllMembers() {
  const pool = nonPoolMembers.value.length > 0 ? nonPoolMembers.value : props.members
  applyMemberSelection(new Set(pool.map((m) => m.id)))
}

function selectNoneMembers() {
  applyMemberSelection(new Set())
}

function invertSelectedMembers() {
  const current = new Set(selectedSplitMemberIds.value)
  const pool = nonPoolMembers.value.length > 0 ? nonPoolMembers.value : props.members
  const inverted = new Set(pool.filter((m) => !current.has(m.id)).map((m) => m.id))
  applyMemberSelection(inverted)
}

function selectOnlyPayer() {
  if (isMultiPayer.value) {
    const ids = new Set(
      props.members
        .filter((m) => (multiPayerAmounts[m.id] ?? 0) > 0)
        .map((m) => m.id),
    )
    if (ids.size > 0) applyMemberSelection(ids)
    return
  }
  if (payerId.value) {
    applyMemberSelection(new Set([payerId.value]))
  }
}

function applySplitGroup(group: ProjectSplitGroup) {
  applyMemberSelection(new Set(group.memberIds))
}

function isGroupActive(group: ProjectSplitGroup): boolean {
  const current = new Set(selectedSplitMemberIds.value)
  const validGroupIds = group.memberIds.filter((id) =>
    props.members.some((m) => m.id === id),
  )
  if (validGroupIds.length === 0 || current.size !== validGroupIds.length) {
    return false
  }
  return validGroupIds.every((id) => current.has(id))
}

function confirmSaveCurrentAsGroup() {
  const trimmed = newGroupName.value.trim()
  if (!trimmed || selectedSplitMemberIds.value.length === 0) return
  emit('saveSplitGroup', {
    name: trimmed,
    memberIds: [...selectedSplitMemberIds.value],
  })
  newGroupName.value = ''
  saveGroupInputOpen.value = false
}

function stepMemberWeight(memberId: string, delta: number) {
  const state = memberStateMap[memberId]
  if (!state) return
  const next = Math.max(0, Number(((state.weight ?? 0) + delta).toFixed(2)))
  state.weight = next
  state.isIncludedInRemainder = next > 0
}

function handleSwitchMode(nextMode: SplitMode) {
  mode.value = nextMode
  if (nextMode === 'equal') {
    const anyChecked = props.members.some(
      (m) => memberStateMap[m.id]?.isIncludedInRemainder,
    )
    if (!anyChecked) {
      for (const member of props.members) {
        if (memberStateMap[member.id]) {
          memberStateMap[member.id].isIncludedInRemainder = true
        }
      }
    }
  } else if (nextMode === 'weight') {
    const totalW = props.members.reduce(
      (sum, m) => sum + (memberStateMap[m.id]?.weight ?? 0),
      0,
    )
    if (totalW <= 0) {
      for (const member of props.members) {
        if (memberStateMap[member.id]) {
          memberStateMap[member.id].weight = 1
          memberStateMap[member.id].isIncludedInRemainder = true
        }
      }
    }
  } else if (nextMode === 'percentage') {
    const totalPct = props.members.reduce(
      (sum, m) => sum + (memberStateMap[m.id]?.percent ?? 0),
      0,
    )
    if (totalPct <= 0) {
      const eqPercents = initEqualPercents()
      props.members.forEach((member, idx) => {
        if (memberStateMap[member.id]) {
          memberStateMap[member.id].percent = eqPercents[idx] ?? 0
        }
      })
    }
  }
}

const multiPayerCheck = computed(() => {
  if (!isMultiPayer.value) {
    return {
      isValid: Boolean(payerId.value),
      paidTotal: normalizedTotal.value,
      diff: 0,
      payers: [] as SplitPayer[],
    }
  }

  const totalUnits = toMinorUnits(normalizedTotal.value, props.currency)
  let paidUnits = 0
  const payers: SplitPayer[] = []

  for (const member of props.members) {
    const raw = multiPayerAmounts[member.id] ?? 0
    if (raw > 0) {
      const units = toMinorUnits(raw, props.currency)
      paidUnits += units
      payers.push({
        memberId: member.id,
        amount: fromMinorUnits(units, props.currency),
      })
    }
  }

  const diffUnits = totalUnits - paidUnits
  return {
    isValid: totalUnits > 0 && diffUnits === 0 && payers.length > 0,
    paidTotal: fromMinorUnits(paidUnits, props.currency),
    diff: fromMinorUnits(diffUnits, props.currency),
    payers,
  }
})

interface EvaluationState {
  result: SplitCalculationResult | null
  errorCode: string | null
  unallocatedRemainder: number
}

const evaluation = computed<EvaluationState>(() => {
  if (props.members.length === 0) {
    return { result: null, errorCode: null, unallocatedRemainder: 0 }
  }

  const inputs = props.members.map((member) => {
    const state = memberStateMap[member.id] ?? {
      customAmount: null,
      isIncludedInRemainder: true,
      weight: 1,
      percent: 0,
    }
    return {
      memberId: member.id,
      customAmount:
        state.customAmount !== null && state.customAmount > 0
          ? state.customAmount
          : 0,
      isIncludedInRemainder: state.isIncludedInRemainder,
      weight: Number.isFinite(state.weight) && state.weight >= 0 ? state.weight : 0,
      percent:
        state.percent !== null && Number.isFinite(state.percent) && state.percent >= 0
          ? state.percent
          : 0,
    }
  })

  try {
    const result = calculateSplit({
      totalAmount: normalizedTotal.value,
      currency: props.currency,
      mode: mode.value,
      members: inputs,
    })
    return { result, errorCode: null, unallocatedRemainder: 0 }
  } catch (error) {
    if (error instanceof SplitCalculationError) {
      const customSum =
        mode.value === 'custom_plus_equal'
          ? inputs.reduce((acc, m) => acc + m.customAmount, 0)
          : 0
      return {
        result: null,
        errorCode: error.code,
        unallocatedRemainder: Math.max(0, normalizedTotal.value - customSum),
      }
    }
    return {
      result: null,
      errorCode: 'ERR_INVALID_TOTAL_AMOUNT',
      unallocatedRemainder: 0,
    }
  }
})

const currentPercentTotal = computed(() =>
  Number(
    props.members
      .reduce((acc, m) => acc + Math.max(0, Number(memberStateMap[m.id]?.percent ?? 0)), 0)
      .toFixed(2),
  ),
)

const shareByMemberId = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  if (!evaluation.value.result) return map
  for (const share of evaluation.value.result.shares) {
    map[share.memberId] = share.finalAmount
  }
  return map
})

function fmt(amount: number): string {
  return formatCurrencyAmount(amount, props.currency, locale.value)
}

const dynamicHint = computed<{
  tone: 'info' | 'success' | 'error'
  text: string
}>(() => {
  if (normalizedTotal.value <= 0) {
    return {
      tone: 'info',
      text: t('split.hintZeroTotal'),
    }
  }

  if (isMultiPayer.value && !multiPayerCheck.value.isValid) {
    if (multiPayerCheck.value.diff > 0) {
      return {
        tone: 'error',
        text: t('split.errMultiPayerShort', {
          diff: fmt(multiPayerCheck.value.diff),
        }),
      }
    }
    return {
      tone: 'error',
      text: t('split.errMultiPayerExceed', {
        diff: fmt(Math.abs(multiPayerCheck.value.diff)),
      }),
    }
  }

  if (evaluation.value.errorCode === 'ERR_CUSTOM_EXCEEDS_TOTAL') {
    return {
      tone: 'error',
      text: t('split.errCustomExceedsTotal'),
    }
  }

  if (evaluation.value.errorCode === 'ERR_UNALLOCATED_REMAINDER') {
    return {
      tone: 'error',
      text: t('split.errUnallocatedRemainder', {
        remainder: fmt(evaluation.value.unallocatedRemainder),
      }),
    }
  }

  if (evaluation.value.errorCode === 'ERR_INVALID_WEIGHTS') {
    return {
      tone: 'error',
      text: t('split.errInvalidWeights'),
    }
  }

  if (evaluation.value.errorCode === 'ERR_PERCENT_TOTAL_INVALID') {
    return {
      tone: 'error',
      text: t('split.errPercentTotal', { total: currentPercentTotal.value }),
    }
  }

  if (evaluation.value.errorCode) {
    return {
      tone: 'error',
      text: t('split.errInvalidAmount'),
    }
  }

  const res = evaluation.value.result
  if (!res) {
    return { tone: 'info', text: t('split.hintZeroTotal') }
  }

  if (res.mode === 'equal') {
    return {
      tone: 'success',
      text: t('split.hintEqual', {
        total: fmt(res.totalAmount),
        count: res.remainderMemberCount,
        perPerson: fmt(res.remainderBasePerMember),
      }),
    }
  }

  if (res.mode === 'weight') {
    return {
      tone: 'success',
      text: t('split.hintWeight', {
        total: fmt(res.totalAmount),
        totalWeight: res.totalWeight ?? 0,
        perWeight: fmt(res.remainderBasePerMember),
      }),
    }
  }

  if (res.mode === 'percentage') {
    return {
      tone: 'success',
      text: t('split.hintPercent', {
        total: fmt(res.totalAmount),
      }),
    }
  }

  if (res.remainderPool === 0) {
    return {
      tone: 'success',
      text: t('split.hintCustomExact', {
        total: fmt(res.totalAmount),
      }),
    }
  }

  return {
    tone: 'success',
    text: t('split.hintCustomRemaining', {
      customTotal: fmt(res.customTotal),
      remainder: fmt(res.remainderPool),
      count: res.remainderMemberCount,
      perPerson: fmt(res.remainderBasePerMember),
    }),
  }
})

watch(
  [evaluation, payerId, isMultiPayer, multiPayerCheck, mode, normalizedTotal, dynamicHint],
  () => {
    const res = evaluation.value.result
    const payerReady = isMultiPayer.value
      ? multiPayerCheck.value.isValid
      : Boolean(payerId.value)

    emit(
      'errorChange',
      dynamicHint.value.tone === 'error' ? dynamicHint.value.text : null,
    )

    if (!res || !payerReady || normalizedTotal.value <= 0) {
      emit('update:splitConfig', null)
      emit('validityChange', false)
      return
    }

    const primaryPayerId = isMultiPayer.value
      ? multiPayerCheck.value.payers[0].memberId
      : payerId.value

    const config: SplitConfig = {
      payerId: primaryPayerId,
      payers: isMultiPayer.value ? multiPayerCheck.value.payers : undefined,
      mode: mode.value,
      shares: res.shares.map((share) => ({
        memberId: share.memberId,
        finalAmount: share.finalAmount,
        customAmount: share.customAmount,
        isIncludedInRemainder: share.isIncludedInRemainder,
        ...(share.weight !== undefined ? { weight: share.weight } : {}),
        ...(share.percent !== undefined ? { percent: share.percent } : {}),
      })),
    }
    emit('update:splitConfig', config)
    emit('validityChange', true)
  },
  { immediate: true },
)
</script>

<template>
  <section
    class="rounded-2xl border border-slate-200 bg-white p-4 transition-colors dark:border-slate-800 dark:bg-slate-900"
  >
    <!-- 付款人區塊（支援單人快選與多人墊付切換） -->
    <div class="mb-3.5 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">
          <Users class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          <span>{{ t('split.payerLabel') }}</span>
        </div>

        <button
          type="button"
          class="rounded-lg px-2.5 py-1 text-xs font-semibold transition"
          :class="
            isMultiPayer
              ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
          "
          @click="toggleMultiPayerMode"
        >
          {{ isMultiPayer ? t('split.singlePayerMode') : t('split.multiPayerMode') }}
        </button>
      </div>

      <!-- 單人墊付膠囊（6 人以上於手機採單行橫向滑動省高度，平板以上展開） -->
      <div
        v-if="!isMultiPayer"
        class="flex items-center gap-1.5"
        :class="
          members.length >= 6
            ? 'no-scrollbar flex-nowrap overflow-x-auto pb-0.5 sm:flex-wrap'
            : 'flex-wrap'
        "
      >
        <button
          v-for="member in members"
          :key="member.id"
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full py-1 pl-1.5 pr-3 text-xs font-semibold transition"
          :class="
            payerId === member.id
              ? 'text-white shadow-sm ring-2 ring-offset-1 ring-slate-900/20 dark:ring-white/30 dark:ring-offset-slate-900'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
          "
          :style="
            payerId === member.id
              ? { backgroundColor: member.avatarColor || '#0f172a' }
              : undefined
          "
          @click="payerId = member.id"
        >
          <Wallet v-if="member.isPool" class="h-3.5 w-3.5 shrink-0" />
          <MemberAvatar
            v-else
            :name="member.name"
            :color="member.avatarColor"
            :image="member.avatarImage"
            size="xxs"
            ring
          />
          <span>{{ member.name }}</span>
        </button>
      </div>

      <!-- 多人墊付金額輸入列（同步顯示每位成員專屬色標） -->
      <div
        v-else
        class="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/50"
      >
        <div class="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400">
          <span>{{ t('split.multiPayerHint') }}</span>
          <span class="tabular-nums font-semibold">
            {{ fmt(multiPayerCheck.paidTotal) }} / {{ fmt(normalizedTotal) }}
          </span>
        </div>

        <div
          v-for="member in members"
          :key="`payer-${member.id}`"
          class="flex items-center justify-between gap-2"
        >
          <div class="flex min-w-[76px] items-center gap-1.5">
            <span
              class="h-2.5 w-2.5 shrink-0 rounded-full"
              :style="{ backgroundColor: member.avatarColor || '#10b981' }"
            />
            <span class="truncate text-xs font-medium text-slate-700 dark:text-slate-200">
              {{ member.name }}
            </span>
          </div>
          <div class="flex items-center gap-1.5">
            <CurrencyAmountInput
              v-model="multiPayerAmounts[member.id]"
              :currency="currency"
              enable-expression
              size="sm"
              placeholder="0"
              class="w-28"
            />
            <button
              type="button"
              class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="fillRemainingToPayer(member.id)"
            >
              {{ t('split.fillRemaining') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 四模式頁籤切換：均攤 / 指定+均攤 / 份數比例 / 百分比 -->
    <div class="mb-3 flex items-center gap-1.5">
      <div
        role="tablist"
        class="grid flex-1 grid-cols-4 gap-0.5 rounded-xl bg-slate-100 p-1 dark:bg-slate-800"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'equal'"
          class="truncate rounded-lg px-1.5 py-1.5 text-[11px] font-semibold transition"
          :class="
            mode === 'equal'
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          "
          @click="handleSwitchMode('equal')"
        >
          {{ t('split.tabEqualShort') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'custom_plus_equal'"
          class="truncate rounded-lg px-1.5 py-1.5 text-[11px] font-semibold transition"
          :class="
            mode === 'custom_plus_equal'
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          "
          @click="handleSwitchMode('custom_plus_equal')"
        >
          {{ t('split.tabCustomShort') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'weight'"
          class="truncate rounded-lg px-1.5 py-1.5 text-[11px] font-semibold transition"
          :class="
            mode === 'weight'
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          "
          @click="handleSwitchMode('weight')"
        >
          {{ t('split.tabWeightShort') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'percentage'"
          class="truncate rounded-lg px-1.5 py-1.5 text-[11px] font-semibold transition"
          :class="
            mode === 'percentage'
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          "
          @click="handleSwitchMode('percentage')"
        >
          {{ t('split.tabPercentShort') }}
        </button>
      </div>

      <button
        v-if="mode !== 'equal'"
        type="button"
        :title="t('split.resetShares')"
        class="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        @click="resetAllSharesToEqual"
      >
        <RotateCcw class="h-3.5 w-3.5" />
      </button>
    </div>

    <!-- 動態白話提示橫幅 -->
    <div
      class="mb-3 flex items-start gap-2 rounded-xl px-3 py-2 text-xs leading-relaxed"
      :class="{
        'border border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300':
          dynamicHint.tone === 'info',
        'border border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/50 dark:text-emerald-200':
          dynamicHint.tone === 'success',
        'border border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800/70 dark:bg-rose-950/50 dark:text-rose-200':
          dynamicHint.tone === 'error',
      }"
    >
      <Info
        v-if="dynamicHint.tone === 'info'"
        class="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500"
      />
      <CheckCircle2
        v-else-if="dynamicHint.tone === 'success'"
        class="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
      />
      <AlertCircle
        v-else
        class="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400"
      />
      <p>{{ dynamicHint.text }}</p>
    </div>

    <!-- 大團一鍵快選與常用子群組工具列（採自動換行呈現，已存群組與「+ 存群組」於電腦與手機皆完整可見不裁切） -->
    <div v-if="members.length >= 2" class="mb-2.5 space-y-2">
      <div class="flex flex-wrap items-center gap-1.5">
        <span
          class="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400"
        >
          {{ selectedSplitMemberIds.length }}/{{ nonPoolMembers.length || members.length }}
        </span>
        <button
          type="button"
          class="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          @click="selectAllMembers"
        >
          {{ t('split.quickSelectAll') }}
        </button>
        <button
          type="button"
          class="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          @click="selectNoneMembers"
        >
          {{ t('split.quickSelectNone') }}
        </button>
        <button
          type="button"
          class="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          @click="invertSelectedMembers"
        >
          {{ t('split.quickSelectInvert') }}
        </button>
        <button
          type="button"
          class="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          @click="selectOnlyPayer"
        >
          {{ t('split.quickSelectPayerOnly') }}
        </button>

        <!-- 選取至少一位成員即可將目前名單存為常用子群組 -->
        <button
          v-if="selectedSplitMemberIds.length >= 1"
          type="button"
          class="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border border-dashed border-emerald-400 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-600 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
          @click="toggleSaveGroupInput"
        >
          <Plus class="h-3 w-3 shrink-0" />
          <span>{{ t('split.saveAsGroupButton') }}</span>
        </button>
      </div>

      <!-- 已存常用拆帳子群組膠囊列（獨立呈現，存完立即顯眼可見） -->
      <div v-if="splitGroups.length > 0" class="flex flex-wrap items-center gap-1.5">
        <span
          v-for="grp in splitGroups"
          :key="grp.id"
          class="inline-flex shrink-0 items-center overflow-hidden rounded-full border text-[11px] font-semibold transition"
          :class="
            isGroupActive(grp)
              ? 'border-emerald-500 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-500 dark:text-slate-950'
              : 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-300'
          "
        >
          <button
            type="button"
            class="whitespace-nowrap py-0.5 pl-2.5 pr-1"
            @click="applySplitGroup(grp)"
          >
            {{ grp.name }} ({{ grp.memberIds.length }})
          </button>
          <button
            type="button"
            :aria-label="t('home.deleteTx')"
            class="px-1.5 py-0.5 opacity-70 hover:opacity-100"
            @click.stop="emit('removeSplitGroup', grp.id)"
          >
            <X class="h-2.5 w-2.5" />
          </button>
        </span>
      </div>

      <div
        v-if="saveGroupInputOpen"
        class="flex items-center gap-1.5 rounded-xl bg-slate-50 p-1.5 dark:bg-slate-800/70"
      >
        <input
          ref="newGroupInputRef"
          v-model="newGroupName"
          type="text"
          maxlength="24"
          :placeholder="t('split.groupNamePlaceholder')"
          class="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          @keydown.enter.prevent.stop="confirmSaveCurrentAsGroup"
        />
        <button
          type="button"
          :disabled="!newGroupName.trim() || selectedSplitMemberIds.length === 0"
          class="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white disabled:opacity-40 dark:bg-emerald-500 dark:text-slate-950"
          @click="confirmSaveCurrentAsGroup"
        >
          {{ t('daily.saveButton') }}
        </button>
        <button
          type="button"
          class="shrink-0 rounded-lg p-1 text-slate-400 hover:text-slate-600"
          @click="saveGroupInputOpen = false"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <!-- 成員分攤清單（改用真實頭像 MemberAvatar ＋ 緊湊單列防爆版） -->
    <ul class="divide-y divide-slate-100 dark:divide-slate-800">
      <li
        v-for="member in members"
        :key="member.id"
        class="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-1 last:pb-0"
      >
        <div class="flex min-w-0 max-w-[140px] items-center gap-2 sm:max-w-[180px]">
          <span
            v-if="member.isPool"
            class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-700 text-white"
          >
            <Wallet class="h-3.5 w-3.5" />
          </span>
          <MemberAvatar
            v-else
            :name="member.name"
            :color="member.avatarColor"
            :image="member.avatarImage"
            size="xs"
          />
          <span class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
            {{ member.name }}
          </span>
        </div>

        <div class="flex flex-1 flex-wrap items-center justify-end gap-2">
          <!-- 指定金額外均攤模式 -->
          <CurrencyAmountInput
            v-if="mode === 'custom_plus_equal'"
            v-model="memberStateMap[member.id].customAmount"
            :currency="currency"
            enable-expression
            size="sm"
            :placeholder="t('split.customAmountPlaceholder')"
            class="w-28 sm:w-32"
          />

          <!-- 份數比例模式（可按 - / + 步進 0.5 或直接輸入份數） -->
          <div
            v-else-if="mode === 'weight'"
            class="inline-flex items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800"
          >
            <button
              type="button"
              class="px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="stepMemberWeight(member.id, -0.5)"
            >
              −
            </button>
            <input
              v-model.number="memberStateMap[member.id].weight"
              type="number"
              min="0"
              step="0.5"
              inputmode="decimal"
              class="w-16 bg-white py-1 text-center text-xs font-bold tabular-nums text-slate-900 focus:outline-none dark:bg-slate-900 dark:text-white sm:w-12"
            />
            <button
              type="button"
              class="px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="stepMemberWeight(member.id, 0.5)"
            >
              +
            </button>
          </div>

          <!-- 百分比模式 -->
          <div
            v-else-if="mode === 'percentage'"
            class="inline-flex items-center overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
          >
            <input
              v-model.number="memberStateMap[member.id].percent"
              type="number"
              min="0"
              max="100"
              step="any"
              inputmode="decimal"
              class="w-20 bg-transparent px-2 py-1 text-right text-xs font-bold tabular-nums text-slate-900 focus:outline-none dark:bg-slate-900 dark:text-white sm:w-16"
            />
            <span class="pr-2 text-[11px] font-bold text-slate-400">%</span>
          </div>

          <label
            v-if="mode === 'equal' || mode === 'custom_plus_equal'"
            class="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition"
            :class="
              memberStateMap[member.id].isIncludedInRemainder
                ? 'border-emerald-300 bg-emerald-50/70 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200'
                : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
            "
          >
            <input
              v-model="memberStateMap[member.id].isIncludedInRemainder"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800"
            />
            <span>{{
              mode === 'equal'
                ? t('split.includeInEqual')
                : t('split.includeInRemainder')
            }}</span>
          </label>

          <div class="min-w-[74px] text-right text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {{ fmt(shareByMemberId[member.id] ?? 0) }}
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
