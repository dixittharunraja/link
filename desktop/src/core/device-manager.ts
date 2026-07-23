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
import {
  OwnerKeyStore,
  RevocationStore,
  MembershipCert,
  Revocation,
  OwnerKeyPair,
  generateOwnerKeyPair,
  issueMembershipCert,
  verifyMembershipCert,
  signRevocation,
  verifyRevocation,
  PACKET_TYPE_POOL_ENROLL,
  PACKET_TYPE_POOL_REVOKE,
} from './pool';

interface ManagedPeer {
  conn: PeerConnection;
  pairing: PairingHandler;
  trusted: boolean;
}

export interface DeviceManagerEvents {
  deviceConnected: (identity: DeviceIdentity, trusted: boolean) => void;
  deviceDisconnected: (deviceId: string) => void;
  incomingPairRequest: (deviceId: string, verificationKey: string | null) => void;
  pairingSuccessful: (deviceId: string) => void;
  pairingFailed: (deviceId: string, reason: string) => void;
  unpaired: (deviceId: string) => void;
  trustMismatch: (deviceId: string) => void;
  packet: (deviceId: string, packet: LinkPacket) => void;
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
    port: number = LINK_PORT,
    // Trusted Pool (Wave 2). Optional so existing callers/tests still work; main.ts passes them.
    private ownerStore?: OwnerKeyStore,
    private revStore?: RevocationStore
  ) {
    super();
    this.myPublicKeyDer = extractPublicKeyDer(opts.cert);
    this.refreshMyPoolIdentity();

    this.server = new LinkServer(opts, port);
    this.server.on('connection', (conn) => this.attach(conn));
  }

  /** Stamp this device's current pool membership onto the shared identity object, so every NEW
   *  connection advertises it (the identity packet is the auto-mesh signal — see attach's
   *  onIdentity). Called at startup and whenever credentials change (enroll / exit). */
  private refreshMyPoolIdentity(): void {
    if (!this.ownerStore) return;
    const fp = this.ownerStore.fingerprint();
    const membership = this.ownerStore.getMembership();
    if (fp && membership) {
      this.opts.myIdentity.ownerKeyFingerprint = fp;
      this.opts.myIdentity.membershipCert = membership;
    } else {
      delete this.opts.myIdentity.ownerKeyFingerprint;
      delete this.opts.myIdentity.membershipCert;
    }
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
          // Certificate mismatch on an already-trusted device — never silently re-pin.
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

      // Auto-mesh (Trusted Pool, item 8): a device we haven't manually paired with, but which
      // presents a valid membership cert signed by OUR OWN owner key, is one of our own pool
      // devices — trust it with no second PIN. Verified against the peer's ACTUAL presented TLS
      // cert (not just its claimed deviceId), and refused if the device has been revoked.
      let trusted = !!existing;
      if (!trusted && this.tryAutoTrust(conn, identity)) {
        trusted = true;
      }

      const pairing = new PairingHandler(
        trusted ? 'Paired' : 'NotPaired',
        this.myPublicKeyDer,
        () => extractPeerPublicKeyDer(conn)
      );
      // Carry any in-flight pairing state over from the connection being replaced — see
      // PairingHandler.snapshot()/restore() for why this matters.
      if (existingPeer) {
        pairing.restore(existingPeer.pairing.snapshot());
      }

      pairing.on('sendPacket', (packet) => conn.send(packet));
      pairing.on('incomingPairRequest', () => {
        this.emit('incomingPairRequest', identity.deviceId, pairing.verificationKey());
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
        // Item 7: the manual PIN pairing that just completed is the human gate for bringing a new
        // device into the pool. Now bootstrap it — hand over the owner key + issue its membership
        // cert — so it can auto-mesh with the rest of the pool without pairing each one.
        this.enrollAfterPairing(conn, identity);
        this.emit('pairingSuccessful', identity.deviceId);
      });
      pairing.on('pairingFailed', (reason) => this.emit('pairingFailed', identity.deviceId, reason));
      pairing.on('unpaired', () => {
        this.trustStore.unpair(identity.deviceId);
        const peer = this.peers.get(identity.deviceId);
        if (peer) peer.trusted = false;
        this.emit('unpaired', identity.deviceId);
      });

      this.peers.set(identity.deviceId, { conn, pairing, trusted });
      this.emit('deviceConnected', identity, trusted);
    });

    conn.on('packet', (packet) => {
      const peerEntry = [...this.peers.entries()].find(([, p]) => p.conn === conn);
      if (!peerEntry) return;
      const [deviceId, peer] = peerEntry;

      if (packet.type === PACKET_TYPE_PAIR) {
        peer.pairing.packetReceived(packet as LinkPacket<{ pair: boolean; timestamp?: number }>);
        return;
      }

      if (!peer.trusted) return; // ignore feature packets from unpaired devices

      // Pool control packets (Trusted Pool, items 7 & 9) — handled internally, never surfaced as
      // ordinary feature packets. They only ever arrive over an already-trusted connection.
      if (packet.type === PACKET_TYPE_POOL_ENROLL) {
        this.applyEnrollment(packet.body as { owner: OwnerKeyPair; membership: MembershipCert });
        return;
      }
      if (packet.type === PACKET_TYPE_POOL_REVOKE) {
        this.applyRevocation((packet.body as { revocation: Revocation }).revocation, conn);
        return;
      }

      this.emit('packet', deviceId, packet);
    });

    conn.on('close', () => {
      const peerEntry = [...this.peers.entries()].find(([, p]) => p.conn === conn);
      if (peerEntry) {
        // Delete before emitting — listeners that synchronously check trustedConnectedDeviceIds()
        // inside their deviceDisconnected handler (e.g. screensaver-inhibit) must see this device
        // already gone, not the stale pre-disconnect state.
        this.peers.delete(peerEntry[0]);
        this.emit('deviceDisconnected', peerEntry[0]);
      }
    });

    conn.on('error', (err) => {
      console.error('PeerConnection error:', err.message);
    });
  }

  // ===== Trusted Pool (Wave 2) =====

  /** Item 8: verify a peer's advertised membership cert against OUR own owner key + the peer's
   *  actual TLS cert, and write it into the trust store if it checks out. Returns true if trusted. */
  private tryAutoTrust(conn: PeerConnection, identity: DeviceIdentity): boolean {
    if (!this.ownerStore || !this.ownerStore.hasKey()) return false;
    if (!identity.membershipCert || !identity.ownerKeyFingerprint) return false;
    if (!conn.peerCertPem) return false;
    if (this.revStore?.has(identity.deviceId)) return false; // revoked — never auto-trust

    const myFp = this.ownerStore.fingerprint();
    if (identity.ownerKeyFingerprint !== myFp) return false; // different pool

    const owner = this.ownerStore.get();
    if (!owner) return false;
    const peerCertFp = certFingerprint(conn.peerCertPem);
    if (!verifyMembershipCert(identity.membershipCert, owner.publicKeyDerB64, identity.deviceId, peerCertFp)) {
      return false;
    }

    this.trustStore.pair({
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      certPem: conn.peerCertPem,
      protocolVersion: identity.protocolVersion,
      pairedAt: Date.now(),
    });
    return true;
  }

  /** Item 7: right after a manual pair completes, bootstrap the peer into the pool. Deterministic —
   *  both sides run the identical evaluation off the identities they already exchanged, so exactly
   *  one side enrolls the other with no extra negotiation. */
  private enrollAfterPairing(conn: PeerConnection, identity: DeviceIdentity): void {
    if (!this.ownerStore || !conn.peerCertPem) return;

    const myFp = this.ownerStore.fingerprint();          // null if I'm not in a pool yet
    const peerFp = identity.ownerKeyFingerprint ?? null; // null if the peer isn't

    if (myFp && peerFp) {
      // Both already in a pool: same pool = nothing to do; different pools = no-merge (per scope).
      return;
    }
    if (!myFp && peerFp) {
      // Peer has a pool, I don't → the peer enrolls me. Just wait for its link.pool.enroll.
      return;
    }
    if (!myFp && !peerFp) {
      // Neither is in a pool → this pairing CREATES one. Deterministic creator = larger deviceId,
      // so both sides agree without negotiating; the other side simply waits for the enroll packet.
      if (this.opts.myIdentity.deviceId > identity.deviceId) {
        const owner = generateOwnerKeyPair();
        const myMembership = issueMembershipCert(owner, this.opts.myIdentity.deviceId, certFingerprint(this.opts.cert));
        this.ownerStore.setCredentials(owner, myMembership);
        this.refreshMyPoolIdentity();
        this.sendEnroll(conn, identity);
      }
      return;
    }
    // myFp && !peerFp → I enroll the peer.
    this.sendEnroll(conn, identity);
  }

  private sendEnroll(conn: PeerConnection, identity: DeviceIdentity): void {
    const owner = this.ownerStore?.get();
    if (!owner || !conn.peerCertPem) return;
    const membership = issueMembershipCert(owner, identity.deviceId, certFingerprint(conn.peerCertPem));
    conn.send(createPacket(PACKET_TYPE_POOL_ENROLL, { owner, membership } as unknown as Record<string, unknown>));
  }

  /** Received link.pool.enroll: store the handed-over owner key + our own membership cert, verify
   *  it's genuinely for us, then re-mesh so already-open connections upgrade to trusted. */
  private applyEnrollment(body: { owner: OwnerKeyPair; membership: MembershipCert }): void {
    if (!this.ownerStore || this.ownerStore.hasKey()) return; // already in a pool — ignore
    const { owner, membership } = body || ({} as any);
    if (!owner || !membership) return;
    const myCertFp = certFingerprint(this.opts.cert);
    if (!verifyMembershipCert(membership, owner.publicKeyDerB64, this.opts.myIdentity.deviceId, myCertFp)) {
      return; // not a valid cert for THIS device — reject
    }
    this.ownerStore.setCredentials(owner, membership);
    this.refreshMyPoolIdentity();
    // Force any still-open UNTRUSTED connections to reconnect: on the fresh handshake both sides
    // now advertise membership, so they auto-mesh mutually. Trusted connections are untouched.
    this.closeUntrustedConnections();
  }

  private closeUntrustedConnections(): void {
    for (const peer of [...this.peers.values()]) {
      if (!peer.trusted) peer.conn.close();
    }
  }

  /** Received link.pool.revoke: verify against our owner key, record it, drop the device if here,
   *  and flood it onward to our other pool members so it propagates. If it names US, we've been
   *  kicked — wipe our own credentials. */
  private applyRevocation(rev: Revocation, from: PeerConnection): void {
    if (!this.ownerStore || !this.revStore) return;
    const owner = this.ownerStore.get();
    if (!owner || !verifyRevocation(rev, owner.publicKeyDerB64)) return;

    const isNew = this.revStore.add(rev);
    if (!isNew) return; // already seen — stop the flood

    if (rev.deviceId === this.opts.myIdentity.deviceId) {
      // We were removed from the pool by another member. Leave: wipe credentials, drop everyone.
      this.ownerStore.clear();
      this.refreshMyPoolIdentity();
      for (const [id, peer] of [...this.peers.entries()]) {
        this.trustStore.unpair(id);
        peer.trusted = false;
        peer.conn.close();
      }
      return;
    }

    // Drop the revoked device if it's currently connected/trusted.
    const target = this.peers.get(rev.deviceId);
    if (target) {
      this.trustStore.unpair(rev.deviceId);
      target.trusted = false;
      target.conn.close();
      this.emit('unpaired', rev.deviceId);
    } else {
      this.trustStore.unpair(rev.deviceId);
    }
    // Flood onward to every OTHER trusted pool member.
    for (const peer of this.peers.values()) {
      if (peer.trusted && peer.conn !== from) {
        peer.conn.send(createPacket(PACKET_TYPE_POOL_REVOKE, { revocation: rev } as unknown as Record<string, unknown>));
      }
    }
  }

  /** Remove another device from the pool (item 9). Owner-signs a revocation, applies it locally,
   *  and gossips it to every connected member. Falls back to a plain unpair if we're not in a pool. */
  removeFromPool(deviceId: string): void {
    const owner = this.ownerStore?.get();
    if (owner && this.revStore) {
      const rev = signRevocation(owner, deviceId);
      this.revStore.add(rev);
      for (const peer of this.peers.values()) {
        if (peer.trusted) {
          peer.conn.send(createPacket(PACKET_TYPE_POOL_REVOKE, { revocation: rev } as unknown as Record<string, unknown>));
        }
      }
    }
    this.unpair(deviceId);
  }

  /** Leave the pool ourselves (item 9). Sign our own revocation so the others drop us, gossip it,
   *  then wipe our credentials and unpair everyone. Falls back to unpair-all if not in a pool. */
  exitPool(): void {
    const owner = this.ownerStore?.get();
    if (owner) {
      const rev = signRevocation(owner, this.opts.myIdentity.deviceId);
      for (const peer of this.peers.values()) {
        if (peer.trusted) {
          peer.conn.send(createPacket(PACKET_TYPE_POOL_REVOKE, { revocation: rev } as unknown as Record<string, unknown>));
        }
      }
      this.ownerStore?.clear();
      this.refreshMyPoolIdentity();
    }
    for (const id of [...this.peers.keys()]) {
      this.unpair(id);
    }
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

  rejectPairing(deviceId: string): void {
    this.peers.get(deviceId)?.pairing.cancelPairing();
  }

  unpair(deviceId: string): void {
    const peer = this.peers.get(deviceId);
    if (peer) {
      peer.pairing.unpair();
      peer.conn.close(); // Force-close socket immediately on disconnect
    }
    // Cover the case where the device isn't currently connected — still drop local trust.
    this.trustStore.unpair(deviceId);
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

  hasPeer(deviceId: string): boolean {
    return this.peers.has(deviceId);
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
