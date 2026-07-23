// Trust store — persists which devices are paired and their pinned certificates.
// Ported from kdeconnect-kde's KdeConnectConfig trusted-devices storage.

import * as fs from 'fs';
import * as path from 'path';

export interface TrustedDevice {
  deviceId: string;
  deviceName: string;
  certPem: string;
  protocolVersion: number;
  pairedAt: number;
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
        const arr: TrustedDevice[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        return new Map(arr.map((d) => [d.deviceId, d]));
      }
    } catch {
      // Corrupt file — start fresh rather than crash. Existing pairings would need to be redone.
    }
    return new Map();
  }

  private persist(): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.devices.values()], null, 2));
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
}
