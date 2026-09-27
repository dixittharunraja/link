"use strict";
// Payload transfer — core mechanism used by any plugin that moves bytes rather than just JSON
// (share, link.clipboard.file). The sender opens a brand-new, one-shot TLS server just for this
// transfer, embeds its port in the packet's `payloadTransferInfo`, and the receiver dials in on a
// separate connection to pull the bytes. See docs/PROTOCOL.md §2.
//
// Since this is a SEPARATE TLS connection from the main paired control channel, we verify the
// peer's certificate on it matches the fingerprint already pinned for that device — otherwise
// a payload connection would be trusted less carefully than the control channel it was announced over.
//
// We use OS-assigned ephemeral ports (`port: 0`) for ease of connection setup.
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
exports.startPayloadUpload = startPayloadUpload;
exports.downloadPayload = downloadPayload;
const tls = __importStar(require("tls"));
const crypto = __importStar(require("crypto"));
/** Starts a one-shot TLS server that accepts exactly one connection, streams `data`, then closes. */
function startPayloadUpload(cert, key, data, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const server = tls.createServer({ cert, key, rejectUnauthorized: false });
        const timeout = setTimeout(() => {
            if (!settled) {
                server.close();
                reject(new Error('Timed out waiting for receiver to connect for payload upload'));
            }
        }, timeoutMs);
        server.on('error', (err) => {
            if (!settled)
                reject(err);
        });
        server.on('connection', (socket) => {
            clearTimeout(timeout);
            socket.on('error', () => { }); // swallow socket errors to prevent app crash
        });
        server.on('secureConnection', (socket) => {
            // Stream in 64 KB chunks so the TLS stack can fill the TCP send window
            // continuously rather than blocking on one giant write syscall.
            const CHUNK = 65536;
            let offset = 0;
            function writeNext() {
                while (offset < data.length) {
                    const end = Math.min(offset + CHUNK, data.length);
                    const slice = data.slice(offset, end);
                    offset = end;
                    const more = socket.write(slice);
                    if (!more) {
                        // Back-pressure: wait for drain before writing more
                        socket.once('drain', writeNext);
                        return;
                    }
                }
                socket.end();
            }
            writeNext();
        });
        server.listen(0, '0.0.0.0', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to determine upload server port'));
                return;
            }
            settled = true;
            const done = new Promise((res, rej) => {
                server.on('close', () => res());
                server.on('error', (err) => rej(err));
            });
            resolve({
                info: { port: address.port },
                done,
                cancel: () => server.close(),
            });
        });
    });
}
/**
 * Connects to a peer's ephemeral upload server (from a received `payloadTransferInfo`) and
 * downloads the full payload. `expectedPeerFingerprint` must match the SHA-256 fingerprint
 * already pinned for that device — this is a fresh TLS connection, not automatically covered by
 * the main control channel's established trust.
 */
function downloadPayload(host, port, cert, key, expectedPeerFingerprint) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const socket = tls.connect({ host, port, cert, key, rejectUnauthorized: false }, () => {
            const peerCert = socket.getPeerCertificate();
            if (!peerCert || !peerCert.raw) {
                socket.destroy();
                reject(new Error('Payload connection presented no certificate'));
                return;
            }
            const actualFingerprint = crypto.createHash('sha256').update(peerCert.raw).digest('hex');
            if (actualFingerprint !== expectedPeerFingerprint) {
                socket.destroy();
                reject(new Error('Payload connection certificate does not match pinned device — refusing transfer'));
                return;
            }
        });
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks)));
        socket.on('error', reject);
    });
}
//# sourceMappingURL=payload-transfer.js.map