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

export interface SyncOutboxRemoveEntry {
  key: string
  /** 本次推送實際送出的版本時間戳；僅當目前 Outbox 內 updatedAt <= pushedUpdatedAt 才刪除 */
  pushedUpdatedAt: number
}

export interface SyncOutboxRecordStore {
  get: (key: string) => Promise<SyncOutboxItem | undefined>
  delete: (key: string) => Promise<void>
}

/**
 * 條件刪除 Outbox 項目：僅刪除「目前尚未被更新版本覆寫（updatedAt <= pushedUpdatedAt）」的項目，
 * 避免推送進行中同筆資料再次修改而遭誤刪。
 */
export async function applyConditionalOutboxRemoval(
  store: SyncOutboxRecordStore,
  entries: SyncOutboxRemoveEntry[],
): Promise<string[]> {
  if (entries.length === 0) return []
  const deletedKeys: string[] = []
  for (const entry of entries) {
    const current = await store.get(entry.key)
    if (!current) continue
    if (current.updatedAt <= entry.pushedUpdatedAt) {
      await store.delete(entry.key)
      deletedKeys.push(entry.key)
    }
  }
  return deletedKeys
}

export async function enqueueSyncOutbox(
  projectId: string,
  entityType: 'project' | 'transaction',
  entityId: string,
  updatedAt = Date.now(),
): Promise<void> {
  const key = `${entityType}:${entityId}`
  await normalVaultDb.transaction('rw', normalVaultDb.syncOutbox, async () => {
    const existing = await normalVaultDb.syncOutbox.get(key)
    // 防止亂序寫入以較舊時間戳覆蓋較新版本
    if (existing && existing.updatedAt > updatedAt) return
    const item: SyncOutboxItem = {
      key,
      projectId,
      entityType,
      entityId,
      updatedAt,
    }
    await normalVaultDb.syncOutbox.put(item)
  })
}

export async function listSyncOutbox(projectId?: string): Promise<SyncOutboxItem[]> {
  if (projectId) {
    return normalVaultDb.syncOutbox.where('projectId').equals(projectId).toArray()
  }
  return normalVaultDb.syncOutbox.toArray()
}

export async function removeSyncOutboxIfNotNewer(
  entries: SyncOutboxRemoveEntry[],
): Promise<string[]> {
  if (entries.length === 0) return []
  return normalVaultDb.transaction('rw', normalVaultDb.syncOutbox, async () => {
    return applyConditionalOutboxRemoval(normalVaultDb.syncOutbox, entries)
  })
}

export async function removeSyncOutboxKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  await normalVaultDb.syncOutbox.bulkDelete(keys)
}

export async function clearProjectSyncOutbox(projectId: string): Promise<void> {
  await normalVaultDb.syncOutbox.where('projectId').equals(projectId).delete()
}
