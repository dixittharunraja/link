// Portal Mode — sender side. Mirrors portal-transfer-server.ts's protocol exactly (see that
// file's header comment) and audio-relay-client.ts's connection/PIN pattern — connects with this
// device's own long-lived TLS identity, announces intent as the first message, then either waits
// for a human PIN-confirm (guest path) or is admitted immediately (paired-token path).
//
// Once admitted, sends a {"type":"batch-info","count":N} message, then for each file in order a
// {"type":"file-info"} JSON message followed by that file's bytes as binary WS frames in 64KB
// pieces (same chunk size as payload-transfer.ts's upload path), respecting backpressure via ws's
// own bufferedAmount. The server sends one 'received' ack only once all N files have arrived.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { computeVerificationCode } from '../core/pairing';

export type JoinMode = { kind: 'guest' } | { kind: 'token'; token: string };

export interface PortalTransferClientEvents {
  pinComputed: (pin: string) => void;
  admitted: (receiverDeviceName?: string) => void;
  // fileIndex/fileCount let the UI show "file 2 of 5" — progress itself is still per-file byte
  // counts (sent/total for the CURRENT file), same shape as before this feature existed.
  fileStarted: (fileIndex: number, fileCount: number, name: string) => void;
  progress: (sent: number, total: number) => void;
  complete: () => void;
  ended: () => void;
  closed: (reason: string) => void;
  error: (err: Error) => void;
}

export declare interface PortalTransferClient {
  on<E extends keyof PortalTransferClientEvents>(event: E, listener: PortalTransferClientEvents[E]): this;
  emit<E extends keyof PortalTransferClientEvents>(event: E, ...args: Parameters<PortalTransferClientEvents[E]>): boolean;
}

const CHUNK_SIZE = 262144; // 256KB chunks for maximum throughput

export class PortalTransferClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pinComputedLocally = false;

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
    const url = `wss://${this.host}:${this.port}`;
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

    this.ws.on('message', (data: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'admitted') this.emit('admitted', msg.deviceName);
      else if (msg.type === 'received') this.emit('complete');
      else if (msg.type === 'pin' && !this.pinComputedLocally) this.emit('pinComputed', msg.code);
    });

    this.ws.on('close', (code, reason) => {
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

  /** Streams every file in filePaths, in order, to the (already-admitted) receiver over the same
   *  connection — one batch-info announcing the count, then one file-info + binary frames per
   *  file. Rejects if not currently admitted/open — callers should only invoke this after the
   *  'admitted' event has fired. The server only sends its final 'received' ack (see 'complete')
   *  once every file in the batch has arrived. */
  async sendFiles(files: { localPath: string; relPath: string }[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify({ type: 'batch-info', count: files.length }));
    for (let i = 0; i < files.length; i++) {
      this.emit('fileStarted', i, files.length, files[i].relPath);
      await this.sendOneFile(files[i].localPath, files[i].relPath);
    }
  }

  private sendOneFile(filePath: string, relPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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

      this.ws.send(JSON.stringify({ type: 'file-info', name: relPath, size: stat.size }));

      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(CHUNK_SIZE);
      let offset = 0;
      const total = stat.size;

      const writeNext = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          fs.closeSync(fd);
          reject(new Error('Connection closed mid-transfer'));
          return;
        }
        if (offset >= total) {
          fs.closeSync(fd);
          resolve();
          return;
        }
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(CHUNK_SIZE, total - offset), offset);
        const slice = Buffer.from(buffer.subarray(0, bytesRead));
        offset += bytesRead;
        this.emit('progress', offset, total);

        this.ws.send(slice, { binary: true }, (err) => {
          if (err) {
            fs.closeSync(fd);
            reject(err);
            return;
          }
          // Respect backpressure — don't queue the whole file in ws's internal buffer if the
          // receiver is draining slower than we can read local disk (same reasoning as
          // fs-mount-service.ts's chunked download loop).
          if (this.ws!.bufferedAmount > CHUNK_SIZE * 4) {
            setImmediate(writeNext);
          } else {
            writeNext();
          }
        });
      };
      writeNext();
    });
  }

  disconnect(): void {
    if (this.ws) {
      // Explicit code+reason (matching audio-sink-client.ts/walkie-talkie-signal-client.ts's
      // disconnect()) rather than a bare close() — a codeless close can locally resolve to a
      // non-1000/1001 code (e.g. 1005), which onWsClose's fallback would otherwise surface as a
      // raw "code 1005" error for what was actually just us intentionally hanging up.
      try { this.ws.close(1000, 'left'); } catch {}
      this.ws = null;
    }
  }
}
