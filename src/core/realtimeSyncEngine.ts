import {
  ShareInviteParamsSchema,
  type Project,
  type ProjectMember,
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
 * 準備同步至雲端的專案資料：剔除裝置私有欄位（syncMeta、isArchived、defaultPayerId）
 * - defaultPayerId 屬本機裝置偏好（例如各成員自己的預設墊付人或本機公費優先開關），不得跨裝置互相覆寫
 */
export function sanitizeProjectForCloud(
  project: Project,
): Omit<Project, 'syncMeta' | 'isArchived' | 'defaultPayerId'> {
  const {
    syncMeta: _syncMeta,
    isArchived: _isArchived,
    defaultPayerId: _defaultPayerId,
    ...sharedPart
  } = project
  return {
    ...sharedPart,
    members: project.members.map((m) => ({ ...m })),
  }
}

/**
 * 合併遠端或外部備份之專案時，安全保留本機裝置偏好的 defaultPayerId：
 * 1. 若本機原本的 defaultPayerId 仍存在於最新成員清單中，優先保留（含本機「公費袋優先」設定）
 * 2. 否則若本機已認領之 syncMeta.myMemberId 仍存在於最新成員清單中，回退至 myMemberId
 * 3. 否則若傳入之 fallbackDefaultPayerId 存在於最新成員清單中，採用之（向下相容舊版資料）
 * 4. 最後回退至第一位真人成員或第一位成員
 */
export function resolvePreservedLocalDefaultPayerId(
  localProj: Pick<Project, 'defaultPayerId' | 'syncMeta'>,
  incomingMembers: readonly ProjectMember[],
  fallbackDefaultPayerId?: string,
): string | undefined {
  const hasMember = (id: string | undefined): id is string =>
    Boolean(id && incomingMembers.some((m) => m.id === id))

  if (hasMember(localProj.defaultPayerId)) {
    return localProj.defaultPayerId
  }
  const myMemberId = localProj.syncMeta?.myMemberId
  if (hasMember(myMemberId)) {
    return myMemberId
  }
  if (hasMember(fallbackDefaultPayerId)) {
    return fallbackDefaultPayerId
  }
  return incomingMembers.find((m) => !m.isPool)?.id ?? incomingMembers[0]?.id
}

/**
 * 將 Firestore 遠端專案更新合併回本機專案，完整保留所有裝置私有欄位（isArchived、syncMeta、defaultPayerId）
 */
export function mergeRemoteProjectPreservingLocalFields(
  localProj: Project,
  remoteProject: Project,
  syncedAt = Date.now(),
): Project {
  const sanitizedRemote = sanitizeProjectForCloud(remoteProject)
  const resolvedDefaultPayerId = resolvePreservedLocalDefaultPayerId(
    localProj,
    sanitizedRemote.members,
    remoteProject.defaultPayerId,
  )

  return {
    ...sanitizedRemote,
    id: localProj.id,
    ...(localProj.isArchived !== undefined ? { isArchived: localProj.isArchived } : {}),
    ...(resolvedDefaultPayerId !== undefined
      ? { defaultPayerId: resolvedDefaultPayerId }
      : {}),
    syncMeta: localProj.syncMeta
      ? { ...localProj.syncMeta, lastSyncedAt: syncedAt }
      : undefined,
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

export interface PendingDeletionGuardEntry {
  projectId: string
  projectName: string
  localActiveCount: number
  newlyDeletedCount: number
  deletionRatio: number
  pendingDeletes: Transaction[]
}

/**
 * 將觸發刪除熔斷的專案加入依 projectId 管理的待決佇列：
 * - 不同專案以 FIFO 排隊，避免新批次覆寫其他專案尚未審核的待決告警
 * - 同一專案重複觸發時，原地合併待刪交易（同 ID 取 updatedAt 較新者）並重算計數與比例
 */
export function enqueuePendingDeletionGuard(
  queue: readonly PendingDeletionGuardEntry[],
  incoming: PendingDeletionGuardEntry,
): PendingDeletionGuardEntry[] {
  const existingIdx = queue.findIndex((item) => item.projectId === incoming.projectId)
  if (existingIdx === -1) {
    return [
      ...queue,
      {
        ...incoming,
        pendingDeletes: [...incoming.pendingDeletes],
      },
    ]
  }

  const existing = queue[existingIdx]
  const mergedById = new Map<string, Transaction>()
  for (const tx of existing.pendingDeletes) {
    mergedById.set(tx.id, tx)
  }
  for (const tx of incoming.pendingDeletes) {
    const prev = mergedById.get(tx.id)
    if (!prev || tx.updatedAt >= prev.updatedAt) {
      mergedById.set(tx.id, tx)
    }
  }

  const mergedDeletes = Array.from(mergedById.values())
  const localActiveCount = incoming.localActiveCount
  const newlyDeletedCount = mergedDeletes.length
  const deletionRatio =
    localActiveCount > 0
      ? Number((newlyDeletedCount / localActiveCount).toFixed(4))
      : incoming.deletionRatio

  const mergedEntry: PendingDeletionGuardEntry = {
    projectId: incoming.projectId,
    projectName: incoming.projectName,
    localActiveCount,
    newlyDeletedCount,
    deletionRatio,
    pendingDeletes: mergedDeletes,
  }

  return queue.map((item, idx) => (idx === existingIdx ? mergedEntry : item))
}

/**
 * 從待決熔斷佇列移除指定 projectId（未指定則移除隊首）並回傳被移除項與新佇列
 */
export function dequeuePendingDeletionGuard(
  queue: readonly PendingDeletionGuardEntry[],
  projectId?: string,
): {
  removed: PendingDeletionGuardEntry | null
  nextQueue: PendingDeletionGuardEntry[]
} {
  if (queue.length === 0) {
    return { removed: null, nextQueue: [] }
  }

  const targetIdx =
    projectId !== undefined
      ? queue.findIndex((item) => item.projectId === projectId)
      : 0

  if (targetIdx === -1) {
    return { removed: null, nextQueue: [...queue] }
  }

  const removed = queue[targetIdx]
  const nextQueue = queue.filter((_, idx) => idx !== targetIdx)
  return { removed, nextQueue }
}

/**
 * 核准待決遠端刪除前，以最新本地交易重跑 reconcileRemoteTransactions：
 * 僅保留「本地仍存在、尚未刪除、且遠端刪除時間戳仍嚴格大於本地 updatedAt」的項目，
 * 避免使用者核准前已於本地編輯的交易被過期刪除覆寫。
 */
export function filterApprovableRemoteDeletes(
  localProjectTxs: Transaction[],
  pendingDeletes: Transaction[],
): Transaction[] {
  if (pendingDeletes.length === 0) return []
  return reconcileRemoteTransactions(localProjectTxs, pendingDeletes).incomingDeletes
}
