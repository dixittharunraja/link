"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Minimal, purpose-built preload for the presenter overlay window — exposes exactly one thing
// (a position update listener) instead of that window running with nodeIntegration:true and
// contextIsolation:false, which gave it unrestricted Node.js access with no sandbox at all.
electron_1.contextBridge.exposeInMainWorld('presenterApi', {
    onPosition: (cb) => electron_1.ipcRenderer.on('presenter-position', (_e, xFraction, yFraction) => cb(xFraction, yFraction)),
});
//# sourceMappingURL=presenter-preload.js.map