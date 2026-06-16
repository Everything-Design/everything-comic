/// <reference lib="webworker" />
import { computeComic } from './comic'
import { ComicInput, WorkerRequest, WorkerResponse } from '../types'

// The worker caches the working-resolution source so palette/texture tweaks (handled on the
// main thread) never reach it, and structure tweaks reuse the cached pixels instead of
// re-uploading the image on every slider drag.
let source: ComicInput | null = null

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.kind === 'source') {
      source = msg.img
    }
    if (!source) {
      const err: WorkerResponse = { kind: 'error', id: msg.id, message: 'No image loaded yet.' }
      ;(self as DedicatedWorkerGlobalScope).postMessage(err)
      return
    }
    const { w, h, tone, ink, timings } = computeComic(source, msg.params)
    const res: WorkerResponse = { kind: 'result', id: msg.id, w, h, tone, ink, timings }
    // Transfer the field buffers back to avoid a copy.
    ;(self as DedicatedWorkerGlobalScope).postMessage(res, [tone.buffer, ink.buffer])
  } catch (err) {
    const res: WorkerResponse = {
      kind: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : 'The comic engine reported an error.',
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage(res)
  }
}
