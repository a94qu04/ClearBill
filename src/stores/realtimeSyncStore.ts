import { computed, ref, type Ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  Project,
  ProjectMember,
  Transaction,
  UserProfile,
} from '@/schemas/ledgerSchema'
import {
  clearProjectSyncOutbox,
  enqueueSyncOutbox,
  listSyncOutbox,
  normalVaultDb,
  removeSyncOutboxIfNotNewer,
  saveProjectToNormalVault,
  saveTransactionToNormalVault,
} from '@/db/normalVaultDb'
import { createOutboxFlusher } from '@/core/outboxFlusher'
import {
  dequeuePendingDeletionGuard,
  enqueuePendingDeletionGuard,
  filterApprovableRemoteDeletes,
  mergeRemoteProjectPreservingLocalFields,
  reconcileRemoteTransactions,
  type PendingDeletionGuardEntry,
} from '@/core/realtimeSyncEngine'
import {
  clearCustomFirebaseConfig,
  FirestoreSyncError,
  getCustomFirebaseConfig,
  hasBuiltInFirebaseConfig,
  isFirebaseConfigured,
  joinSharedProjectOnFirestore,
  parseAndSaveCustomFirebaseConfig,
  publishProjectToFirestore,
  pushProjectUpdateToFirestore,
  pushTransactionToFirestore,
  rotateProjectAccessKeyOnFirestore,
  subscribeSharedProject,
  type FirestoreSyncErrorCode,
} from '@/services/firestoreSyncService'
import { AVATAR_PALETTE } from '@/stores/userPrefsStore'

export type ProjectRealtimeSyncStatus =
  | 'local'
  | 'connecting'
  | 'synced'
  | 'offline'
  | 'error'

export type PendingDeletionGuardAlert = PendingDeletionGuardEntry

export interface RealtimeSyncLedgerContext {
  projects: Ref<Project[]>
  transactions: Ref<Transaction[]>
  activeProjectId: Ref<string | null>
  projectOrder: Ref<string[]>
  userProfile: Ref<UserProfile>
  persistActiveProjectId: (id: string | null) => void
  saveUserPrefs: () => void
  toPlainClone: <T>(value: T) => T
}

