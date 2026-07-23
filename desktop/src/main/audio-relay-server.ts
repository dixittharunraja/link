// Audio Relay — host side. A dedicated WebSocket+TLS server on AUDIO_RELAY_PORT, completely
// separate from DeviceManager/TrustStore/the permission system (see docs/flow.txt and the plan
// this was built from) — an admitted listener here is NEVER added to the paired-device mesh.
//
// Two ways in, both ending at the same admit() path so there's exactly one relay/playback
// implementation regardless of how a listener got here:
//   - Guest (unpaired, manual IP): sends {"type":"join-guest"}. Server computes a PIN from both
//     sides' public keys (same hash PairingHandler.verificationKey() uses, via
//     computeVerificationCode() — reused, not reimplemented) and waits for the host to
//     accept/reject via acceptGuest()/rejectGuest(). Nothing is written to the trust store.
//   - Already-paired device: sends {"type":"join-token","token":"..."}. issueToken() was called
//     for that specific deviceId over the MAIN trusted connection when the session started —
//     matching token admits immediately, no human confirmation needed (trust already exists).
//
// Capture: spawns audio-capture.ps1, reads its one-line JSON format header, then relays every
// subsequent chunk of raw PCM to every admitted listener.
//
// PCM transport: UDP, not the WS/TCP control connection — TCP's head-of-line blocking means one
// delayed/lost packet stalls EVERY later packet behind it in the kernel buffer until it's
// retransmitted, which is exactly backwards for real-time audio (a stale-but-arrived frame is
// worse than a dropped one). AUDIO_RELAY_UDP_PORT carries only PCM; this WS connection keeps
// carrying every control message (join/admit/format/mute/end) exactly as before — none of that is
// latency-sensitive or continuous enough to benefit from UDP, and keeping it on TLS/WS means PIN
// verification, tokens, and admission all keep their existing guarantees unchanged.
//
// Each admitted listener gets its own random 32-byte AES-256-GCM session key, minted in admit()
// and handed over inside the (TLS-encrypted) "admitted" message — so the key exchange itself is
// fully protected even though the audio frames it protects travel unencrypted-transport UDP
// afterward. Every UDP audio packet is then individually encrypted+authenticated with that key:
// confidentiality (no LAN eavesdropper reads the audio) and integrity (a spoofed/injected UDP
// packet from  a mismatched key fails GCM tag verification and is dropped) at the packet level,
// same properties TLS was providing before, without paying TCP's ordering cost.
//
// Association: a listener doesn't have a fixed UDP-reachable address the host can just start
// sending to (NAT/firewall pinholes need the listener to speak first) — so right after receiving
// its session key over the control channel, the listener sends one UDP "hello" datagram (its own
// connId, in plaintext — an unguessable server-minted UUID, not a secret needing its own
// encryption) to the host. The host maps the hello's source (address, port) onto that listener's
// entry and only starts sending it audio once that's known — same pattern STUN/ICE use for NAT
// traversal, simplified because this never needs to cross a NAT in the first place (trusted LAN).

import * as https from 'https';
import * as tls from 'tls';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import * as path from 'path';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { Encoder as OpusEncoderClass } from '@evan/opus';
import { computeVerificationCode } from '../core/pairing';
import { AUDIO_RELAY_UDP_PORT } from '../core/transport';

// Type-only import above emits no runtime code — the actual load is this guarded require(), so a
// missing/broken native binary on some machine falls back to raw PCM transparently instead of
// crashing Audio Relay entirely. In practice @evan/opus ships prebuilt native binaries for the
// common desktop platforms plus a WASM fallback and uses true N-API bindings (ABI-stable across
// Node/Electron versions, confirmed during development — no rebuild step needed even though
// Electron's own Node ABI differs from plain Node's), so this catch is a defensive safety net, not
// an expected common case.
let OpusEncoderCtor: typeof OpusEncoderClass | null = null;
try {
  OpusEncoderCtor = require('@evan/opus').Encoder;
} catch {
  OpusEncoderCtor = null;
}

