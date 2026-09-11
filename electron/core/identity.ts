// Device identity — single source of truth for deviceId generation/persistence.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

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

const PROTOCOL_VERSION = 1;

const NAME_INVALID_CHARS = /["',;:.!?()[\]<>]/g;
const MAX_NAME_LENGTH = 32;

function filterDeviceName(input: string): string {
  return input.replace(NAME_INVALID_CHARS, '').slice(0, MAX_NAME_LENGTH);
}

function isValidDeviceId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{32,38}$/.test(id);
}

function generateDeviceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

interface StoredIdentity {
  deviceId: string;
  deviceName: string;
}

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
    // Corrupt file — regenerate identity.
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

export function saveDeviceName(configDir: string, newName: string): string {
  const identityFile = path.join(configDir, 'identity.json');
  const filtered = filterDeviceName(newName);

  const raw = fs.readFileSync(identityFile, 'utf8');
  const stored: StoredIdentity = JSON.parse(raw);
  stored.deviceName = filtered;
  fs.writeFileSync(identityFile, JSON.stringify(stored, null, 2));

  return filtered;
}
