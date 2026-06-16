import { ComicInput, ComicTimings, StructureParams } from '../types'

// ---------------------------------------------------------------------------
// Comic engine: photo -> (tone field, ink field).
//
//   1. luminance              sRGB -> linear-ish perceptual grey
//   2. edge-preserving smooth  separable bilateral, iterated (flat cel regions)
//   3. tone map + posterize    black/white point + gamma, quantize to N bands
//   4. XDoG-style ink lines     difference-of-Gaussians, adaptive threshold, dilate
//   5. hand-drawn wobble        low-frequency value-noise warp of both fields
//
// Output fields are returned at working resolution; the renderer colours the tone
// field through a duotone gradient and composites the ink on top, so palette and
// texture changes never need a recompute.
// ---------------------------------------------------------------------------

const now = () => (typeof performance !== 'undefined' ? performance.now() : 0)

function luminance(img: ComicInput): Float32Array {
  const { data, width, height } = img
  const out = new Float32Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Rec.601-ish luma in 0..1. Source is already composited on white upstream.
    out[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255
  }
  return out
}

// One separable bilateral pass (horizontal then vertical). True bilateral isn't separable,
// but the cross pass is a well-known fast approximation that's more than good enough for
// flattening photo detail into paintable cel regions. `sr` is the range sigma (tone), `radius`
// the spatial reach.
function bilateralPass(src: Float32Array, w: number, h: number, radius: number, sr: number): Float32Array {
  const s3 = 1 / (2 * sr * sr)
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  // spatial weights
  const sw = new Float32Array(radius + 1)
  const ss = 1 / (2 * (radius * 0.6 + 0.5) * (radius * 0.6 + 0.5))
  for (let d = 0; d <= radius; d++) sw[d] = Math.exp(-(d * d) * ss)

  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const c = src[row + x]
      let acc = c, wsum = 1
      for (let d = 1; d <= radius; d++) {
        const xl = x - d >= 0 ? x - d : 0
        const xr = x + d < w ? x + d : w - 1
        const sl = src[row + xl], srr = src[row + xr]
        const wl = sw[d] * Math.exp(-((sl - c) * (sl - c)) * s3)
        const wr = sw[d] * Math.exp(-((srr - c) * (srr - c)) * s3)
        acc += sl * wl + srr * wr
        wsum += wl + wr
      }
      tmp[row + x] = acc / wsum
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const c = tmp[y * w + x]
      let acc = c, wsum = 1
      for (let d = 1; d <= radius; d++) {
        const yt = y - d >= 0 ? y - d : 0
        const yb = y + d < h ? y + d : h - 1
        const st = tmp[yt * w + x], sb = tmp[yb * w + x]
        const wt = sw[d] * Math.exp(-((st - c) * (st - c)) * s3)
        const wb = sw[d] * Math.exp(-((sb - c) * (sb - c)) * s3)
        acc += st * wt + sb * wb
        wsum += wt + wb
      }
      out[y * w + x] = acc / wsum
    }
  }
  return out
}

// Separable Gaussian blur (used by the DoG ink layer).
function gaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.35) return src.slice()
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(radius + 1)
  const s2 = 1 / (2 * sigma * sigma)
  let norm = 0
  for (let d = 0; d <= radius; d++) { k[d] = Math.exp(-(d * d) * s2); norm += d === 0 ? k[d] : 2 * k[d] }
  for (let d = 0; d <= radius; d++) k[d] /= norm
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let acc = src[row + x] * k[0]
      for (let d = 1; d <= radius; d++) {
        const xl = x - d >= 0 ? x - d : 0
        const xr = x + d < w ? x + d : w - 1
        acc += (src[row + xl] + src[row + xr]) * k[d]
      }
      tmp[row + x] = acc
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = tmp[y * w + x] * k[0]
      for (let d = 1; d <= radius; d++) {
        const yt = y - d >= 0 ? y - d : 0
        const yb = y + d < h ? y + d : h - 1
        acc += (tmp[yt * w + x] + tmp[yb * w + x]) * k[d]
      }
      out[y * w + x] = acc
    }
  }
  return out
}

// Cheap, deterministic 2D value noise with bilinear interpolation, summed over two octaves.
// Used for the hand-drawn line wobble warp. Seeded so results are stable across renders.
function makeNoise(seed: number) {
  const hash = (x: number, y: number) => {
    let n = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
    n = (n ^ (n >> 13)) * 1274126177
    n = n ^ (n >> 16)
    return (n & 0x7fffffff) / 0x7fffffff
  }
  const smooth = (gx: number, gy: number, fx: number, fy: number) => {
    const x0 = Math.floor(gx), y0 = Math.floor(gy)
    const tx = gx - x0, ty = gy - y0
    const a = hash(x0, y0), b = hash(x0 + 1, y0)
    const c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1)
    const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty)
    const top = a + (b - a) * u
    const bot = c + (d - c) * u
    void fx; void fy
    return top + (bot - top) * v
  }
  return (x: number, y: number, scale: number) => {
    const gx = x / scale, gy = y / scale
    return smooth(gx, gy, 0, 0) * 0.65 + smooth(gx * 2.3, gy * 2.3, 0, 0) * 0.35
  }
}

