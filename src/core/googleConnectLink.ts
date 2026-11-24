import { z } from 'zod'

/**
 * 驗證 Google OAuth Web Client ID 格式（必須為合法的 *.apps.googleusercontent.com）
 */
export const GoogleClientIdSchema = z
  .string()
  .trim()
  .min(12)
  .max(200)
  .regex(
    /^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/,
    'Invalid Google OAuth Client ID',
  )

/**
 * 產生跨裝置快速連線連結（#/connect-google?cid=...），讓手機／電腦免手動貼上 Client ID
 */
export function buildGoogleConnectLink(
  originAndPath: string,
  clientId: string,
): string {
  const validClientId = GoogleClientIdSchema.parse(clientId)
  const cleanBase = originAndPath.split('#')[0].split('?')[0]
  const params = new URLSearchParams({ cid: validClientId })
  return `${cleanBase}#/connect-google?${params.toString()}`
}

/**
 * 解析網址 Hash 中的跨裝置 Google 連線參數，未通過 Zod 驗證則回傳 null
 */
export function parseGoogleConnectHash(hash: string): { clientId: string } | null {
  if (!hash) return null
  const normalized = hash.startsWith('#') ? hash.slice(1) : hash
  const cleanPath = normalized.startsWith('/') ? normalized.slice(1) : normalized
  if (!cleanPath.startsWith('connect-google')) return null

  const queryIndex = cleanPath.indexOf('?')
  if (queryIndex === -1) return null

  const params = new URLSearchParams(cleanPath.slice(queryIndex + 1))
  const rawCid = params.get('cid')
  if (!rawCid) return null

  const parsed = GoogleClientIdSchema.safeParse(rawCid)
  if (!parsed.success) return null

  return { clientId: parsed.data }
}
