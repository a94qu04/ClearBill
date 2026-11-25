import { z } from 'zod'

/** 當前資料庫與 JSON 備份之 Schema 版本 */
export const CURRENT_SCHEMA_VERSION = 1 as const

/** 三層隱私金庫層級 */
export const VaultLevelSchema = z.enum(['normal', 'private', 'hidden'])
export type VaultLevel = z.infer<typeof VaultLevelSchema>

/** 交易類型 */
export const TransactionTypeSchema = z.enum([
  'expense',
  'income',
  'transfer',
  'card_repayment',
  'refund',
])
export type TransactionType = z.infer<typeof TransactionTypeSchema>

/** 拆帳模式：equal（全員均攤）| custom_plus_equal（指定金額外其餘均攤）| weight（份數比例）| percentage（百分比） */
export const SplitModeSchema = z.enum([
  'equal',
  'custom_plus_equal',
  'weight',
  'percentage',
])
export type SplitMode = z.infer<typeof SplitModeSchema>

/** ISO 4217 三碼大寫幣別代碼（如 TWD、JPY、USD、KRW） */
export const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, '幣別必須為 ISO 4217 三位大寫代碼')
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>

/** 日期格式 YYYY-MM-DD */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必須為 YYYY-MM-DD')

/** 時間格式 HH:mm（未指定一律預設 00:00） */
export const Time24hSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間格式必須為 HH:mm')

/** 單一成員拆帳輸入結構（用於 splitCalculator） */
export const MemberSplitInputSchema = z.object({
  memberId: z.string().trim().min(1, '成員 ID 不可為空'),
  customAmount: z.number().finite().min(0, '指定金額不可為負數').default(0),
  isIncludedInRemainder: z.boolean().default(true),
  /** 選填：份數比例模式權重（如 1、2、0.5、0） */
  weight: z.number().finite().min(0, '份數權重不可為負數').optional(),
  /** 選填：百分比模式比例（0 ~ 100） */
  percent: z.number().finite().min(0, '百分比不可為負數').max(100, '百分比不可超過 100').optional(),
})
export type MemberSplitInput = z.input<typeof MemberSplitInputSchema>
export type NormalizedMemberSplitInput = z.output<typeof MemberSplitInputSchema>

/** 單一墊付人實付金額結構（支援多人同時墊付同一筆消費） */
export const SplitPayerSchema = z.object({
  memberId: z.string().trim().min(1, '墊付人 ID 不可為空'),
  amount: z.number().finite().min(0, '墊付金額不可為負數'),
})
export type SplitPayer = z.infer<typeof SplitPayerSchema>

/** 單一成員最終分攤金額（保留選填原始輸入欄位，讓修改帳目可 100% 精準還原） */
export const SplitShareSchema = z.object({
  memberId: z.string().trim().min(1),
  finalAmount: z.number().finite().min(0),
  customAmount: z.number().finite().min(0).optional(),
  isIncludedInRemainder: z.boolean().optional(),
  weight: z.number().finite().min(0).optional(),
  percent: z.number().finite().min(0).max(100).optional(),
})
export type SplitShare = z.infer<typeof SplitShareSchema>

/** 交易內嵌之拆帳結果設定（支援單人 payerId 與多人 payers，完整向下相容） */
export const SplitConfigSchema = z.object({
  payerId: z.string().trim().min(1, '付款人 ID 不可為空'),
  payers: z.array(SplitPayerSchema).min(1).optional(),
  mode: SplitModeSchema,
  shares: z.array(SplitShareSchema).min(1, '拆帳分攤名單不可為空'),
})
export type SplitConfig = z.infer<typeof SplitConfigSchema>

/** 外部訂單或地圖連結（1~3 組有效 HTTP/HTTPS URL） */
export const ExternalLinksSchema = z
  .array(
    z
      .string()
      .trim()
      .url('必須為有效的 URL')
      .refine(
        (url) => url.startsWith('http://') || url.startsWith('https://'),
        '僅允許 http 或 https 連結',
      ),
  )
  .min(1)
  .max(3)

