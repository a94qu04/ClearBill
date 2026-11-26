import {
  CURRENT_SCHEMA_VERSION,
  LedgerBackupSchema,
  ProjectSchema,
  TransactionSchema,
  type LedgerBackup,
  type Project,
  type Transaction,
} from '@/schemas/ledgerSchema'
import {
  validateSplitInvariant,
  type SplitInvariantViolation,
} from '@/core/splitInvariant'

export interface MigrateTransactionOptions {
  /** 是否嚴格強制拆帳金額守恆不變式（預設 false，採寬鬆模式向下相容歷史資料） */
  strictSplitInvariant?: boolean
  /** 寬鬆模式下偵測到歷史資料違反拆帳守恆時之回呼 */
  onSplitInvariantViolation?: (
    tx: Transaction,
    violations: SplitInvariantViolation[],
  ) => void
}

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
export function migrateTransaction(
  raw: unknown,
  options?: MigrateTransactionOptions,
): Transaction {
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

  const parsed = TransactionSchema.parse(payload)
  const invariant = validateSplitInvariant(parsed)
  if (!invariant.valid) {
    if (options?.strictSplitInvariant) {
      throw new SchemaMigrationError(
        'ERR_SPLIT_INVARIANT_VIOLATION',
        invariant.violations.map((v) => v.message).join('；'),
      )
    }
    options?.onSplitInvariantViolation?.(parsed, invariant.violations)
  }
  return parsed
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

export interface QuarantinedRecord {
  entityType: 'project' | 'transaction'
  id?: string
  raw: unknown
  error: string
}

export interface MigrateLoadedRecordsResult {
  projects: Project[]
  transactions: Transaction[]
  /** 確實發生版本升級（如 v0 → v1）而需要靜默回寫本機資料庫之專案 */
  upgradedProjects: Project[]
  /** 確實發生版本升級（如 v0 → v1）而需要靜默回寫本機資料庫之交易 */
  upgradedTransactions: Transaction[]
  /** 遷移或 Zod 驗證失敗而被隔離的異常紀錄（不阻斷其餘正常資料載入） */
  quarantined: QuarantinedRecord[]
}

function needsSchemaUpgrade(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return false
  }
  const rawVersion = (raw as RecordObject).schemaVersion
  return (
    rawVersion === undefined ||
    rawVersion === null ||
    (typeof rawVersion === 'number' && rawVersion < CURRENT_SCHEMA_VERSION)
  )
}

function extractRawRecordId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined
  }
  const id = (raw as RecordObject).id
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined
}

function formatMigrationError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message
  }
  return String(err)
}

/**
 * 批次遷移本機 IndexedDB 載入之專案與交易紀錄：
 * - 舊版（如 v0）資料自動升級至 CURRENT_SCHEMA_VERSION 並標記回寫清單
 * - 單筆損毀或不支援之較新版本資料自動隔離至 quarantined，不影響其餘正常資料載入
 */
export function migrateLoadedLedgerRecords(
  rawProjects: readonly unknown[],
  rawTransactions: readonly unknown[],
  transactionOptions?: MigrateTransactionOptions,
): MigrateLoadedRecordsResult {
  const projects: Project[] = []
  const transactions: Transaction[] = []
  const upgradedProjects: Project[] = []
  const upgradedTransactions: Transaction[] = []
  const quarantined: QuarantinedRecord[] = []

  for (const raw of rawProjects) {
    try {
      const upgraded = needsSchemaUpgrade(raw)
      const migrated = migrateProject(raw)
      projects.push(migrated)
      if (upgraded) {
        upgradedProjects.push(migrated)
      }
    } catch (err) {
      quarantined.push({
        entityType: 'project',
        id: extractRawRecordId(raw),
        raw,
        error: formatMigrationError(err),
      })
    }
  }

  for (const raw of rawTransactions) {
    try {
      const upgraded = needsSchemaUpgrade(raw)
      const migrated = migrateTransaction(raw, transactionOptions)
      transactions.push(migrated)
      if (upgraded) {
        upgradedTransactions.push(migrated)
      }
    } catch (err) {
      quarantined.push({
        entityType: 'transaction',
        id: extractRawRecordId(raw),
        raw,
        error: formatMigrationError(err),
      })
    }
  }

  return {
    projects,
    transactions,
    upgradedProjects,
    upgradedTransactions,
    quarantined,
  }
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
  const rawUserProfile =
    payload.userProfile &&
    typeof payload.userProfile === 'object' &&
    !Array.isArray(payload.userProfile)
      ? payload.userProfile
      : undefined
  const rawProjectOrder = Array.isArray(payload.projectOrder)
    ? payload.projectOrder.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      )
    : undefined
  const rawProjectOrderUpdatedAt =
    typeof payload.projectOrderUpdatedAt === 'number' &&
    Number.isFinite(payload.projectOrderUpdatedAt) &&
    payload.projectOrderUpdatedAt >= 0
      ? Math.floor(payload.projectOrderUpdatedAt)
      : undefined

  return LedgerBackupSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt:
      typeof payload.exportedAt === 'number' ? payload.exportedAt : Date.now(),
    projects: migratedProjects,
    transactions: migratedTransactions,
    ...(rawCategories ? { categories: rawCategories } : {}),
    ...(rawUserProfile ? { userProfile: rawUserProfile } : {}),
    ...(rawProjectOrder && rawProjectOrder.length > 0
      ? { projectOrder: rawProjectOrder }
      : {}),
    ...(rawProjectOrderUpdatedAt !== undefined
      ? { projectOrderUpdatedAt: rawProjectOrderUpdatedAt }
      : {}),
  })
}
