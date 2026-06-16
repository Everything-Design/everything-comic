import { StyleParams } from '../types'

// Renders the worker's tone + ink fields into a finished comic panel on a canvas at whatever
// backing resolution the canvas is sized to (screen preview or high-res export). Everything
// here is style-only: re-running it re-colours / re-textures instantly without a recompute.

export interface ComicFields {
  w: number
  h: number
  tone: Uint8Array
  ink: Uint8Array
}

interface RGB { r: number; g: number; b: number }

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

// Integer hash -> [0,1). Used for paper grain (per-pixel) and brush noise lattice.
function hash2(x: number, y: number, seed: number): number {
  let n = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0
  n = (n ^ (n >> 13)) * 1274126177
  n = n ^ (n >> 16)
  return (n & 0x7fffffff) / 0x7fffffff
}

// Smooth value noise at lattice scale (sx, sy) — stretch sx > sy for horizontal brush streaks.
function valueNoise(x: number, y: number, sx: number, sy: number, seed: number): number {
  const gx = x / sx, gy = y / sy
  const x0 = Math.floor(gx), y0 = Math.floor(gy)
  const tx = gx - x0, ty = gy - y0
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed)
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed)
  const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty)
  const top = a + (b - a) * u
  const bot = c + (d - c) * u
  return top + (bot - top) * v
}

// Build the finished panel pixels at (cw, ch) by upscaling the fields and applying the
// duotone gradient, brush variation, grain, and ink — in one pass.
function buildComposite(fields: ComicFields, style: StyleParams, cw: number, ch: number): ImageData {
  const { w, h, tone, ink } = fields
  const light = hexToRgb(style.light)
  const dark = hexToRgb(style.dark)
  const inkC = hexToRgb(style.ink)
  const out = new ImageData(cw, ch)
  const px = out.data
  const sxr = (w - 1) / Math.max(1, cw - 1)
  const syr = (h - 1) / Math.max(1, ch - 1)
  // brush streak scale relative to output size
  const bsx = Math.max(12, cw / 22)
  const bsy = Math.max(28, ch / 7)
  const brush = style.brush
  const grain = style.grain

  let o = 0
  for (let ty = 0; ty < ch; ty++) {
    const fy = ty * syr
    const y0 = Math.floor(fy), y1 = y0 + 1 < h ? y0 + 1 : y0
    const wy = fy - y0
    for (let tx = 0; tx < cw; tx++, o += 4) {
      const fx = tx * sxr
      const x0 = Math.floor(fx), x1 = x0 + 1 < w ? x0 + 1 : x0
      const wx = fx - x0
      // bilinear sample tone + ink
      const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1
      let q = ((tone[i00] * (1 - wx) + tone[i10] * wx) * (1 - wy) +
               (tone[i01] * (1 - wx) + tone[i11] * wx) * wy) / 255
      const ia = ((ink[i00] * (1 - wx) + ink[i10] * wx) * (1 - wy) +
                  (ink[i01] * (1 - wx) + ink[i11] * wx) * wy) / 255

      // brush: nudge tone within the palette for a painterly, uneven fill
      if (brush > 0) {
        const n = valueNoise(tx, ty, bsx, bsy, 7) - 0.5
        q += n * brush * 0.16
        if (q < 0) q = 0; else if (q > 1) q = 1
      }

      let r = dark.r + (light.r - dark.r) * q
      let g = dark.g + (light.g - dark.g) * q
      let b = dark.b + (light.b - dark.b) * q

      // paper grain: fine achromatic speckle
      if (grain > 0) {
        const gn = (hash2(tx, ty, 19) - 0.5) * grain * 30
        r += gn; g += gn; b += gn
      }

      // ink on top
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

// Trace a slightly hand-wobbled rounded rectangle (the comic panel border).
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

  if (!style.frame) {
    ctx.putImageData(buildComposite(fields, style, cw, ch), 0, 0)
    return
  }

  // Framed: white margin, rounded clip, dark border — like the reference panels.
  const margin = Math.round(Math.min(cw, ch) * 0.035)
  const ix = margin, iy = margin
  const iw = cw - margin * 2, ih = ch - margin * 2
  const radius = Math.round(Math.min(iw, ih) * 0.045)
  const border = Math.max(1.5, Math.min(cw, ch) * 0.006)

  // composite rendered at the inner panel resolution so detail isn't wasted on the margin
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

// Render the fields to a fresh canvas at a target long-edge resolution (export / copy).
export function renderToCanvas(fields: ComicFields, style: StyleParams, longSide: number): HTMLCanvasElement {
  const aspect = fields.w / fields.h
  const w = aspect >= 1 ? longSide : Math.round(longSide * aspect)
  const h = aspect >= 1 ? Math.round(longSide / aspect) : longSide
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  drawComic(cv, fields, style)
  return cv
}
