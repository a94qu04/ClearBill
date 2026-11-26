import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import {
  collectRealtimeOutboxEntriesFromMerge,
  createLedgerBackupPayload,
  createSingleProjectBackupPayload,
  mergeLedgerData,
  parseAndMergeLedgerBackup,
} from '@/core/backupMergeEngine'
import {
  buildGoogleConnectLink,
  parseGoogleConnectHash,
} from '@/core/googleConnectLink'
import { formatCurrencyAmount } from '@/core/currency'
import {
  applyPercentFees,
  computeEffectiveCompoundFeePercent,
} from '@/core/ledgerHelpers'
import { SchemaMigrationError } from '@/core/migrationEngine'
import {
  buildMemberStatementShareText,
  buildProjectSettlementShareText,
} from '@/core/shareFormatter'
import { calculateSettleUp } from '@/core/settleUpEngine'
import type { Project, Transaction } from '@/schemas/ledgerSchema'
import zhTW from '@/locales/zh-TW.json'
import en from '@/locales/en.json'
import ja from '@/locales/ja.json'

const projectA: Project = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  schemaVersion: 1,
  name: '2026 東京自由行',
  baseCurrency: 'JPY',
  members: [
    { id: 'me', name: '我', avatarColor: '#10b981' },
    { id: 'lin', name: '小林', avatarColor: '#ec4899' },
  ],
  defaultSplitMode: 'equal',
  defaultPayerId: 'me',
  isActive: true,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
}

const txLocalOld: Transaction = {
  id: '11111111-1111-4111-8111-111111111111',
  schemaVersion: 1,
  projectId: projectA.id,
  vaultLevel: 'normal',
  type: 'expense',
  amount: 2000,
  currency: 'JPY',
  exchangeRateToBase: 1,
  categoryKey: 'cat_food',
  date: '2026-11-24',
  time: '12:00',
  updatedAt: 1700000002000,
  note: '拉麵（舊版）',
  splitConfig: {
    payerId: 'me',
    mode: 'equal',
    shares: [
      { memberId: 'me', finalAmount: 1000 },
      { memberId: 'lin', finalAmount: 1000 },
    ],
  },
}

const sampleShareLabels = {
  headerPrefix: '【ClearBill 結算】',
  totalSpendLabel: '專案總支出',
  memberSummaryTitle: '各成員總支出與淨收支：',
  spentLabel: '總支出',
  paidLabel: '已墊付',
  pendingTitle: '待還款建議：',
  allSettledText: '所有人已結清',
  historyTitle: '已記錄還款：',
  transferLine: (from: string, to: string, amt: string) => `${from} ➔ ${to}：${amt}`,
  paidHistoryLine: (from: string, to: string, amt: string, date: string) =>
    `${date} ${from} 已付給 ${to} ${amt}`,
  footerTagline: '— 由 ClearBill 清帳產生',
}

