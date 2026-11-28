<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Users, Wallet } from 'lucide-vue-next'
import type { ProjectMember } from '@/schemas/ledgerSchema'
import {
  formatCurrencyAmount,
  fromMinorUnits,
  toMinorUnits,
} from '@/core/currency'
import CurrencyAmountInput from '@/components/CurrencyAmountInput.vue'
import MemberAvatar from '@/components/MemberAvatar.vue'

interface Props {
  members: ProjectMember[]
  currency: string
  totalAmount: number
  paidTotal: number
  payerId: string
  isMultiPayer: boolean
  multiPayerAmounts: Record<string, number | null>
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:payerId', value: string): void
  (e: 'update:isMultiPayer', value: boolean): void
  (
    e: 'update:memberAmount',
    payload: { memberId: string; amount: number | null },
  ): void
}>()

const { t, locale } = useI18n()

function fmt(amount: number): string {
  return formatCurrencyAmount(amount, props.currency, locale.value)
}

function setMultiPayerMode(nextIsMulti: boolean) {
  if (nextIsMulti === props.isMultiPayer) return
  if (nextIsMulti) {
    const hasAnyAmount = props.members.some(
      (m) => (props.multiPayerAmounts[m.id] ?? 0) > 0,
    )
    if (!hasAnyAmount && props.payerId && props.totalAmount > 0) {
      emit('update:memberAmount', {
        memberId: props.payerId,
        amount: props.totalAmount,
      })
    }
  } else {
    // 切回單人墊付時自動以墊付金額最高者作為主墊付人
    const topPayer = props.members
      .map((m) => ({ id: m.id, amt: props.multiPayerAmounts[m.id] ?? 0 }))
      .sort((a, b) => b.amt - a.amt)[0]
    if (topPayer && topPayer.amt > 0) {
      emit('update:payerId', topPayer.id)
    }
  }
  emit('update:isMultiPayer', nextIsMulti)
}

function fillRemainingToPayer(memberId: string) {
  if (props.totalAmount <= 0) return
  const totalUnits = toMinorUnits(props.totalAmount, props.currency)
  let othersUnits = 0
  for (const member of props.members) {
    if (member.id === memberId) continue
    const val = props.multiPayerAmounts[member.id] ?? 0
    if (val > 0) {
      othersUnits += toMinorUnits(val, props.currency)
    }
  }
  const remainUnits = Math.max(0, totalUnits - othersUnits)
  emit('update:memberAmount', {
    memberId,
    amount:
      remainUnits > 0 ? fromMinorUnits(remainUnits, props.currency) : null,
  })
}
</script>

<template>
  <!-- 付款人區塊（支援單人快選與多人墊付切換） -->
  <div class="mb-3.5 space-y-2.5">
    <div class="flex items-center justify-between gap-2">
      <div
        class="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300"
      >
        <Users class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        <span>{{ t('split.payerLabel') }}</span>
      </div>

      <div
        role="group"
        class="inline-flex items-center gap-1 rounded-xl bg-slate-100 p-0.5 dark:bg-slate-800"
      >
        <button
          type="button"
          :aria-pressed="!isMultiPayer"
          class="rounded-lg px-2.5 py-1 text-xs font-semibold transition"
          :class="
            !isMultiPayer
              ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
          "
          @click="setMultiPayerMode(false)"
        >
          {{ t('split.singlePayerMode') }}
        </button>
        <button
          type="button"
          :aria-pressed="isMultiPayer"
          class="rounded-lg px-2.5 py-1 text-xs font-semibold transition"
          :class="
            isMultiPayer
              ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-slate-950'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
          "
          @click="setMultiPayerMode(true)"
        >
          {{ t('split.multiPayerMode') }}
        </button>
      </div>
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
        @click="emit('update:payerId', member.id)"
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
      <div
        class="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400"
      >
        <span>{{ t('split.multiPayerHint') }}</span>
        <span class="tabular-nums font-semibold">
          {{ fmt(paidTotal) }} / {{ fmt(totalAmount) }}
        </span>
      </div>

      <div
        v-for="member in members"
        :key="`payer-${member.id}`"
        class="flex items-center justify-between gap-2"
      >
        <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span
            class="h-2.5 w-2.5 shrink-0 rounded-full"
            :style="{ backgroundColor: member.avatarColor || '#10b981' }"
          />
          <span
            class="truncate text-xs font-medium text-slate-700 dark:text-slate-200"
          >
            {{ member.name }}
          </span>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <CurrencyAmountInput
            :model-value="multiPayerAmounts[member.id] ?? null"
            :currency="currency"
            enable-expression
            size="sm"
            placeholder="0"
            class="w-28"
            @update:model-value="
              emit('update:memberAmount', {
                memberId: member.id,
                amount: $event,
              })
            "
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
</template>
