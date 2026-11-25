import Dexie, { type EntityTable } from 'dexie'
import {
  ProjectSchema,
  TransactionSchema,
  type Project,
  type Transaction,
} from '@/schemas/ledgerSchema'

export interface SyncOutboxItem {
  /** 複合主鍵：`${entityType}:${entityId}`，同一筆重複修改自動去重 */
  key: string
  projectId: string
  entityType: 'project' | 'transaction'
  entityId: string
  updatedAt: number
}

/**
 * 個人三層隱私金庫第一層：一般明文本地資料庫（ledger_db_normal）
 * v2 新增 syncOutbox 離線補同步佇列，支援多人即時共享專案離線記帳與連網自動補傳。
 */
export class NormalVaultDatabase extends Dexie {
  projects!: EntityTable<Project, 'id'>
  transactions!: EntityTable<Transaction, 'id'>
  syncOutbox!: EntityTable<SyncOutboxItem, 'key'>

  constructor() {
    super('ledger_db_normal')
    this.version(1).stores({
      projects: 'id, isActive, updatedAt, isDeleted',
      transactions: 'id, projectId, date, updatedAt, vaultLevel, type, isDeleted',
    })
    this.version(2).stores({
      projects: 'id, isActive, updatedAt, isDeleted',
      transactions: 'id, projectId, date, updatedAt, vaultLevel, type, isDeleted',
      syncOutbox: 'key, projectId, entityType, updatedAt',
    })
  }
}

export const normalVaultDb = new NormalVaultDatabase()

export async function saveProjectToNormalVault(rawProject: Project): Promise<Project> {
  const validated = ProjectSchema.parse(rawProject)
  await normalVaultDb.projects.put(validated)
  return validated
}

export async function saveTransactionToNormalVault(
  rawTx: Transaction,
): Promise<Transaction> {
  const validated = TransactionSchema.parse(rawTx)
  await normalVaultDb.transactions.put(validated)
  return validated
}

export async function enqueueSyncOutbox(
  projectId: string,
  entityType: 'project' | 'transaction',
  entityId: string,
  updatedAt = Date.now(),
): Promise<void> {
  const item: SyncOutboxItem = {
    key: `${entityType}:${entityId}`,
    projectId,
    entityType,
    entityId,
    updatedAt,
  }
  await normalVaultDb.syncOutbox.put(item)
}

export async function listSyncOutbox(projectId?: string): Promise<SyncOutboxItem[]> {
  if (projectId) {
    return normalVaultDb.syncOutbox.where('projectId').equals(projectId).toArray()
  }
  return normalVaultDb.syncOutbox.toArray()
}

export async function removeSyncOutboxKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  await normalVaultDb.syncOutbox.bulkDelete(keys)
}

/** 僅刪除 updatedAt <= 已推送版本之 Outbox 項目，避免推送期間產生的新修改遭誤刪漏傳 */
export async function removeSyncOutboxIfNotNewer(
  entries: Array<{ key: string; updatedAt: number }>,
): Promise<void> {
  if (entries.length === 0) return
  await normalVaultDb.transaction('rw', normalVaultDb.syncOutbox, async () => {
    for (const entry of entries) {
      const existing = await normalVaultDb.syncOutbox.get(entry.key)
      if (existing && existing.updatedAt <= entry.updatedAt) {
        await normalVaultDb.syncOutbox.delete(entry.key)
      }
    }
  })
}

export async function clearProjectSyncOutbox(projectId: string): Promise<void> {
  await normalVaultDb.syncOutbox.where('projectId').equals(projectId).delete()
}
