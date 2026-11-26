<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, RefreshCw, Search, X } from 'lucide-vue-next'
import { searchCurrencyCatalog } from '@/core/currencyCatalog'
import { useLedgerStore } from '@/stores/ledgerStore'

const emit = defineEmits<{
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

// 幣別搜尋與自訂匯率輸入狀態
const currencySearchQuery = ref('')
const customRateDrafts = ref<Record<string, string>>({})

const foreignEnabledCurrencies = computed(() =>
  store.availableCurrencies.filter((c) => c !== store.defaultCurrency),
)

const formattedLiveRatesTime = computed(() => {
  const ts = store.liveRatesFetchedAt
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toLocaleString()
  }
})

const filteredCurrencySuggestions = computed(() =>
  searchCurrencyCatalog(currencySearchQuery.value, store.availableCurrencies),
)

const canAddCustomIsoCode = computed(() => {
  const code = currencySearchQuery.value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return false
  if (store.availableCurrencies.includes(code)) return false
  return !filteredCurrencySuggestions.value.some((item) => item.code === code)
})

function syncCustomRateDrafts() {
  const base = store.defaultCurrency
  const next: Record<string, string> = {}
  for (const cur of foreignEnabledCurrencies.value) {
    const custom = store.getRememberedExchangeRate(cur, base)
    const live = store.getLiveExchangeRate(cur, base)
    const val = custom ?? live
    next[cur] = val !== null ? String(val) : ''
  }
  customRateDrafts.value = next
}

onMounted(() => {
  syncCustomRateDrafts()
  void store.refreshExchangeRates(false).then(() => syncCustomRateDrafts())
})

watch(
  () => [
    store.defaultCurrency,
    store.availableCurrencies.join(','),
    store.liveRatesFetchedAt,
  ],
  () => {
    syncCustomRateDrafts()
  },
)

function getCatalogName(item: {
  names: { 'zh-TW': string; en: string; ja: string }
}): string {
  if (locale.value === 'ja') return item.names.ja
  if (locale.value === 'en') return item.names.en
  return item.names['zh-TW']
}

async function handleManualRefreshRates() {
  const res = await store.refreshExchangeRates(true)
  syncCustomRateDrafts()
  if (res) {
    emit('toast', t('rates.refreshedToast'))
  } else {
    emit('toast', t('project.liveRateUnavailableToast'))
  }
}

function handleSaveCustomRate(currencyCode: string) {
  const raw = String(customRateDrafts.value[currencyCode] ?? '').trim()
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    syncCustomRateDrafts()
    emit('toast', t('validation.exchangeRateRequired'))
    return
  }
  store.rememberExchangeRate(currencyCode, store.defaultCurrency, parsed)
  emit(
    'toast',
    t('rates.customSavedToast', {
      from: currencyCode,
      to: store.defaultCurrency,
      rate: parsed,
    }),
  )
}

function handleUseLiveRateForCurrency(currencyCode: string) {
  store.clearRememberedExchangeRate(currencyCode, store.defaultCurrency)
  const live = store.getLiveExchangeRate(currencyCode, store.defaultCurrency)
  customRateDrafts.value = {
    ...customRateDrafts.value,
    [currencyCode]: live !== null ? String(live) : '',
  }
  emit('toast', t('rates.appliedLiveToast', { code: currencyCode }))
}

function handleAddCurrency(code: string) {
  try {
    const added = store.addCurrency(code)
    currencySearchQuery.value = ''
    emit('toast', t('settings.currencyAddedToast', { code: added }))
  } catch {
    emit('toast', t('settings.invalidCurrencyCode'))
  }
}

function handleRemoveCurrency(code: string) {
  const ok = store.removeCurrency(code)
  if (!ok) {
    emit('toast', t('settings.cannotDeleteDefaultCurrency'))
    return
  }
  emit('toast', t('settings.currencyRemovedToast', { code }))
}
</script>

