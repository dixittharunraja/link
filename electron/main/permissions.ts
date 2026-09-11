// Per-device permission store (device-permissions.json).

import * as fs from 'fs';
import * as path from 'path';
import { DeviceManager } from '../core/device-manager';
import { createCapabilitiesPacket } from '../core/plugins/capabilities';
import { ALL_PERMISSION_KEYS, GATED_CAPABILITY_KEYS } from './capabilities-schema';

let configDir: string;
let deviceManager: DeviceManager;

export function initPermissions(dir: string, dm: DeviceManager) {
  configDir = dir;
  deviceManager = dm;
}

function permissionsFilePath(): string {
  return path.join(configDir, 'device-permissions.json');
}

// In-memory cache (avoids repeated fs reads on hot-path checks).
let permissionsCache: Record<string, Record<string, boolean | string>> | null = null;

export function getAllPermissions(): Record<string, Record<string, boolean | string>> {
  if (permissionsCache !== null) return permissionsCache;
  try {
    const p = permissionsFilePath();
    if (fs.existsSync(p)) {
      permissionsCache = JSON.parse(fs.readFileSync(p, 'utf8'));
      return permissionsCache!;
    }
  } catch (err) {
    console.error('[Link] Failed to read permissions:', err);
  }
  permissionsCache = {};
  return permissionsCache;
}

export function writeAllPermissions(data: Record<string, Record<string, boolean | string>>) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(permissionsFilePath(), JSON.stringify(data, null, 2), 'utf8');
  permissionsCache = data;
}

export function checkDevicePermission(deviceId: string, permKey: string): boolean {
  try {
    const data = getAllPermissions();
    const devPerms = data[deviceId];
    if (devPerms && devPerms[permKey] !== undefined) {
      return devPerms[permKey] as boolean;
    }
  } catch (err) {
    console.error('[Link] Failed to check device permission:', err);
  }
  return false; // default to false (denied/off)
}

export function deletePermissionsForDevice(deviceId: string) {
  try {
    const allPermissions = getAllPermissions();
    if (allPermissions[deviceId]) {
      delete allPermissions[deviceId];
      writeAllPermissions(allPermissions);
      console.log(`[Link] Deleted all stored permissions for device ${deviceId.slice(0, 8)}`);
    }
  } catch (err) {
    console.error('[Link] Failed to delete permissions for device:', err);
  }
}

// ALL_PERMISSION_KEYS is now imported from capabilities-schema.ts — see that file for the
// authoritative list. Used here only to seed a brand-new pairing with everything OFF by default
// (see initializeDeniedPermissionsForNewDevice). checkDevicePermission()'s own "unset means
// allowed" default above is left untouched for already-paired devices predating this change, so
// it doesn't retroactively lock out anyone who already granted things — this only affects
// devices paired from this point forward.

// Called once, right when a NEW pairing completes (not on ordinary reconnects of an already-
// trusted device — see device-manager.ts's pairingSuccessful, which only fires for the actual
// pairing handshake). Writes an explicit all-denied permissions record for that device, so the
// user has to deliberately opt each permission in via the Permissions dialog rather than every
// gated feature being silently available by default the moment a new device pairs.
export function initializeDeniedPermissionsForNewDevice(deviceId: string) {
  try {
    const allPermissions = getAllPermissions();
    const denied: Record<string, boolean | string> = {};
    for (const key of ALL_PERMISSION_KEYS) denied[key] = false;
    allPermissions[deviceId] = denied;
    writeAllPermissions(allPermissions);
  } catch (err) {
    console.error('[Link] Failed to initialize default-denied permissions for new device:', err);
  }
}

// GATED_CAPABILITY_KEYS is now imported from capabilities-schema.ts. See that file for the
// list of per-device-gated capability keys THIS device (desktop) itself executes/broadcasts.

function computeEffectiveCapabilities(deviceId: string): string[] {
  return GATED_CAPABILITY_KEYS.filter((key) => checkDevicePermission(deviceId, key));
}

export function pushEffectiveCapabilities(deviceId: string) {
  deviceManager.sendTo(deviceId, createCapabilitiesPacket(computeEffectiveCapabilities(deviceId)));
}

// Clipboard is sending-only, like Telephony/Notification/Flashlight/DND: this device owns its
// own clipboard, so its permission-for-a-peer only controls whether ITS clipboard gets sent to
// that peer. Receiving a peer's clipboard is never gated here — that's controlled entirely by
// THEIR permission-for-us on their own device, not by anything on this side.
export function canSendClipboardTo(deviceId: string): boolean {
  return checkDevicePermission(deviceId, 'clipboard');
}
