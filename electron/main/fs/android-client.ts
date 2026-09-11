import WebSocket from 'ws';
import { FS_PORT } from '../../core/transport';

export interface FsEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

export interface FsRoot {
  name: string;
  path: string;
  totalSpace?: number;
  freeSpace?: number;
}

// Any single request that gets no response within this window is force-rejected. Without this,
// a dropped packet, a doze-throttled radio, or a hotspot NAT silently dropping the connection
// left the underlying Promise pending FOREVER — Explorer/rclone then block their own I/O thread
// waiting on the mounted drive, which is what made the whole app appear frozen (and get
// force-closed) on weak Wi-Fi/hotspot links. 10s: long enough for a legitimately slow read on a
// congested link, short enough that a legitimately dead request recovers before it feels stuck.
const REQUEST_TIMEOUT_MS = 30000;
// Ping/pong cadence — the Android-facing WSS socket previously had NO liveness detection at all
// (unlike the main device connection's heartbeats), so a silently-dead connection just sat there
// looking "connected" indefinitely. We ping every PING_INTERVAL_MS and terminate if the previous
// ping went unanswered, so a dead link fails fast (rejecting all in-flight requests via 'close').
// 30s: large-file transfers (a 2GB copy at 5MB/s takes ~400s) can saturate the socket with
// write-ack frames for a long time — a 10s cadence killed live connections during heavy I/O.
const PING_INTERVAL_MS = 30000;

// Number of parallel TLS/WebSocket connections in the pool. A single TCP stream on a high-latency
// link is capped by its bandwidth-delay product no matter how much we pipeline requests inside it;
// spreading concurrent chunk reads across several independent sockets (the classic download-manager
// trick) multiplies effective throughput on exactly the weak Wi-Fi/hotspot links that felt slow.
const POOL_SIZE = 4;

/**
 * One TLS WebSocket connection to the peer's FS server, with its own request/response
 * demultiplexing (by id), per-request timeout, and ping/pong liveness. LinkAndroidFsClient owns a pool
 * of these and load-balances requests across them.
 */
class PooledSocket {
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isAlive = true;

  constructor(private url: string, private opts: WebSocket.ClientOptions, private label: string) {}

