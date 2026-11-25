# ClearBill（清帳）— 專案開發總綱 (Antigravity 專用)

## 1. 產品定位與語言工程規範
- **產品定位**：Local-First、免註冊即可開團的「旅遊與多人協作分帳清帳 PWA 工具」。聚焦旅遊與群組共同消費、多幣別匯率核算、大團結算與一鍵報表分享。
- **語言規範**：一律使用台灣習慣的「繁體中文（zh-TW）」與台灣技術用語回覆（如：專案、資料庫、函式、變數），UI 文案、程式碼註解與 Commit 訊息亦同。
- **施工節奏**：採階段性模組開發，每完成一階段修改須執行 `npm run test` 與 `npm run build` 驗證通過後再進行下一階段。

## 2. 核心技術架構（Local-First 雙軌同步＋零伺服器維運成本）
- **前端技術棧**：Vue 3 (Composition API) + TypeScript + Vite + Tailwind CSS + Pinia + Dexie.js (IndexedDB) + `vue-i18n` + `zod` + Vitest。
- **PWA 離線優先**：設定 `vite-plugin-pwa`（支援 Web Share Target 與 `#/quick-add` 分享接收、離線快取、啟動時申請 `navigator.storage.persist()` 降低系統清快取風險，並偵測 LINE/FB/IG 內建瀏覽器提醒）。
- **本機優先儲存與雙軌雲端同步**：
  1. **本機 IndexedDB（`normalVaultDb.ts`）**：所有專案、消費／退款／還款交易、收據壓縮圖片與離線同步 Outbox 全數優先寫入本機，無網路時仍可完整記帳與結算。
  2. **跨裝置個人備份（Google Drive）**：透過 `drive.file` 最小權限將帳本同步至個人 Google Drive（`clearbill-backup-v1.json`），採單筆交易 `UUID` 與 `updatedAt` 時間戳無損合併，並支援離線 JSON 匯出／匯入與跨裝置快速配對連結（`#/connect-google`）。
  3. **多人即時協作（Firebase Firestore）**：透過匿名登入與邀請金鑰連結（`#/join`）實現免註冊即時推播同步（`onSnapshot`），掛載離線 Outbox 補傳與**異常大量刪除熔斷器**（單次遠端刪除 >= 5 筆或 >= 10% 自動攔截並要求人工確認）。

## 3. 旅遊與大團分帳核心能力
1. **四模式拆帳與多人墊付**：支援「均攤／指定金額外均攤／份數比例／百分比」與單人／多人共同墊付，內建安全四則運算式與可反悔服務費／刷卡手續費加成。
2. **大團實戰工具**：支援常用拆帳子群組、公費袋（虛擬公積金與批次收款／批次撤銷）、集中收付（財務長窗口）與最少轉帳債務簡化（Greedy Debt Simplification）。
3. **雙層多幣別與獨立結算視角**：每筆交易永久保留原幣別與原始記帳匯率；支援現金價／刷卡價快捷匯率與每小時即時參考匯率；結算頁之「結帳幣別／各筆原匯率／即時匯率／自訂結算匯率」保存於本機裝置視角，避免多人同時對帳互相覆寫。
4. **跨平台報表與對帳輸出**：支援 LINE 群組文字結算摘要、單一成員專屬對帳單、雙工作表標準 Excel（`.xlsx`）與自動降 DPR 防爆長截圖報表（PNG），且公費袋與真人成員分區呈現。

## 4. 產品與工程鐵律
1. **漸進式揭露（Progressive Disclosure）**：首次開啟嚴禁要求註冊、綁定雲端或設定密碼；首頁直接提供「建立第一個分帳專案」與「載入範例旅遊帳本」入口，讓新使用者立即上手。
2. **Schema 版本控管與安檢**：所有資料庫與 JSON 備份強制帶上 `schemaVersion: 1` 並透過 `src/core/migrationEngine.ts` 向下相容；所有外部輸入（雲端、邀請連結、URL 參數、備份檔）寫入前必須通過 `Zod` 驗證。
3. **純邏輯與 UI 嚴格分離**：所有帳務與報表演算法（四模式拆帳、Settle Up 債務簡化與集中收付、跨幣別匯率套用、算式求值、備份合併、Excel 與長圖產製）寫於 `src/core/` 純 TypeScript 函式並附帶完整 Vitest 單元測試。
4. **嚴格多國語言（i18n）與無障礙基礎**：UI 零硬編碼中文字串，所有文案抽離至 `src/locales/{zh-TW,en,ja}.json` 並通過三語系編譯健檢，金額強制使用 `Intl.NumberFormat` 格式化；所有彈窗統一由 `useModalLayer` 管理層級 Escape、Body Scroll Lock 與 Focus Trap。
