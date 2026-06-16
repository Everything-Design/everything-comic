import { StyleParams } from '../types'

// Renders the worker's fields (tone + ink + subject mask) into a finished comic panel at any
// backing resolution. Everything here is style-only: re-running re-colours / re-stages instantly
// without a recompute. The duotone is a single-hue ramp evaluated through a 256-entry LUT.

export interface ComicFields {
  w: number
  h: number
  tone: Uint8Array
  ink: Uint8Array
  mask: Uint8Array
  cx: number
  cy: number
}

interface RGB { r: number; g: number; b: number }

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

function rgbToHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  let s = 0, h = 0
  if (mx !== mn) {
    const d = mx - mn
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

// Build a 256-entry tone->RGB ramp: shadow (deep, slightly hue-shifted, saturated) -> tinted
// paper highlight, with a midtone saturation bump. Locks the fill to one hue family.
function buildRamp(style: StyleParams): Uint8ClampedArray {
  const paper = rgbToHsl(hexToRgb(style.paperColor))
  const shadowL = Math.min(0.4, Math.max(0.05, 0.17 + style.key * 0.06))
  const paperL = Math.min(0.985, Math.max(0.6, paper.l + style.key * 0.04))
  const shadowS = Math.min(0.85, 0.42 + style.satBump * 0.22)
  const paperS = paper.s
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    const L = shadowL + (paperL - shadowL) * t
    const H = style.inkHue + (1 - t) * style.shadowHueShift
    const Sbase = shadowS + (paperS - shadowS) * t
    const bump = style.satBump * 0.3 * Math.exp(-((t - 0.52) * (t - 0.52)) / (2 * 0.2 * 0.2))
    const S = Math.min(1, Math.max(0, Sbase + bump))
    const { r, g, b } = hslToRgb(H, S, L)
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b
  }
  return lut
}

function hash2(x: number, y: number, seed: number): number {
  let n = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0
  n = (n ^ (n >> 13)) * 1274126177
  n = n ^ (n >> 16)
  return (n & 0x7fffffff) / 0x7fffffff
}

function valueNoise(x: number, y: number, sx: number, sy: number, seed: number): number {
  const gx = x / sx, gy = y / sy
  const x0 = Math.floor(gx), y0 = Math.floor(gy)
  const tx = gx - x0, ty = gy - y0
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed)
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed)
  const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty)
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
}

function buildComposite(fields: ComicFields, style: StyleParams, cw: number, ch: number): ImageData {
  const { w, h, tone, ink, mask, cx, cy } = fields
  const lut = buildRamp(style)
  const inkC = hexToRgb(style.ink)
  const out = new ImageData(cw, ch)
  const px = out.data
  const sxr = (w - 1) / Math.max(1, cw - 1)
  const syr = (h - 1) / Math.max(1, ch - 1)
  const bsx = Math.max(12, cw / 22)
  const bsy = Math.max(28, ch / 7)
  const brush = style.brush
  const grain = style.grain
  const bgFlatten = style.bgFlatten
  const vignette = style.vignette
  const GROUND = 0.66 // tone the background collapses toward (a flat, fairly light ground)

  let o = 0
  for (let ty = 0; ty < ch; ty++) {
    const fy = ty * syr
    const y0 = Math.floor(fy), y1 = y0 + 1 < h ? y0 + 1 : y0
    const wy = fy - y0
    const ny = ty / ch - cy
    for (let tx = 0; tx < cw; tx++, o += 4) {
      const fx = tx * sxr
      const x0 = Math.floor(fx), x1 = x0 + 1 < w ? x0 + 1 : x0
      const wx = fx - x0
      const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1
      let q = ((tone[i00] * (1 - wx) + tone[i10] * wx) * (1 - wy) + (tone[i01] * (1 - wx) + tone[i11] * wx) * wy) / 255
      let ia = ((ink[i00] * (1 - wx) + ink[i10] * wx) * (1 - wy) + (ink[i01] * (1 - wx) + ink[i11] * wx) * wy) / 255
      const m = ((mask[i00] * (1 - wx) + mask[i10] * wx) * (1 - wy) + (mask[i01] * (1 - wx) + mask[i11] * wx) * wy) / 255

      // background flattening: collapse tone toward the ground + drop background lines
      const fl = bgFlatten * (1 - m)
      if (fl > 0) {
        q += (GROUND - q) * fl * 0.85
        ia *= 1 - fl * 0.85
      }

      // brush variation within the palette, stronger on the subject
      if (brush > 0) {
        const bAmp = brush * (0.3 + 0.7 * m)
        q += (valueNoise(tx, ty, bsx, bsy, 7) - 0.5) * bAmp * 0.16
      }

      // radial spotlight: ease the periphery toward the shadow/ground
      if (vignette > 0) {
        const nx = tx / cw - cx
        const dn = Math.sqrt(nx * nx + ny * ny) / 0.72
        const vig = dn <= 0.4 ? 0 : dn >= 1 ? 1 : (dn - 0.4) / 0.6
        q *= 1 - vignette * vig * vig * 0.38
      }

      if (q < 0) q = 0; else if (q > 1) q = 1
      const li = (q * 255 + 0.5) | 0
      let r = lut[li * 3], g = lut[li * 3 + 1], b = lut[li * 3 + 2]

      if (grain > 0) {
        const gn = (hash2(tx, ty, 19) - 0.5) * grain * 26
        r += gn; g += gn; b += gn
      }

      if (ia > 0) {
        r = r + (inkC.r - r) * ia
        g = g + (inkC.g - g) * ia
        b = b + (inkC.b - b) * ia
      }

      px[o] = r < 0 ? 0 : r > 255 ? 255 : r
      px[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g
      px[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b
      px[o + 3] = 255
    }
  }
  return out
}

function roundedPanelPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

export function drawComic(canvas: HTMLCanvasElement, fields: ComicFields, style: StyleParams): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const cw = canvas.width, ch = canvas.height

  // 'none' / 'bleed' fill edge-to-edge; only 'rounded' adds the framed white margin + border.
  if (style.frame !== 'rounded') {
    ctx.putImageData(buildComposite(fields, style, cw, ch), 0, 0)
    return
  }

  const margin = Math.round(Math.min(cw, ch) * 0.035)
  const ix = margin, iy = margin
  const iw = cw - margin * 2, ih = ch - margin * 2
  const radius = Math.round(Math.min(iw, ih) * 0.045)
  const border = Math.max(1.5, Math.min(cw, ch) * 0.006)

  const comp = buildComposite(fields, style, Math.max(1, iw), Math.max(1, ih))
  const tmp = document.createElement('canvas')
  tmp.width = comp.width; tmp.height = comp.height
  tmp.getContext('2d')!.putImageData(comp, 0, 0)

  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, cw, ch)

  ctx.save()
  roundedPanelPath(ctx, ix, iy, iw, ih, radius)
  ctx.clip()
  ctx.drawImage(tmp, ix, iy)
  ctx.restore()

  roundedPanelPath(ctx, ix + border / 2, iy + border / 2, iw - border, ih - border, radius)
  ctx.strokeStyle = style.ink
  ctx.lineWidth = border
  ctx.lineJoin = 'round'
  ctx.stroke()
}

export function renderToCanvas(fields: ComicFields, style: StyleParams, longSide: number): HTMLCanvasElement {
  const aspect = fields.w / fields.h
  const w = aspect >= 1 ? longSide : Math.round(longSide * aspect)
  const h = aspect >= 1 ? Math.round(longSide / aspect) : longSide
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  drawComic(cv, fields, style)
  return cv
}
