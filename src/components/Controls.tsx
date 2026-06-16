import { CSSProperties, useState } from 'react'
import { PRESETS, StyleKey, DUOTONES } from '../engine/palettes'
import { ComicParams, StructureParams, StyleParams } from '../types'

interface Props {
  params: ComicParams
  onStructure: (patch: Partial<StructureParams>) => void
  onStyleChange: (patch: Partial<StyleParams>) => void
  onUpload: (file: File) => void
  onExport: () => void
  hasImage: boolean
  style: StyleKey | null
  onSelectStyle: (key: StyleKey) => void
  format: 'image/png' | 'image/jpeg'
  onFormatChange: (f: 'image/png' | 'image/jpeg') => void
  onSavePreset: () => void
  onLoadPreset: (file: File) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onResetAuto: () => void
  onCopyImage: () => void
  onShareLink: () => void
  busy: boolean
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  hint: string
  display?: string
  onChange: (v: number) => void
}) {
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100
  return (
    <label className="control" title={props.hint}>
      <span className="control__row">
        <span className="control__label">{props.label}</span>
        <span className="control__val">{props.display ?? props.value.toFixed(2)}</span>
      </span>
      <input
        className="slider"
        style={{ '--fill': `${pct}%` } as CSSProperties}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-label={`${props.label}. ${props.hint}`}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

export function Controls(p: Props) {
  const s = p.params.structure
  const st = p.params.style
  const set = p.onStructure
  const [advanced, setAdvanced] = useState(false)

  return (
    <aside className="panel">
      <header className="brand">
        <span className="brand__mark">EVERYTHING<br />COMIC</span>
        <span className="brand__sub">INKED<br />CARTOON<br />STUDIO</span>
      </header>

      <label className="upload">
        {p.hasImage ? 'Replace image' : 'Upload image'}
        <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && p.onUpload(e.target.files[0])} />
      </label>

      <div className="toolbar" role="group" aria-label="History">
        <button className="tool" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (⌘Z)" aria-label="Undo">↶ Undo</button>
        <button className="tool" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">↷ Redo</button>
        <button className="tool" onClick={p.onResetAuto} disabled={!p.hasImage} title="Reset every dial to the auto-tuned values for this image">Reset to auto</button>
      </div>

      <div className="seg" role="group" aria-label="Detail level">
        <button className={'seg__btn' + (!advanced ? ' seg__btn--active' : '')} onClick={() => setAdvanced(false)} aria-pressed={!advanced}>Simple</button>
        <button className={'seg__btn' + (advanced ? ' seg__btn--active' : '')} onClick={() => setAdvanced(true)} aria-pressed={advanced}>Advanced</button>
      </div>

      <section className="card">
        <h2 className="card__title">Style</h2>
        <div className="styles">
          {(Object.keys(PRESETS) as StyleKey[]).map((k) => (
            <button
              key={k}
              className={'style' + (p.style === k ? ' style--active' : '')}
              onClick={() => p.onSelectStyle(k)}
              title={PRESETS[k].hint}
              aria-pressed={p.style === k}
            >
              {PRESETS[k].label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Cel shading</h2>
        <Slider label="Tone levels" value={s.toneLevels} min={2} max={6} step={1} display={`${s.toneLevels}`} hint="Number of flat colour cells from highlight to shadow. Fewer = bolder, more graphic." onChange={(v) => set({ toneLevels: v })} />
        <Slider label="Gamma" value={s.gamma} min={0.5} max={2} step={0.01} hint="Midtone bias. Below 1 darkens midtones (moodier); above 1 lifts them (brighter)." onChange={(v) => set({ gamma: v })} />
        {advanced && <>
          <Slider label="Smoothing" value={s.smoothing} min={0} max={1} step={0.01} hint="Edge-preserving flatten. Higher = cleaner cartoon cells, less photo texture." onChange={(v) => set({ smoothing: v })} />
          <Slider label="Black point" value={s.blackPoint} min={0} max={0.4} step={0.01} hint="Luminance that maps to the darkest fill. Raise to deepen shadows." onChange={(v) => set({ blackPoint: v })} />
          <Slider label="Highlight clip" value={s.highlightClip} min={0.6} max={1} step={0.01} hint="Luminance above which the lightest fill is used. Lower to bring detail into highlights." onChange={(v) => set({ highlightClip: v })} />
        </>}
      </section>

      <section className="card">
        <h2 className="card__title">Ink lines</h2>
        <Slider label="Line strength" value={s.lineStrength} min={0} max={1} step={0.01} hint="How many edges become ink outlines. Higher = more, denser linework." onChange={(v) => set({ lineStrength: v })} />
        <Slider label="Line width" value={s.lineWidth} min={0.4} max={2.5} step={0.05} hint="Thickness of the ink outlines." onChange={(v) => set({ lineWidth: v })} />
        {advanced && <>
          <Slider label="Line detail" value={s.lineDetail} min={0} max={1} step={0.01} hint="Fine, delicate edges (low) ↔ bold, simplified contours (high)." onChange={(v) => set({ lineDetail: v })} />
          <Slider label="Wobble" value={s.wobble} min={0} max={1} step={0.01} hint="Hand-drawn waviness of the lines and cell edges. Higher = sketchier, more human." onChange={(v) => set({ wobble: v })} />
        </>}
      </section>

      <section className="card">
        <h2 className="card__title">Duotone</h2>
        <div className="swatches">
          {DUOTONES.map((d) => {
            const active = d.light === st.light && d.dark === st.dark
            return (
              <button
                key={d.name}
                className={'swatch' + (active ? ' swatch--active' : '')}
                title={d.name}
                aria-label={d.name}
                aria-pressed={active}
                style={{ background: `linear-gradient(135deg, ${d.light} 0 50%, ${d.dark} 50% 100%)`, borderColor: d.ink }}
                onClick={() => p.onStyleChange({ light: d.light, dark: d.dark, ink: d.ink })}
              />
            )
          })}
        </div>
        <div className="pickers">
          <label className="control control--inline">
            <span className="control__label">Light</span>
            <input type="color" aria-label="Light fill colour" value={st.light} onChange={(e) => p.onStyleChange({ light: e.target.value })} />
          </label>
          <label className="control control--inline">
            <span className="control__label">Dark</span>
            <input type="color" aria-label="Dark fill colour" value={st.dark} onChange={(e) => p.onStyleChange({ dark: e.target.value })} />
          </label>
          <label className="control control--inline">
            <span className="control__label">Ink</span>
            <input type="color" aria-label="Ink line colour" value={st.ink} onChange={(e) => p.onStyleChange({ ink: e.target.value })} />
          </label>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Paper &amp; frame</h2>
        <Slider label="Paper grain" value={st.grain} min={0} max={1} step={0.01} hint="Fine speckled paper texture over the whole panel." onChange={(v) => p.onStyleChange({ grain: v })} />
        <Slider label="Brush texture" value={st.brush} min={0} max={1} step={0.01} hint="Uneven, painterly variation within each colour cell." onChange={(v) => p.onStyleChange({ brush: v })} />
        <label className="control control--inline" title="Wrap the panel in a rounded comic frame with a white margin.">
          <span className="control__label">Panel frame</span>
          <input type="checkbox" className="checkbox" checked={st.frame} aria-label="Panel frame" onChange={(e) => p.onStyleChange({ frame: e.target.checked })} />
        </label>
      </section>

      <section className="card">
        <h2 className="card__title">Export</h2>
        <div className="seg" role="group" aria-label="Export format">
          <button className={'seg__btn' + (p.format === 'image/png' ? ' seg__btn--active' : '')} onClick={() => p.onFormatChange('image/png')} aria-pressed={p.format === 'image/png'}>PNG</button>
          <button className={'seg__btn' + (p.format === 'image/jpeg' ? ' seg__btn--active' : '')} onClick={() => p.onFormatChange('image/jpeg')} aria-pressed={p.format === 'image/jpeg'}>JPG</button>
        </div>
        <button className="export" disabled={!p.hasImage || p.busy} onClick={p.onExport}>
          {p.busy ? 'Working…' : `Export ${p.format === 'image/png' ? 'PNG' : 'JPG'}`}
        </button>
        <div className="seg" style={{ marginTop: 8 }}>
          <button className="seg__btn" onClick={p.onCopyImage} disabled={!p.hasImage} title="Copy the comic to the clipboard as a PNG">Copy image</button>
          <button className="seg__btn" onClick={p.onShareLink} disabled={!p.hasImage} title="Copy a link that restores these settings">Share link</button>
        </div>
        <div className="seg" style={{ marginTop: 8 }}>
          <button className="seg__btn" onClick={p.onSavePreset}>Save preset</button>
          <label className="seg__btn" style={{ cursor: 'pointer', textAlign: 'center' }}>
            Load preset
            <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && p.onLoadPreset(e.target.files[0])} />
          </label>
        </div>
      </section>
    </aside>
  )
}
