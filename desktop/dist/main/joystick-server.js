"use strict";
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
exports.JoystickServer = void 0;
const https = __importStar(require("https"));
const crypto = __importStar(require("crypto"));
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
const pairing_1 = require("../core/pairing");
const GUEST_CONFIRM_TIMEOUT_MS = 30000;
class JoystickServer extends events_1.EventEmitter {
    cert;
    key;
    port;
    isBlocked;
    httpsServer = null;
    wss = null;
    myPublicKeyDer;
    pendingGuests = new Map();
    admittedGuests = new Map();
    constructor(cert, key, port, isBlocked = () => false) {
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
    stop() {
        this.wss?.close();
        this.httpsServer?.close();
    }
    acceptGuest(connId, padIndex) {
        const pending = this.pendingGuests.get(connId);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pendingGuests.delete(connId);
        this.admittedGuests.set(pending.remoteAddress, { ws: pending.ws, remoteAddress: pending.remoteAddress, deviceName: pending.deviceName });
        try {
            pending.ws.send(JSON.stringify({ type: 'admitted', padIndex }));
        }
        catch { }
        this.emit('guestJoined', pending.remoteAddress, pending.deviceName);
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
    /** Like rejectGuest, but for the host's Block action rather than a plain Reject — closes with a
     *  distinct reason so the guest-side UI can show a generic "failed to connect" instead of
     *  revealing it was specifically rejected, and definitely not that it was blocked outright. */
    blockGuest(connId) {
        const pending = this.pendingGuests.get(connId);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pendingGuests.delete(connId);
        try {
            pending.ws.close(4010, 'blocked');
        }
        catch { }
    }
    getPendingGuestRemoteAddress(connId) {
        return this.pendingGuests.get(connId)?.remoteAddress ?? null;
    }
    getPendingGuestDeviceName(connId) {
        return this.pendingGuests.get(connId)?.deviceName ?? null;
    }
    sendRumble(ip, large, small) {
        const guest = this.admittedGuests.get(ip);
        if (!guest)
            return;
        try {
            guest.ws.send(JSON.stringify({ type: 'rumble', large, small }));
        }
        catch { }
    }
    kickGuest(ip, reason = 'removed by host') {
        const guest = this.admittedGuests.get(ip);
        if (!guest)
            return;
        try {
            guest.ws.close(1000, reason);
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
                ws.close(4003, 'malformed first message');
                return;
            }
            if (msg.type === 'join-guest') {
                const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName : 'Controller';
                const pin = (0, pairing_1.computeVerificationCode)(this.myPublicKeyDer, peerPublicKeyDer);
                const timeout = setTimeout(() => {
                    this.pendingGuests.delete(connId);
                    try {
                        ws.close(4006, 'confirmation timed out');
                    }
                    catch { }
                }, GUEST_CONFIRM_TIMEOUT_MS);
                this.pendingGuests.set(connId, { ws, pin, timeout, remoteAddress, deviceName });
                try {
                    ws.send(JSON.stringify({ type: 'pin', code: pin }));
                }
                catch { }
                this.emit('guestPinPending', connId, pin, remoteAddress, deviceName);
            }
            else {
                ws.close(4004, 'unknown join type');
            }
        };
        ws.on('message', onFirstMessage);
        ws.on('close', () => {
            if (this.pendingGuests.has(connId)) {
                const p = this.pendingGuests.get(connId);
                clearTimeout(p.timeout);
                this.pendingGuests.delete(connId);
            }
            if (this.admittedGuests.has(remoteAddress)) {
                this.admittedGuests.delete(remoteAddress);
                this.emit('guestLeft', remoteAddress);
            }
        });
    }
}
exports.JoystickServer = JoystickServer;
//# sourceMappingURL=joystick-server.js.map