const CODEC_TAG_PCM = 0x00;
const CODEC_TAG_OPUS = 0x01;
// Opus mandates one of these fixed sample rates — WASAPI's actual shared-mode mix rate (whatever
// the audio engine happens to be configured for, commonly but not always 48000Hz) might not be
// one of them, in which case Audio Relay falls back to raw PCM for this session rather than
// resampling (out of scope for now — a real resampler is a separate, bigger piece of work).
const OPUS_SUPPORTED_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 48000]);
// Opus also mandates fixed frame durations (2.5/5/10/20/40/60ms). History: 20ms -> 10ms (confirmed
// clean, real hardware) -> 5ms (reverted). At 5ms the packet rate hit ~200/sec — encode/decode +
// AES-GCM + UDP send/receive + pacing overhead, 4 JNI-crossing MediaCodec calls per frame on the
// Android side, ~200 times a second — and produced pops PLUS rising latency together, not a
// single stall (already fixed via the dequeue-timeout scaling in LinkOpusEncoder/LinkOpusDecoder).
// That combination is the same signature as hitting the real AudioTrack buffer floor earlier this
// session: a genuine cumulative-throughput ceiling on the phone's more CPU-constrained hardware,
// not a discrete bug to chase further. 10ms is the confirmed-good floor for this pipeline.
const OPUS_FRAME_MS = 10;
const GUEST_CONFIRM_TIMEOUT_MS = 30000;
const UDP_NONCE_BYTES = 12;
const UDP_SEQ_BYTES = 4;
// A single WASAPI capture read is ~20-40ms of audio — 3-4KB+ at 48kHz/stereo — which is well over
// the ~1472-byte Ethernet/Wi-Fi MTU payload budget. Sending that as one UDP datagram means the OS
// silently IP-fragments it into several packets; if even ONE fragment is lost, the kernel discards
// the ENTIRE reassembled datagram, not just the missing piece — losing a whole ~20-40ms chunk at
// once instead of a few milliseconds, which is exactly what produces an audible pop/click at the
// resulting waveform discontinuity. Slicing into pieces this small before ever attaching a codec
// tag or encrypting keeps every actual wire datagram safely under the MTU regardless of capture
// chunk size, so a real packet loss costs a few ms of audio, not tens. 1280 divides evenly by
// every bytes-per-frame value this protocol ever produces (1/2/4/8), so slicing never lands
// mid-sample.
const MAX_UDP_PCM_BYTES = 1280;
// A connection can go dead without ever sending a clean close frame — confirmed in practice: a
// listener's app process getting reloaded (its WebView renderer killed/reclaimed by the OS mid-
// session) can orphan the underlying socket with no reference left to close it from that side.
// Without this, that connection just sits in admittedListeners forever, showing as a phantom
// permanent entry in the "Listeners" list even though nothing is there anymore. Pinging and
// terminating anything that doesn't answer is the server-side safety net for that — independent
// of also fixing the actual orphaning bug at its source (see LinkPlugin.java's reattach cleanup).
const HEARTBEAT_INTERVAL_MS = 15000;

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
}

interface Listener {
  ws: WebSocket;
  deviceId?: string; // set for paired listeners, undefined for guests
  label: string;
  sessionKey: Buffer; // AES-256-GCM key for this listener's UDP audio frames, minted in admit()
  udpAddress?: string; // set once this listener's UDP "hello" arrives — see handleUdpMessage()
  udpPort?: number;
  seq: number; // per-listener outgoing sequence counter for UDP audio frames
}

interface PendingGuest {
  ws: WebSocket;
  pin: string;
  timeout: NodeJS.Timeout;
}

export interface AudioRelayServerEvents {
  guestPinPending: (connId: string, pin: string, remoteAddress: string) => void;
  listenerJoined: (connId: string, label: string) => void;
  listenerLeft: (connId: string) => void;
  error: (err: Error) => void;
  stopped: () => void;
}

export declare interface AudioRelayServer {
  on<E extends keyof AudioRelayServerEvents>(event: E, listener: AudioRelayServerEvents[E]): this;
  emit<E extends keyof AudioRelayServerEvents>(event: E, ...args: Parameters<AudioRelayServerEvents[E]>): boolean;
}

