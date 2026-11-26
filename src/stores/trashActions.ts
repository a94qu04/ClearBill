import type { ComputedRef, Ref } from 'vue'
import type {
  Project,
  ProjectMember,
  Transaction,
} from '@/schemas/ledgerSchema'
import {
  clearProjectSyncOutbox,
  normalVaultDb,
  saveProjectToNormalVault,
  saveTransactionToNormalVault,
} from '@/db/normalVaultDb'
import { extractMissingPoolMemberIdsFromTransaction } from '@/core/poolFund'

export interface TrashActionsContext {
  projects: Ref<Project[]>
  transactions: Ref<Transaction[]>
  activeProjectId: Ref<string | null>
  activeProject: ComputedRef<Project | null>
  activeProjects: ComputedRef<Project[]>
  deletedProjects: ComputedRef<Project[]>
  deletedTransactions: ComputedRef<Transaction[]>
  projectOrder: Ref<string[]>
  persistActiveProjectId: (id: string | null) => void
  saveUserPrefs: () => void
  unsubscribeProjectRealtime: (projectId: string) => void
  refreshOutboxCounts: () => Promise<void>
  enqueueAndFlushProjectChange: (
    projectId: string | undefined,
    entityType: 'project' | 'transaction',
    entityId: string,
    updatedAt: number,
  ) => Promise<void>
  markGoogleDriveDirty: () => void
  toPlainClone: <T>(value: T) => T
}

