import { describe, expect, it } from 'vitest'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import {
  POOL_MEMBER_ID_PREFIX,
  collectPoolMemberIds,
  extractMissingPoolMemberIdsFromTransaction,
  findLatestPoolCollectBatch,
  findOrphanedPoolMemberIdInTransactions,
  generatePoolMemberId,
  isPoolCollectionTransaction,
  isPoolMember,
  isPoolMemberId,
  isPoolMemberIdInProject,
  partitionPoolAndHumanBalances,
} from '@/core/poolFund'

function makeProject(members: Project['members']): Project {
  return {
    id: 'proj_1',
    name: '沖繩之旅',
    baseCurrency: 'TWD',
    defaultSplitMode: 'equal',
    isActive: true,
    members,
    createdAt: 1000,
    updatedAt: 1000,
    schemaVersion: 1,
  }
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx_1',
    projectId: 'proj_1',
    vaultLevel: 'normal',
    type: 'transfer',
    amount: 1000,
    currency: 'TWD',
    exchangeRateToBase: 1,
    categoryKey: 'cat_settlement',
    date: '2026-11-26',
    time: '00:00',
    note: '公費',
    updatedAt: 1000,
    schemaVersion: 1,
    splitConfig: {
      payerId: 'm1',
      mode: 'custom_plus_equal',
      shares: [
        {
          memberId: 'pool_1',
          finalAmount: 1000,
          customAmount: 1000,
          isIncludedInRemainder: false,
        },
      ],
    },
    ...overrides,
  }
}

describe('core/poolFund - 公費成員判定與餘額分區', () => {
  it('能正確以 pool_ 前綴或 isPool 旗標辨識公費成員', () => {
    expect(isPoolMemberId('pool_abc')).toBe(true)
    expect(isPoolMemberId('m1')).toBe(false)
    expect(isPoolMemberId('')).toBe(false)
    expect(isPoolMemberId(null)).toBe(false)
    expect(isPoolMemberId(undefined)).toBe(false)

    expect(isPoolMember({ id: 'custom_id', isPool: true })).toBe(true)
    expect(isPoolMember({ id: 'pool_legacy', isPool: false })).toBe(true)
    expect(isPoolMember({ id: 'm1' })).toBe(false)
    expect(isPoolMember(null)).toBe(false)

    const proj = makeProject([
      { id: 'm1', name: '小明' },
      { id: 'vault_custom', name: '公費箱', isPool: true },
    ])
    expect(isPoolMemberIdInProject('vault_custom', proj)).toBe(true)
    expect(isPoolMemberIdInProject('pool_deleted', proj)).toBe(true)
    expect(isPoolMemberIdInProject('m1', proj)).toBe(false)
    expect(isPoolMemberIdInProject('vault_custom', null)).toBe(false)

    const generated = generatePoolMemberId(1700000000000)
    expect(generated.startsWith(POOL_MEMBER_ID_PREFIX)).toBe(true)
    expect(isPoolMemberId(generated)).toBe(true)
  })

  it('collectPoolMemberIds 與 partitionPoolAndHumanBalances 涵蓋 isPool 與孤兒 pool_ 餘額', () => {
    const members: Project['members'] = [
      { id: 'm1', name: '小明' },
      { id: 'm2', name: '小華' },
      { id: 'custom_pool', name: '公費袋', isPool: true },
    ]
    const balances = [
      { memberId: 'm1', netAmount: 100 },
      { memberId: 'custom_pool', netAmount: -500 },
      { memberId: 'pool_orphan', netAmount: -200 },
      { memberId: 'm2', netAmount: 600 },
    ]

    const ids = collectPoolMemberIds(members, balances)
    expect(Array.from(ids)).toEqual(['custom_pool', 'pool_orphan'])

    const partitioned = partitionPoolAndHumanBalances(balances, members)
    expect(partitioned.poolBalances.map((b) => b.memberId)).toEqual([
      'custom_pool',
      'pool_orphan',
    ])
    expect(partitioned.humanBalances.map((b) => b.memberId)).toEqual(['m1', 'm2'])
  })
})

