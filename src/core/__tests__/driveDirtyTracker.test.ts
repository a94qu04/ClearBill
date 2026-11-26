import { describe, expect, it } from 'vitest'
import { createDriveDirtyTracker } from '../driveDirtyTracker'

describe('createDriveDirtyTracker', () => {
  it('正常同步完成且期間無新變更時應安全清除 dirty', () => {
    const tracker = createDriveDirtyTracker(false)
    expect(tracker.isDirty()).toBe(false)
    expect(tracker.getGeneration()).toBe(0)

    const gen = tracker.markDirty()
    expect(gen).toBe(1)
    expect(tracker.isDirty()).toBe(true)

    const session = tracker.beginSync()
    expect(session.startGeneration).toBe(1)
    expect(session.wasDirtyAtStart).toBe(true)
    expect(session.recordUploadSnapshot()).toBe(1)

    const result = session.complete({ uploaded: true })
    expect(result).toEqual({
      cleared: true,
      stillDirty: false,
      generation: 1,
    })
    expect(tracker.isDirty()).toBe(false)
  })

  it('上傳進行中（快照擷取後）產生新寫入時，不得清除 dirty，待下一輪上傳後才清除', () => {
    const tracker = createDriveDirtyTracker(true)
    expect(tracker.isDirty()).toBe(true)
    expect(tracker.getGeneration()).toBe(1)

    // 第一輪同步開始並擷取備份快照（世代 1）
    const session1 = tracker.beginSync()
    expect(session1.recordUploadSnapshot()).toBe(1)

    // 模擬上傳 HTTP 請求進行中，使用者又新增一筆交易（世代前進至 2）
    expect(tracker.markDirty()).toBe(2)

    // 第一輪上傳完成：世代已前進，不得清除 dirty
    const result1 = session1.complete({ uploaded: true })
    expect(result1).toEqual({
      cleared: false,
      stillDirty: true,
      generation: 2,
    })
    expect(tracker.isDirty()).toBe(true)

    // 第二輪同步接手並完成（無新寫入）：安全清除 dirty
    const session2 = tracker.beginSync()
    expect(session2.startGeneration).toBe(2)
    expect(session2.recordUploadSnapshot()).toBe(2)
    const result2 = session2.complete({ uploaded: true })
    expect(result2).toEqual({
      cleared: true,
      stillDirty: false,
      generation: 2,
    })
    expect(tracker.isDirty()).toBe(false)
  })

  it('OAuth／下載階段有新寫入但後續備份快照已涵蓋並成功上傳，完成後可清除 dirty', () => {
    const tracker = createDriveDirtyTracker(true)
    const session = tracker.beginSync()
    expect(session.startGeneration).toBe(1)

    // 同步開始後、擷取上傳快照前產生的新變更
    expect(tracker.markDirty()).toBe(2)

    // 實際擷取備份時已包含世代 2 的最新資料
    expect(session.recordUploadSnapshot()).toBe(2)

    const result = session.complete({ uploaded: true })
    expect(result).toEqual({
      cleared: true,
      stillDirty: false,
      generation: 2,
    })
    expect(tracker.isDirty()).toBe(false)
  })

  it('原本乾淨且本次同步未上傳（skippedNoChanges / 僅下載合併），期間有新寫入不得清除 dirty', () => {
    const tracker = createDriveDirtyTracker(false)
    const session = tracker.beginSync()
    expect(session.wasDirtyAtStart).toBe(false)
    expect(session.startGeneration).toBe(0)

    // 查檔或合併遠端資料期間，使用者寫入新交易
    expect(tracker.markDirty()).toBe(1)

    // 即使 getMergedBackup 有被呼叫，但最終未執行上傳（uploaded: false）
    session.recordUploadSnapshot()
    const result = session.complete({ uploaded: false })
    expect(result).toEqual({
      cleared: false,
      stillDirty: true,
      generation: 1,
    })
    expect(tracker.isDirty()).toBe(true)
  })

  it('原本為 dirty 但本次同步未上傳（uploaded: false）時仍應保留 dirty', () => {
    const tracker = createDriveDirtyTracker(true)
    const session = tracker.beginSync()

    const result = session.complete({ uploaded: false })
    expect(result).toEqual({
      cleared: false,
      stillDirty: true,
      generation: 1,
    })
    expect(tracker.isDirty()).toBe(true)
  })

  it('原本乾淨、無中途寫入且未上傳（快速略過）時保持乾淨', () => {
    const tracker = createDriveDirtyTracker(false)
    const session = tracker.beginSync()

    const result = session.complete({ uploaded: false })
    expect(result).toEqual({
      cleared: true,
      stillDirty: false,
      generation: 0,
    })
    expect(tracker.isDirty()).toBe(false)
  })

  it('同步中途失敗（未呼叫 complete）時保留 dirty 與既有世代', () => {
    const tracker = createDriveDirtyTracker(true)
    const session = tracker.beginSync()
    session.recordUploadSnapshot()
    tracker.markDirty()

    // 模擬拋錯未呼叫 session.complete
    expect(tracker.isDirty()).toBe(true)
    expect(tracker.getGeneration()).toBe(2)
  })
})