<template>
  <div class="space-y-5">
    <!-- 每小時免費即時匯率參考與自訂覆寫 -->
    <section
      class="space-y-3 rounded-2xl border border-amber-200/80 bg-amber-50/40 p-4 dark:border-amber-900/60 dark:bg-amber-950/20"
    >
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-xs font-bold text-slate-900 dark:text-white">
            {{ t('rates.boardTitle', { base: store.defaultCurrency }) }}
          </div>
          <div class="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
            {{
              formattedLiveRatesTime
                ? t('rates.fetchedAtLabel', { time: formattedLiveRatesTime })
                : t('rates.notFetchedYet')
            }}
          </div>
        </div>
        <button
          type="button"
          :disabled="store.isRefreshingLiveRates"
          class="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-900 transition hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/60 dark:text-amber-200"
          @click="handleManualRefreshRates"
        >
          <RefreshCw
            class="h-3 w-3"
            :class="store.isRefreshingLiveRates ? 'animate-spin' : ''"
          />
          <span>{{ t('rates.refreshNow') }}</span>
        </button>
      </div>

      <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        {{ t('rates.hourlyHint') }}
      </p>

      <ul
        class="divide-y divide-amber-200/50 rounded-xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
      >
        <li
          v-for="code in foreignEnabledCurrencies"
          :key="code"
          class="space-y-1.5 px-3 py-2.5"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-extrabold text-slate-900 dark:text-white">
                1 {{ code }}
              </span>
              <span
                class="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                :class="
                  store.getRememberedExchangeRate(
                    code,
                    store.defaultCurrency,
                  ) !== null
                    ? 'bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300'
                "
              >
                {{
                  store.getRememberedExchangeRate(
                    code,
                    store.defaultCurrency,
                  ) !== null
                    ? t('rates.badgeCustom')
                    : t('rates.badgeLive')
                }}
              </span>
            </div>
            <span
              v-if="
                store.getLiveExchangeRate(code, store.defaultCurrency) !== null
              "
              class="text-[10px] tabular-nums text-slate-400"
            >
              {{
                t('rates.liveRefValue', {
                  rate: store.getLiveExchangeRate(code, store.defaultCurrency),
                  base: store.defaultCurrency,
                })
              }}
            </span>
          </div>

          <div class="flex items-center gap-1.5">
            <span class="text-xs font-semibold text-slate-400">=</span>
            <input
              v-model="customRateDrafts[code]"
              type="number"
              step="any"
              min="0"
              inputmode="decimal"
              class="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold tabular-nums text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              @keyup.enter="handleSaveCustomRate(code)"
            />
            <span class="text-[11px] font-bold text-slate-500 dark:text-slate-400">
              {{ store.defaultCurrency }}
            </span>
            <button
              type="button"
              class="rounded-lg bg-slate-900 px-2 py-1 text-[10px] font-bold text-white hover:bg-slate-800 dark:bg-emerald-500 dark:text-slate-950"
              @click="handleSaveCustomRate(code)"
            >
              {{ t('backup.googleSaveClientId') }}
            </button>
            <button
              v-if="
                store.getRememberedExchangeRate(code, store.defaultCurrency) !==
                null
              "
              type="button"
              class="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300"
              @click="handleUseLiveRateForCurrency(code)"
            >
              {{ t('rates.useLiveShort') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <!-- 已啟用幣別與預設幣別 -->
    <section>
      <div class="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
        {{ t('settings.enabledCurrenciesTitle') }}
      </div>
      <p class="mb-2.5 text-[11px] text-slate-400">
        {{ t('settings.defaultCurrencyHint') }}
      </p>
      <div class="flex flex-wrap gap-2">
        <div
          v-for="code in store.availableCurrencies"
          :key="code"
          class="inline-flex items-center overflow-hidden rounded-xl border text-xs font-semibold transition"
          :class="
            store.defaultCurrency === code
              ? 'border-emerald-500 bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
              : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
          "
        >
          <button
            type="button"
            class="px-2.5 py-1.5"
            @click="store.setDefaultCurrency(code)"
          >
            <span>{{ code }}</span>
            <span
              v-if="store.defaultCurrency === code"
              class="ml-1 rounded bg-black/15 px-1 py-0.5 text-[9px]"
            >
              {{ t('settings.defaultTag') }}
            </span>
          </button>
          <button
            v-if="store.defaultCurrency !== code"
            type="button"
            :aria-label="t('home.deleteTx')"
            class="border-l border-slate-200 px-2 py-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
            @click="handleRemoveCurrency(code)"
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </section>

    <!-- 搜尋並新增幣別 -->
    <section
      class="space-y-2.5 border-t border-slate-100 pt-4 dark:border-slate-800"
    >
      <div class="text-xs font-semibold text-slate-500 dark:text-slate-400">
        {{ t('settings.searchCurrencyTitle') }}
      </div>
      <div class="relative">
        <Search
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        />
        <input
          v-model="currencySearchQuery"
          type="text"
          :placeholder="t('settings.searchCurrencyPlaceholder')"
          class="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        />
      </div>

      <button
        v-if="canAddCustomIsoCode"
        type="button"
        class="flex w-full items-center justify-between rounded-xl border border-dashed border-emerald-400 bg-emerald-50/70 px-3 py-2 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
        @click="handleAddCurrency(currencySearchQuery)"
      >
        <span>
          {{
            t('settings.addCustomCodeDirect', {
              code: currencySearchQuery.trim().toUpperCase(),
            })
          }}
        </span>
        <Plus class="h-4 w-4" />
      </button>

      <ul
        class="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800"
      >
        <li
          v-for="item in filteredCurrencySuggestions"
          :key="item.code"
          class="flex items-center justify-between px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/60"
        >
          <div>
            <span class="text-xs font-bold text-slate-900 dark:text-white">
              {{ item.code }}
            </span>
            <span class="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
              {{ getCatalogName(item) }} ({{ item.symbol }})
            </span>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300"
            @click="handleAddCurrency(item.code)"
          >
            <Plus class="h-3 w-3" />
            <span>{{ t('settings.add') }}</span>
          </button>
        </li>
        <li
          v-if="filteredCurrencySuggestions.length === 0 && !canAddCustomIsoCode"
          class="px-3 py-5 text-center text-xs text-slate-400"
        >
          {{ t('settings.noCurrencyMatches') }}
        </li>
      </ul>
    </section>
  </div>
</template>
