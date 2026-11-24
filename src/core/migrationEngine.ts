import {
  CURRENT_SCHEMA_VERSION,
  LedgerBackupSchema,
  ProjectSchema,
  TransactionSchema,
  type LedgerBackup,
  type Project,
  type Transaction,
} from '@/schemas/ledgerSchema'

export class SchemaMigrationError extends Error {
  public readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'SchemaMigrationError'
    this.code = code
  }
}

type RecordObject = Record<string, unknown>

function assertRecordObject(raw: unknown, label: string): RecordObject {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SchemaMigrationError(
      'ERR_INVALID_PAYLOAD',
      `${label} 資料格式必須為 JSON 物件`,
    )
  }
  return { ...(raw as RecordObject) }
}

function readSchemaVersion(obj: RecordObject): number {
  const rawVersion = obj.schemaVersion
  if (rawVersion === undefined || rawVersion === null) {
    // 兼容未標記版本之早期草案資料，視作 v0 並升級至 v1
    return 0
  }
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 0) {
    throw new SchemaMigrationError(
      'ERR_INVALID_SCHEMA_VERSION',
      `無效的 schemaVersion 值：${String(rawVersion)}`,
    )
  }
  if (rawVersion > CURRENT_SCHEMA_VERSION) {
    throw new SchemaMigrationError(
      'ERR_UNSUPPORTED_SCHEMA_VERSION',
      `不支援較新版本 v${rawVersion}（當前支援最高版本為 v${CURRENT_SCHEMA_VERSION}）`,
    )
  }
  return rawVersion
}

/**
 * 單筆交易資料向下相容遷移並通過 Zod 嚴格驗證
 */
export function migrateTransaction(raw: unknown): Transaction {
  const payload = assertRecordObject(raw, 'Transaction')
  let version = readSchemaVersion(payload)

  // v0 -> v1 遷移規則：補齊預設欄位與時間預設值
  if (version < 1) {
    payload.schemaVersion = CURRENT_SCHEMA_VERSION
    if (!payload.time) {
      payload.time = '00:00'
    }
    if (payload.exchangeRateToBase === undefined) {
      payload.exchangeRateToBase = 1
    }
    if (!payload.vaultLevel) {
      payload.vaultLevel = 'normal'
    }
    version = 1
  }

  // 容錯清理：空陣列 links / receiptImages 轉為 undefined，避免觸發 min(1) 驗證失敗
  if (Array.isArray(payload.links) && payload.links.length === 0) {
    delete payload.links
  }
  if (Array.isArray(payload.receiptImages) && payload.receiptImages.length === 0) {
    delete payload.receiptImages
  }
  if (payload.note === '' || payload.note === null) {
    delete payload.note
  }
  if (payload.projectId === '' || payload.projectId === null) {
    delete payload.projectId
  }

  return TransactionSchema.parse(payload)
}

/**
 * 單一專案資料向下相容遷移並通過 Zod 嚴格驗證
 */
export function migrateProject(raw: unknown): Project {
  const payload = assertRecordObject(raw, 'Project')
  let version = readSchemaVersion(payload)

  if (version < 1) {
    payload.schemaVersion = CURRENT_SCHEMA_VERSION
    if (!payload.baseCurrency) {
      payload.baseCurrency = 'TWD'
    }
    if (!payload.defaultSplitMode) {
      payload.defaultSplitMode = 'equal'
    }
    if (payload.isActive === undefined) {
      payload.isActive = true
    }
    version = 1
  }

  return ProjectSchema.parse(payload)
}

/**
 * 完整 JSON 備份檔向下相容遷移並通過 Zod 嚴格驗證
 */
export function migrateLedgerBackup(raw: unknown): LedgerBackup {
  const payload = assertRecordObject(raw, 'LedgerBackup')
  let version = readSchemaVersion(payload)

  if (version < 1) {
    payload.schemaVersion = CURRENT_SCHEMA_VERSION
    version = 1
  }

  const rawProjects = Array.isArray(payload.projects) ? payload.projects : []
  const rawTransactions = Array.isArray(payload.transactions) ? payload.transactions : []

  const migratedProjects = rawProjects.map((item) => migrateProject(item))
  const migratedTransactions = rawTransactions.map((item) => migrateTransaction(item))
  const rawCategories = Array.isArray(payload.categories)
    ? payload.categories
    : undefined

  return LedgerBackupSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt:
      typeof payload.exportedAt === 'number' ? payload.exportedAt : Date.now(),
    projects: migratedProjects,
    transactions: migratedTransactions,
    ...(rawCategories ? { categories: rawCategories } : {}),
  })
}
