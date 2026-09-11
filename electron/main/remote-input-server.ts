// Input Guest Server — allows temporary, ephemeral guest sessions for Presenter & Remote Input
// (Touchpad, Mouse, Stylus/Digitizer) without requiring permanent pairing or touching the TrustStore.
// Admitted guests are authorized by IP on port 1717 for high-speed UDP input relay.

import * as https from 'https';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { computeVerificationCode } from '../core/pairing';
import { GUEST_SESSION_CONFIRM_TIMEOUT_MS } from './constants';
import { PendingGuest, AdmittedGuest } from './guest-session-types';

export type InputMode = 'presenter' | 'touchpad';

export interface AdmittedInputGuest extends AdmittedGuest {
  mode: InputMode;
}

export interface PendingInputGuest extends PendingGuest {
  mode: InputMode;
}

export class RemoteInputServer extends EventEmitter {
  private httpsServer: https.Server | null = null;
  private wss: WebSocket.Server | null = null;
  private myPublicKeyDer: Buffer;

  private pendingGuests = new Map<string, PendingInputGuest>();
  private admittedGuests = new Map<string, AdmittedInputGuest>(); // keyed by remoteAddress

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

  isAdmitted(ip: string, mode?: InputMode): boolean {
    const cleanIp = ip.replace(/^::ffff:/, '');
    const guest = this.admittedGuests.get(cleanIp);
    if (!guest) return false;
    if (mode && guest.mode !== mode && guest.mode !== 'touchpad') return false;
    return true;
  }

  getAdmittedGuests(): { ip: string; name: string; mode: InputMode }[] {
    return Array.from(this.admittedGuests.values()).map((g) => ({
      ip: g.remoteAddress,
      name: g.deviceName || 'Remote Guest',
      mode: g.mode,
    }));
  }

  acceptGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);

    // Enforce single active remote input / presenter at a time:
    for (const [existingIp, guest] of this.admittedGuests.entries()) {
      if (existingIp !== pending.remoteAddress) {
        try { guest.ws.close(1000, 'replaced by new connection'); } catch {}
      }
    }
    this.admittedGuests.clear();

    this.admittedGuests.set(pending.remoteAddress, {
      ws: pending.ws,
      remoteAddress: pending.remoteAddress,
      deviceName: pending.deviceName,
      mode: pending.mode,
    });
    try {
      pending.ws.send(JSON.stringify({ type: 'admitted', mode: pending.mode }));
    } catch {}
    this.emit('guestJoined', pending.remoteAddress, pending.deviceName, pending.mode);
    this.emit('rosterChanged');
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

  kickGuest(ip: string, reason: string = 'removed by host') {
    const cleanIp = ip.replace(/^::ffff:/, '');
    const guest = this.admittedGuests.get(cleanIp);
    if (!guest) return;
    this.admittedGuests.delete(cleanIp);
    try { guest.ws.close(1000, reason); } catch {}
    this.emit('guestLeft', cleanIp);
    this.emit('rosterChanged');
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
        const mode: InputMode = msg.mode === 'presenter' ? 'presenter' : 'touchpad';
        const trustInfo = this.isTrusted(peerCert.raw, remoteAddress);
        const deviceName = trustInfo.deviceName || (typeof msg.deviceName === 'string' ? msg.deviceName : (mode === 'presenter' ? 'Presenter' : 'Touchpad'));

        if (trustInfo.trusted) {
          // Trusted paired device: auto-admit without PIN confirmation
          for (const [existingIp, guest] of this.admittedGuests.entries()) {
            if (existingIp !== remoteAddress) {
              try { guest.ws.close(1000, 'replaced by new connection'); } catch {}
            }
          }
          this.admittedGuests.clear();

          this.admittedGuests.set(remoteAddress, { ws, remoteAddress, deviceName, mode });
          try {
            ws.send(JSON.stringify({ type: 'admitted', mode }));
          } catch {}
          this.emit('guestJoined', remoteAddress, deviceName, mode);
          this.emit('rosterChanged');
          return;
        }

        const pin = computeVerificationCode(this.myPublicKeyDer, peerPublicKeyDer);
        const timeout = setTimeout(() => {
          this.pendingGuests.delete(connId);
          try { ws.close(4006, 'confirmation timed out'); } catch {}
        }, GUEST_SESSION_CONFIRM_TIMEOUT_MS);

        this.pendingGuests.set(connId, { ws, pin, timeout, remoteAddress, deviceName, mode });
        try { ws.send(JSON.stringify({ type: 'pin', code: pin })); } catch {}
        this.emit('guestPinPending', connId, pin, remoteAddress, deviceName, mode);
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
        this.emit('rosterChanged');
      }
    });
  }
}
