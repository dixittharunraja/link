"use strict";
// Walkie Talkie — guest-side signaling client. Connects to a WalkieTalkieSignalServer by manual
// IP, computes the same PIN the host does (independently, from both sides' TLS certs — see
// audio-relay-client.ts's identical reasoning for why that's preferred over trusting a
// server-supplied value), and once admitted, carries the same opaque {type, body} signaling
// messages WalkieTalkieTab.tsx already speaks over the trusted-mesh relay for paired devices.
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
exports.WalkieTalkieSignalClient = void 0;
const crypto = __importStar(require("crypto"));
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
const pairing_1 = require("../core/pairing");
class WalkieTalkieSignalClient extends events_1.EventEmitter {
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
    connect() {
        const url = `wss://${this.host}:${this.port}`;
        this.ws = new ws_1.default(url, {
            rejectUnauthorized: false, // self-signed peer, verified at the app layer (PIN) not here
            handshakeTimeout: 15000,
            cert: this.clientCert,
            key: this.clientKey,
        });
        this.ws.on('open', () => {
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
                this.emit('admitted');
            else if (msg.type === 'pin' && !this.pinComputedLocally)
                this.emit('pinComputed', msg.code);
            else
                this.emit('signal', msg.type, msg.body);
        });
        this.ws.on('close', (code, reason) => {
            if (code === 1000 || code === 1001) {
                // Passing the reason through lets callers tell a graceful session end apart from the
                // coordinator kicking just this guest (reason 'removed by host', same normal-closure code)
                // — see audio-sink-client.ts's onWsClose for the identical distinction/reasoning.
                this.emit('ended', reason?.toString());
            }
            else {
                this.emit('closed', reason?.toString() || `code ${code}`);
            }
        });
        this.ws.on('error', (err) => {
            this.emit('error', err);
        });
    }
    send(type, body) {
        try {
            this.ws?.send(JSON.stringify({ type, body }));
        }
        catch { }
    }
    disconnect() {
        try {
            this.ws?.close(1000, 'left');
        }
        catch { }
        this.ws = null;
    }
}
exports.WalkieTalkieSignalClient = WalkieTalkieSignalClient;
//# sourceMappingURL=walkie-talkie-signal-client.js.map