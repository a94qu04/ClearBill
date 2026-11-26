import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LedgerBackup } from '@/schemas/ledgerSchema'
import type { LedgerMergeStats } from '@/core/backupMergeEngine'
import { createDriveDirtyTracker } from '@/core/driveDirtyTracker'
import {
  disconnectGoogleDrive,
  downloadBackupFromGoogleDrive,
  getBuiltInGoogleClientId,
  getCustomGoogleClientId,
  getLastGoogleSyncAt,
  getSavedGoogleAccount,
  getSavedGoogleClientId,
  GoogleDriveSyncError,
  hasBuiltInGoogleClientId,
  hasGoogleDriveDirtyChanges,
  isGoogleAutoSyncEnabled,
  isGoogleDriveConnected,
  saveGoogleClientId,
  setGoogleAutoSyncEnabled,
  setGoogleDriveDirtyChanges,
  syncWithGoogleDrive,
  type GoogleDriveAccountInfo,
  type GoogleDriveSyncErrorCode,
  type GoogleDriveSyncResult,
} from '@/services/googleDriveSync'

export type GoogleDriveSyncStatus =
  | 'disconnected'
  | 'syncing'
  | 'synced'
  | 'pending'
  | 'needs_auth'
  | 'offline'
  | 'error'

export interface GoogleDriveBackupBridge {
  exportLedgerBackup: (options?: { omitReceiptImages?: boolean }) => LedgerBackup
  importAndMergeLedgerBackup: (raw: string | unknown) => Promise<LedgerMergeStats>
}

