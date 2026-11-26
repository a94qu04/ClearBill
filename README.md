# ClearBill（清帳）

**Local-First、免註冊即可開團的旅遊與多人協作分帳清帳 PWA 工具。**  
專為旅遊團與群組共同消費打造，支援四模式拆帳、多人共同墊付、公費袋、雙層多幣別匯率結算、最少轉帳債務簡化、跨裝置 Google Drive 個人備份與 Firebase Firestore 免註冊即時協作。

---

## 核心特色

- **離線優先（Local-First PWA）**：所有資料與收據圖片優先寫入本機 IndexedDB（Dexie.js），無網路亦可完整記帳與結算；首次開啟免註冊，立即建立專案或載入範例旅遊帳本。
- **四模式拆帳與大團實戰**：支援均攤、指定金額外均攤、份數比例、百分比、多人共同墊付、常用拆帳子群組、公費袋批次收款／撤銷、安全四則運算式與可反悔服務費／刷卡手續費加成。
- **多幣別與本機獨立結算視角**：每筆交易永久保留原幣別與記帳匯率；結算頁之「結帳幣別／各筆原匯率／即時匯率／自訂結算匯率」保存於本機裝置視角，避免多人同時對帳互相覆寫。
- **雙軌雲端同步與防護**：
  - **Google Drive 個人備份**：最小 `drive.file` 權限，採 `UUID + updatedAt` 無損合併，隔離裝置私有欄位（`syncMeta`、`isArchived`、`defaultPayerId`）。
  - **Firebase Firestore 多人即時協作**：匿名登入＋邀請金鑰連結（`#/join`）即時推播，內建離線 Outbox 條件補傳與異常大量刪除熔斷器。
- **跨平台對帳輸出**：支援 LINE 群組文字結算摘要、單一成員專屬對帳單、雙工作表標準 Excel（`.xlsx`）與自動降 DPR 長截圖報表（PNG）。
- **三語系完整支援**：`zh-TW`（繁體中文）、`en`（English）、`ja`（日本語），零硬編碼 UI 文案。

---

## 技術棧

- **前端框架**：Vue 3（Composition API）+ TypeScript（`strict: true`）+ Vite 6 + Tailwind CSS
- **狀態與儲存**：Pinia + Dexie.js（IndexedDB）+ Zod（全面 Schema 驗證）
- **多語系與圖示**：`vue-i18n` + `lucide-vue-next`
- **PWA 與測試**：`vite-plugin-pwa` + Vitest

---

## 快速開始

```bash
# 安裝依賴
npm install

# 啟動本機開發伺服器
npm run dev

# 執行全部單元測試（Vitest）
npm run test

# 監聽模式執行單元測試
npm run test:watch

# 型別檢查與正式版建置（vue-tsc --noEmit && vite build）
npm run build

# 預覽正式版建置成果
npm run preview
```

### 選填環境變數（`.env.local`）

未設定環境變數時，本機記帳與離線 JSON 備份仍可 100% 正常使用；若需啟用內建雲端同步預設值，可於 `.env.local` 設定：

- `VITE_GOOGLE_CLIENT_ID`：Google OAuth 2.0 Web Client ID（Google Drive 個人備份用，亦可於設定頁手動輸入或透過 `#/connect-google` 配對連結導入）。
- `VITE_FIREBASE_*`：Firebase Web App 設定（Firestore 即時協作用，亦可於共享彈窗中貼入自訂 JSON 設定）。

---

## 目錄與分層架構

詳細的檔案職責、行數與資料流請參閱 [PROJECT_MAP.md](./PROJECT_MAP.md) 與 [REFACTOR_PLAN.md](./REFACTOR_PLAN.md)。

```text
src/
├── core/          # 純 TypeScript 商業邏輯與帳務演算法（零 DOM／瀏覽器 API 依賴，附單元測試）
├── platform/      # 瀏覽器平台專屬工具（DOM 檔案下載、Canvas 圖片壓縮與長截圖報表產生）
├── schemas/       # Zod Schema 與容錯解析（ledgerSchema、userPrefsSchema，強制 schemaVersion）
├── db/            # Dexie.js IndexedDB 封裝（寫入前 Zod 驗證、Outbox 原子條件刪除）
├── services/      # 外部整合服務（Google Drive OAuth/API、Firestore 即時同步、即時匯率）
├── stores/        # Pinia 領域 Store（ledgerStore 門面組合 6 個領域子 Store／動作模組）
├── composables/   # 可重用 Vue 組合式函式（彈窗層級、剪貼簿／分享、Hash 路由、PWA 生命週期、篩選與匯出）
├── views/         # 頂層頁面視圖（HomeView、ProjectCreateView、ProjectView）
├── components/    # UI 元件（含 settle/、settings/、split/ 子目錄）
└── locales/       # 三語系文案（zh-TW.json、en.json、ja.json）
```

### 分層設計鐵律

1. **單向依賴**：`core/` 不引用 `stores/`、`services/` 或瀏覽器 DOM；UI 元件與 Composable 統一透過 `ledgerStore` 操作狀態與外部服務，不直連 `services/`。
2. **帳務不變式**：拆帳守恆（`core/splitInvariant.ts`）、成員分攤／墊付口徑（`core/memberLedger.ts`）、雙向結算匯率互為倒數（`core/settlementRateResolver.ts`）與公費袋分區（`core/poolFund.ts`）皆為單一真相來源並受單元測試保護。
3. **驗證與健檢**：任何修改完成後請執行 `npm run test && npm run build` 確認帳務測試、三語系編譯健檢、Store 測試與 TypeScript 嚴格檢查全數通過。
