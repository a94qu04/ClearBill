import type { LedgerBackup } from '@/schemas/ledgerSchema'

const GOOGLE_DRIVE_CLIENT_ID_KEY = 'clearbill_google_client_id'
const GOOGLE_DRIVE_LAST_SYNC_KEY = 'clearbill_google_last_sync_at'
const GOOGLE_DRIVE_BACKUP_FILENAME = 'clearbill-backup-v1.json'
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'

interface GoogleTokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void
}

interface GoogleAccountsOAuth2 {
  initTokenClient: (config: {
    client_id: string
    scope: string
    callback: (response: GoogleTokenResponse) => void
    error_callback?: (error: { type?: string; message?: string }) => void
  }) => GoogleTokenClient
  revoke?: (token: string, done?: () => void) => void
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: GoogleAccountsOAuth2
      }
    }
  }
}

export class GoogleDriveSyncError extends Error {
  public readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'GoogleDriveSyncError'
    this.code = code
  }
}

let cachedAccessToken: string | null = null
let cachedTokenExpiresAt = 0
let gisScriptLoadPromise: Promise<void> | null = null

export function getSavedGoogleClientId(): string {
  const envClientId =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_GOOGLE_CLIENT_ID === 'string'
      ? import.meta.env.VITE_GOOGLE_CLIENT_ID.trim()
      : ''

  if (typeof window === 'undefined') return envClientId
  try {
    return window.localStorage.getItem(GOOGLE_DRIVE_CLIENT_ID_KEY)?.trim() || envClientId
  } catch {
    return envClientId
  }
}

export function saveGoogleClientId(clientId: string): void {
  if (typeof window === 'undefined') return
  try {
    const trimmed = clientId.trim()
    if (trimmed) {
      window.localStorage.setItem(GOOGLE_DRIVE_CLIENT_ID_KEY, trimmed)
    } else {
      window.localStorage.removeItem(GOOGLE_DRIVE_CLIENT_ID_KEY)
    }
  } catch {
    // 忽略儲存受限環境
  }
}

export function getLastGoogleSyncAt(): number | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(GOOGLE_DRIVE_LAST_SYNC_KEY)
    if (!raw) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

function saveLastGoogleSyncAt(timestamp: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(GOOGLE_DRIVE_LAST_SYNC_KEY, String(timestamp))
  } catch {
    // 忽略儲存受限環境
  }
}

export function isGoogleDriveConnected(): boolean {
  return Boolean(cachedAccessToken && Date.now() < cachedTokenExpiresAt)
}

export function disconnectGoogleDrive(): void {
  if (cachedAccessToken && typeof window !== 'undefined') {
    try {
      window.google?.accounts?.oauth2?.revoke?.(cachedAccessToken)
    } catch {
      // 忽略撤銷例外
    }
  }
  cachedAccessToken = null
  cachedTokenExpiresAt = 0
}

function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(
      new GoogleDriveSyncError('ERR_NO_BROWSER', 'Google Drive 同步僅支援瀏覽器環境'),
    )
  }
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve()
  }
  if (gisScriptLoadPromise) {
    return gisScriptLoadPromise
  }

  gisScriptLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SCRIPT_URL}"]`,
    )
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener(
        'error',
        () => reject(new GoogleDriveSyncError('ERR_GIS_LOAD', '無法載入 Google 授權腳本')),
        { once: true },
      )
      return
    }

    const script = document.createElement('script')
    script.src = GIS_SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => {
      gisScriptLoadPromise = null
      reject(new GoogleDriveSyncError('ERR_GIS_LOAD', '無法載入 Google 授權腳本，請檢查網路'))
    }
    document.head.appendChild(script)
  })

  return gisScriptLoadPromise
}

/**
 * 透過 Google Identity Services 取得 Google Drive `drive.file` 最小權限存取權杖
 */
