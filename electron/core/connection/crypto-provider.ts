// Layer 1: Crypto & Identity Provider (Desktop)
// Encapsulates certificate generation, storage, fingerprint calculation, and modern TLS options.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as tls from 'tls';
import selfsigned from 'selfsigned';

interface TlsIdentity {
  certPem: string;
  keyPem: string;
  fingerprint: string;
}

interface ICryptoProvider {
  loadOrCreateIdentity(configDir: string, deviceId: string): TlsIdentity;
  computeFingerprint(certPem: string): string;
  createServerTlsOptions(identity: TlsIdentity): tls.TlsOptions;
  createClientTlsOptions(identity: TlsIdentity): tls.ConnectionOptions;
}

// Recommended modern TLS 1.2 & 1.3 AEAD cipher suites
export const MODERN_CIPHERS = [
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
].join(':');

class ModernCryptoProvider implements ICryptoProvider {
  loadOrCreateIdentity(configDir: string, deviceId: string): TlsIdentity {
    const certFile = path.join(configDir, 'cert.pem');
    const keyFile = path.join(configDir, 'key.pem');

    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      try {
        const certPem = fs.readFileSync(certFile, 'utf8');
        const keyPem = fs.readFileSync(keyFile, 'utf8');
        const fingerprint = this.computeFingerprint(certPem);
        return { certPem, keyPem, fingerprint };
      } catch {
        // If unreadable or corrupted, regenerate
      }
    }

    const attrs = [{ name: 'commonName', value: deviceId }];
    const pems = selfsigned.generate(attrs, {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
    });

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(certFile, pems.cert, 'utf8');
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });

    const fingerprint = this.computeFingerprint(pems.cert);
    return {
      certPem: pems.cert,
      keyPem: pems.private,
      fingerprint,
    };
  }

  computeFingerprint(certPem: string): string {
    const clean = certPem
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, '');
    const der = Buffer.from(clean, 'base64');
    return crypto.createHash('sha256').update(der).digest('hex');
  }

  extractPublicKeyDer(certPem: string): Buffer {
    const cert = new crypto.X509Certificate(certPem);
    return cert.publicKey.export({ type: 'spki', format: 'der' });
  }

  createServerTlsOptions(identity: TlsIdentity): tls.TlsOptions {
    return {
      cert: identity.certPem,
      key: identity.keyPem,
      requestCert: true,
      rejectUnauthorized: false, // Mutual TLS certificate verification is enforced via pinned SHA-256 fingerprint
      minVersion: 'TLSv1.2',
      ciphers: MODERN_CIPHERS,
    };
  }

  createClientTlsOptions(identity: TlsIdentity): tls.ConnectionOptions {
    return {
      cert: identity.certPem,
      key: identity.keyPem,
      rejectUnauthorized: false, // Pinned certificate fingerprint verification
      minVersion: 'TLSv1.2',
      ciphers: MODERN_CIPHERS,
    };
  }
}

export const defaultCryptoProvider = new ModernCryptoProvider();
