import type { LedgerBackup } from '@/schemas/ledgerSchema'
import type { LedgerMergeStats } from '@/core/backupMergeEngine'

const GOOGLE_DRIVE_CLIENT_ID_KEY = 'clearbill_google_client_id'
const GOOGLE_DRIVE_LAST_SYNC_KEY = 'clearbill_google_last_sync_at'
const GOOGLE_DRIVE_ACCOUNT_KEY = 'clearbill_google_account'
const GOOGLE_DRIVE_AUTO_SYNC_KEY = 'clearbill_google_auto_sync'
const GOOGLE_DRIVE_DIRTY_KEY = 'clearbill_google_dirty'
const GOOGLE_DRIVE_REMOTE_MTIME_KEY = 'clearbill_google_remote_mtime'
const GOOGLE_DRIVE_TOKEN_STORAGE_KEY = 'clearbill_google_token_v1'

const GOOGLE_DRIVE_BACKUP_FILENAME = 'clearbill-backup-v1.json'
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'

export type GoogleDriveSyncErrorCode =
  | 'ERR_NO_BROWSER'
  | 'ERR_MISSING_CLIENT_ID'
  | 'ERR_GIS_LOAD'
  | 'ERR_GIS_UNAVAILABLE'
  | 'ERR_OAUTH_DENIED'
  | 'ERR_OAUTH_POPUP'
  | 'ERR_OAUTH_SILENT_REQUIRED'
  | 'ERR_DRIVE_LIST_FAILED'
  | 'ERR_DRIVE_NOT_FOUND'
  | 'ERR_DRIVE_UPLOAD_FAILED'
  | 'ERR_DRIVE_DOWNLOAD_FAILED'

export interface GoogleDriveAccountInfo {
  email: string
  displayName: string
}

interface GoogleTokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: {
    prompt?: string
    hint?: string
  }) => void
}

