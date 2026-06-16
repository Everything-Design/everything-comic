# Everything Comic — Inked Cartoon Studio

Turn any photo into a warm, hand-inked comic panel — entirely in your browser. Nothing is
uploaded to a server; all processing runs client-side in a Web Worker.

It's a sibling to [Engraver](https://github.com/Everything-Design/engraver): same studio shell
(auto-tune, undo/redo, presets, share links, hold-to-compare), but a completely different
engine that recreates the warm-duotone, hand-drawn comic look from the *Making of Animation
Film* illustrations.

## The effect

The pipeline runs photo → comic in five stages:

1. **Edge-preserving smoothing** — a separable bilateral filter flattens photographic detail
   into clean, paintable regions.
2. **Cel posterize** — luminance is tone-mapped (black/white point + gamma) and quantized into
   a few flat colour cells, the way cel animation is shaded.
3. **Duotone gradient map** — the cel tones are recoloured through a single warm hue ramp
   (pale highlight → deep shadow), giving the monochrome coral/brick palette.
4. **XDoG ink lines** — a difference-of-Gaussians pass with an adaptive threshold finds the
   contours and lays down hand-weighted black ink outlines.
5. **Hand-drawn wobble + texture** — a low-frequency noise warp gives the lines a human waver,
   then paper grain and brush variation are composited on top, inside a rounded panel frame.

Palette and texture changes re-render instantly on the main thread; only the structural dials
(smoothing, cel levels, line strength…) trigger a worker recompute.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build to dist/
```

## Deploy

Pushing to `main` builds and publishes to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The Vite `base` is relative, so
the same build also works at a domain root (e.g. Vercel).

## Privacy

Everything happens locally in your browser. Images never leave your device.
