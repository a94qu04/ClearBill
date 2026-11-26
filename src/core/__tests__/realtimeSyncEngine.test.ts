import { describe, expect, it } from 'vitest'
import {
  buildShareInviteUrl,
  dequeuePendingDeletionGuard,
  enqueuePendingDeletionGuard,
  filterApprovableRemoteDeletes,
  generateSecureToken,
  MAX_CLOUD_RECEIPT_CHARS,
  mergeRemoteProjectPreservingLocalFields,
  parseShareInviteHash,
  prepareTransactionForCloud,
  reconcileRemoteTransactions,
  resolvePreservedLocalDefaultPayerId,
  sanitizeProjectForCloud,
  type PendingDeletionGuardEntry,
} from '@/core/realtimeSyncEngine'
import type { Project, Transaction } from '@/schemas/ledgerSchema'

function makeTx(
  idSuffix: string,
  overrides: Partial<Transaction> = {},
): Transaction {
  return {
    id: `00000000-0000-4000-8000-${idSuffix.padStart(12, '0')}`,
    schemaVersion: 1,
    projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    vaultLevel: 'normal',
    type: 'expense',
    amount: 500,
    currency: 'TWD',
    exchangeRateToBase: 1,
    categoryKey: 'cat_food',
    date: '2026-11-24',
    time: '12:00',
    updatedAt: 1700000001000,
    ...overrides,
  }
}

