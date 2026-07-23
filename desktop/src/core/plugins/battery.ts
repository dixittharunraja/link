// Battery plugin — faithful port of kdeconnect-kde's plugins/battery/batteryplugin.cpp.
// Body fields (isCharging, currentCharge, batteryQuantity, thresholdEvent) match upstream
// exactly. Node has no built-in battery API, so we poll via PowerShell/WMI (Win32_Battery) —
// upstream uses Solid's OS-level chargeStateChanged/chargePercentChanged signals directly;
// polling is the closest equivalent available to us on this platform.

import { exec } from 'child_process';
import { LinkPacket, createPacket } from '../packet';

export const PACKET_TYPE_BATTERY = 'link.battery';

const THRESHOLD_NONE = 0;
const THRESHOLD_BATTERY_LOW = 1;
const LOW_BATTERY_PERCENT = 15; // matches upstream's hardcoded 15% cutoff

interface BatteryBody {
  isCharging: boolean;
  currentCharge: number;
  batteryQuantity: number;
  thresholdEvent: number;
}

export function createBatteryPacket(isCharging: boolean, currentCharge: number): LinkPacket<BatteryBody> {
  const thresholdEvent = currentCharge <= LOW_BATTERY_PERCENT && !isCharging ? THRESHOLD_BATTERY_LOW : THRESHOLD_NONE;
  return createPacket(PACKET_TYPE_BATTERY, {
    isCharging,
    currentCharge,
    batteryQuantity: 1,
    thresholdEvent,
  });
}

export function isBatteryPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_BATTERY;
}

interface BatterySnapshot {
  isCharging: boolean;
  currentCharge: number;
}

function queryBattery(): Promise<BatterySnapshot | null> {
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json"',
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null); // no battery hardware (desktop PC) — matches upstream's hasBattery() = false
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const charge = parsed.EstimatedChargeRemaining;
          const status = parsed.BatteryStatus;
          if (typeof charge !== 'number' || typeof status !== 'number') {
            resolve(null);
            return;
          }
          // Win32_Battery.BatteryStatus: 6/7/8/9 = charging variants, everything else isn't.
          const isCharging = [6, 7, 8, 9].includes(status);
          resolve({ isCharging, currentCharge: charge });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

export class BatteryWatcher {
  private lastSnapshot: BatterySnapshot | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(private onChange: (snapshot: BatterySnapshot) => void, pollIntervalMs = 30000) {
    this.poll();
    this.interval = setInterval(() => this.poll(), pollIntervalMs);
  }

  private async poll() {
    const current = await queryBattery();
    if (!current) return; // no battery on this machine

    if (
      !this.lastSnapshot ||
      this.lastSnapshot.isCharging !== current.isCharging ||
      this.lastSnapshot.currentCharge !== current.currentCharge
    ) {
      this.lastSnapshot = current;
      this.onChange(current);
    }
  }

  /** Current known snapshot, for sending immediately on a fresh pairing (matches upstream's connected() -> explicit send). */
  current(): BatterySnapshot | null {
    return this.lastSnapshot;
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }
}
