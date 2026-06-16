import { DEFAULT_PARAMS, StructureParams, StyleParams } from '../types'
import { ImageStats } from './analyze'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// Derive a full parameter set + a short explanation from the measured image stats. The duotone
// stays on the house Coral palette; tone / line / staging dials adapt per image.
export function mapToParams(s: ImageStats): { structure: StructureParams; style: StyleParams; notes: string[] } {
  const notes: string[] = []

  const blackPoint = clamp(s.p05 * 0.8, 0, 0.22)
  const highlightClip = clamp(s.p95 + 0.03, 0.7, 0.99)

  const p50 = clamp(s.p50, 0.08, 0.92)
  const gamma = clamp(Math.log(0.5) / Math.log(p50), 0.6, 1.7)
  if (gamma < 0.85) notes.push('Dark photo — lifted midtones')
  else if (gamma > 1.2) notes.push('Bright photo — deepened midtones')

  const toneLevels = s.contrast < 0.14 ? 3 : s.contrast > 0.24 ? 5 : 4
  if (toneLevels === 3) notes.push('Low contrast — 3 flat cels')
  else if (toneLevels === 5) notes.push('High contrast — 5 cels')

  // Busy / noisy photos: more smoothing + a slightly higher line threshold to stay graphic.
  const smoothing = clamp(0.5 + s.edgeDensity * 3.0, 0.45, 0.85)
  const lineStrength = clamp(0.62 - s.edgeDensity * 1.8, 0.42, 0.62)
  if (s.edgeDensity > 0.07) notes.push('Detailed photo — flattened for clean cels')

  // Stronger weight contrast + bigger spotted blacks when the image already has punch.
  const lineWeightContrast = clamp(0.6 + s.contrast * 0.9, 0.55, 0.9)
  const spottedBlack = clamp(0.4 + (0.2 - s.p05) * 1.2, 0.3, 0.75)
  if (s.p05 < 0.08) notes.push('Deep shadows — spotted blacks on')

  const structure: StructureParams = {
    ...DEFAULT_PARAMS.structure,
    smoothing,
    toneLevels,
    blackPoint,
    highlightClip,
    gamma,
    lineStrength,
    lineWeightContrast,
    spottedBlack,
  }

  // Slightly deepen the key for very bright photos so the subject still anchors.
  const key = clamp(DEFAULT_PARAMS.style.key + (s.mean > 0.7 ? -0.06 : s.mean < 0.3 ? 0.08 : 0), -1, 1)
  const style: StyleParams = { ...DEFAULT_PARAMS.style, key }
  return { structure, style, notes }
}
