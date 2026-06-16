// Parameter model for the comic engine.
// Split into Structure (forces a worker recompute) and Style (real-time canvas redraw),
// mirroring the engraver app's proven split so palette/texture tweaks stay instant.

export interface StructureParams {
  // Fills (cel shading)
  smoothing: number // edge-preserving flatten strength, 0–1 (more = flatter cartoon cells)
  toneLevels: number // posterization bands for the cel shading (2–6)
  blackPoint: number // luminance mapping to the darkest fill (0–0.4)
  highlightClip: number // luminance above which = lightest fill (0.6–1)
  gamma: number // midtone bias (0.5–2)
  // Ink lines (XDoG)
  lineStrength: number // ink amount / threshold (0–1)
  lineWidth: number // ink line thickness in working-res px (0.4–2.5)
  lineDetail: number // fine ↔ coarse edges, maps to DoG sigma (0–1)
  wobble: number // hand-drawn line jitter (0–1)
}

export interface StyleParams {
  light: string // hex — highlight fill colour
  dark: string // hex — shadow fill colour (same warm hue family)
  ink: string // hex — line / outline colour (near-black warm)
  grain: number // paper grain amount (0–1)
  brush: number // brush-stroke texture amount (0–1)
  frame: boolean // rounded comic panel frame + white margin
}

export interface ComicParams {
  structure: StructureParams
  style: StyleParams
}

// Bump when the param model or engine output changes in a way that invalidates saved
// presets. Embedded in saved JSON + share links.
export const PRESET_VERSION = 1

// ---- Worker protocol: one discriminated union shared by App + worker ----

export interface ComicInput {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface ComicTimings {
  smooth: number // ms to bilateral-smooth + tone-map + posterize
  ink: number // ms to compute the XDoG ink layer
  total: number
}

export type WorkerRequest =
  // 'source' carries the working-res pixels (transferred, not cloned), sent once per image;
  // the worker caches the source so later 'params' messages skip the upload.
  | { kind: 'source'; id: number; img: ComicInput; params: StructureParams }
  // 'params' reuses the cached source — recomputes tone + ink only.
  | { kind: 'params'; id: number; params: StructureParams }

export type WorkerResponse =
  | {
      kind: 'result'
      id: number
      w: number
      h: number
      tone: Uint8Array // quantized brightness per px, 0 (shadow) .. 255 (highlight)
      ink: Uint8Array // ink coverage per px, 0 (none) .. 255 (full line)
      timings: ComicTimings
    }
  | { kind: 'error'; id: number; message: string }

// Thrown by the compute core when a job is superseded; the worker swallows it.
export class CancelledError extends Error {
  constructor() {
    super('comic render cancelled')
    this.name = 'CancelledError'
  }
}

export const DEFAULT_PARAMS: ComicParams = {
  structure: {
    smoothing: 0.6,
    toneLevels: 4,
    blackPoint: 0.06,
    highlightClip: 0.94,
    gamma: 1.0,
    lineStrength: 0.55,
    lineWidth: 1.1,
    lineDetail: 0.5,
    wobble: 0.4,
  },
  style: {
    light: '#ffd9c2',
    dark: '#d24a2a',
    ink: '#241712',
    grain: 0.4,
    brush: 0.45,
    frame: true,
  },
}
