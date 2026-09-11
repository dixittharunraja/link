import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { certFingerprint } from './tls';

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
        try {
          const arr: TrustedDevice[] = JSON.parse(raw.toString('utf8'));
          // Migrate plain text to encrypted.
          this.devices = new Map(arr.map((d) => [d.deviceId, d]));
          this.persist();
          return this.devices;
        } catch {
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

  computePoolHash(): string {
    const sorted = [...this.devices.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    const canonical = sorted
      .map((d) => `${d.deviceId}:${certFingerprint(d.certPem)}`)
      .join('|');
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').substring(0, 16);
  }
}

