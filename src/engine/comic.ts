import { ComicInput, ComicTimings, StructureParams } from '../types'

// ---------------------------------------------------------------------------
// Comic engine v2: photo -> (tone field, ink field, subject mask).
//
//   1. luminance + chroma
//   2. edge-preserving smooth        flat cel regions
//   3. saliency mask                 subject vs background (center + contrast + chroma)
//   4. contact shadows               AO proxy darkens junctions
//   5. tone map + posterize          cel bands
//   6. ink lines                     DoG on a denoised source -> clean strokes
//   7. variable line weight          edge-strength + darkness widen (heavy silhouettes)
//   8. spotted blacks                large solid dark masses
//   9. hand-drawn wobble             warp the INK only; cels stay crisp
//
// The renderer colours the tone field through a single-hue ramp, flattens the
// background using the mask, and composites ink + spotted black on top — all
// style-only, so palette/texture changes never recompute.
// ---------------------------------------------------------------------------

const now = () => (typeof performance !== 'undefined' ? performance.now() : 0)

function luminance(img: ComicInput): Float32Array {
  const { data } = img
  const out = new Float32Array(img.width * img.height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255
  }
  return out
}

// Saturation/chroma channel (max−min of RGB), a weak cue that real subjects are more colourful
// than flat/desaturated backgrounds.
function chroma(img: ComicInput): Float32Array {
  const { data } = img
  const out = new Float32Array(img.width * img.height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b
    out[i] = (mx - mn) / 255
  }
  return out
}

// One separable bilateral pass (horizontal then vertical) — a fast cross approximation that
// flattens photo detail into paintable cel regions while keeping edges.
function bilateralPass(src: Float32Array, w: number, h: number, radius: number, sr: number): Float32Array {
  const s3 = 1 / (2 * sr * sr)
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const sw = new Float32Array(radius + 1)
  const ss = 1 / (2 * (radius * 0.6 + 0.5) * (radius * 0.6 + 0.5))
  for (let d = 0; d <= radius; d++) sw[d] = Math.exp(-(d * d) * ss)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const c = src[row + x]
      let acc = c, wsum = 1
      for (let d = 1; d <= radius; d++) {
        const sl = src[row + (x - d >= 0 ? x - d : 0)]
        const srr = src[row + (x + d < w ? x + d : w - 1)]
        const wl = sw[d] * Math.exp(-((sl - c) * (sl - c)) * s3)
        const wr = sw[d] * Math.exp(-((srr - c) * (srr - c)) * s3)
        acc += sl * wl + srr * wr
        wsum += wl + wr
      }
      tmp[row + x] = acc / wsum
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const c = tmp[y * w + x]
      let acc = c, wsum = 1
      for (let d = 1; d <= radius; d++) {
        const st = tmp[(y - d >= 0 ? y - d : 0) * w + x]
        const sb = tmp[(y + d < h ? y + d : h - 1) * w + x]
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

// Separable Gaussian blur.
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
        acc += (src[row + (x - d >= 0 ? x - d : 0)] + src[row + (x + d < w ? x + d : w - 1)]) * k[d]
      }
      tmp[row + x] = acc
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = tmp[y * w + x] * k[0]
      for (let d = 1; d <= radius; d++) {
        acc += (tmp[(y - d >= 0 ? y - d : 0) * w + x] + tmp[(y + d < h ? y + d : h - 1) * w + x]) * k[d]
      }
      out[y * w + x] = acc
    }
  }
  return out
}

// Separable square-SE morphology. max => dilate, min => erode. close = dilate then erode.
function morph(src: Float32Array, w: number, h: number, r: number, grow: boolean): Float32Array {
  if (r <= 0) return src
  const better = (a: number, b: number) => (grow ? b > a : b < a)
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let m = src[row + x]
      for (let d = 1; d <= r; d++) {
        const a = src[row + (x - d >= 0 ? x - d : 0)]
        const b = src[row + (x + d < w ? x + d : w - 1)]
        if (better(m, a)) m = a
        if (better(m, b)) m = b
      }
      tmp[row + x] = m
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = tmp[y * w + x]
      for (let d = 1; d <= r; d++) {
        const a = tmp[(y - d >= 0 ? y - d : 0) * w + x]
        const b = tmp[(y + d < h ? y + d : h - 1) * w + x]
        if (better(m, a)) m = a
        if (better(m, b)) m = b
      }
      out[y * w + x] = m
    }
  }
  return out
}

