import {
  CURRENT_SCHEMA_VERSION,
  type LedgerBackup,
  type ManagedCategoryBackup,
  type Project,
  type Transaction,
  type UserProfile,
} from '@/schemas/ledgerSchema'
import { migrateLedgerBackup } from '@/core/migrationEngine'
import {
  resolvePreservedLocalDefaultPayerId,
  sanitizeProjectForCloud,
} from '@/core/realtimeSyncEngine'

export interface CreateLedgerBackupOptions {
  /** 是否保留裝置私有欄位（syncMeta、isArchived、defaultPayerId）；預設 false，避免外洩 accessKey / myMemberId 或跨裝置互相覆寫 */
  includeDevicePrivateFields?: boolean
}

/**
 * 將外部匯入或雲端備份之專案與本地專案合併時，嚴格隔離裝置私有欄位（syncMeta、isArchived、defaultPayerId）：
 * - 外部專案先剔除其 syncMeta、isArchived 與 defaultPayerId，防止匯入他機／舊版備份時外洩或繼承他人 accessKey、myMemberId、封存狀態與預設墊付人偏好
 * - 若本地已存在同 ID 專案，保留本機原本的 syncMeta、isArchived 與 defaultPayerId（若原成員已被遠端移除則安全回退），不因遠端 updatedAt 較新而被覆寫或清空
 */
function mergeIncomingProjectPreservingPrivateFields(
  existing: Project | undefined,
  incoming: Project,
): Project {
  const sanitizedIncoming: Project = sanitizeProjectForCloud(incoming)
  if (!existing) {
    return sanitizedIncoming
  }
  const resolvedDefaultPayerId = resolvePreservedLocalDefaultPayerId(
    existing,
    sanitizedIncoming.members,
  )
  return {
    ...sanitizedIncoming,
    ...(existing.isArchived !== undefined ? { isArchived: existing.isArchived } : {}),
    ...(resolvedDefaultPayerId !== undefined
      ? { defaultPayerId: resolvedDefaultPayerId }
      : {}),
    ...(existing.syncMeta ? { syncMeta: { ...existing.syncMeta } } : {}),
  }
}

export interface LedgerMergeStats {
  projectsAdded: number
  projectsUpdated: number
  projectsSkipped: number
  transactionsAdded: number
  transactionsUpdated: number
  transactionsSkipped: number
  categoriesAdded: number
}

export interface MergeOutboxEntry {
  projectId: string
  entityType: 'project' | 'transaction'
  entityId: string
  updatedAt: number
}

export interface LedgerMergeResult {
  projects: Project[]
  transactions: Transaction[]
  /** 本次合併實際新增或更新之專案 ID（已去重） */
  changedProjectIds: string[]
  /** 本次合併實際新增或更新之交易 ID（已去重） */
  changedTransactionIds: string[]
  categories: ManagedCategoryBackup[]
  userProfile?: UserProfile
  userProfileUpdated: boolean
  projectOrder?: string[]
  projectOrderUpdatedAt?: number
  projectOrderUpdated: boolean
  stats: LedgerMergeStats
}

/**
 * 依據單筆資料之 UUID（id）與毫秒時間戳（updatedAt）進行無損合併：
 * - 遠端/備份檔中有本地缺少的 UUID ➔ 新增
 * - 兩端皆有相同 UUID ➔ 保留 updatedAt 較新的版本（時間戳較新才覆寫）
 * - 若備份含自訂分類清單，會自動補入本地缺少的分類鍵值，避免跨裝置顯示原始 key
 * - 若備份含個人成員名稱與大頭貼（userProfile），依 updatedAt 保留最新版本實現跨裝置同步
 * - 若備份含分帳專案排序（projectOrder），依 projectOrderUpdatedAt 採用最新排序並保留所有專案 ID
 */
