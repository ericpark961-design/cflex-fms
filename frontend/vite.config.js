import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VITE_CONSOLE_PROFILE=internal (npm run build:console) is the HAEA Local Console build (D-16):
//   · maplibre-gl is swapped for a stub — the alarm map is hidden and its tiles are off-origin;
//   · no Google Fonts — IBM Plex ships in the bundle (@fontsource, src/main.jsx);
//   · served by apps/console at /fms/ (CONSOLE_UI_DIR → dist-console/).
const internal = process.env.VITE_CONSOLE_PROFILE === 'internal'
const stub = (f) => fileURLToPath(new URL(`./src/stubs/${f}`, import.meta.url))

export default defineConfig({
  base: '/fms/',
  plugins: [react()],
  resolve: {
    alias: internal ? [
      { find: /^maplibre-gl\/dist\/maplibre-gl\.css$/, replacement: stub('empty.css') },
      { find: /^maplibre-gl$/, replacement: stub('maplibre.js') },
    ] : [],
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 2000 },
})
