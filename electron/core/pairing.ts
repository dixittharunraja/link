// Pairing state machine (trust-on-first-use).

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { LinkPacket, createPacket } from './packet';

export type PairState = 'NotPaired' | 'Requested' | 'RequestedByPeer' | 'Paired';

const PAIRING_TIMEOUT_MS = 30 * 1000;
const ALLOWED_TIMESTAMP_DIFF_SECONDS = 1800; // 30 min, matches upstream

export const PACKET_TYPE_PAIR = 'link.pair';

interface PairPacketBody {
  pair: boolean;
  timestamp?: number;
}

interface PairingHandlerEvents {
  incomingPairRequest: () => void;
  pairingFailed: (reason: string) => void;
  pairingSuccessful: () => void;
  unpaired: () => void;
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

  // Preserve in-flight state across connection swaps (simultaneous double-dial).
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

  setPairState(state: PairState): void {
    this.clearTimeout();
    this.state = state;
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

  packetReceived(packet: LinkPacket<PairPacketBody>): void {
    this.clearTimeout();
    const wantsPair = !!packet.body.pair;

    if (wantsPair) {
      switch (this.state) {
        case 'Requested':
          this.pairingDone();
          break;
        case 'RequestedByPeer':
          break;
        case 'Paired':
        case 'NotPaired': {
          if (this.state === 'Paired') {
            // Unpair first to avoid double-accept loop.
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

  requestPairing(): boolean {
    this.clearTimeout();

    if (this.state === 'Paired') {
      this.emit('pairingFailed', 'Already paired');
      return false;
    }
    if (this.state === 'RequestedByPeer') {
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

  acceptPairing(): boolean {
    this.clearTimeout();
    this.emit('sendPacket', createPacket<PairPacketBody>(PACKET_TYPE_PAIR, { pair: true }));
    this.pairingDone();
    return true;
  }

  cancelPairing(): void {
    this.clearTimeout();
    this.state = 'NotPaired';
    this.emit('sendPacket', createPacket<PairPacketBody>(PACKET_TYPE_PAIR, { pair: false }));
    this.emit('pairingFailed', 'Cancelled by user');
  }

  unpair(): void {
    this.state = 'NotPaired';
    this.emit('sendPacket', createPacket<PairPacketBody>(PACKET_TYPE_PAIR, { pair: false }));
    this.emit('unpaired');
  }

  private pairingDone(): void {
    this.state = 'Paired';
    this.emit('pairingSuccessful');
  }

  verificationKey(): string | null {
    const peerKey = this.peerPublicKeyDer();
    if (!peerKey) return null;
    return computeVerificationCode(this.myPublicKeyDer, peerKey, String(this.pairingTimestamp));
  }
}

// Deterministic code from both devices' public keys + optional salt (for ephemeral codes like guest PINs).
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
