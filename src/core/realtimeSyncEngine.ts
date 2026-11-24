import {
  ShareInviteParamsSchema,
  type Project,
  type ShareInviteParams,
  type Transaction,
} from '@/schemas/ledgerSchema'

const URL_SAFE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** 單筆交易上傳 Firestore 時收據圖片總字元上限（保留安全緩衝，避免觸碰 Firestore 1MB 單文件限制） */
export const MAX_CLOUD_RECEIPT_CHARS = 620_000

/**
 * 產生高熵 URL 安全隨機碼（供 shareId 與 accessKey 使用）
 */
export function generateSecureToken(length = 24): string {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += URL_SAFE_ALPHABET[bytes[i] % URL_SAFE_ALPHABET.length]
  }
  return out
}

/**
 * 產生共享專案邀請連結（將金鑰置於 Hash Fragment 內，不經伺服器 HTTP Log 洩漏）
 */
export function buildShareInviteUrl(
  baseHref: string,
  shareId: string,
  accessKey: string,
): string {
  const validated = ShareInviteParamsSchema.parse({ shareId, accessKey })
  const cleanBase = baseHref.split('#')[0].split('?')[0]
  const params = new URLSearchParams({
    s: validated.shareId,
    k: validated.accessKey,
  })
  return `${cleanBase}#/join?${params.toString()}`
}

/**
 * 解析並嚴格驗證共享專案邀請連結（支援完整網址或 #/join?... 片段）
 */
export function parseShareInviteHash(rawUrlOrHash: string): ShareInviteParams | null {
  const trimmed = rawUrlOrHash.trim()
  if (!trimmed) return null

  const hashIdx = trimmed.indexOf('#')
  const hashPart = hashIdx !== -1 ? trimmed.slice(hashIdx + 1) : trimmed
  if (!hashPart.startsWith('/join') && !hashPart.startsWith('join')) {
    return null
  }

  const qIdx = hashPart.indexOf('?')
  if (qIdx === -1) return null

  const params = new URLSearchParams(hashPart.slice(qIdx + 1))
  const shareId = params.get('s') ?? ''
  const accessKey = params.get('k') ?? ''

  const parsed = ShareInviteParamsSchema.safeParse({ shareId, accessKey })
  return parsed.success ? parsed.data : null
}

/**
 * 準備同步至雲端的專案資料：剔除裝置私有欄位（如 syncMeta、isArchived）
 */
export function sanitizeProjectForCloud(
  project: Project,
): Omit<Project, 'syncMeta' | 'isArchived'> {
  const { syncMeta: _syncMeta, isArchived: _isArchived, ...sharedPart } = project
  return {
    ...sharedPart,
    members: project.members.map((m) => ({ ...m })),
  }
}

/**
 * 準備同步至雲端的單筆交易：確保不超過 Firestore 1MB 文件大小上限
 */
export function prepareTransactionForCloud(
  tx: Transaction,
  syncReceiptImages = true,
): { payload: Transaction; imagesOmitted: boolean } {
  let receiptImages = tx.receiptImages ? [...tx.receiptImages] : undefined
  let imagesOmitted = false

  if (!syncReceiptImages) {
    if (receiptImages && receiptImages.length > 0) {
      imagesOmitted = true
    }
    receiptImages = undefined
  } else if (receiptImages && receiptImages.length > 0) {
    const totalChars = receiptImages.reduce((sum, img) => sum + img.length, 0)
    if (totalChars > MAX_CLOUD_RECEIPT_CHARS) {
      receiptImages = undefined
      imagesOmitted = true
    }
  }

  const payload: Transaction = {
    ...tx,
    links: tx.links ? [...tx.links] : undefined,
    receiptImages,
    splitConfig: tx.splitConfig
      ? {
          ...tx.splitConfig,
          payers: tx.splitConfig.payers
            ? tx.splitConfig.payers.map((p) => ({ ...p }))
            : undefined,
          shares: tx.splitConfig.shares.map((s) => ({ ...s })),
        }
      : undefined,
  }

  return { payload, imagesOmitted }
}

export interface DeletionCircuitBreakerEvaluation {
  triggered: boolean
  localActiveCount: number
  newlyDeletedCount: number
  deletionRatio: number
}

export interface RemoteReconcileResult {
  /** 可安全直接套用至本地之遠端新增／修改交易（非刪除） */
  safeUpserts: Transaction[]
  /** 遠端要求軟刪除且時間戳較新的交易清單 */
  incomingDeletes: Transaction[]
  /** 異常大量刪除熔斷器評估結果 */
  circuitBreaker: DeletionCircuitBreakerEvaluation
}

/**
 * 遠端交易批次合併與異常大量刪除熔斷器（純 TypeScript 函式）
 * 嚴格遵守規格：
 * - 單次遠端導致新增軟刪除 >= 5 筆，或刪除比例 >= 10%（且達 2 筆以上，或本地 >= 10 筆時 >= 10%）即觸發熔斷攔截
 * - 觸發熔斷時，刪除操作不會自動套用，交由使用者決定「允許刪除」或「攔截保留並回推本地」
 */
export function reconcileRemoteTransactions(
  localProjectTxs: Transaction[],
  remoteTxs: Transaction[],
): RemoteReconcileResult {
  const localMap = new Map<string, Transaction>()
  let localActiveCount = 0

  for (const tx of localProjectTxs) {
    localMap.set(tx.id, tx)
    if (!tx.isDeleted) {
      localActiveCount += 1
    }
  }

  const safeUpserts: Transaction[] = []
  const incomingDeletes: Transaction[] = []

  for (const remoteTx of remoteTxs) {
    const localTx = localMap.get(remoteTx.id)

    if (!localTx) {
      // 本地原本就不存在且遠端標記刪除的歷史 tombstones，不計入「本地有效帳目被刪」
      safeUpserts.push(remoteTx)
      continue
    }

    // 僅接受時間戳較新的遠端變更（UUID + updatedAt 一致性規則）
    if (remoteTx.updatedAt <= localTx.updatedAt) {
      continue
    }

    if (!localTx.isDeleted && remoteTx.isDeleted) {
      incomingDeletes.push(remoteTx)
    } else {
      safeUpserts.push(remoteTx)
    }
  }

  const newlyDeletedCount = incomingDeletes.length
  const deletionRatio =
    localActiveCount > 0 ? newlyDeletedCount / localActiveCount : 0

  const triggered =
    newlyDeletedCount >= 5 ||
    (localActiveCount >= 10 && deletionRatio >= 0.1) ||
    (localActiveCount > 0 && newlyDeletedCount >= 2 && deletionRatio >= 0.1)

  return {
    safeUpserts,
    incomingDeletes,
    circuitBreaker: {
      triggered,
      localActiveCount,
      newlyDeletedCount,
      deletionRatio: Number(deletionRatio.toFixed(4)),
    },
  }
}
