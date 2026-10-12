import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Vite configuration for the shared web app — the SAME build output is loaded by the Tauri
// desktop webview and by the Tauri Android WebView (frontendDist in src-tauri/tauri.conf.json).
// bridge.ts is what lets one bundle serve both: it shims the desktop Rust commands and the Android
// native plugin into a single window.link API.
// `tauri android dev` runs the app on a phone, so the dev server must be reachable over the LAN at
// the host the Tauri CLI exports as TAURI_DEV_HOST.
const devHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src'),
  base: './', // Relative asset paths — the bundle is served from the app's own asset origin
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          qrcode: ['qrcode'],
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
