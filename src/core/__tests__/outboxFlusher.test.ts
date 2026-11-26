import { describe, expect, it, vi } from 'vitest'
import {
  createOutboxFlusher,
  type OutboxEntry,
  type OutboxFlushStatus,
} from '@/core/outboxFlusher'
import {
  applyConditionalOutboxRemoval,
  type SyncOutboxItem,
} from '@/db/normalVaultDb'

function createInMemoryOutbox() {
  const map = new Map<string, SyncOutboxItem>()

  return {
    map,
    enqueue(item: SyncOutboxItem) {
      const existing = map.get(item.key)
      if (existing && existing.updatedAt > item.updatedAt) return
      map.set(item.key, { ...item })
    },
    async list(projectId: string): Promise<OutboxEntry[]> {
      return Array.from(map.values())
        .filter((i) => i.projectId === projectId)
        .map((i) => ({ ...i }))
    },
    async removeIfNotNewer(
      entries: Array<{ key: string; pushedUpdatedAt: number }>,
    ): Promise<string[]> {
      return applyConditionalOutboxRemoval(
        {
          get: async (key) => map.get(key),
          delete: async (key) => {
            map.delete(key)
          },
        },
        entries,
      )
    },
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('applyConditionalOutboxRemoval', () => {
  it('僅刪除 updatedAt <= pushedUpdatedAt 的項目，保留較新版本', async () => {
    const outbox = createInMemoryOutbox()
    outbox.enqueue({
      key: 'transaction:tx-older',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-older',
      updatedAt: 100,
    })
    outbox.enqueue({
      key: 'transaction:tx-same',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-same',
      updatedAt: 200,
    })
    outbox.enqueue({
      key: 'transaction:tx-newer',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-newer',
      updatedAt: 350,
    })

    const deleted = await outbox.removeIfNotNewer([
      { key: 'transaction:tx-older', pushedUpdatedAt: 150 },
      { key: 'transaction:tx-same', pushedUpdatedAt: 200 },
      { key: 'transaction:tx-newer', pushedUpdatedAt: 300 },
      { key: 'transaction:tx-missing', pushedUpdatedAt: 999 },
    ])

    expect(deleted).toEqual(['transaction:tx-older', 'transaction:tx-same'])
    expect(outbox.map.has('transaction:tx-older')).toBe(false)
    expect(outbox.map.has('transaction:tx-same')).toBe(false)
    expect(outbox.map.get('transaction:tx-newer')?.updatedAt).toBe(350)
  })

  it('空清單時直接回傳空陣列', async () => {
    const outbox = createInMemoryOutbox()
    expect(await outbox.removeIfNotNewer([])).toEqual([])
  })
})

describe('createOutboxFlusher', () => {
  it('推送期間同筆資料再次修改：不誤刪較新版本，並於本輪結束後自動補推最新版本', async () => {
    const outbox = createInMemoryOutbox()
    const entityVersion = new Map<string, number>([['tx-1', 100]])
    outbox.enqueue({
      key: 'transaction:tx-1',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-1',
      updatedAt: 100,
    })

    const firstPushGate = createDeferred<void>()
    const pushedHistory: Array<{ entityId: string; version: number }> = []
    const statuses: OutboxFlushStatus[] = []
    const scheduledTasks: Array<() => void> = []

    const flusher = createOutboxFlusher({
      canFlushProject: () => true,
      isOnline: () => true,
      listItems: (pid) => outbox.list(pid),
      pushItem: async (_pid, item) => {
        const version = entityVersion.get(item.entityId) ?? item.updatedAt
        pushedHistory.push({ entityId: item.entityId, version })
        if (pushedHistory.length === 1) {
          await firstPushGate.promise
        }
        return version
      },
      removeIfNotNewer: (entries) => outbox.removeIfNotNewer(entries),
      onStatusChange: (_pid, status) => {
        statuses.push(status)
      },
      scheduleNext: (task) => {
        scheduledTasks.push(task)
      },
    })

    // 啟動第一輪推送（tx-1 v100 卡在網路中）
    const firstFlushPromise = flusher.flush('p1')
    await Promise.resolve()
    expect(flusher.isFlushing('p1')).toBe(true)

    // 推送期間使用者再次編輯 tx-1 → updatedAt 升為 200
    entityVersion.set('tx-1', 200)
    outbox.enqueue({
      key: 'transaction:tx-1',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-1',
      updatedAt: 200,
    })
    // 同步觸發的 flush 因並發鎖定先標記重排程
    await flusher.flush('p1')

    // 放行第一輪網路推送
    firstPushGate.resolve()
    await firstFlushPromise

    // 第一輪結束後：v200 不應被誤刪、尚未標記 synced、且已排程第二輪
    expect(outbox.map.get('transaction:tx-1')?.updatedAt).toBe(200)
    expect(statuses).toEqual([])
    expect(scheduledTasks).toHaveLength(1)

    // 執行排程的第二輪推送
    scheduledTasks.shift()!()
    await vi.waitFor(() => {
      expect(statuses).toEqual(['synced'])
    })

    expect(pushedHistory).toEqual([
      { entityId: 'tx-1', version: 100 },
      { entityId: 'tx-1', version: 200 },
    ])
    expect(outbox.map.size).toBe(0)
  })

  it('推送期間排入另一筆新交易：於本輪結束後自動觸發第二輪推送新交易', async () => {
    const outbox = createInMemoryOutbox()
    outbox.enqueue({
      key: 'transaction:tx-1',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-1',
      updatedAt: 100,
    })

    const gate = createDeferred<void>()
    const pushedIds: string[] = []
    const statuses: OutboxFlushStatus[] = []
    const scheduledTasks: Array<() => void> = []

    const flusher = createOutboxFlusher({
      canFlushProject: () => true,
      isOnline: () => true,
      listItems: (pid) => outbox.list(pid),
      pushItem: async (_pid, item) => {
        pushedIds.push(item.entityId)
        if (item.entityId === 'tx-1') {
          await gate.promise
        }
        return item.updatedAt
      },
      removeIfNotNewer: (entries) => outbox.removeIfNotNewer(entries),
      onStatusChange: (_pid, status) => statuses.push(status),
      scheduleNext: (task) => scheduledTasks.push(task),
    })

    const p1 = flusher.flush('p1')
    await Promise.resolve()

    // 推送 tx-1 期間新增 tx-2
    outbox.enqueue({
      key: 'transaction:tx-2',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-2',
      updatedAt: 150,
    })
    await flusher.flush('p1')

    gate.resolve()
    await p1

    expect(outbox.map.has('transaction:tx-1')).toBe(false)
    expect(outbox.map.has('transaction:tx-2')).toBe(true)
    expect(scheduledTasks).toHaveLength(1)

    scheduledTasks.shift()!()
    await vi.waitFor(() => {
      expect(statuses).toEqual(['synced'])
    })

    expect(pushedIds).toEqual(['tx-1', 'tx-2'])
    expect(outbox.map.size).toBe(0)
  })

  it('中途推送失敗時：保留已成功項目之清除結果、留下失敗項目並回報 error，且不無窮重排程', async () => {
    const outbox = createInMemoryOutbox()
    outbox.enqueue({
      key: 'transaction:tx-ok',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-ok',
      updatedAt: 100,
    })
    outbox.enqueue({
      key: 'transaction:tx-fail',
      projectId: 'p1',
      entityType: 'transaction',
      entityId: 'tx-fail',
      updatedAt: 110,
    })

    const statuses: OutboxFlushStatus[] = []
    const scheduleNext = vi.fn()

    const flusher = createOutboxFlusher({
      canFlushProject: () => true,
      isOnline: () => true,
      listItems: (pid) => outbox.list(pid),
      pushItem: async (_pid, item) => {
        if (item.entityId === 'tx-fail') {
          throw new Error('network failed')
        }
        return item.updatedAt
      },
      removeIfNotNewer: (entries) => outbox.removeIfNotNewer(entries),
      onStatusChange: (_pid, status) => statuses.push(status),
      scheduleNext,
    })

    await flusher.flush('p1')

    expect(outbox.map.has('transaction:tx-ok')).toBe(false)
    expect(outbox.map.has('transaction:tx-fail')).toBe(true)
    expect(statuses).toEqual(['error'])
    expect(scheduleNext).not.toHaveBeenCalled()
  })

  it('離線時回報 offline 且不讀取 Outbox', async () => {
    const listItems = vi.fn(async () => [])
    const statuses: OutboxFlushStatus[] = []

    const flusher = createOutboxFlusher({
      canFlushProject: () => true,
      isOnline: () => false,
      listItems,
      pushItem: async () => undefined,
      removeIfNotNewer: async () => [],
      onStatusChange: (_pid, status) => statuses.push(status),
    })

    await flusher.flush('p1')

    expect(listItems).not.toHaveBeenCalled()
    expect(statuses).toEqual(['offline'])
  })
})
