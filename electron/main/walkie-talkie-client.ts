// Walkie Talkie — guest-side signaling client. Connects to a WalkieTalkieServer by manual
// IP, computes the same PIN the host does (independently, from both sides' TLS certs — see
// audio-relay-client.ts's identical reasoning for why that's preferred over trusting a
// server-supplied value), and once admitted, carries the same opaque {type, body} signaling
// messages WalkieTalkieTab.tsx already speaks over the trusted-mesh relay for paired devices.

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { computeVerificationCode } from '../core/pairing';

import { normalizeHost } from '../core/transport';

export class WalkieTalkieClient extends EventEmitter {
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

  connect(): void {
    const host = normalizeHost(this.host);
    const url = `wss://${host}:${this.port}`;
    this.ws = new WebSocket(url, {
      rejectUnauthorized: false, // self-signed peer, verified at the app layer (PIN) not here
      handshakeTimeout: 15000,
      cert: this.clientCert,
      key: this.clientKey,
    });

    this.ws.on('open', () => {
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
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'admitted') this.emit('admitted');
      else if (msg.type === 'pin' && !this.pinComputedLocally) this.emit('pinComputed', msg.code);
      else this.emit('signal', msg.type, msg.body);
    });

    this.ws.on('close', (code, reason) => {
      if (code === 1000 || code === 1001) {
        // Passing the reason through lets callers tell a graceful session end apart from the
        // coordinator kicking just this guest (reason 'removed by host', same normal-closure code)
        // — see audio-sink-client.ts's onWsClose for the identical distinction/reasoning.
        this.emit('ended', reason?.toString());
      } else {
        this.emit('closed', reason?.toString() || `code ${code}`);
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  send(type: string, body: any) {
    try { this.ws?.send(JSON.stringify({ type, body })); } catch {}
  }

  disconnect() {
    try { this.ws?.close(1000, 'left'); } catch {}
    this.ws = null;
  }
}
