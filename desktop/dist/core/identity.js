"use strict";
// Device identity — one per device, generated once, persisted forever.
//
// Architectural rule (see docs/PROTOCOL.md §4): this is the ONE place identity is generated or
// loaded from disk. Every other part of the app (transport, pairing, UI) reads it from here —
// nothing else is allowed to mint its own deviceId.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROTOCOL_VERSION = void 0;
exports.filterDeviceName = filterDeviceName;
exports.isValidDeviceId = isValidDeviceId;
exports.loadOrCreateIdentity = loadOrCreateIdentity;
exports.saveDeviceName = saveDeviceName;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
exports.PROTOCOL_VERSION = 1;
const NAME_INVALID_CHARS = /["',;:.!?()[\]<>]/g;
const MAX_NAME_LENGTH = 32;
function filterDeviceName(input) {
    return input.replace(NAME_INVALID_CHARS, '').slice(0, MAX_NAME_LENGTH);
}
function isValidDeviceId(id) {
    return /^[a-zA-Z0-9_-]{32,38}$/.test(id);
}
function generateDeviceId() {
    // 32 hex chars — comfortably inside KDE Connect's 32-38 char allowed range.
    return crypto.randomBytes(16).toString('hex');
}
/**
 * Loads this device's persistent identity from `configDir/identity.json`, creating it (with a
 * freshly generated deviceId) if it doesn't exist yet. `configDir` is provided by the caller
 * (the Electron main process) so this module stays platform-agnostic and testable.
 */
function loadOrCreateIdentity(configDir, deviceType, capabilities) {
    const identityFile = path.join(configDir, 'identity.json');
    let stored = null;
    try {
        if (fs.existsSync(identityFile)) {
            const parsed = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
            if (parsed && isValidDeviceId(parsed.deviceId)) {
                stored = parsed;
            }
        }
    }
    catch {
        // Corrupt file — fall through and regenerate. Losing an identity means losing all existing
        // pairings (they're keyed by deviceId + pinned cert), but a corrupt file is not recoverable.
    }
    if (!stored) {
        stored = {
            deviceId: generateDeviceId(),
            deviceName: filterDeviceName(os.hostname() || 'My PC'),
        };
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(identityFile, JSON.stringify(stored, null, 2));
    }
    return {
        deviceId: stored.deviceId,
        deviceName: stored.deviceName,
        deviceType,
        protocolVersion: exports.PROTOCOL_VERSION,
        incomingCapabilities: capabilities.incoming,
        outgoingCapabilities: capabilities.outgoing,
    };
}
/** Persists a new device name. Does NOT touch deviceId — renaming never regenerates identity. */
function saveDeviceName(configDir, newName) {
    const identityFile = path.join(configDir, 'identity.json');
    const filtered = filterDeviceName(newName);
    let stored;
    const raw = fs.readFileSync(identityFile, 'utf8');
    stored = JSON.parse(raw);
    stored.deviceName = filtered;
    fs.writeFileSync(identityFile, JSON.stringify(stored, null, 2));
    return filtered;
}
//# sourceMappingURL=identity.js.map