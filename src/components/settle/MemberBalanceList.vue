<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ArrowUpDown, ChevronRight } from 'lucide-vue-next'
import type { Project } from '@/schemas/ledgerSchema'
import type { MemberNetBalance } from '@/core/settleUpEngine'
import { isPoolMemberId } from '@/core/poolFund'
import { formatCurrencyAmount } from '@/core/currency'
import MemberAvatar from '@/components/MemberAvatar.vue'

export interface MemberBalanceRow {
  balance: MemberNetBalance
  baseBalance: MemberNetBalance | null
}

interface Props {
  project: Project
  memberBalanceRows: MemberBalanceRow[]
  selectedMemberDetailId: string | null
  settlementCurrency: string
  isCrossCurrencySettlement: boolean
  myMemberId?: string
  memberSortMode: 'project' | 'net_desc'
}

const props = withDefaults(defineProps<Props>(), {
  myMemberId: undefined,
})

const emit = defineEmits<{
  (e: 'update:memberSortMode', mode: 'project' | 'net_desc'): void
  (e: 'toggleMemberDetail', memberId: string): void
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

function getMemberColor(memberId: string): string {
  return (
    props.project.members.find((m) => m.id === memberId)?.avatarColor ??
    '#10b981'
  )
}
</script>

<template>
  <section class="rounded-2xl bg-white p-4 shadow-sm dark:bg-[#1C1C1E]">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h3 class="text-sm font-bold text-slate-900 dark:text-white">
        {{ t('settle.balancesTitle') }}
      </h3>
      <button
        v-if="memberBalanceRows.length >= 5"
        type="button"
        class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:text-emerald-600 dark:bg-[#2C2C2E] dark:text-slate-300"
        @click="
          emit(
            'update:memberSortMode',
            memberSortMode === 'project' ? 'net_desc' : 'project',
          )
        "
      >
        <ArrowUpDown class="h-3 w-3" />
        <span>{{
          memberSortMode === 'project'
            ? t('settle.sortByMemberOrder')
            : t('settle.sortByNetAmount')
        }}</span>
      </button>
    </div>

    <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      <button
        v-for="{ balance: bal, baseBalance } in memberBalanceRows"
        :key="bal.memberId"
        type="button"
        class="overflow-hidden rounded-2xl p-3 text-left transition active:scale-[0.99]"
        :class="
          selectedMemberDetailId === bal.memberId
            ? 'bg-emerald-500/10 ring-2 ring-emerald-500/60 dark:bg-emerald-500/15'
            : 'bg-[#F2F2F7]/75 hover:bg-[#F2F2F7] dark:bg-[#2C2C2E]/70 dark:hover:bg-[#2C2C2E]'
        "
        @click="emit('toggleMemberDetail', bal.memberId)"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <MemberAvatar
              :name="getMemberName(bal.memberId)"
              :color="getMemberColor(bal.memberId)"
              :image="project.members.find((m) => m.id === bal.memberId)?.avatarImage"
              size="sm"
            />
            <span class="truncate text-sm font-bold text-slate-900 dark:text-white">
              {{ getMemberName(bal.memberId) }}
            </span>
            <span
              v-if="myMemberId && bal.memberId === myMemberId"
              class="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:text-emerald-300"
            >
              {{ t('settle.meBadge') }}
            </span>
          </div>

          <div class="text-right">
            <div
              class="text-sm font-bold tabular-nums"
              :class="
                bal.netAmount > 0
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : bal.netAmount < 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-slate-400'
              "
            >
              {{ bal.netAmount > 0 ? '+' : '' }}{{ fmt(bal.netAmount, settlementCurrency) }}
            </div>
            <div
              v-if="isCrossCurrencySettlement && baseBalance"
              class="text-[10px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
            >
              {{ baseBalance.netAmount > 0 ? '+' : '' }}{{ fmt(baseBalance.netAmount, project.baseCurrency) }}
            </div>
            <div class="text-[10px] font-medium text-slate-400 dark:text-slate-500">
              {{
                bal.netAmount > 0
                  ? t('settle.shouldReceive')
                  : bal.netAmount < 0
                    ? t('settle.shouldPay')
                    : t('settle.settled')
              }}
            </div>
          </div>
        </div>

        <div class="mt-2.5 grid grid-cols-2 gap-2 border-t border-black/[0.06] pt-2 text-[11px] dark:border-white/10">
          <div>
            <span class="text-slate-400 dark:text-slate-500">{{ t('settle.memberTotalExpense') }}</span>
            <div class="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {{ fmt(bal.totalExpense, settlementCurrency) }}
            </div>
            <div
              v-if="isCrossCurrencySettlement && baseBalance"
              class="text-[10px] tabular-nums text-slate-400"
            >
              {{ fmt(baseBalance.totalExpense, project.baseCurrency) }}
            </div>
          </div>
          <div class="text-right">
            <span class="text-slate-400 dark:text-slate-500">{{ t('settle.memberTotalPaid') }}</span>
            <div class="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
              {{ fmt(bal.totalPaid, settlementCurrency) }}
            </div>
            <div
              v-if="isCrossCurrencySettlement && baseBalance"
              class="text-[10px] tabular-nums text-slate-400"
            >
              {{ fmt(baseBalance.totalPaid, project.baseCurrency) }}
            </div>
          </div>
        </div>

        <div class="mt-1.5 flex items-center justify-end gap-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
          <span>{{
            selectedMemberDetailId === bal.memberId
              ? t('settle.hideMemberDetails')
              : t('settle.viewMemberDetails')
          }}</span>
          <ChevronRight
            class="h-3 w-3 transition-transform"
            :class="selectedMemberDetailId === bal.memberId ? 'rotate-90' : ''"
          />
        </div>
      </button>
    </div>

    <slot name="statement" />
  </section>
</template>