interface GoogleAccountsOAuth2 {
  initTokenClient: (config: {
    client_id: string
    scope: string
    hint?: string
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
  public readonly code: GoogleDriveSyncErrorCode

  constructor(code: GoogleDriveSyncErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'GoogleDriveSyncError'
    this.code = code
  }
}

export interface GoogleDriveSyncOptions {
  clientId?: string
  /** 若為 true，只使用快取權杖或靜默續連，絕不彈出登入視窗（適合背景自動同步） */
  silentOnly?: boolean
  /** 若為 true，強制重新選擇 Google 帳號 */
  selectAccount?: boolean
  /** 本機是否有尚未上傳的新變更；為 false 且雲端檔案未異動時將快速略過上傳 */
  hasLocalChanges?: boolean
  /** 若遠端已有備份檔，下載後交由呼叫端透過 UUID 與 updatedAt 執行無損合併 */
  onMergeRemote: (rawJson: unknown) => Promise<LedgerMergeStats>
  /** 取得合併完成後的最新本地完整備份物件以回傳至 Google Drive */
  getMergedBackup: () => LedgerBackup
}

export interface GoogleDriveSyncResult {
  fileId: string
  syncedAt: number
  hadRemoteFile: boolean
  mergeStats: LedgerMergeStats | null
  skippedNoChanges: boolean
  uploaded: boolean
  account: GoogleDriveAccountInfo | null
}

let cachedAccessToken: string | null = null
let cachedTokenExpiresAt = 0
let gisScriptLoadPromise: Promise<void> | null = null

function restoreSessionTokenIfValid(): void {
  if (cachedAccessToken && Date.now() < cachedTokenExpiresAt) return
  if (typeof window === 'undefined') return
  try {
    const raw =
      window.localStorage.getItem(GOOGLE_DRIVE_TOKEN_STORAGE_KEY) ||
      window.sessionStorage.getItem(GOOGLE_DRIVE_TOKEN_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { token?: string; expiresAt?: number }
    if (
      typeof parsed.token === 'string' &&
      parsed.token &&
      typeof parsed.expiresAt === 'number' &&
      Date.now() < parsed.expiresAt
    ) {
      cachedAccessToken = parsed.token
      cachedTokenExpiresAt = parsed.expiresAt
    } else {
      window.localStorage.removeItem(GOOGLE_DRIVE_TOKEN_STORAGE_KEY)
      window.sessionStorage.removeItem(GOOGLE_DRIVE_TOKEN_STORAGE_KEY)
    }
  } catch {
    // 忽略儲存受限環境
  }
}

function persistSessionToken(token: string, expiresAt: number): void {
  cachedAccessToken = token
  cachedTokenExpiresAt = expiresAt
  if (typeof window === 'undefined') return
  const serialized = JSON.stringify({ token, expiresAt })
  try {
    window.localStorage.setItem(GOOGLE_DRIVE_TOKEN_STORAGE_KEY, serialized)
  } catch {
    try {
      window.sessionStorage.setItem(GOOGLE_DRIVE_TOKEN_STORAGE_KEY, serialized)
    } catch {
      // 忽略儲存受限環境
    }
  }
}

function clearSessionToken(): void {
  cachedAccessToken = null
  cachedTokenExpiresAt = 0
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(GOOGLE_DRIVE_TOKEN_STORAGE_KEY)
    window.sessionStorage.removeItem(GOOGLE_DRIVE_TOKEN_STORAGE_KEY)
  } catch {
    // 忽略儲存受限環境
  }
}

export function getBuiltInGoogleClientId(): string {
  return typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_GOOGLE_CLIENT_ID === 'string'
    ? import.meta.env.VITE_GOOGLE_CLIENT_ID.trim()
    : ''
}

export function hasBuiltInGoogleClientId(): boolean {
  return Boolean(getBuiltInGoogleClientId())
}

export function getCustomGoogleClientId(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(GOOGLE_DRIVE_CLIENT_ID_KEY)?.trim() || ''
  } catch {
    return ''
  }
}

export function getSavedGoogleClientId(): string {
  return getCustomGoogleClientId() || getBuiltInGoogleClientId()
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

export function getSavedGoogleAccount(): GoogleDriveAccountInfo | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(GOOGLE_DRIVE_ACCOUNT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<GoogleDriveAccountInfo>
    if (typeof parsed.email === 'string' && parsed.email.trim()) {
      return {
        email: parsed.email.trim(),
        displayName:
          typeof parsed.displayName === 'string' && parsed.displayName.trim()
            ? parsed.displayName.trim()
            : parsed.email.trim(),
      }
    }
    return null
  } catch {
    return null
  }
}

function saveGoogleAccount(account: GoogleDriveAccountInfo | null): void {
  if (typeof window === 'undefined') return
  try {
    if (account) {
      window.localStorage.setItem(
        GOOGLE_DRIVE_ACCOUNT_KEY,
        JSON.stringify(account),
      )
    } else {
      window.localStorage.removeItem(GOOGLE_DRIVE_ACCOUNT_KEY)
    }
  } catch {
    // 忽略儲存受限環境
  }
}

export function isGoogleAutoSyncEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(GOOGLE_DRIVE_AUTO_SYNC_KEY) === 'true'
  } catch {
    return false
  }
}

export function setGoogleAutoSyncEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (enabled) {
      window.localStorage.setItem(GOOGLE_DRIVE_AUTO_SYNC_KEY, 'true')
    } else {
      window.localStorage.removeItem(GOOGLE_DRIVE_AUTO_SYNC_KEY)
    }
  } catch {
    // 忽略儲存受限環境
  }
}

export function hasGoogleDriveDirtyChanges(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(GOOGLE_DRIVE_DIRTY_KEY) === 'true'
  } catch {
    return false
  }
}

export function setGoogleDriveDirtyChanges(dirty: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (dirty) {
      window.localStorage.setItem(GOOGLE_DRIVE_DIRTY_KEY, 'true')
    } else {
      window.localStorage.removeItem(GOOGLE_DRIVE_DIRTY_KEY)
    }
  } catch {
    // 忽略儲存受限環境
  }
}

function getSavedRemoteModifiedTime(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(GOOGLE_DRIVE_REMOTE_MTIME_KEY) || ''
  } catch {
    return ''
  }
}

