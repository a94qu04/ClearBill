import {
  FirebaseWebConfigSchema,
  type FirebaseWebConfig,
  type Project,
  type Transaction,
} from '@/schemas/ledgerSchema'
import { migrateProject, migrateTransaction } from '@/core/migrationEngine'
import {
  generateSecureToken,
  prepareTransactionForCloud,
  sanitizeProjectForCloud,
} from '@/core/realtimeSyncEngine'

const CUSTOM_FIREBASE_CONFIG_KEY = 'clearbill_firebase_config_v1'
const FIREBASE_APP_NAME = 'clearbill-realtime-sync'

export type FirestoreSyncErrorCode =
  | 'ERR_FIREBASE_NOT_CONFIGURED'
  | 'ERR_INVALID_FIREBASE_CONFIG'
  | 'ERR_AUTH_FAILED'
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_PROJECT_NOT_FOUND'
  | 'ERR_OFFLINE'
  | 'ERR_SYNC_FAILED'

export class FirestoreSyncError extends Error {
  public readonly code: FirestoreSyncErrorCode

  constructor(code: FirestoreSyncErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'FirestoreSyncError'
    this.code = code
  }
}

/** 遞迴移除物件中的 undefined 欄位（Firestore 不允許寫入 undefined） */
function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v)
      }
    }
    return out as T
  }
  return value
}

export function getBuiltInFirebaseConfig(): FirebaseWebConfig | null {
  if (typeof import.meta === 'undefined' || !import.meta.env) return null
  const candidate = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || undefined,
    messagingSenderId:
      import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || undefined,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  }
  const parsed = FirebaseWebConfigSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

export function hasBuiltInFirebaseConfig(): boolean {
  return getBuiltInFirebaseConfig() !== null
}

export function getCustomFirebaseConfig(): FirebaseWebConfig | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CUSTOM_FIREBASE_CONFIG_KEY)
    if (!raw) return null
    const parsed = FirebaseWebConfigSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function getEffectiveFirebaseConfig(): FirebaseWebConfig | null {
  return getCustomFirebaseConfig() ?? getBuiltInFirebaseConfig()
}

export function isFirebaseConfigured(): boolean {
  return getEffectiveFirebaseConfig() !== null
}

/**
 * 解析並儲存使用者貼上之 Firebase Web Config（支援標準 JSON 或 Firebase Console 物件字面值片段）
 */
export function parseAndSaveCustomFirebaseConfig(rawInput: string): FirebaseWebConfig {
  const trimmed = rawInput.trim()
  if (!trimmed) {
    throw new FirestoreSyncError('ERR_INVALID_FIREBASE_CONFIG')
  }

  // 擷取第一個 { ... } 區塊，相容直接從 Firebase Console 複製 const firebaseConfig = { ... };
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  const block = start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed

  // 將常見 JS 物件字面值轉為標準 JSON（單引號、未加引號之 key、尾隨逗號）
  const jsonLike = block
    .replace(/\/\/[^\n]*/g, '')
    .replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'([^']*)'/g, '"$1"')
    .replace(/,\s*}/g, '}')

  let parsedObj: unknown
  try {
    parsedObj = JSON.parse(jsonLike)
  } catch {
    throw new FirestoreSyncError('ERR_INVALID_FIREBASE_CONFIG')
  }

  const validated = FirebaseWebConfigSchema.safeParse(parsedObj)
  if (!validated.success) {
    throw new FirestoreSyncError('ERR_INVALID_FIREBASE_CONFIG')
  }

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        CUSTOM_FIREBASE_CONFIG_KEY,
        JSON.stringify(validated.data),
      )
    } catch {
      // 忽略受限環境
    }
  }

  cachedConfigFingerprint = ''
  return validated.data
}

export function clearCustomFirebaseConfig(): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(CUSTOM_FIREBASE_CONFIG_KEY)
    } catch {
      // 忽略
    }
  }
  cachedConfigFingerprint = ''
}

// ==================== 動態懶載入 Firebase SDK 實例管理 ====================
let cachedConfigFingerprint = ''
let cachedModulesPromise: Promise<{
  appModule: typeof import('firebase/app')
  authModule: typeof import('firebase/auth')
  firestoreModule: typeof import('firebase/firestore')
}> | null = null

async function loadFirebaseModules() {
  if (!cachedModulesPromise) {
    cachedModulesPromise = Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]).then(([appModule, authModule, firestoreModule]) => ({
      appModule,
      authModule,
      firestoreModule,
    }))
  }
  return cachedModulesPromise
}