// Remove blobs smaller than minArea (8-connectivity). Drops isolated specks / dots.
function despeckle(field: Float32Array, w: number, h: number, minArea: number, thr: number) {
  const n = w * h
  const label = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  for (let start = 0; start < n; start++) {
    if (field[start] < thr || label[start] !== -1) continue
    let sp = 0
    stack[sp++] = start
    label[start] = start
    const members: number[] = []
    while (sp > 0) {
      const i = stack[--sp]
      members.push(i)
      const x = i % w, y = (i / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const j = ny * w + nx
          if (field[j] >= thr && label[j] === -1) { label[j] = start; stack[sp++] = j }
        }
      }
    }
    if (members.length < minArea) for (const m of members) field[m] = 0
  }
}

// Deterministic 2-octave value noise for the hand-drawn ink wobble.
function makeNoise(seed: number) {
  const hash = (x: number, y: number) => {
    let n = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
    n = (n ^ (n >> 13)) * 1274126177
    n = n ^ (n >> 16)
    return (n & 0x7fffffff) / 0x7fffffff
  }
  const smooth = (gx: number, gy: number) => {
    const x0 = Math.floor(gx), y0 = Math.floor(gy)
    const tx = gx - x0, ty = gy - y0
    const a = hash(x0, y0), b = hash(x0 + 1, y0)
    const c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1)
    const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty)
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
  }
  return (x: number, y: number, scale: number) =>
    smooth(x / scale, y / scale) * 0.65 + smooth((x / scale) * 2.3, (y / scale) * 2.3) * 0.35
}

// Warp a single field by a low-frequency vector field (bilinear). Used for ink-only wobble.
function warpField(field: Float32Array, w: number, h: number, amount: number): Float32Array {
  if (amount <= 0.001) return field
  const nx = makeNoise(11), ny = makeNoise(29)
  const scale = Math.max(14, Math.min(w, h) / 9)
  const amp = amount * Math.min(w, h) * 0.009
  const out = new Float32Array(w * h)
  const sample = (sx: number, sy: number) => {
    if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1
    if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1
    const x0 = Math.floor(sx), y0 = Math.floor(sy)
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0
    const tx = sx - x0, ty = sy - y0
    const a = field[y0 * w + x0], b = field[y0 * w + x1], c = field[y1 * w + x0], d = field[y1 * w + x1]
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = sample(x + (nx(x, y, scale) - 0.5) * 2 * amp, y + (ny(x, y, scale) - 0.5) * 2 * amp)
    }
  }
  return out
}

// Subject saliency from a center prior * local contrast * chroma. A heuristic (no ML): good
// enough to collapse a busy background to a flat ground without hard-cutting the subject.
function saliency(lum: Float32Array, chr: Float32Array, w: number, h: number): { mask: Float32Array; cx: number; cy: number } {
  const n = w * h
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.022))
  // integral images of lum and lum^2 for O(1) box variance
  const W1 = w + 1
  const I = new Float64Array(W1 * (h + 1))
  const I2 = new Float64Array(W1 * (h + 1))
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0
    for (let x = 0; x < w; x++) {
      const v = lum[y * w + x]
      rs += v; rs2 += v * v
      I[(y + 1) * W1 + (x + 1)] = I[y * W1 + (x + 1)] + rs
      I2[(y + 1) * W1 + (x + 1)] = I2[y * W1 + (x + 1)] + rs2
    }
  }
  const boxVar = (x: number, y: number): number => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r)
    const x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1)
    const area = (x1 - x0) * (y1 - y0)
    const s = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]
    const s2 = I2[y1 * W1 + x1] - I2[y0 * W1 + x1] - I2[y1 * W1 + x0] + I2[y0 * W1 + x0]
    const m = s / area
    return Math.max(0, s2 / area - m * m)
  }
  const cxp = w / 2, cyp = h / 2
  const sx = w * 0.44, sy = h * 0.44
  const raw = new Float32Array(n)
  let vMax = 1e-6
  const vbuf = new Float32Array(n)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = boxVar(x, y); vbuf[y * w + x] = v; if (v > vMax) vMax = v }
  let rawMax = 1e-6
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const dx = (x - cxp) / sx, dy = (y - cyp) / sy
      const cp = Math.exp(-(dx * dx + dy * dy) * 0.5)
      const con = Math.sqrt(vbuf[i] / vMax) // 0..1, lifted
      // Center prior dominates (broadened via pow) so flat interior regions of a central
      // subject stay masked; contrast + chroma only nudge. Avoids carving up the subject.
      const v = Math.pow(cp, 0.8) * (0.55 + 0.45 * con) * (0.62 + 0.38 * chr[i])
      raw[i] = v
      if (v > rawMax) rawMax = v
    }
  }
  for (let i = 0; i < n; i++) raw[i] /= rawMax
  for (let i = 0; i < n; i++) {
    const t = (raw[i] - 0.3) / 0.3
    raw[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
  }
  // Strong dilate then partial erode => a FILLED, slightly grown silhouette (not an edge map),
  // so the subject's flat interior reads as subject. Generous feather — never a hard cut.
  let mask = morph(raw, w, h, Math.max(2, Math.round(r * 1.2)), true)
  mask = morph(mask, w, h, Math.max(1, Math.round(r * 0.7)), false)
  mask = gaussian(mask, w, h, Math.min(w, h) * 0.03)
  // weighted centroid
  let sumM = 0, sumX = 0, sumY = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const m = mask[y * w + x]; sumM += m; sumX += m * x; sumY += m * y }
  const cx = sumM > 1e-3 ? sumX / sumM / w : 0.5
  const cy = sumM > 1e-3 ? sumY / sumM / h : 0.5
  return { mask, cx, cy }
}

