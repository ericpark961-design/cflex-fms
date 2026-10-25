import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config.js'

// The HAEA Local Console build (WO-INT-004): the same UI, served by
// apps/console at /twin/ inside a network with no internet. Two differences
// from the portal build, both about leaving the origin:
//   · no Google Fonts link — the system font stack in index.html's body rule
//     already falls back to Helvetica/Arial;
//   · the map screen draws its pins on a plain background instead of
//     fetching OpenFreeMap tiles (MapScreen.jsx, VITE_CFLEX_OFFLINE).
// apps/console/test checks the output for any off-origin reference.
//
//   npm run build:console   →   dist-console/
const stripWebFonts = {
  name: 'cflex-strip-web-fonts',
  transformIndexHtml(html) {
    return html.replace(/\s*<link[^>]+(fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '')
  },
}

export default mergeConfig(base, defineConfig({
  plugins: [stripWebFonts],
  define: { 'import.meta.env.VITE_CFLEX_OFFLINE': JSON.stringify('1') },
  build: { outDir: 'dist-console', emptyOutDir: true },
}))
