import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig({ plugins: [react(), viteSingleFile()], base: './', build: { outDir: 'dist-demo', rollupOptions: { input: 'demo.html' }, assetsInlineLimit: 100000000, cssCodeSplit: false } });
