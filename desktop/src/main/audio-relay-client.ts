// Audio Relay — listener side, when THIS desktop is listening to another host (not hosting
// itself). Mirrors audio-relay-server.ts's protocol exactly: connects with the device's own
// long-lived TLS identity (the host needs to see it to compute the PIN, or to match a token),
// announces intent as the first message, then either waits for a human PIN-confirm (guest path)
// or is admitted immediately (paired-token path) — same one-relay-server, two-admission-paths
// design as the host side.
//
// PCM audio arrives over a separate UDP socket, not this WS connection — see audio-relay-
// server.ts's header comment for the full reasoning (TCP head-of-line blocking vs. real-time
// audio). This WS connection keeps carrying every control message unchanged. The 'admitted'
// message now also carries our connId and a per-session AES-256-GCM key; we open a UDP socket,
// send one "hello" datagram (our connId) so the host learns our (address, port), then every
// incoming UDP datagram is decrypted+auth-verified with that key before being handed to the
// renderer exactly as before.
//
// Playback happens in the renderer (Web Audio API — no native dependency needed there, see the
// plan this was built from) — this module just gets PCM frames out of the wire and up to the
// renderer via the same event pattern the rest of main.ts already uses for IPC pushes.

import * as crypto from 'crypto';
import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { Decoder as OpusDecoderClass } from '@evan/opus';
import { computeVerificationCode } from '../core/pairing';
import { AUDIO_RELAY_UDP_PORT } from '../core/transport';

// Same guarded-load pattern as audio-relay-server.ts's OpusEncoderCtor — see that file's comment
// for why this is a defensive fallback, not an expected common case.
let OpusDecoderCtor: typeof OpusDecoderClass | null = null;
try {
  OpusDecoderCtor = require('@evan/opus').Decoder;
} catch {
  OpusDecoderCtor = null;
}

const UDP_NONCE_BYTES = 12;
const UDP_SEQ_BYTES = 4;
const UDP_AUTH_TAG_BYTES = 16;
// The host slices each capture chunk into several MTU-safe sub-packets and fires them in a tight
// back-to-back burst (no inter-packet delay) — exactly the pattern that lets Wi-Fi/NIC-level
// reordering shuffle packets relative to each other even on a healthy LAN. A strict "drop anything
// not strictly increasing" rule then discards perfectly good, just slightly-late packets, which
// sounds identical to real loss (a click at the resulting gap) but happens far more often. This
// small reorder window holds a few out-of-order arrivals and releases them once the gap fills, so
// only a genuinely lost packet (buffer fills up without the gap ever showing) gets skipped.
const REORDER_WINDOW_MAX = 8;

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
}

export type JoinMode = { kind: 'guest' } | { kind: 'token'; token: string };

export interface AudioRelayClientEvents {
  /** Fired once, right after connecting, only for the guest path — UI should show this PIN and
   *  wait for the host to accept/reject; nothing further happens until 'admitted' or 'closed'. */
  pinComputed: (pin: string) => void;
  admitted: () => void;
  format: (format: AudioFormat) => void;
  /** Raw PCM bytes for one chunk (codec-tag byte already stripped) — hand straight to Web Audio. */
  audioChunk: (pcm: Buffer) => void;
  hostMuted: (muted: boolean) => void;
  ended: () => void;
  closed: (reason: string) => void;
  error: (err: Error) => void;
}

export declare interface AudioRelayClient {
  on<E extends keyof AudioRelayClientEvents>(event: E, listener: AudioRelayClientEvents[E]): this;
  emit<E extends keyof AudioRelayClientEvents>(event: E, ...args: Parameters<AudioRelayClientEvents[E]>): boolean;
}

const CODEC_TAG_PCM = 0x00;
const CODEC_TAG_OPUS = 0x01;

