/**
 * Google Drive 同步 dirty 世代計數器（純 TypeScript 邏輯）
 * 解決同步進行中產生新變更時，同步完成後無條件清除 dirty 導致更新遺漏上傳的競態問題：
 * - 每次本地資料異動遞增 dirty 世代計數（generation）。
 * - 同步啟動時建立 session 記錄 startGeneration；若執行上傳，於建立備份快照當下記錄 snapshotGeneration。
 * - 同步成功結束時，僅當「此次同步實際覆蓋了最新世代」才允許清除 dirty，否則維持 dirty 以便再排程上傳。
 */

export interface DriveSyncCompletionResult {
  /** 本輪同步後是否已安全清除 dirty（或原本即為乾淨且無新變更） */
  cleared: boolean
  /** 本輪同步後是否仍有尚未上傳的新變更 */
  stillDirty: boolean
  /** 目前的 dirty 世代計數 */
  generation: number
}

export interface DriveSyncSession {
  /** 同步開始當下的世代計數 */
  readonly startGeneration: number
  /** 同步開始時本機是否處於 dirty 狀態 */
  readonly wasDirtyAtStart: boolean
  /** 於實際擷取待上傳備份快照（getMergedBackup）當下記錄世代 */
  recordUploadSnapshot: () => number
  /** 同步成功結束時呼叫，依世代比對決定是否可安全清除 dirty */
  complete: (params: { uploaded: boolean }) => DriveSyncCompletionResult
}

export interface DriveDirtyTracker {
  isDirty: () => boolean
  getGeneration: () => number
  markDirty: () => number
  beginSync: () => DriveSyncSession
}

export function createDriveDirtyTracker(
  initialDirty = false,
): DriveDirtyTracker {
  let dirty = Boolean(initialDirty)
  let generation = dirty ? 1 : 0

  function markDirty(): number {
    dirty = true
    generation += 1
    return generation
  }

  function beginSync(): DriveSyncSession {
    const startGeneration = generation
    const wasDirtyAtStart = dirty
    let snapshotGeneration: number | null = null

    return {
      startGeneration,
      wasDirtyAtStart,
      recordUploadSnapshot(): number {
        snapshotGeneration = generation
        return snapshotGeneration
      },
      complete({ uploaded }): DriveSyncCompletionResult {
        const coveredAllChanges = uploaded
          ? generation === (snapshotGeneration ?? startGeneration)
          : !wasDirtyAtStart && generation === startGeneration

        if (coveredAllChanges) {
          dirty = false
          return {
            cleared: true,
            stillDirty: false,
            generation,
          }
        }

        dirty = true
        return {
          cleared: false,
          stillDirty: true,
          generation,
        }
      },
    }
  }

  return {
    isDirty: () => dirty,
    getGeneration: () => generation,
    markDirty,
    beginSync,
  }
}