/** 核心交易紀錄結構 */
export const TransactionSchema = z.object({
  id: z.string().uuid('交易 ID 必須為標準 UUID'),
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  projectId: z.string().trim().min(1).optional(),
  vaultLevel: VaultLevelSchema,
  type: TransactionTypeSchema,
  amount: z.number().finite().min(0, '金額不可為負數'),
  currency: CurrencyCodeSchema,
  exchangeRateToBase: z.number().finite().positive('匯率必須大於 0').default(1),
  categoryKey: z.string().trim().min(1, '分類鍵值不可為空'),
  date: IsoDateSchema,
  time: z.preprocess(
    (val) => (val === undefined || val === null || val === '' ? '00:00' : val),
    Time24hSchema,
  ),
  updatedAt: z.number().int().nonnegative(),
  isDeleted: z.boolean().optional(),
  note: z.string().max(1000).optional(),
  links: ExternalLinksSchema.optional(),
  receiptImages: z.array(z.string().min(1)).max(3).optional(),
  isReimbursable: z.boolean().optional(),
  /** 選填：最後新增或編輯此筆帳目之成員名稱（供多人協作稽核對帳） */
  lastEditedBy: z.string().trim().max(50).optional(),
  splitConfig: SplitConfigSchema.optional(),
})
export type Transaction = z.infer<typeof TransactionSchema>

/** 專案成員結構 */
export const ProjectMemberSchema = z.object({
  id: z.string().trim().min(1, '成員 ID 不可為空'),
  name: z.string().trim().min(1, '成員名稱不可為空').max(50),
  avatarColor: z.string().trim().max(32).optional(),
  /** 選填：正方形裁切壓縮後之大頭貼 Data URL（輕量小圖，完全向下相容） */
  avatarImage: z.string().max(180_000).optional(),
  /** 選填：收款帳號或轉帳資訊（如銀行代碼＋帳號、LINE Pay 連結），供結算頁一鍵複製 */
  paymentInfo: z.string().trim().max(120).optional(),
})
export type ProjectMember = z.infer<typeof ProjectMemberSchema>

/** 使用者個人成員檔案（用於預設成員名稱、大頭貼與收款帳號，支援跨裝置同步） */
export const UserProfileSchema = z.object({
  displayName: z.string().trim().max(50).default(''),
  avatarColor: z.string().trim().max(32).default('#10b981'),
  avatarImage: z.string().max(180_000).optional(),
  /** 選填：個人收款帳號或轉帳資訊 */
  paymentInfo: z.string().trim().max(120).optional(),
  updatedAt: z.number().int().nonnegative().optional(),
})
export type UserProfile = z.infer<typeof UserProfileSchema>

/** 專案即時協作同步中繼資訊（未開啟共享時省略，維持 100% 本地） */
export const ProjectSyncMetaSchema = z.object({
  mode: z.enum(['local', 'firestore']).default('local'),
  shareId: z.string().trim().min(8).max(64).optional(),
  accessKey: z.string().trim().min(16).max(128).optional(),
  role: z.enum(['owner', 'editor']).optional(),
  /** 此裝置使用者在該團中認領之成員 ID（用於預設墊付人與視角顯示） */
  myMemberId: z.string().trim().min(1).optional(),
  /** 是否一併同步收據圖片至雲端（單筆圖片過大時會自動降級僅同步文字） */
  syncReceiptImages: z.boolean().optional(),
  lastSyncedAt: z.number().int().nonnegative().optional(),
})
export type ProjectSyncMeta = z.infer<typeof ProjectSyncMetaSchema>