export const useGoogleDriveStore = defineStore('googleDrive', () => {
  const googleDriveAccount = ref<GoogleDriveAccountInfo | null>(
    getSavedGoogleAccount(),
  )
  const googleDriveAutoSync = ref<boolean>(isGoogleAutoSyncEnabled())
  const googleDriveLastSyncAt = ref<number | null>(getLastGoogleSyncAt())
  const driveDirtyTracker = createDriveDirtyTracker(hasGoogleDriveDirtyChanges())
  const googleDriveDirty = ref<boolean>(driveDirtyTracker.isDirty())
  const googleDriveLastErrorCode = ref<GoogleDriveSyncErrorCode | null>(null)
  const googleDriveLastErrorDetail = ref<string | null>(null)
  const googleDriveStatus = ref<GoogleDriveSyncStatus>(
    resolveInitialGoogleDriveStatus(),
  )
  let googleAutoSyncTimer: ReturnType<typeof setTimeout> | null = null
  let googleSyncInFlight: Promise<GoogleDriveSyncResult | null> | null = null
  let googlePullInFlight: Promise<{ stats: LedgerMergeStats; syncedAt: number }> | null =
    null
  let backupBridge: GoogleDriveBackupBridge | null = null

  function resolveInitialGoogleDriveStatus(): GoogleDriveSyncStatus {
    if (isGoogleDriveConnected()) {
      return hasGoogleDriveDirtyChanges() ? 'pending' : 'synced'
    }
    if (isGoogleAutoSyncEnabled() || getSavedGoogleAccount()) {
      return typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'offline'
        : 'needs_auth'
    }
    return 'disconnected'
  }

  function bindBackupBridge(bridge: GoogleDriveBackupBridge): void {
    backupBridge = bridge
  }

  function requireBackupBridge(): GoogleDriveBackupBridge {
    if (!backupBridge) {
      throw new Error('ERR_DRIVE_BRIDGE_NOT_BOUND')
    }
    return backupBridge
  }

  function scheduleGoogleDriveAutoSync(delayMs = 2500): void {
    if (typeof window === 'undefined') return
    if (googleAutoSyncTimer) {
      clearTimeout(googleAutoSyncTimer)
      googleAutoSyncTimer = null
    }
    if (!googleDriveAutoSync.value || !getSavedGoogleClientId()) return
    googleAutoSyncTimer = setTimeout(() => {
      googleAutoSyncTimer = null
      void syncGoogleDriveNow({ silentOnly: true })
    }, delayMs)
  }

  function markGoogleDriveDirty(): void {
    driveDirtyTracker.markDirty()
    googleDriveDirty.value = true
    setGoogleDriveDirtyChanges(true)
    if (!googleDriveAutoSync.value) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      googleDriveStatus.value = 'offline'
      return
    }
    if (googleDriveStatus.value !== 'syncing') {
      googleDriveStatus.value = 'pending'
    }
    scheduleGoogleDriveAutoSync(2500)
  }

  function setGoogleDriveAutoSync(enabled: boolean): void {
    googleDriveAutoSync.value = enabled
    setGoogleAutoSyncEnabled(enabled)
    if (enabled) {
      if (isGoogleDriveConnected()) {
        googleDriveStatus.value = googleDriveDirty.value ? 'pending' : 'synced'
        if (googleDriveDirty.value) {
          scheduleGoogleDriveAutoSync(600)
        }
      } else if (googleDriveAccount.value) {
        googleDriveStatus.value = 'needs_auth'
      }
    } else if (googleAutoSyncTimer) {
      clearTimeout(googleAutoSyncTimer)
      googleAutoSyncTimer = null
    }
  }

  async function syncGoogleDriveNow(options?: {
    clientId?: string
    silentOnly?: boolean
    selectAccount?: boolean
    enableAutoSyncOnSuccess?: boolean
  }): Promise<GoogleDriveSyncResult | null> {
    if (googleSyncInFlight) {
      return googleSyncInFlight
    }

    const silentOnly = Boolean(options?.silentOnly)
    const effectiveClientId = (
      options?.clientId ?? getSavedGoogleClientId()
    ).trim()

    if (!effectiveClientId) {
      if (silentOnly) return null
      throw new GoogleDriveSyncError('ERR_MISSING_CLIENT_ID')
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      googleDriveStatus.value = 'offline'
      if (silentOnly) return null
      throw new GoogleDriveSyncError('ERR_GIS_LOAD', 'Offline')
    }

    const bridge = requireBackupBridge()

    const run = async (): Promise<GoogleDriveSyncResult | null> => {
      if (googlePullInFlight) {
        try {
          await googlePullInFlight
        } catch {
          // 忽略既有拉取失敗，繼續本次同步
        }
      }
      googleDriveStatus.value = 'syncing'
      googleDriveLastErrorCode.value = null
      googleDriveLastErrorDetail.value = null
      const syncSession = driveDirtyTracker.beginSync()
      const hadLocalChangesAtStart =
        syncSession.wasDirtyAtStart || !googleDriveLastSyncAt.value
      try {
        const res = await syncWithGoogleDrive({
          clientId: effectiveClientId,
          silentOnly,
          selectAccount: options?.selectAccount,
          hasLocalChanges: hadLocalChangesAtStart,
          onMergeRemote: (rawJson) => bridge.importAndMergeLedgerBackup(rawJson),
          getMergedBackup: () => {
            syncSession.recordUploadSnapshot()
            return bridge.exportLedgerBackup()
          },
        })

        googleDriveLastSyncAt.value = res.syncedAt
        if (res.account) {
          googleDriveAccount.value = res.account
        }

        const completion = syncSession.complete({ uploaded: res.uploaded })
        googleDriveDirty.value = completion.stillDirty
        setGoogleDriveDirtyChanges(completion.stillDirty)
        googleDriveLastErrorCode.value = null
        googleDriveLastErrorDetail.value = null

        // 首次透過互動式按鈕連結成功時，預設開啟跨裝置自動同步
        if (!silentOnly && options?.enableAutoSyncOnSuccess !== false) {
          if (!googleDriveAutoSync.value) {
            googleDriveAutoSync.value = true
            setGoogleAutoSyncEnabled(true)
          }
        }

        if (completion.stillDirty) {
          const offline =
            typeof navigator !== 'undefined' && navigator.onLine === false
          googleDriveStatus.value = offline ? 'offline' : 'pending'
          if (!offline && googleDriveAutoSync.value) {
            scheduleGoogleDriveAutoSync(600)
          }
        } else {
          googleDriveStatus.value = 'synced'
        }
        return res
      } catch (err) {
        if (err instanceof GoogleDriveSyncError) {
          if (err.code === 'ERR_OAUTH_SILENT_REQUIRED') {
            googleDriveStatus.value = 'needs_auth'
            googleDriveLastErrorCode.value = null
            googleDriveLastErrorDetail.value = null
            if (silentOnly) return null
            throw err
          }
          googleDriveLastErrorCode.value = err.code
          googleDriveLastErrorDetail.value = err.message
          googleDriveStatus.value = 'error'
          if (silentOnly) return null
          throw err
        }
        googleDriveLastErrorCode.value = null
        googleDriveLastErrorDetail.value =
          err instanceof Error ? err.message : String(err)
        googleDriveStatus.value = 'error'
        if (silentOnly) return null
        throw err
      } finally {
        googleSyncInFlight = null
      }
    }

    googleSyncInFlight = run()
    return googleSyncInFlight
  }

  async function pullGoogleDriveNow(clientId?: string): Promise<{
    stats: LedgerMergeStats
    syncedAt: number
  }> {
    if (googlePullInFlight) {
      return googlePullInFlight
    }
    const bridge = requireBackupBridge()
    const runPull = async (): Promise<{
      stats: LedgerMergeStats
      syncedAt: number
    }> => {
      if (googleSyncInFlight) {
        try {
          await googleSyncInFlight
        } catch {
          // 忽略既有背景同步失敗，繼續本次拉取
        }
      }
      googleDriveStatus.value = 'syncing'
      googleDriveLastErrorCode.value = null
      googleDriveLastErrorDetail.value = null
      try {
        const downloaded = await downloadBackupFromGoogleDrive(clientId, false)
        if (!downloaded) {
          throw new GoogleDriveSyncError('ERR_DRIVE_NOT_FOUND')
        }
        const stats = await bridge.importAndMergeLedgerBackup(downloaded.rawJson)
        googleDriveLastSyncAt.value = downloaded.syncedAt
        if (downloaded.account) {
          googleDriveAccount.value = downloaded.account
        }
        googleDriveStatus.value = googleDriveDirty.value ? 'pending' : 'synced'
        return { stats, syncedAt: downloaded.syncedAt }
      } catch (err) {
        if (err instanceof GoogleDriveSyncError) {
          googleDriveLastErrorCode.value = err.code
          googleDriveLastErrorDetail.value = err.message
          if (err.code === 'ERR_OAUTH_SILENT_REQUIRED') {
            googleDriveStatus.value = 'needs_auth'
            throw err
          }
        } else {
          googleDriveLastErrorDetail.value =
            err instanceof Error ? err.message : String(err)
        }
        googleDriveStatus.value = 'error'
        throw err
      } finally {
        googlePullInFlight = null
      }
    }
    googlePullInFlight = runPull()
    return googlePullInFlight
  }

  function disconnectGoogleDriveAccount(): void {
    if (googleAutoSyncTimer) {
      clearTimeout(googleAutoSyncTimer)
      googleAutoSyncTimer = null
    }
    disconnectGoogleDrive()
    googleDriveAccount.value = null
    googleDriveAutoSync.value = false
    googleDriveLastErrorCode.value = null
    googleDriveLastErrorDetail.value = null
    googleDriveStatus.value = 'disconnected'
  }

  async function tryBackgroundGoogleDriveSync(force = false): Promise<void> {
    if (!googleDriveAutoSync.value) return
    if (!getSavedGoogleClientId()) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      googleDriveStatus.value = 'offline'
      return
    }
    const elapsed = googleDriveLastSyncAt.value
      ? Date.now() - googleDriveLastSyncAt.value
      : Infinity
    if (!force && !googleDriveDirty.value && elapsed < 15_000) {
      return
    }
    await syncGoogleDriveNow({ silentOnly: true })
  }

  function getGoogleDriveErrorCode(
    err: unknown,
  ): GoogleDriveSyncErrorCode | null {
    return err instanceof GoogleDriveSyncError ? err.code : null
  }

  return {
    googleDriveAccount,
    googleDriveAutoSync,
    googleDriveLastSyncAt,
    googleDriveDirty,
    googleDriveLastErrorCode,
    googleDriveLastErrorDetail,
    googleDriveStatus,
    bindBackupBridge,
    scheduleGoogleDriveAutoSync,
    markGoogleDriveDirty,
    setGoogleDriveAutoSync,
    syncGoogleDriveNow,
    pullGoogleDriveNow,
    disconnectGoogleDriveAccount,
    tryBackgroundGoogleDriveSync,
    getBuiltInGoogleClientId,
    hasBuiltInGoogleClientId,
    getCustomGoogleClientId,
    saveGoogleClientId,
    getGoogleDriveErrorCode,
  }
})
