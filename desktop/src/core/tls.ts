// TLS identity — self-signed certificate generated once per device, reused forever.
//
// Trust model (docs/PROTOCOL.md §5):
//   - Unpaired connections: no peer verification, just get the socket up for pairing.
//   - Paired connections: verify the peer's cert matches exactly the one pinned at pairing time.
// Regenerating this device's own cert invalidates every existing pairing, since peer trust is
// bound to the specific certificate, not just the deviceId.

import * as fs from 'fs';
import * as path from 'path';
import selfsigned from 'selfsigned';

export interface TlsIdentity {
  cert: string; // PEM
  key: string; // PEM
}

/**
 * Loads this device's TLS cert+key from `configDir`, generating a new self-signed pair (valid
 * ~10 years) if none exists yet.
 */
export function loadOrCreateTlsIdentity(configDir: string, deviceId: string): TlsIdentity {
  const certFile = path.join(configDir, 'cert.pem');
  const keyFile = path.join(configDir, 'key.pem');

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return {
      cert: fs.readFileSync(certFile, 'utf8'),
      key: fs.readFileSync(keyFile, 'utf8'),
    };
  }

  const attrs = [{ name: 'commonName', value: deviceId }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
  });

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });

  return { cert: pems.cert, key: pems.private };
}

/** SHA-256 fingerprint of a PEM certificate, as a hex string — used for the pairing verification key. */
export function certFingerprint(pem: string): string {
  const crypto = require('crypto');
  const der = pemToDer(pem);
  return crypto.createHash('sha256').update(der).digest('hex');
}

function pemToDer(pem: string): Buffer {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(base64, 'base64');
}
