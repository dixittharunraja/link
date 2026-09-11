import * as https from 'https';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { computeVerificationCode } from '../core/pairing';
import { GUEST_SESSION_CONFIRM_TIMEOUT_MS } from './constants';
import { PendingGuest, AdmittedGuest } from './guest-session-types';

const GUEST_CONFIRM_TIMEOUT_MS = GUEST_SESSION_CONFIRM_TIMEOUT_MS;

export class JoystickServer extends EventEmitter {
  private httpsServer: https.Server | null = null;
  private wss: WebSocket.Server | null = null;
  private myPublicKeyDer: Buffer;

  private pendingGuests = new Map<string, PendingGuest>();
  private admittedGuests = new Map<string, AdmittedGuest>();

  constructor(
    private cert: string,
    private key: string,
    private port: number,
    private isBlocked: (idOrIp: string) => boolean = () => false,
    private isTrusted: (peerCertDer: Buffer, remoteAddress: string) => { trusted: boolean; deviceName?: string } = () => ({ trusted: false })
  ) {
    super();
    this.myPublicKeyDer = new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
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
    });
  }

  stop() {
    this.wss?.close();
    this.httpsServer?.close();
  }

  acceptGuest(connId: string, padIndex: number) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    this.admittedGuests.set(pending.remoteAddress, { ws: pending.ws, remoteAddress: pending.remoteAddress, deviceName: pending.deviceName });
    try {
      pending.ws.send(JSON.stringify({ type: 'admitted', padIndex }));
    } catch {}
    this.emit('guestJoined', pending.remoteAddress, pending.deviceName);
  }

  rejectGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    try { pending.ws.close(4007, 'rejected by host'); } catch {}
  }

  blockGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    try { pending.ws.close(4010, 'blocked'); } catch {}
  }

  getPendingGuestRemoteAddress(connId: string): string | null {
    return this.pendingGuests.get(connId)?.remoteAddress ?? null;
  }

  getPendingGuestDeviceName(connId: string): string | null {
    return this.pendingGuests.get(connId)?.deviceName ?? null;
  }

  sendRumble(ip: string, large: number, small: number) {
    const guest = this.admittedGuests.get(ip);
    if (!guest) return;
    try {
      guest.ws.send(JSON.stringify({ type: 'rumble', large, small }));
    } catch {}
  }

  sendPing(ip: string) {
    const guest = this.admittedGuests.get(ip);
    if (!guest) return;
    try {
      guest.ws.send(JSON.stringify({ type: 'ping' }));
    } catch {}
  }

  broadcastPing(ips: string[]) {
    for (const ip of ips) {
      this.sendPing(ip);
    }
  }

  kickGuest(ip: string, reason: string = 'removed by host') {
    const guest = this.admittedGuests.get(ip);
    if (!guest) return;
    try { guest.ws.close(1000, reason); } catch {}
  }

  private handleConnection(ws: WebSocket, req: any) {
    const socket = req.socket as tls.TLSSocket;
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

    const rawAddress = (req.socket.remoteAddress as string) || 'unknown';
    const remoteAddress = rawAddress.replace(/^::ffff:/, '');
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
        ws.close(4003, 'malformed first message');
        return;
      }

      if (msg.type === 'join-guest') {
        const trustInfo = this.isTrusted(peerCert.raw, remoteAddress);
        const deviceName = trustInfo.deviceName || (typeof msg.deviceName === 'string' ? msg.deviceName : 'Controller');

        if (trustInfo.trusted) {
          // Trusted paired device: auto-admit without PIN confirmation
          this.emit('autoAdmit', remoteAddress, deviceName, (padIndex: number | null, error?: string) => {
            if (padIndex !== null && padIndex !== undefined && !error) {
              this.admittedGuests.set(remoteAddress, { ws, remoteAddress, deviceName });
              try {
                ws.send(JSON.stringify({ type: 'admitted', padIndex }));
              } catch {}
              this.emit('guestJoined', remoteAddress, deviceName);
            } else {
              try { ws.close(4008, error || 'failed to admit'); } catch {}
            }
          });
          return;
        }

        const pin = computeVerificationCode(this.myPublicKeyDer, peerPublicKeyDer);
        const timeout = setTimeout(() => {
          this.pendingGuests.delete(connId);
          try { ws.close(4006, 'confirmation timed out'); } catch {}
        }, GUEST_CONFIRM_TIMEOUT_MS);

        this.pendingGuests.set(connId, { ws, pin, timeout, remoteAddress, deviceName });
        try { ws.send(JSON.stringify({ type: 'pin', code: pin })); } catch {}
        this.emit('guestPinPending', connId, pin, remoteAddress, deviceName);
      } else {
        ws.close(4004, 'unknown join type');
      }
    };
    ws.on('message', onFirstMessage);

    ws.on('close', () => {
      if (this.pendingGuests.has(connId)) {
        const p = this.pendingGuests.get(connId)!;
        if (p.timeout) clearTimeout(p.timeout);
        this.pendingGuests.delete(connId);
      }
      if (this.admittedGuests.has(remoteAddress)) {
        this.admittedGuests.delete(remoteAddress);
        this.emit('guestLeft', remoteAddress);
      }
    });
  }
}
