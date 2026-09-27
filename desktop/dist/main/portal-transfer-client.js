"use strict";
// Portal Mode — sender side. Mirrors portal-transfer-server.ts's protocol exactly (see that
// file's header comment) and audio-relay-client.ts's connection/PIN pattern — connects with this
// device's own long-lived TLS identity, announces intent as the first message, then either waits
// for a human PIN-confirm (guest path) or is admitted immediately (paired-token path).
//
// Once admitted, sends a {"type":"batch-info","count":N} message, then for each file in order a
// {"type":"file-info"} JSON message followed by that file's bytes as binary WS frames in 64KB
// pieces (same chunk size as payload-transfer.ts's upload path), respecting backpressure via ws's
// own bufferedAmount. The server sends one 'received' ack only once all N files have arrived.
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
exports.PortalTransferClient = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
const pairing_1 = require("../core/pairing");
const CHUNK_SIZE = 262144; // 256KB chunks for maximum throughput
class PortalTransferClient extends events_1.EventEmitter {
    host;
    port;
    clientCert;
    clientKey;
    localDeviceName;
    ws = null;
    pinComputedLocally = false;
    constructor(host, port, clientCert, clientKey, localDeviceName) {
        super();
        this.host = host;
        this.port = port;
        this.clientCert = clientCert;
        this.clientKey = clientKey;
        this.localDeviceName = localDeviceName;
    }
    connect(mode) {
        const url = `wss://${this.host}:${this.port}`;
        this.ws = new ws_1.default(url, {
            rejectUnauthorized: false,
            handshakeTimeout: 15000,
            cert: this.clientCert,
            key: this.clientKey,
        });
        this.ws.on('open', () => {
            if (mode.kind === 'token') {
                this.ws.send(JSON.stringify({ type: 'join-token', token: mode.token }));
            }
            else {
                this.pinComputedLocally = false;
                const peerCert = this.ws._socket?.getPeerCertificate?.();
                if (peerCert && peerCert.raw) {
                    try {
                        const peerPublicKeyDer = new crypto.X509Certificate(peerCert.raw).publicKey.export({ type: 'spki', format: 'der' });
                        const myPublicKeyDer = new crypto.X509Certificate(this.clientCert).publicKey.export({ type: 'spki', format: 'der' });
                        const pin = (0, pairing_1.computeVerificationCode)(myPublicKeyDer, peerPublicKeyDer);
                        this.pinComputedLocally = true;
                        this.emit('pinComputed', pin);
                    }
                    catch (e) {
                        this.emit('error', new Error('Failed to compute PIN: ' + e.message));
                    }
                }
                this.ws.send(JSON.stringify({ type: 'join-guest', deviceName: this.localDeviceName }));
            }
        });
        this.ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            if (msg.type === 'admitted')
                this.emit('admitted', msg.deviceName);
            else if (msg.type === 'received')
                this.emit('complete');
            else if (msg.type === 'pin' && !this.pinComputedLocally)
                this.emit('pinComputed', msg.code);
        });
        this.ws.on('close', (code, reason) => {
            if (code === 1000 || code === 1001) {
                this.emit('ended');
            }
            else {
                this.emit('closed', reason?.toString() || `code ${code}`);
            }
        });
        this.ws.on('error', (err) => {
            this.emit('error', err);
        });
    }
    /** Streams every file in filePaths, in order, to the (already-admitted) receiver over the same
     *  connection — one batch-info announcing the count, then one file-info + binary frames per
     *  file. Rejects if not currently admitted/open — callers should only invoke this after the
     *  'admitted' event has fired. The server only sends its final 'received' ack (see 'complete')
     *  once every file in the batch has arrived. */
    async sendFiles(files) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            throw new Error('Not connected');
        }
        this.ws.send(JSON.stringify({ type: 'batch-info', count: files.length }));
        for (let i = 0; i < files.length; i++) {
            this.emit('fileStarted', i, files.length, files[i].relPath);
            await this.sendOneFile(files[i].localPath, files[i].relPath);
        }
    }
    sendOneFile(filePath, relPath) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
                reject(new Error('Not connected'));
                return;
            }
            let stat;
            try {
                stat = fs.statSync(filePath);
            }
            catch (e) {
                reject(new Error('Failed to read file: ' + e.message));
                return;
            }
            this.ws.send(JSON.stringify({ type: 'file-info', name: relPath, size: stat.size }));
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(CHUNK_SIZE);
            let offset = 0;
            const total = stat.size;
            const writeNext = () => {
                if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
                    fs.closeSync(fd);
                    reject(new Error('Connection closed mid-transfer'));
                    return;
                }
                if (offset >= total) {
                    fs.closeSync(fd);
                    resolve();
                    return;
                }
                const bytesRead = fs.readSync(fd, buffer, 0, Math.min(CHUNK_SIZE, total - offset), offset);
                const slice = Buffer.from(buffer.subarray(0, bytesRead));
                offset += bytesRead;
                this.emit('progress', offset, total);
                this.ws.send(slice, { binary: true }, (err) => {
                    if (err) {
                        fs.closeSync(fd);
                        reject(err);
                        return;
                    }
                    // Respect backpressure — don't queue the whole file in ws's internal buffer if the
                    // receiver is draining slower than we can read local disk (same reasoning as
                    // fs-mount-service.ts's chunked download loop).
                    if (this.ws.bufferedAmount > CHUNK_SIZE * 4) {
                        setImmediate(writeNext);
                    }
                    else {
                        writeNext();
                    }
                });
            };
            writeNext();
        });
    }
    disconnect() {
        if (this.ws) {
            // Explicit code+reason (matching audio-sink-client.ts/walkie-talkie-signal-client.ts's
            // disconnect()) rather than a bare close() — a codeless close can locally resolve to a
            // non-1000/1001 code (e.g. 1005), which onWsClose's fallback would otherwise surface as a
            // raw "code 1005" error for what was actually just us intentionally hanging up.
            try {
                this.ws.close(1000, 'left');
            }
            catch { }
            this.ws = null;
        }
    }
}
exports.PortalTransferClient = PortalTransferClient;
//# sourceMappingURL=portal-transfer-client.js.map