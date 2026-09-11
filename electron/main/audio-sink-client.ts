// Audio Sink / Remote Mic — listener side (this class is shared by both: same PCM-relay protocol,
// different port, see main.ts's wireAudioSinkClientEvents vs wireRemoteMicClientEvents). Connects
// with the device's own long-lived TLS identity, announces intent as the first message.
//
// The two hosts this connects to are NOT symmetric on the accept step, which is why the PIN
// machinery below has to stay even though Audio Sink itself doesn't need it: Audio Sink's own
// host (audio-sink-server.ts, and LinkAudioSinkServer.java on Android) admits a guest join
// immediately, no human confirmation. Remote Mic's host (LinkRemoteMicServer.java — Android only,
// since desktop never hosts Remote Mic) still gates a guest join on a human PIN accept/reject.
// wireAudioSinkClientEvents simply never forwards 'pinComputed' to the renderer, since Audio
// Sink's own UI has nothing to do with it; wireRemoteMicClientEvents does forward it.
//
// PCM audio arrives over a separate UDP socket, not this WS connection — see audio-sink-
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

// Same guarded-load pattern as audio-sink-server.ts's OpusEncoderCtor — see that file's comment
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

import { normalizeHost } from '../core/transport';

interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
}

export type JoinMode = { kind: 'guest' } | { kind: 'token'; token: string };

interface AudioSinkClientEvents {
  /** Fired once, right after connecting, only for the guest path. Audio Sink's own host admits
   *  immediately regardless (see this file's header comment), so Audio Sink's own event wiring
   *  never forwards this to the renderer; Remote Mic's host genuinely still gates on it. */
  pinComputed: (pin: string) => void;
  admitted: (hostName: string) => void;
  format: (format: AudioFormat) => void;
  /** Raw PCM bytes for one chunk (codec-tag byte already stripped) — hand straight to Web Audio. */
  audioChunk: (pcm: Buffer) => void;
  hostMuted: (muted: boolean) => void;
  /** `reason` is set when this close came from the host kicking just this listener (server sends
   *  no {type:'ended'} message first, only a plain 1000 close with a reason) — undefined for a
   *  graceful whole-session end. See audio-sink-client.ts's onWsClose for the full distinction. */
  ended: (reason?: string) => void;
  closed: (reason: string) => void;
  error: (err: Error) => void;
}

export declare interface AudioSinkClient {
  on<E extends keyof AudioSinkClientEvents>(event: E, listener: AudioSinkClientEvents[E]): this;
  emit<E extends keyof AudioSinkClientEvents>(event: E, ...args: Parameters<AudioSinkClientEvents[E]>): boolean;
}

const CODEC_TAG_PCM = 0x00;
const CODEC_TAG_OPUS = 0x01;

