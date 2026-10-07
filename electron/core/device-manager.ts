// Wires transport + pairing + trust together per connection. This is the orchestration layer —
// individual pieces (transport.ts, pairing.ts, trust.ts) stay independently testable.

import { EventEmitter } from 'events';
import { DeviceIdentity } from './identity';
import { LinkServer, PeerConnection, connectToPeer, TransportOptions, LINK_PORT } from './transport';
import { PairingHandler, PACKET_TYPE_PAIR, PairState } from './pairing';
import { TrustStore } from './trust';
import { certFingerprint, extractPublicKeyDer } from './tls';
import { LinkPacket, createPacket } from './packet';

interface ManagedPeer {
  conn: PeerConnection;
  pairing: PairingHandler;
  trusted: boolean;
  identity?: DeviceIdentity;
  createdAt: number;
}

interface DeviceManagerEvents {
  deviceConnected: (identity: DeviceIdentity, trusted: boolean) => void;
  deviceDisconnected: (deviceId: string) => void;
  incomingPairRequest: (deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null) => void;
  pairingSuccessful: (deviceId: string) => void;
  pairingFailed: (deviceId: string, reason: string) => void;
  unpaired: (deviceId: string) => void;
  trustMismatch: (deviceId: string) => void;
  packet: (deviceId: string, packet: LinkPacket) => void;
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
    conn.getPoolHash = () => this.trustStore.computePoolHash();

    conn.on('heartbeat', (peerPoolHash) => {
      if (peerPoolHash && peerPoolHash !== this.trustStore.computePoolHash()) {
        const peerEntry = [...this.peers.entries()].find(([, p]) => p.conn === conn);
        if (peerEntry && peerEntry[1].trusted) {
          this.sendPoolSync(conn);
        }
      }
    });

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
        if (existingPeer.conn === conn) {
          return;
        }

        // Deterministic collision tie-breaker:
        // When two devices dial each other concurrently (double-dial), both sides resolve
        // symmetrically: the device with lexicographically smaller deviceId keeps outbound,
        // while the device with larger deviceId keeps inbound.
        const shouldKeepOutbound = this.opts.myIdentity.deviceId < identity.deviceId;
        const currentIsOutbound = conn.isOutgoing;

        if (existingPeer.conn.isStale(9000)) {
          console.log(`[Link] Replacing stale connection to ${identity.deviceId.slice(0, 8)} with fresh connection.`);
          existingPeer.conn.close();
        } else if (currentIsOutbound === shouldKeepOutbound) {
          console.log(`[Link] Deterministic tie-breaker: keeping current connection to ${identity.deviceId.slice(0, 8)}.`);
          existingPeer.conn.close();
        } else {
          console.log(`[Link] Deterministic tie-breaker: dropping current duplicate connection to ${identity.deviceId.slice(0, 8)}.`);
          conn.close();
          return;
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
        const remoteIp = conn.remoteAddress ? conn.remoteAddress.replace(/^::ffff:/, '').split(':')[0] : undefined;
        if (conn.peerCertPem) {
          this.trustStore.pair({
            deviceId: identity.deviceId,
            deviceName: identity.deviceName,
            certPem: conn.peerCertPem,
            protocolVersion: identity.protocolVersion,
            pairedAt: Date.now(),
            lastKnownIp: remoteIp,
          });
          if (peer) {
            peer.trusted = true;
          }
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

      this.peers.set(identity.deviceId, { conn, pairing, trusted, identity, createdAt: Date.now() });
      this.emit('deviceConnected', identity, trusted);
      if (trusted) {
        const remoteIp = conn.remoteAddress ? conn.remoteAddress.replace(/^::ffff:/, '').split(':')[0] : undefined;
        if (remoteIp) {
          this.trustStore.updateLastKnownIp(identity.deviceId, remoteIp);
        }
        conn.send(createPacket('link.pairing-state', { state: 'Paired' }));
        this.sendPoolSync(conn);
        this.broadcastPoolSync();
      }
    });

