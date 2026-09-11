import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'in.rodix.link',
  appName: 'Link',
  // Points straight at Vite's output. This is what removed the old build step that wiped and
  // re-copied the renderer bundle into mobile/www on every Android build — Capacitor now reads
  // the same directory Electron loads from, so there is one build artifact rather than a copy.
  webDir: 'dist/renderer',
};

export default config;