describe('core/poolFund - isPoolCollectionTransaction', () => {
  const project = makeProject([
    { id: 'm1', name: '小明' },
    { id: 'm2', name: '小華' },
    { id: 'custom_pool', name: '共用錢包', isPool: true },
  ])

  it('一般消費與退款不視為繳公費', () => {
    expect(
      isPoolCollectionTransaction(makeTx({ type: 'expense' }), project),
    ).toBe(false)
    expect(
      isPoolCollectionTransaction(makeTx({ type: 'refund' }), project),
    ).toBe(false)
  })

  it('單人轉帳給 pool_ 前綴或 isPool 成員視為繳公費，轉帳給真人則否', () => {
    expect(isPoolCollectionTransaction(makeTx(), project)).toBe(true)
    expect(
      isPoolCollectionTransaction(
        makeTx({
          splitConfig: {
            payerId: 'm1',
            mode: 'custom_plus_equal',
            shares: [{ memberId: 'custom_pool', finalAmount: 1000 }],
          },
        }),
        project,
      ),
    ).toBe(true)
    expect(
      isPoolCollectionTransaction(
        makeTx({
          splitConfig: {
            payerId: 'm1',
            mode: 'custom_plus_equal',
            shares: [{ memberId: 'm2', finalAmount: 1000 }],
          },
        }),
        project,
      ),
    ).toBe(false)
  })

  it('多人共同繳交之 transfer 即使收款人為真人財務長也視為繳公費', () => {
    const multiToHuman = makeTx({
      amount: 2000,
      splitConfig: {
        payerId: 'm1',
        payers: [
          { memberId: 'm1', amount: 1000 },
          { memberId: 'm2', amount: 1000 },
        ],
        mode: 'custom_plus_equal',
        shares: [{ memberId: 'm3', finalAmount: 2000 }],
      },
    })
    expect(isPoolCollectionTransaction(multiToHuman, project)).toBe(true)
  })
})

describe('core/poolFund - findLatestPoolCollectBatch（涵蓋新舊兩種批次格式）', () => {
  const poolIds = new Set(['pool_1', 'pool_2'])

  it('無公費成員或無公費存入時回傳 null', () => {
    expect(findLatestPoolCollectBatch([], poolIds)).toBeNull()
    expect(findLatestPoolCollectBatch([makeTx()], new Set())).toBeNull()
    expect(
      findLatestPoolCollectBatch(
        [
          makeTx({
            splitConfig: {
              payerId: 'm1',
              mode: 'custom_plus_equal',
              shares: [{ memberId: 'm2', finalAmount: 1000 }],
            },
          }),
        ],
        poolIds,
      ),
    ).toBeNull()
  })

  it('新版格式：能辨識單筆合併多人公費紀錄', () => {
    const olderLegacy = makeTx({
      id: 'legacy_1',
      amount: 500,
      updatedAt: 1000,
    })
    const latestMerged = makeTx({
      id: 'merged_1',
      amount: 3000,
      currency: 'JPY',
      date: '2026-11-26',
      updatedAt: 5000,
      splitConfig: {
        payerId: 'm1',
        payers: [
          { memberId: 'm1', amount: 1000 },
          { memberId: 'm2', amount: 1000 },
          { memberId: 'm3', amount: 1000 },
        ],
        mode: 'custom_plus_equal',
        shares: [{ memberId: 'pool_1', finalAmount: 3000 }],
      },
    })

    const result = findLatestPoolCollectBatch([olderLegacy, latestMerged], poolIds)
    expect(result).toEqual({
      ids: ['merged_1'],
      count: 3,
      amountPerPerson: 1000,
      totalAmount: 3000,
      currency: 'JPY',
      date: '2026-11-26',
    })
  })

  it('舊版格式：能將同日、同幣別、同金額、同備註、同公費袋的多筆單人轉帳歸為同一批，並精準加總小數幣別', () => {
    const txs: Transaction[] = [
      // 同批三筆（USD 33.33 × 3 = 99.99，驗證無浮點誤差）
      makeTx({
        id: 'old_1',
        amount: 33.33,
        currency: 'USD',
        date: '2026-11-26',
        note: '第一天公費 ',
        updatedAt: 3000,
      }),
      makeTx({
        id: 'old_2',
        amount: 33.33,
        currency: 'USD',
        date: '2026-11-26',
        note: ' 第一天公費',
        updatedAt: 2900,
        splitConfig: {
          payerId: 'm2',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'pool_1', finalAmount: 33.33 }],
        },
      }),
      makeTx({
        id: 'old_3',
        amount: 33.33,
        currency: 'USD',
        date: '2026-11-26',
        note: '第一天公費',
        updatedAt: 2800,
        splitConfig: {
          payerId: 'm3',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'pool_1', finalAmount: 33.33 }],
        },
      }),
      // 不應被併入的干擾項：不同日期、不同幣別、不同備註、不同公費袋、已刪除、新版多人合併
      makeTx({
        id: 'diff_date',
        amount: 33.33,
        currency: 'USD',
        date: '2026-11-25',
        note: '第一天公費',
        updatedAt: 2700,
      }),
      makeTx({
        id: 'diff_note',
        amount: 33.33,
        currency: 'USD',
        date: '2026-11-26',
        note: '第二天公費',
        updatedAt: 2600,
      }),
      makeTx({
        id: 'diff_pool',
        amount: 33.33,
        currency: 'USD',
        date: '2026-11-26',
        note: '第一天公費',
        updatedAt: 2500,
        splitConfig: {
          payerId: 'm4',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'pool_2', finalAmount: 33.33 }],
        },
      }),
      makeTx({
        id: 'deleted_tx',
        amount: 33.33,
        currency: 'USD',
        date: '2026-11-26',
        note: '第一天公費',
        updatedAt: 4000,
        isDeleted: true,
      }),
      makeTx({
        id: 'new_merged_same_amount',
        amount: 33.33,
        currency: 'USD',
        date: '2026-11-26',
        note: '第一天公費',
        updatedAt: 2400,
        splitConfig: {
          payerId: 'm1',
          payers: [
            { memberId: 'm1', amount: 16.66 },
            { memberId: 'm2', amount: 16.67 },
          ],
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'pool_1', finalAmount: 33.33 }],
        },
      }),
    ]

    const result = findLatestPoolCollectBatch(txs, poolIds)
    expect(result).toEqual({
      ids: ['old_1', 'old_2', 'old_3'],
      count: 3,
      amountPerPerson: 33.33,
      totalAmount: 99.99,
      currency: 'USD',
      date: '2026-11-26',
    })
  })
})