export function mergeLedgerData(
  local: {
    projects: Project[]
    transactions: Transaction[]
    categories?: ManagedCategoryBackup[]
    userProfile?: UserProfile
    projectOrder?: string[]
    projectOrderUpdatedAt?: number
  },
  incomingBackup: LedgerBackup,
): LedgerMergeResult {
  const projectMap = new Map<string, Project>()
  for (const proj of local.projects) {
    projectMap.set(proj.id, proj)
  }

  let projectsAdded = 0
  let projectsUpdated = 0
  let projectsSkipped = 0
  const changedProjectIdSet = new Set<string>()

  for (const incomingProj of incomingBackup.projects) {
    const existing = projectMap.get(incomingProj.id)
    if (!existing) {
      projectMap.set(
        incomingProj.id,
        mergeIncomingProjectPreservingPrivateFields(undefined, incomingProj),
      )
      changedProjectIdSet.add(incomingProj.id)
      projectsAdded += 1
    } else if (incomingProj.updatedAt > existing.updatedAt) {
      projectMap.set(
        incomingProj.id,
        mergeIncomingProjectPreservingPrivateFields(existing, incomingProj),
      )
      changedProjectIdSet.add(incomingProj.id)
      projectsUpdated += 1
    } else {
      projectsSkipped += 1
    }
  }

  const txMap = new Map<string, Transaction>()
  for (const tx of local.transactions) {
    txMap.set(tx.id, tx)
  }

  let transactionsAdded = 0
  let transactionsUpdated = 0
  let transactionsSkipped = 0
  const changedTransactionIdSet = new Set<string>()

  for (const incomingTx of incomingBackup.transactions) {
    const existing = txMap.get(incomingTx.id)
    if (!existing) {
      txMap.set(incomingTx.id, incomingTx)
      changedTransactionIdSet.add(incomingTx.id)
      transactionsAdded += 1
    } else if (incomingTx.updatedAt > existing.updatedAt) {
      txMap.set(incomingTx.id, incomingTx)
      changedTransactionIdSet.add(incomingTx.id)
      transactionsUpdated += 1
    } else {
      transactionsSkipped += 1
    }
  }

  const categoryMap = new Map<string, ManagedCategoryBackup>()
  for (const cat of local.categories ?? []) {
    categoryMap.set(cat.key, { ...cat })
  }

  let categoriesAdded = 0
  for (const incomingCat of incomingBackup.categories ?? []) {
    const existing = categoryMap.get(incomingCat.key)
    if (!existing) {
      categoryMap.set(incomingCat.key, { ...incomingCat })
      categoriesAdded += 1
    } else if (
      (!existing.customLabel && incomingCat.customLabel) ||
      (!existing.icon && incomingCat.icon)
    ) {
      categoryMap.set(incomingCat.key, {
        ...existing,
        customLabel: existing.customLabel || incomingCat.customLabel,
        icon: existing.icon || incomingCat.icon,
      })
    }
  }

  // 合併個人成員檔案（名稱、大頭貼與頭像色票）：以 updatedAt 較新者為準
  let mergedUserProfile: UserProfile | undefined = local.userProfile
    ? { ...local.userProfile }
    : undefined
  let userProfileUpdated = false
  const incomingProfile = incomingBackup.userProfile
  if (incomingProfile) {
    const incomingTs = incomingProfile.updatedAt ?? 0
    const localTs = local.userProfile?.updatedAt ?? 0
    const localHasContent = Boolean(
      local.userProfile?.displayName || local.userProfile?.avatarImage,
    )
    const incomingHasContent = Boolean(
      incomingProfile.displayName || incomingProfile.avatarImage,
    )
    if (
      incomingTs > localTs ||
      (!localHasContent && incomingHasContent && localTs === 0)
    ) {
      mergedUserProfile = { ...incomingProfile }
      userProfileUpdated = true
    }
  }

  // 合併分帳專案排序（projectOrder）：以 projectOrderUpdatedAt 較新者為主順序，同時補齊另一端獨有之專案 ID
  let mergedProjectOrder: string[] | undefined = local.projectOrder
    ? [...local.projectOrder]
    : undefined
  let mergedProjectOrderUpdatedAt = local.projectOrderUpdatedAt
  let projectOrderUpdated = false
  const incomingOrder = incomingBackup.projectOrder
  if (incomingOrder && incomingOrder.length > 0) {
    const localOrder = local.projectOrder ?? []
    const incomingOrderTs = incomingBackup.projectOrderUpdatedAt ?? 0
    const localOrderTs = local.projectOrderUpdatedAt ?? 0
    if (
      incomingOrderTs > localOrderTs ||
      (localOrder.length === 0 && localOrderTs === 0)
    ) {
      const seen = new Set<string>()
      const combined: string[] = []
      for (const id of [...incomingOrder, ...localOrder]) {
        if (!seen.has(id)) {
          seen.add(id)
          combined.push(id)
        }
      }
      mergedProjectOrder = combined
      mergedProjectOrderUpdatedAt = Math.max(incomingOrderTs, localOrderTs)
      projectOrderUpdated = true
    } else if (localOrder.length > 0) {
      // 本地排序較新：保留本地順序，但將遠端新增的專案 ID 補到末尾
      const seen = new Set<string>(localOrder)
      const extras = incomingOrder.filter((id) => !seen.has(id))
      if (extras.length > 0) {
        mergedProjectOrder = [...localOrder, ...extras]
        projectOrderUpdated = true
      }
    }
  }

  return {
    projects: Array.from(projectMap.values()),
    transactions: Array.from(txMap.values()),
    changedProjectIds: Array.from(changedProjectIdSet),
    changedTransactionIds: Array.from(changedTransactionIdSet),
    categories: Array.from(categoryMap.values()),
    userProfile: mergedUserProfile,
    userProfileUpdated,
    projectOrder: mergedProjectOrder,
    projectOrderUpdatedAt: mergedProjectOrderUpdatedAt,
    projectOrderUpdated,
    stats: {
      projectsAdded,
      projectsUpdated,
      projectsSkipped,
      transactionsAdded,
      transactionsUpdated,
      transactionsSkipped,
      categoriesAdded,
    },
  }
}

