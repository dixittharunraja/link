import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// package.json is the one place the version is written (tauri.conf.json reads it too).
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

// One build serves both the desktop webview and the Android WebView (frontendDist in
// src-tauri/tauri.conf.json); src/utils/bridge.ts maps each platform onto a single window.link API.
// `tauri android dev` runs the app on a phone, so the dev server listens on the LAN address the
// Tauri CLI exports as TAURI_DEV_HOST.
const devHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  root: resolve(__dirname, 'src'),
  base: './', // relative asset paths; the bundle is served from the app's own asset origin
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    // No chunkSizeWarningLimit override: heavy tabs, overlays and libraries (qrcode, jsqr) are loaded with
    // dynamic import(), so a chunk over the default 500 kB warning means something heavy became eager again.
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: devHost || false,
    hmr: devHost ? { protocol: 'ws', host: devHost, port: 5174 } : undefined,
  },
});
