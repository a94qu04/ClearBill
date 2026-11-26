import { describe, expect, it, vi } from 'vitest'
import { migrateLoadedLedgerRecords } from '@/core/migrationEngine'
import { CURRENT_SCHEMA_VERSION } from '@/schemas/ledgerSchema'

const VALID_PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VALID_PROJECT_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const VALID_TX_ID = '11111111-1111-4111-8111-111111111111'
const VALID_TX_ID_2 = '22222222-2222-4222-8222-222222222222'

describe('migrationEngine - migrateLoadedLedgerRecords（IndexedDB 啟動載入遷移與隔離）', () => {
  it('將 v0（缺 schemaVersion 或 schemaVersion=0）專案與交易自動升級至 v1 並標記回寫', () => {
    const rawV0Project = {
      id: VALID_PROJECT_ID,
      // 刻意省略 schemaVersion、baseCurrency、defaultSplitMode、isActive
      name: '早期 v0 旅遊團',
      members: [{ id: 'me', name: '我' }],
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    }

    const rawV0Tx = {
      id: VALID_TX_ID,
      schemaVersion: 0,
      projectId: VALID_PROJECT_ID,
      // 刻意省略 vaultLevel、time、exchangeRateToBase，並帶入舊版空陣列／空字串
      type: 'expense',
      amount: 1200,
      currency: 'TWD',
      categoryKey: 'cat_food',
      date: '2026-05-01',
      updatedAt: 1700000002000,
      note: '',
      links: [],
      receiptImages: [],
      splitConfig: {
        payerId: 'me',
        mode: 'equal',
        shares: [{ memberId: 'me', finalAmount: 1200 }],
      },
    }

    const result = migrateLoadedLedgerRecords([rawV0Project], [rawV0Tx])

    expect(result.quarantined).toHaveLength(0)
    expect(result.projects).toHaveLength(1)
    expect(result.transactions).toHaveLength(1)
    expect(result.upgradedProjects).toHaveLength(1)
    expect(result.upgradedTransactions).toHaveLength(1)

    expect(result.projects[0]).toMatchObject({
      id: VALID_PROJECT_ID,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      baseCurrency: 'TWD',
      defaultSplitMode: 'equal',
      isActive: true,
    })

    expect(result.transactions[0]).toMatchObject({
      id: VALID_TX_ID,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      vaultLevel: 'normal',
      time: '00:00',
      exchangeRateToBase: 1,
    })
    expect(result.transactions[0].note).toBeUndefined()
    expect(result.transactions[0].links).toBeUndefined()
    expect(result.transactions[0].receiptImages).toBeUndefined()
  })

  it('已是當前版本（v1）之正常紀錄不會重複列入 upgraded 回寫清單', () => {
    const rawV1Project = {
      id: VALID_PROJECT_ID,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      name: '現行 v1 專案',
      baseCurrency: 'JPY',
      members: [{ id: 'me', name: '我' }],
      defaultSplitMode: 'equal',
      isActive: true,
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    }

    const rawV1Tx = {
      id: VALID_TX_ID,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projectId: VALID_PROJECT_ID,
      vaultLevel: 'normal',
      type: 'expense',
      amount: 500,
      currency: 'JPY',
      exchangeRateToBase: 1,
      categoryKey: 'cat_food',
      date: '2026-05-02',
      time: '12:30',
      updatedAt: 1700000002000,
    }

    const result = migrateLoadedLedgerRecords([rawV1Project], [rawV1Tx])

    expect(result.quarantined).toHaveLength(0)
    expect(result.projects).toHaveLength(1)
    expect(result.transactions).toHaveLength(1)
    expect(result.upgradedProjects).toHaveLength(0)
    expect(result.upgradedTransactions).toHaveLength(0)
  })

  it('損毀紀錄或不支援之未來版本會被隔離，且不阻斷其餘正常專案與交易載入', () => {
    const validProject = {
      id: VALID_PROJECT_ID,
      schemaVersion: 0,
      name: '正常專案',
      members: [{ id: 'me', name: '我' }],
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    }
    const futureProject = {
      id: VALID_PROJECT_ID_2,
      schemaVersion: CURRENT_SCHEMA_VERSION + 10,
      name: '未來版本專案',
      members: [{ id: 'me', name: '我' }],
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    }
    const corruptedProject = {
      id: 'not-a-uuid',
      name: '',
      members: [],
    }

    const validTx = {
      id: VALID_TX_ID,
      projectId: VALID_PROJECT_ID,
      type: 'expense',
      amount: 300,
      currency: 'TWD',
      categoryKey: 'cat_food',
      date: '2026-05-03',
      updatedAt: 1700000003000,
    }
    const corruptedTx = {
      id: VALID_TX_ID_2,
      schemaVersion: 1,
      type: 'expense',
      amount: -999,
      currency: 'TWD',
      categoryKey: 'cat_food',
      date: '2026-05-03',
      updatedAt: 1700000004000,
    }

    const result = migrateLoadedLedgerRecords(
      [validProject, futureProject, corruptedProject, null],
      [validTx, corruptedTx, 'unexpected-string'],
    )

    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].id).toBe(VALID_PROJECT_ID)
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].id).toBe(VALID_TX_ID)

    expect(result.quarantined).toHaveLength(5)
    expect(
      result.quarantined.filter((q) => q.entityType === 'project'),
    ).toHaveLength(3)
    expect(
      result.quarantined.filter((q) => q.entityType === 'transaction'),
    ).toHaveLength(2)

    const futureRecord = result.quarantined.find(
      (q) => q.id === VALID_PROJECT_ID_2,
    )
    expect(futureRecord?.error).toContain('ERR_UNSUPPORTED_SCHEMA_VERSION')

    const nullProjectRecord = result.quarantined.find(
      (q) => q.entityType === 'project' && q.id === undefined,
    )
    expect(nullProjectRecord?.error).toContain('ERR_INVALID_PAYLOAD')
  })

  it('預設寬鬆模式容許歷史拆帳尾差並可觸發回呼；嚴格模式則予以隔離', () => {
    const legacyImbalancedTx = {
      id: VALID_TX_ID,
      projectId: VALID_PROJECT_ID,
      type: 'expense',
      amount: 1000,
      currency: 'TWD',
      categoryKey: 'cat_food',
      date: '2026-05-04',
      updatedAt: 1700000005000,
      splitConfig: {
        payerId: 'me',
        mode: 'custom_plus_equal',
        shares: [
          { memberId: 'me', finalAmount: 400 },
          { memberId: 'amy', finalAmount: 400 },
        ],
      },
    }

    const onViolation = vi.fn()
    const lenient = migrateLoadedLedgerRecords([], [legacyImbalancedTx], {
      onSplitInvariantViolation: onViolation,
    })
    expect(lenient.transactions).toHaveLength(1)
    expect(lenient.quarantined).toHaveLength(0)
    expect(onViolation).toHaveBeenCalledTimes(1)

    const strict = migrateLoadedLedgerRecords([], [legacyImbalancedTx], {
      strictSplitInvariant: true,
    })
    expect(strict.transactions).toHaveLength(0)
    expect(strict.quarantined).toHaveLength(1)
    expect(strict.quarantined[0].error).toContain('ERR_SPLIT_INVARIANT_VIOLATION')
  })
})
