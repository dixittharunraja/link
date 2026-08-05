// Wires transport + pairing + trust together per connection. This is the orchestration layer —
// individual pieces (transport.ts, pairing.ts, trust.ts) stay independently testable.

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { DeviceIdentity } from './identity';
import { LinkServer, PeerConnection, connectToPeer, TransportOptions, LINK_PORT } from './transport';
import { PairingHandler, PACKET_TYPE_PAIR, PairState } from './pairing';
import { TrustStore } from './trust';
import { certFingerprint } from './tls';
import { LinkPacket, createPacket } from './packet';

interface ManagedPeer {
  conn: PeerConnection;
  pairing: PairingHandler;
  trusted: boolean;
  identity?: DeviceIdentity;
}

export interface DeviceManagerEvents {
  deviceConnected: (identity: DeviceIdentity, trusted: boolean) => void;
  deviceDisconnected: (deviceId: string) => void;
  incomingPairRequest: (deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null) => void;
  pairingSuccessful: (deviceId: string) => void;
  pairingFailed: (deviceId: string, reason: string) => void;
  unpaired: (deviceId: string) => void;
  trustMismatch: (deviceId: string) => void;
  packet: (deviceId: string, packet: LinkPacket) => void;
  /** Emitted when a pool-member IP hint arrives — main.ts uses this to attempt a direct TCP connect
   *  and to persist the deviceId+ip as a retry candidate in case the immediate attempt fails. */
  poolPeerHint: (deviceId: string, ip: string) => void;
  trustListUpdated: () => void;
}

export declare interface DeviceManager {
  on<E extends keyof DeviceManagerEvents>(event: E, listener: DeviceManagerEvents[E]): this;
  emit<E extends keyof DeviceManagerEvents>(event: E, ...args: Parameters<DeviceManagerEvents[E]>): boolean;
}

export class DeviceManager extends EventEmitter {
  private server: LinkServer;
  private peers = new Map<string, ManagedPeer>(); // keyed by deviceId
  private myPublicKeyDer: Buffer;

  constructor(
    private opts: TransportOptions,
    public trustStore: TrustStore,
    port: number = LINK_PORT
  ) {
    super();
    this.myPublicKeyDer = extractPublicKeyDer(opts.cert);

    this.server = new LinkServer(opts, port);
    this.server.on('connection', (conn) => this.attach(conn));
  }

  async connectTo(host: string, port: number = LINK_PORT): Promise<void> {
    const conn = await connectToPeer(host, port, this.opts);
    this.attach(conn);
  }

  private attach(conn: PeerConnection): void {
    conn.on('identity', (identity, _certPem) => {
      const existing = this.trustStore.get(identity.deviceId);
      const currentFingerprint = conn.currentPeerFingerprint();

      if (existing) {
        const pinnedFingerprint = certFingerprint(existing.certPem);
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
        } else {
          existingPeer.conn.close();
        }
      }

      const trusted = !!existing;

      const pairing = new PairingHandler(
        trusted ? 'Paired' : 'NotPaired',
        this.myPublicKeyDer,
        () => extractPeerPublicKeyDer(conn)
      );
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
        if (peer) peer.trusted = false;
        this.emit('unpaired', identity.deviceId);
      });

