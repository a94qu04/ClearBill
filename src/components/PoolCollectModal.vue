<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Calendar, Check, X } from 'lucide-vue-next'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useModalLayer } from '@/composables/useModalLayer'
import {
  buildOrderedCurrencyOptions,
  formatCompactHeaderDate,
  getTodayIso,
} from '@/core/ledgerHelpers'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'
import EntryModeSelector, { type EntryMode } from '@/components/EntryModeSelector.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'
import MoneyText from '@/components/MoneyText.vue'

interface Props {
  open: boolean
  project: Project | null
  editingTx?: Transaction | null
  allowProjectSwitch?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  editingTx: null,
  allowProjectSwitch: false,
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', message: string): void
  (e: 'switchProject', projectId: string): void
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

const customPoolName = ref('')
const selectedContributorIds = ref<string[]>([])
const amountPerMember = ref<number | null>(null)
const currency = ref('TWD')
const exchangeRate = ref<number | null>(1)
const exchangeRateSource = ref<
  'same' | 'live' | 'remembered' | 'estimated' | 'saved' | 'missing'
>('same')
const date = ref(getTodayIso())
const datePanelExpanded = ref(false)
const note = ref('')
const errorText = ref('')
const isSubmitting = ref(false)

const headerDateLabel = computed(() =>
  formatCompactHeaderDate(date.value, getTodayIso(), t('project.todayShort')),
)

const existingPoolMember = computed(
  () => props.project?.members.find((m) => m.isPool) ?? null,
)

const humanMembers = computed(
  () => props.project?.members.filter((m) => !m.isPool) ?? [],
)

const orderedCurrencies = computed(() => {
  const baseCur = props.project?.baseCurrency || store.defaultCurrency
  const settleCur = props.project
    ? store.getProjectSettlementCurrency(props.project)
    : baseCur
  return buildOrderedCurrencyOptions({
    baseCurrency: baseCur,
    settlementCurrency: settleCur,
    availableCurrencies: store.availableCurrencies,
    extraCurrencies: [currency.value],
    tags: {
      base: t('settle.currencyTagBaseShort'),
      settlement: t('settle.currencyTagSettlementShort'),
      both: t('settle.currencyTagBothShort'),
    },
  })
})

const currencyOptions = computed<string[]>(() => orderedCurrencies.value.currencies)
const currencyOptionLabels = computed<Record<string, string>>(
  () => orderedCurrencies.value.labels,
)

const needsExchangeRate = computed(() => {
  if (!props.project) return false
  return currency.value.trim().toUpperCase() !== props.project.baseCurrency.trim().toUpperCase()
})

const eligibleContributors = computed(() => humanMembers.value)

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
    datePanelExpanded.value = false

