"use strict";
// Walkie Talkie — guest-facing signaling server. Unlike Audio Relay/Remote Mic, this carries no
// media at all (Walkie Talkie's audio is WebRTC, peer-to-peer) — this is purely a TLS+WebSocket
// channel for an unpaired guest to reach the SAME session-membership/SDP/ICE protocol that
// already-paired devices exchange over their main trusted connection (see main.ts's
// link.walkietalkie.* packet relay). Deliberately isolated from DeviceManager/TrustStore, same as
// every other ephemeral Tools plugin — an admitted guest here is never added to the paired mesh.
//
// Admission is guest-only (PIN, computed from both sides' public keys via computeVerificationCode
// — same mechanism Audio Relay/Remote Mic/Portal already use) — there's no paired-token fast path
// here, because a paired device already has a working signaling channel (the main connection) and
// never needs this server at all.
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
exports.WalkieTalkieSignalServer = void 0;
const https = __importStar(require("https"));
const crypto = __importStar(require("crypto"));
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
const pairing_1 = require("../core/pairing");
const GUEST_CONFIRM_TIMEOUT_MS = 30000;
class WalkieTalkieSignalServer extends events_1.EventEmitter {
    cert;
    key;
    port;
    isBlocked;
    httpsServer = null;
    wss = null;
    myPublicKeyDer;
    pendingGuests = new Map();
    admittedGuests = new Map();
    constructor(cert, key, port, 
    // Checked against the connecting IP — lets a Blocklist entry cut off an IP from this guest
    // channel too, not just the main paired-device connection. Defaults to "never blocked" so
    // existing callers/tests that don't pass one keep working unchanged.
    isBlocked = () => false) {
        super();
        this.cert = cert;
        this.key = key;
        this.port = port;
        this.isBlocked = isBlocked;
        this.myPublicKeyDer = new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
    }
    start() {
        return new Promise((resolve, reject) => {
            this.httpsServer = https.createServer({
                cert: this.cert,
                key: this.key,
                // Same reasoning as the main device connection and every other guest-session server:
                // accept any cert at the raw TLS layer (self-signed, no CA), verify identity ourselves at
                // the application layer (here: extracting the peer's public key to compute the PIN).
                requestCert: true,
                rejectUnauthorized: false,
            });
            this.wss = new ws_1.default.Server({ server: this.httpsServer });
            this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
            this.httpsServer.on('error', (err) => {
                this.emit('error', err);
                reject(err);
            });
            this.httpsServer.listen(this.port, () => resolve());
        });
    }
    acceptGuest(connId) {
        const pending = this.pendingGuests.get(connId);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pendingGuests.delete(connId);
        this.admittedGuests.set(connId, { ws: pending.ws, remoteAddress: pending.remoteAddress, deviceName: pending.deviceName });
        try {
            pending.ws.send(JSON.stringify({ type: 'admitted' }));
        }
        catch { }
        this.emit('guestJoined', connId, pending.remoteAddress, pending.deviceName);
    }
    rejectGuest(connId) {
        const pending = this.pendingGuests.get(connId);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pendingGuests.delete(connId);
        try {
            pending.ws.close(4007, 'rejected by host');
        }
        catch { }
    }
    getPendingGuestRemoteAddress(connId) {
        return this.pendingGuests.get(connId)?.remoteAddress ?? null;
    }
    getGuestRemoteAddress(connId) {
        return this.admittedGuests.get(connId)?.remoteAddress ?? null;
    }
    /** Sends an opaque {type, body} signaling message to one specific admitted guest — the actual
     *  session-membership/WebRTC-negotiation meaning of type/body is entirely WalkieTalkieTab.tsx's
     *  concern, mirroring how main.ts's link.walkietalkie.* relay never interprets them either. */
    sendTo(connId, type, body) {
        const guest = this.admittedGuests.get(connId);
        if (!guest)
            return;
        try {
            guest.ws.send(JSON.stringify({ type, body }));
        }
        catch { }
    }
    kickGuest(connId) {
        const guest = this.admittedGuests.get(connId);
        if (!guest)
            return;
        try {
            guest.ws.close(1000, 'removed by host');
        }
        catch { }
    }
    handleConnection(ws, req) {
        const socket = req.socket;
        const peerCert = socket.getPeerCertificate();
        if (!peerCert || !peerCert.raw) {
            ws.close(4001, 'no client certificate presented');
            return;
        }
        let peerPublicKeyDer;
        try {
            peerPublicKeyDer = new crypto.X509Certificate(peerCert.raw).publicKey.export({ type: 'spki', format: 'der' });
        }
        catch {
            ws.close(4002, 'invalid certificate');
            return;
        }
        const remoteAddress = req.socket.remoteAddress || 'unknown';
        const connId = crypto.randomUUID();
        if (this.isBlocked(remoteAddress)) {
            ws.close(4010, 'blocked');
            return;
        }
        const onFirstMessage = (data) => {
            ws.off('message', onFirstMessage);
            let msg;
            try {
                msg = JSON.parse(data.toString('utf8'));
            }
            catch {
                ws.close(4003, 'malformed join message');
                return;
            }
            if (msg.type !== 'join-guest') {
                ws.close(4004, 'unknown join type');
                return;
            }
            const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName : 'Guest';
            const pin = (0, pairing_1.computeVerificationCode)(this.myPublicKeyDer, peerPublicKeyDer);
            const timeout = setTimeout(() => {
                this.pendingGuests.delete(connId);
                try {
                    ws.close(4006, 'confirmation timed out');
                }
                catch { }
            }, GUEST_CONFIRM_TIMEOUT_MS);
            this.pendingGuests.set(connId, { ws, pin, timeout, remoteAddress, deviceName });
            // Fallback for clients that can't independently pull their own TLS peer certificate to
            // compute the PIN themselves (a real constraint on Android's WS client library) — see
            // audio-relay-server.ts's identical comment for the full reasoning.
            try {
                ws.send(JSON.stringify({ type: 'pin', code: pin }));
            }
            catch { }
            this.emit('guestPinPending', connId, pin, remoteAddress, deviceName);
            // Every message from here on (post-join, pre- or post-admission) is a generic signaling
            // envelope — dropped silently if it arrives before acceptGuest() admits this connId, so a
            // guest can't smuggle session traffic in before the human accept gate.
            ws.on('message', (data2) => {
                if (!this.admittedGuests.has(connId))
                    return;
                try {
                    const m = JSON.parse(data2.toString('utf8'));
                    this.emit('signal', connId, m.type, m.body);
                }
                catch { }
            });
        };
        ws.on('message', onFirstMessage);
        ws.on('close', () => {
            const pending = this.pendingGuests.get(connId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingGuests.delete(connId);
            }
            if (this.admittedGuests.has(connId)) {
                this.admittedGuests.delete(connId);
                this.emit('guestLeft', connId);
            }
        });
    }
    async stop() {
        for (const g of this.admittedGuests.values()) {
            try {
                g.ws.close(1000, 'session ended');
            }
            catch { }
        }
        this.admittedGuests.clear();
        for (const p of this.pendingGuests.values()) {
            clearTimeout(p.timeout);
            try {
                p.ws.close(1000, 'session ended');
            }
            catch { }
        }
        this.pendingGuests.clear();
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.httpsServer) {
            const server = this.httpsServer;
            this.httpsServer = null;
            await new Promise((resolve) => server.close(() => resolve()));
        }
    }
}
exports.WalkieTalkieSignalServer = WalkieTalkieSignalServer;
//# sourceMappingURL=walkie-talkie-signal-server.js.map