      this.peers.set(identity.deviceId, { conn, pairing, trusted, identity });
      this.emit('deviceConnected', identity, trusted);
      if (trusted) {
        conn.send(createPacket('link.pairing-state', { state: 'Paired' }));
        this.sendPoolSync(conn);
      }
    });

    conn.on('packet', (packet) => {
      const peerEntry = [...this.peers.entries()].find(([, p]) => p.conn === conn);
      if (!peerEntry) return;
      const [deviceId, peer] = peerEntry;

      if (packet.type === 'link.pairing-state') {
        const body = packet.body as { state?: string };
        if (body.state === 'Paired') {
          if (!peer.trusted) {
            console.log(`[Link] Peer ${deviceId.slice(0, 8)} thinks they are paired, but we don't trust them. Sending unpair.`);
            conn.send(createPacket('link.pair', { pair: false }));
            setTimeout(() => {
              conn.close();
            }, 500);
          }
        }
        return;
      }

      if (packet.type === 'link.pool.sync') {
        const body = packet.body as { trustList?: Array<{ deviceId: string; deviceName: string; certPem: string; protocolVersion: number; lastKnownIp?: string }> };
        if (body.trustList && Array.isArray(body.trustList)) {
          let updated = false;
          for (const dev of body.trustList) {
            if (dev.deviceId === this.opts.myIdentity.deviceId) continue;
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
            } else {
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
        const body = packet.body as { deviceId?: string };
        if (body.deviceId && this.trustStore.isPaired(body.deviceId)) {
          console.log(`[Link] Peer ${deviceId.slice(0, 8)} requested removal of ${body.deviceId.slice(0, 8)} from pool.`);
          this.unpair(body.deviceId);

          // Propagate to other trusted connected devices (excluding the sender and the target)
          const targetId = body.deviceId;
          for (const otherId of this.trustedConnectedDeviceIds()) {
            if (otherId !== deviceId && otherId !== targetId) {
              this.sendTo(otherId, createPacket('link.pool.remove', { deviceId: targetId }));
            }
          }
        }
        return;
      }

      if (packet.type === PACKET_TYPE_PAIR) {
        peer.pairing.packetReceived(packet as LinkPacket<{ pair: boolean; timestamp?: number }>);
        return;
      }

      if (!peer.trusted) return;

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

  requestPairing(deviceId: string): string | null {
    const peer = this.peers.get(deviceId);
    if (peer) {
      peer.pairing.requestPairing();
      return peer.pairing.verificationKey();
    }
    return null;
  }

  acceptPairing(deviceId: string): void {
    this.peers.get(deviceId)?.pairing.acceptPairing();
  }

  cancelPairing(deviceId: string): void {
    this.peers.get(deviceId)?.pairing.cancelPairing();
  }

  rejectPairing(deviceId: string): void {
    this.peers.get(deviceId)?.pairing.cancelPairing();
  }

  unpair(deviceId: string): void {
    const peer = this.peers.get(deviceId);
    if (peer) {
      try {
        console.log(`[Link] Sending unpair packet to ${deviceId.slice(0, 8)}`);
        peer.conn.send(createPacket('link.pair', { pair: false }));
      } catch (err: any) {
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

  closeConnection(deviceId: string): void {
    this.peers.get(deviceId)?.conn.close();
  }

  sendTo(deviceId: string, packet: LinkPacket): void {
    const peer = this.peers.get(deviceId);
    if (peer && peer.trusted) peer.conn.send(packet);
  }

  pairState(deviceId: string): PairState | null {
    return this.peers.get(deviceId)?.pairing.pairState ?? null;
  }

  /** This device's own TLS identity — needed by plugins (e.g. share) that open their own ephemeral payload connections. */
  get myCert(): string {
    return this.opts.cert;
  }

  get myKey(): string {
    return this.opts.key;
  }

  /** All currently-connected, paired device IDs — e.g. for broadcasting a local clipboard change to everyone. */
  trustedConnectedDeviceIds(): string[] {
    return [...this.peers.entries()].filter(([, p]) => p.trusted).map(([id]) => id);
  }

  /** The peer's IP for an active connection — e.g. for downloading a payload they announced. */
  remoteAddressOf(deviceId: string): string | undefined {
    return this.peers.get(deviceId)?.conn.remoteAddress;
  }

  /**
   * Reverse of remoteAddressOf — identifies which trusted, connected peer a raw source IP
   * belongs to. Needed for the unauthenticated UDP fast-path input relay (touchpad/digitizer/
   * presenter continuous move events), which has no packet envelope/deviceId of its own and
   * previously trusted ANY sender on the LAN blasting to that port, regardless of pairing.
   */
  deviceIdForAddress(address: string): string | undefined {
    for (const [id, p] of this.peers.entries()) {
      if (p.trusted && p.conn.remoteAddress === address) return id;
    }
    return undefined;
  }

  pinnedCertPemOf(deviceId: string): string | null {
    return this.trustStore.get(deviceId)?.certPem ?? null;
  }

  /** The pinned certificate fingerprint for a paired device — for verifying a payload connection's cert matches. */
  pinnedFingerprintOf(deviceId: string): string | null {
    const trusted = this.trustStore.get(deviceId);
    return trusted ? certFingerprint(trusted.certPem) : null;
  }

  getPeerIdentity(deviceId: string): DeviceIdentity | undefined {
    return this.peers.get(deviceId)?.conn.peerIdentity ?? undefined;
  }

  getConnectedPeers(): Array<{ deviceId: string; identity?: DeviceIdentity; trusted: boolean }> {
    return [...this.peers.entries()].map(([id, p]) => ({
      deviceId: id,
      identity: p.conn.peerIdentity ?? undefined,
      trusted: p.trusted,
    }));
  }

  hasPeer(deviceId: string): boolean {
    return this.peers.has(deviceId);
  }

  updatePeerName(deviceId: string, newName: string): void {
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
  connectedPeers(): Array<{ identity: DeviceIdentity; trusted: boolean }> {
    return [...this.peers.values()]
      .filter((p) => p.conn.peerIdentity !== null)
      .map((p) => ({ identity: p.conn.peerIdentity as DeviceIdentity, trusted: p.trusted }));
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
  runHeartbeatCycle(timeoutMs: number): void {
    for (const peer of this.peers.values()) {
      if (peer.conn.isStale(timeoutMs)) {
        peer.conn.close();
      } else {
        peer.conn.sendHeartbeat();
      }
    }
  }

  private getPoolSyncList() {
    return this.trustStore.list().map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      certPem: d.certPem,
      protocolVersion: d.protocolVersion,
      lastKnownIp: d.lastKnownIp,
    }));
  }

  private sendPoolSync(conn: PeerConnection) {
    conn.send(createPacket('link.pool.sync', { trustList: this.getPoolSyncList() }));
  }

  private broadcastPoolSync() {
    const list = this.getPoolSyncList();
    const packet = createPacket('link.pool.sync', { trustList: list });
    for (const peer of this.peers.values()) {
      if (peer.trusted) {
        peer.conn.send(packet);
      }
    }
  }
}

// Exported for reuse by Audio Relay's guest-session PIN (same "hash both sides' public keys"
// approach as PairingHandler.verificationKey(), without pulling in the rest of pairing's
// trust-store-coupled state machine — see computeVerificationCode() in pairing.ts).
export function extractPublicKeyDer(certPem: string): Buffer {
  const cert = new crypto.X509Certificate(certPem);
  return cert.publicKey.export({ type: 'spki', format: 'der' });
}

function extractPeerPublicKeyDer(conn: PeerConnection): Buffer | null {
  if (!conn.peerCertPem) return null;
  return extractPublicKeyDer(conn.peerCertPem);
}