export class AudioSinkClient extends EventEmitter {
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
    private clientKey: string,
    private localDeviceName: string
  ) {
    super();
  }

  connect(mode: JoinMode): void {
    const hosts = this.host.split(',').map((h) => normalizeHost(h)).filter(Boolean);
    
    if (hosts.length <= 1) {
      this.connectSingle(this.host, mode);
      return;
    }

    let resolved = false;
    const clients: WebSocket[] = [];

    const cleanupOthers = (successfulWs: WebSocket) => {
      resolved = true;
      for (const client of clients) {
        if (client !== successfulWs) {
          try {
            client.removeAllListeners();
            client.close();
          } catch {}
        }
      }
    };

    for (const rawHost of hosts) {
      const host = normalizeHost(rawHost);
      const url = `wss://${host}:${this.port}`;
      const ws = new WebSocket(url, {
        rejectUnauthorized: false, // self-signed peer, verified at the app layer (PIN/token) not here
        handshakeTimeout: 10000,
        cert: this.clientCert,
        key: this.clientKey,
      });
      clients.push(ws);

      ws.on('open', () => {
        if (resolved) {
          try { ws.close(); } catch {}
          return;
        }
        cleanupOthers(ws);
        this.ws = ws;
        this.onWsOpen(ws, mode);
      });

      ws.on('message', (data: WebSocket.RawData) => {
        if (this.ws === ws) {
          this.onWsMessage(data);
        }
      });

      ws.on('close', (code, reason) => {
        if (this.ws === ws) {
          this.onWsClose(code, reason);
        }
      });

      ws.on('error', (err) => {
        if (this.ws === ws) {
          this.onWsError(err);
        } else if (!resolved && clients.every(c => c.readyState === WebSocket.CLOSED || c.readyState === WebSocket.CLOSING)) {
          this.emit('error', err);
        }
      });
    }
  }

  private connectSingle(rawHost: string, mode: JoinMode): void {
    const host = normalizeHost(rawHost);
    const url = `wss://${host}:${this.port}`;
    this.ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout: 15000,
      cert: this.clientCert,
      key: this.clientKey,
    });

    this.ws.on('open', () => this.onWsOpen(this.ws!, mode));
    this.ws.on('message', (data: WebSocket.RawData) => this.onWsMessage(data));
    this.ws.on('close', (code, reason) => this.onWsClose(code, reason));
    this.ws.on('error', (err) => this.onWsError(err));
  }

  private onWsOpen(ws: WebSocket, mode: JoinMode): void {
    const socket = (ws as any)._socket;
    if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

    if (mode.kind === 'token') {
      ws.send(JSON.stringify({ type: 'join-token', token: mode.token }));
    } else {
      // Compute our own PIN independently from what THIS side saw during the handshake —
      // preferred over trusting a value the server tells us, so a genuine MITM (relaying/
      // proxying the connection) would produce a mismatch a human would notice. Only Remote
      // Mic's host actually gates admission on this (Audio Sink's own host ignores it entirely
      // and admits immediately — see this file's header comment), but this class can't tell
      // which feature it's being used for, so it always computes and offers the PIN; whichever
      // side's event wiring in main.ts chooses to forward it decides whether it's shown.
      this.pinComputedLocally = false;
      const peerCert = (ws as any)._socket?.getPeerCertificate?.();
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
      ws.send(JSON.stringify({ type: 'join-guest', deviceName: this.localDeviceName }));
    }
  }

  private onWsMessage(data: WebSocket.RawData): void {
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
      this.emit('admitted', msg.hostName || '');
    }
    else if (msg.type === 'format') this.handleFormatMessage(msg);
    else if (msg.type === 'hostMuted') this.emit('hostMuted', !!msg.muted);
    else if (msg.type === 'ended') this.emit('ended');
    else if (msg.type === 'pin' && !this.pinComputedLocally) this.emit('pinComputed', msg.code);
  }

  private onWsClose(code: number, reason: any): void {
    // 1000 (normal closure) and 1001 (going away) are the codes a graceful host-initiated
    // ending produces — the host's stop() broadcasts {type:'ended'} then closes with exactly
    // code 1000, but there's a real race between that message being delivered/processed and
    // this socket-level close event firing (network delivery isn't instant, and closing right
    // after sending doesn't guarantee the message was flushed first) — so this event can arrive
    // instead of, or before, that message ever gets handled. Treating these codes as a graceful
    // 'ended' rather than surfacing "code 1000"/"code 1001" as a scary raw error is what makes
    // that race harmless instead of leaving the UI stuck showing a confusing error for what's
    // actually just the host ending the session normally.
    if (code === 1000 || code === 1001) {
      // Passing the reason through lets callers tell a graceful whole-session end (server sends
      // 'session ended', or no reason at all if the {type:'ended'} message already handled it)
      // apart from the host kicking just this one listener (server sends 'removed by host' with
      // no prior {type:'ended'} message) — both close with the same normal-closure code, so the
      // reason string is the only signal that distinguishes them.
      this.emit('ended', reason?.toString());
    } else {
      this.emit('closed', reason?.toString() || `code ${code}`);
    }
  }

  private onWsError(err: Error): void {
    this.emit('error', err);
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
   *  learn our (address, port) — see audio-sink-server.ts's header comment for the full protocol. */
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
      // Derived from the WS control port, not the hardcoded AUDIO_SINK_UDP_PORT constant — this
      // client class is shared between Audio Sink and Remote Mic (see main.ts's
      // join-remote-mic-paired, which constructs this same class against a different WS port).
      // Remote Mic's host listens for UDP audio on AUDIO_SINK_UDP_PORT + 2 while its WS control
      // port is AUDIO_SINK_PORT + 2 — the same "+1 from the WS port" relationship Audio Sink
      // itself uses (AUDIO_SINK_PORT -> AUDIO_SINK_UDP_PORT). Hardcoding the Audio-Sink-specific
      // constant here meant Remote Mic's hello went to the wrong port entirely — the host's
      // sendFrame() never learns this listener's address, so it never sends a single audio packet,
      // regardless of anything else being correct. Confirmed via reading both servers' actual
      // listening ports, not assumed.
      const udpPort = this.port + 1;
      this.udpSocket!.send(Buffer.from(connId, 'utf8'), udpPort, this.host);
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