    const editTx = props.editingTx
    if (editTx && editTx.splitConfig) {
      const toId = editTx.splitConfig.shares[0]?.memberId ?? ''
      const toMember = props.project.members.find((m) => m.id === toId)
      customPoolName.value =
        (toMember?.isPool ? toMember.name : existingPoolMember.value?.name) ||
        t('pool.defaultName')

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

    customPoolName.value = existingPoolMember.value?.name || t('pool.defaultName')
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
    const poolMember = await store.ensureProjectPoolMember(
      props.project.id,
      customPoolName.value || t('pool.defaultName'),
    )
    if (!poolMember) {
      errorText.value = t('home.saveFailed')
      return
    }

    store.rememberLastExpenseProject(props.project.id)
    const count = await store.batchCollectPoolFund({
      projectId: props.project.id,
      collectorMemberId: poolMember.id,
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
        class="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-[#F2F2F7] shadow-2xl dark:bg-[#0D0D0F] sm:rounded-3xl"
      >
        <!-- Apple 風格頂部 Sheet 標題列（左日期膠囊、中模式切換／標題、右關閉） -->
        <div
          class="relative z-20 flex shrink-0 items-center justify-between gap-2 border-b border-black/5 bg-white/90 px-4 py-3 backdrop-blur-md dark:border-white/10 dark:bg-[#1C1C1E]/95"
        >
          <button
            type="button"
            :aria-expanded="datePanelExpanded"
            class="inline-flex max-w-[116px] shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-semibold transition active:scale-95"
            :class="
              datePanelExpanded || date !== getTodayIso()
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
            "
            @mousedown.prevent
            @click="datePanelExpanded = !datePanelExpanded"
          >
            <Calendar class="h-3.5 w-3.5 shrink-0" />
            <span class="truncate tabular-nums">{{ headerDateLabel }}</span>
          </button>
          <h2
            v-if="editingTx"
            class="truncate text-[15px] font-bold text-slate-900 dark:text-white"
          >
            {{ t('pool.modalTitle') }}
          </h2>
          <EntryModeSelector
            v-else
            model-value="pool"
            @select="handleEntryModeSelect"
          />
          <button
            type="button"
            :aria-label="t('settings.close')"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300"
            @mousedown.prevent
            @click="emit('close')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- 展開：日期選擇 -->
        <div
          v-if="datePanelExpanded"
          class="shrink-0 border-b border-black/5 bg-white px-4 py-2.5 dark:border-white/10 dark:bg-[#1C1C1E]"
        >
          <input
            v-model="date"
            type="date"
            class="w-full min-w-0 rounded-xl bg-[#F2F2F7] px-3 py-2 text-xs text-slate-800 dark:bg-[#2C2C2E] dark:text-slate-200"
          />
        </div>

        <!-- 中間可捲動表單主體 -->
        <form
          id="pool-collect-form"
          class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5"
          @submit.prevent="handleSubmit"
        >
          <!-- 首頁快速記一筆時顯示目標專案並支援即時切換 -->
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

          <!-- 分組 1：公費袋說明與名稱（首次建立時可自訂） -->
          <div
            class="space-y-1.5 rounded-2xl border border-teal-200/80 bg-teal-50/70 p-3.5 text-[11px] leading-relaxed text-teal-900 shadow-sm dark:border-teal-800/60 dark:bg-teal-950/35 dark:text-teal-200"
          >
            <p>{{ t('pool.virtualPoolHint') }}</p>
            <input
              v-if="!existingPoolMember"
              v-model="customPoolName"
              type="text"
              maxlength="30"
              :placeholder="t('pool.defaultName')"
              class="mt-1 w-full rounded-xl border border-teal-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 focus:border-teal-500 focus:outline-none dark:border-teal-800 dark:bg-[#1C1C1E] dark:text-white"
            />
          </div>

          <!-- 分組 2：每人繳交金額、幣別與匯率 -->
          <div class="space-y-2.5 rounded-2xl bg-white p-3.5 shadow-sm dark:bg-[#1C1C1E]">
            <label class="block text-xs font-semibold text-slate-500 dark:text-slate-400">
              {{ t('pool.amountPerPersonLabel') }}
            </label>
            <CurrencyAmountInput
              v-model="amountPerMember"
              :currency="currency"
              :currencies="currencyOptions"
              :currency-labels="currencyOptionLabels"
              show-currency-select
              size="lg"
              autofocus
              placeholder="0"
              @update:currency="handleUserCurrencyChange"
            />

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
          </div>

          <!-- 分組 3：繳交成員多選區 -->
          <div class="space-y-2.5 rounded-2xl bg-white p-3.5 shadow-sm dark:bg-[#1C1C1E]">
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
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
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

          <!-- 分組 4：備註 -->
          <div class="rounded-2xl bg-white px-3.5 py-2 shadow-sm dark:bg-[#1C1C1E]">
            <input
              v-model="note"
              type="text"
              :placeholder="t('pool.defaultNote')"
              class="w-full bg-transparent py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none dark:text-white dark:placeholder-slate-500"
            />
          </div>

          <p
            v-if="errorText"
            role="alert"
            class="rounded-2xl bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-600 dark:bg-rose-950/50 dark:text-rose-300"
          >
            {{ errorText }}
          </p>
        </form>

        <!-- Sticky 底部確認收款列 -->
        <div
          class="safe-sticky-pb shrink-0 space-y-2 border-t border-black/5 bg-white/95 px-4 pt-3 backdrop-blur-md dark:border-white/10 dark:bg-[#1C1C1E]/95 sm:pb-3"
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
            class="w-full rounded-2xl bg-teal-600 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-teal-700 active:scale-[0.99] disabled:opacity-40 dark:bg-teal-500 dark:text-slate-950"
          >
            {{ t('pool.confirmButton') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
