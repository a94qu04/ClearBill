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

/**
 * 將使用者選取的大頭貼圖片自動做中心正方形裁切並壓縮為輕量 JPEG Data URL（預設 160x160）
 * 單張約 5~12 KB，適合存入 IndexedDB、本地備份與雲端同步。
 */
export async function compressAvatarImageFileToDataUrl(
  file: File,
  size = 160,
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
      const side = Math.min(img.width, img.height)
      const sx = Math.max(0, Math.floor((img.width - side) / 2))
      const sy = Math.max(0, Math.floor((img.height - side) / 2))

      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(rawDataUrl)
        return
      }
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
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

/**
 * 將專案小卡封面照片自動依指定長寬比（預設 16:9、640x360）做中心裁切並壓縮為輕量 JPEG Data URL
 * 單張約 20~45 KB，適合同步至 Google Drive 與 Firestore。
 */
export async function compressCoverImageFileToDataUrl(
  file: File,
  targetWidth = 640,
  targetHeight = 360,
  quality = 0.74,
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
      const targetRatio = targetWidth / targetHeight
      const imgRatio = img.width / img.height
      let sx = 0
      let sy = 0
      let sw = img.width
      let sh = img.height

      if (imgRatio > targetRatio) {
        sw = Math.round(img.height * targetRatio)
        sx = Math.max(0, Math.floor((img.width - sw) / 2))
      } else {
        sh = Math.round(img.width / targetRatio)
        sy = Math.max(0, Math.floor((img.height - sh) / 2))
      }

      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(rawDataUrl)
        return
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight)
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
