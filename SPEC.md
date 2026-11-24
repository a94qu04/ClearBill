# SPEC.md — ClearBill（清帳）Phase 1 實作規格

## 1. 目標檔案清單
- `src/schemas/ledgerSchema.ts`：定義 `Transaction`、`Project`、`MemberSplitInput` 之 TypeScript 型別與 Zod 驗證器。
- `src/core/splitCalculator.ts`：雙模式拆帳計算機（支援 `equal` 全部均攤與 `custom_plus_equal` 指定金額外均攤，含最小幣別單位尾差精準分配）。
- `src/core/settleUpEngine.ts`：多人債務最小化結算演算法（Greedy Debt Simplification）。
- `src/core/quickIntakeParser.ts`：無感自動化入口解析器（解析 iOS 捷徑 URL 參數 `/#/quick-add?amount=...&merchant=...`、Web Share 分享文字與剪貼簿刷卡通知脫敏）。
- `src/core/__tests__/splitCalculator.test.ts`：核心算帳邏輯 Vitest 單元測試。
- `src/components/QuickSplitPanel.vue`：極簡雙頁籤拆帳面板（附動態白話提示與「均攤剩餘」個別勾選框）。

## 2. 核心資料結構 (`src/schemas/ledgerSchema.ts`)
- `Transaction` 必須包含：
  - `id` (UUID), `schemaVersion: 1`, `projectId?`, `vaultLevel` (`'normal' | 'private' | 'hidden'`)
  - `type` (`'expense' | 'income' | 'transfer' | 'card_repayment' | 'refund'`)
  - `amount` (原始幣別金額), `currency` (ISO 4217), `exchangeRateToBase`
  - `categoryKey` (語系無關鍵值，如 `'cat_food'`), `date` (`YYYY-MM-DD`), `time` (`HH:mm`，未指定一律預設 `'00:00'`)
  - `updatedAt` (毫秒時間戳), `isDeleted?`, `note?`, `links?` (1~3 組外部訂單/地圖 URL), `isReimbursable?`
  - `splitConfig?`: `{ payerId: string, mode: 'equal' | 'custom_plus_equal', shares: Array<{ memberId: string, finalAmount: number }> }`

## 3. 核心算法與邊界條件
- **雙模式拆帳 (`calculateSplit`)**：
  - `remainderPool = totalAmount - sum(customAmount)`。
  - 若 `remainderPool < 0`，拋出 `ERR_CUSTOM_EXCEEDS_TOTAL`。
  - 若 `isIncludedInRemainder` 勾選人數為 `0` 且 `remainderPool > 0`，拋出 `ERR_UNALLOCATED_REMAINDER`。
  - 除法尾差依幣別最小精度（`TWD`/`JPY`/`KRW` 為 `1`，其餘為 `0.01`）輪流分配給前 $N$ 位參與均攤者，確保加總 100% 等於 `totalAmount`。
- **iOS 捷徑無感入帳 (`quickIntakeParser`)**：
  - 接收網址參數 `amount`、`merchant`、`sourceApp`、`rawText`，自動抓取金額與商家名稱；若當前有設定「進行中旅遊/分帳專案」，自動歸入該專案並套用預設拆帳規則。

## 4. 驗收標準
- 執行 `npm run test` 所有拆帳、尾差對齊、債務簡化與 URL 參數解析測試 100% 通過。
- 執行 `npm run build` 無任何 TypeScript 型別或打包錯誤。