function saveRemoteModifiedTime(mtime: string | undefined): void {
  if (typeof window === 'undefined') return
  try {
    if (mtime) {
      window.localStorage.setItem(GOOGLE_DRIVE_REMOTE_MTIME_KEY, mtime)
    } else {
      window.localStorage.removeItem(GOOGLE_DRIVE_REMOTE_MTIME_KEY)
    }
  } catch {
    // 忽略儲存受限環境
  }
}

export function isGoogleDriveConnected(): boolean {
  restoreSessionTokenIfValid()
  return Boolean(cachedAccessToken && Date.now() < cachedTokenExpiresAt)
}

export function disconnectGoogleDrive(): void {
  restoreSessionTokenIfValid()
  if (cachedAccessToken && typeof window !== 'undefined') {
    try {
      window.google?.accounts?.oauth2?.revoke?.(cachedAccessToken)
    } catch {
      // 忽略撤銷例外
    }
  }
  clearSessionToken()
  saveGoogleAccount(null)
  setGoogleAutoSyncEnabled(false)
  saveRemoteModifiedTime(undefined)
}

function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new GoogleDriveSyncError('ERR_NO_BROWSER'))
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
        () => reject(new GoogleDriveSyncError('ERR_GIS_LOAD')),
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
      reject(new GoogleDriveSyncError('ERR_GIS_LOAD'))
    }
    document.head.appendChild(script)
  })

  return gisScriptLoadPromise
}

/**
 * 透過 Google Identity Services 取得 Google Drive `drive.file` 最小權限存取權杖
 * - 優先使用同分頁有效快取權杖
 * - 支援 silentOnly（靜默續連，不跳彈窗，適合啟動／切回前景自動同步）
 */
export async function requestGoogleDriveToken(
  clientId?: string,
  interactivePrompt: 'consent' | 'select_account' | '' = '',
  options?: { silentOnly?: boolean; loginHint?: string },
): Promise<string> {
  const effectiveClientId = (clientId ?? getSavedGoogleClientId()).trim()
  if (!effectiveClientId) {
    throw new GoogleDriveSyncError('ERR_MISSING_CLIENT_ID')
  }

  const forceSelect = interactivePrompt === 'select_account'
  if (!forceSelect) {
    restoreSessionTokenIfValid()
    if (cachedAccessToken && Date.now() < cachedTokenExpiresAt) {
      return cachedAccessToken
    }
  }

  const silentOnly = Boolean(options?.silentOnly)

  // GIS OAuth Token Model 不支援背景無彈窗 prompt='none'；
  // 靜默模式若無有效快取權杖，直接回報需重新驗證，避免觸發瀏覽器彈窗封鎖或 invalid_request 錯誤
  if (silentOnly) {
    throw new GoogleDriveSyncError('ERR_OAUTH_SILENT_REQUIRED')
  }

  await loadGoogleIdentityScript()
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) {
    throw new GoogleDriveSyncError('ERR_GIS_UNAVAILABLE')
  }

  const hint =
    !forceSelect ? options?.loginHint ?? getSavedGoogleAccount()?.email : undefined

  return new Promise<string>((resolve, reject) => {
    let settled = false

    const finishResolve = (token: string) => {
      if (settled) return
      settled = true
      resolve(token)
    }

    const finishReject = (err: GoogleDriveSyncError) => {
      if (settled) return
      settled = true
      reject(err)
    }

    const client = oauth2.initTokenClient({
      client_id: effectiveClientId,
      scope: GOOGLE_DRIVE_SCOPE,
      ...(hint ? { hint } : {}),
      callback: (response) => {
        if (response.error || !response.access_token) {
          finishReject(
            new GoogleDriveSyncError(
              'ERR_OAUTH_DENIED',
              response.error_description || response.error,
            ),
          )
          return
        }
        const ttlSec = response.expires_in ?? 3500
        const expiresAt = Date.now() + Math.max(60, ttlSec - 60) * 1000
        persistSessionToken(response.access_token, expiresAt)
        finishResolve(response.access_token)
      },
      error_callback: (err) => {
        finishReject(
          new GoogleDriveSyncError('ERR_OAUTH_POPUP', err.message || err.type),
        )
      },
    })

    client.requestAccessToken({
      prompt: interactivePrompt,
      ...(hint ? { hint } : {}),
    })
  })
}

