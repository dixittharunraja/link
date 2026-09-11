// Portal Mode — sender side. Connects to server, broadcasts available files manifest,
// responds to download requests, and requests downloads from server.

import * as crypto from 'crypto';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { computeVerificationCode } from '../core/pairing';
import { normalizeHost } from '../core/transport';
import * as path from 'path';

const STREAM_CHUNK_SIZE = 262144; // 256KB chunks

export function streamFileOverWebSocket(
  ws: WebSocket,
  filePath: string,
  relPath: string,
  onProgress?: (sent: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected'));
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (e: any) {
      reject(new Error('Failed to read file: ' + e.message));
      return;
    }

    ws.send(JSON.stringify({ type: 'file-info', name: relPath, size: stat.size }));

    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(STREAM_CHUNK_SIZE);
    let offset = 0;
    const total = stat.size;

    const writeNext = () => {
      if (ws.readyState !== WebSocket.OPEN) {
        fs.closeSync(fd);
        reject(new Error('Connection closed mid-transfer'));
        return;
      }
      if (offset >= total) {
        fs.closeSync(fd);
        resolve();
        return;
      }
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(STREAM_CHUNK_SIZE, total - offset), offset);
      const slice = Buffer.from(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      if (onProgress) onProgress(offset, total);

      ws.send(slice, { binary: true }, (err) => {
        if (err) {
          fs.closeSync(fd);
          reject(err);
          return;
        }
        if (ws.bufferedAmount > STREAM_CHUNK_SIZE * 4) {
          setImmediate(writeNext);
        } else {
          writeNext();
        }
      });
    };
    writeNext();
  });
}

type JoinMode = { kind: 'guest' } | { kind: 'token'; token: string };

const MAX_FILE_BYTES = 100 * 1024 * 1024 * 1024 * 1024; // 100TB

interface ActiveReceiveTransfer {
  name: string;
  size: number;
  received: number;
  fd: number;
  destPath: string;
}

interface BatchState {
  expected: number;
  received: number;
}

interface SharedFileEntry {
  id: string;
  name: string;
  size: number;
  localPath: string;
}

interface RemoteFileEntry {
  id: string;
  name: string;
  size: number;
}

interface FileTransferClientEvents {
  pinComputed: (pin: string) => void;
  admitted: (receiverDeviceName?: string) => void;
  peerFilesChanged: (files: RemoteFileEntry[]) => void;
  fileStarted: (fileIndex: number, fileCount: number, name: string) => void;
  progress: (sent: number, total: number) => void;
  complete: () => void;
  transferStarted: (name: string, size: number) => void;
  transferProgress: (received: number, size: number) => void;
  transferComplete: (destPath: string) => void;
  ended: () => void;
  closed: (reason: string) => void;
  error: (err: Error) => void;
}

export declare interface FileTransferClient {
  on<E extends keyof FileTransferClientEvents>(event: E, listener: FileTransferClientEvents[E]): this;
  emit<E extends keyof FileTransferClientEvents>(event: E, ...args: Parameters<FileTransferClientEvents[E]>): boolean;
}

