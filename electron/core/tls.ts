// TLS identity — self-signed certificate (generated once per device, reused forever).

import { defaultCryptoProvider } from './connection/crypto-provider';

export interface TlsIdentity {
  cert: string; // PEM
  key: string; // PEM
}

export function loadOrCreateTlsIdentity(configDir: string, deviceId: string): TlsIdentity {
  const identity = defaultCryptoProvider.loadOrCreateIdentity(configDir, deviceId);
  return {
    cert: identity.certPem,
    key: identity.keyPem,
  };
}

export function certFingerprint(pem: string): string {
  return defaultCryptoProvider.computeFingerprint(pem);
}

export function extractPublicKeyDer(certPem: string): Buffer {
  return defaultCryptoProvider.extractPublicKeyDer(certPem);
}


