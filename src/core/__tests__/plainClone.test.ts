import { describe, expect, it } from 'vitest'
import { reactive, ref, toRaw } from 'vue'
import { cloneAsPlain, deepUnwrap } from '@/core/plainClone'

describe('plainClone', () => {
  it('直接回傳原始型別值（含 undefined 與 null）', () => {
    expect(cloneAsPlain(undefined, toRaw)).toBeUndefined()
    expect(cloneAsPlain(null, toRaw)).toBeNull()
    expect(cloneAsPlain(42, toRaw)).toBe(42)
    expect(cloneAsPlain('clearbill', toRaw)).toBe('clearbill')
    expect(cloneAsPlain(true, toRaw)).toBe(true)
  })

  it('保留 undefined 屬性與非 JSON 原生型別（Date、NaN、Map、Set、Uint8Array）', () => {
    const created = new Date('2026-11-26T10:00:00.000Z')
    const bytes = new Uint8Array([1, 2, 3])
    const source = {
      id: 'tx_1',
      note: undefined as string | undefined,
      ratio: Number.NaN,
      createdAt: created,
      tags: new Set(['food', 'tokyo']),
      rates: new Map([['JPY', 0.21]]),
      rawBytes: bytes,
    }

    const cloned = cloneAsPlain(source, toRaw)
    expect(cloned).not.toBe(source)
    expect('note' in cloned).toBe(true)
    expect(cloned.note).toBeUndefined()
    expect(Number.isNaN(cloned.ratio)).toBe(true)
    expect(cloned.createdAt).toBeInstanceOf(Date)
    expect(cloned.createdAt.getTime()).toBe(created.getTime())
    expect(cloned.createdAt).not.toBe(created)
    expect(cloned.tags).toBeInstanceOf(Set)
    expect(Array.from(cloned.tags)).toEqual(['food', 'tokyo'])
    expect(cloned.rates).toBeInstanceOf(Map)
    expect(cloned.rates.get('JPY')).toBe(0.21)
    expect(cloned.rawBytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(cloned.rawBytes)).toEqual([1, 2, 3])
    expect(cloned.rawBytes).not.toBe(bytes)
  })

  it('可深拷貝 Vue ref / reactive 物件與陣列，且修改拷貝不影響原狀態', () => {
    const state = ref([
      {
        id: 'tx_1',
        amount: 1200,
        receiptImages: ['data:image/jpeg;base64,AAA'],
        splitConfig: {
          mode: 'equal',
          shares: [{ memberId: 'm1', finalAmount: 1200 }],
        },
      },
    ])

    const cloned = cloneAsPlain(state.value, toRaw)
    expect(cloned).toEqual(state.value)
    expect(cloned).not.toBe(state.value)
    expect(cloned[0]).not.toBe(toRaw(state.value)[0])
    expect(cloned[0].receiptImages).not.toBe(toRaw(state.value)[0].receiptImages)

    // 修改拷貝不應污染原 Vue 狀態
    cloned[0].amount = 9999
    cloned[0].receiptImages.push('data:image/jpeg;base64,BBB')
    cloned[0].splitConfig.shares[0].finalAmount = 9999

    expect(state.value[0].amount).toBe(1200)
    expect(state.value[0].receiptImages).toEqual(['data:image/jpeg;base64,AAA'])
    expect(state.value[0].splitConfig.shares[0].finalAmount).toBe(1200)
  })

  it('遇到內層巢狀 Vue Reactive Proxy 時可自動回退 deepUnwrap 並成功 structuredClone', () => {
    const nestedMember = reactive({ id: 'm1', name: 'Alice', note: undefined as string | undefined })
    const nestedTags = reactive(new Set(['japan']))
    // 刻意將 reactive Proxy 塞入一般物件與陣列中，模擬巢狀 Proxy 情境
    const container = {
      id: 'p1',
      members: [nestedMember],
      meta: {
        owner: nestedMember,
        tags: nestedTags,
      },
    }

    // 未解包前直接 structuredClone 會因 Proxy 拋出 DataCloneError
    expect(() => structuredClone(container)).toThrow()

    const cloned = cloneAsPlain(container, toRaw)
    expect(cloned).toEqual({
      id: 'p1',
      members: [{ id: 'm1', name: 'Alice', note: undefined }],
      meta: {
        owner: { id: 'm1', name: 'Alice', note: undefined },
        tags: new Set(['japan']),
      },
    })
    expect('note' in cloned.members[0]).toBe(true)
    expect(cloned.members[0].note).toBeUndefined()
    // 結果必須已脫離 Proxy，可再次被 IndexedDB 的 structuredClone 接受
    expect(() => structuredClone(cloned)).not.toThrow()
  })

  it('deepUnwrap 可安全處理循環參考不致堆疊溢位', () => {
    interface Node {
      name: string
      self?: Node
    }
    const rawNode: Node = { name: 'root' }
    rawNode.self = reactive(rawNode) as Node

    const unwrapped = deepUnwrap(rawNode, toRaw)
    expect(unwrapped.name).toBe('root')
    expect(unwrapped.self).toBe(unwrapped)
    expect(() => structuredClone(unwrapped)).not.toThrow()
  })
})