describe('core/poolFund - 孤兒公費袋 ID 偵測', () => {
  it('extractMissingPoolMemberIdsFromTransaction 會去重並排除既有成員與零金額項目', () => {
    const tx = makeTx({
      splitConfig: {
        payerId: 'pool_missing_a',
        payers: [
          { memberId: 'pool_missing_a', amount: 500 },
          { memberId: 'pool_zero', amount: 0 },
          { memberId: 'pool_existing', amount: 500 },
        ],
        mode: 'custom_plus_equal',
        shares: [
          { memberId: 'pool_missing_b', finalAmount: 1000 },
          { memberId: 'pool_zero_share', finalAmount: 0 },
          { memberId: 'm1', finalAmount: 0 },
        ],
      },
    })

    const missing = extractMissingPoolMemberIdsFromTransaction(
      tx,
      new Set(['m1', 'pool_existing']),
    )
    expect(missing).toEqual(['pool_missing_a', 'pool_missing_b'])
  })

  it('findOrphanedPoolMemberIdInTransactions 忽略已刪除與他專案交易', () => {
    const txs: Transaction[] = [
      makeTx({
        id: 'deleted_pool_tx',
        projectId: 'proj_1',
        isDeleted: true,
        splitConfig: {
          payerId: 'pool_deleted',
          mode: 'equal',
          shares: [{ memberId: 'm1', finalAmount: 100 }],
        },
      }),
      makeTx({
        id: 'other_project_tx',
        projectId: 'proj_2',
        splitConfig: {
          payerId: 'pool_other_proj',
          mode: 'equal',
          shares: [{ memberId: 'm1', finalAmount: 100 }],
        },
      }),
      makeTx({
        id: 'active_orphan_tx',
        projectId: 'proj_1',
        splitConfig: {
          payerId: 'm1',
          mode: 'custom_plus_equal',
          shares: [{ memberId: 'pool_orphan_real', finalAmount: 100 }],
        },
      }),
    ]

    expect(
      findOrphanedPoolMemberIdInTransactions(txs, 'proj_1', new Set(['m1'])),
    ).toBe('pool_orphan_real')
    expect(
      findOrphanedPoolMemberIdInTransactions(
        txs,
        'proj_1',
        new Set(['m1', 'pool_orphan_real']),
      ),
    ).toBeNull()
  })
})