async function getFirebaseContext() {
  const config = getEffectiveFirebaseConfig()
  if (!config) {
    throw new FirestoreSyncError('ERR_FIREBASE_NOT_CONFIGURED')
  }

  const { appModule, authModule, firestoreModule } = await loadFirebaseModules()
  const fingerprint = `${config.projectId}:${config.apiKey}:${config.appId}`

  let app = appModule
    .getApps()
    .find((existing) => existing.name === FIREBASE_APP_NAME)

  if (app && cachedConfigFingerprint && cachedConfigFingerprint !== fingerprint) {
    await appModule.deleteApp(app)
    app = undefined
  }

  if (!app) {
    app = appModule.initializeApp(config, FIREBASE_APP_NAME)
  }
  cachedConfigFingerprint = fingerprint

  const auth = authModule.getAuth(app)
  const db = firestoreModule.getFirestore(app)

  let uid = auth.currentUser?.uid
  if (!uid) {
    try {
      const cred = await authModule.signInAnonymously(auth)
      uid = cred.user.uid
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      throw new FirestoreSyncError('ERR_AUTH_FAILED', msg)
    }
  }

  return { app, auth, db, uid, firestoreModule }
}

function mapFirebaseError(err: unknown): FirestoreSyncError {
  if (err instanceof FirestoreSyncError) return err
  const rawCode =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : ''
  const rawMsg = err instanceof Error ? err.message : ''

  if (rawCode.includes('permission-denied')) {
    return new FirestoreSyncError('ERR_PERMISSION_DENIED', rawMsg)
  }
  if (rawCode.includes('not-found')) {
    return new FirestoreSyncError('ERR_PROJECT_NOT_FOUND', rawMsg)
  }
  if (rawCode.includes('unavailable') || rawMsg.toLowerCase().includes('offline')) {
    return new FirestoreSyncError('ERR_OFFLINE', rawMsg)
  }
  return new FirestoreSyncError('ERR_SYNC_FAILED', rawMsg)
}

/**
 * 將本地專案升級為 Firestore 多人即時共享專案，上傳專案本體與所有既有明細
 */
export async function publishProjectToFirestore(
  project: Project,
  projectTransactions: Transaction[],
  syncReceiptImages = true,
): Promise<{
  shareId: string
  accessKey: string
  uid: string
  syncedAt: number
  omittedImageTxCount: number
}> {
  try {
    const { db, uid, firestoreModule } = await getFirebaseContext()
    const { doc, setDoc, writeBatch } = firestoreModule

    const shareId = generateSecureToken(16)
    const accessKey = generateSecureToken(24)
    const syncedAt = Date.now()
    const cloudProject = stripUndefinedDeep(sanitizeProjectForCloud(project))

    const projectRef = doc(db, 'shared_projects', shareId)
    await setDoc(projectRef, {
      ownerUid: uid,
      memberUids: [uid],
      accessKey,
      project: cloudProject,
      updatedAt: project.updatedAt,
      createdAt: syncedAt,
    })

    // 分批上傳既有交易（每批 350 筆，安全低於 Firestore 500 筆上限）
    let omittedImageTxCount = 0
    const CHUNK_SIZE = 350
    for (let i = 0; i < projectTransactions.length; i += CHUNK_SIZE) {
      const slice = projectTransactions.slice(i, i + CHUNK_SIZE)
      const batch = writeBatch(db)
      for (const tx of slice) {
        const prepared = prepareTransactionForCloud(tx, syncReceiptImages)
        if (prepared.imagesOmitted) omittedImageTxCount += 1
        const txRef = doc(db, 'shared_projects', shareId, 'transactions', tx.id)
        batch.set(txRef, stripUndefinedDeep(prepared.payload))
      }
      await batch.commit()
    }

    return {
      shareId,
      accessKey,
      uid,
      syncedAt,
      omittedImageTxCount,
    }
  } catch (err) {
    throw mapFirebaseError(err)
  }
}

/**
 * 旅伴透過邀請連結（shareId + accessKey）加入共享專案並拉取完整初始資料
 */
export async function joinSharedProjectOnFirestore(
  shareId: string,
  accessKey: string,
): Promise<{
  project: Project
  transactions: Transaction[]
  uid: string
}> {
  try {
    const { db, uid, firestoreModule } = await getFirebaseContext()
    const { arrayUnion, collection, doc, getDoc, getDocs, updateDoc } =
      firestoreModule

    const projectRef = doc(db, 'shared_projects', shareId)

    // 先透過帶入 accessKey 將自己的匿名 UID 加入 memberUids（金鑰不符會被 Firestore Rules 直接拒絕）
    await updateDoc(projectRef, {
      accessKey,
      memberUids: arrayUnion(uid),
    })

    const projSnap = await getDoc(projectRef)
    if (!projSnap.exists()) {
      throw new FirestoreSyncError('ERR_PROJECT_NOT_FOUND')
    }

    const rawDoc = projSnap.data() as { project?: unknown }
    const validatedProject = migrateProject(rawDoc.project)

    const txSnap = await getDocs(
      collection(db, 'shared_projects', shareId, 'transactions'),
    )
    const validatedTransactions: Transaction[] = []
    txSnap.forEach((docSnap) => {
      try {
        validatedTransactions.push(migrateTransaction(docSnap.data()))
      } catch {
        // 略過不符合 Zod 規格之異常文件
      }
    })

    return {
      project: validatedProject,
      transactions: validatedTransactions,
      uid,
    }
  } catch (err) {
    throw mapFirebaseError(err)
  }
}

