import * as http from 'http';
import * as crypto from 'crypto';
import { LinkAndroidFsClient, FsRoot } from './android-client';

/**
 * Thin JSON + binary HTTP server that wraps LinkAndroidFsClient so the C# WinFSP driver can reach
 * the Android device without speaking the binary WebSocket framing protocol directly.
 *
 * Binds exclusively to 127.0.0.1 on a random port. Every request must carry the shared token
 * in X-Link-Token — without it the server returns 403 immediately. The token is generated once
 * at startup and passed to the driver process via a CLI argument, so no other local process can
 * enumerate or guess it.
 */
export class FsApiServer {
  private server: http.Server | null = null;
  private _port = 0;
  readonly token: string;

  constructor(private readonly client: LinkAndroidFsClient, private readonly roots: FsRoot[]) {
    this.token = crypto.randomUUID();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => { this.handleRequest(req, res); });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this._port = (this.server!.address() as { port: number }).port;
        console.log(`[FsApiServer] Listening on http://127.0.0.1:${this._port}`);
        resolve();
      });
    });
  }

  get port(): number { return this._port; }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.headers['x-link-token'] !== this.token) {
      res.writeHead(403);
      res.end();
      return;
    }

    const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${this._port}`);
    const pathname = parsed.pathname;

    try {
      if (pathname === '/roots' && req.method === 'GET') {
        const payload = this.roots.map(r => ({
          name: r.name,
          path: r.path,
          totalSpace: r.totalSpace ?? 0,
          freeSpace: r.freeSpace ?? 0,
        }));
        this.sendJson(res, 200, payload);
        return;
      }

      if (pathname === '/stat' && req.method === 'GET') {
        const targetPath = parsed.searchParams.get('path') ?? '';
        try {
          const entry = await this.client.stat(targetPath);
          this.sendJson(res, 200, entry);
        } catch (err: any) {
          if (err.message?.includes('not found') || err.message?.includes('File not found') || err.message?.includes('Access Denied')) {
            this.sendJson(res, 404, { error: 'Not found' });
          } else {
            console.error(`[FsApiServer] Error handling GET /stat:`, err.message);
            this.sendJson(res, 500, { error: err.message });
          }
        }
        return;
      }

      if (pathname === '/readdir' && req.method === 'GET') {
        const targetPath = parsed.searchParams.get('path') ?? '';
        try {
          const entries = await this.client.readdir(targetPath);
          this.sendJson(res, 200, entries);
        } catch (err: any) {
          if (err.message?.includes('not found') || err.message?.includes('Directory not found') || err.message?.includes('Access Denied')) {
            this.sendJson(res, 404, { error: 'Not found' });
          } else {
            console.error(`[FsApiServer] Error handling GET /readdir:`, err.message);
            this.sendJson(res, 500, { error: err.message });
          }
        }
        return;
      }

      if (pathname === '/read' && req.method === 'GET') {
        const targetPath = parsed.searchParams.get('path') ?? '';
        const offset = parseInt(parsed.searchParams.get('offset') ?? '0', 10);
        const length = parseInt(parsed.searchParams.get('length') ?? '0', 10);
        try {
          const data = await this.client.read(targetPath, offset, length);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
          });
          res.end(data);
        } catch (err: any) {
          if (err.message?.includes('not found') || err.message?.includes('Access Denied')) {
            this.sendJson(res, 404, { error: 'Not found' });
          } else {
            console.error(`[FsApiServer] Error handling GET /read:`, err.message);
            this.sendJson(res, 500, { error: err.message });
          }
        }
        return;
      }

      if (pathname === '/write' && req.method === 'POST') {
        const targetPath = parsed.searchParams.get('path') ?? '';
        const offset = parseInt(parsed.searchParams.get('offset') ?? '0', 10);
        const body = await this.readBodyBuffer(req);
        const ok = await this.client.write(targetPath, offset, body);
        this.sendJson(res, 200, { ok });
        return;
      }

      if (pathname === '/create' && req.method === 'POST') {
        const json = await this.readBodyJson<{ path: string; isDirectory: boolean }>(req);
        const ok = await this.client.create(json.path, json.isDirectory);
        this.sendJson(res, 200, { ok });
        return;
      }

      if (pathname === '/delete' && req.method === 'POST') {
        const json = await this.readBodyJson<{ path: string }>(req);
        const ok = await this.client.delete(json.path);
        this.sendJson(res, 200, { ok });
        return;
      }

      if (pathname === '/rename' && req.method === 'POST') {
        const json = await this.readBodyJson<{ path: string; newPath: string }>(req);
        const ok = await this.client.rename(json.path, json.newPath);
        this.sendJson(res, 200, { ok });
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (err: any) {
      console.error(`[FsApiServer] Unexpected error handling ${req.method} ${pathname}:`, err.message);
      this.sendJson(res, 500, { error: err.message });
    }
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown) {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': raw.length,
    });
    res.end(raw);
  }

  private readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private async readBodyJson<T>(req: http.IncomingMessage): Promise<T> {
    const buf = await this.readBodyBuffer(req);
    return JSON.parse(buf.toString('utf8')) as T;
  }
}
