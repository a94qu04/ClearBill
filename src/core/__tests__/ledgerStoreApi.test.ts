import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  AVATAR_PALETTE,
  DEFAULT_MANAGED_CATEGORIES,
  INITIAL_CURRENCIES,
  PROJECT_CARD_PALETTE,
  useLedgerStore,
} from '@/stores/ledgerStore'
import { useUserPrefsStore } from '@/stores/userPrefsStore'
import { useSettlementViewStore } from '@/stores/settlementViewStore'
import { useGoogleDriveStore } from '@/stores/googleDriveStore'
import { useRealtimeSyncStore } from '@/stores/realtimeSyncStore'

const EXPECTED_LEDGER_STORE_API_KEYS = [
  'projects',
  'transactions',
  'activeProjectId',
  'isLoaded',
  'isStoragePersisted',
  'syncStatusByProject',
  'lastSyncedAtByProject',
  'outboxCountByProject',
  'pendingDeletionGuard',
  'pendingDeletionGuardCount',
  'googleDriveStatus',
  'googleDriveAccount',
  'googleDriveAutoSync',
  'googleDriveLastSyncAt',
  'googleDriveDirty',
  'googleDriveLastErrorCode',
  'googleDriveLastErrorDetail',
  'defaultCurrency',
  'enabledCurrencies',
  'categories',
  'userProfile',
  'availableCurrencies',
  'allNonDeletedProjects',
  'activeProjects',
  'archivedProjects',
  'deletedProjects',
  'activeProject',
  'visibleTransactions',
  'deletedTransactions',
  'dailyTransactions',
  'activeProjectTransactions',
  'activeProjectExpenses',
  'activeProjectEntriesWithPool',
  'activeProjectEffectiveExpenses',
  'activeProjectSettlements',
  'activeProjectSettleUp',
  'activeProjectBaseSettleUp',
  'projectTotalExpenseMap',
  'liveRatesCache',
  'liveRatesFetchedAt',
  'liveRatesSource',
  'isRefreshingLiveRates',
  'refreshExchangeRates',
  'getLiveExchangeRate',
  'getEffectiveExchangeRate',
  'getEffectiveExchangeRateWithSource',
  'getProjectSettlementCurrency',
  'getProjectSettlementRateMode',
  'getProjectSettlementOptions',
  'settlementViewByProject',
  'getProjectTotalExpense',
  'getProjectTransactionCount',
  'getRememberedExchangeRate',
  'rememberExchangeRate',
  'clearRememberedExchangeRate',
  'getQuickExchangeRatePresets',
  'saveQuickExchangeRatePreset',
  'rememberLastExpenseProject',
  'getLastExpenseProject',
  'getProjectLastCurrency',
  'rememberProjectLastCurrency',
  'rememberProjectLastSplitConfig',
  'getProjectLastSplitConfig',
  'getProjectSettlementRateOverrides',
  'getProjectCustomRatesForTarget',
  'updateProjectSettlementCurrency',
  'updateProjectSettlementRateConfig',
  'getProjectById',
  'getAnyProjectById',
  'setDefaultCurrency',
  'addCurrency',
  'removeCurrency',
  'addCategory',
  'updateCategory',
  'removeCategory',
  'resetDefaultCategories',
  'updateUserProfile',
  'initFromIndexedDb',
  'quarantinedRecords',
  'setStoragePersisted',
  'createProject',
  'createDemoProject',
  'reorderProjects',
  'moveProjectOrder',
  'updateProject',
  'toggleArchiveProject',
  'addProjectMember',
  'updateProjectMember',
  'removeProjectMember',
  'hasDuplicateMemberName',
  'saveProjectSplitGroup',
  'removeProjectSplitGroup',
  'ensureProjectPoolMember',
  'togglePreferPoolPayer',
  'batchCollectPoolFund',
  'isPoolCollectionTransaction',
  'isMemberUsedInProjectTransactions',
  'softDeleteProject',
  'restoreProject',
  'permanentlyDeleteProject',
  'selectProject',
  'addTransaction',
  'recordSettlementPayment',
  'updateTransaction',
  'softDeleteTransaction',
  'softDeleteTransactionsBatch',
  'restoreTransaction',
  'permanentlyDeleteTransaction',
  'emptyTrash',
  'storageUsageStats',
  'exportLedgerBackup',
  'exportProjectBackup',
  'importAndMergeLedgerBackup',
  'enableProjectRealtimeSync',
  'fetchSharedProjectForJoin',
  'finalizeJoinSharedProject',
  'setMyMemberForProject',
  'rotateProjectInviteLink',
  'stopProjectRealtimeSync',
  'startProjectRealtimeListener',
  'startAllSharedProjectListeners',
  'stopAllSharedProjectListeners',
  'flushProjectOutbox',
  'flushAllSharedProjectsOutbox',
  'approvePendingRemoteDeletes',
  'rejectPendingRemoteDeletes',
  'setGoogleDriveAutoSync',
  'syncGoogleDriveNow',
  'pullGoogleDriveNow',
  'disconnectGoogleDriveAccount',
  'tryBackgroundGoogleDriveSync',
] as const

describe('ledgerStore 模組拆分與對外 API 相容性快照', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('保留所有既有常數與全部 132 個對外 Store API 鍵值', () => {
    expect(INITIAL_CURRENCIES.length).toBeGreaterThan(0)
    expect(AVATAR_PALETTE.length).toBeGreaterThan(0)
    expect(PROJECT_CARD_PALETTE.length).toBeGreaterThan(0)
    expect(DEFAULT_MANAGED_CATEGORIES.length).toBe(7)

    const store = useLedgerStore()
    for (const key of EXPECTED_LEDGER_STORE_API_KEYS) {
      expect(key in store, `缺少 API 鍵值：${key}`).toBe(true)
    }
  })

  it('子 Store 狀態變更可透過 ledgerStore 即時響應並維持單一真相來源', () => {
    const ledger = useLedgerStore()
    const prefs = useUserPrefsStore()
    const settle = useSettlementViewStore()
    const drive = useGoogleDriveStore()
    const realtime = useRealtimeSyncStore()

    // 1. 偏好設定與 Drive dirty 連動
    expect(ledger.defaultCurrency).toBe(prefs.defaultCurrency)
    ledger.setDefaultCurrency('JPY')
    expect(prefs.defaultCurrency).toBe('JPY')
    expect(ledger.defaultCurrency).toBe('JPY')

    ledger.addCategory('測試分類')
    expect(prefs.categories.some((c) => c.customLabel === '測試分類')).toBe(true)
    expect(drive.googleDriveDirty).toBe(true)
    expect(ledger.googleDriveDirty).toBe(true)

    // 2. 結算視角共享同一個 settlementViewByProject
    expect(ledger.settlementViewByProject).toStrictEqual(
      settle.settlementViewByProject,
    )

    // 3. 即時同步狀態與刪除熔斷告警共享
    expect(ledger.pendingDeletionGuardCount).toBe(
      realtime.pendingDeletionGuardCount,
    )
    expect(ledger.pendingDeletionGuard).toBeNull()
  })
})
