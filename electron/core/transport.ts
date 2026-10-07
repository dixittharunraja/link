// TCP+TLS transport. Manually verify cert fingerprint after handshake (deferred until we know deviceId).


import * as tls from 'tls';
import { EventEmitter } from 'events';
import { LinkPacket, PacketStreamReader, serializePacket, createPacket } from './packet';
import { DeviceIdentity } from './identity';
import { certFingerprint } from './tls';
import { MODERN_CIPHERS } from './connection/crypto-provider';

export const LINK_PORT = 1739;
export const FS_PORT = LINK_PORT + 2;
export const AUDIO_SINK_PORT = LINK_PORT + 3;
export const AUDIO_SINK_UDP_PORT = AUDIO_SINK_PORT + 1;
export const FILE_TRANSFER_PORT = LINK_PORT + 7;
export const WALKIE_TALKIE_PORT = LINK_PORT + 8;
export const JOYSTICK_PORT = LINK_PORT + 9;
export const REMOTE_INPUT_PORT = LINK_PORT + 10;
const PACKET_TYPE_IDENTITY = 'link.identity';
// App-level heartbeat for faster dead-peer detection than TCP keepalive.
const PACKET_TYPE_HEARTBEAT = 'link.heartbeat';

/** Cleans IPv6 wrappers, URI schemes, and trailing ports to produce a clean hostname/IPv4 string */
export function normalizeHost(raw?: string | null): string {
  if (!raw) return '';
  let host = raw.trim().replace(/^::ffff:/, '');
  host = host.replace(/^(https?:\/\/|wss?:\/\/)/, '');
  if (host.includes(':')) {
    host = host.split(':')[0];
  }
  return host;
}

interface PeerConnectionEvents {
  identity: (identity: DeviceIdentity, certPem: string) => void;
  packet: (packet: LinkPacket) => void;
  heartbeat: (poolHash?: string) => void;
  close: () => void;
  error: (err: Error) => void;
}

export declare interface PeerConnection {
  on<E extends keyof PeerConnectionEvents>(event: E, listener: PeerConnectionEvents[E]): this;
  emit<E extends keyof PeerConnectionEvents>(event: E, ...args: Parameters<PeerConnectionEvents[E]>): boolean;
}

export class PeerConnection extends EventEmitter {
  private reader = new PacketStreamReader();
  private identitySent = false;
  public peerIdentity: DeviceIdentity | null = null;
  public peerCertPem: string | null = null;
  public readonly remoteAddress: string | undefined;
  public lastActivityAt: number = Date.now();
  public getPoolHash?: () => string;

  constructor(private socket: tls.TLSSocket, private myIdentity: DeviceIdentity, public readonly isOutgoing: boolean) {
    super();
    this.remoteAddress = socket.remoteAddress;

    socket.on('data', (chunk) => {
      this.lastActivityAt = Date.now();
      for (const packet of this.reader.push(chunk)) {
        if (packet.type === PACKET_TYPE_IDENTITY) {
          this.handleIdentityPacket(packet);
        } else if (packet.type === PACKET_TYPE_HEARTBEAT) {
          const body = packet.body as { reply?: boolean; poolHash?: string };
          this.emit('heartbeat', body?.poolHash);
          if (!body?.reply) {
            this.sendHeartbeat(true, this.getPoolHash ? this.getPoolHash() : undefined);
          }
        } else {
          this.emit('packet', packet);
        }
      }
    });
    socket.on('close', () => this.emit('close'));
    socket.on('error', (err) => this.emit('error', err));

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
    this.lastActivityAt = Date.now();
    this.socket.write(serializePacket(packet));
  }

  sendHeartbeat(isReply: boolean = false, poolHash?: string): void {
    try {
      this.socket.write(serializePacket(createPacket(PACKET_TYPE_HEARTBEAT, { reply: isReply, poolHash })));
    } catch {}
  }

  isStale(timeoutMs: number): boolean {
    return Date.now() - this.lastActivityAt > timeoutMs;
  }

  close(): void {
    this.socket.end();
    // Force hard destroy if graceful close hangs.
    setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy();
    }, 1000);
  }

  currentPeerFingerprint(): string | null {
    return this.peerCertPem ? certFingerprint(this.peerCertPem) : null;
  }
}

export interface TransportOptions {
  cert: string;
  key: string;
  myIdentity: DeviceIdentity;
}

export class LinkServer extends EventEmitter {
  private server: tls.Server;

  constructor(private opts: TransportOptions, port: number = LINK_PORT) {
    super();
    this.server = tls.createServer(
      {
        cert: opts.cert,
        key: opts.key,
        requestCert: true,
        rejectUnauthorized: false,
        ciphers: MODERN_CIPHERS,
        minVersion: 'TLSv1.2',
      },
      (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
        const conn = new PeerConnection(socket, opts.myIdentity, false);
        this.emit('connection', conn);
      }
    );
    this.server.on('error', (err) => {
      console.error('[Link] LinkServer error:', err);
    });
    this.server.listen(port, '0.0.0.0');
  }

  close(): void {
    this.server.close();
  }
}

// Timeout to avoid hanging on unreachable peers during discovery retries.
const CONNECT_TIMEOUT_MS = 4000;

export function connectToPeer(host: string, port: number, opts: TransportOptions): Promise<PeerConnection> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        cert: opts.cert,
        key: opts.key,
        rejectUnauthorized: false,
        timeout: CONNECT_TIMEOUT_MS,
        ciphers: MODERN_CIPHERS,
        minVersion: 'TLSv1.2',
      },
      () => {
        socket.setTimeout(0);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
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