export function computeComic(img: ComicInput, p: StructureParams): {
  w: number; h: number; tone: Uint8Array; ink: Uint8Array; mask: Uint8Array; cx: number; cy: number; timings: ComicTimings
} {
  const w = img.width, h = img.height, n = w * h
  const t0 = now()
  const lum = luminance(img)
  const chr = chroma(img)

  // --- 2. edge-preserving smoothing -> flat cel regions ---
  const radius = 2 + Math.round(p.smoothing * 4)
  const iterations = 1 + Math.round(p.smoothing * 2)
  const sr = 0.16 - p.smoothing * 0.06
  let sm = lum
  for (let it = 0; it < iterations; it++) sm = bilateralPass(sm, w, h, radius, sr)

  // --- 3. subject saliency ---
  const { mask, cx, cy } = saliency(lum, chr, w, h)

  // --- 4. contact shadows (AO proxy): darken local concavities ---
  if (p.contactShadow > 0.01) {
    const big = gaussian(sm, w, h, Math.min(w, h) * 0.012)
    const small = gaussian(sm, w, h, 2)
    const sm2 = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const conc = big[i] - small[i] // >0 where locally darker than the broad average
      const c = conc > 0 ? conc : 0
      sm2[i] = Math.max(0, sm[i] - p.contactShadow * c * 0.7)
    }
    sm = sm2
  }

  // --- 5. tone map + posterize into cel bands ---
  const bp = p.blackPoint, hc = p.highlightClip
  const span = Math.max(1e-3, hc - bp)
  const invGamma = 1 / Math.max(0.05, p.gamma)
  const levels = Math.max(2, Math.round(p.toneLevels))
  const tone = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    let v = (sm[i] - bp) / span
    v = v < 0 ? 0 : v > 1 ? 1 : v
    v = Math.pow(v, invGamma)
    const band = Math.min(levels - 1, Math.floor(v * levels))
    const q = levels > 1 ? band / (levels - 1) : v
    tone[i] = Math.round(q * 255)
  }
  const t1 = now()

  // --- 6. ink lines: DoG on a denoised source ---
  let lineSrc = bilateralPass(lum, w, h, 4, 0.12)
  lineSrc = bilateralPass(lineSrc, w, h, 4, 0.12)
  const sigma = 0.7 + p.lineDetail * 1.7
  const g1 = gaussian(lineSrc, w, h, sigma)
  const g2 = gaussian(lineSrc, w, h, sigma * 1.6)
  // coarse pass for silhouette / region edges (drives heavy line weight)
  const cs = Math.min(5, sigma * 2.3)
  const g1c = gaussian(lineSrc, w, h, cs)
  const g2c = gaussian(lineSrc, w, h, cs * 1.6)
  const resp = new Float32Array(n)
  const coarse = new Float32Array(n)
  let mean = 0
  for (let i = 0; i < n; i++) {
    const r1 = g2[i] - g1[i]
    resp[i] = r1 > 0 ? r1 : 0
    const r2 = g2c[i] - g1c[i]
    coarse[i] = r2 > 0 ? r2 : 0
    mean += resp[i]
  }
  mean /= n
  let varsum = 0
  for (let i = 0; i < n; i++) { const d = resp[i] - mean; varsum += d * d }
  const std = Math.sqrt(varsum / n) || 1e-4
  const thr = mean + std * (1.7 - p.lineStrength * 1.5)
  const thrHi = thr + std * 0.7
  let ridge: Float32Array = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = resp[i]
    let a = v <= thr ? 0 : v >= thrHi ? 1 : (v - thr) / (thrHi - thr)
    ridge[i] = a * a * (3 - 2 * a)
  }
  // bridge gaps then despeckle -> continuous strokes
  ridge = morph(ridge, w, h, 1, true)
  ridge = morph(ridge, w, h, 1, false)
  despeckle(ridge, w, h, Math.max(10, Math.round(Math.min(w, h) * 0.028)), 0.4)

  // --- 7. variable line weight: widen heavy/dark edges more than light interior ones ---
  const maxR = Math.min(4, Math.max(1, Math.round(p.lineWidth * 1.6)))
  const respScale = mean + std * 2.5
  const coarseScale = (() => { let m = 1e-4; for (let i = 0; i < n; i++) if (coarse[i] > m) m = coarse[i]; return m * 0.6 })()
  const rad = new Float32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    if (ridge[i] <= 0.4) continue
    const e = Math.min(1, resp[i] / respScale)
    const ce = Math.min(1, coarse[i] / coarseScale)
    const dk = 1 - lineSrc[i]
    const wgt = Math.min(1, 0.4 * e + 0.38 * ce + 0.22 * dk)
    const mix = (1 - p.lineWeightContrast) + p.lineWeightContrast * wgt
    rad[i] = Math.round(maxR * mix)
  }
  // geodesic dilation: a pixel with radius k spreads k rings outward
  for (let step = 1; step <= maxR; step++) {
    const next = rad.slice()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (rad[i] >= 0) continue
        let m = -1
        if (x > 0 && rad[i - 1] > m) m = rad[i - 1]
        if (x < w - 1 && rad[i + 1] > m) m = rad[i + 1]
        if (y > 0 && rad[i - w] > m) m = rad[i - w]
        if (y < h - 1 && rad[i + w] > m) m = rad[i + w]
        if (m >= 1) next[i] = m - 1
      }
    }
    rad.set(next)
  }
  let inkF: Float32Array = new Float32Array(n)
  for (let i = 0; i < n; i++) inkF[i] = rad[i] >= 0 ? 1 : 0

  // --- 8. spotted blacks: large solid dark masses ---
  if (p.spottedBlack > 0.01) {
    const blkThr = p.spottedBlack * 0.18
    const blk = new Float32Array(n)
    for (let i = 0; i < n; i++) blk[i] = sm[i] < blkThr ? 1 : 0
    let b = morph(blk, w, h, 1, false) // open: drop thin/noisy darks
    b = morph(b, w, h, 1, true)
    despeckle(b, w, h, Math.max(400, Math.round(Math.min(w, h) * 2.2)), 0.5)
    b = morph(b, w, h, 1, true) // grow back slightly
    for (let i = 0; i < n; i++) if (b[i] > 0.5 && inkF[i] < 1) inkF[i] = 1
  }

  // --- 9. hand-drawn wobble (ink only) + anti-alias ---
  inkF = warpField(inkF, w, h, p.wobble)
  inkF = gaussian(inkF, w, h, 0.7)

  const toneOut = new Uint8Array(n)
  const inkOut = new Uint8Array(n)
  const maskOut = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    toneOut[i] = tone[i]
    inkOut[i] = Math.round(Math.max(0, Math.min(1, inkF[i])) * 255)
    maskOut[i] = Math.round(Math.max(0, Math.min(1, mask[i])) * 255)
  }
  const t2 = now()

  return {
    w, h, tone: toneOut, ink: inkOut, mask: maskOut, cx, cy,
    timings: { smooth: t1 - t0, ink: t2 - t1, total: t2 - t0 },
  }
}
