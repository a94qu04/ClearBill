import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettlementViewStore } from '@/stores/settlementViewStore'
import { useUserPrefsStore } from '@/stores/userPrefsStore'
import type { Project, Transaction } from '@/schemas/ledgerSchema'

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    schemaVersion: 1,
    name: '大阪美食團',
    baseCurrency: 'JPY',
    members: [
      { id: 'm1', name: '小明' },
      { id: 'm2', name: '小美' },
    ],
    defaultSplitMode: 'equal',
    defaultPayerId: 'm1',
    isActive: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('settlementViewStore - 本機結算視角與舊欄位遷移', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('migrateLegacyProjectViews 一次性遷移舊欄位，並不覆寫已存在之本機視角', () => {
    const settleStore = useSettlementViewStore()
    const legacyProject = createProject({
      id: '22222222-2222-4222-8222-222222222222',
      settlementCurrency: 'TWD',
      settlementRateMode: 'custom',
      settlementCustomRates: { JPY: 0.212 },
    })

    const count1 = settleStore.migrateLegacyProjectViews([legacyProject])
    expect(count1).toBe(1)
    expect(settleStore.getProjectSettlementCurrency(legacyProject)).toBe('TWD')
    expect(settleStore.getProjectSettlementRateMode(legacyProject)).toBe('custom')
    expect(
      settleStore.getProjectCustomRatesForTarget(legacyProject, 'TWD'),
    ).toEqual({ JPY: 0.212 })

    // 再次呼叫應為冪等（回傳 0）
    expect(settleStore.migrateLegacyProjectViews([legacyProject])).toBe(0)
  })

  it('切換結帳幣別與自訂匯率會保留各目標幣別分桶，且雙向匯率互為倒數', async () => {
    const prefs = useUserPrefsStore()
    const settleStore = useSettlementViewStore()
    const project = createProject()
    const txs: Transaction[] = [
      {
        id: '33333333-3333-4333-8333-333333333333',
        schemaVersion: 1,
        projectId: project.id,
        vaultLevel: 'normal',
        type: 'expense',
        amount: 10000,
        currency: 'JPY',
        exchangeRateToBase: 1,
        categoryKey: 'cat_food',
        date: '2026-11-26',
        time: '12:00',
        updatedAt: 1_700_000_001_000,
        splitConfig: {
          payerId: 'm1',
          mode: 'equal',
          shares: [
            { memberId: 'm1', finalAmount: 5000 },
            { memberId: 'm2', finalAmount: 5000 },
          ],
        },
      },
    ]

    settleStore.bindDataSource({
      findNonDeletedProject: (id) => (id === project.id ? project : undefined),
      getVisibleProjectTransactions: (id) => (id === project.id ? txs : []),
    })
    prefs.rememberExchangeRate('JPY', 'TWD', 0.21)

    await settleStore.updateProjectSettlementCurrency(project.id, 'TWD')
    await settleStore.updateProjectSettlementRateConfig(project.id, 'custom', {
      JPY: 0.225,
    })

    const resolved = settleStore.getProjectSettlementOptions(project)
    expect(resolved.settlementCurrency).toBe('TWD')
    expect(resolved.mode).toBe('custom')
    expect(resolved.baseToSettlement).toEqual({ rate: 0.225, source: 'custom' })
    expect(resolved.settlementToBase.rate).toBeCloseTo(1 / 0.225, 10)
    expect(resolved.options.overrideRatesByCurrency).toEqual({ JPY: 0.225 })

    // 切到 USD 再切回 TWD，TWD 自訂匯率分桶應完整保留
    await settleStore.updateProjectSettlementCurrency(project.id, 'USD')
    expect(settleStore.getProjectSettlementRateMode(project)).toBe('live')

    await settleStore.updateProjectSettlementCurrency(project.id, 'TWD')
    expect(
      settleStore.getProjectCustomRatesForTarget(project, 'TWD'),
    ).toEqual({ JPY: 0.225 })
  })
})
