<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Camera, Clock, Plus, RefreshCw, X } from 'lucide-vue-next'
import { useLedgerStore, type ManagedCategory } from '@/stores/ledgerStore'
import { formatCurrencyAmount } from '@/core/currency'
import { compressImageFileToDataUrl } from '@/core/imageCompressor'
import {
  getCurrentTimeHHmm,
  getSuggestedExchangeRate,
  getTodayIso,
} from '@/core/ledgerHelpers'
import {
  getCachedLiveExchangeRate,
  refreshLiveExchangeRates,
} from '@/services/exchangeRateService'
import type { ParsedQuickIntakeResult } from '@/core/quickIntakeParser'
import type { Project, SplitConfig, Transaction } from '@/schemas/ledgerSchema'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'
import QuickSplitPanel from '@/components/QuickSplitPanel.vue'

interface Props {
  open: boolean
  project: Project | null
  editingTx: Transaction | null
  prefill?: ParsedQuickIntakeResult | null
}

const props = withDefaults(defineProps<Props>(), {
  prefill: null,
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', message: string): void
  (e: 'previewPhotos', payload: { photos: string[]; index: number }): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

let isHydrating = false
const txType = ref<'expense' | 'refund'>('expense')
const splitPreset = ref<SplitConfig | null>(null)
const splitResetKey = ref(0)
const amount = ref<number | null>(null)
const currency = ref('TWD')
const exchangeRate = ref<number | null>(1)
const exchangeRateSource = ref<'remembered' | 'live' | 'estimated' | 'saved'>('estimated')
const isFetchingLiveRate = ref(false)
const categoryKey = ref<string>(store.categories[0]?.key ?? 'cat_food')
const note = ref('')
const date = ref(getTodayIso())
const time = ref('')
const links = ref<string[]>([])
const receiptImages = ref<string[]>([])
const splitConfig = ref<SplitConfig | null>(null)
const splitValid = ref(false)
const errorText = ref('')

const inlineNewCategoryOpen = ref(false)
const inlineNewCategoryName = ref('')

function resolveCategoryLabel(cat: ManagedCategory): string {
  if (cat.customLabel) return cat.customLabel
  const translated = t(`categories.${cat.key}`)
  return translated === `categories.${cat.key}` ? cat.key : translated
}

const allCategories = computed(() =>
  store.categories.map((cat) => ({
    key: cat.key,
    label: resolveCategoryLabel(cat),
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
  const live = getCachedLiveExchangeRate(fromCurrency, baseCurrency)
  if (live !== null) {
    return { rate: live.rate, source: 'live' }
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
    await refreshLiveExchangeRates(true)
    const live = getCachedLiveExchangeRate(currency.value, props.project.baseCurrency)
    if (live) {
      exchangeRate.value = live.rate
      exchangeRateSource.value = 'live'
      emit('toast', t('project.liveRateAppliedToast', { rate: live.rate }))
    } else {
      emit('toast', t('project.liveRateUnavailableToast'))
    }
  } finally {
    isFetchingLiveRate.value = false
  }
}

function hydrateForm() {
  if (!props.project) return
  isHydrating = true
  errorText.value = ''
  inlineNewCategoryOpen.value = false

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
    splitPreset.value = cloneSplitConfig(tx.splitConfig)
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
    currency.value = props.project.baseCurrency
    exchangeRate.value = 1
    exchangeRateSource.value = 'estimated'
    categoryKey.value = store.categories[0]?.key ?? 'cat_food'
    note.value = ''
    date.value = getTodayIso()
    time.value = ''
    links.value = []
    receiptImages.value = []
    splitPreset.value = null
  }

  splitResetKey.value += 1
  isHydrating = false
}

watch(
  () => [props.open, props.editingTx?.id, props.prefill, props.project?.id] as const,
  ([isOpen]) => {
    if (isOpen) {
      hydrateForm()
    }
  },
  { immediate: true },
)

watch(currency, (nextCurrency) => {
  if (isHydrating || !props.project) return
  const resolved = resolveExchangeRateForCurrency(
    nextCurrency,
    props.project.baseCurrency,
  )
  exchangeRate.value = resolved.rate
  exchangeRateSource.value = resolved.source
})

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

  try {
    const selected = Array.from(files).slice(0, remainingSlots)
    const compressed = await Promise.all(
      selected.map((file) => compressImageFileToDataUrl(file)),
    )
    receiptImages.value = [...receiptImages.value, ...compressed].slice(0, 3)
  } catch {
    emit('toast', t('photo.uploadError'))
  } finally {
    input.value = ''
  }
}

function removeImage(index: number) {
  receiptImages.value = receiptImages.value.filter((_, idx) => idx !== index)
}

async function handleSubmit() {
  errorText.value = ''
  if (!props.project) return

  const numericAmount = amount.value ?? 0
  if (numericAmount <= 0) {
    errorText.value = t('validation.amountRequired')
    return
  }

  const rate = needsExchangeRate.value ? (exchangeRate.value ?? 0) : 1
  if (needsExchangeRate.value && rate <= 0) {
    errorText.value = t('validation.exchangeRateRequired')
    return
  }

  if (!splitValid.value || !splitConfig.value) {
    errorText.value = t('split.errInvalidAmount')
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

  try {
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
    emit('saved', t('daily.savedToast'))
    emit('close')
  } catch {
    errorText.value = t('home.saveFailed')
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && project"
      class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
      @click.self="emit('close')"
    >
      <div
        class="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-bold text-slate-900 dark:text-white">
            {{
              editingTx
                ? t('project.editExpenseTitle')
                : t('project.addExpenseTitle')
            }}
          </h2>
          <button
            type="button"
            :aria-label="t('settings.close')"
            class="rounded-full p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            @click="emit('close')"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <form class="space-y-3.5" @submit.prevent="handleSubmit">
          <!-- 兩段式類型切換：消費支出 / 退款・退稅 -->
          <div
            role="tablist"
            class="grid grid-cols-2 rounded-xl bg-slate-100 p-1 text-xs font-semibold dark:bg-slate-800"
          >
            <button
              type="button"
              role="tab"
              :aria-selected="txType === 'expense'"
              class="rounded-lg py-1.5 transition"
              :class="
                txType === 'expense'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              "
              @click="txType = 'expense'"
            >
              {{ t('project.typeExpense') }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="txType === 'refund'"
              class="rounded-lg py-1.5 transition"
              :class="
                txType === 'refund'
                  ? 'bg-teal-600 text-white shadow-sm dark:bg-teal-500 dark:text-slate-950'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              "
              @click="txType = 'refund'"
            >
              {{ t('project.typeRefund') }}
            </button>
          </div>

          <CurrencyAmountInput
            v-model="amount"
            v-model:currency="currency"
            :currencies="currencyOptions"
            show-currency-select
            enable-expression
            show-math-toolbar
            show-service-fee-button
            size="lg"
            autofocus
            placeholder="0"
          />

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
                size="sm"
                placeholder="1"
                class="w-24"
              />
              <span class="font-semibold text-amber-900 dark:text-amber-200">
                {{ project.baseCurrency }}
              </span>
              <span
                v-if="convertedPreviewAmount > 0"
                class="ml-auto font-bold text-amber-800 dark:text-amber-300"
              >
                {{
                  t('project.convertedPreview', {
                    amount: fmt(convertedPreviewAmount, project.baseCurrency),
                  })
                }}
              </span>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2 text-[10px]">
              <span
                v-if="exchangeRateSource !== 'saved'"
                class="font-medium text-amber-700/90 dark:text-amber-300/80"
              >
                {{
                  exchangeRateSource === 'remembered'
                    ? t('project.exchangeRateRememberedHint')
                    : exchangeRateSource === 'live'
                      ? t('project.exchangeRateLiveHint')
                      : t('project.exchangeRateEstimatedHint')
                }}
              </span>
              <span v-else />

              <button
                type="button"
                :disabled="isFetchingLiveRate"
                class="inline-flex items-center gap-1 rounded-md bg-amber-200/70 px-2 py-0.5 font-bold text-amber-900 transition hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/60 dark:text-amber-200"
                @click="handleApplyLiveRate"
              >
                <RefreshCw
                  class="h-3 w-3"
                  :class="isFetchingLiveRate ? 'animate-spin' : ''"
                />
                <span>{{ t('project.refreshLiveRateButton') }}</span>
              </button>
            </div>
          </div>

          <input
            v-model="note"
            type="text"
            :placeholder="
              txType === 'refund'
                ? t('project.refundTitlePlaceholder')
                : t('project.expenseTitlePlaceholder')
            "
            class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />

          <div class="space-y-2">
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="cat in allCategories"
                :key="cat.key"
                type="button"
                class="rounded-full px-2.5 py-1 text-xs font-semibold transition"
                :class="
                  categoryKey === cat.key
                    ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
                    : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                "
                @click="categoryKey = cat.key"
              >
                {{ cat.label }}
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-0.5 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-700"
                @click="inlineNewCategoryOpen = !inlineNewCategoryOpen"
              >
                <Plus class="h-3 w-3" />
                <span>{{ t('search.addCategoryInline') }}</span>
              </button>
            </div>
            <div v-if="inlineNewCategoryOpen" class="flex gap-1.5">
              <input
                v-model="inlineNewCategoryName"
                type="text"
                maxlength="24"
                :placeholder="t('search.newCategoryPlaceholder')"
                class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                @keyup.enter="confirmInlineAddCategory"
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

          <div class="flex items-center gap-2">
            <input
              v-model="date"
              type="date"
              class="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
            <input
              v-model="time"
              type="time"
              class="w-32 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
            <button
              type="button"
              class="inline-flex shrink-0 items-center gap-1 rounded-xl bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-emerald-600 dark:bg-slate-800 dark:text-emerald-400"
              @click="time = getCurrentTimeHHmm()"
            >
              <Clock class="h-3.5 w-3.5" />
              <span>{{ t('daily.useNowTime') }}</span>
            </button>
          </div>

          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">
                {{ t('photo.title') }}
              </span>
              <label
                v-if="receiptImages.length < 3"
                class="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"
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
                class="relative h-16 w-16 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700"
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
                  class="absolute right-0.5 top-0.5 rounded-full bg-slate-950/75 p-0.5 text-white"
                  @click="removeImage(idx)"
                >
                  <X class="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>

          <QuickSplitPanel
            :total-amount="amount ?? 0"
            :currency="currency"
            :members="project.members"
            :default-payer-id="project.defaultPayerId"
            :initial-mode="project.defaultSplitMode"
            :initial-split-config="splitPreset"
            :reset-key="splitResetKey"
            @update:split-config="splitConfig = $event"
            @validity-change="splitValid = $event"
          />

          <p v-if="errorText" class="text-xs font-medium text-rose-500">
            {{ errorText }}
          </p>

          <button
            type="submit"
            :disabled="!splitValid || (amount ?? 0) <= 0"
            class="w-full rounded-2xl py-3 text-sm font-bold text-white shadow-sm transition disabled:opacity-40"
            :class="
              txType === 'refund'
                ? 'bg-teal-600 hover:bg-teal-700 dark:bg-teal-500 dark:text-slate-950'
                : 'bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950'
            "
          >
            {{
              editingTx
                ? t('project.updateExpenseButton')
                : txType === 'refund'
                  ? t('project.saveRefundButton')
                  : t('project.saveExpenseButton')
            }}
          </button>
        </form>
      </div>
    </div>
  </Teleport>
</template>
