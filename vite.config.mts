import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Vite configuration for the shared web app — the SAME build output is loaded by the Electron
// renderer (via loadFile on dist/renderer/index.html) and by Capacitor on Android (webDir in
// capacitor.config.ts points straight at this directory). bridge.ts is what lets one bundle serve
// both: it shims Electron IPC and the Capacitor plugin into a single window.link API.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src'),
  base: './', // Relative asset paths — required by both Electron's file:// load and Capacitor
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
  },
});
