/**
 * 離線同步 Outbox 推送協調器（純 TypeScript 邏輯）
 * 解決兩類競態問題：
 * 1. 推送期間同筆實體再次被修改：清除時比對 updatedAt <= pushedUpdatedAt，保留較新版本避免更新遺失。
 * 2. 推送期間有新項目排入或有同筆更新保留：於本輪結束後自動再排程一次，不因並發鎖定而遺漏延後。
 */

export interface OutboxEntry {
  key: string
  projectId: string
  entityType: 'project' | 'transaction'
  entityId: string
  updatedAt: number
}

export interface OutboxRemoveCondition {
  key: string
  pushedUpdatedAt: number
}

export type OutboxFlushStatus = 'synced' | 'offline' | 'error'

export interface OutboxFlusherDeps {
  /** 判斷該專案是否符合推送條件（例如已啟用 Firestore 共享且設定完成） */
  canFlushProject: (projectId: string) => boolean
  /** 目前裝置是否處於連線狀態 */
  isOnline: () => boolean
  /** 列出指定專案目前待推送的 Outbox 項目 */
  listItems: (projectId: string) => Promise<OutboxEntry[]>
  /**
   * 推送單筆項目至遠端，回傳實際推送出的實體 updatedAt（若本地實體已不存在回傳 undefined，
   * 將退回使用 item.updatedAt 作為條件刪除基準）。
   */
  pushItem: (projectId: string, item: OutboxEntry) => Promise<number | undefined>
  /** 僅刪除目前 updatedAt <= pushedUpdatedAt 的項目，回傳實際刪除之鍵值清單 */
  removeIfNotNewer: (entries: OutboxRemoveCondition[]) => Promise<string[]>
  /** Outbox 數量變動後更新顯示計數 */
  onCountsChanged?: () => Promise<void> | void
  /** 同步狀態回報 */
  onStatusChange?: (
    projectId: string,
    status: OutboxFlushStatus,
    syncedAt?: number,
  ) => void
  /** 排程下一輪 flush（預設使用 queueMicrotask） */
  scheduleNext?: (task: () => void) => void
  /** 單專案連續自動重排程上限（預設 20，防止異常環境無窮迴圈） */
  maxConsecutiveReschedules?: number
}

export interface OutboxFlusher {
  flush: (projectId: string) => Promise<void>
  isFlushing: (projectId: string) => boolean
}

const DEFAULT_MAX_CONSECUTIVE_RESCHEDULES = 20

export function createOutboxFlusher(deps: OutboxFlusherDeps): OutboxFlusher {
  const flushingProjectIds = new Set<string>()
  const rescheduleRequestedProjectIds = new Set<string>()
  const consecutiveRoundsByProject = new Map<string, number>()
  const maxReschedules =
    deps.maxConsecutiveReschedules ?? DEFAULT_MAX_CONSECUTIVE_RESCHEDULES
  const scheduleNext =
    deps.scheduleNext ?? ((task: () => void) => queueMicrotask(task))

  async function flush(projectId: string): Promise<void> {
    if (!deps.canFlushProject(projectId)) return

    if (!deps.isOnline()) {
      deps.onStatusChange?.(projectId, 'offline')
      return
    }

    if (flushingProjectIds.has(projectId)) {
      // 記錄推送期間又有新呼叫，待本輪結束後立即補跑一次
      rescheduleRequestedProjectIds.add(projectId)
      return
    }

    flushingProjectIds.add(projectId)
    let shouldReschedule = false
    let hadError = false
    const succeeded: OutboxRemoveCondition[] = []

    try {
      const pendingItems = await deps.listItems(projectId)
      if (pendingItems.length === 0) {
        consecutiveRoundsByProject.delete(projectId)
        return
      }

      for (const item of pendingItems) {
        const pushedVersion = await deps.pushItem(projectId, item)
        const pushedUpdatedAt =
          typeof pushedVersion === 'number'
            ? Math.max(item.updatedAt, pushedVersion)
            : item.updatedAt
        succeeded.push({
          key: item.key,
          pushedUpdatedAt,
        })
      }

      await deps.removeIfNotNewer(succeeded)
      await deps.onCountsChanged?.()

      const remainingItems = await deps.listItems(projectId)
      if (remainingItems.length > 0) {
        shouldReschedule = true
      } else {
        consecutiveRoundsByProject.delete(projectId)
        deps.onStatusChange?.(projectId, 'synced', Date.now())
      }
    } catch {
      hadError = true
      if (succeeded.length > 0) {
        try {
          await deps.removeIfNotNewer(succeeded)
          await deps.onCountsChanged?.()
        } catch {
          // 忽略次級清理錯誤，保留原始同步失敗狀態
        }
      }
      consecutiveRoundsByProject.delete(projectId)
      deps.onStatusChange?.(projectId, deps.isOnline() ? 'error' : 'offline')
    } finally {
      flushingProjectIds.delete(projectId)
      const requestedDuringFlush = rescheduleRequestedProjectIds.delete(projectId)
      if (!hadError && (shouldReschedule || requestedDuringFlush)) {
        const nextRound = (consecutiveRoundsByProject.get(projectId) ?? 0) + 1
        if (nextRound <= maxReschedules) {
          consecutiveRoundsByProject.set(projectId, nextRound)
          scheduleNext(() => {
            void flush(projectId)
          })
        } else {
          consecutiveRoundsByProject.delete(projectId)
        }
      }
    }
  }

  return {
    flush,
    isFlushing: (projectId: string) => flushingProjectIds.has(projectId),
  }
}
