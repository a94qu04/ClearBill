<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { useLedgerStore } from '@/stores/ledgerStore'
import { formatCurrencyAmount } from '@/core/currency'
import { getTodayIso } from '@/core/ledgerHelpers'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'

interface Props {
  open: boolean
  project: Project | null
  editingTx: Transaction | null
  initialFromId?: string
  initialToId?: string
  suggestedAmount?: number | null
  currency?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  initialFromId: '',
  initialToId: '',
  suggestedAmount: null,
  currency: null,
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', message: string): void
}>()

const { t, locale } = useI18n()
const store = useLedgerStore()

const effectiveCurrency = computed<string>(() => {
  if (props.editingTx) return props.editingTx.currency
  if (props.currency) return props.currency.trim().toUpperCase()
  if (props.project) return store.getProjectSettlementCurrency(props.project)
  return store.defaultCurrency
})

const fromId = ref('')
const toId = ref('')
const amount = ref<number | null>(null)
const date = ref(getTodayIso())
const note = ref('')
const errorText = ref('')

watch(
  () => [props.open, props.editingTx?.id, props.initialFromId, props.initialToId, props.suggestedAmount] as const,
  ([isOpen]) => {
    if (!isOpen) return
    errorText.value = ''
    if (props.editingTx && props.editingTx.splitConfig) {
      fromId.value = props.editingTx.splitConfig.payerId
      toId.value = props.editingTx.splitConfig.shares[0]?.memberId ?? ''
      amount.value = props.editingTx.amount
      date.value = props.editingTx.date
      note.value = props.editingTx.note ?? ''
      return
    }
    fromId.value = props.initialFromId || props.project?.members[0]?.id || ''
    toId.value = props.initialToId || props.project?.members[1]?.id || ''
    amount.value = props.suggestedAmount ?? null
    date.value = getTodayIso()
    note.value = ''
  },
  { immediate: true },
)

function fmt(val: number, cur: string): string {
  return formatCurrencyAmount(val, cur, locale.value)
}

async function handleSubmit() {
  errorText.value = ''
  if (!props.project) return

  const numericAmount = amount.value ?? 0
  if (numericAmount <= 0) {
    errorText.value = t('validation.amountRequired')
    return
  }
  if (!fromId.value || !toId.value || fromId.value === toId.value) {
    errorText.value = t('validation.sameMemberSettlement')
    return
  }

  const payCurrency = effectiveCurrency.value
  const projectBase = props.project.baseCurrency.trim().toUpperCase()
  const rateToBase =
    payCurrency === projectBase
      ? 1
      : props.editingTx && props.editingTx.currency.trim().toUpperCase() === payCurrency
        ? props.editingTx.exchangeRateToBase
        : store.getEffectiveExchangeRate(payCurrency, projectBase)

  try {
    if (props.editingTx) {
      await store.updateTransaction(props.editingTx.id, {
        projectId: props.project.id,
        type: 'transfer',
        amount: numericAmount,
        currency: payCurrency,
        exchangeRateToBase: rateToBase,
        categoryKey: 'cat_settlement',
        date: date.value || getTodayIso(),
        time: '00:00',
        note: note.value,
        splitConfig: {
          payerId: fromId.value,
          mode: 'custom_plus_equal',
          shares: [
            {
              memberId: toId.value,
              finalAmount: numericAmount,
              customAmount: numericAmount,
              isIncludedInRemainder: false,
            },
          ],
        },
      })
      emit('saved', t('daily.updatedToast'))
      emit('close')
      return
    }

    await store.recordSettlementPayment({
      projectId: props.project.id,
      fromMemberId: fromId.value,
      toMemberId: toId.value,
      amount: numericAmount,
      currency: payCurrency,
      exchangeRateToBase: rateToBase,
      date: date.value || getTodayIso(),
      note: note.value,
    })
    emit('saved', t('settle.paymentRecordedToast'))
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
        class="w-full max-w-md rounded-t-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-bold text-slate-900 dark:text-white">
            {{
              editingTx
                ? t('settle.editModalTitle')
                : t('settle.recordModalTitle')
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

        <form class="space-y-4" @submit.prevent="handleSubmit">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-1 block text-xs font-semibold text-slate-500">
                {{ t('settle.fromLabel') }}
              </label>
              <select
                v-model="fromId"
                class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                <option
                  v-for="m in project.members"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.name }}
                </option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-xs font-semibold text-slate-500">
                {{ t('settle.toLabel') }}
              </label>
              <select
                v-model="toId"
                class="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                <option
                  v-for="m in project.members"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.name }}
                </option>
              </select>
            </div>
          </div>

          <div>
            <label class="mb-1 block text-xs font-semibold text-slate-500">
              {{ t('settle.paidAmountLabel') }} ({{ effectiveCurrency }})
            </label>
            <CurrencyAmountInput
              v-model="amount"
              :currency="effectiveCurrency"
              size="lg"
              autofocus
              placeholder="0"
            />
            <p
              v-if="!editingTx && suggestedAmount !== null"
              class="mt-1 text-[11px] text-slate-500 dark:text-slate-400"
            >
              {{
                t('settle.remainingHint', {
                  amount: fmt(suggestedAmount, effectiveCurrency),
                })
              }}
            </p>
          </div>

          <div class="grid grid-cols-2 gap-2.5">
            <input
              v-model="date"
              type="date"
              class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
            <input
              v-model="note"
              type="text"
              :placeholder="t('daily.notePlaceholder')"
              class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
          </div>

          <p v-if="errorText" class="text-xs font-medium text-rose-500">
            {{ errorText }}
          </p>

          <button
            type="submit"
            class="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
          >
            {{
              editingTx
                ? t('settle.updatePayment')
                : t('settle.savePayment')
            }}
          </button>
        </form>
      </div>
    </div>
  </Teleport>
</template>
