// Pairing state machine.
// Trust-on-first-use: no PIN, no shared-secret proof. See docs/PROTOCOL.md §6 for why this is
// intentional for this pass.

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { LinkPacket, createPacket } from './packet';

export type PairState = 'NotPaired' | 'Requested' | 'RequestedByPeer' | 'Paired';

export const PAIRING_TIMEOUT_MS = 30 * 1000;
const ALLOWED_TIMESTAMP_DIFF_SECONDS = 1800; // 30 min, matches upstream

export const PACKET_TYPE_PAIR = 'link.pair';

interface PairPacketBody {
  pair: boolean;
  timestamp?: number;
}

export interface PairingHandlerEvents {
  incomingPairRequest: () => void;
  pairingFailed: (reason: string) => void;
  pairingSuccessful: () => void;
  unpaired: () => void;
  /** Emitted when this handler needs to send a packet to the peer — caller wires this to the actual socket. */
  sendPacket: (packet: LinkPacket) => void;
}

export declare interface PairingHandler {
  on<E extends keyof PairingHandlerEvents>(event: E, listener: PairingHandlerEvents[E]): this;
  emit<E extends keyof PairingHandlerEvents>(event: E, ...args: Parameters<PairingHandlerEvents[E]>): boolean;
}

export class PairingHandler extends EventEmitter {
  private state: PairState;
  private pairingTimestamp = 0;
  private timeoutHandle: NodeJS.Timeout | null = null;

  constructor(
    initialState: PairState,
    private readonly myPublicKeyDer: Buffer,
    private readonly peerPublicKeyDer: () => Buffer | null
  ) {
    super();
    this.state = initialState;
  }

  get pairState(): PairState {
    return this.state;
  }

  /**
   * Snapshot/restore in-flight state across a connection swap. Discovery auto-connects both
   * sides to each other, so a simultaneous double-dial race (most likely right during a fresh
   * first-ever pairing) can cause the tie-break in device-manager.ts to replace a connection
   * mid-handshake. Without carrying this over, the replacement PairingHandler used to always
   * start fresh from trust-store state alone — silently dropping a Requested/RequestedByPeer
   * in-flight pairing, which caused a duplicate incoming-request prompt on one side and a
   * "never actually registers as paired" result on the other.
   */
  snapshot(): { state: PairState; pairingTimestamp: number } {
    return { state: this.state, pairingTimestamp: this.pairingTimestamp };
  }

  restore(snapshot: { state: PairState; pairingTimestamp: number }): void {
    this.state = snapshot.state;
    this.pairingTimestamp = snapshot.pairingTimestamp;
    if (this.state === 'Requested' || this.state === 'RequestedByPeer') {
      this.startTimeout();
    }
  }

