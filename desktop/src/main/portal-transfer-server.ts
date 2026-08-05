// Portal Mode — receiver side. A dedicated WebSocket+TLS server on PORTAL_TRANSFER_PORT for
// one-time file transfer, completely separate from DeviceManager/TrustStore/the permission system
// — same isolation model as audio-relay-server.ts (see that file's header comment for the full
// reasoning), reused here rather than reinvented: an admitted sender is NEVER added to the
// paired-device mesh.
//
// Two ways in, both ending at the same admit() path:
//   - Guest (unpaired, manual IP): sends {"type":"join-guest"}. Server computes a PIN from both
//     sides' public keys (computeVerificationCode() — same as pairing/Audio Relay) and waits for
//     the receiving human to accept/reject via acceptGuest()/rejectGuest(). Nothing is written to
//     the trust store.
//   - Already-paired device: sends {"type":"join-token","token":"..."}. issueToken() was called
//     for that specific deviceId over the MAIN trusted connection when "Receive Files" started —
//     matching token admits immediately, no human confirmation needed (trust already exists).
//
// Wire protocol after admission (over the same TLS/WS connection — no separate payload-transfer
// sub-connection needed, unlike the existing trusted-peer payload-transfer.ts, which requires an
// ALREADY-PINNED fingerprint that an unpaired guest doesn't have; the PIN confirmation above IS
// this session's trust establishment):
//   sender -> {"type":"batch-info","count":N}   (once, before any file)
//   for each of the N files, in order:
//     sender -> {"type":"file-info","name":...,"size":...}
//     sender -> binary WS frames, in order, totaling exactly `size` bytes
//   server -> {"type":"received"} once ALL N files are fully in, THEN closes the connection
// batch-info is optional for backward compatibility with an older client that only ever sent one
// file with no preceding batch-info — treated as an implicit count of 1. One batch per admitted
// connection, then the connection closes itself — "one-time transfer" is enforced per-connection,
// not per-server, so the server can keep listening for a next sender without the user having to
// restart "Receive Files" each time.

import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { computeVerificationCode } from '../core/pairing';

const GUEST_CONFIRM_TIMEOUT_MS = 30000;
// A file this large arriving as one message would need to be fully buffered before we could even
// start writing it — instead every incoming binary frame is appended to the destination file as
// it arrives (see handleBinaryChunk), so memory use stays flat regardless of file size.
const MAX_FILE_BYTES = 100 * 1024 * 1024 * 1024 * 1024; // 100TB (effectively no limit)

interface PendingGuest {
  ws: WebSocket;
  pin: string;
  timeout: NodeJS.Timeout | null;
  remoteAddress: string;
  deviceName?: string;
}

interface BatchState {
  expected: number;
  received: number;
}

interface ActiveTransfer {
  name: string;
  size: number;
  received: number;
  fd: number;
  destPath: string;
}

export interface PortalTransferServerEvents {
  guestPinPending: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void;
  connectionAdmitted: (connId: string, deviceName: string) => void;
  connectionClosed: (connId: string) => void;
  transferStarted: (connId: string, name: string, size: number) => void;
  transferProgress: (connId: string, received: number, size: number) => void;
  transferComplete: (connId: string, destPath: string) => void;
  error: (err: Error) => void;
}

export declare interface PortalTransferServer {
  on<E extends keyof PortalTransferServerEvents>(event: E, listener: PortalTransferServerEvents[E]): this;
  emit<E extends keyof PortalTransferServerEvents>(event: E, ...args: Parameters<PortalTransferServerEvents[E]>): boolean;
}

export class PortalTransferServer extends EventEmitter {
  private httpsServer: https.Server | null = null;
  private httpServer: http.Server | null = null;
  private wss: WebSocket.Server | null = null;
  private myPublicKeyDer: Buffer;
  private pendingGuests = new Map<string, PendingGuest>();
  private validTokens = new Map<string, { deviceId: string; deviceName: string }>();
  private admittedConnections = new Map<string, WebSocket>();
  private activeTransfers = new Map<string, ActiveTransfer>();
  private batchState = new Map<string, BatchState>();
  private isWebMode = false;
  // Per-connection override of this.saveDir — set at accept time so each incoming batch can be
  // saved wherever the user picked via the native folder dialog, not a fixed directory.
  private connSaveDirs = new Map<string, string>();
  private availableDownloads: { id: string; name: string; size: number; localPath: string }[] = [];

