import { describe, expect, it, vi } from 'vitest'
import {
  copyTextToClipboard,
  shareFiles,
  shareOrCopyText,
  useClipboardShare,
  type ClipboardShareDocumentLike,
  type ClipboardShareTextareaLike,
} from '@/composables/useClipboardShare'

function createMockDocument(execResult = true) {
  const created: ClipboardShareTextareaLike[] = []
  const appended: unknown[] = []
  const removed: unknown[] = []

  const doc: ClipboardShareDocumentLike = {
    body: {
      appendChild: vi.fn((node: unknown) => {
        appended.push(node)
        return node
      }),
      removeChild: vi.fn((node: unknown) => {
        removed.push(node)
        return node
      }),
    },
    createElement: vi.fn(() => {
      const ta: ClipboardShareTextareaLike = {
        value: '',
        style: { position: '', opacity: '' },
        select: vi.fn(),
        setSelectionRange: vi.fn(),
      }
      created.push(ta)
      return ta
    }),
    execCommand: vi.fn(() => execResult),
  }

  return { doc, created, appended, removed }
}

describe('useClipboardShare', () => {
  it('copyTextToClipboard 優先使用 navigator.clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const { doc } = createMockDocument(true)

    const ok = await copyTextToClipboard('hello clearbill', {
      navigator: { clipboard: { writeText } },
      document: doc,
    })

    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello clearbill')
    expect(doc.createElement).not.toHaveBeenCalled()
  })

  it('Clipboard API 失敗時應降級至隱藏 textarea + execCommand 並移除節點', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    const { doc, created, appended, removed } = createMockDocument(true)

    const ok = await copyTextToClipboard('fallback text', {
      navigator: { clipboard: { writeText } },
      document: doc,
    })

    expect(ok).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]?.value).toBe('fallback text')
    expect(created[0]?.select).toHaveBeenCalledTimes(1)
    expect(created[0]?.setSelectionRange).toHaveBeenCalledWith(0, 'fallback text'.length)
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    expect(appended).toHaveLength(1)
    expect(removed).toHaveLength(1)
    expect(removed[0]).toBe(appended[0])
  })

  it('execCommand 回傳 false 或拋錯時應回傳 false 且仍清理 textarea', async () => {
    const { doc: docFalse, removed: removedFalse } = createMockDocument(false)
    expect(
      await copyTextToClipboard('nope', { navigator: null, document: docFalse }),
    ).toBe(false)
    expect(removedFalse).toHaveLength(1)

    const { doc: docThrow, removed: removedThrow } = createMockDocument(true)
    docThrow.execCommand = vi.fn(() => {
      throw new Error('execCommand failed')
    })
    expect(
      await copyTextToClipboard('boom', { navigator: null, document: docThrow }),
    ).toBe(false)
    expect(removedThrow).toHaveLength(1)
  })

  it('shareOrCopyText 在原生分享成功時回傳 shared 且不觸發剪貼簿', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)

    const result = await shareOrCopyText(
      { title: '旅遊結算', text: '摘要內容', url: 'https://example.com' },
      { navigator: { share, clipboard: { writeText } }, document: null },
    )

    expect(result).toBe('shared')
    expect(share).toHaveBeenCalledWith({
      title: '旅遊結算',
      text: '摘要內容',
      url: 'https://example.com',
    })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('shareOrCopyText 在使用者取消（AbortError）時回傳 cancelled 且不降級複製', async () => {
    const abortErr = new Error('User cancelled')
    abortErr.name = 'AbortError'
    const share = vi.fn().mockRejectedValue(abortErr)
    const writeText = vi.fn().mockResolvedValue(undefined)

    const result = await shareOrCopyText(
      { title: '分享', text: '內容' },
      { navigator: { share, clipboard: { writeText } }, document: null },
    )

    expect(result).toBe('cancelled')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('shareOrCopyText 在原生分享失敗時降級複製並支援 fallbackCopyText', async () => {
    const share = vi.fn().mockRejectedValue(new Error('Share unavailable'))
    const writeText = vi.fn().mockResolvedValue(undefined)

    const result = await shareOrCopyText(
      {
        title: '邀請連結',
        text: '快來加入：https://example.com/#join',
        url: 'https://example.com/#join',
        fallbackCopyText: 'https://example.com/#join',
      },
      { navigator: { share, clipboard: { writeText } }, document: null },
    )

    expect(result).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('https://example.com/#join')
  })

  it('shareOrCopyText 在分享與降級複製都失敗時回傳 failed', async () => {
    const result = await shareOrCopyText(
      { text: '無法複製' },
      { navigator: null, document: null },
    )
    expect(result).toBe('failed')
  })

  it('shareFiles 應正確處理支援、canShare 為 false、取消與失敗情境', async () => {
    const fakeFile = {} as File

    expect(
      await shareFiles({ title: '報表', files: [fakeFile] }, { navigator: null }),
    ).toBe('unsupported')

    const canShareFalse = vi.fn(() => false)
    const shareMock = vi.fn().mockResolvedValue(undefined)
    expect(
      await shareFiles(
        { title: '報表', files: [fakeFile] },
        { navigator: { share: shareMock, canShare: canShareFalse } },
      ),
    ).toBe('unsupported')
    expect(shareMock).not.toHaveBeenCalled()

    const canShareTrue = vi.fn(() => true)
    expect(
      await shareFiles(
        { title: '報表', files: [fakeFile] },
        { navigator: { share: shareMock, canShare: canShareTrue } },
      ),
    ).toBe('shared')

    const abortErr = { name: 'AbortError' }
    expect(
      await shareFiles(
        { title: '報表', files: [fakeFile] },
        { navigator: { share: vi.fn().mockRejectedValue(abortErr) } },
      ),
    ).toBe('cancelled')

    expect(
      await shareFiles(
        { title: '報表', files: [fakeFile] },
        { navigator: { share: vi.fn().mockRejectedValue(new Error('fail')) } },
      ),
    ).toBe('failed')
  })

  it('useClipboardShare composable 應正確綁定注入的環境', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const { copyText } = useClipboardShare({
      navigator: { clipboard: { writeText } },
      document: null,
    })
    expect(await copyText('abc')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('abc')
  })
})
