/**
 * 剪貼簿複製與原生 Web Share API 降級共用模組
 *
 * 統一處理：
 * 1. Clipboard API → 隱藏 textarea + `document.execCommand('copy')` 兩段式降級複製
 * 2. Web Share API（文字／連結）→ 使用者取消靜默結束 → 失敗時降級至剪貼簿複製
 * 3. Web Share API（檔案分享，例如長圖 PNG）→ 不支援或失敗時交由呼叫端降級下載
 */

export interface ShareTextPayload {
  title?: string
  text: string
  url?: string
  /** 降級複製到剪貼簿時使用的文字；未指定時預設使用 text */
  fallbackCopyText?: string
}

export type ShareOrCopyResult = 'shared' | 'copied' | 'cancelled' | 'failed'

export interface ShareFilesPayload {
  title?: string
  text?: string
  files: File[]
}

export type ShareFilesResult = 'shared' | 'cancelled' | 'unsupported' | 'failed'

export interface ClipboardShareNavigatorLike {
  clipboard?: {
    writeText?: (text: string) => Promise<void>
  }
  share?: (data: ShareData) => Promise<void>
  canShare?: (data?: ShareData) => boolean
}

export interface ClipboardShareTextareaLike {
  value: string
  readOnly?: boolean
  style: {
    position: string
    opacity: string
    pointerEvents?: string
  }
  select: () => void
  setSelectionRange?: (start: number, end: number) => void
}

export interface ClipboardShareDocumentLike {
  body?: {
    appendChild: (node: unknown) => unknown
    removeChild: (node: unknown) => unknown
  } | null
  createElement: (tag: 'textarea') => ClipboardShareTextareaLike
  execCommand?: (commandId: string) => boolean
}

export interface ClipboardShareEnv {
  navigator?: ClipboardShareNavigatorLike | null
  document?: ClipboardShareDocumentLike | null
}

function getDefaultEnv(): ClipboardShareEnv {
  return {
    navigator: typeof navigator !== 'undefined' ? navigator : null,
    document:
      typeof document !== 'undefined'
        ? (document as unknown as ClipboardShareDocumentLike)
        : null,
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * 將純文字複製到剪貼簿；優先使用現代 Clipboard API，失敗或不支援時自動降級至
 * 隱藏 textarea + `document.execCommand('copy')`。
 */
export async function copyTextToClipboard(
  text: string,
  env?: ClipboardShareEnv,
): Promise<boolean> {
  const resolved = env ?? getDefaultEnv()
  const nav = resolved.navigator
  const doc = resolved.document

  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text)
      return true
    } catch {
      // 降級改用 execCommand('copy')
    }
  }

  if (!doc?.body || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') {
    return false
  }

  let textarea: ClipboardShareTextareaLike | null = null
  try {
    textarea = doc.createElement('textarea')
    textarea.value = text
    textarea.readOnly = true
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    doc.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange?.(0, text.length)
    return Boolean(doc.execCommand('copy'))
  } catch {
    return false
  } finally {
    if (textarea) {
      try {
        doc.body.removeChild(textarea)
      } catch {
        // 忽略清理階段錯誤
      }
    }
  }
}

/**
 * 優先呼叫瀏覽器原生 `navigator.share` 分享文字／連結；
 * 若使用者主動取消（AbortError）則回傳 `'cancelled'` 而不複製；
 * 若不支援原生分享或分享失敗，則自動降級複製到剪貼簿。
 */
export async function shareOrCopyText(
  payload: ShareTextPayload,
  env?: ClipboardShareEnv,
): Promise<ShareOrCopyResult> {
  const resolved = env ?? getDefaultEnv()
  const nav = resolved.navigator

  if (typeof nav?.share === 'function') {
    try {
      const shareData: ShareData = {
        text: payload.text,
      }
      if (payload.title !== undefined) {
        shareData.title = payload.title
      }
      if (payload.url !== undefined) {
        shareData.url = payload.url
      }
      await nav.share(shareData)
      return 'shared'
    } catch (err) {
      if (isAbortError(err)) {
        return 'cancelled'
      }
      // 其餘錯誤改走剪貼簿降級
    }
  }

  const copied = await copyTextToClipboard(
    payload.fallbackCopyText ?? payload.text,
    resolved,
  )
  return copied ? 'copied' : 'failed'
}

/**
 * 嘗試透過瀏覽器原生 `navigator.share` 分享檔案（例如長圖 PNG）。
 * 若環境不支援檔案分享回傳 `'unsupported'`，呼叫端可降級為直接下載檔案。
 */
export async function shareFiles(
  payload: ShareFilesPayload,
  env?: ClipboardShareEnv,
): Promise<ShareFilesResult> {
  const resolved = env ?? getDefaultEnv()
  const nav = resolved.navigator

  if (typeof nav?.share !== 'function') {
    return 'unsupported'
  }

  if (
    typeof nav.canShare === 'function' &&
    !nav.canShare({ files: payload.files })
  ) {
    return 'unsupported'
  }

  try {
    const shareData: ShareData = {
      files: payload.files,
    }
    if (payload.title !== undefined) {
      shareData.title = payload.title
    }
    if (payload.text !== undefined) {
      shareData.text = payload.text
    }
    await nav.share(shareData)
    return 'shared'
  } catch (err) {
    if (isAbortError(err)) {
      return 'cancelled'
    }
    return 'failed'
  }
}

export function useClipboardShare(env?: ClipboardShareEnv) {
  return {
    copyText: (text: string) => copyTextToClipboard(text, env),
    shareOrCopyText: (payload: ShareTextPayload) =>
      shareOrCopyText(payload, env),
    shareFiles: (payload: ShareFilesPayload) => shareFiles(payload, env),
  }
}