  get isLive(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Requests currently awaiting a response on this socket — used for least-loaded balancing. */
  get inFlight(): number {
    return this.pending.size;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url, this.opts);
      this.ws = ws;

      ws.on('open', () => {
        settled = true;
        this.isAlive = true;
        this.startHeartbeat();
        resolve();
      });

      ws.on('pong', () => {
        this.isAlive = true;
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('close', () => {
        this.stopHeartbeat();
        this.ws = null;
        for (const [id, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error(`FS connection ${this.label} closed while request ${id} in-flight`));
        }
        this.pending.clear();
      });

      ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
        if (!isBinary || typeof data === 'string') {
          const str = typeof data === 'string' ? data : (data instanceof Buffer ? data.toString('utf8') : Buffer.from(data as any).toString('utf8'));
          console.log(`[LinkAndroidFsClient] Text message on ${this.label}:`, str.slice(0, 300));
          try {
            const msg = JSON.parse(str);
            const req = this.pending.get(msg.id);
            if (!req) {
              console.warn(`[LinkAndroidFsClient] No pending request for id ${msg.id} on ${this.label}`);
              return;
            }
            clearTimeout(req.timer);
            this.pending.delete(msg.id);
            if (msg.error || msg.success === false) {
              req.reject(new Error(msg.error || 'FS request failed'));
            } else {
              req.resolve(msg.result !== undefined ? msg.result : msg);
            }
          } catch (e: any) {
            console.error(`[LinkAndroidFsClient] Error parsing text message on ${this.label}:`, e);
          }
          return;
        }

        // Binary frame handling (isBinary is true)
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        if (buf.length >= 4) {
          const headerLen = buf.readUInt32BE(0);
          if (headerLen > 0 && buf.length >= 4 + headerLen) {
            try {
              const headerStr = buf.subarray(4, 4 + headerLen).toString('utf8');
              const header = JSON.parse(headerStr);
              const req = this.pending.get(header.id);
              if (req) {
                clearTimeout(req.timer);
                this.pending.delete(header.id);
                if (header.error || header.success === false) {
                  req.reject(new Error(header.error || 'FS binary request failed'));
                } else {
                  req.resolve(buf.subarray(4 + headerLen));
                }
                return;
              }
            } catch {}
          }
        }

        // Fallback if raw 36-byte id
        if (buf.length >= 36) {
          const id = buf.subarray(0, 36).toString('utf8');
          const payload = buf.subarray(36);
          const req = this.pending.get(id);
          if (req) {
            clearTimeout(req.timer);
            this.pending.delete(id);
            req.resolve(payload);
          }
        }
      });
    });
  }

  request(payload: Record<string, any>): Promise<any> {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`.padEnd(36, '0').substring(0, 36);
    payload.id = id;

    return new Promise((resolve, reject) => {
      if (!this.isLive) {
        reject(new Error(`FS connection ${this.label} is not open`));
        return;
      }

      console.log(`[LinkAndroidFsClient] Sending request on ${this.label} (id=${id}):`, JSON.stringify(payload));

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`FS request ${payload.action || payload.type || 'unknown'} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      this.ws!.send(JSON.stringify(payload), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  sendBinary(headerJson: Record<string, any>, binaryData: Buffer): Promise<any> {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`.padEnd(36, '0').substring(0, 36);
    headerJson.id = id;

    return new Promise((resolve, reject) => {
      if (!this.isLive) {
        reject(new Error(`FS connection ${this.label} is not open`));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`FS binary request ${headerJson.action || headerJson.type || 'unknown'} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const headerBuf = Buffer.from(JSON.stringify(headerJson), 'utf8');
      const headerLenBuf = Buffer.alloc(4);
      headerLenBuf.writeUInt32BE(headerBuf.length, 0);
      const combined = Buffer.concat([headerLenBuf, headerBuf, binaryData]);

      this.ws!.send(combined, { binary: true }, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close(): void {
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.isLive) return;
      if (!this.isAlive) {
        console.warn(`[LinkFsClient] ${this.label} ping timed out — terminating dead socket`);
        this.ws?.terminate();
        return;
      }
      this.isAlive = false;
      try {
        this.ws?.ping();
      } catch {
        this.ws?.terminate();
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}

/**
 * High-performance TLS WebSocket client for remote Android device (Phone / TV) filesystem access.
 * Maintains a pool of connections (POOL_SIZE) and load-balances chunk reads across them.
 */
export class LinkAndroidFsClient {
  private sockets: PooledSocket[] = [];
  private poolSize = POOL_SIZE;

  constructor(
    private host: string,
    private port = FS_PORT,
    private clientCert: string,
    private clientKey: string
  ) {}

  async connect(): Promise<void> {
    const url = `wss://${this.host}:${this.port}/fs`;
    const opts: WebSocket.ClientOptions = {
      cert: this.clientCert,
      key: this.clientKey,
      rejectUnauthorized: false,
    };

    const primary = new PooledSocket(url, opts, 'socket-0');
    await primary.connect();
    this.sockets.push(primary);

    for (let i = 1; i < this.poolSize; i++) {
      const s = new PooledSocket(url, opts, `socket-${i}`);
      s.connect().then(() => {
        this.sockets.push(s);
      }).catch((err) => {
        console.warn(`[LinkAndroidFsClient] Secondary pooled socket ${i} failed to connect:`, err.message);
      });
    }
  }

  get isConnected(): boolean {
    return this.sockets.some((s) => s.isLive);
  }

  private pickSocket(): PooledSocket {
    const live = this.sockets.filter((s) => s.isLive);
    if (live.length === 0) {
      throw new Error('LinkAndroidFsClient has no live connections');
    }
    let least = live[0];
    for (let i = 1; i < live.length; i++) {
      if (live[i].inFlight < least.inFlight) least = live[i];
    }
    return least;
  }

  async listRoots(): Promise<FsRoot[]> {
    console.log('[LinkAndroidFsClient] Calling listRoots...');
    const res = await this.pickSocket().request({ action: 'listRoots', type: 'listRoots' });
    console.log('[LinkAndroidFsClient] listRoots received raw res:', JSON.stringify(res));
    const result = res.roots || res.result || (Array.isArray(res) ? res : []);
    console.log('[LinkAndroidFsClient] listRoots returning:', JSON.stringify(result));
    return result;
  }

  async stat(path: string): Promise<FsEntry> {
    const res = await this.pickSocket().request({ action: 'stat', type: 'stat', path });
    if (res.result) return res.result;
    return {
      name: res.name,
      isDirectory: !!res.isDirectory,
      size: res.size ?? 0,
      mtime: res.mtime ?? 0,
    };
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const res = await this.pickSocket().request({ action: 'readdir', type: 'readdir', path });
    return res.files || res.entries || res.result || (Array.isArray(res) ? res : []);
  }

  async read(path: string, offset: number, length: number): Promise<Buffer> {
    const res = await this.pickSocket().request({ action: 'read', type: 'read', path, offset, length });
    if (Buffer.isBuffer(res)) return res;
    if (res && res.type === 'Buffer' && Array.isArray(res.data)) {
      return Buffer.from(res.data);
    }
    throw new Error('Expected binary buffer in read response');
  }

  async create(path: string, isDirectory: boolean): Promise<boolean> {
    const res = await this.pickSocket().request({ action: 'create', type: 'create', path, isDirectory });
    return res.success ?? (res.ok ?? true);
  }

  async delete(path: string): Promise<boolean> {
    const res = await this.pickSocket().request({ action: 'delete', type: 'delete', path });
    return res.success ?? (res.ok ?? true);
  }

  async rename(path: string, newPath: string): Promise<boolean> {
    const res = await this.pickSocket().request({ action: 'rename', type: 'rename', path, newPath });
    return res.success ?? (res.ok ?? true);
  }

  async write(path: string, offset: number, buffer: Buffer): Promise<boolean> {
    const res = await this.pickSocket().sendBinary({ action: 'write', type: 'write', path, offset }, buffer);
    return res.success ?? (res.ok ?? true);
  }

  close(): void {
    for (const s of this.sockets) s.close();
    this.sockets = [];
  }

  disconnect(): void {
    this.close();
  }
}

// Aliases
export class LinkFsClient extends LinkAndroidFsClient {}