  private clearTimeout() {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private startTimeout() {
    this.clearTimeout();
    this.timeoutHandle = setTimeout(() => this.onTimeout(), PAIRING_TIMEOUT_MS);
  }

  private onTimeout() {
    this.emit('sendPacket', createPacket<PairPacketBody>(PACKET_TYPE_PAIR, { pair: false }));
    this.state = 'NotPaired';
    this.emit('pairingFailed', 'Timed out');
  }

  /** Call with every incoming `link.pair` packet from this peer. */
  packetReceived(packet: LinkPacket<PairPacketBody>): void {
    this.clearTimeout();
    const wantsPair = !!packet.body.pair;

    if (wantsPair) {
      switch (this.state) {
        case 'Requested':
          this.pairingDone();
          break;
        case 'RequestedByPeer':
          // Ignore a second request while the first hasn't timed out yet.
          break;
        case 'Paired':
        case 'NotPaired': {
          if (this.state === 'Paired') {
            // Don't auto-accept — could infinite-loop if both sides "helpfully" auto-accept.
            // Unpair locally first, then fall through and treat this as a fresh request.
            this.state = 'NotPaired';
            this.emit('unpaired');
          }

          const timestamp = packet.body.timestamp;
          if (typeof timestamp !== 'number') {
            this.state = 'NotPaired';
            this.emit('unpaired');
            return;
          }
          const nowSeconds = Math.floor(Date.now() / 1000);
          if (Math.abs(timestamp - nowSeconds) > ALLOWED_TIMESTAMP_DIFF_SECONDS) {
            this.state = 'NotPaired';
            this.emit('pairingFailed', 'Device clocks are out of sync');
            return;
          }

          this.pairingTimestamp = timestamp;
          this.state = 'RequestedByPeer';
          this.startTimeout();
          this.emit('incomingPairRequest');
          break;
        }
      }
    } else {
      switch (this.state) {
        case 'NotPaired':
          // Already unpaired, nothing to do.
          break;
        case 'Requested':
        case 'RequestedByPeer':
          this.state = 'NotPaired';
          this.emit('pairingFailed', 'Rejected by other peer');
          break;
        case 'Paired':
          this.state = 'NotPaired';
          this.emit('unpaired');
          break;
      }
    }
  }

  /** Call to initiate pairing with this peer (user clicked "Pair"). */
  requestPairing(): boolean {
    this.clearTimeout();

    if (this.state === 'Paired') {
      this.emit('pairingFailed', 'Already paired');
      return false;
    }
    if (this.state === 'RequestedByPeer') {
      // They started first — just accept theirs instead of racing.
      return this.acceptPairing();
    }

    this.state = 'Requested';
    this.startTimeout();
    this.pairingTimestamp = Math.floor(Date.now() / 1000);

    this.emit(
      'sendPacket',
      createPacket<PairPacketBody>(PACKET_TYPE_PAIR, { pair: true, timestamp: this.pairingTimestamp })
    );
    return true;
  }

  /** Call to accept an incoming pair request (user clicked "Accept" in the UI). */
  acceptPairing(): boolean {
    this.clearTimeout();
    this.emit('sendPacket', createPacket<PairPacketBody>(PACKET_TYPE_PAIR, { pair: true }));
    this.pairingDone();
    return true;
  }

  /** Call to reject an incoming request, or cancel one this side sent. */
  cancelPairing(): void {
    this.clearTimeout();
    this.state = 'NotPaired';
    this.emit('sendPacket', createPacket<PairPacketBody>(PACKET_TYPE_PAIR, { pair: false }));
    this.emit('pairingFailed', 'Cancelled by user');
  }

  /** Explicitly break an existing pairing. Must be mirrored by cleanup on BOTH sides — see PROTOCOL.md. */
  unpair(): void {
    this.state = 'NotPaired';
    this.emit('sendPacket', createPacket<PairPacketBody>(PACKET_TYPE_PAIR, { pair: false }));
    this.emit('unpaired');
  }

  private pairingDone(): void {
    this.state = 'Paired';
    this.emit('pairingSuccessful');
  }

  /**
   * SHA-256 of both devices' public keys (larger DER first, deterministic regardless of who's
   * "us"), plus the pairing timestamp — first 8 hex chars, uppercased. Shown on both screens for
   * the user to optionally eyeball-compare. NOT a cryptographic proof, just a shared computed value.
   */
  verificationKey(): string | null {
    const peerKey = this.peerPublicKeyDer();
    if (!peerKey) return null;
    return computeVerificationCode(this.myPublicKeyDer, peerKey, String(this.pairingTimestamp));
  }
}

/**
 * The same deterministic "eyeball-compare" hash `PairingHandler.verificationKey()` computes,
 * pulled out as a standalone function so callers that don't want the full stateful pairing
 * machinery (trust-store writes, Requested/Paired state machine) can still reuse the exact same
 * hashing approach — e.g. Audio Relay's ephemeral guest-session PIN, which must NEVER touch
 * `PairingHandler`/`TrustStore` but still wants the same "both sides independently compute the
 * same value from the certs they each saw during the handshake" tamper-evidence property.
 * `salt` defaults to '' (no per-session salt) — pass a session-specific value (nonce, timestamp)
 * if the caller wants a fresh code per session rather than a fixed one per device-pair.
 */
export function computeVerificationCode(keyDerA: Buffer, keyDerB: Buffer, salt = ''): string {
  let a = keyDerA;
  let b = keyDerB;
  if (Buffer.compare(a, b) < 0) {
    [a, b] = [b, a];
  }

  const hash = crypto.createHash('sha256');
  hash.update(a);
  hash.update(b);
  hash.update(salt);

  return hash.digest('hex').slice(0, 8).toUpperCase();
}