export class AudioRelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pinComputedLocally = false;
  private udpSocket: dgram.Socket | null = null;
  private sessionKey: Buffer | null = null;
  private nextExpectedSeq = -1; // -1 = not bootstrapped yet; accept whatever arrives first
  private reorderBuffer = new Map<number, Buffer>(); // seq -> decrypted payload (still encoded if opus), awaiting its turn
  // Built fresh from each session's "format" message — see that handler for why a missing decoder
  // here (Opus unavailable on this machine) surfaces as an 'error' event rather than a crash.
  private opusDecoder: InstanceType<typeof OpusDecoderClass> | null = null;

  constructor(
    private host: string,
    private port: number,
    private clientCert: string,
    private clientKey: string
  ) {
    super();
  }

  connect(mode: JoinMode): void {
    const url = `wss://${this.host}:${this.port}`;
    this.ws = new WebSocket(url, {
      rejectUnauthorized: false, // self-signed peer, verified at the app layer (PIN/token) not here
      handshakeTimeout: 15000,
      cert: this.clientCert,
      key: this.clientKey,
    });

    this.ws.on('open', () => {
      const socket = (this.ws as any)._socket;
      if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

      if (mode.kind === 'token') {
        this.ws!.send(JSON.stringify({ type: 'join-token', token: mode.token }));
      } else {
        // Compute our own PIN independently from what THIS side saw during the handshake —
        // preferred over trusting a value the server tells us, so a genuine MITM (relaying/
        // proxying the connection) would produce a mismatch a human would notice, preserving the
        // same tamper-evidence property normal pairing's PIN already has. Falls back to the
        // server's own 'pin' control message (see the message handler below) only if this fails
        // — kept as a fallback rather than the primary path since it's weaker (see
        // audio-relay-server.ts's join-guest branch for the full reasoning).
        this.pinComputedLocally = false;
        const peerCert = (this.ws as any)._socket?.getPeerCertificate?.();
        if (peerCert && peerCert.raw) {
          try {
            const peerPublicKeyDer = new crypto.X509Certificate(peerCert.raw).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
            const myPublicKeyDer = new crypto.X509Certificate(this.clientCert).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
            const pin = computeVerificationCode(myPublicKeyDer, peerPublicKeyDer);
            this.pinComputedLocally = true;
            this.emit('pinComputed', pin);
          } catch (e: any) {
            this.emit('error', new Error('Failed to compute PIN: ' + e.message));
          }
        }
        this.ws!.send(JSON.stringify({ type: 'join-guest' }));
      }
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      // Audio no longer arrives over this connection at all (see this file's header comment) —
      // every message here is a JSON control message now.
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'admitted') {
        this.setupUdp(msg.connId, msg.udpKey);
        this.emit('admitted');
      }
      else if (msg.type === 'format') this.handleFormatMessage(msg);
      else if (msg.type === 'hostMuted') this.emit('hostMuted', !!msg.muted);
      else if (msg.type === 'ended') this.emit('ended');
      else if (msg.type === 'pin' && !this.pinComputedLocally) this.emit('pinComputed', msg.code);
    });

    this.ws.on('close', (code, reason) => {
      this.emit('closed', reason?.toString() || `code ${code}`);
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /** Builds (or tears down) the Opus decoder for this session before forwarding the format info
   *  up to the renderer unchanged — the renderer's PcmPlayer always just gets raw PCM handed to
   *  it via 'audioChunk' regardless of wire codec, so it needs zero changes for Opus support; all
   *  of that is handled here and in deliver(). */
  private handleFormatMessage(msg: any) {
    this.opusDecoder = null;
    if (msg.codec === 'opus') {
      if (!OpusDecoderCtor) {
        this.emit('error', new Error('Host is streaming Opus-encoded audio but this device has no Opus support available — audio will not play.'));
      } else {
        try {
          this.opusDecoder = new OpusDecoderCtor({ channels: msg.channels as 1 | 2, sample_rate: msg.sampleRate });
        } catch (e: any) {
          this.opusDecoder = null;
          this.emit('error', new Error('Failed to initialize Opus decoder: ' + (e?.message || e)));
        }
      }
    }
    this.emit('format', { sampleRate: msg.sampleRate, channels: msg.channels, bitsPerSample: msg.bitsPerSample, isFloat: msg.isFloat });
  }

  /** Opens the UDP socket for this session and sends the one "hello" datagram that lets the host
   *  learn our (address, port) — see audio-relay-server.ts's header comment for the full protocol. */
  private setupUdp(connId: string, udpKeyBase64: string) {
    if (typeof connId !== 'string' || typeof udpKeyBase64 !== 'string') return;
    this.sessionKey = Buffer.from(udpKeyBase64, 'base64');
    this.nextExpectedSeq = -1;
    this.reorderBuffer.clear();

    this.udpSocket = dgram.createSocket('udp4');
    this.udpSocket.on('message', (msg) => this.handleUdpFrame(msg));
    this.udpSocket.on('error', (err) => this.emit('error', err));
    this.udpSocket.bind(() => {
      // The host fires several sub-packets per capture chunk back-to-back with zero delay (see
      // MAX_UDP_PCM_BYTES on the host side) — a real burst, not a steady trickle. The OS default
      // receive buffer is sized for typical request/response traffic, not that; if this process's
      // event loop is even briefly busy elsewhere while a burst arrives, the kernel can silently
      // drop the tail of it before we ever see it. 128KB is ~10x a single burst's worst-case size
      // — enough headroom without inviting the bufferbloat-style latency growth a much larger
      // buffer (this was 1MB) causes once anything downstream runs even slightly behind on
      // average: a queue that can grow huge just delays the reckoning instead of preventing it.
      try { this.udpSocket!.setRecvBufferSize(1 << 17); } catch {} // 128KB
      this.udpSocket!.send(Buffer.from(connId, 'utf8'), AUDIO_RELAY_UDP_PORT, this.host);
    });
  }

  private handleUdpFrame(frame: Buffer) {
    if (!this.sessionKey) return;
    const minLen = UDP_SEQ_BYTES + UDP_NONCE_BYTES + UDP_AUTH_TAG_BYTES;
    if (frame.length < minLen) return;

    const seq = frame.readUInt32BE(0);
    const nonce = frame.subarray(UDP_SEQ_BYTES, UDP_SEQ_BYTES + UDP_NONCE_BYTES);
    const authTag = frame.subarray(frame.length - UDP_AUTH_TAG_BYTES);
    const ciphertext = frame.subarray(UDP_SEQ_BYTES + UDP_NONCE_BYTES, frame.length - UDP_AUTH_TAG_BYTES);

    // Sequence check before decryption would be cheaper, but doing it after means a spoofed
    // packet with a fresh-looking seq still gets rejected by the auth tag rather than accepted —
    // decrypt-then-check keeps auth failure and staleness as two independent reasons to drop, not
    // one masking the other.
    let payload: Buffer;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.sessionKey, nonce);
      decipher.setAuthTag(authTag);
      payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      return; // failed auth — wrong key, corrupted, or spoofed; silently drop
    }

    this.acceptDecrypted(seq, payload);
  }

  /** Reorder-tolerant delivery: plays packets in seq order, briefly holding out-of-order arrivals
   *  instead of dropping them outright — see this file's REORDER_WINDOW_MAX comment for why a
   *  strict monotonic check isn't safe for a burst of back-to-back sub-packets. */
  private acceptDecrypted(seq: number, payload: Buffer) {
    if (this.nextExpectedSeq === -1) {
      this.nextExpectedSeq = seq;
    } else if (seq < this.nextExpectedSeq) {
      return; // stale — already played, a duplicate, or a replayed/spoofed packet
    }

    if (seq === this.nextExpectedSeq) {
      this.deliver(payload);
      this.nextExpectedSeq++;
      this.drainReorderBuffer();
      return;
    }

    // Ahead of what we're waiting for — hold it briefly in case the gap is just reordering, not
    // real loss. If too many later packets pile up without the gap ever showing, give up on it.
    this.reorderBuffer.set(seq, payload);
    if (this.reorderBuffer.size > REORDER_WINDOW_MAX) {
      this.nextExpectedSeq = Math.min(...this.reorderBuffer.keys());
      this.drainReorderBuffer();
    }
  }

  private drainReorderBuffer() {
    let next = this.reorderBuffer.get(this.nextExpectedSeq);
    while (next !== undefined) {
      this.reorderBuffer.delete(this.nextExpectedSeq);
      this.deliver(next);
      this.nextExpectedSeq++;
      next = this.reorderBuffer.get(this.nextExpectedSeq);
    }
  }

  private deliver(payload: Buffer) {
    if (payload.length < 1) return;
    const codecTag = payload[0];
    const body = payload.subarray(1);
    if (codecTag === CODEC_TAG_PCM) {
      this.emit('audioChunk', body);
    } else if (codecTag === CODEC_TAG_OPUS) {
      if (!this.opusDecoder) return; // unavailable — already surfaced via 'error' in handleFormatMessage
      try {
        this.emit('audioChunk', Buffer.from(this.opusDecoder.decode(body)));
      } catch {
        // One bad/corrupted frame — drop it and keep going, same as a PCM auth failure already
        // does, rather than surfacing an error for what's normally a rare, transient event.
      }
    }
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(1000, 'left'); } catch {}
      this.ws = null;
    }
    if (this.udpSocket) {
      try { this.udpSocket.close(); } catch {}
      this.udpSocket = null;
    }
    this.sessionKey = null;
    this.opusDecoder = null;
  }
}
