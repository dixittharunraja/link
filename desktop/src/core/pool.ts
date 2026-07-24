// Trusted Pool — owner-key engine (Wave 2 of the Trusted Pool transformation; see docs/backlog.txt).
//
// The pool is the set of the owner's OWN devices, all mutually trusted. Trust flows through a
// single shared OWNER KEY (a per-person Ed25519 root of trust), NOT peer-to-peer / transitively.
// Every full member holds the owner PRIVATE key, so a new device can join by pairing with ANY
// existing member (one PIN, the human gate), which then hands over the owner key and issues the
// newcomer an owner-signed MEMBERSHIP CERT binding its TLS identity to the pool. Any other member
// then auto-trusts it by verifying that cert against the owner PUBLIC key it already holds — no
// second PIN.
//
// This module is the pure crypto/storage core: keygen, storage, fingerprints, and membership-cert
// issue/verify. It has NO knowledge of connections/pairing — device-manager.ts wires it in. It is
// deliberately mirrored 1:1 by Android's LinkPool.java; the signed-message format below
// (buildMembershipMessage) is defined as an explicit UTF-8 byte layout (NOT JSON key ordering) so
// both platforms sign/verify the exact same bytes, the same discipline computeVerificationCode /
// LinkVerification already use.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Domain-separation prefixes baked into every signed message, so an owner-key signature can never
// be replayed as a different kind of signature. Bump a version suffix only on a breaking change to
// that signed layout. MUST stay identical to LinkPool.java's constants.
const MEMBERSHIP_MSG_PREFIX = 'link-pool-membership-v1';
const REVOCATION_MSG_PREFIX = 'link-pool-revocation-v1';

// Pool control packet types (sent over an already-trusted connection). Intercepted by
// device-manager.ts, never surfaced as ordinary feature packets. Mirror LinkPool.java.
export const PACKET_TYPE_POOL_ENROLL = 'link.pool.enroll';
export const PACKET_TYPE_POOL_REVOKE = 'link.pool.revoke';

export interface OwnerKeyPair {
  /** SPKI DER of the Ed25519 public key, base64 — the portable, cross-platform public-key form. */
  publicKeyDerB64: string;
  /** PKCS8 DER of the Ed25519 private key, base64. Held by every full member (see module header). */
  privateKeyDerB64: string;
}

export interface MembershipCert {
  deviceId: string;
  /** SHA-256 hex of the member device's pinned TLS certificate (DER). Binds the cert to the pool. */
  certFingerprint: string;
  /** Fingerprint of the owner key that signed this — lets a verifier confirm "same pool as me". */
  ownerKeyFingerprint: string;
  issuedAt: number;
  /** Owner-key epoch; reserved for revocation/re-key (item 9). Always 1 for now. */
  epoch: number;
  /** Ed25519 signature over buildMembershipMessage(...), base64. */
  signature: string;
}

// ----- Key generation / storage -----

/** Generates a fresh Ed25519 owner keypair, exported in the portable SPKI/PKCS8 DER (base64) form. */
export function generateOwnerKeyPair(): OwnerKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyDerB64: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    privateKeyDerB64: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
  };
}

/** SHA-256 hex of the owner public key's SPKI DER — the stable id a verifier uses to say "same pool". */
export function ownerKeyFingerprint(publicKeyDerB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(publicKeyDerB64, 'base64')).digest('hex');
}

interface StoredCredentials {
  owner: OwnerKeyPair;
  /** This device's OWN membership cert (what it advertises to prove it's in the pool). */
  membership: MembershipCert;
}

/**
 * This device's pool credentials — the shared owner keypair AND this device's own membership cert.
 * Kept alongside the TLS key (itself a plaintext 0600 PEM today), so this matches the existing
 * on-disk posture rather than inventing a half-measure. Real encryption-at-rest (OS keystore /
 * pool passphrase) is tracked separately as hardening — storing this plaintext is not a regression
 * relative to key.pem already being plaintext.
 */
export class OwnerKeyStore {
  private file: string;
  private cached: StoredCredentials | null = null;

  constructor(configDir: string) {
    this.file = path.join(configDir, 'owner-key.json');
    this.cached = this.load();
  }

  private load(): StoredCredentials | null {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && parsed.owner?.publicKeyDerB64 && parsed.owner?.privateKeyDerB64 && parsed.membership) {
          return parsed;
        }
      }
    } catch {
      // Corrupt — treat as "no pool yet". Re-enrolling is the recovery path.
    }
    return null;
  }

  /** True if this device belongs to a pool (holds an owner key + membership). */
  hasKey(): boolean {
    return this.cached !== null;
  }

  get(): OwnerKeyPair | null {
    return this.cached ? this.cached.owner : null;
  }

  getMembership(): MembershipCert | null {
    return this.cached ? this.cached.membership : null;
  }

  fingerprint(): string | null {
    return this.cached ? ownerKeyFingerprint(this.cached.owner.publicKeyDerB64) : null;
  }

  setCredentials(owner: OwnerKeyPair, membership: MembershipCert): void {
    this.cached = { owner, membership };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cached, null, 2), { mode: 0o600 });
  }

  /** Leaving the pool: wipe our copy of the owner key + membership so we're no longer a member. */
  clear(): void {
    this.cached = null;
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
  }
}

