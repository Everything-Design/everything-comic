// Parameter model for the comic engine (v2 — "inked & staged" rewrite).
// Split into Structure (forces a worker recompute) and Style (real-time canvas redraw).

export interface StructureParams {
  // Fills (cel shading)
  smoothing: number // edge-preserving flatten strength, 0–1
  toneLevels: number // posterization bands (2–6)
  blackPoint: number // luminance mapping to the darkest fill (0–0.4)
  highlightClip: number // luminance above which = lightest fill (0.6–1)
  gamma: number // midtone bias (0.5–2)
  // Ink lines (XDoG + variable weight)
  lineStrength: number // ink amount / threshold (0–1)
  lineWidth: number // base/max ink weight (0.4–2.5) — drives the variable widen radius
  lineWeightContrast: number // how much edge-strength/darkness modulates weight (0 = uniform, 1 = max)
  lineDetail: number // fine ↔ coarse edges, maps to DoG sigma (0–1)
  wobble: number // hand-drawn line jitter (0–1) — ink only, cels stay crisp
  // Staging
  spottedBlack: number // solid black shadow masses for depth (0–1, 0 = off)
  contactShadow: number // junction/occlusion darkening, AO proxy (0–1)
}

export interface StyleParams {
  // Single-hue duotone ramp (shadow → tinted paper highlight)
  inkHue: number // base hue of the fill family, degrees (0–360)
  paperColor: string // hex — tinted highlight / paper (never pure white)
  shadowHueShift: number // degrees the shadow end rotates from inkHue (−20..20)
  satBump: number // midtone saturation boost (0–1)
  key: number // overall lightness bias, low-key ↔ high-key (−1..1)
  ink: string // hex — global near-black line / spotted-black colour
  grain: number // paper grain amount (0–1)
  brush: number // brush-stroke texture amount (0–1), modulated by the subject mask
  bgFlatten: number // collapse the background toward a flat ground + drop its lines (0–1)
  vignette: number // radial spotlight toward the ground colour (0–1)
  frame: FrameStyle // panel framing
}

export type FrameStyle = 'none' | 'rounded' | 'bleed'

export interface ComicParams {
  structure: StructureParams
  style: StyleParams
}

// Bumped from v1: param model + worker contract changed (mask field, ramp params).
export const PRESET_VERSION = 2

// ---- Worker protocol ----

export interface ComicInput {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface ComicTimings {
  smooth: number
  ink: number
  total: number
}

export type WorkerRequest =
  | { kind: 'source'; id: number; img: ComicInput; params: StructureParams }
  | { kind: 'params'; id: number; params: StructureParams }

export type WorkerResponse =
  | {
      kind: 'result'
      id: number
      w: number
      h: number
      tone: Uint8Array // quantized brightness per px, 0 (shadow) .. 255 (highlight)
      ink: Uint8Array // ink coverage per px, 0 .. 255 (lines + spotted blacks)
      mask: Uint8Array // subject saliency per px, 0 (background) .. 255 (subject)
      cx: number // subject centroid x (0..1) for spotlight / framing
      cy: number
      timings: ComicTimings
    }
  | { kind: 'error'; id: number; message: string }

export class CancelledError extends Error {
  constructor() {
    super('comic render cancelled')
    this.name = 'CancelledError'
  }
}

export const DEFAULT_PARAMS: ComicParams = {
  structure: {
    smoothing: 0.62,
    toneLevels: 4,
    blackPoint: 0.06,
    highlightClip: 0.94,
    gamma: 1.0,
    lineStrength: 0.55,
    lineWidth: 1.2,
    lineWeightContrast: 0.7,
    lineDetail: 0.5,
    wobble: 0.35,
    spottedBlack: 0.5,
    contactShadow: 0.4,
  },
  style: {
    inkHue: 11,
    paperColor: '#fbeae3',
    shadowHueShift: -5,
    satBump: 0.38,
    key: 0,
    ink: '#1a1208',
    grain: 0.1,
    brush: 0.4,
    bgFlatten: 0.6,
    vignette: 0.22,
    frame: 'rounded',
  },
}