// Warp two fields by the same low-frequency vector field (bilinear sampling). Keeps lines and
// cell edges wobbling together so the result reads as one hand-drawn pass, not two layers.
function warp(tone: Float32Array, ink: Float32Array, w: number, h: number, amount: number) {
  if (amount <= 0.001) return { tone, ink }
  const nx = makeNoise(11), ny = makeNoise(29)
  const scale = Math.max(8, Math.min(w, h) / 14) // coarse swells
  const amp = amount * Math.min(w, h) * 0.012
  const ot = new Float32Array(w * h)
  const oi = new Float32Array(w * h)
  const sample = (f: Float32Array, sx: number, sy: number) => {
    if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1
    if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1
    const x0 = Math.floor(sx), y0 = Math.floor(sy)
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0
    const tx = sx - x0, ty = sy - y0
    const a = f[y0 * w + x0], b = f[y0 * w + x1], c = f[y1 * w + x0], d = f[y1 * w + x1]
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (nx(x, y, scale) - 0.5) * 2 * amp
      const dy = (ny(x, y, scale) - 0.5) * 2 * amp
      const i = y * w + x
      ot[i] = sample(tone, x + dx, y + dy)
      oi[i] = sample(ink, x + dx, y + dy)
    }
  }
  return { tone: ot, ink: oi }
}

export function computeComic(img: ComicInput, p: StructureParams): {
  w: number; h: number; tone: Uint8Array; ink: Uint8Array; timings: ComicTimings
} {
  const w = img.width, h = img.height
  const t0 = now()
  const lum = luminance(img)

  // --- 1. edge-preserving smoothing -> flat cel regions ---
  const radius = 2 + Math.round(p.smoothing * 4) // 2..6
  const iterations = 1 + Math.round(p.smoothing * 2) // 1..3
  const sr = 0.16 - p.smoothing * 0.06 // tighter range sigma => flatter regions
  let sm = lum
  for (let it = 0; it < iterations; it++) sm = bilateralPass(sm, w, h, radius, sr)

  // --- 2. tone map + posterize into cel bands ---
  const bp = p.blackPoint, hc = p.highlightClip
  const span = Math.max(1e-3, hc - bp)
  const invGamma = 1 / Math.max(0.05, p.gamma)
  const levels = Math.max(2, Math.round(p.toneLevels))
  const tone = new Uint8Array(w * h)
  for (let i = 0; i < sm.length; i++) {
    let v = (sm[i] - bp) / span
    v = v < 0 ? 0 : v > 1 ? 1 : v
    v = Math.pow(v, invGamma)
    // quantize to `levels` steps, snap to band centres for even cel spacing
    const band = Math.min(levels - 1, Math.floor(v * levels))
    const q = levels > 1 ? band / (levels - 1) : v
    tone[i] = Math.round(q * 255)
  }
  const t1 = now()

  // --- 3. XDoG-style ink lines (adaptive threshold so density is image-independent) ---
  const sigma = 0.6 + p.lineDetail * 2.0 // fine..coarse
  const g1 = gaussian(lum, w, h, sigma)
  const g2 = gaussian(lum, w, h, sigma * 1.6)
  // dark-side DoG response: positive where a pixel is darker than its surround (an ink ridge)
  const resp = new Float32Array(w * h)
  let mean = 0
  for (let i = 0; i < resp.length; i++) {
    const r = g2[i] - g1[i]
    const v = r > 0 ? r : 0
    resp[i] = v
    mean += v
  }
  mean /= resp.length
  let varsum = 0
  for (let i = 0; i < resp.length; i++) { const d = resp[i] - mean; varsum += d * d }
  const std = Math.sqrt(varsum / resp.length) || 1e-4
  // lineStrength raises density by lowering the threshold toward the mean.
  const thr = mean + std * (1.6 - p.lineStrength * 1.5)
  const thrHi = thr + std * 0.9
  const inkBase = new Float32Array(w * h)
  for (let i = 0; i < resp.length; i++) {
    const v = resp[i]
    let a = v <= thr ? 0 : v >= thrHi ? 1 : (v - thr) / (thrHi - thr)
    a = a * a * (3 - 2 * a) // smoothstep
    inkBase[i] = a
  }
  // dilate to widen lines (morphological max over a small radius from lineWidth)
  const dil = Math.max(0, Math.round(p.lineWidth - 0.6))
  let inkF = inkBase
  if (dil > 0) {
    const tmp = new Float32Array(w * h)
    const o2 = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        let m = inkBase[row + x]
        for (let d = 1; d <= dil; d++) {
          const xl = x - d >= 0 ? x - d : 0
          const xr = x + d < w ? x + d : w - 1
          if (inkBase[row + xl] > m) m = inkBase[row + xl]
          if (inkBase[row + xr] > m) m = inkBase[row + xr]
        }
        tmp[row + x] = m
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let m = tmp[y * w + x]
        for (let d = 1; d <= dil; d++) {
          const yt = y - d >= 0 ? y - d : 0
          const yb = y + d < h ? y + d : h - 1
          if (tmp[yt * w + x] > m) m = tmp[yt * w + x]
          if (tmp[yb * w + x] > m) m = tmp[yb * w + x]
        }
        o2[y * w + x] = m
      }
    }
    inkF = o2
  }

  // --- 4. hand-drawn wobble (warp tone + ink together) ---
  const toneF = new Float32Array(w * h)
  for (let i = 0; i < toneF.length; i++) toneF[i] = tone[i] / 255
  const warped = warp(toneF, inkF, w, h, p.wobble)

  const toneOut = new Uint8Array(w * h)
  const inkOut = new Uint8Array(w * h)
  for (let i = 0; i < toneOut.length; i++) {
    toneOut[i] = Math.round(Math.max(0, Math.min(1, warped.tone[i])) * 255)
    inkOut[i] = Math.round(Math.max(0, Math.min(1, warped.ink[i])) * 255)
  }
  const t2 = now()

  return {
    w, h, tone: toneOut, ink: inkOut,
    timings: { smooth: t1 - t0, ink: t2 - t1, total: t2 - t0 },
  }
}
