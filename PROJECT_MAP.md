# ClearBill 程式與資料流地圖（PROJECT_MAP）

> 產出基準：2026-11-27 重構收尾更新。行數為 `(Get-Content).Count` 實際行數（含空行）。
> 單元測試分布於 `src/core/__tests__/`、`src/composables/__tests__/` 與 `src/stores/__tests__/`（共 26 個測試檔、203 項測試）；Vitest 環境為 `node`（`vite.config.ts` L131-132）。
> 「過肥」判定：≥300 行且承擔 2 種以上職責。

## 1. 根目錄設定檔與文件

| 檔案 | 行數 | 職責 |
|---|---|---|
| README.md | 83 | 專案定位、核心特色、技術棧、開發指令、環境變數、目錄分層架構與設計鐵律（連結 PROJECT_MAP / REFACTOR_PLAN） |
| package.json | 34 | 依賴：vue 3.5、pinia 2、dexie 4、firebase 13、zod 3、vue-i18n 11、lucide；`build = vue-tsc --noEmit && vite build`、`test = vitest run` |
| vite.config.ts | 135 | Vite + PWA（`share_target`、workbox）+ Vitest 設定 |
| tsconfig.json | 26 | `strict: true`、`noUnusedLocals/Parameters`、別名 `@/* → src/*` |
| firestore.rules | 56 | Firestore 安全規則（本次未審查內容） |

## 2. 實際目錄與檔案職責表

### 2.1 入口與全域

