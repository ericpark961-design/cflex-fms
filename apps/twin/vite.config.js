import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served at https://fms.runless.co.uk/twin/ (nginx alias). API stays relative (/v1/...).
// Dev proxy target is env-driven so the same config covers both verification passes:
//   mock API   : node mock/server.js && npm run dev          (default localhost:3001)
//   real server: TWIN_API=https://cflex.runless.co.uk npm run dev
const API = process.env.TWIN_API || 'http://localhost:3001'

export default defineConfig({
  base: '/twin/',
  plugins: [react()],
  build: {
    outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200,
    // Vite inlines assets under 4 KB as data URIs. With the equipment photo
    // library that put 170 product shots into index.js and took it to 2.7 MB —
    // every page load fetching pictures it may never show. Emitted as files
    // they are fetched only when a device panel actually asks for one, which
    // is what the <img loading="lazy"> on them is for.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5174,
    proxy: { '/v1': { target: API, changeOrigin: true, secure: true } },
  },
})
