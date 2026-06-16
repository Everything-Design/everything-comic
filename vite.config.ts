import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative base so the build works both at a domain root (Vercel) and under a
  // project subpath (GitHub Pages: /<repo>/), including the bundled web worker.
  base: './',
  plugins: [react()],
})
