import {
  CURRENT_SCHEMA_VERSION,
  type LedgerBackup,
  type ManagedCategoryBackup,
  type Project,
  type Transaction,
  type UserProfile,
} from '@/schemas/ledgerSchema'
import { migrateLedgerBackup } from '@/core/migrationEngine'

export interface LedgerMergeStats {
  projectsAdded: number
  projectsUpdated: number
  projectsSkipped: number
  transactionsAdded: number
  transactionsUpdated: number
  transactionsSkipped: number
  categoriesAdded: number
}

export interface LedgerMergeResult {
  projects: Project[]
  transactions: Transaction[]
  categories: ManagedCategoryBackup[]
  userProfile?: UserProfile
  userProfileUpdated: boolean
  stats: LedgerMergeStats
}

/**
 * 依據單筆資料之 UUID（id）與毫秒時間戳（updatedAt）進行無損合併：
 * - 遠端/備份檔中有本地缺少的 UUID ➔ 新增
 * - 兩端皆有相同 UUID ➔ 保留 updatedAt 較新的版本（時間戳較新才覆寫）
 * - 若備份含自訂分類清單，會自動補入本地缺少的分類鍵值，避免跨裝置顯示原始 key
 * - 若備份含個人成員名稱與大頭貼（userProfile），依 updatedAt 保留最新版本實現跨裝置同步
 */
export function mergeLedgerData(
  local: {
    projects: Project[]
    transactions: Transaction[]
    categories?: ManagedCategoryBackup[]
    userProfile?: UserProfile
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

  for (const incomingProj of incomingBackup.projects) {
    const existing = projectMap.get(incomingProj.id)
    if (!existing) {
      projectMap.set(incomingProj.id, incomingProj)
      projectsAdded += 1
    } else if (incomingProj.updatedAt > existing.updatedAt) {
      projectMap.set(incomingProj.id, incomingProj)
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

  for (const incomingTx of incomingBackup.transactions) {
    const existing = txMap.get(incomingTx.id)
    if (!existing) {
      txMap.set(incomingTx.id, incomingTx)
      transactionsAdded += 1
    } else if (incomingTx.updatedAt > existing.updatedAt) {
      txMap.set(incomingTx.id, incomingTx)
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
    } else if (!existing.customLabel && incomingCat.customLabel) {
      categoryMap.set(incomingCat.key, {
        ...existing,
        customLabel: incomingCat.customLabel,
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

  return {
    projects: Array.from(projectMap.values()),
    transactions: Array.from(txMap.values()),
    categories: Array.from(categoryMap.values()),
    userProfile: mergedUserProfile,
    userProfileUpdated,
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
 * 建立符合 schemaVersion: 1 規格之標準備份物件
 */
export function createLedgerBackupPayload(
  projects: Project[],
  transactions: Transaction[],
  exportedAt = Date.now(),
  categories?: ManagedCategoryBackup[],
  userProfile?: UserProfile,
): LedgerBackup {
  return migrateLedgerBackup({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt,
    projects,
    transactions,
    ...(categories && categories.length > 0 ? { categories } : {}),
    ...(userProfile ? { userProfile } : {}),
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
  },
  rawInput: string | unknown,
): LedgerMergeResult {
  const parsedRaw =
    typeof rawInput === 'string' ? (JSON.parse(rawInput) as unknown) : rawInput
  const validatedIncoming = migrateLedgerBackup(parsedRaw)
  return mergeLedgerData(local, validatedIncoming)
}