/**
 * 從備份／Google Drive 合併結果中，篩選出屬於「啟用中 Firestore 即時共享專案」的變更項目，
 * 供呼叫端補排進離線同步 Outbox，避免匯入或跨裝置合併後與其他協作成員產生資料分歧。
 */
export function collectRealtimeOutboxEntriesFromMerge(
  mergeResult: Pick<
    LedgerMergeResult,
    'projects' | 'transactions' | 'changedProjectIds' | 'changedTransactionIds'
  >,
): MergeOutboxEntry[] {
  const syncedProjectsById = new Map<string, Project>()
  for (const proj of mergeResult.projects) {
    if (
      !proj.isDeleted &&
      proj.syncMeta?.mode === 'firestore' &&
      Boolean(proj.syncMeta.shareId)
    ) {
      syncedProjectsById.set(proj.id, proj)
    }
  }
  if (syncedProjectsById.size === 0) return []

  const entries: MergeOutboxEntry[] = []

  for (const projectId of mergeResult.changedProjectIds) {
    const proj = syncedProjectsById.get(projectId)
    if (!proj) continue
    entries.push({
      projectId: proj.id,
      entityType: 'project',
      entityId: proj.id,
      updatedAt: proj.updatedAt,
    })
  }

  if (mergeResult.changedTransactionIds.length > 0) {
    const txById = new Map(mergeResult.transactions.map((tx) => [tx.id, tx]))
    for (const txId of mergeResult.changedTransactionIds) {
      const tx = txById.get(txId)
      if (!tx || !tx.projectId || !syncedProjectsById.has(tx.projectId)) continue
      entries.push({
        projectId: tx.projectId,
        entityType: 'transaction',
        entityId: tx.id,
        updatedAt: tx.updatedAt,
      })
    }
  }

  return entries
}

/**
 * 建立符合 schemaVersion: 1 規格之標準備份物件
 * 預設剔除裝置私有欄位（syncMeta、isArchived），避免外洩共享金鑰（accessKey）或於跨裝置同步時互相覆寫
 */
export function createLedgerBackupPayload(
  projects: Project[],
  transactions: Transaction[],
  exportedAt = Date.now(),
  categories?: ManagedCategoryBackup[],
  userProfile?: UserProfile,
  projectOrder?: string[],
  projectOrderUpdatedAt?: number,
  options?: CreateLedgerBackupOptions,
): LedgerBackup {
  const exportProjects = options?.includeDevicePrivateFields
    ? projects
    : projects.map((proj) => sanitizeProjectForCloud(proj))

  return migrateLedgerBackup({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt,
    projects: exportProjects,
    transactions,
    ...(categories && categories.length > 0 ? { categories } : {}),
    ...(userProfile ? { userProfile } : {}),
    ...(projectOrder && projectOrder.length > 0 ? { projectOrder } : {}),
    ...(projectOrderUpdatedAt !== undefined ? { projectOrderUpdatedAt } : {}),
  })
}

/**
 * 建立單一專案之輕量協作備份（僅包含該專案、關聯交易與使用到的自訂分類）
 */
export function createSingleProjectBackupPayload(
  project: Project,
  allTransactions: Transaction[],
  allCategories?: ManagedCategoryBackup[],
  exportedAt = Date.now(),
): LedgerBackup {
  const projectTransactions = allTransactions.filter(
    (tx) => tx.projectId === project.id,
  )
  const usedCategoryKeys = new Set(
    projectTransactions.map((tx) => tx.categoryKey),
  )
  const relevantCategories = (allCategories ?? []).filter(
    (cat) => !cat.isBuiltin || usedCategoryKeys.has(cat.key),
  )

  return createLedgerBackupPayload(
    [project],
    projectTransactions,
    exportedAt,
    relevantCategories,
  )
}

/**
 * 解析外部備份字串或物件，強制經過 Schema 遷移與 Zod 安檢後，與本地資料合併
 */
export function parseAndMergeLedgerBackup(
  local: {
    projects: Project[]
    transactions: Transaction[]
    categories?: ManagedCategoryBackup[]
    userProfile?: UserProfile
    projectOrder?: string[]
    projectOrderUpdatedAt?: number
  },
  rawInput: string | unknown,
): LedgerMergeResult {
  const parsedRaw =
    typeof rawInput === 'string' ? (JSON.parse(rawInput) as unknown) : rawInput
  const validatedIncoming = migrateLedgerBackup(parsedRaw)
  return mergeLedgerData(local, validatedIncoming)
}