export const useRealtimeSyncStore = defineStore('realtimeSync', () => {
  const syncStatusByProject = ref<Record<string, ProjectRealtimeSyncStatus>>({})
  const lastSyncedAtByProject = ref<Record<string, number>>({})
  const outboxCountByProject = ref<Record<string, number>>({})
  const pendingDeletionGuardQueue = ref<PendingDeletionGuardAlert[]>([])
  const pendingDeletionGuard = computed<PendingDeletionGuardAlert | null>(
    () => pendingDeletionGuardQueue.value[0] ?? null,
  )
  const pendingDeletionGuardCount = computed<number>(
    () => pendingDeletionGuardQueue.value.length,
  )
  const activeRealtimeUnsubscribers = new Map<string, () => void>()

  let ledgerCtx: RealtimeSyncLedgerContext | null = null

  function bindLedgerContext(ctx: RealtimeSyncLedgerContext): void {
    ledgerCtx = ctx
  }

  function requireContext(): RealtimeSyncLedgerContext {
    if (!ledgerCtx) {
      throw new Error('ERR_REALTIME_SYNC_CONTEXT_NOT_BOUND')
    }
    return ledgerCtx
  }

  async function refreshOutboxCounts(): Promise<void> {
    try {
      const items = await listSyncOutbox()
      const counts: Record<string, number> = {}
      for (const item of items) {
        counts[item.projectId] = (counts[item.projectId] ?? 0) + 1
      }
      outboxCountByProject.value = counts
    } catch {
      // 忽略受限環境
    }
  }

  function isProjectRealtimeSynced(projectId: string | undefined): boolean {
    if (!projectId || !ledgerCtx) return false
    const proj = ledgerCtx.projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    return Boolean(proj?.syncMeta?.mode === 'firestore' && proj.syncMeta.shareId)
  }

  async function enqueueAndFlushProjectChange(
    projectId: string | undefined,
    entityType: 'project' | 'transaction',
    entityId: string,
    updatedAt: number,
  ): Promise<void> {
    if (!projectId || !isProjectRealtimeSynced(projectId)) return
    await enqueueSyncOutbox(projectId, entityType, entityId, updatedAt)
    await refreshOutboxCounts()
    void flushProjectOutbox(projectId)
  }

  const projectOutboxFlusher = createOutboxFlusher({
    canFlushProject: (projectId) => {
      if (!ledgerCtx) return false
      const proj = ledgerCtx.projects.value.find(
        (p) => p.id === projectId && !p.isDeleted,
      )
      return Boolean(
        proj &&
          proj.syncMeta?.mode === 'firestore' &&
          proj.syncMeta.shareId &&
          isFirebaseConfigured(),
      )
    },
    isOnline: () =>
      typeof navigator === 'undefined' || navigator.onLine !== false,
    listItems: (projectId) => listSyncOutbox(projectId),
    pushItem: async (projectId, item) => {
      const ctx = requireContext()
      const proj = ctx.projects.value.find(
        (p) => p.id === projectId && !p.isDeleted,
      )
      const shareId = proj?.syncMeta?.shareId
      if (!proj || proj.syncMeta?.mode !== 'firestore' || !shareId) {
        return undefined
      }
      const syncImages = proj.syncMeta.syncReceiptImages !== false
      if (item.entityType === 'project') {
        const latestProj = ctx.projects.value.find((p) => p.id === projectId)
        if (!latestProj) return undefined
        await pushProjectUpdateToFirestore(shareId, latestProj)
        return latestProj.updatedAt
      }
      const latestTx = ctx.transactions.value.find((t) => t.id === item.entityId)
      if (!latestTx) return undefined
      await pushTransactionToFirestore(shareId, latestTx, syncImages)
      return latestTx.updatedAt
    },
    removeIfNotNewer: (entries) => removeSyncOutboxIfNotNewer(entries),
    onCountsChanged: () => refreshOutboxCounts(),
    onStatusChange: (projectId, status, syncedAt) => {
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]: status,
      }
      if (status === 'synced' && typeof syncedAt === 'number') {
        lastSyncedAtByProject.value = {
          ...lastSyncedAtByProject.value,
          [projectId]: syncedAt,
        }
      }
    },
  })

  async function flushProjectOutbox(projectId: string): Promise<void> {
    await projectOutboxFlusher.flush(projectId)
  }

  async function flushAllSharedProjectsOutbox(): Promise<void> {
    const ctx = requireContext()
    const sharedIds = ctx.projects.value
      .filter(
        (p) =>
          !p.isDeleted && p.syncMeta?.mode === 'firestore' && p.syncMeta.shareId,
      )
      .map((p) => p.id)
    for (const id of sharedIds) {
      await flushProjectOutbox(id)
    }
  }

  async function applyRemoteProjectUpdate(
    localProjectId: string,
    remoteProject: Project,
  ): Promise<void> {
    const ctx = requireContext()
    const localProj = ctx.projects.value.find((p) => p.id === localProjectId)
    if (!localProj) return
    if (remoteProject.updatedAt <= localProj.updatedAt) return

    const now = Date.now()
    const mergedProject = mergeRemoteProjectPreservingLocalFields(
      localProj,
      remoteProject,
      now,
    )

    const saved = await saveProjectToNormalVault(mergedProject)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === localProjectId ? saved : p,
    )
    lastSyncedAtByProject.value = {
      ...lastSyncedAtByProject.value,
      [localProjectId]: now,
    }
  }

  async function applyRemoteTransactionsList(
    localProjectId: string,
    txList: Transaction[],
  ): Promise<void> {
    if (txList.length === 0) return
    const ctx = requireContext()

    const plainIncomingList = ctx.toPlainClone(txList)
    // 僅需索引既有交易以保留本地圖片，未變更的交易不需全量深拷貝
    const localMap = new Map(ctx.transactions.value.map((t) => [t.id, t]))
    const toPersist: Transaction[] = []

    for (const incoming of plainIncomingList) {
      const existing = localMap.get(incoming.id)
      // 若遠端因圖片體積過大略過圖片，保留本地既有圖片避免遺失
      const preservedImages =
        (!incoming.receiptImages || incoming.receiptImages.length === 0) &&
        existing?.receiptImages &&
        existing.receiptImages.length > 0
          ? [...existing.receiptImages]
          : incoming.receiptImages

      const normalized: Transaction = {
        ...incoming,
        projectId: localProjectId,
        receiptImages: preservedImages,
      }
      toPersist.push(normalized)
      localMap.set(normalized.id, normalized)
    }

    await normalVaultDb.transactions.bulkPut(toPersist)
    // 寫入完成後改以當下最新記憶體陣列增量合併，避免蓋掉 await 期間本地剛新增的交易
    const currentMap = new Map(ctx.transactions.value.map((t) => [t.id, t]))
    for (const savedTx of toPersist) {
      const current = currentMap.get(savedTx.id)
      if (!current || savedTx.updatedAt >= current.updatedAt) {
        currentMap.set(savedTx.id, savedTx)
      }
    }
    ctx.transactions.value = Array.from(currentMap.values())
  }

  async function handleRemoteTransactionsBatch(
    localProjectId: string,
    remoteTxs: Transaction[],
  ): Promise<void> {
    const ctx = requireContext()
    const localProj = ctx.projects.value.find((p) => p.id === localProjectId)
    if (!localProj) return

    const localProjectTxs = ctx.transactions.value.filter(
      (tx) => tx.projectId === localProjectId,
    )
    const reconciled = reconcileRemoteTransactions(localProjectTxs, remoteTxs)

    // 先安全套用遠端的新增與一般修改
    if (reconciled.safeUpserts.length > 0) {
      await applyRemoteTransactionsList(localProjectId, reconciled.safeUpserts)
    }

    // 異常大量刪除熔斷器：達門檻時自動攔截並依 projectId 排入待決佇列，要求使用者確認
    if (reconciled.circuitBreaker.triggered) {
      pendingDeletionGuardQueue.value = enqueuePendingDeletionGuard(
        pendingDeletionGuardQueue.value,
        {
          projectId: localProjectId,
          projectName: localProj.name,
          localActiveCount: reconciled.circuitBreaker.localActiveCount,
          newlyDeletedCount: reconciled.circuitBreaker.newlyDeletedCount,
          deletionRatio: reconciled.circuitBreaker.deletionRatio,
          pendingDeletes: reconciled.incomingDeletes,
        },
      )
      return
    }

    if (reconciled.incomingDeletes.length > 0) {
      await applyRemoteTransactionsList(
        localProjectId,
        reconciled.incomingDeletes,
      )
    }

    syncStatusByProject.value = {
      ...syncStatusByProject.value,
      [localProjectId]: 'synced',
    }
    lastSyncedAtByProject.value = {
      ...lastSyncedAtByProject.value,
      [localProjectId]: Date.now(),
    }
  }

  async function approvePendingRemoteDeletes(projectId?: string): Promise<number> {
    const ctx = requireContext()
    const { removed: guard, nextQueue } = dequeuePendingDeletionGuard(
      pendingDeletionGuardQueue.value,
      projectId,
    )
    if (!guard) return 0
    pendingDeletionGuardQueue.value = nextQueue

    const currentLocalProjectTxs = ctx.transactions.value.filter(
      (tx) => tx.projectId === guard.projectId,
    )
    const approvableDeletes = filterApprovableRemoteDeletes(
      currentLocalProjectTxs,
      guard.pendingDeletes,
    )
    if (approvableDeletes.length > 0) {
      await applyRemoteTransactionsList(guard.projectId, approvableDeletes)
    }
    return approvableDeletes.length
  }

  async function rejectPendingRemoteDeletes(projectId?: string): Promise<number> {
    const ctx = requireContext()
    const { removed: guard, nextQueue } = dequeuePendingDeletionGuard(
      pendingDeletionGuardQueue.value,
      projectId,
    )
    if (!guard) return 0
    pendingDeletionGuardQueue.value = nextQueue

    const now = Date.now()
    let restoredCount = 0
    for (const blockedDelete of guard.pendingDeletes) {
      const localTx = ctx.transactions.value.find(
        (t) => t.id === blockedDelete.id,
      )
      if (!localTx || localTx.isDeleted) continue
      const bumped: Transaction = {
        ...localTx,
        isDeleted: false,
        updatedAt: Math.max(now, blockedDelete.updatedAt + 1),
      }
      const saved = await saveTransactionToNormalVault(bumped)
      ctx.transactions.value = ctx.transactions.value.map((t) =>
        t.id === saved.id ? saved : t,
      )
      await enqueueAndFlushProjectChange(
        guard.projectId,
        'transaction',
        saved.id,
        saved.updatedAt,
      )
      restoredCount += 1
    }
    return restoredCount
  }

  function unsubscribeProjectRealtime(projectId: string): void {
    const unsub = activeRealtimeUnsubscribers.get(projectId)
    if (unsub) {
      unsub()
      activeRealtimeUnsubscribers.delete(projectId)
    }
    const { nextQueue } = dequeuePendingDeletionGuard(
      pendingDeletionGuardQueue.value,
      projectId,
    )
    pendingDeletionGuardQueue.value = nextQueue
  }

  async function startProjectRealtimeListener(projectId: string): Promise<void> {
    const ctx = requireContext()
    const proj = ctx.projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    const shareId = proj?.syncMeta?.shareId
    if (!proj || proj.syncMeta?.mode !== 'firestore' || !shareId) return
    if (!isFirebaseConfigured()) {
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]: 'error',
      }
      return
    }
    if (activeRealtimeUnsubscribers.has(projectId)) return

    syncStatusByProject.value = {
      ...syncStatusByProject.value,
      [projectId]: 'connecting',
    }

    try {
      const unsub = await subscribeSharedProject(shareId, {
        onProjectChange: (remoteProj) => {
          void applyRemoteProjectUpdate(projectId, remoteProj)
        },
        onTransactionsBatch: (remoteTxs) => {
          void handleRemoteTransactionsBatch(projectId, remoteTxs)
        },
        onError: () => {
          syncStatusByProject.value = {
            ...syncStatusByProject.value,
            [projectId]:
              typeof navigator !== 'undefined' && navigator.onLine === false
                ? 'offline'
                : 'error',
          }
        },
      })
      activeRealtimeUnsubscribers.set(projectId, unsub)
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]: 'synced',
      }
      lastSyncedAtByProject.value = {
        ...lastSyncedAtByProject.value,
        [projectId]: Date.now(),
      }
      void flushProjectOutbox(projectId)
    } catch {
      syncStatusByProject.value = {
        ...syncStatusByProject.value,
        [projectId]:
          typeof navigator !== 'undefined' && navigator.onLine === false
            ? 'offline'
            : 'error',
      }
    }
  }

  async function startAllSharedProjectListeners(): Promise<void> {
    if (!isFirebaseConfigured()) return
    const ctx = requireContext()
    const sharedProjects = ctx.projects.value.filter(
      (p) =>
        !p.isDeleted && p.syncMeta?.mode === 'firestore' && p.syncMeta.shareId,
    )
    for (const proj of sharedProjects) {
      await startProjectRealtimeListener(proj.id)
    }
  }

  function stopAllSharedProjectListeners(): void {
    for (const unsub of activeRealtimeUnsubscribers.values()) {
      unsub()
    }
    activeRealtimeUnsubscribers.clear()
  }

  async function enableProjectRealtimeSync(
    projectId: string,
    options: { myMemberId?: string; syncReceiptImages?: boolean } = {},
  ): Promise<{ shareId: string; accessKey: string; omittedImageTxCount: number }> {
    const ctx = requireContext()
    const existing = ctx.projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) {
      throw new Error('ERR_PROJECT_NOT_FOUND')
    }

    const syncImages = options.syncReceiptImages !== false
    const projTxs = ctx.transactions.value.filter(
      (tx) => tx.projectId === projectId,
    )
    const published = await publishProjectToFirestore(existing, projTxs, syncImages)

    const updated: Project = {
      ...existing,
      defaultPayerId: options.myMemberId || existing.defaultPayerId,
      syncMeta: {
        mode: 'firestore',
        shareId: published.shareId,
        accessKey: published.accessKey,
        role: 'owner',
        myMemberId: options.myMemberId || existing.defaultPayerId,
        syncReceiptImages: syncImages,
        lastSyncedAt: published.syncedAt,
      },
      members: existing.members.map((m) => ({ ...m })),
    }

    const saved = await saveProjectToNormalVault(updated)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === projectId ? saved : p,
    )
    await startProjectRealtimeListener(projectId)

    return {
      shareId: published.shareId,
      accessKey: published.accessKey,
      omittedImageTxCount: published.omittedImageTxCount,
    }
  }

  async function fetchSharedProjectForJoin(
    shareId: string,
    accessKey: string,
  ): Promise<{ project: Project; transactions: Transaction[] }> {
    const res = await joinSharedProjectOnFirestore(shareId, accessKey)
    return { project: res.project, transactions: res.transactions }
  }

  async function finalizeJoinSharedProject(params: {
    shareId: string
    accessKey: string
    remoteProject: Project
    remoteTransactions: Transaction[]
    selectedMemberId?: string
    newMemberName?: string
    applyMyProfile?: boolean
  }): Promise<Project> {
    const ctx = requireContext()
    const now = Date.now()
    const plainRemoteProject = ctx.toPlainClone(params.remoteProject)
    const plainRemoteTransactions = ctx.toPlainClone(params.remoteTransactions)

    let members = plainRemoteProject.members.map((m) => ({ ...m }))
    let claimedMemberId = params.selectedMemberId
    let projectMemberChanged = false

    const trimmedNewName = params.newMemberName?.trim()
    if (!claimedMemberId && trimmedNewName) {
      const createdMember: ProjectMember = {
        id: `m_${members.length + 1}_${now.toString(36)}`,
        name: trimmedNewName,
        avatarColor:
          ctx.userProfile.value.avatarColor ||
          AVATAR_PALETTE[members.length % AVATAR_PALETTE.length],
        ...(ctx.userProfile.value.avatarImage
          ? { avatarImage: ctx.userProfile.value.avatarImage }
          : {}),
        ...(ctx.userProfile.value.paymentInfo
          ? { paymentInfo: ctx.userProfile.value.paymentInfo }
          : {}),
      }
      members = [...members, createdMember]
      claimedMemberId = createdMember.id
      projectMemberChanged = true
    } else if (claimedMemberId && params.applyMyProfile) {
      const profile = ctx.userProfile.value
      const hasProfileCustom = Boolean(
        profile.displayName ||
          profile.avatarImage ||
          profile.avatarColor ||
          profile.paymentInfo,
      )
      if (hasProfileCustom) {
        members = members.map((m) => {
          if (m.id !== claimedMemberId) return m
          return {
            ...m,
            name: profile.displayName || m.name,
            avatarColor: profile.avatarColor || m.avatarColor,
            ...(profile.avatarImage
              ? { avatarImage: profile.avatarImage }
              : {}),
            ...(profile.paymentInfo
              ? { paymentInfo: profile.paymentInfo }
              : {}),
          }
        })
        projectMemberChanged = true
      }
    }

    const existingLocal = ctx.projects.value.find(
      (p) => p.id === plainRemoteProject.id,
    )

    const joinedProject: Project = {
      ...plainRemoteProject,
      members,
      isActive: true,
      isDeleted: false,
      isArchived: false,
      defaultPayerId: claimedMemberId || members[0]?.id,
      updatedAt: projectMemberChanged
        ? Math.max(now, plainRemoteProject.updatedAt + 1)
        : plainRemoteProject.updatedAt,
      syncMeta: {
        mode: 'firestore',
        shareId: params.shareId,
        accessKey: params.accessKey,
        role: existingLocal?.syncMeta?.role ?? 'editor',
        myMemberId: claimedMemberId || members[0]?.id,
        syncReceiptImages: true,
        lastSyncedAt: now,
      },
    }

    const savedProj = await saveProjectToNormalVault(joinedProject)
    if (existingLocal) {
      ctx.projects.value = ctx.projects.value.map((p) =>
        p.id === savedProj.id ? savedProj : p,
      )
    } else {
      ctx.projects.value = [savedProj, ...ctx.projects.value]
      ctx.projectOrder.value = [
        savedProj.id,
        ...ctx.projectOrder.value.filter((id) => id !== savedProj.id),
      ]
      ctx.saveUserPrefs()
    }

    await applyRemoteTransactionsList(savedProj.id, plainRemoteTransactions)

    if (projectMemberChanged) {
      await enqueueAndFlushProjectChange(
        savedProj.id,
        'project',
        savedProj.id,
        savedProj.updatedAt,
      )
    }

    ctx.activeProjectId.value = savedProj.id
    ctx.persistActiveProjectId(savedProj.id)
    await startProjectRealtimeListener(savedProj.id)
    return savedProj
  }

  async function setMyMemberForProject(
    projectId: string,
    memberId: string,
  ): Promise<void> {
    const ctx = requireContext()
    const existing = ctx.projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    if (!existing) return
    if (!existing.members.some((m) => m.id === memberId)) return

    const updated: Project = {
      ...existing,
      defaultPayerId: memberId,
      syncMeta: existing.syncMeta
        ? { ...existing.syncMeta, myMemberId: memberId }
        : undefined,
      members: existing.members.map((m) => ({ ...m })),
    }
    const saved = await saveProjectToNormalVault(updated)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === projectId ? saved : p,
    )
  }

  async function rotateProjectInviteLink(
    projectId: string,
  ): Promise<{ shareId: string; accessKey: string } | null> {
    const ctx = requireContext()
    const existing = ctx.projects.value.find(
      (p) => p.id === projectId && !p.isDeleted,
    )
    const shareId = existing?.syncMeta?.shareId
    if (!existing || existing.syncMeta?.mode !== 'firestore' || !shareId) {
      return null
    }
    const nextAccessKey = await rotateProjectAccessKeyOnFirestore(shareId)
    const updated: Project = {
      ...existing,
      syncMeta: {
        ...existing.syncMeta,
        accessKey: nextAccessKey,
        lastSyncedAt: Date.now(),
      },
      members: existing.members.map((m) => ({ ...m })),
    }
    const saved = await saveProjectToNormalVault(updated)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === projectId ? saved : p,
    )
    return { shareId, accessKey: nextAccessKey }
  }

  async function stopProjectRealtimeSync(projectId: string): Promise<void> {
    const ctx = requireContext()
    unsubscribeProjectRealtime(projectId)
    await clearProjectSyncOutbox(projectId)
    await refreshOutboxCounts()

    const existing = ctx.projects.value.find((p) => p.id === projectId)
    if (!existing) return
    const updated: Project = {
      ...existing,
      syncMeta: undefined,
      members: existing.members.map((m) => ({ ...m })),
    }
    const saved = await saveProjectToNormalVault(updated)
    ctx.projects.value = ctx.projects.value.map((p) =>
      p.id === projectId ? saved : p,
    )
    syncStatusByProject.value = {
      ...syncStatusByProject.value,
      [projectId]: 'local',
    }
  }

  function saveCustomFirebaseConfig(raw: string): void {
    parseAndSaveCustomFirebaseConfig(raw)
  }

  function getRealtimeSyncErrorCode(
    err: unknown,
  ): FirestoreSyncErrorCode | null {
    return err instanceof FirestoreSyncError ? err.code : null
  }

  return {
    syncStatusByProject,
    lastSyncedAtByProject,
    outboxCountByProject,
    pendingDeletionGuard,
    pendingDeletionGuardCount,
    bindLedgerContext,
    refreshOutboxCounts,
    isProjectRealtimeSynced,
    enqueueAndFlushProjectChange,
    flushProjectOutbox,
    flushAllSharedProjectsOutbox,
    applyRemoteProjectUpdate,
    applyRemoteTransactionsList,
    handleRemoteTransactionsBatch,
    approvePendingRemoteDeletes,
    rejectPendingRemoteDeletes,
    unsubscribeProjectRealtime,
    startProjectRealtimeListener,
    startAllSharedProjectListeners,
    stopAllSharedProjectListeners,
    enableProjectRealtimeSync,
    fetchSharedProjectForJoin,
    finalizeJoinSharedProject,
    setMyMemberForProject,
    rotateProjectInviteLink,
    stopProjectRealtimeSync,
    isFirebaseConfigured,
    hasBuiltInFirebaseConfig,
    getCustomFirebaseConfig,
    saveCustomFirebaseConfig,
    clearCustomFirebaseConfig,
    getRealtimeSyncErrorCode,
  }
})