export async function requestGoogleDriveToken(
  clientId?: string,
  interactivePrompt: 'consent' | '' = 'consent',
): Promise<string> {
  const effectiveClientId = (clientId ?? getSavedGoogleClientId()).trim()
  if (!effectiveClientId) {
    throw new GoogleDriveSyncError(
      'ERR_MISSING_CLIENT_ID',
      '尚未設定 Google OAuth Client ID',
    )
  }

  if (isGoogleDriveConnected() && cachedAccessToken) {
    return cachedAccessToken
  }

  await loadGoogleIdentityScript()
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) {
    throw new GoogleDriveSyncError(
      'ERR_GIS_UNAVAILABLE',
      'Google OAuth2 模組尚未就緒',
    )
  }

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: effectiveClientId,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new GoogleDriveSyncError(
              'ERR_OAUTH_DENIED',
              response.error_description || response.error || '使用者取消授權',
            ),
          )
          return
        }
        cachedAccessToken = response.access_token
        const ttlSec = response.expires_in ?? 3500
        cachedTokenExpiresAt = Date.now() + Math.max(60, ttlSec - 60) * 1000
        resolve(response.access_token)
      },
      error_callback: (err) => {
        reject(
          new GoogleDriveSyncError(
            'ERR_OAUTH_POPUP',
            err.message || err.type || '無法開啟 Google 登入視窗',
          ),
        )
      },
    })

    client.requestAccessToken({ prompt: interactivePrompt })
  })
}

async function findExistingBackupFileId(accessToken: string): Promise<string | null> {
  const query = encodeURIComponent(
    `name='${GOOGLE_DRIVE_BACKUP_FILENAME}' and trashed=false`,
  )
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=1`

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!res.ok) {
    if (res.status === 401) {
      cachedAccessToken = null
      cachedTokenExpiresAt = 0
    }
    throw new GoogleDriveSyncError(
      'ERR_DRIVE_LIST_FAILED',
      `查詢 Google Drive 備份失敗（HTTP ${res.status}）`,
    )
  }

  const data = (await res.json()) as {
    files?: Array<{ id: string; name: string; modifiedTime?: string }>
  }
  return data.files?.[0]?.id ?? null
}

/**
 * 將本地完整備份 JSON 上傳（新增或覆蓋更新）至 Google Drive
 */
export async function uploadBackupToGoogleDrive(
  backup: LedgerBackup,
  clientId?: string,
): Promise<{ fileId: string; syncedAt: number }> {
  const token = await requestGoogleDriveToken(clientId)
  const existingFileId = await findExistingBackupFileId(token)

  const boundary = 'clearbill_drive_sync_boundary'
  const metadata = {
    name: GOOGLE_DRIVE_BACKUP_FILENAME,
    mimeType: 'application/json',
  }
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(backup, null, 2)}\r\n` +
    `--${boundary}--`

  const endpoint = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'

  const res = await fetch(endpoint, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })

  if (!res.ok) {
    throw new GoogleDriveSyncError(
      'ERR_DRIVE_UPLOAD_FAILED',
      `上傳至 Google Drive 失敗（HTTP ${res.status}）`,
    )
  }

  const uploaded = (await res.json()) as { id: string }
  const syncedAt = Date.now()
  saveLastGoogleSyncAt(syncedAt)
  return { fileId: uploaded.id, syncedAt }
}

/**
 * 從 Google Drive 下載 ClearBill 備份 JSON 原始內容（交由 backupMergeEngine 做 Zod 驗證與合併）
 */
export async function downloadBackupFromGoogleDrive(
  clientId?: string,
): Promise<{ rawJson: unknown; syncedAt: number }> {
  const token = await requestGoogleDriveToken(clientId)
  const existingFileId = await findExistingBackupFileId(token)

  if (!existingFileId) {
    throw new GoogleDriveSyncError(
      'ERR_DRIVE_NOT_FOUND',
      'Google Drive 尚未建立 ClearBill 備份檔',
    )
  }

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${existingFileId}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  )

  if (!res.ok) {
    throw new GoogleDriveSyncError(
      'ERR_DRIVE_DOWNLOAD_FAILED',
      `下載 Google Drive 備份失敗（HTTP ${res.status}）`,
    )
  }

  const rawJson = (await res.json()) as unknown
  const syncedAt = Date.now()
  saveLastGoogleSyncAt(syncedAt)
  return { rawJson, syncedAt }
}
