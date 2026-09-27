"use strict";
// TCP+TLS transport, adapted for Node's `tls` module. See docs/PROTOCOL.md §5.
//
// Implementation note: We start TLS immediately with `rejectUnauthorized: false` (accept any
// cert at the socket layer), then manually verify the peer's certificate fingerprint against our
// pinned store right after the handshake completes and we've learned their deviceId via the
// (now encrypted) identity packet. Unpaired connections proceed with an unverified cert, while
// paired connections are rejected outright on any certificate mismatch.
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
exports.LinkServer = exports.PeerConnection = exports.PACKET_TYPE_HEARTBEAT = exports.PACKET_TYPE_IDENTITY = exports.JOYSTICK_PORT = exports.WALKIE_TALKIE_PORT = exports.PORTAL_TRANSFER_PORT = exports.AUDIO_SINK_UDP_PORT = exports.AUDIO_SINK_PORT = exports.LINK_PORT = void 0;
exports.connectToPeer = connectToPeer;
const tls = __importStar(require("tls"));
const events_1 = require("events");
const packet_1 = require("./packet");
const tls_1 = require("./tls");
exports.LINK_PORT = 1739; // arbitrary, distinct from KDE Connect's 1716/1717
// File System's WebSocket server lives on LINK_PORT + 2 (see LinkFsServer.java/fs-client.ts).
// Audio Sink's dedicated relay server (see audio-sink-server.ts) uses LINK_PORT + 3 — entirely
// separate from this module's DeviceManager/TrustStore-backed connections by design: guest
// listeners are never paired and must never touch the trust store or peers map.
exports.AUDIO_SINK_PORT = exports.LINK_PORT + 3;
// Dedicated UDP channel for the actual PCM stream (see audio-sink-server.ts's header comment) —
// AUDIO_SINK_PORT above now carries only JSON control messages (join/admit/format/mute/end) over
// TLS/WebSocket; audio frames move over UDP here to avoid TCP head-of-line blocking stalling
// playback behind a single delayed/lost packet.
exports.AUDIO_SINK_UDP_PORT = exports.AUDIO_SINK_PORT + 1;
// Remote Mic reuses AUDIO_SINK_PORT + 2 / + 3 for its control/UDP pair (see main.ts) — next free
// offset for a new ephemeral feature is + 7. Portal Mode (one-time file transfer to an unpaired
// device) gets its own dedicated port for the same reason Audio Sink/Remote Mic do: guest
// connections here are NEVER paired and must never touch the trust store or peers map.
exports.PORTAL_TRANSFER_PORT = exports.LINK_PORT + 7;
// Walkie Talkie's actual audio is WebRTC (getUserMedia + RTCPeerConnection, already built into
// both Electron's renderer and Android's WebView) and never touches our own transport layer.
// Signaling (session membership + SDP/ICE) between already-paired devices rides over the existing
// trusted connection as plain link.walkietalkie.* packets — see main.ts. But an unpaired guest has
// no such connection to ride on, so this dedicated control-only port (no UDP pair needed, unlike
// Audio Sink/Remote Mic — there's no PCM stream of our own to carry) exists purely for guests to
// reach the same signaling protocol via manual IP + PIN, same guest-admission model as every other
// ephemeral Tools plugin. See walkie-talkie-signal-server.ts.
exports.WALKIE_TALKIE_PORT = exports.LINK_PORT + 8;
exports.JOYSTICK_PORT = exports.LINK_PORT + 9;
exports.PACKET_TYPE_IDENTITY = 'link.identity';
// Silent, transport-level-only packet — never surfaced as a 'packet' event, purely to prove
// liveness and reset lastActivityAt. TCP keepalive alone was too slow/opaque to rely on for this:
// Node (and Java) only let you configure the initial idle delay, not the retry interval or count,
// so actual dead-peer detection could silently take 20-30+ seconds depending on OS defaults — far
// from "instant" reconnection. An app-level heartbeat with a known, short timeout gives full
// control over detection speed instead of depending on OS TCP stack quirks.
exports.PACKET_TYPE_HEARTBEAT = 'link.heartbeat';
/** Wraps one live TLS socket to a peer — either direction (we dialed out, or they dialed in). */
class PeerConnection extends events_1.EventEmitter {
    socket;
    myIdentity;
    isOutgoing;
    reader = new packet_1.PacketStreamReader();
    identitySent = false;
    peerIdentity = null;
    peerCertPem = null;
    /** The peer's IP, regardless of which side dialed — needed for e.g. downloading a payload the peer announced. */
    remoteAddress;
    /** Timestamp of the last inbound byte, of any kind — used to detect a dead peer ourselves instead of waiting on TCP keepalive. */
    lastActivityAt = Date.now();
    constructor(socket, myIdentity, isOutgoing) {
        super();
        this.socket = socket;
        this.myIdentity = myIdentity;
        this.isOutgoing = isOutgoing;
        this.remoteAddress = socket.remoteAddress;
        socket.on('data', (chunk) => {
            this.lastActivityAt = Date.now();
            for (const packet of this.reader.push(chunk)) {
                if (packet.type === exports.PACKET_TYPE_IDENTITY) {
                    this.handleIdentityPacket(packet);
                }
                else if (packet.type === exports.PACKET_TYPE_HEARTBEAT) {
                    // lastActivityAt above already recorded it — nothing else to do.
                }
                else {
                    this.emit('packet', packet);
                }
            }
        });
        socket.on('close', () => this.emit('close'));
        socket.on('error', (err) => this.emit('error', err));
        // Send our identity as the first packet, as soon as the encrypted socket is writable.
        this.sendIdentity();
    }
    sendIdentity() {
        if (this.identitySent)
            return;
        this.identitySent = true;
        const packet = (0, packet_1.createPacket)(exports.PACKET_TYPE_IDENTITY, this.myIdentity);
        this.socket.write((0, packet_1.serializePacket)(packet));
    }
    handleIdentityPacket(packet) {
        this.peerIdentity = packet.body;
        const cert = this.socket.getPeerCertificate();
        this.peerCertPem = cert && cert.raw ? derToPem(cert.raw) : null;
        if (this.peerCertPem) {
            this.emit('identity', this.peerIdentity, this.peerCertPem);
        }
    }
    send(packet) {
        this.socket.write((0, packet_1.serializePacket)(packet));
    }
    sendHeartbeat() {
        this.socket.write((0, packet_1.serializePacket)((0, packet_1.createPacket)(exports.PACKET_TYPE_HEARTBEAT, {})));
    }
    /** True if nothing at all has arrived from the peer in longer than timeoutMs — treat as dead. */
    isStale(timeoutMs) {
        return Date.now() - this.lastActivityAt > timeoutMs;
    }
    close() {
        this.socket.end();
        // Belt-and-suspenders: end() is a graceful FIN that can itself hang if the peer is truly gone
        // (no ACK ever arrives), leaving 'close' unfired. Force a hard destroy shortly after so a
        // stale connection we just detected ourselves is guaranteed to actually go away.
        setTimeout(() => {
            if (!this.socket.destroyed)
                this.socket.destroy();
        }, 1000);
    }
    /** Fingerprint of the certificate actually presented on THIS connection — compare against the pinned one. */
    currentPeerFingerprint() {
        return this.peerCertPem ? (0, tls_1.certFingerprint)(this.peerCertPem) : null;
    }
}
exports.PeerConnection = PeerConnection;
/** Starts listening for incoming connections. Emits 'connection' for each new PeerConnection. */
class LinkServer extends events_1.EventEmitter {
    opts;
    server;
    constructor(opts, port = exports.LINK_PORT) {
        super();
        this.opts = opts;
        this.server = tls.createServer({
            cert: opts.cert,
            key: opts.key,
            requestCert: true,
            rejectUnauthorized: false, // manual verification happens after identity exchange
        }, (socket) => {
            // A connection can go half-open (one side thinks it's fine, the peer is actually gone)
            // without either end noticing for a long time — common after a phone's Wi-Fi radio
            // sleeps/wakes or the OS silently drops a NAT/AP session. Left undetected, the peer stays
            // listed as "connected" while anything sent to it (a pair request, a plugin action) just
            // vanishes with no error. TCP keepalive makes the OS notice and fire 'close' instead.
            socket.setKeepAlive(true, 10000);
            const conn = new PeerConnection(socket, opts.myIdentity, false);
            this.emit('connection', conn);
        });
        // Without this, a server-level error (e.g. a bad client handshake bubbling up on some Node/TLS
        // versions) would throw as an unhandled 'error' event — main.ts's global uncaughtException
        // handler swallows it, but the listening socket's state afterward isn't guaranteed, which
        // could silently stop it from accepting new connections until the app is restarted.
        this.server.on('error', (err) => {
            console.error('[Link] LinkServer error:', err);
        });
        this.server.listen(port, '0.0.0.0');
    }
    close() {
        this.server.close();
    }
}
exports.LinkServer = LinkServer;
// Node's default TCP connect timeout can run into tens of seconds against an unreachable/
// firewalled peer (e.g. a stale discovery entry, or a peer that just dropped off Wi-Fi). Since
// discovery re-attempts a connection on every broadcast (~every 5s) while the peer is still
// unconnected, one hung attempt with no timeout meant nothing ever failed to let the next retry
// through — the likely cause of "device stays invisible until the app is restarted."
const CONNECT_TIMEOUT_MS = 4000;
/** Dials out to a peer at host:port. Resolves with a PeerConnection once the TLS handshake completes. */
function connectToPeer(host, port, opts) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({
            host,
            port,
            cert: opts.cert,
            key: opts.key,
            rejectUnauthorized: false, // manual verification happens after identity exchange
            timeout: CONNECT_TIMEOUT_MS,
        }, () => {
            socket.setTimeout(0); // handshake succeeded — stop timing out an otherwise-idle live connection
            socket.setKeepAlive(true, 10000); // detect a half-open connection instead of writing into the void
            const conn = new PeerConnection(socket, opts.myIdentity, true);
            resolve(conn);
        });
        socket.once('error', reject);
        socket.once('timeout', () => {
            socket.destroy();
            reject(new Error(`Connect to ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`));
        });
    });
}
function derToPem(der) {
    const base64 = der.toString('base64');
    const lines = base64.match(/.{1,64}/g) || [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}
//# sourceMappingURL=transport.js.map