    conn.on('packet', (packet) => {
      const peerEntry = [...this.peers.entries()].find(([, p]) => p.conn === conn);
      if (!peerEntry) return;
      const [deviceId, peer] = peerEntry;

      if (packet.type === 'link.pairing-state') {
        const body = packet.body as { state?: string };
        if (body.state === 'Paired') {
          if (!this.upgradePeerIfTrusted(deviceId)) {
            // Peer claims paired, but not in our trust store yet — exchange pool sync immediately.
            this.sendPoolSync(conn);
          }
        }
        return;
      }

      if (packet.type === 'link.pool.sync') {
        const senderIp = conn.remoteAddress ? conn.remoteAddress.replace(/^::ffff:/, '').split(':')[0] : undefined;
        this.handlePoolSyncPacket(packet.body, deviceId, senderIp);
        return;
      }

      if (packet.type === 'link.pool.remove') {
        const body = packet.body as { deviceId?: string };
        if (body.deviceId && this.trustStore.isPaired(body.deviceId)) {
          console.log(`[Link] Peer ${deviceId.slice(0, 8)} requested removal of ${body.deviceId.slice(0, 8)} from pool.`);
          this.unpair(body.deviceId);
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
      const peerEntry = [...this.peers.entries()].find(([devId, p]) => p.conn === conn && this.peers.get(devId)?.conn === conn);
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

  private handlePoolSyncPacket(body: any, senderDeviceId?: string, senderIp?: string): void {
    const trustList = (body as { trustList?: Array<{ deviceId: string; deviceName: string; certPem: string; protocolVersion: number; lastKnownIp?: string }> })?.trustList;
    if (!trustList || !Array.isArray(trustList)) return;

    let updated = false;
    for (const dev of trustList) {
      if (dev.deviceId === this.opts.myIdentity.deviceId) continue;
      const effectiveIp = dev.lastKnownIp || (dev.deviceId === senderDeviceId ? senderIp : undefined);

      if (!this.trustStore.isPaired(dev.deviceId)) {
        console.log(`[Link] Auto-learning trust for pool peer ${dev.deviceName} (${dev.deviceId.slice(0, 8)})`);
        this.trustStore.pair({
          deviceId: dev.deviceId,
          deviceName: dev.deviceName,
          certPem: dev.certPem,
          protocolVersion: dev.protocolVersion || 1,
          pairedAt: Date.now(),
          lastKnownIp: effectiveIp,
        });
        updated = true;
      } else {
        const existing = this.trustStore.get(dev.deviceId);
        if (existing && effectiveIp && existing.lastKnownIp !== effectiveIp) {
          console.log(`[Link] Updating IP for pool peer ${dev.deviceName} (${dev.deviceId.slice(0, 8)}) to ${effectiveIp}`);
          this.trustStore.updateLastKnownIp(dev.deviceId, effectiveIp);
          updated = true;
        }
      }
      this.upgradePeerIfTrusted(dev.deviceId);
    }
    if (updated) {
      this.emit('trustListUpdated');
      this.broadcastPoolSync();
    }
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

  get myCert(): string {
    return this.opts.cert;
  }

  get myKey(): string {
    return this.opts.key;
  }

  trustedConnectedDeviceIds(): string[] {
    return [...this.peers.entries()].filter(([, p]) => p.trusted).map(([id]) => id);
  }

  remoteAddressOf(deviceId: string): string | undefined {
    const raw = this.peers.get(deviceId)?.conn.remoteAddress;
    if (!raw) return undefined;
    return raw.replace(/^::ffff:/, '').split(':')[0];
  }

  // Maps source IP to deviceId for unauthenticated UDP fast-path (touchpad/digitizer/presenter).
  deviceIdForAddress(address: string): string | undefined {
    for (const [id, p] of this.peers.entries()) {
      if (p.trusted && p.conn.remoteAddress === address) return id;
    }
    return undefined;
  }

  pinnedCertPemOf(deviceId: string): string | null {
    return this.trustStore.get(deviceId)?.certPem ?? null;
  }

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

  hasTrustedPeer(deviceId: string): boolean {
    return this.peers.get(deviceId)?.trusted ?? false;
  }

  upgradePeerIfTrusted(deviceId: string): boolean {
    const peer = this.peers.get(deviceId);
    if (!peer) return false;
    if (peer.trusted) return true;
    const trustedDev = this.trustStore.get(deviceId);
    if (!trustedDev) return false;

    if (peer.conn.peerCertPem) {
      try {
        const pinnedFp = certFingerprint(trustedDev.certPem);
        const actualFp = certFingerprint(peer.conn.peerCertPem);
        if (pinnedFp !== actualFp) {
          console.warn(`[Link] Cert fingerprint mismatch upgrading pool peer ${deviceId.slice(0, 8)}`);
          this.emit('trustMismatch', deviceId);
          peer.conn.close();
          return false;
        }
      } catch {
        peer.conn.close();
        return false;
      }
    }

    console.log(`[Link] Upgraded peer ${deviceId.slice(0, 8)} to trusted.`);
    peer.trusted = true;
    peer.pairing.setPairState('Paired');
    const remoteIp = peer.conn.remoteAddress ? peer.conn.remoteAddress.replace(/^::ffff:/, '').split(':')[0] : undefined;
    if (remoteIp) {
      this.trustStore.updateLastKnownIp(deviceId, remoteIp);
    }
    try {
      peer.conn.send(createPacket('link.pairing-state', { state: 'Paired' }));
    } catch {
      // Ignored
    }
    this.sendPoolSync(peer.conn);
    if (peer.conn.peerIdentity) {
      this.emit('deviceConnected', peer.conn.peerIdentity, true);
    }
    return true;
  }

  updatePeerName(deviceId: string, newName: string): void {
    const peer = this.peers.get(deviceId);
    if (peer && peer.conn && peer.conn.peerIdentity) {
      peer.conn.peerIdentity.deviceName = newName;
    }
  }

  // Persists live connections across renderer reload (main.ts keeps running undisturbed).
  connectedPeers(): Array<{ identity: DeviceIdentity; trusted: boolean }> {
    return [...this.peers.values()]
      .filter((p) => p.conn.peerIdentity !== null)
      .map((p) => ({ identity: p.conn.peerIdentity as DeviceIdentity, trusted: p.trusted }));
  }

  // Detect dead peers via TCP silence; send heartbeat only when idle to keep connection alive.
  runHeartbeatCycle(timeoutMs: number): void {
    const currentHash = this.trustStore.computePoolHash();
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (peer.conn.isStale(timeoutMs)) {
        peer.conn.close();
      } else if (now - peer.conn.lastActivityAt >= 4000) {
        // Only send keepalive when idle for >= 4s, saving power and avoiding redundant pings
        peer.conn.sendHeartbeat(false, currentHash);
      }
    }
  }

  private getPoolSyncList() {
    const list = this.trustStore.list().map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      certPem: d.certPem,
      protocolVersion: d.protocolVersion,
      lastKnownIp: d.lastKnownIp || this.remoteAddressOf(d.deviceId),
    }));

    // Include ourselves in the pool list
    list.push({
      deviceId: this.opts.myIdentity.deviceId,
      deviceName: this.opts.myIdentity.deviceName,
      certPem: this.opts.cert,
      protocolVersion: this.opts.myIdentity.protocolVersion || 1,
      lastKnownIp: undefined,
    });

    return list;
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

function extractPeerPublicKeyDer(conn: PeerConnection): Buffer | null {
  if (!conn.peerCertPem) return null;
  return extractPublicKeyDer(conn.peerCertPem);
}


