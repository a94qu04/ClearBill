import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Project, Transaction } from '@/schemas/ledgerSchema'

const mockProjects = new Map<string, Project>()
const mockTransactions = new Map<string, Transaction>()

vi.mock('@/db/normalVaultDb', () => ({
  normalVaultDb: {
    projects: {
      toArray: vi.fn(async () => Array.from(mockProjects.values())),
      bulkPut: vi.fn(async (items: Project[]) => {
        for (const p of items) mockProjects.set(p.id, p)
      }),
      delete: vi.fn(async (id: string) => {
        mockProjects.delete(id)
      }),
      bulkDelete: vi.fn(async (ids: string[]) => {
        for (const id of ids) mockProjects.delete(id)
      }),
    },
    transactions: {
      toArray: vi.fn(async () => Array.from(mockTransactions.values())),
      bulkPut: vi.fn(async (items: Transaction[]) => {
        for (const t of items) mockTransactions.set(t.id, t)
      }),
      delete: vi.fn(async (id: string) => {
        mockTransactions.delete(id)
      }),
      bulkDelete: vi.fn(async (ids: string[]) => {
        for (const id of ids) mockTransactions.delete(id)
      }),
    },
    syncOutbox: {
      toArray: vi.fn(async () => []),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          toArray: vi.fn(async () => []),
          delete: vi.fn(async () => 0),
        })),
      })),
    },
  },
  saveProjectToNormalVault: vi.fn(async (project: Project) => {
    mockProjects.set(project.id, project)
    return project
  }),
  saveTransactionToNormalVault: vi.fn(async (tx: Transaction) => {
    mockTransactions.set(tx.id, tx)
    return tx
  }),
  enqueueSyncOutbox: vi.fn(async () => {}),
  listSyncOutbox: vi.fn(async () => []),
  removeSyncOutboxIfNotNewer: vi.fn(async () => true),
  clearProjectSyncOutbox: vi.fn(async () => {}),
}))

import { useLedgerStore } from '@/stores/ledgerStore'
import { GoogleDriveSyncError } from '@/services/googleDriveSync'
import { FirestoreSyncError } from '@/services/firestoreSyncService'

describe('ledgerStore - 核心業務動作整合測試', () => {
  beforeEach(() => {
    mockProjects.clear()
    mockTransactions.clear()
    setActivePinia(createPinia())
  })

  it('建立專案、記帳、結算、軟刪除與復原完整閉環', async () => {
    const store = useLedgerStore()
    const project = await store.createProject({
      name: '九州自駕',
      baseCurrency: 'JPY',
      memberNames: ['小明', '小華'],
    })

    expect(store.activeProjectId).toBe(project.id)
    const [m1, m2] = project.members

    const tx = await store.addTransaction({
      projectId: project.id,
      type: 'expense',
      amount: 6000,
      currency: 'JPY',
      exchangeRateToBase: 1,
      categoryKey: 'cat_food',
      date: '2026-11-26',
      time: '19:00',
      note: '博多拉麵',
      splitConfig: {
        payerId: m1.id,
        mode: 'equal',
        shares: [
          { memberId: m1.id, finalAmount: 3000 },
          { memberId: m2.id, finalAmount: 3000 },
        ],
      },
    })

    expect(store.getProjectTotalExpense(project.id)).toBe(6000)
    expect(store.activeProjectSettleUp?.transfers).toEqual([
      {
        fromMemberId: m2.id,
        toMemberId: m1.id,
        amount: 3000,
        currency: 'JPY',
      },
    ])

    // 軟刪除後結算歸零、進入回收桶
    await store.softDeleteTransaction(tx.id)
    expect(store.getProjectTotalExpense(project.id)).toBe(0)
    expect(store.deletedTransactions.some((t) => t.id === tx.id)).toBe(true)

    // 復原後恢復原狀
    await store.restoreTransaction(tx.id)
    expect(store.getProjectTotalExpense(project.id)).toBe(6000)
    expect(store.deletedTransactions.some((t) => t.id === tx.id)).toBe(false)
  })

  it('公費袋批次收款建立公費成員與轉帳紀錄，並可正確辨識為公費收款交易', async () => {
    const store = useLedgerStore()
    const project = await store.createProject({
      name: '沖繩潛水團',
      baseCurrency: 'JPY',
      memberNames: ['阿明', '阿美'],
    })
    const humanIds = project.members.map((m) => m.id)

    const poolMember = await store.ensureProjectPoolMember(project.id, '公費袋')
    expect(poolMember).not.toBeNull()
    expect(poolMember?.isPool).toBe(true)

    const collectedCount = await store.batchCollectPoolFund({
      projectId: project.id,
      collectorMemberId: poolMember!.id,
      contributorMemberIds: humanIds,
      amountPerMember: 10000,
      currency: 'JPY',
      date: '2026-11-26',
    })

    expect(collectedCount).toBe(2)
    const poolTxs = store.visibleTransactions.filter((t) =>
      store.isPoolCollectionTransaction(t),
    )
    expect(poolTxs.length).toBe(1)
    expect(poolTxs[0].amount).toBe(20000)
    // 專案成員應已自動加入公費袋
    const updatedProj = store.getProjectById(project.id)
    expect(updatedProj?.members.some((m) => m.isPool)).toBe(true)
  })

  it('跨幣還款缺少匯率時必須拒絕並拋出 ERR_EXCHANGE_RATE_REQUIRED', async () => {
    const store = useLedgerStore()
    const project = await store.createProject({
      name: '越南河內行',
      baseCurrency: 'TWD',
      memberNames: ['A', 'B'],
    })
    const [m1, m2] = project.members

    await expect(
      store.recordSettlementPayment({
        projectId: project.id,
        fromMemberId: m2.id,
        toMemberId: m1.id,
        amount: 500000,
        currency: 'ARS',
        date: '2026-11-26',
      }),
    ).rejects.toThrow('ERR_EXCHANGE_RATE_REQUIRED')
  })

  it('封裝之 Service 錯誤碼解析器能正確辨識 Drive 與 Firestore 錯誤', () => {
    const store = useLedgerStore()
    expect(
      store.getGoogleDriveErrorCode(
        new GoogleDriveSyncError('ERR_DRIVE_NOT_FOUND'),
      ),
    ).toBe('ERR_DRIVE_NOT_FOUND')
    expect(store.getGoogleDriveErrorCode(new Error('other'))).toBeNull()

    expect(
      store.getRealtimeSyncErrorCode(
        new FirestoreSyncError('ERR_PERMISSION_DENIED'),
      ),
    ).toBe('ERR_PERMISSION_DENIED')
    expect(store.getRealtimeSyncErrorCode('plain')).toBeNull()
  })
})
