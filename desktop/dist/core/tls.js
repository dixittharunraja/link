"use strict";
// TLS identity — self-signed certificate generated once per device, reused forever.
//
// Trust model (docs/PROTOCOL.md §5):
//   - Unpaired connections: no peer verification, just get the socket up for pairing.
//   - Paired connections: verify the peer's cert matches exactly the one pinned at pairing time.
// Regenerating this device's own cert invalidates every existing pairing, since peer trust is
// bound to the specific certificate, not just the deviceId.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadOrCreateTlsIdentity = loadOrCreateTlsIdentity;
exports.certFingerprint = certFingerprint;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const selfsigned_1 = __importDefault(require("selfsigned"));
/**
 * Loads this device's TLS cert+key from `configDir`, generating a new self-signed pair (valid
 * ~10 years) if none exists yet.
 */
function loadOrCreateTlsIdentity(configDir, deviceId) {
    const certFile = path.join(configDir, 'cert.pem');
    const keyFile = path.join(configDir, 'key.pem');
    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
        return {
            cert: fs.readFileSync(certFile, 'utf8'),
            key: fs.readFileSync(keyFile, 'utf8'),
        };
    }
    const attrs = [{ name: 'commonName', value: deviceId }];
    const pems = selfsigned_1.default.generate(attrs, {
        days: 3650,
        keySize: 2048,
        algorithm: 'sha256',
    });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    return { cert: pems.cert, key: pems.private };
}
/** SHA-256 fingerprint of a PEM certificate, as a hex string — used for the pairing verification key. */
function certFingerprint(pem) {
    const crypto = require('crypto');
    const der = pemToDer(pem);
    return crypto.createHash('sha256').update(der).digest('hex');
}
function pemToDer(pem) {
    const base64 = pem
        .replace(/-----BEGIN CERTIFICATE-----/, '')
        .replace(/-----END CERTIFICATE-----/, '')
        .replace(/\s+/g, '');
    return Buffer.from(base64, 'base64');
}
//# sourceMappingURL=tls.js.map