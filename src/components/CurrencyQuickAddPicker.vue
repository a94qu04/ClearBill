<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Search, X } from 'lucide-vue-next'
import { searchCurrencyCatalog, type CurrencyCatalogItem } from '@/core/currencyCatalog'
import { useLedgerStore } from '@/stores/ledgerStore'

const emit = defineEmits<{
  (e: 'added', code: string): void
  (e: 'close'): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const query = ref('')

const matchedItems = computed(() =>
  searchCurrencyCatalog(query.value, store.availableCurrencies).slice(0, 8),
)

const customCodeCandidate = computed(() => {
  const code = query.value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return ''
  if (store.availableCurrencies.includes(code)) return ''
  if (matchedItems.value.some((item) => item.code === code)) return ''
  return code
})

function getLocalizedName(item: CurrencyCatalogItem): string {
  if (locale.value === 'ja') return item.names.ja
  if (locale.value === 'en') return item.names.en
  return item.names['zh-TW']
}

function handlePickCurrency(code: string) {
  try {
    const added = store.addCurrency(code)
    query.value = ''
    emit('toast', t('settings.currencyAddedToast', { code: added }))
    emit('added', added)
  } catch {
    emit('toast', t('settings.invalidCurrencyCode'))
  }
}

function handleEnter() {
  if (matchedItems.value.length > 0) {
    handlePickCurrency(matchedItems.value[0].code)
    return
  }
  if (customCodeCandidate.value) {
    handlePickCurrency(customCodeCandidate.value)
    return
  }
  emit('toast', t('settings.invalidCurrencyCode'))
}
</script>

<template>
  <div
    class="space-y-2 rounded-2xl border border-slate-200 bg-slate-50/90 p-2.5 dark:border-slate-700 dark:bg-slate-800/80"
  >
    <div class="flex items-center gap-1.5">
      <div class="relative min-w-0 flex-1">
        <Search
          class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
        />
        <input
          v-model="query"
          type="text"
          :placeholder="t('settings.searchCurrencyPlaceholder')"
          class="w-full rounded-xl border border-slate-200 bg-white py-1.5 pl-8 pr-2.5 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          @keydown.enter.prevent.stop="handleEnter"
        />
      </div>
      <button
        type="button"
        :aria-label="t('settings.close')"
        class="shrink-0 rounded-xl p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-slate-700"
        @click="emit('close')"
      >
        <X class="h-4 w-4" />
      </button>
    </div>

    <div
      v-if="matchedItems.length > 0 || customCodeCandidate"
      class="flex flex-wrap gap-1.5"
    >
      <button
        v-for="item in matchedItems"
        :key="item.code"
        type="button"
        class="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-emerald-500 dark:hover:text-emerald-300"
        @click="handlePickCurrency(item.code)"
      >
        <span class="font-extrabold text-emerald-700 dark:text-emerald-400">{{
          item.code
        }}</span>
        <span>{{ getLocalizedName(item) }}</span>
      </button>

      <button
        v-if="customCodeCandidate"
        type="button"
        class="inline-flex items-center gap-1 rounded-full border border-dashed border-emerald-400 bg-emerald-50/70 px-2.5 py-1 text-[11px] font-bold text-emerald-800 transition hover:bg-emerald-100 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300"
        @click="handlePickCurrency(customCodeCandidate)"
      >
        <Plus class="h-3 w-3" />
        <span>{{
          t('settings.addCustomCodeDirect', { code: customCodeCandidate })
        }}</span>
      </button>
    </div>

    <p v-else class="px-1 text-[11px] text-slate-400 dark:text-slate-500">
      {{ t('settings.noCurrencyMatches') }}
    </p>
  </div>
</template>
