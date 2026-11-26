<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Wallet, X } from 'lucide-vue-next'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useModalLayer } from '@/composables/useModalLayer'
import { getTodayIso } from '@/core/ledgerHelpers'
import { isPoolMemberIdInProject } from '@/core/poolFund'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'
import EntryModeSelector, { type EntryMode } from '@/components/EntryModeSelector.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'
import MoneyText from '@/components/MoneyText.vue'

interface Props {
  open: boolean
  project: Project | null
  editingTx?: Transaction | null
}

const props = withDefaults(defineProps<Props>(), {
  editingTx: null,
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', message: string): void
  (e: 'switchEntryMode', mode: EntryMode): void
}>()

const { t } = useI18n()
const store = useLedgerStore()

const dialogRef = ref<HTMLElement | null>(null)

useModalLayer(
  () => Boolean(props.open && props.project),
  () => emit('close'),
  dialogRef,
)

const collectorMode = ref<'pool' | 'member'>('pool')
const customPoolName = ref('')
const selectedCollectorMemberId = ref('')
const selectedContributorIds = ref<string[]>([])
const amountPerMember = ref<number | null>(null)
const currency = ref('TWD')
const exchangeRate = ref<number | null>(1)
const exchangeRateSource = ref<
  'same' | 'live' | 'remembered' | 'estimated' | 'saved' | 'missing'
>('same')
const date = ref(getTodayIso())
const note = ref('')
const errorText = ref('')
const isSubmitting = ref(false)

const existingPoolMember = computed(
  () => props.project?.members.find((m) => m.isPool) ?? null,
)

const humanMembers = computed(
  () => props.project?.members.filter((m) => !m.isPool) ?? [],
)

const currencyOptions = computed<string[]>(() => {
  const set = new Set<string>(store.availableCurrencies)
  if (props.project?.baseCurrency) set.add(props.project.baseCurrency.trim().toUpperCase())
  if (currency.value) set.add(currency.value.trim().toUpperCase())
  return Array.from(set)
})

const needsExchangeRate = computed(() => {
  if (!props.project) return false
  return currency.value.trim().toUpperCase() !== props.project.baseCurrency.trim().toUpperCase()
})

const eligibleContributors = computed(() => {
  if (collectorMode.value === 'pool') {
    return humanMembers.value
  }
  return humanMembers.value.filter((m) => m.id !== selectedCollectorMemberId.value)
})

const totalCollectedPreview = computed(() => {
  const amt = amountPerMember.value ?? 0
  if (amt <= 0 || selectedContributorIds.value.length === 0) return 0
  return amt * selectedContributorIds.value.length
})

function handleEntryModeSelect(mode: EntryMode) {
  if (mode === 'pool') return
  emit('switchEntryMode', mode)
}

function syncDefaultContributors() {
  selectedContributorIds.value = eligibleContributors.value.map((m) => m.id)
}

watch(
  () => [props.open, props.project?.id, props.editingTx?.id] as const,
  ([isOpen]) => {
    if (!isOpen || !props.project) return
    errorText.value = ''

    const editTx = props.editingTx
    if (editTx && editTx.splitConfig) {
      const toId = editTx.splitConfig.shares[0]?.memberId ?? ''
      const toMember = props.project.members.find((m) => m.id === toId)
      const isPoolTarget = isPoolMemberIdInProject(toId, props.project)
      collectorMode.value = isPoolTarget ? 'pool' : 'member'
      customPoolName.value =
        (isPoolTarget ? toMember?.name : existingPoolMember.value?.name) ||
        t('pool.defaultName')
      selectedCollectorMemberId.value = isPoolTarget
        ? props.project.syncMeta?.myMemberId ||
          props.project.defaultPayerId ||
          humanMembers.value[0]?.id ||
          ''
        : toId || humanMembers.value[0]?.id || ''

      const activePayers = (editTx.splitConfig.payers ?? []).filter(
        (p) => p.amount > 0,
      )
      const payerIds =
        activePayers.length > 0
          ? activePayers.map((p) => p.memberId)
          : [editTx.splitConfig.payerId]
      const validSet = new Set(eligibleContributors.value.map((m) => m.id))
      const matchedIds = payerIds.filter((id) => validSet.has(id))
      selectedContributorIds.value =
        matchedIds.length > 0
          ? matchedIds
          : eligibleContributors.value.map((m) => m.id)

      amountPerMember.value =
        activePayers.length > 0
          ? activePayers[0].amount
          : editTx.amount / Math.max(1, selectedContributorIds.value.length)
      currency.value = editTx.currency.trim().toUpperCase()
      if (currency.value === props.project.baseCurrency.trim().toUpperCase()) {
        exchangeRate.value = 1
        exchangeRateSource.value = 'same'
      } else if (editTx.exchangeRateToBase > 0) {
        exchangeRate.value = editTx.exchangeRateToBase
        exchangeRateSource.value = 'saved'
      } else {
        const resolved = store.getEffectiveExchangeRateWithSource(
          currency.value,
          props.project.baseCurrency,
        )
        exchangeRate.value = resolved.rate
        exchangeRateSource.value = resolved.source
      }
      date.value = editTx.date || getTodayIso()
      note.value = editTx.note ?? t('pool.defaultNote')
      return
    }

    collectorMode.value = 'pool'
    customPoolName.value = existingPoolMember.value?.name || t('pool.defaultName')
    selectedCollectorMemberId.value =
      props.project.syncMeta?.myMemberId ||
      props.project.defaultPayerId ||
      humanMembers.value[0]?.id ||
      ''
    currency.value = store.getProjectLastCurrency(
      props.project.id,
      props.project.baseCurrency,
    )
    if (currency.value === props.project.baseCurrency.trim().toUpperCase()) {
      exchangeRate.value = 1
      exchangeRateSource.value = 'same'
    } else {
      const resolved = store.getEffectiveExchangeRateWithSource(
        currency.value,
        props.project.baseCurrency,
      )
      exchangeRate.value = resolved.rate
      exchangeRateSource.value = resolved.source
    }
    amountPerMember.value = null
    date.value = getTodayIso()
    note.value = t('pool.defaultNote')
    syncDefaultContributors()
  },
  { immediate: true },
)

watch([collectorMode, selectedCollectorMemberId], () => {
  const allowed = new Set(eligibleContributors.value.map((m) => m.id))
  const kept = selectedContributorIds.value.filter((id) => allowed.has(id))
  selectedContributorIds.value =
    kept.length > 0 ? kept : eligibleContributors.value.map((m) => m.id)
})

/** 僅由使用者主動切換幣別時更新匯率，避免開啟編輯歷史公費帳目時覆寫原始匯率 */
function handleUserCurrencyChange(nextCur: string) {
  const cur = nextCur.trim().toUpperCase()
  if (!cur || !props.project) return
  if (currency.value === cur) return
  currency.value = cur
  const base = props.project.baseCurrency.trim().toUpperCase()
  if (cur === base) {
    exchangeRate.value = 1
    exchangeRateSource.value = 'same'
  } else {
    const resolved = store.getEffectiveExchangeRateWithSource(cur, base)
    exchangeRate.value = resolved.rate
    exchangeRateSource.value = resolved.source
  }
}

function toggleContributor(memberId: string) {
  if (selectedContributorIds.value.includes(memberId)) {
    selectedContributorIds.value = selectedContributorIds.value.filter(
      (id) => id !== memberId,
    )
  } else {
    selectedContributorIds.value = [...selectedContributorIds.value, memberId]
  }
}

async function handleSubmit() {
  if (!props.project || isSubmitting.value) return
  errorText.value = ''

  const amt = amountPerMember.value ?? 0
  if (amt <= 0) {
    errorText.value = t('validation.amountRequired')
    return
  }
  if (selectedContributorIds.value.length === 0) {
    errorText.value = t('pool.errNoContributors')
    return
  }
  const rate = needsExchangeRate.value ? (exchangeRate.value ?? 0) : 1
  if (needsExchangeRate.value && rate <= 0) {
    errorText.value = t('validation.exchangeRateRequired')
    return
  }

  isSubmitting.value = true
  try {
    let collectorId = selectedCollectorMemberId.value
    if (collectorMode.value === 'pool') {
      const poolMember = await store.ensureProjectPoolMember(
        props.project.id,
        customPoolName.value || t('pool.defaultName'),
      )
      if (!poolMember) {
        errorText.value = t('home.saveFailed')
        return
      }
      collectorId = poolMember.id
    }

    if (!collectorId) {
      errorText.value = t('home.saveFailed')
      return
    }

    const count = await store.batchCollectPoolFund({
      projectId: props.project.id,
      collectorMemberId: collectorId,
      contributorMemberIds: selectedContributorIds.value,
      amountPerMember: amt,
      currency: currency.value,
      exchangeRateToBase: rate,
      date: date.value || getTodayIso(),
      note: note.value.trim() || t('pool.defaultNote'),
      editingTxId: props.editingTx?.id,
    })

    if (count > 0) {
      emit(
        'saved',
        props.editingTx
          ? t('daily.updatedToast')
          : t('pool.collectedToast', { count }),
      )
      emit('close')
    }
  } catch {
    errorText.value = t('home.saveFailed')
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && project"
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      :aria-label="t('pool.modalTitle')"
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
      @click.self="emit('close')"
    >
      <div
        class="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl"
      >
        <!-- Sticky 頂部標題列 -->
        <div
          class="relative z-20 flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3.5 dark:border-slate-800"
        >
          <div v-if="editingTx" class="flex items-center gap-2">
            <span
              class="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-teal-50 text-teal-700 dark:bg-teal-950/70 dark:text-teal-300"
            >
              <Wallet class="h-4 w-4" />
            </span>
            <div>
              <h2 class="text-sm font-bold text-slate-900 dark:text-white">
                {{ t('pool.modalTitle') }}
              </h2>
              <p class="text-[11px] text-slate-400">
                {{ t('pool.modalSubtitle') }}
              </p>
            </div>
          </div>
          <EntryModeSelector
            v-else
            model-value="pool"
            @select="handleEntryModeSelect"
          />
          <button
            type="button"
            :aria-label="t('settings.close')"
            class="rounded-full p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            @click="emit('close')"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <!-- 中間可捲動表單主體 -->
        <form
          id="pool-collect-form"
          class="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4"
          @submit.prevent="handleSubmit"
        >
          <!-- 收款模式切換：獨立公費袋 vs 指定財務長 -->
          <div class="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-xs font-bold dark:bg-slate-800">
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                collectorMode === 'pool'
                  ? 'bg-white text-teal-700 shadow-sm dark:bg-slate-950 dark:text-teal-300'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="collectorMode = 'pool'"
            >
              {{ t('pool.modeVirtualPool') }}
            </button>
            <button
              type="button"
              class="rounded-lg py-1.5 transition"
              :class="
                collectorMode === 'member'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              "
              @click="collectorMode = 'member'"
            >
              {{ t('pool.modeTreasurer') }}
            </button>
          </div>

          <div
            v-if="collectorMode === 'pool'"
            class="space-y-1.5 rounded-xl border border-teal-200/80 bg-teal-50/60 p-3 text-[11px] leading-relaxed text-teal-900 dark:border-teal-800/60 dark:bg-teal-950/30 dark:text-teal-200"
          >
            <p>{{ t('pool.virtualPoolHint') }}</p>
            <input
              v-if="!existingPoolMember"
              v-model="customPoolName"
              type="text"
              maxlength="30"
              :placeholder="t('pool.defaultName')"
              class="mt-1 w-full rounded-lg border border-teal-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 focus:border-teal-500 focus:outline-none dark:border-teal-800 dark:bg-slate-900 dark:text-white"
            />
          </div>

          <div v-else class="space-y-1.5">
            <label class="block text-xs font-semibold text-slate-600 dark:text-slate-300">
              {{ t('pool.selectTreasurerLabel') }}
            </label>
            <select
              v-model="selectedCollectorMemberId"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              <option v-for="m in humanMembers" :key="m.id" :value="m.id">
                {{ m.name }}
              </option>
            </select>
          </div>

          <!-- 每人繳交金額與幣別 -->
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-slate-600 dark:text-slate-300">
              {{ t('pool.amountPerPersonLabel') }}
            </label>
            <CurrencyAmountInput
              v-model="amountPerMember"
              :currency="currency"
              :currencies="currencyOptions"
              show-currency-select
              size="lg"
              autofocus
              placeholder="0"
              @update:currency="handleUserCurrencyChange"
            />
          </div>

          <!-- 外幣匯率 -->
          <div
            v-if="needsExchangeRate"
            class="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs dark:border-amber-800/60 dark:bg-amber-950/30"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-amber-900 dark:text-amber-200">
                {{ t('project.exchangeRateLabel', { from: currency }) }}
              </span>
              <CurrencyAmountInput
                v-model="exchangeRate"
                :allow-decimals="true"
                :max-decimals="8"
                size="sm"
                :placeholder="t('rates.needInputShort')"
                class="w-28"
              />
              <span class="font-semibold text-amber-900 dark:text-amber-200">
                {{ project.baseCurrency }}
              </span>
              <span
                v-if="exchangeRateSource === 'estimated' && exchangeRate !== null && exchangeRate > 0"
                class="rounded-md bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200"
              >
                {{ t('rates.sourceEstimatedTag') }}
              </span>
            </div>
            <p
              v-if="exchangeRate === null || exchangeRate <= 0"
              class="text-[11px] font-semibold text-amber-800 dark:text-amber-300"
            >
              {{ t('project.exchangeRateMissingHint') }}
            </p>
            <p
              v-else-if="exchangeRateSource === 'estimated'"
              class="text-[10px] font-medium text-amber-800/80 dark:text-amber-300/80"
            >
              {{ t('project.exchangeRateEstimatedHint') }}
            </p>
          </div>

          <!-- 繳交成員多選區 -->
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-semibold text-slate-600 dark:text-slate-300">
                {{ t('pool.contributorsLabel') }} ({{ selectedContributorIds.length }}/{{ eligibleContributors.length }})
              </span>
              <div class="flex items-center gap-1.5 text-[11px] font-semibold">
                <button
                  type="button"
                  class="text-emerald-600 hover:underline dark:text-emerald-400"
                  @click="syncDefaultContributors"
                >
                  {{ t('split.quickSelectAll') }}
                </button>
                <span class="text-slate-300">·</span>
                <button
                  type="button"
                  class="text-slate-500 hover:underline dark:text-slate-400"
                  @click="selectedContributorIds = []"
                >
                  {{ t('split.quickSelectNone') }}
                </button>
              </div>
            </div>

            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="m in eligibleContributors"
                :key="m.id"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-3 text-xs font-semibold transition"
                :class="
                  selectedContributorIds.includes(m.id)
                    ? 'bg-teal-600 text-white shadow-sm dark:bg-teal-500 dark:text-slate-950'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                "
                @click="toggleContributor(m.id)"
              >
                <MemberAvatar
                  :name="m.name"
                  :color="m.avatarColor"
                  :image="m.avatarImage"
                  size="xxs"
                  ring
                />
                <span>{{ m.name }}</span>
                <Check
                  v-if="selectedContributorIds.includes(m.id)"
                  class="h-3 w-3"
                />
              </button>
            </div>
          </div>

          <!-- 日期與備註（手機單欄／寬屏雙欄防擠爆） -->
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              v-model="date"
              type="date"
              class="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
            <input
              v-model="note"
              type="text"
              :placeholder="t('pool.defaultNote')"
              class="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
          </div>

          <p v-if="errorText" class="text-xs font-medium text-rose-500">
            {{ errorText }}
          </p>
        </form>

        <!-- Sticky 底部確認收款列 -->
        <div
          class="safe-sticky-pb shrink-0 space-y-2 border-t border-slate-100 bg-white/95 px-5 pt-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 sm:pb-3"
        >
          <div
            v-if="totalCollectedPreview > 0"
            class="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300"
          >
            <span>{{ t('pool.totalPreviewLabel', { count: selectedContributorIds.length }) }}</span>
            <strong class="tabular-nums text-teal-700 dark:text-teal-300">
              <MoneyText :amount="totalCollectedPreview" :currency="currency" />
            </strong>
          </div>
          <button
            type="submit"
            form="pool-collect-form"
            :disabled="isSubmitting || totalCollectedPreview <= 0"
            class="w-full rounded-2xl bg-teal-600 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-40 dark:bg-teal-500 dark:text-slate-950"
          >
            {{ t('pool.confirmButton') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
