<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, X } from 'lucide-vue-next'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import { isPoolMemberId } from '@/core/poolFund'
import { formatCurrencyAmount } from '@/core/currency'
import type { SettleMemberStatementEntry } from '@/composables/useSettleExports'
import MemberAvatar from '@/components/MemberAvatar.vue'

interface Props {
  project: Project
  memberId: string
  entries: SettleMemberStatementEntry[]
  settlementCurrency: string
  isCrossCurrencySettlement: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'copyStatement', memberId: string): void
  (e: 'inspectMember', memberId: string): void
  (e: 'editExpense', tx: Transaction): void
  (e: 'close'): void
}>()

const { t, locale } = useI18n()
const sectionRef = ref<HTMLElement | null>(null)

watch(
  () => props.memberId,
  (nextId) => {
    if (!nextId) return
    void nextTick(() => {
      sectionRef.value?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    })
  },
  { immediate: true },
)

function fmt(amount: number, currency: string): string {
  return formatCurrencyAmount(amount, currency, locale.value)
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
</script>

<template>
  <div
    ref="sectionRef"
    class="mt-3 space-y-2.5 rounded-2xl bg-[#F2F2F7]/80 p-3 dark:bg-[#2C2C2E]/70"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
        <MemberAvatar
          :name="getMemberName(memberId)"
          :color="getMemberColor(memberId)"
          :image="project.members.find((m) => m.id === memberId)?.avatarImage"
          size="xs"
        />
        <span class="truncate">
          {{
            t('settle.memberStatementTitle', {
              name: getMemberName(memberId),
            })
          }}
          ({{ entries.length }})
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950"
          @click="emit('copyStatement', memberId)"
        >
          <Copy class="h-3 w-3" />
          <span>{{ t('settle.copyMemberStatementButton') }}</span>
        </button>
        <button
          type="button"
          class="text-[11px] font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
          @click="emit('inspectMember', memberId)"
        >
          {{ t('settle.openInEntriesButton') }}
        </button>
        <button
          type="button"
          :aria-label="t('settings.close')"
          class="rounded-full p-1 text-slate-400 hover:bg-white dark:hover:bg-white/10"
          @click="emit('close')"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <p
      v-if="entries.length === 0"
      class="py-3 text-center text-xs text-slate-400"
    >
      {{ t('settle.memberStatementEmpty') }}
    </p>

    <ul
      v-else
      class="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl bg-white dark:divide-white/10 dark:bg-[#1C1C1E]"
    >
      <li
        v-for="item in entries"
        :key="item.tx.id"
        class="flex items-center justify-between gap-2 px-3 py-2.5 text-xs"
      >
        <button
          type="button"
          class="min-w-0 flex-1 text-left transition hover:opacity-80"
          @click="emit('editExpense', item.tx)"
        >
          <div class="flex items-center gap-1.5">
            <span
              v-if="item.isRefund"
              class="rounded bg-teal-500/15 px-1.5 py-0.5 text-[9px] font-bold text-teal-700 dark:text-teal-300"
            >
              {{ t('project.refundBadge') }}
            </span>
            <span class="truncate font-semibold text-slate-900 dark:text-white">
              {{ item.title }}
            </span>
          </div>
          <div class="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
            {{ item.tx.date }} · {{ fmt(item.tx.amount, item.tx.currency) }}
          </div>
        </button>
        <div class="shrink-0 text-right tabular-nums">
          <div
            v-if="item.shareInSettle !== 0"
            class="text-[11px] font-semibold text-slate-900 dark:text-white"
          >
            {{ t('settle.memberTotalExpense') }}
            {{ fmt(item.shareInSettle, settlementCurrency) }}
            <span
              v-if="isCrossCurrencySettlement"
              class="block text-[9px] font-normal text-slate-400"
            >
              {{ fmt(item.shareInBase, project.baseCurrency) }}
            </span>
          </div>
          <div
            v-if="item.paidInSettle !== 0"
            class="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
          >
            {{ t('settle.memberTotalPaid') }}
            {{ fmt(item.paidInSettle, settlementCurrency) }}
            <span
              v-if="isCrossCurrencySettlement"
              class="ml-1 text-[9px] font-normal text-slate-400"
            >
              ({{ fmt(item.paidInBase, project.baseCurrency) }})
            </span>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