export class FileTransferClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pinComputedLocally = false;
  private activeReceive: ActiveReceiveTransfer | null = null;
  private batchState: BatchState | null = null;
  private peerDeviceName: string | null = null;
  private availableDownloads: SharedFileEntry[] = [];
  private peerFiles: RemoteFileEntry[] = [];

  constructor(
    private host: string,
    private port: number,
    private clientCert: string,
    private clientKey: string,
    private localDeviceName: string,
    private saveDir: string = ''
  ) {
    super();
  }

  setSaveDir(dir: string) {
    this.saveDir = dir;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getPeerDeviceName(): string | null {
    return this.peerDeviceName;
  }

  getPeerFiles(): RemoteFileEntry[] {
    return this.peerFiles;
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
          console.error('[Link] Failed to stat file for client download:', e);
        }
      }
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'downloads-available',
        files: this.availableDownloads.map(d => ({ id: d.id, name: d.name, size: d.size }))
      }));
    }
  }

  connect(mode: JoinMode): void {
    const host = normalizeHost(this.host);
    const url = `wss://${host}:${this.port}`;
    this.ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout: 15000,
      cert: this.clientCert,
      key: this.clientKey,
    });

    this.ws.on('open', () => {
      if (mode.kind === 'token') {
        this.ws!.send(JSON.stringify({ type: 'join-token', token: mode.token }));
      } else {
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
        this.ws!.send(JSON.stringify({ type: 'join-guest', deviceName: this.localDeviceName }));
      }
    });

    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        let msg: any;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (msg.type === 'admitted') {
          this.peerDeviceName = msg.deviceName || null;
          this.emit('admitted', msg.deviceName);
          if (this.availableDownloads.length > 0) {
            this.ws?.send(JSON.stringify({
              type: 'downloads-available',
              files: this.availableDownloads.map(d => ({ id: d.id, name: d.name, size: d.size }))
            }));
          }
        } else if (msg.type === 'downloads-available' && Array.isArray(msg.files)) {
          this.peerFiles = msg.files;
          this.emit('peerFilesChanged', msg.files);
        } else if (msg.type === 'request-download' && typeof msg.fileId === 'string') {
          const file = this.availableDownloads.find(d => d.id === msg.fileId);
          if (file && fs.existsSync(file.localPath)) {
            streamFileOverWebSocket(this.ws!, file.localPath, file.name, (sent, total) => {
              this.emit('progress', sent, total);
            }).then(() => {
              this.emit('complete');
            }).catch((err) => {
              console.error('[Link] Client download stream failed:', err);
            });
          }
        } else if (msg.type === 'received') {
          this.emit('complete');
        } else if (msg.type === 'pin' && !this.pinComputedLocally) {
          this.emit('pinComputed', msg.code);
        } else if (msg.type === 'batch-info' && typeof msg.count === 'number' && msg.count > 0) {
          this.batchState = { expected: msg.count, received: 0 };
        } else if (msg.type === 'file-info' && typeof msg.name === 'string' && typeof msg.size === 'number') {
          this.startReceiveTransfer(msg.name, msg.size);
        }
        return;
      }
      this.handleBinaryChunk(data as Buffer);
    });

    this.ws.on('close', (code, reason) => {
      if (this.activeReceive) {
        try { fs.closeSync(this.activeReceive.fd); } catch {}
        this.activeReceive = null;
      }
      this.batchState = null;
      this.peerFiles = [];
      if (code === 1000 || code === 1001) {
        this.emit('ended');
      } else {
        this.emit('closed', reason?.toString() || `code ${code}`);
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  requestDownload(fileId: string, saveDir?: string) {
    if (saveDir) {
      this.saveDir = saveDir;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'request-download', fileId }));
    }
  }

  async sendFiles(files: { localPath: string; relPath: string }[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify({ type: 'batch-info', count: files.length }));
    for (let i = 0; i < files.length; i++) {
      this.emit('fileStarted', i, files.length, files[i].relPath);
      await streamFileOverWebSocket(this.ws, files[i].localPath, files[i].relPath, (sent, total) => {
        this.emit('progress', sent, total);
      });
    }
  }

  private startReceiveTransfer(name: string, size: number) {
    if (size < 0 || size > MAX_FILE_BYTES) {
      this.ws?.close(4008, 'file too large');
      return;
    }
    const saveDir = this.saveDir || '';
    if (saveDir) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    const parts = name.split(/[/\\]/).filter(p => p && p !== '.' && p !== '..');
    const relativePath = path.join(...parts);
    if (!relativePath) {
      this.ws?.close(4009, 'invalid filename');
      return;
    }

    let destPath = saveDir ? path.join(saveDir, relativePath) : relativePath;
    const dirName = path.dirname(destPath);
    if (dirName) fs.mkdirSync(dirName, { recursive: true });

    const ext = path.extname(relativePath);
    const base = path.basename(relativePath, ext);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      destPath = path.join(dirName, `${base} (${counter})${ext}`);
      counter++;
    }

    const fd = fs.openSync(destPath, 'w');
    this.activeReceive = { name: relativePath, size, received: 0, fd, destPath };
    this.emit('transferStarted', relativePath, size);
  }

  private handleBinaryChunk(chunk: Buffer) {
    const transfer = this.activeReceive;
    if (!transfer) return;
    fs.writeSync(transfer.fd, chunk, 0, chunk.length, transfer.received);
    transfer.received += chunk.length;
    this.emit('transferProgress', transfer.received, transfer.size);

    if (transfer.received >= transfer.size) {
      fs.closeSync(transfer.fd);
      this.activeReceive = null;
      this.emit('transferComplete', transfer.destPath);

      if (this.batchState) {
        this.batchState.received += 1;
        if (this.batchState.received < this.batchState.expected) return;
        this.batchState = null;
      }

      try { this.ws?.send(JSON.stringify({ type: 'received' })); } catch {}
    }
  }

  disconnect(): void {
    if (this.activeReceive) {
      try { fs.closeSync(this.activeReceive.fd); } catch {}
      this.activeReceive = null;
    }
    this.batchState = null;
    this.peerFiles = [];
    if (this.ws) {
      try { this.ws.close(1000, 'left'); } catch {}
      this.ws = null;
    }
  }
}