export function createTrashActions(ctx: TrashActionsContext) {
  async function softDeleteProject(projectId: string): Promise<void> {
    const existing = ctx.projects.value.find((p) => p.id === projectId)
    if (!existing) return

    ctx.unsubscribeProjectRealtime(projectId)
    await clearProjectSyncOutbox(projectId)
    await ctx.refreshOutboxCounts()

    const now = Date.now()
    const updatedProject: Project = {
      ...existing,
      isActive: false,
      isDeleted: true,
      updatedAt: now,
    }
    await saveProjectToNormalVault(updatedProject)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === projectId ? updatedProject : p,
    )

    const relatedTxs = ctx.transactions.value.filter(
      (tx) => tx.projectId === projectId && !tx.isDeleted,
    )
    for (const tx of relatedTxs) {
      const deletedTx: Transaction = {
        ...tx,
        isDeleted: true,
        updatedAt: now,
      }
      await saveTransactionToNormalVault(deletedTx)
    }
    if (relatedTxs.length > 0) {
      const relatedIds = new Set(relatedTxs.map((tx) => tx.id))
      ctx.transactions.value = ctx.transactions.value.map((tx) =>
        relatedIds.has(tx.id) ? { ...tx, isDeleted: true, updatedAt: now } : tx,
      )
    }

    if (ctx.activeProjectId.value === projectId) {
      const next = ctx.activeProjects.value[0]?.id ?? null
      ctx.activeProjectId.value = next
      ctx.persistActiveProjectId(next)
    }
    ctx.markGoogleDriveDirty()
  }

  async function softDeleteTransaction(id: string): Promise<void> {
    const target = ctx.transactions.value.find((tx) => tx.id === id)
    if (!target) return
    const updated: Transaction = {
      ...target,
      isDeleted: true,
      updatedAt: Date.now(),
    }
    await saveTransactionToNormalVault(updated)
    ctx.transactions.value = ctx.transactions.value.map((tx) =>
      tx.id === id ? updated : tx,
    )
    await ctx.enqueueAndFlushProjectChange(
      updated.projectId,
      'transaction',
      updated.id,
      updated.updatedAt,
    )
    ctx.markGoogleDriveDirty()
  }

  async function softDeleteTransactionsBatch(ids: string[]): Promise<string[]> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)))
    if (uniqueIds.length === 0) return []
    const now = Date.now()
    const deletedMap = new Map<string, Transaction>()
    for (const id of uniqueIds) {
      const target = ctx.transactions.value.find(
        (tx) => tx.id === id && !tx.isDeleted,
      )
      if (!target) continue
      const updated: Transaction = {
        ...target,
        isDeleted: true,
        updatedAt: now,
      }
      await saveTransactionToNormalVault(updated)
      deletedMap.set(id, updated)
    }
    if (deletedMap.size === 0) return []
    ctx.transactions.value = ctx.transactions.value.map(
      (tx) => deletedMap.get(tx.id) ?? tx,
    )
    for (const updated of deletedMap.values()) {
      await ctx.enqueueAndFlushProjectChange(
        updated.projectId,
        'transaction',
        updated.id,
        updated.updatedAt,
      )
    }
    ctx.markGoogleDriveDirty()
    return Array.from(deletedMap.keys())
  }

  async function restoreTransaction(
    id: string,
  ): Promise<{ ok: boolean; projectId?: string }> {
    const target = ctx.transactions.value.find(
      (tx) => tx.id === id && tx.isDeleted,
    )
    if (!target) return { ok: false }

    const now = Date.now()

    // 若該筆消費原本屬於某個專案且該專案目前處於軟刪除狀態，一併復原專案；若交易指向已刪除的公費袋 ID，亦自動補回該公費袋成員避免出現孤兒 ID
    let targetProjectId = target.projectId
    if (targetProjectId) {
      const parentProject = ctx.projects.value.find(
        (p) => p.id === targetProjectId,
      )
      if (parentProject) {
        const existingMemberIds = new Set(
          parentProject.members.map((m) => m.id),
        )
        const missingPoolIds = extractMissingPoolMemberIdsFromTransaction(
          target,
          existingMemberIds,
        )

        if (parentProject.isDeleted || missingPoolIds.length > 0) {
          const plainParent = ctx.toPlainClone(parentProject)
          const extraPoolMembers: ProjectMember[] = missingPoolIds.map(
            (poolId) => ({
              id: poolId,
              name: '公費袋',
              avatarColor: '#0f766e',
              isPool: true,
            }),
          )
          const restoredProject = await saveProjectToNormalVault({
            ...plainParent,
            isDeleted: false,
            isActive: true,
            members: [
              ...plainParent.members.map((m) => ({ ...m })),
              ...extraPoolMembers,
            ],
            updatedAt: now,
          })
          ctx.projects.value = ctx.projects.value.map((p) =>
            p.id === restoredProject.id ? restoredProject : p,
          )
          await ctx.enqueueAndFlushProjectChange(
            restoredProject.id,
            'project',
            restoredProject.id,
            restoredProject.updatedAt,
          )
        }
      }
      // 同步切換回該專案，讓使用者馬上看到復原後的帳目與更新後結算
      ctx.activeProjectId.value = targetProjectId
      ctx.persistActiveProjectId(targetProjectId)
    } else if (ctx.activeProject.value) {
      // 若復原的是無專案歸屬的舊消費且目前隱藏日常記帳模式中有進行中專案，仍保留原資料不亂竄改
      targetProjectId = undefined
    }

    const restoredPayload: Transaction = {
      ...target,
      projectId: targetProjectId,
      isDeleted: false,
      updatedAt: now,
    }
    const saved = await saveTransactionToNormalVault(restoredPayload)
    ctx.transactions.value = ctx.transactions.value.map((tx) =>
      tx.id === id ? saved : tx,
    )
    await ctx.enqueueAndFlushProjectChange(
      saved.projectId,
      'transaction',
      saved.id,
      saved.updatedAt,
    )
    ctx.markGoogleDriveDirty()
    return { ok: true, projectId: saved.projectId }
  }

  async function restoreProject(
    projectId: string,
  ): Promise<{ ok: boolean; restoredTxCount: number; projectName?: string }> {
    const target = ctx.projects.value.find(
      (p) => p.id === projectId && p.isDeleted,
    )
    if (!target) return { ok: false, restoredTxCount: 0 }

    const now = Date.now()
    const restoredProject: Project = {
      ...target,
      isDeleted: false,
      isActive: true,
      isArchived: false,
      members: target.members.map((m) => ({ ...m })),
      updatedAt: now,
    }
    const savedProj = await saveProjectToNormalVault(restoredProject)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === projectId ? savedProj : p,
    )

    // 一併復原隨該專案軟刪除之關聯交易
    const relatedDeleted = ctx.transactions.value.filter(
      (tx) => tx.projectId === projectId && tx.isDeleted,
    )
    const restoredMap = new Map<string, Transaction>()
    for (const tx of relatedDeleted) {
      const savedTx = await saveTransactionToNormalVault({
        ...tx,
        isDeleted: false,
        updatedAt: now,
      })
      restoredMap.set(savedTx.id, savedTx)
    }
    if (restoredMap.size > 0) {
      ctx.transactions.value = ctx.transactions.value.map(
        (tx) => restoredMap.get(tx.id) ?? tx,
      )
    }

    ctx.activeProjectId.value = savedProj.id
    ctx.persistActiveProjectId(savedProj.id)
    ctx.markGoogleDriveDirty()
    return {
      ok: true,
      restoredTxCount: restoredMap.size,
      projectName: savedProj.name,
    }
  }

  async function permanentlyDeleteProject(projectId: string): Promise<void> {
    const relatedIds = ctx.transactions.value
      .filter((tx) => tx.projectId === projectId)
      .map((tx) => tx.id)
    if (relatedIds.length > 0) {
      await normalVaultDb.transactions.bulkDelete(relatedIds)
      const idSet = new Set(relatedIds)
      ctx.transactions.value = ctx.transactions.value.filter(
        (tx) => !idSet.has(tx.id),
      )
    }
    await normalVaultDb.projects.delete(projectId)
    ctx.projects.value = ctx.projects.value.filter((p) => p.id !== projectId)
    ctx.projectOrder.value = ctx.projectOrder.value.filter(
      (id) => id !== projectId,
    )
    ctx.saveUserPrefs()
  }

  async function permanentlyDeleteTransaction(id: string): Promise<void> {
    await normalVaultDb.transactions.delete(id)
    ctx.transactions.value = ctx.transactions.value.filter((tx) => tx.id !== id)
  }

  async function emptyTrash(): Promise<number> {
    const txIds = ctx.deletedTransactions.value.map((tx) => tx.id)
    const projIds = ctx.deletedProjects.value.map((p) => p.id)
    const total = txIds.length + projIds.length
    if (total === 0) return 0

    if (txIds.length > 0) {
      await normalVaultDb.transactions.bulkDelete(txIds)
      const deletedSet = new Set(txIds)
      ctx.transactions.value = ctx.transactions.value.filter(
        (tx) => !deletedSet.has(tx.id),
      )
    }
    if (projIds.length > 0) {
      await normalVaultDb.projects.bulkDelete(projIds)
      const projSet = new Set(projIds)
      ctx.projects.value = ctx.projects.value.filter((p) => !projSet.has(p.id))
      ctx.projectOrder.value = ctx.projectOrder.value.filter(
        (id) => !projSet.has(id),
      )
      ctx.saveUserPrefs()
    }
    return total
  }

  return {
    softDeleteProject,
    softDeleteTransaction,
    softDeleteTransactionsBatch,
    restoreTransaction,
    restoreProject,
    permanentlyDeleteProject,
    permanentlyDeleteTransaction,
    emptyTrash,
  }
}