// ----- Revocation (item 9): owner-signed "device X is out", gossiped across the pool -----

export interface Revocation {
  deviceId: string;
  revokedAt: number;
  /** Ed25519 signature over buildRevocationMessage(...), base64. Provable by any pool member. */
  signature: string;
}

export function buildRevocationMessage(deviceId: string, revokedAt: number): Buffer {
  return Buffer.from([REVOCATION_MSG_PREFIX, deviceId, String(revokedAt)].join('\n'), 'utf8');
}

export function signRevocation(owner: OwnerKeyPair, deviceId: string): Revocation {
  const revokedAt = Date.now();
  const message = buildRevocationMessage(deviceId, revokedAt);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(owner.privateKeyDerB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return { deviceId, revokedAt, signature: crypto.sign(null, message, privateKey).toString('base64') };
}

export function verifyRevocation(rev: Revocation, ownerPublicKeyDerB64: string): boolean {
  try {
    const message = buildRevocationMessage(rev.deviceId, rev.revokedAt);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(ownerPublicKeyDerB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, message, publicKey, Buffer.from(rev.signature, 'base64'));
  } catch {
    return false;
  }
}

/** Persistent set of revoked deviceIds — checked before auto-trusting, so a revoked device can't
 *  re-mesh even at an offline member that only just learned of the revocation. */
export class RevocationStore {
  private file: string;
  private revoked = new Map<string, Revocation>();

  constructor(configDir: string) {
    this.file = path.join(configDir, 'revoked-devices.json');
    try {
      if (fs.existsSync(this.file)) {
        const arr: Revocation[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const r of arr) this.revoked.set(r.deviceId, r);
      }
    } catch { /* start empty */ }
  }

  has(deviceId: string): boolean {
    return this.revoked.has(deviceId);
  }

  /** Records a revocation (idempotent). Returns true if it was new (so the caller knows to gossip). */
  add(rev: Revocation): boolean {
    if (this.revoked.has(rev.deviceId)) return false;
    this.revoked.set(rev.deviceId, rev);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.revoked.values()], null, 2));
    return true;
  }

  all(): Revocation[] {
    return [...this.revoked.values()];
  }
}

// ----- Membership certificates -----

/**
 * The exact bytes signed for a membership cert. Explicit UTF-8 field concatenation (NOT JSON) so
 * Android's LinkPool.buildMembershipMessage() can reproduce it identically — any drift here breaks
 * cross-platform verification silently, so keep the two in lockstep.
 */
export function buildMembershipMessage(
  deviceId: string,
  certFingerprint: string,
  ownerKeyFp: string,
  issuedAt: number,
  epoch: number
): Buffer {
  return Buffer.from(
    [MEMBERSHIP_MSG_PREFIX, deviceId, certFingerprint, ownerKeyFp, String(issuedAt), String(epoch)].join('\n'),
    'utf8'
  );
}

/**
 * Issue a membership cert for `deviceId` (whose pinned TLS cert fingerprint is `certFingerprint`),
 * signed by our owner private key. Called by a pool member enrolling a freshly-paired newcomer.
 */
export function issueMembershipCert(
  owner: OwnerKeyPair,
  deviceId: string,
  certFingerprint: string,
  epoch = 1
): MembershipCert {
  const ownerKeyFp = ownerKeyFingerprint(owner.publicKeyDerB64);
  const issuedAt = Date.now();
  const message = buildMembershipMessage(deviceId, certFingerprint, ownerKeyFp, issuedAt, epoch);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(owner.privateKeyDerB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  // Ed25519 signs the message directly (no pre-hash) — pass null as the algorithm.
  const signature = crypto.sign(null, message, privateKey).toString('base64');
  return { deviceId, certFingerprint, ownerKeyFingerprint: ownerKeyFp, issuedAt, epoch, signature };
}

/**
 * Verify that `cert` was signed by the owner key whose public half is `ownerPublicKeyDerB64`, AND
 * that it actually binds the given deviceId + TLS cert fingerprint. Returns true only if EVERY
 * check passes — a verifier must additionally confirm ownerKeyFingerprint matches its OWN pool
 * (see device-manager) before auto-trusting.
 */
export function verifyMembershipCert(
  cert: MembershipCert,
  ownerPublicKeyDerB64: string,
  expectedDeviceId: string,
  expectedCertFingerprint: string
): boolean {
  try {
    if (cert.deviceId !== expectedDeviceId) return false;
    if (cert.certFingerprint !== expectedCertFingerprint) return false;
    if (cert.ownerKeyFingerprint !== ownerKeyFingerprint(ownerPublicKeyDerB64)) return false;

    const message = buildMembershipMessage(
      cert.deviceId,
      cert.certFingerprint,
      cert.ownerKeyFingerprint,
      cert.issuedAt,
      cert.epoch
    );
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(ownerPublicKeyDerB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, message, publicKey, Buffer.from(cert.signature, 'base64'));
  } catch {
    return false;
  }
}