/** 旅遊 / 分帳專案結構 */
export const ProjectSchema = z.object({
  id: z.string().uuid('專案 ID 必須為標準 UUID'),
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  name: z.string().trim().min(1, '專案名稱不可為空').max(100),
  baseCurrency: CurrencyCodeSchema.default('TWD'),
  members: z.array(ProjectMemberSchema).min(1, '專案至少須包含一位成員'),
  defaultSplitMode: SplitModeSchema.default('equal'),
  defaultPayerId: z.string().trim().min(1).optional(),
  isActive: z.boolean().default(true),
  isArchived: z.boolean().optional(),
  /** 選填：專案小卡自訂背景色（Hex 色碼） */
  cardColor: z.string().trim().max(32).optional(),
  /** 選填：專案小卡自訂封面照片（16:9 輕量壓縮 Data URL） */
  cardCoverImage: z.string().max(280_000).optional(),
  /** 選填：結算頁面自行設定之結帳幣別（未設定時預設等同記帳主幣別 baseCurrency） */
  settlementCurrency: CurrencyCodeSchema.optional(),
  /** 選填：結算金額使用之匯率模式（per_tx=各筆原匯率 | live=統一套用即時匯率 | custom=統一自訂結算匯率） */
  settlementRateMode: z.enum(['per_tx', 'live', 'custom']).optional(),
  /** 選填：當 settlementRateMode 為 custom 時，各幣別折合結帳幣別之自訂結算匯率 */
  settlementCustomRates: z.record(z.string(), z.number().finite().positive()).optional(),
  syncMeta: ProjectSyncMetaSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  isDeleted: z.boolean().optional(),
})
export type Project = z.infer<typeof ProjectSchema>

/** 共享專案邀請連結參數驗證結構 */
export const ShareInviteParamsSchema = z.object({
  shareId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, '無效的共享專案代碼'),
  accessKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,128}$/, '無效的共享存取金鑰'),
})
export type ShareInviteParams = z.infer<typeof ShareInviteParamsSchema>

/** Firebase Web App 設定驗證結構 */
export const FirebaseWebConfigSchema = z.object({
  apiKey: z.string().trim().min(10),
  authDomain: z.string().trim().min(3),
  projectId: z.string().trim().min(2),
  storageBucket: z.string().trim().optional(),
  messagingSenderId: z.string().trim().optional(),
  appId: z.string().trim().min(5),
})
export type FirebaseWebConfig = z.infer<typeof FirebaseWebConfigSchema>

/** 自訂消費分類結構 */
export const CustomCategorySchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(32),
  color: z.string().trim().max(32).optional(),
})
export type CustomCategory = z.infer<typeof CustomCategorySchema>

/** 備份與同步用之分類管理項目結構（供跨裝置同步自訂分類名稱與色標） */
export const ManagedCategoryBackupSchema = z.object({
  key: z.string().trim().min(1).max(64),
  customLabel: z.string().trim().min(1).max(32).optional(),
  color: z.string().trim().min(1).max(32),
  isBuiltin: z.boolean().optional(),
})
export type ManagedCategoryBackup = z.infer<typeof ManagedCategoryBackupSchema>

/** 外部快速入帳（iOS 捷徑 / Web Share / 剪貼簿）輸入驗證結構 */
export const QuickIntakeParamsSchema = z.object({
  amount: z.union([z.string(), z.number()]).optional(),
  merchant: z.string().max(200).optional(),
  sourceApp: z.string().max(80).optional(),
  rawText: z.string().max(4000).optional(),
  currency: z.string().max(10).optional(),
  sourceUrl: z.string().max(1000).optional(),
  categoryKey: z.string().max(64).optional(),
  date: z.string().max(32).optional(),
  time: z.string().max(16).optional(),
})
export type QuickIntakeParams = z.infer<typeof QuickIntakeParamsSchema>

/** 完整備份與同步封包結構（categories、userProfile、projectOrder 為選填，完整向下相容舊版備份檔） */
export const LedgerBackupSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  exportedAt: z.number().int().nonnegative(),
  projects: z.array(ProjectSchema),
  transactions: z.array(TransactionSchema),
  categories: z.array(ManagedCategoryBackupSchema).optional(),
  userProfile: UserProfileSchema.optional(),
  projectOrder: z.array(z.string().trim().min(1)).optional(),
  projectOrderUpdatedAt: z.number().int().nonnegative().optional(),
})
export type LedgerBackup = z.infer<typeof LedgerBackupSchema>
