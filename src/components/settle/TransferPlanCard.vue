<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Coins, Copy, Wallet } from 'lucide-vue-next'
import type { Project } from '@/schemas/ledgerSchema'
import type { SettlementTransfer } from '@/core/settleUpEngine'
import { isPoolMemberId } from '@/core/poolFund'
import { formatCurrencyNumber } from '@/core/currency'
import { useClipboardShare } from '@/composables/useClipboardShare'

interface Props {
  project: Project
  effectiveTransfers: SettlementTransfer[]
  visibleTransfers: SettlementTransfer[]
  isCrossCurrencySettlement: boolean
  settlementToBaseRate: number | null
  myMemberId?: string
  hasPoolBalances: boolean
  transferPlanMode: 'min_transfers' | 'hub'
  resolvedHubMemberId: string
  onlyMyTransfers: boolean
}

const props = withDefaults(defineProps<Props>(), {
  myMemberId: undefined,
})

const emit = defineEmits<{
  (e: 'update:transferPlanMode', mode: 'min_transfers' | 'hub'): void
  (e: 'update:hubMemberId', memberId: string): void
  (e: 'update:onlyMyTransfers', value: boolean): void
  (e: 'openPoolCollect'): void
  (
    e: 'recordPayment',
    payload: {
      fromMemberId: string
      toMemberId: string
      amount: number
      currency: string
    },
  ): void
  (e: 'toast', message: string): void
}>()

const { t, locale } = useI18n()
const { copyText } = useClipboardShare()

function fmtNum(amount: number, currency: string): string {
  return formatCurrencyNumber(amount, currency, locale.value)
}

function convertSettleAmountToBase(amount: number): number | null {
  const rate = props.settlementToBaseRate
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null
  return amount * rate
}

function getMemberName(memberId: string): string {
  const found = props.project.members.find((m) => m.id === memberId)
  if (found) return found.name
  if (isPoolMemberId(memberId)) return t('pool.defaultName')
  return memberId
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
  const copied = await copyText(info)
  emit(
    'toast',
    copied ? t('profile.paymentInfoCopiedToast') : t('share.failedToast'),
  )
}
</script>

