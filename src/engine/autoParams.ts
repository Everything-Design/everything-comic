import { DEFAULT_PARAMS, StructureParams, StyleParams } from '../types'
import { ImageStats } from './analyze'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// Derive a full parameter set + a short human explanation from the measured image stats.
// The duotone colours stay on the house Coral palette; tone/line dials adapt per image.
export function mapToParams(s: ImageStats): { structure: StructureParams; style: StyleParams; notes: string[] } {
  const notes: string[] = []

  // Tone window from percentiles, leaving a little headroom so highlights read as paper.
  const blackPoint = clamp(s.p05 * 0.8, 0, 0.22)
  const highlightClip = clamp(s.p95 + 0.03, 0.7, 0.99)

  // Gamma to pull the median toward mid-grey for balanced cel bands.
  const p50 = clamp(s.p50, 0.08, 0.92)
  const gamma = clamp(Math.log(0.5) / Math.log(p50), 0.6, 1.7)
  if (gamma < 0.85) notes.push('Dark photo — lifted midtones')
  else if (gamma > 1.2) notes.push('Bright photo — deepened midtones')

  // Contrast drives cel-band count: flat images get fewer, punchy bands.
  const toneLevels = s.contrast < 0.14 ? 3 : s.contrast > 0.24 ? 5 : 4
  if (toneLevels === 3) notes.push('Low contrast — 3 flat cels')
  else if (toneLevels === 5) notes.push('High contrast — 5 cels')

  // Busy / noisy photos get more smoothing and a slightly higher line threshold so the
  // result stays graphic instead of scribbly.
  const smoothing = clamp(0.45 + s.edgeDensity * 3.2, 0.4, 0.85)
  const lineStrength = clamp(0.62 - s.edgeDensity * 2.0, 0.4, 0.62)
  if (s.edgeDensity > 0.07) notes.push('Detailed photo — flattened for clean cels')

  const structure: StructureParams = {
    ...DEFAULT_PARAMS.structure,
    smoothing,
    toneLevels,
    blackPoint,
    highlightClip,
    gamma,
    lineStrength,
  }
  return { structure, style: { ...DEFAULT_PARAMS.style }, notes }
}