/**
 * 團主重設共享專案的存取金鑰（舊邀請連結立即失效，不影響既有已加入旅伴同步）
 */
export async function rotateProjectAccessKeyOnFirestore(
  shareId: string,
): Promise<string> {
  try {
    const { db, firestoreModule } = await getFirebaseContext()
    const { doc, updateDoc } = firestoreModule
    const nextAccessKey = generateSecureToken(24)
    const projectRef = doc(db, 'shared_projects', shareId)
    await updateDoc(projectRef, {
      accessKey: nextAccessKey,
    })
    return nextAccessKey
  } catch (err) {
    throw mapFirebaseError(err)
  }
}

/**
 * 推送單一共享專案之設定／成員變更至 Firestore
 */
export async function pushProjectUpdateToFirestore(
  shareId: string,
  project: Project,
): Promise<void> {
  try {
    const { db, firestoreModule } = await getFirebaseContext()
    const { doc, updateDoc } = firestoreModule
    const projectRef = doc(db, 'shared_projects', shareId)
    await updateDoc(projectRef, {
      project: stripUndefinedDeep(sanitizeProjectForCloud(project)),
      updatedAt: project.updatedAt,
    })
  } catch (err) {
    throw mapFirebaseError(err)
  }
}

/**
 * 推送單筆交易新增／修改／軟刪除至 Firestore
 */
export async function pushTransactionToFirestore(
  shareId: string,
  tx: Transaction,
  syncReceiptImages = true,
): Promise<{ imagesOmitted: boolean }> {
  try {
    const { db, firestoreModule } = await getFirebaseContext()
    const { doc, setDoc } = firestoreModule
    const prepared = prepareTransactionForCloud(tx, syncReceiptImages)
    const txRef = doc(db, 'shared_projects', shareId, 'transactions', tx.id)
    await setDoc(txRef, stripUndefinedDeep(prepared.payload))
    return { imagesOmitted: prepared.imagesOmitted }
  } catch (err) {
    throw mapFirebaseError(err)
  }
}

export interface SharedProjectSubscriptionCallbacks {
  onProjectChange: (remoteProject: Project) => void
  onTransactionsBatch: (remoteTransactions: Transaction[]) => void
  onError: (err: FirestoreSyncError) => void
}

/**
 * 對已共享專案掛載 Firestore onSnapshot 即時雙向推播監聽（0.2 秒毫秒級同步）
 */
export async function subscribeSharedProject(
  shareId: string,
  callbacks: SharedProjectSubscriptionCallbacks,
): Promise<() => void> {
  try {
    const { db, firestoreModule } = await getFirebaseContext()
    const { collection, doc, onSnapshot } = firestoreModule

    const projectRef = doc(db, 'shared_projects', shareId)
    const unsubProject = onSnapshot(
      projectRef,
      (snap) => {
        if (!snap.exists()) return
        try {
          const data = snap.data() as { project?: unknown }
          if (data.project) {
            const validated = migrateProject(data.project)
            callbacks.onProjectChange(validated)
          }
        } catch {
          // 忽略非法遠端結構
        }
      },
      (err) => callbacks.onError(mapFirebaseError(err)),
    )

    const txColRef = collection(db, 'shared_projects', shareId, 'transactions')
    const unsubTxs = onSnapshot(
      txColRef,
      (querySnap) => {
        const remoteTxs: Transaction[] = []
        querySnap.docChanges().forEach((change) => {
          if (change.type === 'removed') return
          try {
            remoteTxs.push(migrateTransaction(change.doc.data()))
          } catch {
            // 忽略未通過 Zod 安檢之資料
          }
        })
        if (remoteTxs.length > 0) {
          callbacks.onTransactionsBatch(remoteTxs)
        }
      },
      (err) => callbacks.onError(mapFirebaseError(err)),
    )

    return () => {
      unsubProject()
      unsubTxs()
    }
  } catch (err) {
    throw mapFirebaseError(err)
  }
}
