import { describe, expect, it } from 'vitest'
import {
  buildShareInviteUrl,
  generateSecureToken,
  MAX_CLOUD_RECEIPT_CHARS,
  parseShareInviteHash,
  prepareTransactionForCloud,
  reconcileRemoteTransactions,
} from '@/core/realtimeSyncEngine'
import type { Transaction } from '@/schemas/ledgerSchema'

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
})