| 檔案路徑 | 行數 | 核心職責 | 主要依賴 | 被誰引用 | 過肥/需拆分 |
|---|---|---|---|---|---|
| src/main.ts | 43 | 建立 App、Pinia、i18n | App.vue、i18n、ledgerStore | — | 否 |
| src/i18n.ts | 45 | 三語系載入 | locales/*.json（各 652 行） | main、SettingsProfileSection | 否 |
| src/App.vue | 780 | 根殼層：頂部導覽列、Toast 與 6 秒連刪復原、內建瀏覽器提醒、視圖切換（Home／Create／Workspace）、全域 Modal 掛載與協調 | ledgerStore、useHashRoute、usePwaLifecycle、useClipboardShare、views/*.vue（3 檔）、3 個常駐元件＋7 個 lazy Modal | main | 否（已拆出 2 個 composables＋3 個 View） |

### 2.2 Store（依領域拆分，由 `ledgerStore` 門面組合）

| 檔案路徑 | 行數 | 核心職責 | 主要依賴 | 被誰引用 | 過肥/需拆分 |
|---|---|---|---|---|---|
| src/stores/ledgerStore.ts | 1854 | **門面組合 Store（完整保留對外 132 API＋Service 封裝動作）**：核心 `projects`/`transactions` 狀態、IndexedDB 載入遷移與異常隔離、專案／成員／交易 CRUD、範例專案、備份匯入匯出、儲存量統計，並透過 `storeToRefs` 與單向橋接組合下列 6 個領域模組 | normalVaultDb、ledgerSchema、migrationEngine、settleUpEngine、memberLedger、backupMergeEngine、plainClone、6 個子 Store／動作模組 | main、App、13 個元件 | 否（已拆出 6 個領域模組） |
| src/stores/userPrefsStore.ts | 576 | 使用者偏好（localStorage v2/v1 經 `userPrefsSchema` 驗證）、幣別與分類管理、匯率記憶／快捷匯率、即時參考匯率快取（含 `liveRatesCacheTtlMs`）、上次拆帳記憶與個人檔案 | ledgerSchema、userPrefsSchema、ledgerHelpers、categoryIcons、exchangeRateService | ledgerStore、settlementViewStore、realtimeSyncStore | 否 |
| src/stores/settlementViewStore.ts | 178 | 本機裝置結算視角（結帳幣別、per_tx/live/custom 匯率模式、自訂匯率分桶、舊專案欄位一次性遷移 `migrateLegacyProjectViews`），經 `bindDataSource` 維持單向依賴 | ledgerSchema、settlementRateResolver、userPrefsStore | ledgerStore | 否 |
| src/stores/googleDriveStore.ts | 330 | Google Drive 跨裝置雙向同步、自動同步排程、dirty 世代追蹤、OAuth Client ID 管理與錯誤碼封裝，經 `bindBackupBridge` 維持零循環依賴 | driveDirtyTracker、googleDriveSync | ledgerStore | 否 |
| src/stores/realtimeSyncStore.ts | 748 | Firestore 即時協作監聽、Outbox 排程與重試、遠端批次套用、依 projectId 排隊之刪除熔斷佇列、發布／加入／輪替／停止共享與 Firebase 設定／錯誤碼封裝，經 `bindLedgerContext` 維持零循環依賴 | normalVaultDb、outboxFlusher、realtimeSyncEngine、firestoreSyncService、userPrefsStore | ledgerStore | 否 |
| src/stores/poolActions.ts | 278 | 公費袋動作工廠（`isPoolCollectionTransaction`、`ensureProjectPoolMember`、`togglePreferPoolPayer`、`batchCollectPoolFund`） | normalVaultDb、currency、poolFund | ledgerStore | 否 |
| src/stores/trashActions.ts | 334 | 軟刪除、批次軟刪除、復原（含連動復原專案與孤兒公費袋補回）、永久刪除與清空回收桶動作工廠 | normalVaultDb、poolFund | ledgerStore | 否 |

### 2.3 Core（純 TypeScript 邏輯）

| 檔案路徑 | 行數 | 核心職責 | 主要依賴 | 被誰引用 | 過肥/需拆分 |
|---|---|---|---|---|---|
| core/splitCalculator.ts | 302 | 四模式拆帳（最大餘數法、最小幣別單位） | currency、ledgerSchema | QuickSplitPanel、quickIntakeParser | 否（單一職責） |
| core/settleUpEngine.ts | 447 | 成員淨額、Greedy 債務簡化、集中收付、`applySettlementRatesToTransactions` 匯率覆寫與跨幣缺匯率防護（`strict` 拋錯／`MISSING_SETTLEMENT_RATE` 異常標記） | currency、memberLedger、splitInvariant、ledgerSchema | ledgerStore、ProjectSettleTab、excel/report/share | 否（可再分匯率覆寫） |
| core/settlementRateResolver.ts | 457 | 統一解析結算幣別／匯率模式／覆寫表／互為倒數之雙向匯率（`resolveSettlementOptions`）、自訂匯率分桶合併（`mergeCustomRateBuckets`）與舊專案結算欄位一次性遷移至本機視角（`migrateLegacyProjectSettlementViews`） | settleUpEngine、ledgerSchema | ledgerStore、settlementViewStore、ProjectSettleTab、SettlementPaymentModal | 否 |
| core/memberLedger.ts | 282 | 統一單筆拆解、成員分攤／墊付／淨額貢獻（`computeMemberTxContribution`）、成員彙總、淨消費加總與專案輕量總額加總（`sumProjectExpense`，per_tx 口徑） | currency、splitInvariant、ledgerSchema | settleUpEngine、ledgerStore、TransactionListSection、ProjectSettleTab | 否 |
| core/poolFund.ts | 190 | 統一公費袋成員判定（`isPoolMemberId`/`isPoolMemberIdInProject`）、公費與真人餘額分區（`partitionPoolAndHumanBalances`，含孤兒 `pool_` ID）、繳公費交易判定（`isPoolCollectionTransaction`）、新舊格式最近批次收公費辨識（`findLatestPoolCollectBatch`）與孤兒公費 ID 偵測 | currency、ledgerSchema | ledgerStore、ProjectSettleTab、PoolCollectModal、shareFormatter、excelExporter、reportImageGenerator | 否 |
| core/splitInvariant.ts | 196 | 拆帳金額守恆不變式（`validateSplitInvariant`、`assertSplitInvariant`、`StrictTransactionSchema`、尾差上限） | currency、ledgerSchema | settleUpEngine、memberLedger、migrationEngine、ledgerStore | 否 |
| core/currency.ts | 163 | 幣別精度、minor units、Intl 格式化 | — | 幾乎所有帳務模組與 11 個元件 | 否 |
| core/ledgerHelpers.ts | 131 | 離線估算匯率表（未知幣別回傳 `null`）、服務費加成、日期比對與檔名清理（純函式，DOM 下載已移至 `platform/download.ts`） | — | ledgerStore、9 個元件 | 否 |
| core/migrationEngine.ts | 304 | v0→v1 遷移＋Zod 驗證（交易/專案/備份）與本機 IndexedDB 批次載入遷移／異常隔離（`migrateLoadedLedgerRecords`） | ledgerSchema、splitInvariant | ledgerStore、backupMergeEngine、firestoreSyncService | 否 |
| core/backupMergeEngine.ts | 389 | UUID＋updatedAt 無損合併、備份封包建立（匯出預設經 `sanitizeProjectForCloud` 剔除 `syncMeta`/`isArchived`/`defaultPayerId`，合併時保留本機裝置私有欄位並隔離外部私有欄位，並回傳變更 ID 與 `collectRealtimeOutboxEntriesFromMerge` 供即時共享專案補排 Outbox） | migrationEngine、realtimeSyncEngine、ledgerSchema | ledgerStore、googleDriveSync | 否 |
| core/realtimeSyncEngine.ts | 372 | 邀請連結、雲端 payload 清理（剔除 `syncMeta`/`isArchived`/`defaultPayerId`）、遠端專案合併保留本機私有欄位（`mergeRemoteProjectPreservingLocalFields`/`resolvePreservedLocalDefaultPayerId`）、刪除熔斷判定、依 `projectId` 排隊之待決熔斷佇列（`enqueuePendingDeletionGuard`/`dequeuePendingDeletionGuard`）與核准前二次比對（`filterApprovableRemoteDeletes`） | ledgerSchema | ledgerStore、firestoreSyncService、backupMergeEngine、ProjectShareModal、App | 否 |
| core/outboxFlusher.ts | 148 | 離線 Outbox 推送協調器（並發鎖定、版本條件清除、推送中新增／更新自動重排程與中途失敗清理） | — | ledgerStore | 否 |
| core/driveDirtyTracker.ts | 90 | Google Drive 同步 dirty 世代計數器（記錄開始與上傳快照世代，防止同步期間新寫入被無條件清除） | — | ledgerStore | 否 |
| core/plainClone.ts | 97 | `cloneAsPlain`/`deepUnwrap`：以 `structuredClone` + 解包函式（`toRaw`）深拷貝並解除巢狀 Proxy，保留 `undefined` 與原生型別，避免 JSON 序列化大圖開銷 | — | ledgerStore | 否 |
| core/txPresentation.ts | 93 | 交易付款人標籤組字（`getTxPayerEntries`、`getTxPayerIds`、`describePayers`，支援多人分隔符、附金額與自訂摘要） | ledgerSchema | shareFormatter、excelExporter、reportImageGenerator、ProjectSettleTab | 否 |
| core/duplicateDetector.ts | 85 | 多人協作疑似重複記帳偵測（`isPotentialDuplicateTransaction`、`findPotentialDuplicateTransaction`，含金額容差、備註／分類交叉防誤報、忽略軟刪除與排除自身） | ledgerSchema | ProjectExpenseModal | 否 |
| core/shareFormatter.ts | 318 | LINE 結算摘要、成員對帳單文字 | settleUpEngine、currency、poolFund、txPresentation | ProjectSettleTab | 邊界（2 種輸出） |
| core/excelExporter.ts | 467 | 手刻 xlsx（雙工作表） | settleUpEngine、currency、poolFund、txPresentation | useSettleExports（dynamic import） | 否 |
| core/categoryStats.ts | 107 | 分類統計 | currency | CategoryPieChart、reportImageGenerator | 否 |
| core/quickIntakeParser.ts | 376 | 外部快速入帳解析 | splitCalculator | ProjectExpenseModal、App | 否 |
| core/expressionEvaluator.ts | 244 | 安全四則運算 | — | CurrencyAmountInput | 否 |
| core/categoryIcons.ts / currencyCatalog.ts / googleConnectLink.ts / inAppBrowser.ts | 147/60/49/45 | 圖示表、幣別目錄、配對連結、內建瀏覽器偵測 | — | 少數元件／Store | 否 |

### 2.3.1 Platform（瀏覽器 DOM / Canvas 平台專屬工具）

| 檔案路徑 | 行數 | 核心職責 | 主要依賴 | 被誰引用 | 過肥/需拆分 |
|---|---|---|---|---|---|
| platform/download.ts | 36 | 瀏覽器 DOM 檔案下載（`triggerTextFileDownload`、`triggerBinaryFileDownload`） | — | useSettleExports、ProjectSettingsTab | 否 |
| platform/imageCompressor.ts | 153 | Canvas 圖片壓縮（收據／頭像／封面轉 Data URL） | — | ProjectExpenseModal、ProjectSettingsTab、SettingsProfileSection、ProjectCreateView | 否 |
| platform/reportImageGenerator.ts | 621 | Canvas 長圖 PNG 報表產生（自動降 DPR） | settleUpEngine、categoryStats、poolFund、txPresentation | useSettleExports（dynamic import） | 否（已與 core 純邏輯分離） |

### 2.4 Schema / DB / Services

| 檔案路徑 | 行數 | 核心職責 | 主要依賴 | 被誰引用 | 過肥/需拆分 |
|---|---|---|---|---|---|
| schemas/ledgerSchema.ts | 278 | 全部 Zod Schema（交易、拆帳、專案、同步中繼、備份、快速入帳） | zod | 幾乎全部 | 否 |
| schemas/userPrefsSchema.ts | 611 | localStorage 與快取之 Zod Schema 與欄位級容錯解析（使用者偏好 v2/v1、即時匯率快取與 API 匯率表、Google Drive Token／帳號快取、自訂服務費與刷卡手續費） | zod、ledgerSchema、categoryIcons、settlementRateResolver | ledgerStore、exchangeRateService、googleDriveSync、CurrencyAmountInput | 否 |
| db/normalVaultDb.ts | 134 | Dexie v2（projects/transactions/syncOutbox）＋寫入前 Zod 驗證＋原子條件刪除 Outbox（`removeSyncOutboxIfNotNewer`、`applyConditionalOutboxRemoval`）與防亂序倒退 | ledgerSchema | ledgerStore | 否 |
| services/firestoreSyncService.ts | 470 | Firebase 動態載入、發布/加入/推送/onSnapshot（讀取端經 migrate* 驗證） | migrationEngine、realtimeSyncEngine | ledgerStore、JoinSharedProjectModal、ProjectShareModal | 邊界 |
| services/googleDriveSync.ts | 760 | GIS OAuth、Token/帳號 localStorage（改經 `userPrefsSchema` 驗證）、Drive 上傳下載、雙向同步流程（dirty 清除權交由呼叫端依世代判定） | backupMergeEngine、userPrefsSchema | ledgerStore、SettingsCloudSyncSection、App | 是（OAuth＋儲存＋同步流程） |
| services/exchangeRateService.ts | 213 | 即時匯率抓取與 1 小時快取（快取與外部匯率表皆經 `userPrefsSchema` 驗證） | userPrefsSchema | ledgerStore、App | 否 |

### 2.5 Composables

| 檔案路徑 | 行數 | 核心職責 | 被誰引用 |
|---|---|---|---|
| composables/useModalLayer.ts | 176 | 彈窗層級、Escape、Scroll Lock、Focus Trap | 11 個 Modal/元件 |
| composables/useConfirm.ts | 67 | Promise 化確認框 | ConfirmDialog、ProjectExpense、ProjectSettings、ProjectSettle、ProjectShare、SettingsTrashSection、App |
| composables/useClipboardShare.ts | 220 | 剪貼簿兩段式降級複製（Clipboard API → execCommand）與原生 Web Share API（文字／連結／檔案）共用封裝 | App、TransferPlanCard、useSettleExports、ProjectShareModal、SettingsCloudSyncSection |
| composables/useSettleExports.ts | 327 | 結算頁匯出與分享協調（文字結算摘要、成員對帳單複製、Excel 匯出、PNG 長截圖分享／下載與分類標籤／色彩解析） | ProjectSettleTab |
| composables/useHashRoute.ts | 136 | 外部 Hash 路由解析與分發（`#/connect-google`、`#/join`、`#/quick-add`）與 `hashchange` 監聽生命週期（透過 callback 寫入 Client ID，不直連 Service） | App |
| composables/usePwaLifecycle.ts | 116 | 深淺色主題同步、觸控裝置偵測、內建瀏覽器橫幅狀態、IndexedDB 啟動、線上／前景喚醒同步與每小時匯率定時器（改由 Store 取得 TTL） | App |
| composables/useTxFilters.ts | 376 | 交易明細搜尋、多條件篩選（專案／類別複選／成員／退款／收據）、倒序排序、日期分組、每日淨消費小計與成員分攤／墊付小計（含純函式匯出與單元測試） | TransactionListSection |

### 2.6 Views（頂層頁面視圖）

| 檔案路徑 | 行數 | 核心職責 | 主要依賴 | 被誰引用 | 過肥/需拆分 |
|---|---|---|---|---|---|
| views/HomeView.vue | 368 | 首頁視圖：專案卡片網格、桌機拖曳排序、建立首個／範例專案入口、首頁近期帳目與浮動快速記帳按鈕 | ledgerStore、currency、projectCardHelpers、MemberAvatar、TransactionListSection | App | 否（單一職責） |
| views/ProjectCreateView.vue | 462 | 建立分帳專案視圖：名稱／幣別／預設拆帳模式、現場搜尋新增幣別、既有專案成員複製、膠囊輸入、小卡背景／封面上傳與離頁未儲存確認 | ledgerStore、imageCompressor、useConfirm、projectCardHelpers、CurrencyQuickAddPicker | App | 否（單一職責） |
| views/ProjectView.vue | 396 | 專案工作區視圖：頂部專案資訊主卡（成員／總支出／即時共享狀態／公費餘額與優先支出膠囊）、三分頁切換（明細／結算／設定）與明細頁浮動記帳按鈕 | ledgerStore、currency、projectCardHelpers、MemberAvatar、TransactionListSection、ProjectSettleTab、ProjectSettingsTab | App | 否（單一職責） |
| views/projectCardHelpers.ts | 43 | 專案卡片樣式、自訂背景判定與真人成員過濾共用輔助函式 | — | HomeView、ProjectCreateView、ProjectView | 否 |

### 2.7 Components

| 檔案路徑 | 行數 | 核心職責 | 主要依賴 | 被誰引用 | 過肥/需拆分 |
|---|---|---|---|---|---|
| SettingsModal.vue | 202 | 設定側欄容器：版本號標題列、四大分頁導覽（個人／匯率／分類／資料）、`useModalLayer` 與 6 個設定子元件串接 | useModalLayer、settings/*.vue（6 檔） | App（lazy） | 否（已拆出 6 個設定子元件） |
| settings/SettingsProfileSection.vue | 286 | 個人檔案（頭像壓縮上傳、色票、收款資訊）、外觀深淺色與三語系切換 | store、imageCompressor、i18n、MemberAvatar | SettingsModal | 否 |
| settings/SettingsCloudSyncSection.vue | 582 | Google 雲端硬碟帳號連結、狀態徽章、自動同步開關、Client ID／配對連結與手動同步／合併（全數經 Store 封裝） | store、googleConnectLink、useClipboardShare | SettingsModal | 否（單一職責） |
| settings/SettingsRatesSection.vue | 379 | 每小時即時匯率參考看板、自訂匯率記憶覆寫、預設幣別與常用幣別搜尋管理 | store、currencyCatalog | SettingsModal | 否（單一職責） |
| settings/SettingsCategoriesSection.vue | 452 | 消費分類新增、行內編輯（名稱／底色／24 款圖示）、刪除與重置預設分類 | store、categoryIcons、CategoryIconBadge | SettingsModal | 否（單一職責） |
| settings/SettingsBackupSection.vue | 152 | 本機儲存空間統計、完整／輕量 JSON 備份匯出與合併匯入 | store、ledgerHelpers | SettingsModal | 否 |
| settings/SettingsTrashSection.vue | 343 | 已封存專案管理（檢視／取消封存）與最近刪除回收桶（專案／帳目復原、永久刪除、一鍵清空） | store、currency、useConfirm、MemberAvatar | SettingsModal | 否 |
| ProjectSettleTab.vue | 505 | 結算頁容器：協調結算視角、餘額分區、個人對帳明細計算、已記錄還款明細與 6 個子元件／`useSettleExports` 串接 | store、settleUpEngine、memberLedger、poolFund、txPresentation、useSettleExports、settle/*.vue、CategoryPieChart | App | 否（已拆出 6 個子元件＋匯出 composable） |
| settle/SettleRatePanel.vue | 551 | 頂部總支出、結帳幣別切換、記帳/結帳幣別對照小卡與三模式結算匯率抽屜 | store、currency | ProjectSettleTab | 否（單一職責） |
| settle/TransferPlanCard.vue | 259 | 待還款轉帳方案（最少轉帳／集中收付窗口切換、「只看我」濾鏡、收款資訊複製與記錄還款） | currency、poolFund、useClipboardShare | ProjectSettleTab | 否 |
| settle/MemberBalanceList.vue | 187 | 成員淨額卡片網格、排序切換（成員順序／淨額高到低）與對帳展開插槽 | currency、poolFund、MemberAvatar | ProjectSettleTab | 否 |
| settle/MemberStatementPanel.vue | 180 | 單一成員個人對帳明細展開面板（自動捲動視口、複製對帳單、導向明細與編輯） | currency、poolFund、MemberAvatar | ProjectSettleTab | 否 |
| settle/PoolSummaryCard.vue | 143 | 公費袋餘額卡片、批次收公費入口與最近批次一鍵撤銷確認 | currency、poolFund、useConfirm | ProjectSettleTab | 否 |
| settle/SettleShareSheet.vue | 138 | Apple Action Sheet 分享與匯出選單（明細開關、文字分享、PNG 長截圖、Excel 匯出） | useModalLayer | ProjectSettleTab | 否 |
| ProjectExpenseModal.vue | 1459 | 記帳表單、匯率、收據、存並續記（重複記帳偵測已抽至 `core/duplicateDetector`） | store、QuickSplitPanel、CurrencyAmountInput、quickIntakeParser、duplicateDetector | App | 是（可再細拆匯率／收據子段） |
| QuickSplitPanel.vue | 1106 | 四模式拆帳 UI、子群組（單／多人墊付編輯器已拆至 `split/MultiPayerEditor`） | splitCalculator、currency、MultiPayerEditor | ProjectExpenseModal | 是（可再細拆模式列） |
| split/MultiPayerEditor.vue | 207 | 單人快選膠囊與多人墊付金額輸入／自動補滿剩餘金額／主墊付人切換子元件 | currency、CurrencyAmountInput、MemberAvatar | QuickSplitPanel | 否 |
| TransactionListSection.vue | 941 | 明細清單與展開詳情 UI（搜尋／篩選／排序／日期分組與小計已抽至 `composables/useTxFilters`） | store、currency、useTxFilters | App | 否（篩選邏輯已抽離） |
| ProjectSettingsTab.vue | 765 | 專案設定、成員管理、單專案備份 | store、platform/imageCompressor、platform/download | App | 是 |
| CurrencyAmountInput.vue | 683 | 金額輸入、算式、服務費加成 | expressionEvaluator、ledgerHelpers、userPrefsSchema | PoolCollect、ProjectExpense、QuickSplit、SettlementPayment | 邊界 |
| ProjectShareModal.vue | 645 | 啟用共享、邀請連結、認領成員（全數經 Store 封裝） | store、useClipboardShare | App（lazy） | 是 |
| SettlementPaymentModal.vue | 646 | 記錄／編輯還款、跨幣別換算（改經 `settlementRateResolver` 同步結算匯率） | store、currency | App | 邊界 |
| PoolCollectModal.vue | 503 | 公費批次收款 | store | App（lazy） | 邊界 |
| PhotoLightboxModal.vue | 501 | 收據圖片檢視 | useModalLayer | App（lazy） | 否 |
| JoinSharedProjectModal.vue | 366 | 加入共享專案（全數經 Store 封裝） | store | App（lazy） | 否 |
| AllProjectsModal.vue | 329 | 全部專案清單 | store | App（lazy） | 否 |
| CategoryPieChart.vue | 307 | 分類圓餅圖 | categoryStats、store | ProjectSettleTab | 否 |
| SwipeableTxRow / SyncDeletionGuardModal / CurrencyQuickAddPicker / ConfirmDialog / CategoryIconBadge / MemberAvatar | 297/146/122/88/67/59 | 小型 UI 元件 | — | 見 import 圖 | 否 |

## 3. 核心業務資料流

```
【交易管理】
App → ProjectExpenseModal → QuickSplitPanel → core/splitCalculator.calculateSplit
    → emit splitConfig → store.addTransaction / updateTransaction
    → db.saveTransactionToNormalVault (Zod) → enqueueAndFlushProjectChange → Firestore
    → markGoogleDriveDirty → (2.5s) syncGoogleDriveNow

【帳務與多幣別結算】
store.activeProjectTransactions
  → core/settlementRateResolver.resolveSettlementOptions（本機視角：結帳幣別 + per_tx/live/custom + 互為倒數之 baseToSettlement/settlementToBase）
  → core/settleUpEngine.calculateSettleUp（內部 applySettlementRatesToTransactions）
  → activeProjectSettleUp / activeProjectBaseSettleUp / activeProjectEffectiveExpenses
  → App → ProjectSettleTab（props） → CategoryPieChart → core/categoryStats

【成員餘額】 calculateSettleUp.balances（經 core/memberLedger）→ ProjectSettleTab.displayedMemberBalances
            ＋ TransactionListSection.filteredMemberShare/PaidSubtotal（經 core/memberLedger）

【個人對帳】 ProjectSettleTab.selectedMemberStatement（經 core/memberLedger.computeMemberTxContribution）
            → core/shareFormatter.buildMemberStatementShareText → Clipboard

【還款結算】 ProjectSettleTab emit recordPayment → App → SettlementPaymentModal
            → store.recordSettlementPayment → addTransaction(type=transfer) → 回流 calculateSettleUp
            集中收付：ProjectSettleTab → settleUpEngine.buildHubSettlementTransfers

【公費收支】 PoolCollectModal → store.ensureProjectPoolMember / batchCollectPoolFund
            → addTransaction(transfer, 多 payers) ；顯示：store.isPoolCollectionTransaction、
            ProjectSettleTab.poolBalances / latestPoolCollectBatch（撤銷 → softDeleteTransactionsBatch）

【資料同步－Firestore】
寫：store.* → db.enqueueSyncOutbox → core/outboxFlusher → firestoreSyncService.push*
    → db.removeSyncOutboxIfNotNewer（updatedAt <= pushedUpdatedAt）→ 若仍有殘餘或期間新排入則自動重排程
讀：subscribeSharedProject(onSnapshot) → migrateTransaction/migrateProject
    → handleRemoteTransactionsBatch → realtimeSyncEngine.reconcileRemoteTransactions
    → 熔斷 → pendingDeletionGuardQueue（依 projectId FIFO 排隊）→ SyncDeletionGuardModal → approve（重跑 filterApprovableRemoteDeletes）/reject

【資料同步－Google Drive】
store.syncGoogleDriveNow → core/driveDirtyTracker.beginSync → googleDriveSync.syncWithGoogleDrive
    → onMergeRemote = store.importAndMergeLedgerBackup → backupMergeEngine.parseAndMergeLedgerBackup
    → migrateLedgerBackup(Zod) → mergeLedgerData（保留本機 syncMeta/isArchived/defaultPayerId，剔除外部私有欄位，追蹤變更 ID）→ Dexie bulkPut
    → collectRealtimeOutboxEntriesFromMerge → 對即時共享專案變更補排 enqueueSyncOutbox + flushProjectOutbox
    → getMergedBackup = recordUploadSnapshot + exportLedgerBackup（經 sanitizeProjectForCloud 剔除 syncMeta/isArchived/defaultPayerId）→ 上傳
    → session.complete({ uploaded }) 依世代比對決定清除 dirty 或維持 pending 並重新排程自動同步

【匯入匯出】 SettingsBackupSection → store.exportLedgerBackup / importAndMergeLedgerBackup
            ProjectSettingsTab → store.exportProjectBackup → createSingleProjectBackupPayload（預設剔除 syncMeta/isArchived）

【分享】 ProjectSettleTab → SettleShareSheet → useSettleExports → shareFormatter（文字）/ excelExporter（xlsx，lazy）/ reportImageGenerator（PNG，lazy）
        → useClipboardShare（Web Share → Clipboard API → execCommand 降級）
```

## 4. 跨模組依賴與耦合摘要

| 類型 | 觀察 | 證據 |
|---|---|---|
| 循環依賴 | **未發現**。core 不引用 store/services；services 不引用 store | import 圖掃描 |
| 跨層呼叫（元件→Service） | 所有元件與 Composable 改由 `ledgerStore` 封裝呼叫外部 Service | —（已清零） |
| 跨層呼叫（元件內帳務） | 成員分攤／墊付／日小計已統一抽至 `core/memberLedger`；結算雙向匯率換算已統一抽至 `core/settlementRateResolver` | —（已清零） |
| Core 混入 DOM | 下載與 Canvas 模組已全數移至 `src/platform/`（`download.ts`、`imageCompressor.ts`、`reportImageGenerator.ts`），`src/core/` 維持 100% 純邏輯 | —（已清零） |
| 重複依賴點 | 13 個元件依賴 ledgerStore 單一實例；Store 是所有寫入路徑的唯一匯流點 | §2.2 |
| 結算視角雙源 | 啟動與匯入時由 `settlementViewStore.migrateLegacyProjectViews` 一次性將舊專案欄位搬移至本機 `settlementViewByProject`，之後僅讀本機視角 | `settlementRateResolver.ts`、`settlementViewStore.ts`（已收斂） |
| 重複輔助邏輯 | 公費 ID 判定與分區已統一抽至 `core/poolFund`；付款人標籤組字已統一抽至 `core/txPresentation`；剪貼簿降級複製與 Web Share 已統一抽至 `composables/useClipboardShare` | —（已清零） |
| 運算式非空斷言（`!`） | 全專案非測試碼運算式 `!` 已以區域常數／型別收窄清零（僅保留 Dexie `EntityTable` 類別欄位之明確賦值斷言） | —（已清零） |