/**
 * 透過既有的 `drive.file` 權限查詢目前登入的 Google 帳號名稱與 Email（不需額外權限）
 */
async function fetchDriveAccountInfo(
  accessToken: string,
): Promise<GoogleDriveAccountInfo | null> {
  try {
    const res = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    )
    if (!res.ok) return getSavedGoogleAccount()
    const data = (await res.json()) as {
      user?: { displayName?: string; emailAddress?: string }
    }
    const email = data.user?.emailAddress?.trim()
    if (!email) return getSavedGoogleAccount()
    const info: GoogleDriveAccountInfo = {
      email,
      displayName: data.user?.displayName?.trim() || email,
    }
    saveGoogleAccount(info)
    return info
  } catch {
    return getSavedGoogleAccount()
  }
}

interface DriveBackupFileMeta {
  id: string
  name: string
  modifiedTime?: string
}

async function findExistingBackupFile(
  accessToken: string,
): Promise<DriveBackupFileMeta | null> {
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
      clearSessionToken()
      throw new GoogleDriveSyncError('ERR_OAUTH_SILENT_REQUIRED', 'HTTP 401')
    }
    throw new GoogleDriveSyncError('ERR_DRIVE_LIST_FAILED', `HTTP ${res.status}`)
  }

  const data = (await res.json()) as {
    files?: DriveBackupFileMeta[]
  }
  return data.files?.[0] ?? null
}

async function fetchDriveBackupJson(
  accessToken: string,
  fileId: string,
): Promise<unknown> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  if (!res.ok) {
    if (res.status === 401) {
      clearSessionToken()
      throw new GoogleDriveSyncError('ERR_OAUTH_SILENT_REQUIRED', 'HTTP 401')
    }
    throw new GoogleDriveSyncError(
      'ERR_DRIVE_DOWNLOAD_FAILED',
      `HTTP ${res.status}`,
    )
  }

  return (await res.json()) as unknown
}