  constructor(
    private cert: string,
    private key: string,
    private port: number,
    private saveDir: string,
    // Sent back to the sender in the 'admitted' message so it can show "Connected with <name>"
    // instead of a generic placeholder — see admit() below.
    private deviceName: string,
    // Same mechanism as AudioRelayServer's — see that class's constructor comment.
    private isBlocked: (idOrIp: string) => boolean = () => false
  ) {
    super();
    this.myPublicKeyDer = new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  }

  setAvailableDownloads(files: { name: string; localPath: string }[]) {
    this.availableDownloads = [];
    for (const f of files) {
      if (fs.existsSync(f.localPath)) {
        try {
          const stat = fs.statSync(f.localPath);
          if (stat.isFile()) {
            this.availableDownloads.push({
              id: `file-${crypto.randomBytes(4).toString('hex')}`,
              name: f.name,
              size: stat.size,
              localPath: f.localPath
            });
          }
        } catch (e) {
          console.error('[Link] Failed to stat file for download:', e);
        }
      }
    }
    const packet = JSON.stringify({
      type: 'downloads-available',
      files: this.availableDownloads.map(d => ({ id: d.id, name: d.name, size: d.size }))
    });
    for (const ws of this.admittedConnections.values()) {
      try { ws.send(packet); } catch {}
    }
  }

