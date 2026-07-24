// Payload transfer — core mechanism used by any plugin that moves bytes rather than just JSON
// (share, link.clipboard.file). Ported from the *mechanism* in kdeconnect-kde's
// core/backends/lan/uploadjob.h: the sender opens a brand-new, one-shot TLS server just for this
// transfer, embeds its port in the packet's `payloadTransferInfo`, and the receiver dials in on a
// separate connection to pull the bytes. See docs/PROTOCOL.md §2 and the deferred-scope note for
// link.clipboard.file.
//
// One deliberate strengthening over the minimal port of the mechanism: since this is a SEPARATE
// TLS connection from the main paired control channel, we verify the peer's certificate on it
// matches the fingerprint already pinned for that device — otherwise a payload connection would
// be trusted less carefully than the control channel it was announced over.
//
// KDE Connect uses a fixed port range (1739-1764) for firewall-rule friendliness; we use OS-
// assigned ephemeral ports (`port: 0`) instead — simpler, and firewall rules aren't a concern for
// this phase.

import * as tls from 'tls';
import * as crypto from 'crypto';

export interface PayloadTransferInfo {
  port: number;
}

export interface UploadHandle {
  info: PayloadTransferInfo;
  /** Resolves once the (single) accepted connection has finished receiving the data, or rejects on error/timeout. */
  done: Promise<void>;
  /** Closes the upload server early (e.g. if the receiver never connects). */
  cancel: () => void;
}

/** Starts a one-shot TLS server that accepts exactly one connection, streams `data`, then closes. */
export function startPayloadUpload(cert: string, key: string, data: Buffer, timeoutMs = 30000): Promise<UploadHandle> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = tls.createServer({ cert, key, rejectUnauthorized: false });

    const timeout = setTimeout(() => {
      if (!settled) {
        server.close();
        reject(new Error('Timed out waiting for receiver to connect for payload upload'));
      }
    }, timeoutMs);

    server.on('error', (err) => {
      if (!settled) reject(err);
    });

    server.on('connection', (socket) => {
      clearTimeout(timeout);
      socket.on('error', () => {}); // swallow socket errors to prevent app crash
    });

    server.on('secureConnection', (socket) => {
      // Stream in 64 KB chunks so the TLS stack can fill the TCP send window
      // continuously rather than blocking on one giant write syscall.
      const CHUNK = 65536;
      let offset = 0;
      function writeNext() {
        while (offset < data.length) {
          const end = Math.min(offset + CHUNK, data.length);
          const slice = data.slice(offset, end);
          offset = end;
          const more = socket.write(slice);
          if (!more) {
            // Back-pressure: wait for drain before writing more
            socket.once('drain', writeNext);
            return;
          }
        }
        socket.end();
      }
      writeNext();
    });

    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to determine upload server port'));
        return;
      }
      settled = true;

      const done = new Promise<void>((res, rej) => {
        server.on('close', () => res());
        server.on('error', (err) => rej(err));
      });

      resolve({
        info: { port: address.port },
        done,
        cancel: () => server.close(),
      });
    });
  });
}

/**
 * Connects to a peer's ephemeral upload server (from a received `payloadTransferInfo`) and
 * downloads the full payload. `expectedPeerFingerprint` must match the SHA-256 fingerprint
 * already pinned for that device — this is a fresh TLS connection, not automatically covered by
 * the main control channel's established trust.
 */
export function downloadPayload(
  host: string,
  port: number,
  cert: string,
  key: string,
  expectedPeerFingerprint: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = tls.connect({ host, port, cert, key, rejectUnauthorized: false }, () => {
      const peerCert = socket.getPeerCertificate();
      if (!peerCert || !peerCert.raw) {
        socket.destroy();
        reject(new Error('Payload connection presented no certificate'));
        return;
      }
      const actualFingerprint = crypto.createHash('sha256').update(peerCert.raw).digest('hex');
      if (actualFingerprint !== expectedPeerFingerprint) {
        socket.destroy();
        reject(new Error('Payload connection certificate does not match pinned device — refusing transfer'));
        return;
      }
    });

    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
  });
}
