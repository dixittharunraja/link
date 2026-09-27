"use strict";
// Trust store — persists which devices are paired and their pinned certificates.
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
exports.TrustStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class TrustStore {
    configDir;
    file;
    devices;
    constructor(configDir) {
        this.configDir = configDir;
        this.file = path.join(configDir, 'trusted-devices.json');
        this.devices = this.load();
    }
    load() {
        try {
            if (fs.existsSync(this.file)) {
                const raw = fs.readFileSync(this.file);
                // Try parsing as plain text JSON first for migration
                try {
                    const arr = JSON.parse(raw.toString('utf8'));
                    // Successfully parsed plain text, write it back encrypted to migrate
                    this.devices = new Map(arr.map((d) => [d.deviceId, d]));
                    this.persist();
                    return this.devices;
                }
                catch {
                    // If it fails to parse as plain JSON, it's encrypted. Decrypt it.
                    const { safeStorage } = require('electron');
                    if (safeStorage.isEncryptionAvailable()) {
                        const decrypted = safeStorage.decryptString(raw);
                        const arr = JSON.parse(decrypted);
                        return new Map(arr.map((d) => [d.deviceId, d]));
                    }
                    else {
                        console.error('[Link] safeStorage is not available but the file is encrypted');
                    }
                }
            }
        }
        catch (e) {
            console.error('[Link] Failed to load trusted devices:', e);
        }
        return new Map();
    }
    persist() {
        fs.mkdirSync(this.configDir, { recursive: true });
        const jsonStr = JSON.stringify([...this.devices.values()], null, 2);
        try {
            const { safeStorage } = require('electron');
            if (safeStorage.isEncryptionAvailable()) {
                const encrypted = safeStorage.encryptString(jsonStr);
                fs.writeFileSync(this.file, encrypted);
                return;
            }
        }
        catch (e) {
            console.error('[Link] safeStorage encryption failed, saving as plain text:', e);
        }
        fs.writeFileSync(this.file, jsonStr, 'utf8');
    }
    isPaired(deviceId) {
        return this.devices.has(deviceId);
    }
    get(deviceId) {
        return this.devices.get(deviceId);
    }
    pair(device) {
        this.devices.set(device.deviceId, device);
        this.persist();
    }
    /** Removes trust for a device. Must be called on BOTH the initiating and receiving side of an unpair. */
    unpair(deviceId) {
        this.devices.delete(deviceId);
        this.persist();
    }
    list() {
        return [...this.devices.values()];
    }
    rename(deviceId, newName) {
        const dev = this.devices.get(deviceId);
        if (dev) {
            dev.deviceName = newName;
            this.persist();
        }
    }
    updateLastKnownIp(deviceId, ip) {
        const dev = this.devices.get(deviceId);
        if (dev && dev.lastKnownIp !== ip) {
            dev.lastKnownIp = ip;
            this.persist();
        }
    }
}
exports.TrustStore = TrustStore;
//# sourceMappingURL=trust.js.map