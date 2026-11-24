/**
 * 前端輕量圖片壓縮工具：
 * 將使用者選取或拍攝的收據/消費圖片縮放至合理邊長並轉為 JPEG Data URL，
 * 以便安全儲存於本地 IndexedDB 且維持流暢載入速度。
 */
export async function compressImageFileToDataUrl(
  file: File,
  maxDimension = 960,
  quality = 0.78,
): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('ERR_IMAGE_READ_FAILED'))
    reader.readAsDataURL(file)
  })

  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return rawDataUrl
  }

  return new Promise<string>((resolve) => {
    const img = new Image()
    img.onload = () => {
      const ratio = Math.min(1, maxDimension / Math.max(img.width, img.height))
      const width = Math.max(1, Math.round(img.width * ratio))
      const height = Math.max(1, Math.round(img.height * ratio))

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(rawDataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      try {
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch {
        resolve(rawDataUrl)
      }
    }
    img.onerror = () => resolve(rawDataUrl)
    img.src = rawDataUrl
  })
}