describe('realtimeSyncEngine - 邀請連結、熔斷器與雲端序列化', () => {
  it('能產生高熵安全金鑰並正確編解碼 #/join 邀請連結', () => {
    const shareId = generateSecureToken(16)
    const accessKey = generateSecureToken(24)
    expect(shareId).toHaveLength(16)
    expect(accessKey).toHaveLength(24)

    const url = buildShareInviteUrl(
      'https://example.github.io/ClearBill/',
      shareId,
      accessKey,
    )
    expect(url).toContain('#/join?')
    const parsed = parseShareInviteHash(url)
    expect(parsed).toEqual({ shareId, accessKey })

    // 非法或過短金鑰應拒絕解析
    expect(parseShareInviteHash('#/join?s=abc&k=short')).toBeNull()
    expect(parseShareInviteHash('#/quick-add?amount=100')).toBeNull()
  })

  it('異常大量刪除熔斷器：單次遠端刪除 >= 5 筆應自動攔截', () => {
    const localTxs = Array.from({ length: 60 }, (_, idx) =>
      makeTx(String(idx + 1)),
    )
    // 遠端一次刪除 5 筆（雖佔比 8.3% < 10%，但筆數 >= 5 必須觸發熔斷）
    const remoteDeletes = localTxs.slice(0, 5).map((tx) => ({
      ...tx,
      isDeleted: true,
      updatedAt: tx.updatedAt + 5000,
    }))

    const result = reconcileRemoteTransactions(localTxs, remoteDeletes)
    expect(result.circuitBreaker.triggered).toBe(true)
    expect(result.circuitBreaker.newlyDeletedCount).toBe(5)
    expect(result.incomingDeletes).toHaveLength(5)
  })

  it('異常大量刪除熔斷器：單次遠端刪除達 >= 10% 應自動攔截', () => {
    const localTxs = Array.from({ length: 20 }, (_, idx) =>
      makeTx(String(idx + 1)),
    )
    // 20 筆中一次刪除 2 筆 = 10% -> 觸發熔斷
    const remoteDeletes = localTxs.slice(0, 2).map((tx) => ({
      ...tx,
      isDeleted: true,
      updatedAt: tx.updatedAt + 5000,
    }))

    const result = reconcileRemoteTransactions(localTxs, remoteDeletes)
    expect(result.circuitBreaker.triggered).toBe(true)
    expect(result.circuitBreaker.deletionRatio).toBe(0.1)
  })

  it('正常單筆刪除與遠端新增／修改不觸發熔斷，且忽略較舊 updatedAt', () => {
    const localTxs = Array.from({ length: 12 }, (_, idx) =>
      makeTx(String(idx + 1)),
    )
    const remoteBatch: Transaction[] = [
      // 1 筆刪除（1/12 = 8.3% < 10%，不應熔斷）
      { ...localTxs[0], isDeleted: true, updatedAt: localTxs[0].updatedAt + 1000 },
      // 1 筆較舊更新（應略過）
      { ...localTxs[1], amount: 999, updatedAt: localTxs[1].updatedAt - 100 },
      // 1 筆遠端新增
      makeTx('99', { amount: 1200, updatedAt: 1700000009000 }),
    ]

    const result = reconcileRemoteTransactions(localTxs, remoteBatch)
    expect(result.circuitBreaker.triggered).toBe(false)
    expect(result.incomingDeletes).toHaveLength(1)
    expect(result.safeUpserts).toHaveLength(1)
    expect(result.safeUpserts[0].amount).toBe(1200)

    // 專案剛好有 10 筆時，正常刪除 1 筆不應誤觸熔斷器
    const exactlyTen = Array.from({ length: 10 }, (_, idx) =>
      makeTx(String(idx + 20)),
    )
    const oneDeleteRes = reconcileRemoteTransactions(exactlyTen, [
      {
        ...exactlyTen[0],
        isDeleted: true,
        updatedAt: exactlyTen[0].updatedAt + 1000,
      },
    ])
    expect(oneDeleteRes.circuitBreaker.triggered).toBe(false)
    expect(oneDeleteRes.incomingDeletes).toHaveLength(1)
  })

  it('prepareTransactionForCloud 會在收據圖片過大或關閉同步時安全略過圖片', () => {
    const hugeImage = `data:image/jpeg;base64,${'A'.repeat(MAX_CLOUD_RECEIPT_CHARS + 10)}`
    const tx = makeTx('1', { receiptImages: [hugeImage] })

    const resOverLimit = prepareTransactionForCloud(tx, true)
    expect(resOverLimit.imagesOmitted).toBe(true)
    expect(resOverLimit.payload.receiptImages).toBeUndefined()

    const normalTx = makeTx('2', { receiptImages: ['data:image/jpeg;base64,abc'] })
    const resKeep = prepareTransactionForCloud(normalTx, true)
    expect(resKeep.imagesOmitted).toBe(false)
    expect(resKeep.payload.receiptImages).toHaveLength(1)

    const resDisabled = prepareTransactionForCloud(normalTx, false)
    expect(resDisabled.imagesOmitted).toBe(true)
    expect(resDisabled.payload.receiptImages).toBeUndefined()
  })

  it('待決刪除熔斷佇列：多專案依 projectId FIFO 排隊，不覆寫前一筆待決；同專案重複觸發則原地合併去重', () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    const txA1 = makeTx('1', { projectId: projectA, isDeleted: true, updatedAt: 2000 })
    const txA2 = makeTx('2', { projectId: projectA, isDeleted: true, updatedAt: 2000 })
    const txB1 = makeTx('3', { projectId: projectB, isDeleted: true, updatedAt: 3000 })
    const txB2 = makeTx('4', { projectId: projectB, isDeleted: true, updatedAt: 3000 })

    let queue: PendingDeletionGuardEntry[] = []
    queue = enqueuePendingDeletionGuard(queue, {
      projectId: projectA,
      projectName: '東京團',
      localActiveCount: 10,
      newlyDeletedCount: 2,
      deletionRatio: 0.2,
      pendingDeletes: [txA1, txA2],
    })
    queue = enqueuePendingDeletionGuard(queue, {
      projectId: projectB,
      projectName: '大阪團',
      localActiveCount: 10,
      newlyDeletedCount: 2,
      deletionRatio: 0.2,
      pendingDeletes: [txB1, txB2],
    })

    // A 與 B 皆保留，且維持 FIFO 順序
    expect(queue).toHaveLength(2)
    expect(queue[0].projectId).toBe(projectA)
    expect(queue[1].projectId).toBe(projectB)

    // 同專案 A 再次觸發：包含 txA2 較新刪除時間戳與新增 txA3，應原地合併且不搶走順序
    const txA2Newer = { ...txA2, updatedAt: 5000 }
    const txA3 = makeTx('5', { projectId: projectA, isDeleted: true, updatedAt: 5000 })
    queue = enqueuePendingDeletionGuard(queue, {
      projectId: projectA,
      projectName: '東京團（改名）',
      localActiveCount: 10,
      newlyDeletedCount: 2,
      deletionRatio: 0.2,
      pendingDeletes: [txA2Newer, txA3],
    })

    expect(queue).toHaveLength(2)
    expect(queue[0].projectId).toBe(projectA)
    expect(queue[0].projectName).toBe('東京團（改名）')
    expect(queue[0].newlyDeletedCount).toBe(3)
    expect(queue[0].deletionRatio).toBe(0.3)
    expect(queue[0].pendingDeletes.find((t) => t.id === txA2.id)?.updatedAt).toBe(5000)

    // 指定 projectId 移除 B 不影響 A
    const removedB = dequeuePendingDeletionGuard(queue, projectB)
    expect(removedB.removed?.projectId).toBe(projectB)
    expect(removedB.nextQueue.map((item) => item.projectId)).toEqual([projectA])

    // 未指定 projectId 時移除隊首
    const removedHead = dequeuePendingDeletionGuard(removedB.nextQueue)
    expect(removedHead.removed?.projectId).toBe(projectA)
    expect(removedHead.nextQueue).toHaveLength(0)
  })

  it('filterApprovableRemoteDeletes：核准前本地已編輯更新的交易不得被過期刪除覆寫', () => {
    const baseTx1 = makeTx('1', { amount: 500, updatedAt: 1000 })
    const baseTx2 = makeTx('2', { amount: 800, updatedAt: 1000 })
    const baseTx3 = makeTx('3', { amount: 300, updatedAt: 1000 })
    const baseTx4 = makeTx('4', { amount: 400, updatedAt: 1000 })

    // 當初被熔斷攔截的遠端刪除批次（updatedAt = 2000）
    const pendingDeletes: Transaction[] = [
      { ...baseTx1, isDeleted: true, updatedAt: 2000 },
      { ...baseTx2, isDeleted: true, updatedAt: 2000 },
      { ...baseTx3, isDeleted: true, updatedAt: 2000 },
      { ...baseTx4, isDeleted: true, updatedAt: 2000 },
    ]

    // 在使用者點選「允許刪除」之前：
    // - tx1 本地未變動（updatedAt 1000 < 2000）→ 應允許套用刪除
    // - tx2 本地已被編輯（updatedAt 3500 > 2000）→ 不可被過期刪除覆蓋
    // - tx3 本地已被設為相同時間戳（updatedAt 2000 === 2000）→ 不可覆蓋
    // - tx4 本地已被軟刪除 → 不需重複套用
    const currentLocalTxs: Transaction[] = [
      baseTx1,
      { ...baseTx2, amount: 999, note: '本地已修改', updatedAt: 3500 },
      { ...baseTx3, amount: 350, updatedAt: 2000 },
      { ...baseTx4, isDeleted: true, updatedAt: 1500 },
    ]

    const approvable = filterApprovableRemoteDeletes(currentLocalTxs, pendingDeletes)
    expect(approvable).toHaveLength(1)
    expect(approvable[0].id).toBe(baseTx1.id)
    expect(approvable[0].isDeleted).toBe(true)
  })

  it('defaultPayerId 本機裝置偏好：雲端清理會剔除 defaultPayerId，遠端合併保留本機公費優先且成員移除時安全回退', () => {
    const baseProject: Project = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      schemaVersion: 1,
      name: '2026 東京自由行',
      baseCurrency: 'JPY',
      members: [
        { id: 'alice', name: '愛麗絲', avatarColor: '#10b981' },
        { id: 'bob', name: '鮑伯', avatarColor: '#3b82f6' },
        { id: 'pool_1', name: '公費袋', avatarColor: '#f59e0b', isPool: true },
      ],
      defaultSplitMode: 'equal',
      defaultPayerId: 'pool_1',
      isActive: true,
      isArchived: true,
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      syncMeta: {
        mode: 'firestore',
        shareId: 'share_pool_test_01',
        accessKey: 'secret_pool_test_key_01',
        role: 'owner',
        myMemberId: 'alice',
        syncReceiptImages: true,
        lastSyncedAt: 1700000001000,
      },
    }

    // 1. sanitizeProjectForCloud 應剔除 syncMeta、isArchived 與 defaultPayerId，且不修改原物件
    const cloudPayload = sanitizeProjectForCloud(baseProject) as Partial<Project>
    expect(cloudPayload.syncMeta).toBeUndefined()
    expect(cloudPayload.isArchived).toBeUndefined()
    expect(cloudPayload.defaultPayerId).toBeUndefined()
    expect(baseProject.defaultPayerId).toBe('pool_1')

    // 2. 遠端更新專案名稱（即使夾帶他機 defaultPayerId: 'bob'），應保留本機公費優先 'pool_1' 而非被 myMemberId 覆寫
    const remoteRenamed: Project = {
      ...baseProject,
      name: '2026 東京賞櫻行',
      defaultPayerId: 'bob',
      isArchived: false,
      syncMeta: undefined,
      updatedAt: 1700000009000,
    }
    const mergedKeepPool = mergeRemoteProjectPreservingLocalFields(
      baseProject,
      remoteRenamed,
      1700000010000,
    )
    expect(mergedKeepPool.name).toBe('2026 東京賞櫻行')
    expect(mergedKeepPool.defaultPayerId).toBe('pool_1')
    expect(mergedKeepPool.isArchived).toBe(true)
    expect(mergedKeepPool.syncMeta?.myMemberId).toBe('alice')
    expect(mergedKeepPool.syncMeta?.lastSyncedAt).toBe(1700000010000)

    // 3. 若遠端移除本機原本指定的 defaultPayerId 成員，應安全回退至 myMemberId
    const remoteWithoutPool: Project = {
      ...remoteRenamed,
      members: [
        { id: 'alice', name: '愛麗絲', avatarColor: '#10b981' },
        { id: 'bob', name: '鮑伯', avatarColor: '#3b82f6' },
      ],
    }
    const mergedFallbackMyMember = mergeRemoteProjectPreservingLocalFields(
      baseProject,
      remoteWithoutPool,
      1700000011000,
    )
    expect(mergedFallbackMyMember.defaultPayerId).toBe('alice')

    // 4. 若本機 defaultPayerId 與 myMemberId 皆已不在成員清單，回退至第一位真人成員
    expect(
      resolvePreservedLocalDefaultPayerId(
        { defaultPayerId: 'gone_1', syncMeta: { mode: 'firestore', shareId: 's', accessKey: 'k', role: 'editor', myMemberId: 'gone_2' } },
        [
          { id: 'pool_1', name: '公費袋', avatarColor: '#f59e0b', isPool: true },
          { id: 'bob', name: '鮑伯', avatarColor: '#3b82f6' },
        ],
      ),
    ).toBe('bob')
  })
})