describe('backupMergeEngine - JSON 備份匯出與 UUID + updatedAt 合併', () => {
  it('能輸出 schemaVersion: 1 備份並精準比對 UUID 與 updatedAt 進行合併', () => {
    const incomingBackup = createLedgerBackupPayload(
      [
        // 相同 UUID 但時間戳較新 -> 應覆寫更新
        { ...projectA, name: '2026 東京賞楓行', updatedAt: 1700000009000 },
      ],
      [
        // 相同 UUID 但時間戳較舊 -> 應保留本地版本（skip）
        { ...txLocalOld, amount: 1500, updatedAt: 1700000001000 },
        // 新 UUID -> 應新增
        {
          ...txLocalOld,
          id: '22222222-2222-4222-8222-222222222222',
          amount: 4000,
          note: '燒肉',
          updatedAt: 1700000005000,
        },
      ],
    )

    expect(incomingBackup.schemaVersion).toBe(1)

    const merged = parseAndMergeLedgerBackup(
      { projects: [projectA], transactions: [txLocalOld] },
      JSON.stringify(incomingBackup),
    )

    expect(merged.stats).toEqual({
      projectsAdded: 0,
      projectsUpdated: 1,
      projectsSkipped: 0,
      transactionsAdded: 1,
      transactionsUpdated: 0,
      transactionsSkipped: 1,
      categoriesAdded: 0,
    })

    expect(merged.projects[0].name).toBe('2026 東京賞楓行')
    const keptOld = merged.transactions.find((t) => t.id === txLocalOld.id)
    expect(keptOld?.amount).toBe(2000)
    expect(merged.transactions).toHaveLength(2)
  })

  it('能容錯遷移空陣列 links / receiptImages 與空備註之雲端備份檔', () => {
    const legacyCloudPayload = {
      schemaVersion: 1,
      exportedAt: Date.now(),
      projects: [projectA],
      transactions: [
        {
          ...txLocalOld,
          id: '55555555-5555-4555-8555-555555555555',
          note: '',
          links: [],
          receiptImages: [],
          updatedAt: 1700000010000,
        },
      ],
    }

    const merged = parseAndMergeLedgerBackup(
      { projects: [projectA], transactions: [txLocalOld] },
      legacyCloudPayload,
    )

    expect(merged.stats.transactionsAdded).toBe(1)
    const added = merged.transactions.find(
      (t) => t.id === '55555555-5555-4555-8555-555555555555',
    )
    expect(added?.links).toBeUndefined()
    expect(added?.receiptImages).toBeUndefined()
    expect(added?.note).toBeUndefined()
  })

  it('能依 updatedAt 跨裝置同步並合併個人成員名稱與大頭貼', () => {
    const remoteNewerBackup = createLedgerBackupPayload(
      [projectA],
      [txLocalOld],
      1700000020000,
      undefined,
      {
        displayName: '阿明',
        avatarColor: '#3b82f6',
        avatarImage: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        updatedAt: 1700000020000,
      },
    )

    // 情境 A：遠端較新 -> 覆寫更新本地個人名稱與大頭貼
    const mergedNewer = parseAndMergeLedgerBackup(
      {
        projects: [projectA],
        transactions: [txLocalOld],
        userProfile: {
          displayName: '舊名字',
          avatarColor: '#10b981',
          updatedAt: 1700000010000,
        },
      },
      JSON.stringify(remoteNewerBackup),
    )

    expect(mergedNewer.userProfileUpdated).toBe(true)
    expect(mergedNewer.userProfile?.displayName).toBe('阿明')
    expect(mergedNewer.userProfile?.avatarImage).toBe(
      'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    )

    // 情境 B：本地較新 -> 不被遠端舊大頭貼倒退覆蓋
    const mergedOlder = parseAndMergeLedgerBackup(
      {
        projects: [projectA],
        transactions: [txLocalOld],
        userProfile: {
          displayName: '最新暱稱',
          avatarColor: '#ec4899',
          updatedAt: 1700000099999,
        },
      },
      JSON.stringify(remoteNewerBackup),
    )

    expect(mergedOlder.userProfileUpdated).toBe(false)
    expect(mergedOlder.userProfile?.displayName).toBe('最新暱稱')
  })

  it('能依 projectOrderUpdatedAt 跨裝置同步分帳專案排序並保留本地新專案', () => {
    const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const idC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    const remoteBackup = createLedgerBackupPayload(
      [projectA],
      [txLocalOld],
      1700000030000,
      undefined,
      undefined,
      [idB, idA],
      1700000030000,
    )

    // 情境 A：遠端排序較新 -> 採用 [idB, idA] 並保留本地獨有的 idC
    const mergedFromNewerRemote = parseAndMergeLedgerBackup(
      {
        projects: [projectA],
        transactions: [txLocalOld],
        projectOrder: [idA, idB, idC],
        projectOrderUpdatedAt: 1700000010000,
      },
      JSON.stringify(remoteBackup),
    )

    expect(mergedFromNewerRemote.projectOrderUpdated).toBe(true)
    expect(mergedFromNewerRemote.projectOrder).toEqual([idB, idA, idC])

    // 情境 B：本地排序較新 -> 保留本地順序，僅補入遠端獨有 ID
    const mergedWithNewerLocal = parseAndMergeLedgerBackup(
      {
        projects: [projectA],
        transactions: [txLocalOld],
        projectOrder: [idC, idA],
        projectOrderUpdatedAt: 1700000099999,
      },
      JSON.stringify(remoteBackup),
    )

    expect(mergedWithNewerLocal.projectOrder).toEqual([idC, idA, idB])
  })

  it('拒絕無效的 JSON 字串與結構損毀之備份資料', () => {
    expect(() =>
      parseAndMergeLedgerBackup(
        { projects: [projectA], transactions: [txLocalOld] },
        '{ invalid json !!!',
      ),
    ).toThrow()

    expect(() =>
      parseAndMergeLedgerBackup(
        { projects: [projectA], transactions: [txLocalOld] },
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: Date.now(),
          projects: [{ id: 'not-a-uuid' }],
          transactions: [],
        }),
      ),
    ).toThrow()
  })

  it('拒絕高於當前支援版本（schemaVersion: 99）的外部備份檔', () => {
    const futureBackup = JSON.stringify({
      schemaVersion: 99,
      exportedAt: Date.now(),
      projects: [],
      transactions: [],
    })

    expect(() =>
      parseAndMergeLedgerBackup(
        { projects: [projectA], transactions: [txLocalOld] },
        futureBackup,
      ),
    ).toThrowError(SchemaMigrationError)

    expect(() =>
      parseAndMergeLedgerBackup(
        { projects: [projectA], transactions: [txLocalOld] },
        futureBackup,
      ),
    ).toThrowError(/ERR_UNSUPPORTED_SCHEMA_VERSION/)
  })

  it('匯出完整與單專案備份時，預設剔除 syncMeta（含 accessKey/myMemberId）與 isArchived', () => {
    const sharedArchivedProject: Project = {
      ...projectA,
      isArchived: true,
      syncMeta: {
        mode: 'firestore',
        shareId: 'share_12345678',
        accessKey: 'secret_access_key_1234567890',
        role: 'owner',
        myMemberId: 'me',
        syncReceiptImages: true,
        lastSyncedAt: 1700000005000,
      },
    }

    const fullBackup = createLedgerBackupPayload(
      [sharedArchivedProject],
      [txLocalOld],
    )
    expect(fullBackup.projects[0].syncMeta).toBeUndefined()
    expect(fullBackup.projects[0].isArchived).toBeUndefined()
    expect(fullBackup.projects[0].defaultPayerId).toBeUndefined()
    expect(JSON.stringify(fullBackup)).not.toContain('secret_access_key_1234567890')

    const singleBackup = createSingleProjectBackupPayload(
      sharedArchivedProject,
      [txLocalOld],
    )
    expect(singleBackup.projects[0].syncMeta).toBeUndefined()
    expect(singleBackup.projects[0].isArchived).toBeUndefined()
    expect(singleBackup.projects[0].defaultPayerId).toBeUndefined()
    expect(JSON.stringify(singleBackup)).not.toContain('secret_access_key_1234567890')

    // 原始專案物件不被就地修改
    expect(sharedArchivedProject.syncMeta?.accessKey).toBe(
      'secret_access_key_1234567890',
    )
    expect(sharedArchivedProject.isArchived).toBe(true)
    expect(sharedArchivedProject.defaultPayerId).toBe('me')
  })

  it('合併備份時保留本機專案的 syncMeta、isArchived 與 defaultPayerId，並剔除外部夾帶的裝置私有欄位', () => {
    const localSyncMeta = {
      mode: 'firestore' as const,
      shareId: 'local_share_0001',
      accessKey: 'local_secret_access_key_0001',
      role: 'owner' as const,
      myMemberId: 'me',
      syncReceiptImages: true,
      lastSyncedAt: 1700000005000,
    }
    const localProjectShared: Project = {
      ...projectA,
      members: [
        ...projectA.members,
        { id: 'pool_1', name: '公費袋', avatarColor: '#f59e0b', isPool: true },
      ],
      defaultPayerId: 'pool_1',
      isArchived: true,
      syncMeta: localSyncMeta,
      updatedAt: 1700000001000,
    }
    const localProjectUnshared: Project = {
      ...projectA,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: '2026 大阪行',
      defaultPayerId: 'me',
      updatedAt: 1700000001000,
    }

    // 模擬舊版備份或他機 Drive 同步：專案更新時間較新，且夾帶他機 syncMeta / isArchived / defaultPayerId
    const incomingBackup = createLedgerBackupPayload(
      [
        // 情境 A：本機有 syncMeta、isArchived 與公費優先 defaultPayerId，遠端夾帶他機不同的私有欄位
        {
          ...projectA,
          members: [
            ...projectA.members,
            { id: 'pool_1', name: '公費袋', avatarColor: '#f59e0b', isPool: true },
          ],
          name: '2026 東京自由行（遠端改名）',
          defaultPayerId: 'lin',
          isArchived: false,
          syncMeta: {
            mode: 'firestore',
            shareId: 'remote_share_9999',
            accessKey: 'remote_secret_access_key_9999',
            role: 'editor',
            myMemberId: 'lin',
          },
          updatedAt: 1700000010000,
        },
        // 情境 B：本機無 syncMeta & 無 isArchived，遠端舊版夾帶他機 syncMeta、isArchived: true 與 defaultPayerId: 'lin'
        {
          ...localProjectUnshared,
          name: '2026 大阪行（遠端改名）',
          defaultPayerId: 'lin',
          isArchived: true,
          syncMeta: {
            mode: 'firestore',
            shareId: 'other_device_share',
            accessKey: 'other_device_secret_key_1234',
            role: 'editor',
            myMemberId: 'lin',
          },
          updatedAt: 1700000010000,
        },
        // 情境 C：本機不存在的新專案，外部舊版備份夾帶他人 syncMeta、isArchived: true 與 defaultPayerId: 'lin'
        {
          ...projectA,
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          name: '朋友分享的北海道專案',
          defaultPayerId: 'lin',
          isArchived: true,
          syncMeta: {
            mode: 'firestore',
            shareId: 'friend_share_0001',
            accessKey: 'friend_secret_access_key_0001',
            role: 'owner',
            myMemberId: 'friend_1',
          },
          updatedAt: 1700000010000,
        },
      ],
      [],
      1700000010000,
      undefined,
      undefined,
      undefined,
      undefined,
      { includeDevicePrivateFields: true },
    )

    const merged = mergeLedgerData(
      {
        projects: [localProjectShared, localProjectUnshared],
        transactions: [],
      },
      incomingBackup,
    )

    expect(merged.stats.projectsUpdated).toBe(2)
    expect(merged.stats.projectsAdded).toBe(1)

    // 情境 A：共享欄位已更新，本機 syncMeta、isArchived 與公費優先 defaultPayerId 完整保留
    const mergedA = merged.projects.find((p) => p.id === localProjectShared.id)
    expect(mergedA?.name).toBe('2026 東京自由行（遠端改名）')
    expect(mergedA?.isArchived).toBe(true)
    expect(mergedA?.defaultPayerId).toBe('pool_1')
    expect(mergedA?.syncMeta).toEqual(localSyncMeta)

    // 情境 B：本機原本未共享未封存，不得被遠端塞入他機 syncMeta / isArchived / defaultPayerId
    const mergedB = merged.projects.find((p) => p.id === localProjectUnshared.id)
    expect(mergedB?.name).toBe('2026 大阪行（遠端改名）')
    expect(mergedB?.syncMeta).toBeUndefined()
    expect(mergedB?.isArchived).toBeUndefined()
    expect(mergedB?.defaultPayerId).toBe('me')

    // 情境 C：新增專案時剔除外部夾帶的 syncMeta、isArchived 與 defaultPayerId
    const mergedC = merged.projects.find(
      (p) => p.id === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    )
    expect(mergedC?.name).toBe('朋友分享的北海道專案')
    expect(mergedC?.syncMeta).toBeUndefined()
    expect(mergedC?.isArchived).toBeUndefined()
    expect(mergedC?.defaultPayerId).toBeUndefined()
  })

  it('匯入／Drive 合併後，僅為即時共享專案中實際新增或更新的項目產出 Firestore Outbox 補排清單', () => {
    const sharedProjectId = projectA.id
    const localOnlyProjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const deletedSharedProjectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const newExternalProjectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

    const sharedProject: Project = {
      ...projectA,
      updatedAt: 1700000001000,
      syncMeta: {
        mode: 'firestore',
        shareId: 'share_realtime_01',
        accessKey: 'secret_key_realtime_01',
        role: 'owner',
        myMemberId: 'me',
      },
    }
    const localOnlyProject: Project = {
      ...projectA,
      id: localOnlyProjectId,
      name: '僅本機專案',
      updatedAt: 1700000001000,
    }
    const deletedSharedProject: Project = {
      ...projectA,
      id: deletedSharedProjectId,
      name: '已刪除共享專案',
      isDeleted: true,
      updatedAt: 1700000001000,
      syncMeta: {
        mode: 'firestore',
        shareId: 'share_deleted_01',
        accessKey: 'secret_key_deleted_01',
        role: 'owner',
        myMemberId: 'me',
      },
    }

    const txSharedSkipped: Transaction = {
      ...txLocalOld,
      id: '11111111-1111-4111-8111-111111111111',
      projectId: sharedProjectId,
      updatedAt: 1700000005000,
    }
    const txSharedUpdatedLocal: Transaction = {
      ...txLocalOld,
      id: '22222222-2222-4222-8222-222222222222',
      projectId: sharedProjectId,
      updatedAt: 1700000002000,
    }

    const incomingBackup = createLedgerBackupPayload(
      [
        // 共享專案更新 -> 應補排 project
        { ...sharedProject, name: '2026 東京自由行（合併更新）', updatedAt: 1700000010000 },
        // 非共享專案更新 -> 不補排
        { ...localOnlyProject, name: '僅本機專案（更新）', updatedAt: 1700000010000 },
        // 已軟刪除之共享專案更新 -> 不補排
        { ...deletedSharedProject, name: '已刪除共享專案（更新）', updatedAt: 1700000010000 },
        // 外部新增專案（即便原始帶 syncMeta，合併時已被剔除） -> 不補排
        {
          ...projectA,
          id: newExternalProjectId,
          name: '外部新增專案',
          updatedAt: 1700000010000,
          syncMeta: {
            mode: 'firestore',
            shareId: 'external_share',
            accessKey: 'external_secret_key_1234',
            role: 'owner',
          },
        },
      ],
      [
        // 共享專案交易較舊 -> skipped，不補排
        { ...txSharedSkipped, amount: 1800, updatedAt: 1700000003000 },
        // 共享專案既有交易更新（且含同 ID 兩筆遞增版本 -> 去重並採用最新 updatedAt）
        { ...txSharedUpdatedLocal, amount: 2400, updatedAt: 1700000008000 },
        { ...txSharedUpdatedLocal, amount: 2600, updatedAt: 1700000009000 },
        // 共享專案新增交易 -> 應補排
        {
          ...txLocalOld,
          id: '33333333-3333-4333-8333-333333333333',
          projectId: sharedProjectId,
          amount: 3200,
          updatedAt: 1700000011000,
        },
        // 共享專案新增軟刪除交易 -> 應補排（同步刪除狀態）
        {
          ...txLocalOld,
          id: '44444444-4444-4444-8444-444444444444',
          projectId: sharedProjectId,
          isDeleted: true,
          updatedAt: 1700000012000,
        },
        // 非共享專案新增交易 -> 不補排
        {
          ...txLocalOld,
          id: '55555555-5555-4555-8555-555555555555',
          projectId: localOnlyProjectId,
          amount: 500,
          updatedAt: 1700000011000,
        },
        // 已軟刪除共享專案新增交易 -> 不補排
        {
          ...txLocalOld,
          id: '66666666-6666-4666-8666-666666666666',
          projectId: deletedSharedProjectId,
          amount: 700,
          updatedAt: 1700000011000,
        },
      ],
      1700000012000,
      undefined,
      undefined,
      undefined,
      undefined,
      { includeDevicePrivateFields: true },
    )

    const merged = mergeLedgerData(
      {
        projects: [sharedProject, localOnlyProject, deletedSharedProject],
        transactions: [txSharedSkipped, txSharedUpdatedLocal],
      },
      incomingBackup,
    )

    const outboxEntries = collectRealtimeOutboxEntriesFromMerge(merged)

    expect(outboxEntries).toEqual([
      {
        projectId: sharedProjectId,
        entityType: 'project',
        entityId: sharedProjectId,
        updatedAt: 1700000010000,
      },
      {
        projectId: sharedProjectId,
        entityType: 'transaction',
        entityId: '22222222-2222-4222-8222-222222222222',
        updatedAt: 1700000009000,
      },
      {
        projectId: sharedProjectId,
        entityType: 'transaction',
        entityId: '33333333-3333-4333-8333-333333333333',
        updatedAt: 1700000011000,
      },
      {
        projectId: sharedProjectId,
        entityType: 'transaction',
        entityId: '44444444-4444-4444-8444-444444444444',
        updatedAt: 1700000012000,
      },
    ])
  })
})

