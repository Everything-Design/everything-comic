import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { Controls } from './components/Controls'
import { StyleKey, presetParams } from './engine/palettes'
import { analyze } from './engine/analyze'
import { mapToParams } from './engine/autoParams'
import { drawComic, renderToCanvas, ComicFields } from './render/comicCanvas'
import {
  ComicParams,
  DEFAULT_PARAMS,
  PRESET_VERSION,
  StructureParams,
  StyleParams,
  WorkerRequest,
  WorkerResponse,
} from './types'

const FIELD_LONG = 1280 // working resolution for the compute fields (finer lines)
const EXPORT_LONG = 2200
const COPY_LONG = 1600
const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_SOURCE_DIM = 12000

// Allowed range per structure dial — mirrors the Controls sliders. Used to clamp/sanitize
// loaded presets so a hand-edited or stale JSON can't push the engine out of bounds.
const STRUCTURE_RANGES: Record<keyof StructureParams, [number, number]> = {
  smoothing: [0, 1],
  toneLevels: [2, 6],
  blackPoint: [0, 0.4],
  highlightClip: [0.6, 1],
  gamma: [0.5, 2],
  lineStrength: [0, 1],
  lineWidth: [0.4, 2.5],
  lineWeightContrast: [0, 1],
  lineDetail: [0, 1],
  wobble: [0, 1],
  spottedBlack: [0, 1],
  contactShadow: [0, 1],
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)

function sanitizeParams(obj: unknown): ComicParams | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (!o.structure || typeof o.structure !== 'object') return null
  const src = o.structure as Record<string, unknown>
  const structure = { ...DEFAULT_PARAMS.structure }
  for (const k of Object.keys(STRUCTURE_RANGES) as (keyof StructureParams)[]) {
    const [lo, hi] = STRUCTURE_RANGES[k]
    const raw = src[k]
    const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : (structure[k] as number)
    ;(structure[k] as number) = Math.min(hi, Math.max(lo, num))
  }
  structure.toneLevels = Math.round(structure.toneLevels)

  const st = (o.style ?? {}) as Record<string, unknown>
  const d = DEFAULT_PARAMS.style
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb
  const frame = st.frame === 'none' || st.frame === 'rounded' || st.frame === 'bleed' ? st.frame : d.frame
  const style: StyleParams = {
    inkHue: num(st.inkHue, 0, 360, d.inkHue),
    paperColor: isHex(st.paperColor) ? st.paperColor : d.paperColor,
    shadowHueShift: num(st.shadowHueShift, -40, 40, d.shadowHueShift),
    satBump: num(st.satBump, 0, 1, d.satBump),
    key: num(st.key, -1, 1, d.key),
    ink: isHex(st.ink) ? st.ink : d.ink,
    grain: num(st.grain, 0, 1, d.grain),
    brush: num(st.brush, 0, 1, d.brush),
    bgFlatten: num(st.bgFlatten, 0, 1, d.bgFlatten),
    vignette: num(st.vignette, 0, 1, d.vignette),
    frame,
  }
  return { structure, style }
}

