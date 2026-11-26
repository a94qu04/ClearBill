import { onBeforeUnmount } from 'vue'
import { parseGoogleConnectHash } from '@/core/googleConnectLink'
import { parseShareInviteHash } from '@/core/realtimeSyncEngine'
import {
  parseQuickIntake,
  type ParsedQuickIntakeResult,
} from '@/core/quickIntakeParser'
import type { Project, ShareInviteParams } from '@/schemas/ledgerSchema'

export interface HashRouteCallbacks {
  getActiveProject: () => Project | null
  getDefaultCurrency: () => string
  onGoogleConnected: (clientId: string) => void
  onGoogleConnectInvalid: () => void
  onJoinInvite: (invite: ShareInviteParams) => void
  onJoinInvalid: () => void
  onQuickIntakeApplied: (parsed: ParsedQuickIntakeResult) => void
  onQuickIntakeNeedProject: (parsed: ParsedQuickIntakeResult) => void
  saveClientId?: (clientId: string) => void
}

export interface DispatchHashRouteParams extends HashRouteCallbacks {
  hash: string
  href: string
  clearHash: () => void
}

export type HashRouteDispatchResult =
  | 'ignored'
  | 'connect_google'
  | 'connect_google_invalid'
  | 'join'
  | 'join_invalid'
  | 'quick_add_applied'
  | 'quick_add_need_project'
  | 'quick_add_empty'

/**
 * 處理外部 Hash 路由（純分發邏輯，方便測試與複用）：
 * 支援 #/connect-google（Google 雲端跨裝置配對）、#/join（多人共享）與 #/quick-add（iOS 捷徑）
 */
export function dispatchHashRoute(
  params: DispatchHashRouteParams,
): HashRouteDispatchResult {
  const { hash, href, clearHash } = params

  if (hash.startsWith('#/connect-google')) {
    const parsedConnect = parseGoogleConnectHash(hash)
    clearHash()
    if (parsedConnect) {
      params.saveClientId?.(parsedConnect.clientId)
      params.onGoogleConnected(parsedConnect.clientId)
      return 'connect_google'
    }
    params.onGoogleConnectInvalid()
    return 'connect_google_invalid'
  }

  if (hash.startsWith('#/join')) {
    const invite = parseShareInviteHash(hash)
    clearHash()
    if (invite) {
      params.onJoinInvite(invite)
      return 'join'
    }
    params.onJoinInvalid()
    return 'join_invalid'
  }

  if (!hash.startsWith('#/quick-add')) {
    return 'ignored'
  }

  const activeProject = params.getActiveProject()
  const parsed = parseQuickIntake(href, {
    activeProject,
    defaultCurrency: params.getDefaultCurrency(),
  })
  clearHash()

  if (parsed.projectId && activeProject) {
    params.onQuickIntakeApplied(parsed)
    return 'quick_add_applied'
  }
  if (parsed.amount !== null || parsed.merchant) {
    params.onQuickIntakeNeedProject(parsed)
    return 'quick_add_need_project'
  }
  return 'quick_add_empty'
}

/**
 * 監聽與處理瀏覽器 Hash 路由的 Composable。
 * 呼叫端可在 IndexedDB 初始化完成後呼叫 `processCurrentHash()` 與 `startListening()`。
 */
export function useHashRoute(callbacks: HashRouteCallbacks) {
  let isListening = false

  function processCurrentHash(): HashRouteDispatchResult {
    if (typeof window === 'undefined') return 'ignored'
    return dispatchHashRoute({
      ...callbacks,
      hash: window.location.hash,
      href: window.location.href,
      clearHash: () => {
        window.history.replaceState(null, '', window.location.pathname)
      },
    })
  }

  function handleHashChange() {
    processCurrentHash()
  }

  function startListening() {
    if (typeof window === 'undefined' || isListening) return
    window.addEventListener('hashchange', handleHashChange)
    isListening = true
  }

  function stopListening() {
    if (typeof window === 'undefined' || !isListening) return
    window.removeEventListener('hashchange', handleHashChange)
    isListening = false
  }

  onBeforeUnmount(() => {
    stopListening()
  })

  return {
    processCurrentHash,
    startListening,
    stopListening,
  }
}
