// Cheap image analysis used to auto-tune the comic parameters on upload.

export interface ImageStats {
  p05: number // luminance percentiles, 0..1
  p50: number
  p95: number
  mean: number
  contrast: number // luminance std dev, 0..1
  edgeDensity: number // mean gradient magnitude, 0..1
}

export function analyze(bitmap: ImageBitmap): ImageStats {
  const long = 220
  const scale = Math.min(1, long / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data

  const lum = new Float32Array(w * h)
  const hist = new Uint32Array(256)
  let sum = 0
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const l = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255
    lum[i] = l
    sum += l
    hist[Math.min(255, Math.max(0, Math.round(l * 255)))]++
  }
  const mean = sum / lum.length
  let varsum = 0
  for (let i = 0; i < lum.length; i++) { const d = lum[i] - mean; varsum += d * d }
  const contrast = Math.sqrt(varsum / lum.length)

  const pct = (frac: number): number => {
    const target = frac * lum.length
    let acc = 0
    for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= target) return b / 255 }
    return 1
  }

  // edge density: mean Sobel-ish gradient magnitude
  let edgeSum = 0, edgeN = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = lum[i + 1] - lum[i - 1]
      const gy = lum[i + w] - lum[i - w]
      edgeSum += Math.sqrt(gx * gx + gy * gy)
      edgeN++
    }
  }
  const edgeDensity = edgeN ? edgeSum / edgeN : 0

  return { p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), mean, contrast, edgeDensity }
}
