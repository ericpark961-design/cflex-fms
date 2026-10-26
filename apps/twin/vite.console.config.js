import fs from 'node:fs'
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config.js'
import { PORTAL_ROUTES } from './src/profile.js'

// The HAEA Local Console build (WO-INT-004, WO-INT-004c): the same UI, served
// by apps/console at /twin/ inside a network with no internet.
//
// Leaving the origin — two differences from the portal build:
//   · no Google Fonts link — the system font stack in index.html's body rule
//     already falls back to Helvetica/Arial;
//   · the map screen draws its pins on a plain background instead of
//     fetching OpenFreeMap tiles (MapScreen.jsx, VITE_CFLEX_OFFLINE).
//
// The internal profile (CONSOLE_PROFILE=internal, the default here;
// DECISIONS Q-2026-10-25-09 (B)) — no portal-scope screen:
//   · __CFLEX_PROFILE__ = "internal" compiles the 3D twin, NOC wall, power
//     chain, map and Copilot out of App.jsx (src/profile.js);
//   · the screen templates lose their links to them (menu entries, the
//     Copilot buttons and the ask-the-AI form), and the menu's "FMS 1.x" entry
//     — a page the console does not have — points at the console's Settings.
// CONSOLE_PROFILE=portal builds the console variant with every screen.
// apps/console/test checks the output for any off-origin reference and, for
// the internal profile, any route to a portal screen.
//
//   npm run build:console   →   dist-console/
const PROFILE = process.env.CONSOLE_PROFILE === 'portal' ? 'portal' : 'internal'

const stripWebFonts = {
  name: 'cflex-strip-web-fonts',
  transformIndexHtml(html) {
    return html.replace(/\s*<link[^>]+(fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '')
  },
}

const routes = PORTAL_ROUTES.join('|')
const portalLink = new RegExp(`\\s*<a\\b[^>]*\\bhref="#/(?:${routes})(?:[?/][^"]*)?"[^>]*>[\\s\\S]*?</a>`, 'g')
const portalForm = new RegExp(`\\s*<form\\b[^>]*\\baction="#/(?:${routes})[^"]*"[^>]*>[\\s\\S]*?</form>`, 'g')
const legacyAdmin = /(<a\b[^>]*\bhref=")\/fms("[^>]*>[\s\S]*?)FMS 1\.x \(관리\)(\s*<\/a>)/g

/** A screen template with the portal screens' entry points taken out. */
export function internalTemplate(html) {
  return html.replace(portalLink, '').replace(portalForm, '').replace(legacyAdmin, '$1/settings$2설정$3')
}

// Templates are imported as `?raw`; this loads them first, already stripped.
// And App.jsx's one import of the portal screens resolves to the empty stub,
// so three, maplibre-gl and their CSS are not even in the module graph.
const internalTemplates = {
  name: 'cflex-internal-templates',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (source !== './portalScreens' || !importer) return null
    return this.resolve('./portalScreens.internal.js', importer, { skipSelf: true })
  },
  load(id) {
    const [file, query] = id.split('?')
    if (query !== 'raw' || !file.endsWith('.tpl.html')) return null
    return `export default ${JSON.stringify(internalTemplate(fs.readFileSync(file, 'utf8')))}`
  },
}

export default mergeConfig(base, defineConfig({
  plugins: [stripWebFonts, ...(PROFILE === 'internal' ? [internalTemplates] : [])],
  define: {
    'import.meta.env.VITE_CFLEX_OFFLINE': JSON.stringify('1'),
    __CFLEX_PROFILE__: JSON.stringify(PROFILE),
  },
  build: { outDir: 'dist-console', emptyOutDir: true },
}))
