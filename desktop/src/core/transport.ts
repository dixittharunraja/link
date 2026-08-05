// TCP+TLS transport, adapted for Node's `tls` module. See docs/PROTOCOL.md §5.
//
// Implementation note: We start TLS immediately with `rejectUnauthorized: false` (accept any
// cert at the socket layer), then manually verify the peer's certificate fingerprint against our
// pinned store right after the handshake completes and we've learned their deviceId via the
// (now encrypted) identity packet. Unpaired connections proceed with an unverified cert, while
// paired connections are rejected outright on any certificate mismatch.


import * as net from 'net';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import { LinkPacket, PacketStreamReader, serializePacket, createPacket } from './packet';
import { DeviceIdentity } from './identity';
import { certFingerprint } from './tls';

export const LINK_PORT = 1739; // arbitrary, distinct from KDE Connect's 1716/1717
// File System's WebSocket server lives on LINK_PORT + 2 (see LinkFsServer.java/fs-client.ts).
// Audio Sink's dedicated relay server (see audio-sink-server.ts) uses LINK_PORT + 3 — entirely
// separate from this module's DeviceManager/TrustStore-backed connections by design: guest
// listeners are never paired and must never touch the trust store or peers map.
export const AUDIO_SINK_PORT = LINK_PORT + 3;
// Dedicated UDP channel for the actual PCM stream (see audio-sink-server.ts's header comment) —
// AUDIO_SINK_PORT above now carries only JSON control messages (join/admit/format/mute/end) over
// TLS/WebSocket; audio frames move over UDP here to avoid TCP head-of-line blocking stalling
// playback behind a single delayed/lost packet.
export const AUDIO_SINK_UDP_PORT = AUDIO_SINK_PORT + 1;
// Remote Mic reuses AUDIO_SINK_PORT + 2 / + 3 for its control/UDP pair (see main.ts) — next free
// offset for a new ephemeral feature is + 7. Portal Mode (one-time file transfer to an unpaired
// device) gets its own dedicated port for the same reason Audio Sink/Remote Mic do: guest
// connections here are NEVER paired and must never touch the trust store or peers map.
export const PORTAL_TRANSFER_PORT = LINK_PORT + 7;
// Walkie Talkie's actual audio is WebRTC (getUserMedia + RTCPeerConnection, already built into
// both Electron's renderer and Android's WebView) and never touches our own transport layer.
// Signaling (session membership + SDP/ICE) between already-paired devices rides over the existing
// trusted connection as plain link.walkietalkie.* packets — see main.ts. But an unpaired guest has
// no such connection to ride on, so this dedicated control-only port (no UDP pair needed, unlike
// Audio Sink/Remote Mic — there's no PCM stream of our own to carry) exists purely for guests to
// reach the same signaling protocol via manual IP + PIN, same guest-admission model as every other
// ephemeral Tools plugin. See walkie-talkie-signal-server.ts.
export const WALKIE_TALKIE_PORT = LINK_PORT + 8;
export const JOYSTICK_PORT = LINK_PORT + 9;
export const PACKET_TYPE_IDENTITY = 'link.identity';
// Silent, transport-level-only packet — never surfaced as a 'packet' event, purely to prove
// liveness and reset lastActivityAt. TCP keepalive alone was too slow/opaque to rely on for this:
// Node (and Java) only let you configure the initial idle delay, not the retry interval or count,
// so actual dead-peer detection could silently take 20-30+ seconds depending on OS defaults — far
// from "instant" reconnection. An app-level heartbeat with a known, short timeout gives full
// control over detection speed instead of depending on OS TCP stack quirks.
export const PACKET_TYPE_HEARTBEAT = 'link.heartbeat';

export interface PeerConnectionEvents {
  identity: (identity: DeviceIdentity, certPem: string) => void;
  packet: (packet: LinkPacket) => void;
  close: () => void;
  error: (err: Error) => void;
}

export declare interface PeerConnection {
  on<E extends keyof PeerConnectionEvents>(event: E, listener: PeerConnectionEvents[E]): this;
  emit<E extends keyof PeerConnectionEvents>(event: E, ...args: Parameters<PeerConnectionEvents[E]>): boolean;
}

/** Wraps one live TLS socket to a peer — either direction (we dialed out, or they dialed in). */
export class PeerConnection extends EventEmitter {
  private reader = new PacketStreamReader();
  private identitySent = false;
  public peerIdentity: DeviceIdentity | null = null;
  public peerCertPem: string | null = null;
  /** The peer's IP, regardless of which side dialed — needed for e.g. downloading a payload the peer announced. */
  public readonly remoteAddress: string | undefined;
  /** Timestamp of the last inbound byte, of any kind — used to detect a dead peer ourselves instead of waiting on TCP keepalive. */
  public lastActivityAt: number = Date.now();

