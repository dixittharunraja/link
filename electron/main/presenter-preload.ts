import { contextBridge, ipcRenderer } from 'electron';

// Minimal, purpose-built preload for the presenter overlay window — exposes exactly one thing
// (a position update listener) instead of that window running with nodeIntegration:true and
// contextIsolation:false, which gave it unrestricted Node.js access with no sandbox at all.
contextBridge.exposeInMainWorld('presenterApi', {
  onPosition: (cb: (xFraction: number, yFraction: number) => void) =>
    ipcRenderer.on('presenter-position', (_e, xFraction, yFraction) => cb(xFraction, yFraction)),
});