// Downscale an image to a working-resolution ImageData (long edge = FIELD_LONG).
function toFieldImageData(image: ImageBitmap, longSide: number): ImageData {
  const srcW = image.width, srcH = image.height
  const scale = Math.min(1, longSide / Math.max(srcW, srcH))
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  // Composite onto white so transparent PNG cut-outs read as bare paper.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(image, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// --- Share link: pack params into the URL hash, unicode-safe. ---
function encodeParams(p: ComicParams): string {
  return btoa(encodeURIComponent(JSON.stringify({ ...p, version: PRESET_VERSION })))
}
function decodeHashParams(): ComicParams | null {
  const m = location.hash.match(/[#&]p=([^&]+)/)
  if (!m) return null
  try {
    return sanitizeParams(JSON.parse(decodeURIComponent(atob(m[1]))))
  } catch {
    return null
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const compareRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const sourceBitmapRef = useRef<ImageBitmap | null>(null)
  const workerNeedsSourceRef = useRef(false)
  const fieldsRef = useRef<ComicFields | null>(null)
  const reqIdRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSizeRef = useRef({ w: 0, h: 0 })

  const [params, setParams] = useState<ComicParams>(DEFAULT_PARAMS)
  const paramsRef = useRef(params)
  paramsRef.current = params
  const [style, setStyle] = useState<StyleKey | null>(null)
  const [format, setFormat] = useState<'image/png' | 'image/jpeg'>('image/png')
  const [hasImage, setHasImage] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [notesOpen, setNotesOpen] = useState(true)
  const [toast, setToast] = useState<string | null>(null)

  // --- Undo/redo history ---
  const autoParamsRef = useRef<ComicParams>(DEFAULT_PARAMS)
  const historyRef = useRef<ComicParams[]>([])
  const histIndexRef = useRef(-1)
  const histTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hist, setHist] = useState({ canUndo: false, canRedo: false })
  const syncHist = useCallback(() => {
    setHist({
      canUndo: histIndexRef.current > 0,
      canRedo: histIndexRef.current < historyRef.current.length - 1,
    })
  }, [])
  const pushHistory = useCallback((p: ComicParams, reset = false) => {
    if (reset) {
      historyRef.current = [p]
      histIndexRef.current = 0
    } else {
      const stack = historyRef.current.slice(0, histIndexRef.current + 1)
      stack.push(p)
      if (stack.length > 60) stack.shift()
      historyRef.current = stack
      histIndexRef.current = stack.length - 1
    }
    syncHist()
  }, [syncHist])
  const scheduleHistory = useCallback((next: ComicParams) => {
    if (histTimerRef.current) clearTimeout(histTimerRef.current)
    histTimerRef.current = setTimeout(() => pushHistory(next), 450)
  }, [pushHistory])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200)
  }, [])

  // Reallocate the backing store only when the fitted size changed; otherwise just repaint.
  const resize = useCallback((): boolean => {
    const fields = fieldsRef.current
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!fields || !canvas || !stage) return false
    const dpr = window.devicePixelRatio || 1
    const pad = 64
    const aspect = fields.w / fields.h
    let dispW = stage.clientWidth - pad
    let dispH = dispW / aspect
    if (dispH > stage.clientHeight - pad) {
      dispH = stage.clientHeight - pad
      dispW = dispH * aspect
    }
    const bw = Math.max(1, Math.floor(dispW * dpr))
    const bh = Math.max(1, Math.floor(dispH * dpr))
    canvas.style.width = `${Math.floor(dispW)}px`
    canvas.style.height = `${Math.floor(dispH)}px`
    const compare = compareRef.current
    if (compare) {
      compare.style.width = `${Math.floor(dispW)}px`
      compare.style.height = `${Math.floor(dispH)}px`
    }
    if (bw === lastSizeRef.current.w && bh === lastSizeRef.current.h) return false
    canvas.width = bw
    canvas.height = bh
    if (compare) { compare.width = bw; compare.height = bh }
    lastSizeRef.current = { w: bw, h: bh }
    return true
  }, [])

  const redraw = useCallback(() => {
    const fields = fieldsRef.current
    const canvas = canvasRef.current
    if (!fields || !canvas) return
    drawComic(canvas, fields, paramsRef.current.style)
  }, [])

  const render = useCallback(() => {
    resize()
    redraw()
  }, [resize, redraw])

  // Init worker.
  useEffect(() => {
    const worker = new Worker(new URL('./engine/comic.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.id !== reqIdRef.current) return // stale
      if (msg.kind === 'error') {
        setBusy(false)
        setError(msg.message || 'The comic engine reported an error.')
        return
      }
      fieldsRef.current = { w: msg.w, h: msg.h, tone: msg.tone, ink: msg.ink, mask: msg.mask, cx: msg.cx, cy: msg.cy }
      console.debug(
        `[comic] smooth ${msg.timings.smooth.toFixed(1)}ms · ink ${msg.timings.ink.toFixed(1)}ms · total ${msg.timings.total.toFixed(1)}ms`,
      )
      setBusy(false)
      setError(null)
      render()
    }
    worker.onerror = (e) => {
      setBusy(false)
      setError('The comic engine crashed. Try a smaller image, or reload the page.')
      console.error('worker.onerror', e)
    }
    worker.onmessageerror = () => {
      setBusy(false)
      setError('The comic engine sent data this browser could not read.')
    }
    workerRef.current = worker
    workerNeedsSourceRef.current = true
    return () => worker.terminate()
  }, [render])

  // Recompute the fields. Sends the source ONCE per worker (transferred), then params-only
  // messages reuse the worker's cached source.
  const recompute = useCallback((structure: StructureParams) => {
    const worker = workerRef.current
    const bitmap = sourceBitmapRef.current
    if (!worker || !bitmap) return
    setBusy(true)
    setError(null)
    const id = ++reqIdRef.current
    if (workerNeedsSourceRef.current) {
      const src = toFieldImageData(bitmap, FIELD_LONG)
      workerNeedsSourceRef.current = false
      const msg: WorkerRequest = {
        kind: 'source',
        id,
        img: { data: src.data, width: src.width, height: src.height },
        params: structure,
      }
      worker.postMessage(msg, [src.data.buffer])
    } else {
      const msg: WorkerRequest = { kind: 'params', id, params: structure }
      worker.postMessage(msg)
    }
  }, [])

  const scheduleRecompute = useCallback((structure: StructureParams) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => recompute(structure), 200)
  }, [recompute])

  // Structure change -> recompute; style change -> just redraw (instant re-tint/texture).
  const setStructure = useCallback((patch: Partial<StructureParams>) => {
    setParams((prev) => {
      const next = { ...prev, structure: { ...prev.structure, ...patch } }
      scheduleRecompute(next.structure)
      scheduleHistory(next)
      return next
    })
  }, [scheduleRecompute, scheduleHistory])

  const setStyleParams = useCallback((patch: Partial<StyleParams>) => {
    setParams((prev) => {
      const next = { ...prev, style: { ...prev.style, ...patch } }
      requestAnimationFrame(redraw)
      scheduleHistory(next)
      return next
    })
  }, [redraw, scheduleHistory])

  const applyStyle = useCallback((key: StyleKey) => {
    setStyle(key)
    const next = presetParams(key)
    setParams(next)
    pushHistory(next)
    scheduleRecompute(next.structure)
  }, [scheduleRecompute, pushHistory])

  const applyHistory = useCallback((idx: number) => {
    const p = historyRef.current[idx]
    if (!p) return
    histIndexRef.current = idx
    syncHist()
    setStyle(null)
    setParams(p)
    scheduleRecompute(p.structure)
  }, [scheduleRecompute, syncHist])
  const undo = useCallback(() => applyHistory(histIndexRef.current - 1), [applyHistory])
  const redo = useCallback(() => applyHistory(histIndexRef.current + 1), [applyHistory])
  const resetAuto = useCallback(() => {
    const p = autoParamsRef.current
    setStyle(null)
    setParams(p)
    pushHistory(p)
    scheduleRecompute(p.structure)
  }, [pushHistory, scheduleRecompute])

  // Auto-tune: measure the image and derive every dial, then recompute.
  const pendingHashRef = useRef<ComicParams | null>(decodeHashParams())
  const processBitmap = useCallback((bitmap: ImageBitmap) => {
    const auto = mapToParams(analyze(bitmap))
    sourceBitmapRef.current = bitmap
    workerNeedsSourceRef.current = true
    autoParamsRef.current = { structure: auto.structure, style: auto.style }
    setStyle(null)
    setNotes(['Auto-tuned for this image', ...auto.notes])
    setNotesOpen(true)
    setHasImage(true)
    const initial = pendingHashRef.current ?? { structure: auto.structure, style: auto.style }
    pendingHashRef.current = null
    setParams(initial)
    pushHistory(initial, true)
    scheduleRecompute(initial.structure)
  }, [scheduleRecompute, pushHistory])

  const loadFile = useCallback(async (file: File) => {
    setError(null)
    setBusy(true)
    if (file.size > MAX_FILE_BYTES) {
      setError(`That image is ${(file.size / 1024 / 1024).toFixed(0)} MB — too large. Try one under ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
      setBusy(false)
      return
    }
    const isHeic = /heic|heif/i.test(file.type) || /\.he(ic|if)$/i.test(file.name)
    try {
      const bitmap = await createImageBitmap(file)
      if (bitmap.width > MAX_SOURCE_DIM || bitmap.height > MAX_SOURCE_DIM) {
        setError(`That image is ${bitmap.width}×${bitmap.height}px — too large to process. Resize it first.`)
        setBusy(false)
        return
      }
      processBitmap(bitmap)
    } catch (e) {
      if (isHeic) {
        setError('HEIC/HEIF images aren’t supported by this browser. Export as JPG or PNG and try again.')
      } else {
        setError('Could not read that image — it may be corrupt or an unsupported format. Try a PNG or JPG.')
      }
      setBusy(false)
      console.error(e)
    }
  }, [processBitmap])

  // Auto-load a bundled default image on first open so the page isn't blank.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const res = await fetch('default.png')
        if (!res.ok || !active) return
        const bitmap = await createImageBitmap(await res.blob())
        if (!active) return
        setBusy(true)
        processBitmap(bitmap)
      } catch {
        /* no default available — page stays on the upload prompt */
      }
    })()
    return () => { active = false }
  }, [processBitmap])

  const handleExport = useCallback(async () => {
    const fields = fieldsRef.current
    if (!fields) return
    try {
      const cv = renderToCanvas(fields, paramsRef.current.style, EXPORT_LONG)
      const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, format, 0.95))
      if (!blob) { setError('Export failed — could not encode the image.'); return }
      downloadBlob(blob, format === 'image/png' ? 'comic.png' : 'comic.jpg')
    } catch (e) {
      setError('Export failed.')
      console.error(e)
    }
  }, [format])

  const handleCopyImage = useCallback(async () => {
    const fields = fieldsRef.current
    if (!fields) return
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      setError('Copying images isn’t supported in this browser. Use Export instead.')
      return
    }
    try {
      const cv = renderToCanvas(fields, paramsRef.current.style, COPY_LONG)
      const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'))
      if (!blob) return
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      showToast('Image copied to clipboard')
    } catch (e) {
      setError('Could not copy the image.')
      console.error(e)
    }
  }, [showToast])

  const handleShareLink = useCallback(async () => {
    const hash = `#p=${encodeParams(paramsRef.current)}`
    history.replaceState(null, '', hash)
    const url = location.href
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        showToast('Share link copied')
      } else {
        showToast('Link is in the address bar')
      }
    } catch {
      showToast('Link is in the address bar')
    }
  }, [showToast])

  const handleSavePreset = useCallback(() => {
    downloadBlob(
      new Blob([JSON.stringify({ ...paramsRef.current, version: PRESET_VERSION }, null, 2)], { type: 'application/json' }),
      'comic-preset.json',
    )
  }, [])

  const handleLoadPreset = useCallback(async (file: File) => {
    try {
      const obj = JSON.parse(await file.text())
      const clean = sanitizeParams(obj)
      if (!clean) {
        setError('That JSON is not a Comic preset.')
        return
      }
      if (typeof obj.version === 'number' && obj.version !== PRESET_VERSION) {
        showToast(`Preset is v${obj.version} (app is v${PRESET_VERSION}) — values clamped to fit.`)
      }
      setStyle(null)
      setParams(clean)
      pushHistory(clean)
      scheduleRecompute(clean.structure)
    } catch {
      setError('Could not read that preset file.')
    }
  }, [scheduleRecompute, pushHistory, showToast])

  // rAF-throttled resize.
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(render)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf) }
  }, [render])

  // Clipboard paste upload.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) { e.preventDefault(); loadFile(file) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadFile])

  // Keyboard undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // Hold-to-compare with the source.
  const [comparing, setComparing] = useState(false)
  const startCompare = useCallback(() => {
    const bitmap = sourceBitmapRef.current
    const compare = compareRef.current
    if (!bitmap || !compare) return
    const ctx = compare.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, compare.width, compare.height)
    ctx.drawImage(bitmap, 0, 0, compare.width, compare.height)
    setComparing(true)
  }, [])
  const endCompare = useCallback(() => setComparing(false), [])

  // Whole-stage drag-and-drop.
  const [dragging, setDragging] = useState(false)
  const onDragOver = useCallback((e: ReactDragEvent) => { e.preventDefault(); setDragging(true) }, [])
  const onDragLeave = useCallback((e: ReactDragEvent) => {
    if (e.currentTarget === e.target) setDragging(false)
  }, [])
  const onDrop = useCallback((e: ReactDragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) loadFile(file)
  }, [loadFile])

  return (
    <div className="app">
      <Controls
        params={params}
        onStructure={setStructure}
        onStyleChange={setStyleParams}
        onUpload={loadFile}
        onExport={handleExport}
        hasImage={hasImage}
        style={style}
        onSelectStyle={applyStyle}
        format={format}
        onFormatChange={setFormat}
        onSavePreset={handleSavePreset}
        onLoadPreset={handleLoadPreset}
        onUndo={undo}
        onRedo={redo}
        canUndo={hist.canUndo}
        canRedo={hist.canRedo}
        onResetAuto={resetAuto}
        onCopyImage={handleCopyImage}
        onShareLink={handleShareLink}
        busy={busy}
      />
      <main
        className={'stage' + (dragging ? ' stage--drag' : '')}
        ref={stageRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {error && <div className="stage__error" role="alert">{error}</div>}
        {hasImage && notes.length > 0 && notesOpen && (
          <aside className="stage__notes" aria-label="Auto-tune notes">
            <button className="stage__notes-close" onClick={() => setNotesOpen(false)} aria-label="Dismiss notes">×</button>
            {notes.join('  ·  ')}
          </aside>
        )}
        {!hasImage && !error && (
          <div className="stage__empty">
            <p>Upload, drag in, or paste an image to begin.</p>
            <span>Processed entirely in your browser — nothing is uploaded to a server.</span>
          </div>
        )}
        <div className="stage__canvas-wrap" style={{ display: hasImage ? 'block' : 'none' }}>
          <canvas
            ref={canvasRef}
            className="stage__canvas"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startCompare() }}
            onPointerUp={endCompare}
            onPointerCancel={endCompare}
            onPointerLeave={endCompare}
          />
          <canvas
            ref={compareRef}
            className="stage__compare"
            style={{ display: comparing ? 'block' : 'none' }}
            aria-hidden="true"
          />
        </div>
        {hasImage && (
          <div className="stage__hint">Hold the image to compare with the source</div>
        )}
        {busy && <div className="stage__busy" role="status">drawing…</div>}
        {toast && <div className="stage__toast" role="status">{toast}</div>}
        {dragging && <div className="stage__drop">Drop image to comicify</div>}
      </main>
    </div>
  )
}
