import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { serwist } from '@serwist/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = path.dirname(fileURLToPath(import.meta.url))

// `--mode desktop` builds the app for the Tauri shell (desktop/): no PWA/service worker, its own
// output folder, and VITE_DESKTOP=1 from .env.desktop.
export default defineConfig(({ mode }) => ({
  build: mode === 'desktop' ? { outDir: 'dist-desktop', emptyOutDir: true } : undefined,
  // The Tauri dev server URL is fixed in desktop/src-tauri/tauri.conf.json.
  server: mode === 'desktop' ? { port: 1420, strictPort: true } : undefined,
  clearScreen: mode === 'desktop' ? false : undefined,
  plugins: [
    react(),
    mode !== 'desktop' && serwist({
      swSrc: 'src/sw.ts',
      swDest: 'sw.js',
      globDirectory: 'dist',
      injectionPoint: 'self.__SW_MANIFEST',
      rollupFormat: 'iife',
      globPatterns: ['**/*.{js,css,html,svg,ico,png,webp,woff2,webmanifest}'],
    }),
  ],
  resolve: {
    alias: [
      // Web builds get a stub, so no Tauri code ships to browsers.
      { find: /^@\/lib\/desktop$/, replacement: path.resolve(projectDir, mode === 'desktop' ? './src/lib/desktop.ts' : './src/lib/desktop-web.ts') },
      { find: '@', replacement: path.resolve(projectDir, './src') },
    ],
  },
}))