<template>
  <section class="space-y-3 rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
        <span class="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <Coins class="h-3.5 w-3.5" />
        </span>
        <span>{{ t('settle.suggestionsTitle') }}</span>
      </div>

      <!-- 僅於尚未建立公費袋時在此顯示「收公費」入口，避免與公費袋卡片按鈕重複 -->
      <button
        v-if="!hasPoolBalances"
        type="button"
        class="inline-flex items-center gap-1 rounded-full bg-teal-500/12 px-2.5 py-1 text-[11px] font-semibold text-teal-700 transition hover:bg-teal-500/20 dark:bg-teal-400/15 dark:text-teal-300"
        @click="emit('openPoolCollect')"
      >
        <Wallet class="h-3 w-3" />
        <span>{{ t('pool.collectButtonShort') }}</span>
      </button>
    </div>

    <!-- 結算模式切換列：最少轉帳 / 集中收付 ＋ 只看我濾鏡 -->
    <div v-if="effectiveTransfers.length > 0" class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="inline-flex rounded-xl bg-black/[0.06] p-0.5 text-[11px] font-semibold dark:bg-[#2C2C2E]">
          <button
            type="button"
            class="rounded-lg px-2.5 py-1 transition"
            :class="
              transferPlanMode === 'min_transfers'
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#3A3A3C] dark:text-white'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
            "
            @click="emit('update:transferPlanMode', 'min_transfers')"
          >
            {{ t('settle.planModeMin') }}
          </button>
          <button
            type="button"
            class="rounded-lg px-2.5 py-1 transition"
            :class="
              transferPlanMode === 'hub'
                ? 'bg-white text-emerald-700 shadow-sm dark:bg-[#3A3A3C] dark:text-emerald-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
            "
            @click="emit('update:transferPlanMode', 'hub')"
          >
            {{ t('settle.planModeHub') }}
          </button>
        </div>

        <button
          v-if="myMemberId"
          type="button"
          class="rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
          :class="
            onlyMyTransfers
              ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-[#2C2C2E] dark:text-slate-300'
          "
          @click="emit('update:onlyMyTransfers', !onlyMyTransfers)"
        >
          {{ t('settle.onlyMyTransfersButton') }}
        </button>
      </div>

      <!-- 集中收付模式窗口選擇 -->
      <div
        v-if="transferPlanMode === 'hub'"
        class="flex items-center justify-between gap-2 rounded-xl bg-slate-100/80 px-3 py-1.5 text-[11px] dark:bg-[#2C2C2E]"
      >
        <span class="shrink-0 font-medium text-slate-500 dark:text-slate-400">
          {{ t('settle.hubMemberLabel') }}
        </span>
        <select
          :value="resolvedHubMemberId"
          class="min-w-0 max-w-[180px] rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-800 focus:outline-none dark:bg-[#1C1C1E] dark:text-white"
          @change="
            emit('update:hubMemberId', ($event.target as HTMLSelectElement).value)
          "
        >
          <option v-for="m in project.members" :key="m.id" :value="m.id">
            {{ m.name }}
          </option>
        </select>
      </div>
    </div>

    <p
      v-if="effectiveTransfers.length === 0"
      class="rounded-xl bg-emerald-500/10 px-3.5 py-3 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
    >
      {{ t('settle.allSettled') }}
    </p>

    <p
      v-else-if="visibleTransfers.length === 0"
      class="rounded-xl bg-slate-100/80 px-3.5 py-3 text-xs font-medium text-slate-500 dark:bg-[#2C2C2E] dark:text-slate-400"
    >
      {{ t('settle.noMyTransfers') }}
    </p>

    <ul v-else class="divide-y divide-slate-100 dark:divide-white/10">
      <li
        v-for="(transfer, idx) in visibleTransfers"
        :key="idx"
        class="flex items-center justify-between gap-2 py-3 first:pt-1 last:pb-0"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-white">
            <span class="inline-flex items-center gap-1.5">
              <span
                class="h-2 w-2 rounded-full"
                :style="{ backgroundColor: getMemberColor(transfer.fromMemberId) }"
              />
              <span>{{ getMemberName(transfer.fromMemberId) }}</span>
            </span>
            <span class="text-slate-400">→</span>
            <span class="inline-flex items-center gap-1.5">
              <span
                class="h-2 w-2 rounded-full"
                :style="{ backgroundColor: getMemberColor(transfer.toMemberId) }"
              />
              <span>{{ getMemberName(transfer.toMemberId) }}</span>
            </span>
          </div>
          <div class="mt-1 flex flex-wrap items-baseline gap-1.5 tabular-nums">
            <span class="inline-flex items-baseline gap-1">
              <span class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-extrabold tracking-wide text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                {{ transfer.currency }}
              </span>
              <span class="text-base font-bold text-emerald-700 dark:text-emerald-400">
                {{ fmtNum(transfer.amount, transfer.currency) }}
              </span>
            </span>
            <span
              v-if="isCrossCurrencySettlement && convertSettleAmountToBase(transfer.amount) !== null"
              class="text-[11px] font-medium text-slate-400 dark:text-slate-500"
            >
              ≈ {{ project.baseCurrency }} {{ fmtNum(convertSettleAmountToBase(transfer.amount) ?? 0, project.baseCurrency) }}
            </span>
          </div>
          <button
            v-if="getMemberPaymentInfo(transfer.toMemberId)"
            type="button"
            class="mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-medium text-slate-600 transition hover:text-emerald-600 dark:bg-[#2C2C2E] dark:text-slate-300"
            @click="copyPaymentInfo(transfer.toMemberId)"
          >
            <Copy class="h-2.5 w-2.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span class="truncate">{{ getMemberPaymentInfo(transfer.toMemberId) }}</span>
          </button>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:text-slate-950"
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
</template>