describe('shareFormatter - 一鍵分享結算摘要文字產生器', () => {
  it('產生含總支出、各成員支出與待還款建議的清晰文字', () => {
    const settleUp = calculateSettleUp([txLocalOld], 'JPY', ['me', 'lin'])
    const text = buildProjectSettlementShareText(
      projectA,
      settleUp,
      [],
      sampleShareLabels,
      'zh-TW',
    )

    expect(text).toContain('2026 東京自由行')
    expect(text).toContain('2,000')
    expect(text).toContain('小林 ➔ 我')
    expect(text).toContain('1,000')
  })

  it('同時包含 refund（退款／退稅）與 transfer（已記錄還款）時，總支出與待還款輸出皆準確', () => {
    const txRefund: Transaction = {
      id: '33333333-3333-4333-8333-333333333333',
      schemaVersion: 1,
      projectId: projectA.id,
      vaultLevel: 'normal',
      type: 'refund',
      amount: 400,
      currency: 'JPY',
      exchangeRateToBase: 1,
      categoryKey: 'cat_shopping',
      date: '2026-11-24',
      time: '15:00',
      updatedAt: 1700000003000,
      note: '藥妝退稅',
      splitConfig: {
        payerId: 'me',
        mode: 'equal',
        shares: [
          { memberId: 'me', finalAmount: 200 },
          { memberId: 'lin', finalAmount: 200 },
        ],
      },
    }

    const txTransfer: Transaction = {
      id: '44444444-4444-4444-8444-444444444444',
      schemaVersion: 1,
      projectId: projectA.id,
      vaultLevel: 'normal',
      type: 'transfer',
      amount: 300,
      currency: 'JPY',
      exchangeRateToBase: 1,
      categoryKey: 'cat_settlement',
      date: '2026-11-25',
      time: '00:00',
      updatedAt: 1700000004000,
      note: '現金先還部分',
      splitConfig: {
        payerId: 'lin',
        mode: 'custom_plus_equal',
        shares: [{ memberId: 'me', finalAmount: 300 }],
      },
    }

    // 原消費 2000 - 退稅 400 = 專案總支出 1600（兩人各負擔 800）
    // 小林原本欠我 800，已還 300 -> 剩餘待還款 500
    const allTxs = [txLocalOld, txRefund, txTransfer]
    const settleUp = calculateSettleUp(allTxs, 'JPY', ['me', 'lin'])

    expect(settleUp.totalProjectExpense).toBe(1600)
    expect(settleUp.transfers).toEqual([
      { fromMemberId: 'lin', toMemberId: 'me', amount: 500, currency: 'JPY' },
    ])

    const text = buildProjectSettlementShareText(
      projectA,
      settleUp,
      [txTransfer],
      sampleShareLabels,
      'zh-TW',
    )

    expect(text).toContain('專案總支出')
    expect(text).toContain('1,600')
    expect(text).toContain('總支出')
    expect(text).toContain('800')
    expect(text).toContain('小林 ➔ 我')
    expect(text).toContain('500')
    expect(text).toContain('已記錄還款：')
    expect(text).toContain('2026-11-25 小林 已付給 我')
    expect(text).toContain('300')
  })

  it('能產生單一成員專屬對帳單並驗證泰國複利加成與 THB 整數格式省略 .00', () => {
    expect(computeEffectiveCompoundFeePercent(10, 7)).toBe(17.7)
    expect(applyPercentFees(1000, 10, 7, 0)).toBe(1177)
    expect(formatCurrencyAmount(100, 'THB', 'en')).not.toContain('.00')
    expect(formatCurrencyAmount(100.5, 'THB', 'en')).toContain('.50')

    const settleUp = calculateSettleUp([txLocalOld], 'JPY', ['me', 'lin'])
    const memberText = buildMemberStatementShareText(
      {
        ...projectA,
        members: [
          { id: 'me', name: '我', paymentInfo: '國泰世華 013-999' },
          { id: 'lin', name: '小林' },
        ],
      },
      'lin',
      settleUp,
      [
        {
          date: '2026-11-24',
          title: '拉麵（舊版）',
          isRefund: false,
          shareInSettle: 1000,
          paidInSettle: 0,
        },
      ],
      {
        headerPrefix: '【ClearBill 結算】',
        statementTitle: '小林 的分攤與墊付明細',
        spentLabel: '總支出',
        paidLabel: '已墊付',
        netLabel: '淨收支',
        shouldReceive: '應收回',
        shouldPay: '應支付',
        settled: '已結清',
        transfersTitle: '▎待還款建議',
        allSettledText: '已結清',
        entriesTitle: '▎消費與退款明細',
        refundTag: '退款',
        transferLine: (from, to, amt) => `${from} ➔ ${to}：${amt}`,
        footerTagline: '— ClearBill',
      },
      'zh-TW',
    )

    expect(memberText).toContain('小林 的分攤與墊付明細')
    expect(memberText).toContain('小林 ➔ 我')
    expect(memberText).toContain('國泰世華 013-999')
    expect(memberText).toContain('拉麵（舊版）')
  })
})