  constructor(private socket: tls.TLSSocket, private myIdentity: DeviceIdentity, public readonly isOutgoing: boolean) {
    super();
    this.remoteAddress = socket.remoteAddress;

    socket.on('data', (chunk) => {
      this.lastActivityAt = Date.now();
      for (const packet of this.reader.push(chunk)) {
        if (packet.type === PACKET_TYPE_IDENTITY) {
          this.handleIdentityPacket(packet);
        } else if (packet.type === PACKET_TYPE_HEARTBEAT) {
          // lastActivityAt above already recorded it — nothing else to do.
        } else {
          this.emit('packet', packet);
        }
      }
    });
    socket.on('close', () => this.emit('close'));
    socket.on('error', (err) => this.emit('error', err));

    // Send our identity as the first packet, as soon as the encrypted socket is writable.
    this.sendIdentity();
  }

  private sendIdentity() {
    if (this.identitySent) return;
    this.identitySent = true;
    const packet = createPacket(PACKET_TYPE_IDENTITY, this.myIdentity as unknown as Record<string, unknown>);
    this.socket.write(serializePacket(packet));
  }

  private handleIdentityPacket(packet: LinkPacket) {
    this.peerIdentity = packet.body as unknown as DeviceIdentity;
    const cert = this.socket.getPeerCertificate();
    this.peerCertPem = cert && cert.raw ? derToPem(cert.raw) : null;
    if (this.peerCertPem) {
      this.emit('identity', this.peerIdentity, this.peerCertPem);
    }
  }

  send(packet: LinkPacket): void {
    this.socket.write(serializePacket(packet));
  }

  sendHeartbeat(): void {
    this.socket.write(serializePacket(createPacket(PACKET_TYPE_HEARTBEAT, {})));
  }

  /** True if nothing at all has arrived from the peer in longer than timeoutMs — treat as dead. */
  isStale(timeoutMs: number): boolean {
    return Date.now() - this.lastActivityAt > timeoutMs;
  }

  close(): void {
    this.socket.end();
    // Belt-and-suspenders: end() is a graceful FIN that can itself hang if the peer is truly gone
    // (no ACK ever arrives), leaving 'close' unfired. Force a hard destroy shortly after so a
    // stale connection we just detected ourselves is guaranteed to actually go away.
    setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy();
    }, 1000);
  }

  /** Fingerprint of the certificate actually presented on THIS connection — compare against the pinned one. */
  currentPeerFingerprint(): string | null {
    return this.peerCertPem ? certFingerprint(this.peerCertPem) : null;
  }
}

export interface TransportOptions {
  cert: string;
  key: string;
  myIdentity: DeviceIdentity;
}

/** Starts listening for incoming connections. Emits 'connection' for each new PeerConnection. */
export class LinkServer extends EventEmitter {
  private server: tls.Server;

  constructor(private opts: TransportOptions, port: number = LINK_PORT) {
    super();
    this.server = tls.createServer(
      {
        cert: opts.cert,
        key: opts.key,
        requestCert: true,
        rejectUnauthorized: false, // manual verification happens after identity exchange
      },
      (socket) => {
        // A connection can go half-open (one side thinks it's fine, the peer is actually gone)
        // without either end noticing for a long time — common after a phone's Wi-Fi radio
        // sleeps/wakes or the OS silently drops a NAT/AP session. Left undetected, the peer stays
        // listed as "connected" while anything sent to it (a pair request, a plugin action) just
        // vanishes with no error. TCP keepalive makes the OS notice and fire 'close' instead.
        socket.setKeepAlive(true, 10000);
        const conn = new PeerConnection(socket, opts.myIdentity, false);
        this.emit('connection', conn);
      }
    );
    // Without this, a server-level error (e.g. a bad client handshake bubbling up on some Node/TLS
    // versions) would throw as an unhandled 'error' event — main.ts's global uncaughtException
    // handler swallows it, but the listening socket's state afterward isn't guaranteed, which
    // could silently stop it from accepting new connections until the app is restarted.
    this.server.on('error', (err) => {
      console.error('[Link] LinkServer error:', err);
    });
    this.server.listen(port, '0.0.0.0');
  }

  close(): void {
    this.server.close();
  }
}

// Node's default TCP connect timeout can run into tens of seconds against an unreachable/
// firewalled peer (e.g. a stale discovery entry, or a peer that just dropped off Wi-Fi). Since
// discovery re-attempts a connection on every broadcast (~every 5s) while the peer is still
// unconnected, one hung attempt with no timeout meant nothing ever failed to let the next retry
// through — the likely cause of "device stays invisible until the app is restarted."
const CONNECT_TIMEOUT_MS = 4000;

/** Dials out to a peer at host:port. Resolves with a PeerConnection once the TLS handshake completes. */
export function connectToPeer(host: string, port: number, opts: TransportOptions): Promise<PeerConnection> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        cert: opts.cert,
        key: opts.key,
        rejectUnauthorized: false, // manual verification happens after identity exchange
        timeout: CONNECT_TIMEOUT_MS,
      },
      () => {
        socket.setTimeout(0); // handshake succeeded — stop timing out an otherwise-idle live connection
        socket.setKeepAlive(true, 10000); // detect a half-open connection instead of writing into the void
        const conn = new PeerConnection(socket, opts.myIdentity, true);
        resolve(conn);
      }
    );
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Connect to ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`));
    });
  });
}

function derToPem(der: Buffer): string {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}
