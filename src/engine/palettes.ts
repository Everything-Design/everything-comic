import { ComicParams, DEFAULT_PARAMS, StructureParams, StyleParams } from '../types'

// Duotone fill palettes — each maps the cel-shaded tone field from a light highlight to a
// dark shadow within one warm hue family, matching the reference comic's monochrome look.
// `ink` here is the suggested line colour for that palette (near-black warm).
export interface Duotone {
  name: string
  light: string
  dark: string
  ink: string
}

// Warm pairs are calibrated from the reference panels (pale highlight -> deep shadow within
// the orange-red family, hue ~10-20 deg) so the cel midtones land on the signature coral.
// Two cool/neutral options round out the set for portraits that resist a warm cast.
export const DUOTONES: Duotone[] = [
  { name: 'Coral', light: '#fcd8c0', dark: '#d2451f', ink: '#241712' },
  { name: 'Peach', light: '#fbddcf', dark: '#e07a4f', ink: '#3a221a' },
  { name: 'Apricot', light: '#ffe3c8', dark: '#e0742f', ink: '#2c1c10' },
  { name: 'OrangeRed', light: '#fbc2a3', dark: '#c43d1c', ink: '#21100a' },
  { name: 'Brick', light: '#f0b89c', dark: '#9a3a24', ink: '#1f0f0a' },
  { name: 'Maroon', light: '#e2a188', dark: '#5e2317', ink: '#1a0c09' },
  { name: 'Slate', light: '#dfe6ec', dark: '#3f5a73', ink: '#141b22' },
  { name: 'Mono', light: '#efece6', dark: '#4a4642', ink: '#161412' },
]

// Named "looks": a full Structure + Style bundle, like the engraver's PRESETS.
export type StyleKey = 'coral' | 'softPeach' | 'boldBrick' | 'inkHeavy' | 'cleanCel' | 'gritty'

interface Preset {
  label: string
  hint: string
  structure: StructureParams
  style: StyleParams
}

const D = DEFAULT_PARAMS

export const PRESETS: Record<StyleKey, Preset> = {
  coral: {
    label: 'Coral',
    hint: 'The house style — warm coral duotone, balanced ink, soft grain.',
    structure: { ...D.structure },
    style: { ...D.style },
  },
  softPeach: {
    label: 'Soft Peach',
    hint: 'Light peach wash, fewer tones, delicate lines — gentle and airy.',
    structure: { ...D.structure, smoothing: 0.7, toneLevels: 3, lineStrength: 0.42, lineWidth: 0.9, gamma: 1.12 },
    style: { light: '#ffe4d4', dark: '#e98a63', ink: '#3a221a', grain: 0.35, brush: 0.5, frame: true },
  },
  boldBrick: {
    label: 'Bold Brick',
    hint: 'Deep brick-red, punchy contrast, heavier shadows — dramatic panel.',
    structure: { ...D.structure, toneLevels: 4, blackPoint: 0.12, gamma: 0.9, lineStrength: 0.6, lineWidth: 1.2 },
    style: { light: '#f3b89c', dark: '#9c2f1c', ink: '#1f0f0a', grain: 0.45, brush: 0.5, frame: true },
  },
  inkHeavy: {
    label: 'Ink Heavy',
    hint: 'Bold, confident outlines and cross-detail — graphic-novel weight.',
    structure: { ...D.structure, smoothing: 0.55, toneLevels: 4, lineStrength: 0.78, lineWidth: 1.6, lineDetail: 0.6, wobble: 0.5 },
    style: { ...D.style, grain: 0.4, brush: 0.4 },
  },
  cleanCel: {
    label: 'Clean Cel',
    hint: 'Flat animation cells — strong smoothing, minimal grain, crisp lines.',
    structure: { ...D.structure, smoothing: 0.85, toneLevels: 3, lineStrength: 0.5, lineWidth: 1.0, wobble: 0.2 },
    style: { ...D.style, grain: 0.12, brush: 0.18 },
  },
  gritty: {
    label: 'Gritty',
    hint: 'Sketchier wobble, more tones, heavy paper grain — rough zine feel.',
    structure: { ...D.structure, smoothing: 0.45, toneLevels: 5, lineStrength: 0.68, lineWidth: 1.2, lineDetail: 0.55, wobble: 0.75 },
    style: { ...D.style, grain: 0.7, brush: 0.7 },
  },
}

export function presetParams(key: StyleKey): ComicParams {
  const p = PRESETS[key]
  return { structure: { ...p.structure }, style: { ...p.style } }
}