describe('googleConnectLink - Google 雲端跨裝置快速連線連結', () => {
  it('能產生並解析合法的 Google OAuth Client ID 跨裝置配對連結', () => {
    const clientId = '1234567890-abcdefg12345.apps.googleusercontent.com'
    const url = buildGoogleConnectLink(
      'https://example.github.io/ClearBill/',
      clientId,
    )
    expect(url).toContain('#/connect-google?cid=')

    const hash = url.slice(url.indexOf('#'))
    const parsed = parseGoogleConnectHash(hash)
    expect(parsed).toEqual({ clientId })
  })

  it('拒絕偽造或非 apps.googleusercontent.com 格式的惡意參數', () => {
    expect(parseGoogleConnectHash('#/connect-google?cid=evil.com')).toBeNull()
    expect(parseGoogleConnectHash('#/connect-google?cid=')).toBeNull()
    expect(parseGoogleConnectHash('#/other?cid=123.apps.googleusercontent.com')).toBeNull()
    expect(() =>
      buildGoogleConnectLink('https://example.com/', 'not-a-valid-client-id'),
    ).toThrow()
  })
})

describe('i18n locales - 全站三語系鍵值對齊與 vue-i18n 實機編譯健檢', () => {
  const flattenKeys = (obj: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? flattenKeys(v as Record<string, unknown>, prefix ? `${prefix}.${k}` : k)
        : [prefix ? `${prefix}.${k}` : k],
    )

  it('zh-TW / en / ja 三語系鍵值 100% 一致且全部可被 vue-i18n 零錯誤編譯', () => {
    const zhKeys = flattenKeys(zhTW).sort()
    const enKeys = flattenKeys(en).sort()
    const jaKeys = flattenKeys(ja).sort()

    expect(enKeys).toEqual(zhKeys)
    expect(jaKeys).toEqual(zhKeys)

    const i18n = createI18n({
      legacy: false,
      locale: 'zh-TW',
      messages: { 'zh-TW': zhTW, en, ja },
    })

    for (const loc of ['zh-TW', 'en', 'ja'] as const) {
      i18n.global.locale.value = loc
      for (const key of zhKeys) {
        const rendered = i18n.global.t(key)
        expect(typeof rendered).toBe('string')
        expect(rendered.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('mergeLedgerData - 直接邊界測試', () => {
  it('相同 UUID 且 updatedAt 相等時應保留本機並標記 skipped，不計入 changedIds', () => {
    const incoming = createLedgerBackupPayload([projectA], [txLocalOld])
    const res = mergeLedgerData(
      { projects: [projectA], transactions: [txLocalOld] },
      incoming,
    )
    expect(res.stats.projectsSkipped).toBe(1)
    expect(res.stats.projectsUpdated).toBe(0)
    expect(res.stats.transactionsSkipped).toBe(1)
    expect(res.stats.transactionsUpdated).toBe(0)
    expect(res.changedProjectIds).toEqual([])
    expect(res.changedTransactionIds).toEqual([])
  })

  it('空的 incoming 備份不影響本機既有專案、交易與分類，且自訂分類去重合併正確', () => {
    const localCats = [
      { key: 'cat_food', isBuiltin: true, color: '#ef4444' },
      { key: 'cat_custom_1', customLabel: '滑雪', isBuiltin: false, color: '#0ea5e9' },
    ]
    const emptyIncoming = createLedgerBackupPayload(
      [],
      [],
      1700000099999,
      [
        { key: 'cat_custom_1', customLabel: '不應覆蓋本機', isBuiltin: false, color: '#000000' },
        { key: 'cat_custom_2', customLabel: '溫泉', isBuiltin: false, color: '#10b981' },
      ],
      {
        displayName: '新版大明',
        avatarColor: '#2563eb',
        updatedAt: 1700000099999,
      },
    )

    const res = mergeLedgerData(
      {
        projects: [projectA],
        transactions: [txLocalOld],
        categories: localCats,
        userProfile: {
          displayName: '舊版大明',
          avatarColor: '#059669',
          updatedAt: 1700000001000,
        },
      },
      emptyIncoming,
    )

    expect(res.projects).toHaveLength(1)
    expect(res.transactions).toHaveLength(1)
    expect(res.stats.categoriesAdded).toBe(1)
    expect(res.categories.find((c) => c.key === 'cat_custom_1')?.customLabel).toBe('滑雪')
    expect(res.categories.find((c) => c.key === 'cat_custom_2')?.customLabel).toBe('溫泉')
    expect(res.userProfileUpdated).toBe(true)
    expect(res.userProfile?.displayName).toBe('新版大明')
  })
})
