"use strict";
// Wires transport + pairing + trust together per connection. This is the orchestration layer —
// individual pieces (transport.ts, pairing.ts, trust.ts) stay independently testable.
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
exports.DeviceManager = void 0;
exports.extractPublicKeyDer = extractPublicKeyDer;
const events_1 = require("events");
const crypto = __importStar(require("crypto"));
const transport_1 = require("./transport");
const pairing_1 = require("./pairing");
const tls_1 = require("./tls");
const packet_1 = require("./packet");
class DeviceManager extends events_1.EventEmitter {
    opts;
    trustStore;
    server;
    peers = new Map(); // keyed by deviceId
    myPublicKeyDer;
    constructor(opts, trustStore, port = transport_1.LINK_PORT) {
        super();
        this.opts = opts;
        this.trustStore = trustStore;
        this.myPublicKeyDer = extractPublicKeyDer(opts.cert);
        this.server = new transport_1.LinkServer(opts, port);
        this.server.on('connection', (conn) => this.attach(conn));
    }
    async connectTo(host, port = transport_1.LINK_PORT) {
        const conn = await (0, transport_1.connectToPeer)(host, port, this.opts);
        this.attach(conn);
    }
    attach(conn) {
        conn.on('identity', (identity, _certPem) => {
            const existing = this.trustStore.get(identity.deviceId);
            const currentFingerprint = conn.currentPeerFingerprint();
            if (existing) {
                const pinnedFingerprint = (0, tls_1.certFingerprint)(existing.certPem);
                if (currentFingerprint !== pinnedFingerprint) {
                    this.emit('trustMismatch', identity.deviceId);
                    conn.close();
                    return;
                }
            }
            const existingPeer = this.peers.get(identity.deviceId);
            if (existingPeer) {
                const keepThis = this.opts.myIdentity.deviceId > identity.deviceId
                    ? conn.isOutgoing
                    : !conn.isOutgoing;
                if (!keepThis) {
                    conn.close();
                    return;
                }
                else {
                    existingPeer.conn.close();
                }
            }
            const trusted = !!existing;
            const pairing = new pairing_1.PairingHandler(trusted ? 'Paired' : 'NotPaired', this.myPublicKeyDer, () => extractPeerPublicKeyDer(conn));
            if (existingPeer) {
                pairing.restore(existingPeer.pairing.snapshot());
            }
            pairing.on('sendPacket', (packet) => conn.send(packet));
            pairing.on('incomingPairRequest', () => {
                this.emit('incomingPairRequest', identity.deviceId, identity.deviceName, identity.deviceType, pairing.verificationKey());
            });
            pairing.on('pairingSuccessful', () => {
                const peer = this.peers.get(identity.deviceId);
                if (peer && conn.peerCertPem) {
                    this.trustStore.pair({
                        deviceId: identity.deviceId,
                        deviceName: identity.deviceName,
                        certPem: conn.peerCertPem,
                        protocolVersion: identity.protocolVersion,
                        pairedAt: Date.now(),
                    });
                    peer.trusted = true;
                }
                this.emit('pairingSuccessful', identity.deviceId);
                this.broadcastPoolSync();
                this.sendPoolSync(conn);
            });
            pairing.on('pairingFailed', (reason) => this.emit('pairingFailed', identity.deviceId, reason));
            pairing.on('unpaired', () => {
                this.trustStore.unpair(identity.deviceId);
                const peer = this.peers.get(identity.deviceId);
                if (peer)
                    peer.trusted = false;
                this.emit('unpaired', identity.deviceId);
            });
            this.peers.set(identity.deviceId, { conn, pairing, trusted, identity });
            this.emit('deviceConnected', identity, trusted);
            if (trusted) {
                conn.send((0, packet_1.createPacket)('link.pairing-state', { state: 'Paired' }));
                this.sendPoolSync(conn);
            }
        });
        conn.on('packet', (packet) => {
            const peerEntry = [...this.peers.entries()].find(([, p]) => p.conn === conn);
            if (!peerEntry)
                return;
            const [deviceId, peer] = peerEntry;
            if (packet.type === 'link.pairing-state') {
                const body = packet.body;
                if (body.state === 'Paired') {
                    if (!peer.trusted) {
                        console.log(`[Link] Peer ${deviceId.slice(0, 8)} thinks they are paired, but we don't trust them. Sending unpair.`);
                        conn.send((0, packet_1.createPacket)('link.pair', { pair: false }));
                        setTimeout(() => {
                            conn.close();
                        }, 500);
                    }
                }
                return;
            }
            if (packet.type === 'link.pool.sync') {
                const body = packet.body;
                if (body.trustList && Array.isArray(body.trustList)) {
                    let updated = false;
                    for (const dev of body.trustList) {
                        if (dev.deviceId === this.opts.myIdentity.deviceId)
                            continue;
                        if (!this.trustStore.isPaired(dev.deviceId)) {
                            console.log(`[Link] Auto-learning trust for pool peer ${dev.deviceName} (${dev.deviceId.slice(0, 8)})`);
                            this.trustStore.pair({
                                deviceId: dev.deviceId,
                                deviceName: dev.deviceName,
                                certPem: dev.certPem,
                                protocolVersion: dev.protocolVersion || 1,
                                pairedAt: Date.now(),
                                lastKnownIp: dev.lastKnownIp,
                            });
                            updated = true;
                        }
                        else {
                            const existing = this.trustStore.get(dev.deviceId);
                            if (existing && dev.lastKnownIp && existing.lastKnownIp !== dev.lastKnownIp) {
                                console.log(`[Link] Updating IP for pool peer ${dev.deviceName} (${dev.deviceId.slice(0, 8)}) to ${dev.lastKnownIp}`);
                                this.trustStore.updateLastKnownIp(dev.deviceId, dev.lastKnownIp);
                                updated = true;
                            }
                        }
                    }
                    if (updated) {
                        this.emit('trustListUpdated');
                        this.broadcastPoolSync();
                    }
                }
                return;
            }
            if (packet.type === 'link.pool.remove') {
                const body = packet.body;
                if (body.deviceId && this.trustStore.isPaired(body.deviceId)) {
                    console.log(`[Link] Peer ${deviceId.slice(0, 8)} requested removal of ${body.deviceId.slice(0, 8)} from pool.`);
                    this.unpair(body.deviceId);
                    // Propagate to other trusted connected devices (excluding the sender and the target)
                    const targetId = body.deviceId;
                    for (const otherId of this.trustedConnectedDeviceIds()) {
                        if (otherId !== deviceId && otherId !== targetId) {
                            this.sendTo(otherId, (0, packet_1.createPacket)('link.pool.remove', { deviceId: targetId }));
                        }
                    }
                }
                return;
            }
            if (packet.type === pairing_1.PACKET_TYPE_PAIR) {
                peer.pairing.packetReceived(packet);
                return;
            }
            if (!peer.trusted)
                return;
            this.emit('packet', deviceId, packet);
        });
        conn.on('close', () => {
            const peerEntry = [...this.peers.entries()].find(([, p]) => p.conn === conn);
            if (peerEntry) {
                this.peers.delete(peerEntry[0]);
                this.emit('deviceDisconnected', peerEntry[0]);
            }
        });
        conn.on('error', (err) => {
            console.error('PeerConnection error:', err.message);
        });
    }
    requestPairing(deviceId) {
        const peer = this.peers.get(deviceId);
        if (peer) {
            peer.pairing.requestPairing();
            return peer.pairing.verificationKey();
        }
        return null;
    }
    acceptPairing(deviceId) {
        this.peers.get(deviceId)?.pairing.acceptPairing();
    }
    cancelPairing(deviceId) {
        this.peers.get(deviceId)?.pairing.cancelPairing();
    }
    rejectPairing(deviceId) {
        this.peers.get(deviceId)?.pairing.cancelPairing();
    }
    unpair(deviceId) {
        const peer = this.peers.get(deviceId);
        if (peer) {
            try {
                console.log(`[Link] Sending unpair packet to ${deviceId.slice(0, 8)}`);
                peer.conn.send((0, packet_1.createPacket)('link.pair', { pair: false }));
            }
            catch (err) {
                console.error(`[Link] Failed to send unpair: ${err.message}`);
            }
            peer.pairing.unpair();
            setTimeout(() => {
                peer.conn.close();
            }, 500);
            this.peers.delete(deviceId);
        }
        // Cover the case where the device isn't currently connected — still drop local trust.
        this.trustStore.unpair(deviceId);
        this.emit('unpaired', deviceId);
    }
    closeConnection(deviceId) {
        this.peers.get(deviceId)?.conn.close();
    }
    sendTo(deviceId, packet) {
        const peer = this.peers.get(deviceId);
        if (peer && peer.trusted)
            peer.conn.send(packet);
    }
    pairState(deviceId) {
        return this.peers.get(deviceId)?.pairing.pairState ?? null;
    }
    /** This device's own TLS identity — needed by plugins (e.g. share) that open their own ephemeral payload connections. */
    get myCert() {
        return this.opts.cert;
    }
    get myKey() {
        return this.opts.key;
    }
    /** All currently-connected, paired device IDs — e.g. for broadcasting a local clipboard change to everyone. */
    trustedConnectedDeviceIds() {
        return [...this.peers.entries()].filter(([, p]) => p.trusted).map(([id]) => id);
    }
    /** The peer's IP for an active connection — e.g. for downloading a payload they announced. */
    remoteAddressOf(deviceId) {
        return this.peers.get(deviceId)?.conn.remoteAddress;
    }
    /**
     * Reverse of remoteAddressOf — identifies which trusted, connected peer a raw source IP
     * belongs to. Needed for the unauthenticated UDP fast-path input relay (touchpad/digitizer/
     * presenter continuous move events), which has no packet envelope/deviceId of its own and
     * previously trusted ANY sender on the LAN blasting to that port, regardless of pairing.
     */
    deviceIdForAddress(address) {
        for (const [id, p] of this.peers.entries()) {
            if (p.trusted && p.conn.remoteAddress === address)
                return id;
        }
        return undefined;
    }
    pinnedCertPemOf(deviceId) {
        return this.trustStore.get(deviceId)?.certPem ?? null;
    }
    /** The pinned certificate fingerprint for a paired device — for verifying a payload connection's cert matches. */
    pinnedFingerprintOf(deviceId) {
        const trusted = this.trustStore.get(deviceId);
        return trusted ? (0, tls_1.certFingerprint)(trusted.certPem) : null;
    }
    getPeerIdentity(deviceId) {
        return this.peers.get(deviceId)?.conn.peerIdentity ?? undefined;
    }
    getConnectedPeers() {
        return [...this.peers.entries()].map(([id, p]) => ({
            deviceId: id,
            identity: p.conn.peerIdentity ?? undefined,
            trusted: p.trusted,
        }));
    }
    hasPeer(deviceId) {
        return this.peers.has(deviceId);
    }
    updatePeerName(deviceId, newName) {
        const peer = this.peers.get(deviceId);
        if (peer && peer.conn && peer.conn.peerIdentity) {
            peer.conn.peerIdentity.deviceName = newName;
        }
    }
    /**
     * Every currently-connected peer's real identity + trust state. Needed because a renderer
     * reload (F5/Ctrl+R) only tears down and rebuilds the renderer — main.ts and this DeviceManager
     * keep running completely undisturbed, so any already-live connections are still perfectly
     * fine. Without this, the renderer's bootstrap only had `get-trusted-devices` to fall back on,
     * which hardcodes connected:false for everything — making a reload LOOK like every connection
     * was lost even when nothing at the network level actually changed.
     */
    connectedPeers() {
        return [...this.peers.values()]
            .filter((p) => p.conn.peerIdentity !== null)
            .map((p) => ({ identity: p.conn.peerIdentity, trusted: p.trusted }));
    }
    /**
     * Called periodically (see main.ts) for every connected peer: force-closes any connection that
     * has gone silent for longer than timeoutMs (dead peer, detected ourselves instead of waiting
     * on OS-level TCP keepalive — see PeerConnection.isStale()'s comment for why that alone wasn't
     * fast/reliable enough), otherwise sends a heartbeat so a genuinely-alive-but-idle connection
     * never goes stale in the first place. Closing here triggers the normal 'close' → deviceDisconnected
     * cleanup path, which is what lets discovery reconnect promptly instead of the UI sitting on a
     * stale "connected" state that no longer reflects reality.
     */
    runHeartbeatCycle(timeoutMs) {
        for (const peer of this.peers.values()) {
            if (peer.conn.isStale(timeoutMs)) {
                peer.conn.close();
            }
            else {
                peer.conn.sendHeartbeat();
            }
        }
    }
    getPoolSyncList() {
        return this.trustStore.list().map((d) => ({
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            certPem: d.certPem,
            protocolVersion: d.protocolVersion,
            lastKnownIp: d.lastKnownIp,
        }));
    }
    sendPoolSync(conn) {
        conn.send((0, packet_1.createPacket)('link.pool.sync', { trustList: this.getPoolSyncList() }));
    }
    broadcastPoolSync() {
        const list = this.getPoolSyncList();
        const packet = (0, packet_1.createPacket)('link.pool.sync', { trustList: list });
        for (const peer of this.peers.values()) {
            if (peer.trusted) {
                peer.conn.send(packet);
            }
        }
    }
}
exports.DeviceManager = DeviceManager;
// Exported for reuse by Audio Relay's guest-session PIN (same "hash both sides' public keys"
// approach as PairingHandler.verificationKey(), without pulling in the rest of pairing's
// trust-store-coupled state machine — see computeVerificationCode() in pairing.ts).
function extractPublicKeyDer(certPem) {
    const cert = new crypto.X509Certificate(certPem);
    return cert.publicKey.export({ type: 'spki', format: 'der' });
}
function extractPeerPublicKeyDer(conn) {
    if (!conn.peerCertPem)
        return null;
    return extractPublicKeyDer(conn.peerCertPem);
}
//# sourceMappingURL=device-manager.js.map