# ClearBill（清帳）— 專案開發總綱 (Antigravity 專用)

## 1. 語言與工程行為規範
- **語言**：一律使用台灣習慣的「繁體中文（zh-TW）」與台灣技術用語回覆（如：專案、資料庫、函式、變數），UI 文案、程式碼註解與 Commit 訊息亦同。
- **施工節奏**：嚴格採階段性模組開發（Phase 1 ➔ Phase 2），每完成一個模組須執行 `npm run test` 與 `npm run build` 驗證通過後再進行下一階段。

## 2. 核心技術架構（Local-First 雙軌分流＋零伺服器成本）
- **前端技術棧**：Vue 3 (Composition API) + TypeScript + Vite + Tailwind CSS + Pinia + Dexie.js (IndexedDB) + `vue-i18n` + `zod` + Vitest。
- **PWA 離線優先**：設定 `vite-plugin-pwa`（支援 Web Share Target 分享接收、離線快取、啟動時申請 `navigator.storage.persist()` 防系統清快取）。
- **雙軌儲存與同步引擎**：
  1. **個人三層隱私金庫（100% 本地隔離）**：`ledger_db_normal`（一般明文）、`ledger_db_private`（AES-256-GCM 加密，退背景 30 秒鎖定）、`ledger_db_hidden`（防盤問偽裝入口，支援各自獨立照片 LSB 隱寫救援）。
  2. **協作同步分流（按訂閱方案自動切換）**：
     - **免費版（Free）**：Google Drive 獨立專案 JSON 檔手動觸發同步（比對單筆交易 `UUID` 與 `updatedAt` 時間戳合併）。
     - **訂閱版（Pro）**：串接 Firebase Firestore (`onSnapshot`) 實現 0.2 秒毫秒級即時推播同步，並掛載異常大量刪除熔斷器（單次遠端刪除 >= 5 筆或 >= 10% 自動攔截）。

## 3. 產品與工程鐵律
1. **漸進式揭露（Progressive Disclosure）**：首頁與首次開啟嚴禁要求註冊、綁定雲端或設定密碼；提供「建立旅遊/分帳專案」與「開始極簡日常記帳」雙入口，確保 3 秒內記下第一筆帳。
2. **Schema 版本控管與安檢**：所有資料庫與 JSON 備份強制帶上 `schemaVersion: 1` 並透過 `src/core/migrationEngine.ts` 向下相容；所有外部輸入（雲端、QR Code、URL 參數、備份檔）寫入前必須通過 `Zod` 驗證。
3. **純邏輯與 UI 嚴格分離**：所有帳務計算（雙模式拆帳、Settle Up 債務簡化、卡費防重複、外幣現鈔加權成本）寫於 `src/core/` 純 TypeScript 函式並附帶完整 Vitest 單元測試。
4. **嚴格多國語言（i18n）**：UI 零硬編碼中文字串，所有文案抽離至 `src/locales/{zh-TW,en,ja}.json`，金額強制使用 `Intl.NumberFormat` 格式化。
