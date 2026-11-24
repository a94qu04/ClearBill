import Dexie, { type EntityTable } from 'dexie'
import {
  ProjectSchema,
  TransactionSchema,
  type Project,
  type Transaction,
} from '@/schemas/ledgerSchema'

/**
 * 個人三層隱私金庫第一層：一般明文本地資料庫（ledger_db_normal）
 * Phase 1 建立 Local-First 本地持久化基礎，所有寫入皆強制通過 Zod 驗證。
 */
export class NormalVaultDatabase extends Dexie {
  projects!: EntityTable<Project, 'id'>
  transactions!: EntityTable<Transaction, 'id'>

  constructor() {
    super('ledger_db_normal')
    this.version(1).stores({
      projects: 'id, isActive, updatedAt, isDeleted',
      transactions: 'id, projectId, date, updatedAt, vaultLevel, type, isDeleted',
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
