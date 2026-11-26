/**
 * 瀏覽器平台專屬檔案下載工具（DOM / Blob / ObjectURL）。
 * 歸屬 `src/platform/`，與 `src/core/` 純邏輯層嚴格分離。
 */

/** 觸發瀏覽器下載文字內容檔案 */
export function triggerTextFileDownload(
  content: string,
  filename: string,
  mimeType: string,
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  const blob = new Blob([content], { type: mimeType })
  triggerBinaryFileDownload(blob, filename, mimeType)
}

/** 觸發瀏覽器下載二進位檔案（如 .xlsx 或 .png） */
export function triggerBinaryFileDownload(
  data: Uint8Array | Blob,
  filename: string,
  mimeType: string,
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data.slice().buffer], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