  start(webMode: boolean = false): Promise<void> {
    this.isWebMode = webMode;
    return new Promise((resolve, reject) => {
      // Don't create this.saveDir (the Downloads/Link default) here — the user picks the real
      // destination via the native folder dialog per transfer. The dir actually used is created
      // lazily where the batch is saved (see handleConnection's mkdirSync on saveDir/connSaveDirs).
      if (webMode) {
        this.httpServer = http.createServer((req: any, res: any) => {
          const urlPath = req.url || '';
          if (urlPath === '/' || urlPath === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getWebClientHtml());
          } else if (urlPath.startsWith('/download/')) {
            const fileId = urlPath.substring('/download/'.length).split('?')[0];
            const file = this.availableDownloads.find(d => d.id === fileId);
            if (!file) {
              res.writeHead(404);
              res.end('File Not Found');
              return;
            }
            if (!fs.existsSync(file.localPath)) {
              res.writeHead(410);
              res.end('File no longer exists on host');
              return;
            }
            const stat = fs.statSync(file.localPath);
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': stat.size,
              'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`
            });
            const readStream = fs.createReadStream(file.localPath);
            readStream.pipe(res);
          } else {
            res.writeHead(404);
            res.end('Not Found');
          }
        });

        this.wss = new WebSocket.Server({ server: this.httpServer });
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

        this.httpServer.on('error', (err) => {
          this.emit('error', err);
          reject(err);
        });

        this.httpServer.listen(this.port, () => resolve());
      } else {
        this.httpsServer = https.createServer({
          cert: this.cert,
          key: this.key,
          requestCert: true,
          rejectUnauthorized: false,
        });

        this.wss = new WebSocket.Server({ server: this.httpsServer });
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

        this.httpsServer.on('error', (err) => {
          this.emit('error', err);
          reject(err);
        });

        this.httpsServer.listen(this.port, () => resolve());
      }
    });
  }

  issueToken(deviceId: string, deviceName: string): string {
    const token = crypto.randomBytes(16).toString('hex');
    this.validTokens.set(token, { deviceId, deviceName });
    return token;
  }

  /** Clears the pending guest's confirm-timeout WITHOUT admitting them yet — lets the caller show
   *  a native "choose destination folder" dialog after the human clicks Accept without racing the
   *  30s PIN-confirm timeout while that dialog is still open. Call acceptGuest() (or rejectGuest())
   *  once the dialog resolves; this alone does not let the sender start transferring anything. */
  holdGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending || !pending.timeout) return;
    clearTimeout(pending.timeout);
    pending.timeout = null;
  }

  /** saveDir, if given, overrides this.saveDir for every file in this connection's batch — the
   *  per-transfer destination the user picked via the native folder dialog. */
  acceptGuest(connId: string, saveDir?: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    if (saveDir) this.connSaveDirs.set(connId, saveDir);
    this.admit(connId, pending.ws, pending.deviceName || 'Guest');
  }

  rejectGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    try { pending.ws.close(4007, 'rejected by host'); } catch {}
  }

  disconnectConnection(connId: string) {
    const ws = this.admittedConnections.get(connId);
    if (ws) {
      try { ws.close(1000, 'disconnect'); } catch {}
      this.admittedConnections.delete(connId);
    }
  }

  /** remoteAddress for a still-pending (not yet accepted/rejected) guest — everything the caller
   *  (main.ts) needs to add a real Blocklist entry for "Block" on a pending PIN-confirm request. */
  getPendingGuestBlockInfo(connId: string): { remoteAddress: string; deviceName?: string } | null {
    const pending = this.pendingGuests.get(connId);
    return pending ? { remoteAddress: pending.remoteAddress, deviceName: pending.deviceName } : null;
  }

  /** True only while bytes are actually flowing for at least one connection — distinct from "is
   *  the receive-mode server running at all" (which stays true between batches so a second sender
   *  can connect without the user restarting "Receive Files"). main.ts's get-portal-status uses
   *  this for the Tools grid's "ACTIVE" badge specifically, so it correctly turns off once a
   *  transfer finishes instead of staying lit for the whole "Receive Files" session regardless of
   *  whether anything is actually in flight right now. */
  hasActiveTransfer(): boolean {
    return this.activeTransfers.size > 0;
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingGuests.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      try { pending.ws.close(1000, 'receiver stopped'); } catch {}
    }
    this.pendingGuests.clear();
    this.validTokens.clear();
    for (const ws of this.admittedConnections.values()) {
      try { ws.close(1000, 'receiver stopped'); } catch {}
    }
    this.admittedConnections.clear();
    for (const transfer of this.activeTransfers.values()) {
      try { fs.closeSync(transfer.fd); } catch {}
    }
    this.activeTransfers.clear();
    this.batchState.clear();
    this.connSaveDirs.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpsServer) {
      const server = this.httpsServer;
      this.httpsServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.availableDownloads = [];
  }

  private admit(connId: string, ws: WebSocket, senderDeviceName: string) {
    this.admittedConnections.set(connId, ws);
    // deviceName here is THIS (receiving) device's own name — lets the sender show "Connected
    // with <name>" instead of a generic placeholder, mirroring what connectionAdmitted already
    // gives the receiver about the sender below.
    ws.send(JSON.stringify({ type: 'admitted', deviceName: this.deviceName }));
    if (this.isWebMode && this.availableDownloads.length > 0) {
      ws.send(JSON.stringify({
        type: 'downloads-available',
        files: this.availableDownloads.map(d => ({ id: d.id, name: d.name, size: d.size }))
      }));
    }
    this.emit('connectionAdmitted', connId, senderDeviceName);
  }

  private handleConnection(ws: WebSocket, req: any) {
    let peerPublicKeyDer: Buffer | null = null;

    if (!this.isWebMode) {
      const socket = req.socket as tls.TLSSocket;
      const peerCert = socket.getPeerCertificate();
      if (!peerCert || !peerCert.raw) {
        ws.close(4001, 'no client certificate presented');
        return;
      }

      try {
        peerPublicKeyDer = new crypto.X509Certificate(peerCert.raw).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      } catch {
        ws.close(4002, 'invalid certificate');
        return;
      }
    }

    const remoteAddress = (req.socket.remoteAddress as string) || 'unknown';
    const connId = crypto.randomUUID();

    if (this.isBlocked(remoteAddress)) {
      ws.close(4010, 'blocked');
      return;
    }

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
        const entry = this.validTokens.get(msg.token);
        if (!entry) {
          ws.close(4005, 'invalid or expired token');
          return;
        }
        this.validTokens.delete(msg.token); // one-time use
        if (this.isBlocked(entry.deviceId)) {
          ws.close(4010, 'blocked');
          return;
        }
        this.admit(connId, ws, entry.deviceName);
      } else if (msg.type === 'join-guest') {
        let pin: string;
        if (this.isWebMode) {
          pin = Math.floor(100000 + crypto.randomInt(900000)).toString();
        } else {
          pin = computeVerificationCode(this.myPublicKeyDer, peerPublicKeyDer!);
        }
        const timeout = setTimeout(() => {
          this.pendingGuests.delete(connId);
          try { ws.close(4006, 'confirmation timed out'); } catch {}
        }, GUEST_CONFIRM_TIMEOUT_MS);
        const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName : undefined;
        this.pendingGuests.set(connId, { ws, pin, timeout, remoteAddress, deviceName });
        try { ws.send(JSON.stringify({ type: 'pin', code: pin })); } catch {}
        this.emit('guestPinPending', connId, pin, remoteAddress, deviceName);
      } else {
        ws.close(4004, 'unknown join type');
      }
    };
    ws.on('message', onFirstMessage);

    // After admission, every message is either batch-info/file-info JSON or a binary chunk — the
    // isBinary flag (ws 8.x's message event signature) is what distinguishes them, since both can
    // arrive on the same connection.
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        let msg: any;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (msg.type === 'batch-info' && typeof msg.count === 'number' && msg.count > 0) {
          this.batchState.set(connId, { expected: msg.count, received: 0 });
        } else if (msg.type === 'file-info' && typeof msg.name === 'string' && typeof msg.size === 'number') {
          this.startTransfer(connId, ws, msg.name, msg.size);
        }
        return;
      }
      this.handleBinaryChunk(connId, ws, data as Buffer);
    });

    ws.on('close', () => {
      this.pendingGuests.delete(connId);
      this.batchState.delete(connId);
      this.connSaveDirs.delete(connId);
      this.admittedConnections.delete(connId);
      this.emit('connectionClosed', connId);
      const transfer = this.activeTransfers.get(connId);
      if (transfer) {
        // Connection dropped mid-transfer — close the partial file handle and leave the partial
        // file on disk rather than silently deleting it (the user may still want the partial
        // bytes, and this mirrors how a failed browser download is handled).
        try { fs.closeSync(transfer.fd); } catch {}
        this.activeTransfers.delete(connId);
      }
    });
  }

  private startTransfer(connId: string, ws: WebSocket, name: string, size: number) {
    if (size < 0 || size > MAX_FILE_BYTES) {
      ws.close(4008, 'file too large');
      return;
    }
    const saveDir = this.connSaveDirs.get(connId) || this.saveDir;
    fs.mkdirSync(saveDir, { recursive: true });

    // Sanitize path to prevent directory traversal
    const parts = name.split(/[/\\]/).filter(p => p && p !== '.' && p !== '..');
    const relativePath = path.join(...parts);
    if (!relativePath) {
      ws.close(4009, 'invalid filename');
      return;
    }

    let destPath = path.join(saveDir, relativePath);
    const dirName = path.dirname(destPath);
    fs.mkdirSync(dirName, { recursive: true });

    const ext = path.extname(relativePath);
    const base = path.basename(relativePath, ext);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      destPath = path.join(dirName, `${base} (${counter})${ext}`);
      counter++;
    }

    const fd = fs.openSync(destPath, 'w');
    this.activeTransfers.set(connId, { name: relativePath, size, received: 0, fd, destPath });
    this.emit('transferStarted', connId, relativePath, size);
  }

  private handleBinaryChunk(connId: string, ws: WebSocket, chunk: Buffer) {
    const transfer = this.activeTransfers.get(connId);
    if (!transfer) return; // binary arrived before file-info — ignore, sender protocol error
    fs.writeSync(transfer.fd, chunk, 0, chunk.length, transfer.received);
    transfer.received += chunk.length;
    this.emit('transferProgress', connId, transfer.received, transfer.size);

    if (transfer.received >= transfer.size) {
      fs.closeSync(transfer.fd);
      this.activeTransfers.delete(connId);
      this.emit('transferComplete', connId, transfer.destPath);

      // No batch-info at all (an older client, or a genuinely single-file sender) means an
      // implicit count of 1 — finish immediately, same as before this feature existed.
      const batch = this.batchState.get(connId);
      if (batch) {
        batch.received += 1;
        if (batch.received < batch.expected) return; // more files still coming on this connection
        this.batchState.delete(connId);
      }

      try { ws.send(JSON.stringify({ type: 'received' })); } catch {}
    }
  }
}

function getWebClientHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Web Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #030303;
      --card-bg: rgba(13, 13, 17, 0.75);
      --text: #f8fafc;
      --text-muted: #64748b;
      --accent: #009bd5;
      --accent-hover: #3b82f6;
      --accent-gradient: linear-gradient(135deg, #009bd5 0%, #3b82f6 100%);
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(0, 155, 213, 0.25);
      --input-bg: rgba(255, 255, 255, 0.03);
      --font-display: 'Outfit', sans-serif;
      --font-sans: 'Inter', sans-serif;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 0% 0%, rgba(0, 155, 213, 0.03) 0%, transparent 40%),
        radial-gradient(circle at 100% 100%, rgba(59, 130, 246, 0.04) 0%, transparent 40%);
      color: var(--text);
      font-family: var(--font-sans);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      width: 100%;
      max-width: 440px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(20px);
      display: flex;
      flex-direction: column;
      gap: 24px;
      transition: border-color 0.3s ease, box-shadow 0.3s ease;
    }
    .container:hover {
      border-color: var(--border-hover);
      box-shadow: 0 25px 60px rgba(0, 155, 213, 0.1), inset 0 1px 1px rgba(255, 255, 255, 0.05);
    }
    .header {
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .header svg {
      color: var(--accent);
      margin-bottom: 8px;
      filter: drop-shadow(0 0 8px rgba(0, 155, 213, 0.4));
    }
    h1 {
      font-family: var(--font-display);
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .section {
      display: none;
      flex-direction: column;
      gap: 16px;
    }
    .section.active {
      display: flex;
    }
    input[type="text"] {
      width: 100%;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--input-bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s, background 0.2s;
    }
    input[type="text"]:focus {
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.06);
    }
    button {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: none;
      background: var(--accent-gradient);
      color: #fff;
      font-family: var(--font-sans);
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 155, 213, 0.3);
      transition: transform 0.2s, opacity 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(0, 155, 213, 0.4);
    }
    button:active {
      transform: translateY(0);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    .pin-box {
      background: rgba(0, 155, 213, 0.05);
      border: 1px solid rgba(0, 155, 213, 0.2);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      font-size: 36px;
      font-weight: 800;
      letter-spacing: 6px;
      color: var(--accent);
      font-family: monospace;
      box-shadow: 0 0 15px rgba(0, 155, 213, 0.1);
    }
    .dropzone {
      border: 2px dashed rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 40px 20px;
      text-align: center;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      transition: border-color 0.2s, background 0.2s;
    }
    .dropzone:hover, .dropzone.dragover {
      border-color: var(--accent);
      background: rgba(0, 155, 213, 0.05);
    }
    .file-list {
      max-height: 180px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .file-item {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      padding: 12px;
      border-radius: 8px;
      font-size: 13px;
    }
    .file-name {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .progress-bar {
      height: 6px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent-gradient);
      width: 0%;
      transition: width 0.1s;
    }
    .file-info {
      display: flex;
      justify-content: space-between;
      color: var(--text-muted);
      font-size: 11px;
    }
    .status-alert {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
      line-height: 1.5;
    }
    .status-success {
      color: #10b981;
      font-weight: 500;
    }
    .status-error {
      color: #ef4444;
      font-weight: 500;
    }
    .download-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      padding: 12px;
      border-radius: 8px;
      font-size: 13px;
    }
    .download-name {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
      text-align: left;
    }
    .download-size {
      color: var(--text-muted);
      font-size: 11px;
      margin-left: 4px;
    }
    .download-btn {
      padding: 6px 12px;
      font-size: 11px;
      border-radius: 6px;
      width: auto;
      box-shadow: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <h1 id="title">Link Web Portal</h1>
      <p class="subtitle" id="subtitle">Connect to peer to send files directly over the local network.</p>
    </div>

    <!-- Step 1: Device Info -->
    <div class="section active" id="sec-connect">
      <input type="text" id="device-name" placeholder="Your device name (e.g. My Phone)" />
      <button id="btn-connect">Connect</button>
    </div>

    <!-- Step 2: Verification PIN -->
    <div class="section" id="sec-pin">
      <div class="status-alert">Verify that this PIN matches the one displayed on the receiving device:</div>
      <div class="pin-box" id="pin-display">------</div>
      <div class="status-alert">Waiting for authorization on host...</div>
    </div>

    <!-- Step 3: Two-Way Portal Interface -->
    <div class="section" id="sec-upload">
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; text-align: left;">Upload to PC</div>
        <div class="dropzone" id="dropzone">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-muted)">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span style="font-size: 13px; font-weight: 500;">Drag & Drop files here or click to browse</span>
        </div>
        <input type="file" id="file-input" multiple style="display: none" />
        <div class="file-list" id="file-list"></div>
        <div class="status-alert" id="upload-status"></div>
      </div>

      <div id="downloads-container" style="display: none; flex-direction: column; gap: 12px; border-top: 1px solid var(--border); padding-top: 16px; margin-top: 8px;">
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; text-align: left;">Download from PC</div>
        <div id="download-list" style="max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;"></div>
      </div>
    </div>
  </div>

  <script>
    const secConnect = document.getElementById('sec-connect');
    const secPin = document.getElementById('sec-pin');
    const secUpload = document.getElementById('sec-upload');
    const inputDevice = document.getElementById('device-name');
    const btnConnect = document.getElementById('btn-connect');
    const pinDisplay = document.getElementById('pin-display');
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const fileListContainer = document.getElementById('file-list');
    const uploadStatus = document.getElementById('upload-status');
    const subtitle = document.getElementById('subtitle');
    const downloadsContainer = document.getElementById('downloads-container');
    const downloadList = document.getElementById('download-list');

    // Default device name based on browser UA
    let defaultName = 'Web Browser';
    if (/android/i.test(navigator.userAgent)) defaultName = 'Android Browser';
    else if (/ipad|iphone|ipod/i.test(navigator.userAgent)) defaultName = 'iOS Browser';
    else if (/mac/i.test(navigator.userAgent)) defaultName = 'Mac Browser';
    else if (/windows/i.test(navigator.userAgent)) defaultName = 'Windows Browser';
    inputDevice.placeholder = 'Your device name (e.g. ' + defaultName + ')';

    let ws = null;
    let selectedFiles = [];

    btnConnect.addEventListener('click', () => {
      const devName = inputDevice.value.trim() || defaultName;
      btnConnect.disabled = true;
      btnConnect.textContent = 'Connecting...';

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = wsProtocol + '//' + location.host + '/ws';
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'join-guest',
          deviceName: devName
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pin') {
          secConnect.classList.remove('active');
          secPin.classList.add('active');
          const pinStr = msg.code.toString();
          pinDisplay.textContent = pinStr.substring(0, 3) + ' ' + pinStr.substring(3);
          subtitle.textContent = 'Authenticating connection...';
        } else if (msg.type === 'admitted') {
          secPin.classList.remove('active');
          secUpload.classList.add('active');
          subtitle.textContent = 'Two-way files sharing active.';
        } else if (msg.type === 'received') {
          uploadStatus.innerHTML = '<span class="status-success">✓ All files transferred successfully!</span>';
          selectedFiles = [];
          fileListContainer.innerHTML = '';
          dropzone.style.pointerEvents = 'auto';
          dropzone.style.opacity = '1';
        } else if (msg.type === 'downloads-available') {
          updateDownloadsList(msg.files);
        }
      };

      ws.onerror = (err) => {
        alert('Connection error. Please try again.');
        resetUI();
      };

      ws.onclose = () => {
        alert('Connection closed.');
        resetUI();
      };
    });

    function resetUI() {
      if (ws) {
        try { ws.close(); } catch(e) {}
        ws = null;
      }
      btnConnect.disabled = false;
      btnConnect.textContent = 'Connect';
      secPin.classList.remove('active');
      secUpload.classList.remove('active');
      secConnect.classList.add('active');
      subtitle.textContent = 'Connect to peer to send files directly over the local network.';
      uploadStatus.textContent = '';
      fileListContainer.innerHTML = '';
      selectedFiles = [];
      dropzone.style.pointerEvents = 'auto';
      dropzone.style.opacity = '1';
      downloadsContainer.style.display = 'none';
      downloadList.innerHTML = '';
    }

    function updateDownloadsList(files) {
      if (!files || files.length === 0) {
        downloadsContainer.style.display = 'none';
        downloadList.innerHTML = '';
        return;
      }
      downloadsContainer.style.display = 'flex';
      downloadList.innerHTML = '';
      files.forEach((file) => {
        const item = document.createElement('div');
        item.className = 'download-item';
        item.innerHTML = 
          '<div class="download-name" title="' + file.name + '">' + file.name + 
            ' <span class="download-size">(' + formatBytes(file.size) + ')</span>' +
          '</div>' +
          '<a href="/download/' + file.id + '" download="' + file.name + '" style="text-decoration: none;">' +
            '<button class="download-btn">Download</button>' +
          '</a>';
        downloadList.appendChild(item);
      });
    }

    dropzone.addEventListener('click', () => fileInput.click());
    
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = Array.from(dt.files);
      if (files.length > 0) {
        handleFilesSelected(files);
      }
    });

    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      if (files.length > 0) {
        handleFilesSelected(files);
      }
    });

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function handleFilesSelected(files) {
      selectedFiles = files;
      fileListContainer.innerHTML = '';
      
      selectedFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.id = 'file-item-' + index;
        item.innerHTML = 
          '<div class="file-name">' + file.name + '</div>' +
          '<div class="progress-bar">' +
            '<div class="progress-fill" id="progress-fill-' + index + '"></div>' +
          '</div>' +
          '<div class="file-info">' +
            '<span id="progress-text-' + index + '">0%</span>' +
            '<span>' + formatBytes(file.size) + '</span>' +
          '</div>';
        fileListContainer.appendChild(item);
      });

      startUpload();
    }

    function startUpload() {
      if (!ws || selectedFiles.length === 0) return;
      
      dropzone.style.pointerEvents = 'none';
      dropzone.style.opacity = '0.5';
      uploadStatus.innerHTML = 'Sending batch info...';
      
      ws.send(JSON.stringify({
        type: 'batch-info',
        count: selectedFiles.length
      }));

      let currentFileIndex = 0;

      function uploadNext() {
        if (currentFileIndex >= selectedFiles.length) {
          uploadStatus.innerHTML = 'Waiting for confirmation...';
          return;
        }

        const file = selectedFiles[currentFileIndex];
        uploadStatus.innerHTML = 'Sending file ' + (currentFileIndex + 1) + ' of ' + selectedFiles.length + ': ' + file.name;
        
        ws.send(JSON.stringify({
          type: 'file-info',
          name: file.name,
          size: file.size
        }));

        const chunkSize = 65536;
        let offset = 0;
        const progressFill = document.getElementById('progress-fill-' + currentFileIndex);
        const progressText = document.getElementById('progress-text-' + currentFileIndex);

        function sendChunk() {
          if (offset >= file.size) {
            currentFileIndex++;
            uploadNext();
            return;
          }

          if (ws.bufferedAmount > 1024 * 1024) {
            setTimeout(sendChunk, 50);
            return;
          }

          const slice = file.slice(offset, offset + chunkSize);
          ws.send(slice);
          offset += chunkSize;

          const pct = Math.min(100, Math.round((offset / file.size) * 100));
          if (progressFill) progressFill.style.width = pct + '%';
          if (progressText) progressText.textContent = pct + '%';

          setTimeout(sendChunk, 0);
        }

        sendChunk();
      }

      uploadNext();
    }
  </script>
</body>
</html>`;
}
