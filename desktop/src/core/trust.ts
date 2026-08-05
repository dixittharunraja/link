// Trust store — persists which devices are paired and their pinned certificates.

import * as fs from 'fs';
import * as path from 'path';

export interface TrustedDevice {
  deviceId: string;
  deviceName: string;
  certPem: string;
  protocolVersion: number;
  pairedAt: number;
  lastKnownIp?: string;
}

export class TrustStore {
  private file: string;
  private devices: Map<string, TrustedDevice>;

  constructor(private configDir: string) {
    this.file = path.join(configDir, 'trusted-devices.json');
    this.devices = this.load();
  }

  private load(): Map<string, TrustedDevice> {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file);
        // Try parsing as plain text JSON first for migration
        try {
          const arr: TrustedDevice[] = JSON.parse(raw.toString('utf8'));
          // Successfully parsed plain text, write it back encrypted to migrate
          this.devices = new Map(arr.map((d) => [d.deviceId, d]));
          this.persist();
          return this.devices;
        } catch {
          // If it fails to parse as plain JSON, it's encrypted. Decrypt it.
          const { safeStorage } = require('electron');
          if (safeStorage.isEncryptionAvailable()) {
            const decrypted = safeStorage.decryptString(raw);
            const arr: TrustedDevice[] = JSON.parse(decrypted);
            return new Map(arr.map((d) => [d.deviceId, d]));
          } else {
            console.error('[Link] safeStorage is not available but the file is encrypted');
          }
        }
      }
    } catch (e) {
      console.error('[Link] Failed to load trusted devices:', e);
    }
    return new Map();
  }

  private persist(): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    const jsonStr = JSON.stringify([...this.devices.values()], null, 2);
    try {
      const { safeStorage } = require('electron');
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(jsonStr);
        fs.writeFileSync(this.file, encrypted);
        return;
      }
    } catch (e) {
      console.error('[Link] safeStorage encryption failed, saving as plain text:', e);
    }
    fs.writeFileSync(this.file, jsonStr, 'utf8');
  }

  isPaired(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  get(deviceId: string): TrustedDevice | undefined {
    return this.devices.get(deviceId);
  }

  pair(device: TrustedDevice): void {
    this.devices.set(device.deviceId, device);
    this.persist();
  }

  /** Removes trust for a device. Must be called on BOTH the initiating and receiving side of an unpair. */
  unpair(deviceId: string): void {
    this.devices.delete(deviceId);
    this.persist();
  }

  list(): TrustedDevice[] {
    return [...this.devices.values()];
  }

  rename(deviceId: string, newName: string): void {
    const dev = this.devices.get(deviceId);
    if (dev) {
      dev.deviceName = newName;
      this.persist();
    }
  }

  updateLastKnownIp(deviceId: string, ip: string): void {
    const dev = this.devices.get(deviceId);
    if (dev && dev.lastKnownIp !== ip) {
      dev.lastKnownIp = ip;
      this.persist();
    }
  }
}
