<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Undo2, Wallet } from 'lucide-vue-next'
import type { Project } from '@/schemas/ledgerSchema'
import type { MemberNetBalance } from '@/core/settleUpEngine'
import { isPoolMemberId, type PoolCollectBatchSummary } from '@/core/poolFund'
import { formatCurrencyAmount } from '@/core/currency'
import { askConfirm } from '@/composables/useConfirm'
import MoneyText from '@/components/MoneyText.vue'

export interface PoolBalanceRow {
  balance: MemberNetBalance
  baseBalance: MemberNetBalance | null
}

interface Props {
  project: Project
  poolBalanceRows: PoolBalanceRow[]
  latestPoolCollectBatch: PoolCollectBatchSummary | null
  settlementCurrency: string
  isCrossCurrencySettlement: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'openPoolCollect'): void
  (e: 'deleteSettlementsBatch', ids: string[]): void
}>()

const { t, locale } = useI18n()

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
}

function getMemberName(memberId: string): string {
  const found = props.project.members.find((m) => m.id === memberId)
  if (found) return found.name
  if (isPoolMemberId(memberId)) return t('pool.defaultName')
  return memberId
}

async function handleUndoLatestPoolBatch() {
  const batch = props.latestPoolCollectBatch
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
</script>

<template>
  <section
    v-if="poolBalanceRows.length > 0"
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
        v-for="{ balance: pb, baseBalance } in poolBalanceRows"
        :key="pb.memberId"
        class="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
      >
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-900 dark:text-white">
            {{ getMemberName(pb.memberId) }}
          </div>
          <div class="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
            {{ t('pool.paidOutLabel') }}
            <MoneyText :amount="pb.totalPaid" :currency="settlementCurrency" />
            <span
              v-if="isCrossCurrencySettlement && baseBalance"
              class="ml-1"
            >
              (<MoneyText :amount="baseBalance.totalPaid" :currency="project.baseCurrency" />)
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
            <MoneyText :amount="Math.abs(pb.netAmount)" :currency="settlementCurrency" />
          </div>
          <div
            v-if="isCrossCurrencySettlement && baseBalance"
            class="text-[10px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
          >
            <MoneyText :amount="Math.abs(baseBalance.netAmount)" :currency="project.baseCurrency" />
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
</template>
