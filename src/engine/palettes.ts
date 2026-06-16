import { ComicParams, DEFAULT_PARAMS, StructureParams, StyleParams } from '../types'

// Single-hue duotone palettes. Each locks the fill family to one hue (the references hold a
// tight hue and shift only saturation/lightness across the ramp), tints the paper highlight,
// and rotates the shadow end slightly. The line/spotted-black ink is a single global near-black,
// decoupled from the fill hue — that's what gives the signature black-on-coral contrast.
export interface Duotone {
  name: string
  inkHue: number
  paperColor: string
  shadowHueShift: number
  satBump: number
  key: number
}

export const DUOTONES: Duotone[] = [
  { name: 'Coral', inkHue: 11, paperColor: '#fbeae3', shadowHueShift: -5, satBump: 0.4, key: 0 },
  { name: 'Peach', inkHue: 19, paperColor: '#fdeee2', shadowHueShift: -3, satBump: 0.32, key: 0.18 },
  { name: 'Apricot', inkHue: 27, paperColor: '#fdefd9', shadowHueShift: -7, satBump: 0.38, key: 0.05 },
  { name: 'Brick', inkHue: 8, paperColor: '#f3d8c8', shadowHueShift: -3, satBump: 0.48, key: -0.26 },
  { name: 'Oxblood', inkHue: 5, paperColor: '#eccabb', shadowHueShift: -2, satBump: 0.5, key: -0.4 },
  { name: 'Violet', inkHue: 258, paperColor: '#e7e2ee', shadowHueShift: 8, satBump: 0.34, key: -0.08 },
  { name: 'Riso Blue', inkHue: 212, paperColor: '#dee7ee', shadowHueShift: 6, satBump: 0.36, key: -0.05 },
  { name: 'Mono', inkHue: 28, paperColor: '#eeeae4', shadowHueShift: 0, satBump: 0.04, key: 0 },
]

// Named "looks": a full Structure + Style bundle. Variable line weight, spotted blacks, and
// background flattening are ON in every preset — they are the comic look, not options to find.
export type StyleKey = 'coral' | 'softPeach' | 'oxblood' | 'inked' | 'cleanCel' | 'cool'

interface Preset {
  label: string
  hint: string
  structure: StructureParams
  style: StyleParams
}

const D = DEFAULT_PARAMS

function styleFrom(d: Duotone, over: Partial<StyleParams> = {}): StyleParams {
  return {
    ...D.style,
    inkHue: d.inkHue,
    paperColor: d.paperColor,
    shadowHueShift: d.shadowHueShift,
    satBump: d.satBump,
    key: d.key,
    ...over,
  }
}

const byName = (n: string) => DUOTONES.find((d) => d.name === n)!

export const PRESETS: Record<StyleKey, Preset> = {
  coral: {
    label: 'Coral',
    hint: 'The house style — warm coral, staged subject, balanced ink.',
    structure: { ...D.structure },
    style: styleFrom(byName('Coral')),
  },
  softPeach: {
    label: 'Soft Peach',
    hint: 'Light peach, fewer tones, delicate lines — gentle and airy.',
    structure: { ...D.structure, toneLevels: 3, lineStrength: 0.46, lineWidth: 1.0, spottedBlack: 0.3, gamma: 1.12 },
    style: styleFrom(byName('Peach'), { grain: 0.08, vignette: 0.25 }),
  },
  oxblood: {
    label: 'Oxblood',
    hint: 'Deep blood-red, heavy blacks, dramatic low-key staging.',
    structure: { ...D.structure, blackPoint: 0.12, gamma: 0.9, lineWidth: 1.4, spottedBlack: 0.7, contactShadow: 0.55 },
    style: styleFrom(byName('Oxblood'), { vignette: 0.45 }),
  },
  inked: {
    label: 'Inked',
    hint: 'Bold, confident hand-inked lines with strong weight contrast.',
    structure: { ...D.structure, lineStrength: 0.72, lineWidth: 1.7, lineWeightContrast: 0.85, lineDetail: 0.58, wobble: 0.5, spottedBlack: 0.6 },
    style: styleFrom(byName('Coral'), { grain: 0.12 }),
  },
  cleanCel: {
    label: 'Clean Cel',
    hint: 'Flat animation cells — strong smoothing, minimal grain, crisp lines.',
    structure: { ...D.structure, smoothing: 0.85, toneLevels: 3, lineWeightContrast: 0.55, wobble: 0.18, spottedBlack: 0.4 },
    style: styleFrom(byName('Coral'), { grain: 0.04, brush: 0.16 }),
  },
  cool: {
    label: 'Cool Violet',
    hint: 'Violet duotone for moody, emotional panels.',
    structure: { ...D.structure },
    style: styleFrom(byName('Violet'), { vignette: 0.4 }),
  },
}

export function presetParams(key: StyleKey): ComicParams {
  const p = PRESETS[key]
  return { structure: { ...p.structure }, style: { ...p.style } }
}
