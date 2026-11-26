import { describe, expect, it, vi } from 'vitest'
import { dispatchHashRoute } from '@/composables/useHashRoute'
import type { Project } from '@/schemas/ledgerSchema'

function createSampleProject(): Project {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    schemaVersion: 1,
    name: '東京五日遊',
    baseCurrency: 'TWD',
    defaultSplitMode: 'equal',
    defaultPayerId: 'm1',
    isActive: true,
    members: [
      { id: 'm1', name: '小明' },
      { id: 'm2', name: '小華' },
    ],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function buildCallbacks(activeProject: Project | null = createSampleProject()) {
  return {
    getActiveProject: () => activeProject,
    getDefaultCurrency: () => 'TWD',
    clearHash: vi.fn(),
    saveClientId: vi.fn(),
    onGoogleConnected: vi.fn(),
    onGoogleConnectInvalid: vi.fn(),
    onJoinInvite: vi.fn(),
    onJoinInvalid: vi.fn(),
    onQuickIntakeApplied: vi.fn(),
    onQuickIntakeNeedProject: vi.fn(),
  }
}

describe('dispatchHashRoute', () => {
  it('非支援的 hash 應回傳 ignored 且不清除網址列', () => {
    const cb = buildCallbacks()
    const res = dispatchHashRoute({
      ...cb,
      hash: '#/unknown',
      href: 'https://clearbill.app/#/unknown',
    })
    expect(res).toBe('ignored')
    expect(cb.clearHash).not.toHaveBeenCalled()
  })

  it('#/connect-google 有效時應儲存 clientId 並通知 onGoogleConnected', () => {
    const cb = buildCallbacks()
    const clientId = '1234567890-abc.apps.googleusercontent.com'
    const hash = `#/connect-google?cid=${encodeURIComponent(clientId)}`
    const res = dispatchHashRoute({
      ...cb,
      hash,
      href: `https://clearbill.app/${hash}`,
    })
    expect(res).toBe('connect_google')
    expect(cb.clearHash).toHaveBeenCalledTimes(1)
    expect(cb.saveClientId).toHaveBeenCalledWith(clientId)
    expect(cb.onGoogleConnected).toHaveBeenCalledWith(clientId)
    expect(cb.onGoogleConnectInvalid).not.toHaveBeenCalled()
  })

  it('#/connect-google 缺參數時應清除 hash 並觸發 onGoogleConnectInvalid', () => {
    const cb = buildCallbacks()
    const res = dispatchHashRoute({
      ...cb,
      hash: '#/connect-google',
      href: 'https://clearbill.app/#/connect-google',
    })
    expect(res).toBe('connect_google_invalid')
    expect(cb.clearHash).toHaveBeenCalledTimes(1)
    expect(cb.saveClientId).not.toHaveBeenCalled()
    expect(cb.onGoogleConnectInvalid).toHaveBeenCalledTimes(1)
  })

  it('#/join 有效邀請應解析並觸發 onJoinInvite', () => {
    const cb = buildCallbacks()
    const hash = '#/join?s=share_123456&k=secret_key_1234567890'
    const res = dispatchHashRoute({
      ...cb,
      hash,
      href: `https://clearbill.app/${hash}`,
    })
    expect(res).toBe('join')
    expect(cb.clearHash).toHaveBeenCalledTimes(1)
    expect(cb.onJoinInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        shareId: 'share_123456',
        accessKey: 'secret_key_1234567890',
      }),
    )
  })

  it('#/join 無效參數應觸發 onJoinInvalid', () => {
    const cb = buildCallbacks()
    const res = dispatchHashRoute({
      ...cb,
      hash: '#/join?s=only_s',
      href: 'https://clearbill.app/#/join?s=only_s',
    })
    expect(res).toBe('join_invalid')
    expect(cb.clearHash).toHaveBeenCalledTimes(1)
    expect(cb.onJoinInvalid).toHaveBeenCalledTimes(1)
  })

  it('#/quick-add 在有活躍專案時應觸發 onQuickIntakeApplied', () => {
    const cb = buildCallbacks(createSampleProject())
    const hash = '#/quick-add?amount=350&merchant=%E4%B8%80%E8%98%AD%E6%8B%89%E9%BA%B5&sourceApp=ApplePay'
    const res = dispatchHashRoute({
      ...cb,
      hash,
      href: `https://clearbill.app/${hash}`,
    })
    expect(res).toBe('quick_add_applied')
    expect(cb.clearHash).toHaveBeenCalledTimes(1)
    expect(cb.onQuickIntakeApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        amount: 350,
        merchant: '一蘭拉麵',
      }),
    )
  })

  it('#/quick-add 在無活躍專案但有金額或商家時應觸發 onQuickIntakeNeedProject', () => {
    const cb = buildCallbacks(null)
    const hash = '#/quick-add?amount=120&merchant=星巴克'
    const res = dispatchHashRoute({
      ...cb,
      hash,
      href: `https://clearbill.app/${hash}`,
    })
    expect(res).toBe('quick_add_need_project')
    expect(cb.clearHash).toHaveBeenCalledTimes(1)
    expect(cb.onQuickIntakeNeedProject).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 120,
        merchant: '星巴克',
      }),
    )
  })
})
