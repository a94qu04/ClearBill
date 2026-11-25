export type InAppBrowserKind =
  | 'line'
  | 'facebook'
  | 'instagram'
  | 'wechat'
  | 'threads'
  | 'other'

export interface InAppBrowserDetection {
  isInApp: boolean
  kind: InAppBrowserKind | null
  appName: string
}

/**
 * 偵測使用者是否正在 LINE / Facebook / Instagram / WeChat 等 App 內建瀏覽器中開啟
 * （內建瀏覽器往往阻擋 Google OAuth 彈窗、限制檔案下載，且本地儲存與 Safari/Chrome 隔離）
 */
export function detectInAppBrowser(userAgent?: string): InAppBrowserDetection {
  const ua =
    userAgent ??
    (typeof navigator !== 'undefined' ? navigator.userAgent : '') ??
    ''

  if (!ua) {
    return { isInApp: false, kind: null, appName: '' }
  }

  if (/\bLine\//i.test(ua)) {
    return { isInApp: true, kind: 'line', appName: 'LINE' }
  }
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) {
    return { isInApp: true, kind: 'facebook', appName: 'Facebook' }
  }
  if (/Instagram/i.test(ua)) {
    return { isInApp: true, kind: 'instagram', appName: 'Instagram' }
  }
  if (/MicroMessenger/i.test(ua)) {
    return { isInApp: true, kind: 'wechat', appName: 'WeChat' }
  }
  if (/Barcelona/i.test(ua)) {
    return { isInApp: true, kind: 'threads', appName: 'Threads' }
  }
  return { isInApp: false, kind: null, appName: '' }
}