export class AudioRelayServer extends EventEmitter {
  private httpsServer: https.Server | null = null;
  private wss: WebSocket.Server | null = null;
  private udpSocket: dgram.Socket | null = null;
  private captureProcess: child_process.ChildProcess | null = null;
  private format: AudioFormat | null = null;
  private headerBuffer = Buffer.alloc(0);
  private admittedListeners = new Map<string, Listener>();
  private pendingGuests = new Map<string, PendingGuest>();
  private validTokens = new Map<string, string>(); // token -> deviceId
  // Shared send-pacing cursor for relayAudio() — see that method's comment for why this must be a
  // single cursor across all calls rather than a per-chunk countdown.
  private nextSendAtMs: number | null = null;
  // Opus encoding state — decided once per session, right after the capture format header is
  // parsed (see handleCaptureData). One shared encoder instance for every listener (Opus is a
  // stateful streaming codec; the encoded bytes going out are identical for all listeners, only
  // the AES-GCM encryption wrapping them differs per listener's session key) — see relayAudioOpus.
  private useOpus = false;
  private opusEncoder: InstanceType<typeof OpusEncoderClass> | null = null;
  private opusAccumulator = Buffer.alloc(0); // raw captured PCM bytes not yet forming a full 20ms frame
  private opusFrameBytes = 0; // byte size of exactly one 20ms frame, in the ORIGINAL captured PCM format
  private muted = false;
  private myPublicKeyDer: Buffer;
  // Every live socket regardless of state (pending-guest or admitted) — a single set so the
  // heartbeat sweep doesn't need to know which map a connection currently lives in.
  private allSockets = new Set<WebSocket>();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(private cert: string, private key: string, private port: number) {
    super();
    this.myPublicKeyDer = new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpsServer = https.createServer({
        cert: this.cert,
        key: this.key,
        // Same reasoning as the main device connection and LinkFsServer: accept any cert at the
        // raw TLS layer (self-signed, no CA), then verify identity ourselves at the application
        // layer (here: extracting the peer's public key to compute the PIN, or checking a token).
        requestCert: true,
        rejectUnauthorized: false,
      });

      this.wss = new WebSocket.Server({ server: this.httpsServer });
      this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

      this.httpsServer.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.httpsServer.listen(this.port, () => {
        this.startUdp();
        this.startCapture();
        this.startHeartbeat();
        resolve();
      });
    });
  }

  private startUdp() {
    this.udpSocket = dgram.createSocket('udp4');
    this.udpSocket.on('message', (msg, rinfo) => this.handleUdpHello(msg, rinfo));
    this.udpSocket.on('error', (err) => this.emit('error', err));
    this.udpSocket.on('listening', () => {
      // Every capture chunk fans out as several sub-packets fired back-to-back with zero delay
      // between them (see MAX_UDP_PCM_BYTES) — a real burst, not a steady trickle. The OS default
      // send buffer is sized for typical request/response traffic, not that; a brief scheduling
      // hiccup on this process (GC, another task on the event loop) while a burst is still
      // draining can silently drop the tail of it. 128KB is ~10x a single burst's worst-case size
      // — enough headroom to absorb that without inviting the bufferbloat-style latency growth a
      // much larger buffer (this was 1MB) causes once anything downstream runs even slightly
      // behind on average: a queue that can grow huge just delays the reckoning instead of
      // preventing it, at the cost of added end-to-end latency for every packet queued behind it.
      try { this.udpSocket!.setSendBufferSize(1 << 17); } catch {} // 128KB
    });
    this.udpSocket.bind(AUDIO_RELAY_UDP_PORT);
  }

  /** A listener's first UDP datagram is just its own connId, sent so we learn the (address, port)
   *  it's actually reachable on — see this file's header comment for why. Anything that doesn't
   *  match a currently-admitted connId is silently ignored (stale hello after disconnect, or
   *  noise from something else on the network). */
  private handleUdpHello(msg: Buffer, rinfo: dgram.RemoteInfo) {
    const connId = msg.toString('utf8');
    const listener = this.admittedListeners.get(connId);
    if (!listener) return;
    listener.udpAddress = rinfo.address;
    listener.udpPort = rinfo.port;
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      for (const ws of this.allSockets) {
        const anyWs = ws as any;
        if (anyWs._audioRelayAlive === false) {
          try { ws.terminate(); } catch {}
          continue; // terminate() fires 'close', which removes it from allSockets there
        }
        anyWs._audioRelayAlive = false;
        try { ws.ping(); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Mints a one-time token for a specific already-paired deviceId — call once per peer when the
   *  session starts (over the MAIN trusted connection), so each paired device gets its own token
   *  rather than a single shared secret. */
  issueToken(deviceId: string): string {
    const token = crypto.randomBytes(16).toString('hex');
    this.validTokens.set(token, deviceId);
    return token;
  }

  acceptGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    this.admit(connId, pending.ws, 'Guest');
  }

  rejectGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    try { pending.ws.close(4007, 'rejected by host'); } catch {}
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.broadcastJson({ type: 'hostMuted', muted });
  }

  listenersSnapshot(): { id: string; label: string }[] {
    return Array.from(this.admittedListeners.entries()).map(([id, l]) => ({ id, label: l.label }));
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.broadcastJson({ type: 'ended' });
    for (const listener of this.admittedListeners.values()) {
      try { listener.ws.close(1000, 'session ended'); } catch {}
    }
    this.admittedListeners.clear();
    for (const pending of this.pendingGuests.values()) {
      clearTimeout(pending.timeout);
      try { pending.ws.close(1000, 'session ended'); } catch {}
    }
    this.pendingGuests.clear();
    this.validTokens.clear();

    if (this.captureProcess) {
      try { this.captureProcess.kill(); } catch {}
      this.captureProcess = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.udpSocket) {
      try { this.udpSocket.close(); } catch {}
      this.udpSocket = null;
    }
    if (this.httpsServer) {
      const server = this.httpsServer;
      this.httpsServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.allSockets.clear();
    this.format = null;
    this.headerBuffer = Buffer.alloc(0);
    this.nextSendAtMs = null;
    this.useOpus = false;
    this.opusEncoder = null;
    this.opusAccumulator = Buffer.alloc(0);
    this.opusFrameBytes = 0;
    this.emit('stopped');
  }

  private handleConnection(ws: WebSocket, req: any) {
    const socket = req.socket as tls.TLSSocket;
    // Nagle's algorithm was still on here — for a stream of frequent small audio chunks (the
    // exact pathological case it punishes), this could add up to ~40ms of avoidable delay PER
    // CHUNK on the host->listener direction, which is the one that actually matters for audio.
    // The listener side already disabled it (audio-relay-client.ts); the server accepting the
    // connection needed the same call on ITS end of the same socket.
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

    this.allSockets.add(ws);
    (ws as any)._audioRelayAlive = true;
    ws.on('pong', () => { (ws as any)._audioRelayAlive = true; });

    const peerCert = socket.getPeerCertificate();
    if (!peerCert || !peerCert.raw) {
      ws.close(4001, 'no client certificate presented');
      return;
    }

    let peerPublicKeyDer: Buffer;
    try {
      peerPublicKeyDer = new crypto.X509Certificate(peerCert.raw).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    } catch {
      ws.close(4002, 'invalid certificate');
      return;
    }

    const remoteAddress = (req.socket.remoteAddress as string) || 'unknown';
    const connId = crypto.randomUUID();

    // The client always announces its intent as the first message — avoids any race/timeout
    // guessing between "is this a paired device with a token" vs "is this a guest needing a PIN".
    const onFirstMessage = (data: WebSocket.RawData) => {
      ws.off('message', onFirstMessage);
      let msg: any;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        ws.close(4003, 'malformed join message');
        return;
      }

      if (msg.type === 'join-token' && typeof msg.token === 'string') {
        const deviceId = this.validTokens.get(msg.token);
        if (!deviceId) {
          ws.close(4005, 'invalid or expired token');
          return;
        }
        this.validTokens.delete(msg.token); // one-time use
        this.admit(connId, ws, `Paired device (${deviceId.slice(0, 8)})`, deviceId);
      } else if (msg.type === 'join-guest') {
        const pin = computeVerificationCode(this.myPublicKeyDer, peerPublicKeyDer);
        const timeout = setTimeout(() => {
          this.pendingGuests.delete(connId);
          try { ws.close(4006, 'confirmation timed out'); } catch {}
        }, GUEST_CONFIRM_TIMEOUT_MS);
        this.pendingGuests.set(connId, { ws, pin, timeout });
        // Also send the PIN we computed to the guest as a fallback for clients that can't pull
        // their own TLS peer certificate to independently compute it (a real constraint on
        // Android's WebSocket client library — see LinkAudioRelayClient.java). A client capable
        // of independent computation should prefer its own value and treat this only as a
        // convenience/fallback, not the primary source of truth.
        try { ws.send(JSON.stringify({ type: 'pin', code: pin })); } catch {}
        this.emit('guestPinPending', connId, pin, remoteAddress);
      } else {
        ws.close(4004, 'unknown join type');
      }
    };
    ws.on('message', onFirstMessage);

    ws.on('close', () => {
      this.allSockets.delete(ws);
      const pending = this.pendingGuests.get(connId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingGuests.delete(connId);
      }
      if (this.admittedListeners.has(connId)) {
        this.admittedListeners.delete(connId);
        this.emit('listenerLeft', connId);
      }
    });
  }

  private admit(connId: string, ws: WebSocket, label: string, deviceId?: string) {
    const sessionKey = crypto.randomBytes(32);
    this.admittedListeners.set(connId, { ws, deviceId, label, sessionKey, seq: 0 });
    // connId + udpKey ride this already-TLS-encrypted message, so the key exchange itself stays
    // fully protected even though the UDP audio frames it protects don't have their own transport
    // encryption — see this file's header comment.
    ws.send(JSON.stringify({ type: 'admitted', connId, udpKey: sessionKey.toString('base64') }));
    if (this.format) {
      ws.send(JSON.stringify({ type: 'format', ...this.formatMessage() }));
    }
    this.emit('listenerJoined', connId, label);
  }

  private startCapture() {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'audio-capture.ps1');
    this.captureProcess = child_process.spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, 'capture'],
      { windowsHide: true }
    );

    this.captureProcess.stderr?.on('data', (d: Buffer) => {
      console.error('[AudioRelayServer:capture stderr]', d.toString().trim());
    });

    this.captureProcess.on('error', (err) => {
      this.emit('error', err);
    });

    this.captureProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        this.emit('error', new Error(`Capture process exited unexpectedly (code ${code})`));
      }
    });

    this.captureProcess.stdout?.on('data', (chunk: Buffer) => this.handleCaptureData(chunk));
  }

  private handleCaptureData(chunk: Buffer) {
    if (!this.format) {
      this.headerBuffer = Buffer.concat([this.headerBuffer, chunk]);
      const newlineIdx = this.headerBuffer.indexOf(0x0a);
      if (newlineIdx === -1) return; // still waiting for the full header line

      const headerLine = this.headerBuffer.subarray(0, newlineIdx).toString('utf8');
      const rest = this.headerBuffer.subarray(newlineIdx + 1);
      try {
        this.format = JSON.parse(headerLine);
      } catch {
        this.emit('error', new Error('Failed to parse capture format header: ' + headerLine));
        return;
      }
      this.setupOpusIfPossible();
      // Listeners admitted before capture finished starting up get the format now; anyone
      // admitted after this point gets it immediately in admit() instead.
      this.broadcastJson({ type: 'format', ...this.formatMessage() });
      if (rest.length > 0) this.relayAudio(rest);
      return;
    }

    this.relayAudio(chunk);
  }

  /** Decides once per session whether this capture format is Opus-eligible (supported sample
   *  rate/channel count, and a PCM sample format toInt16() knows how to convert) and, if so,
   *  constructs the shared encoder. Any failure here — including OpusEncoderCtor being null
   *  because the native/WASM binary never loaded — just leaves useOpus false, and every other
   *  method in this class already treats that as "use the raw PCM path", so no separate fallback
   *  logic is needed elsewhere. */
  private setupOpusIfPossible() {
    if (!this.format || !OpusEncoderCtor) return;
    const rateOk = OPUS_SUPPORTED_SAMPLE_RATES.has(this.format.sampleRate);
    const channelsOk = this.format.channels === 1 || this.format.channels === 2;
    const sampleFormatOk =
      (!this.format.isFloat && this.format.bitsPerSample === 16) ||
      (this.format.isFloat && this.format.bitsPerSample === 32);
    if (!rateOk || !channelsOk || !sampleFormatOk) return;

    try {
      this.opusEncoder = new OpusEncoderCtor({
        channels: this.format.channels as 1 | 2,
        sample_rate: this.format.sampleRate as 8000 | 12000 | 16000 | 24000 | 48000,
        application: 'audio', // optimized for music/movie content, not voice
      });
      this.opusEncoder.bitrate = 128000; // near-transparent for stereo music at this frame size
      const bytesPerFrame = this.format.channels * (this.format.bitsPerSample / 8);
      this.opusFrameBytes = bytesPerFrame * Math.round((this.format.sampleRate * OPUS_FRAME_MS) / 1000);
      this.useOpus = true;
    } catch (e: any) {
      console.error('[AudioRelayServer] Opus encoder init failed, falling back to raw PCM:', e?.message || e);
      this.opusEncoder = null;
      this.useOpus = false;
    }
  }

  /** What to actually tell listeners in the "format" message — Opus always decodes to 16-bit int
   *  PCM regardless of what it was encoded from, so that's what's declared here whenever useOpus
   *  is true, not this.format's own (possibly 32-bit float) bitsPerSample/isFloat. */
  private formatMessage(): (AudioFormat & { codec: 'pcm' | 'opus' }) | null {
    if (!this.format) return null;
    if (this.useOpus) {
      return { sampleRate: this.format.sampleRate, channels: this.format.channels, bitsPerSample: 16, isFloat: false, codec: 'opus' };
    }
    return { ...this.format, codec: 'pcm' };
  }

  private relayAudio(pcm: Buffer) {
    if (this.muted || this.admittedListeners.size === 0 || !this.udpSocket) return;
    if (this.useOpus && this.opusEncoder) {
      this.relayAudioOpus(pcm);
    } else {
      this.relayAudioPcm(pcm);
    }
  }

  private relayAudioPcm(pcm: Buffer) {
    const slices: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += MAX_UDP_PCM_BYTES) {
      slices.push(pcm.subarray(offset, Math.min(offset + MAX_UDP_PCM_BYTES, pcm.length)));
    }

    const bytesPerFrame = this.format ? this.format.channels * (this.format.bitsPerSample / 8) : 0;
    const sampleRate = this.format?.sampleRate ?? 0;
    const canPace = bytesPerFrame > 0 && sampleRate > 0;

    const now = Date.now();
    this.advancePacingCursor(now);

    for (const slice of slices) {
      this.scheduleSend(now, CODEC_TAG_PCM, slice);
      if (canPace) {
        this.nextSendAtMs! += (slice.length / bytesPerFrame / sampleRate) * 1000;
      }
    }
  }

  /** Accumulates raw captured PCM until there's a full OPUS_FRAME_MS worth, encodes exactly that
   *  much (Opus requires fixed frame sizes), and sends. Unlike the PCM path, this doesn't need to
   *  slice a variable-size chunk into MTU-safe pieces (an encoded frame is already far under the
   *  MTU) — but it still shares the same pacing cursor, because WASAPI can occasionally hand over
   *  more than one frame's worth of audio in a single callback, and firing all of those back-to-
   *  back would reintroduce the exact burst pattern pacing was built to avoid. */
  private relayAudioOpus(pcm: Buffer) {
    this.opusAccumulator = Buffer.concat([this.opusAccumulator, pcm]);
    if (this.opusAccumulator.length < this.opusFrameBytes) return;

    const now = Date.now();
    this.advancePacingCursor(now);

    while (this.opusAccumulator.length >= this.opusFrameBytes) {
      const rawFrame = this.opusAccumulator.subarray(0, this.opusFrameBytes);
      this.opusAccumulator = this.opusAccumulator.subarray(this.opusFrameBytes);

      let encoded: Buffer;
      try {
        encoded = Buffer.from(this.opusEncoder!.encode(this.toInt16(rawFrame)));
      } catch (e: any) {
        console.error('[AudioRelayServer] Opus encode failed for a frame, dropping it:', e?.message || e);
        continue;
      }
      this.scheduleSend(now, CODEC_TAG_OPUS, encoded);
      this.nextSendAtMs! += OPUS_FRAME_MS;
    }
  }

  /** Converts a raw captured PCM frame to 16-bit int if it isn't already — the only two formats
   *  setupOpusIfPossible() ever allows useOpus to be true for. WASAPI's shared-mode mix is 32-bit
   *  float in practice (see audio-capture.ps1), which Opus's encode() was NOT confirmed to accept
   *  correctly during development (it silently accepted a float32 buffer without throwing, which
   *  is not proof it interpreted the samples correctly — libopus has separate int16 and float
   *  entry points, and there's no way to tell from the outside which one this binding calls).
   *  Converting explicitly here is correct either way and costs nothing. */
  private toInt16(raw: Buffer): Buffer {
    if (!this.format) return raw;
    if (!this.format.isFloat && this.format.bitsPerSample === 16) return raw;
    const sampleCount = raw.length / 4;
    const out = Buffer.alloc(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
      let sample = raw.readFloatLE(i * 4);
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      out.writeInt16LE(Math.round(sample * 32767), i * 2);
    }
    return out;
  }

  // nextSendAtMs is a SINGLE cursor shared across every relayAudio call, not a fresh per-chunk
  // countdown — capture chunks don't arrive perfectly metronomically, so a per-chunk countdown
  // starting at 0 each time let a new chunk's immediate first unit fire before an earlier chunk's
  // still-pending delayed units, sending audio out of its true chronological order (not just out
  // of network order) — that's what produced "completely distorted" audio, not a tuning problem.
  // A shared, monotonically-advancing cursor (same pattern the listener's own jitter buffer
  // already uses for nextStartTime) guarantees every unit is scheduled strictly after the one
  // before it, in true source order, regardless of how bursty capture's own delivery timing is.
  //
  // MAX_AHEAD_MS is the other half of that same pattern — nextStartTime's own jitter buffer
  // resyncs both when it's fallen BEHIND real time and when it's drifted too far AHEAD (a burst
  // inflated the schedule). This cursor originally only handled the "behind" case: small,
  // persistent overestimates of audio-duration-per-wall-clock-time (WASAPI catching up after a
  // brief hiccup delivers slightly more audio-time than real time actually elapsed) had nothing
  // capping how far ahead nextSendAtMs could drift, so over a real session it grew unbounded —
  // exactly what "latency keeps climbing" looks like. Confirmed via real testing.
  private static readonly MAX_AHEAD_MS = 100;

  private advancePacingCursor(now: number) {
    if (this.nextSendAtMs === null || this.nextSendAtMs < now || this.nextSendAtMs - now > AudioRelayServer.MAX_AHEAD_MS) {
      this.nextSendAtMs = now;
    }
  }

  private scheduleSend(now: number, codecTag: number, payload: Buffer) {
    const delay = this.nextSendAtMs! - now;
    if (delay <= 0) {
      this.sendFrame(codecTag, payload);
    } else {
      setTimeout(() => this.sendFrame(codecTag, payload), delay);
    }
  }

  private sendFrame(codecTag: number, payload: Buffer) {
    if (!this.udpSocket) return;
    const framedPayload = Buffer.concat([Buffer.from([codecTag]), payload]);
    for (const listener of this.admittedListeners.values()) {
      // Nothing to send to until this listener's UDP hello arrives (see handleUdpHello) — a
      // brief startup gap of a few chunks at most, same order of magnitude as the old admission
      // round-trip, not an ongoing issue.
      if (!listener.udpAddress || listener.udpPort === undefined) continue;

      const seq = listener.seq++;
      const seqBuf = Buffer.alloc(UDP_SEQ_BYTES);
      seqBuf.writeUInt32BE(seq >>> 0, 0);
      const nonce = crypto.randomBytes(UDP_NONCE_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', listener.sessionKey, nonce);
      const encrypted = Buffer.concat([cipher.update(framedPayload), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const frame = Buffer.concat([seqBuf, nonce, encrypted, authTag]);
      this.udpSocket.send(frame, listener.udpPort, listener.udpAddress);
    }
  }

  private broadcastJson(obj: any) {
    const msg = JSON.stringify(obj);
    for (const listener of this.admittedListeners.values()) {
      if (listener.ws.readyState === WebSocket.OPEN) listener.ws.send(msg);
    }
  }
}