async function uploadBackupPayload(
  accessToken: string,
  backup: LedgerBackup,
  existingFileId: string | null,
): Promise<{ fileId: string; syncedAt: number; modifiedTime?: string }> {
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
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,modifiedTime`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime'

  const res = await fetch(endpoint, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })

  if (!res.ok) {
    if (res.status === 401) {
      clearSessionToken()
      throw new GoogleDriveSyncError('ERR_OAUTH_SILENT_REQUIRED', 'HTTP 401')
    }
    throw new GoogleDriveSyncError(
      'ERR_DRIVE_UPLOAD_FAILED',
      `HTTP ${res.status}`,
    )
  }

  const uploaded = (await res.json()) as { id: string; modifiedTime?: string }
  const syncedAt = Date.now()
  saveLastGoogleSyncAt(syncedAt)
  if (uploaded.modifiedTime) {
    saveRemoteModifiedTime(uploaded.modifiedTime)
  }
  setGoogleDriveDirtyChanges(false)
  return {
    fileId: uploaded.id,
    syncedAt,
    modifiedTime: uploaded.modifiedTime,
  }
}

/**
 * 智慧跨裝置安全無損雙向同步（Pull ➔ Merge ➔ Push）：
 * 1. 取得存取權杖（可選靜默續連）並確認 Google 帳號資訊
 * 2. 比對遠端 modifiedTime；若無遠端異動且無本機新變更則秒速略過
 * 3. 若遠端有檔案且有異動（或首次同步），先拉回透過 UUID + updatedAt 與本地無損合併
 * 4. 依需要將最新合併結果上傳至 Google Drive，並更新同步時間戳
 */
export async function syncWithGoogleDrive(
  options: GoogleDriveSyncOptions,
): Promise<GoogleDriveSyncResult> {
  const runOnce = async (forceRefreshToken = false): Promise<GoogleDriveSyncResult> => {
    if (forceRefreshToken) {
      clearSessionToken()
    }
    const token = await requestGoogleDriveToken(
      options.clientId,
      options.selectAccount ? 'select_account' : '',
      { silentOnly: options.silentOnly },
    )
    const account = await fetchDriveAccountInfo(token)
    const existingFile = await findExistingBackupFile(token)

    const hadRemoteFile = Boolean(existingFile)
    const lastKnownMtime = getSavedRemoteModifiedTime()
    const remoteChanged =
      !existingFile ||
      !lastKnownMtime ||
      existingFile.modifiedTime !== lastKnownMtime

    const hasLocalChanges = options.hasLocalChanges ?? true

    // 遠端沒有變動且本地也沒有新變更：直接更新同步檢查時間，省去重複下載與上傳
    if (existingFile && !remoteChanged && !hasLocalChanges) {
      const syncedAt = Date.now()
      saveLastGoogleSyncAt(syncedAt)
      return {
        fileId: existingFile.id,
        syncedAt,
        hadRemoteFile: true,
        mergeStats: null,
        skippedNoChanges: true,
        uploaded: false,
        account,
      }
    }

    let mergeStats: LedgerMergeStats | null = null
    if (existingFile && remoteChanged) {
      const remoteJson = await fetchDriveBackupJson(token, existingFile.id)
      mergeStats = await options.onMergeRemote(remoteJson)
      if (existingFile.modifiedTime) {
        saveRemoteModifiedTime(existingFile.modifiedTime)
      }
    }

    // 若雲端已經有檔且本機原本無未上傳變更，且合併僅單純吸收遠端資料，可免除不必要上傳
    const latestBackup = options.getMergedBackup()
    const shouldUpload =
      !existingFile ||
      hasLocalChanges ||
      (mergeStats !== null &&
        (mergeStats.projectsSkipped > 0 || mergeStats.transactionsSkipped > 0))

    if (!shouldUpload && existingFile) {
      const syncedAt = Date.now()
      saveLastGoogleSyncAt(syncedAt)
      setGoogleDriveDirtyChanges(false)
      return {
        fileId: existingFile.id,
        syncedAt,
        hadRemoteFile: true,
        mergeStats,
        skippedNoChanges: false,
        uploaded: false,
        account,
      }
    }

    const { fileId, syncedAt } = await uploadBackupPayload(
      token,
      latestBackup,
      existingFile?.id ?? null,
    )

    return {
      fileId,
      syncedAt,
      hadRemoteFile,
      mergeStats,
      skippedNoChanges: false,
      uploaded: true,
      account,
    }
  }

  try {
    return await runOnce(false)
  } catch (err) {
    // 手動操作若遇快取 Token 提前 401 失效，自動清快取重新驗證一次並重試
    if (
      !options.silentOnly &&
      err instanceof GoogleDriveSyncError &&
      err.code === 'ERR_OAUTH_SILENT_REQUIRED'
    ) {
      return await runOnce(true)
    }
    throw err
  }
}

/**
 * 僅將本地完整備份 JSON 上傳（保留供單獨上傳使用）
 */
export async function uploadBackupToGoogleDrive(
  backup: LedgerBackup,
  clientId?: string,
): Promise<{ fileId: string; syncedAt: number }> {
  const token = await requestGoogleDriveToken(clientId)
  const existingFile = await findExistingBackupFile(token)
  return uploadBackupPayload(token, backup, existingFile?.id ?? null)
}

/**
 * 從 Google Drive 下載 ClearBill 備份 JSON 原始內容
 * - allowMissing 為 true 時，若雲端尚無備份檔則回傳 null 而不拋錯
 */
export async function downloadBackupFromGoogleDrive(
  clientId?: string,
  allowMissing = false,
): Promise<{
  rawJson: unknown
  syncedAt: number
  account: GoogleDriveAccountInfo | null
} | null> {
  const token = await requestGoogleDriveToken(clientId)
  const account = await fetchDriveAccountInfo(token)
  const existingFile = await findExistingBackupFile(token)

  if (!existingFile) {
    if (allowMissing) return null
    throw new GoogleDriveSyncError('ERR_DRIVE_NOT_FOUND')
  }

  const rawJson = await fetchDriveBackupJson(token, existingFile.id)
  const syncedAt = Date.now()
  saveLastGoogleSyncAt(syncedAt)
  if (existingFile.modifiedTime) {
    saveRemoteModifiedTime(existingFile.modifiedTime)
  }
  return { rawJson, syncedAt, account }
}
