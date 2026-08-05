// Device identity — one per device, generated once, persisted forever.
//
// Architectural rule (see docs/PROTOCOL.md §4): this is the ONE place identity is generated or
// loaded from disk. Every other part of the app (transport, pairing, UI) reads it from here —
// nothing else is allowed to mint its own deviceId.


import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

// Only 'desktop', 'phone', and 'tv' are ever actually produced at runtime — desktop's own
// identity creation hardcodes 'desktop' (main.ts), and Android's detectDeviceType() only ever
// returns 'tv' (Android TV) or 'phone' (everything else, no tablet auto-detection exists).
export type DeviceType = 'desktop' | 'phone' | 'tv';

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
  protocolVersion: number;
  incomingCapabilities: string[];
  outgoingCapabilities: string[];
  visibility?: boolean;
}

export const PROTOCOL_VERSION = 1;

const NAME_INVALID_CHARS = /["',;:.!?()[\]<>]/g;
const MAX_NAME_LENGTH = 32;

export function filterDeviceName(input: string): string {
  return input.replace(NAME_INVALID_CHARS, '').slice(0, MAX_NAME_LENGTH);
}

export function isValidDeviceId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{32,38}$/.test(id);
}

function generateDeviceId(): string {
  // 32 hex chars — comfortably inside KDE Connect's 32-38 char allowed range.
  return crypto.randomBytes(16).toString('hex');
}

interface StoredIdentity {
  deviceId: string;
  deviceName: string;
}

/**
 * Loads this device's persistent identity from `configDir/identity.json`, creating it (with a
 * freshly generated deviceId) if it doesn't exist yet. `configDir` is provided by the caller
 * (the Electron main process) so this module stays platform-agnostic and testable.
 */
export function loadOrCreateIdentity(configDir: string, deviceType: DeviceType, capabilities: {
  incoming: string[];
  outgoing: string[];
}): DeviceIdentity {
  const identityFile = path.join(configDir, 'identity.json');

  let stored: StoredIdentity | null = null;
  try {
    if (fs.existsSync(identityFile)) {
      const parsed = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (parsed && isValidDeviceId(parsed.deviceId)) {
        stored = parsed;
      }
    }
  } catch {
    // Corrupt file — fall through and regenerate. Losing an identity means losing all existing
    // pairings (they're keyed by deviceId + pinned cert), but a corrupt file is not recoverable.
  }

  if (!stored) {
    stored = {
      deviceId: generateDeviceId(),
      deviceName: filterDeviceName(os.hostname() || 'My PC'),
    };
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(identityFile, JSON.stringify(stored, null, 2));
  }

  return {
    deviceId: stored.deviceId,
    deviceName: stored.deviceName,
    deviceType,
    protocolVersion: PROTOCOL_VERSION,
    incomingCapabilities: capabilities.incoming,
    outgoingCapabilities: capabilities.outgoing,
  };
}

/** Persists a new device name. Does NOT touch deviceId — renaming never regenerates identity. */
export function saveDeviceName(configDir: string, newName: string): string {
  const identityFile = path.join(configDir, 'identity.json');
  const filtered = filterDeviceName(newName);

  let stored: StoredIdentity;
  const raw = fs.readFileSync(identityFile, 'utf8');
  stored = JSON.parse(raw);
  stored.deviceName = filtered;
  fs.writeFileSync(identityFile, JSON.stringify(stored, null, 2));

  return filtered;
}
