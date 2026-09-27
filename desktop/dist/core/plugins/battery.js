"use strict";
// Battery plugin.
// Body fields (isCharging, currentCharge, batteryQuantity, thresholdEvent) match protocol.
// Node has no built-in battery API, so we poll via PowerShell/WMI (Win32_Battery).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatteryWatcher = exports.PACKET_TYPE_BATTERY = void 0;
exports.createBatteryPacket = createBatteryPacket;
exports.isBatteryPacket = isBatteryPacket;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const packet_1 = require("../packet");
exports.PACKET_TYPE_BATTERY = 'link.battery';
const THRESHOLD_NONE = 0;
const THRESHOLD_BATTERY_LOW = 1;
const LOW_BATTERY_PERCENT = 15; // matches upstream's hardcoded 15% cutoff
function createBatteryPacket(isCharging, currentCharge) {
    const thresholdEvent = currentCharge <= LOW_BATTERY_PERCENT && !isCharging ? THRESHOLD_BATTERY_LOW : THRESHOLD_NONE;
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_BATTERY, {
        isCharging,
        currentCharge,
        batteryQuantity: 1,
        thresholdEvent,
    });
}
function isBatteryPacket(packet) {
    return packet.type === exports.PACKET_TYPE_BATTERY;
}
function queryBatteryLinux() {
    return (async () => {
        try {
            const powerSupplyDir = '/sys/class/power_supply';
            const supplies = await fs.promises.readdir(powerSupplyDir);
            const batDir = supplies.find((dir) => dir.startsWith('BAT'));
            if (!batDir)
                return null; // no battery hardware (desktop PC)
            const capacityStr = await fs.promises.readFile(path.join(powerSupplyDir, batDir, 'capacity'), 'utf-8');
            const statusStr = await fs.promises.readFile(path.join(powerSupplyDir, batDir, 'status'), 'utf-8');
            const currentCharge = parseInt(capacityStr.trim(), 10);
            if (isNaN(currentCharge))
                return null;
            const isCharging = statusStr.trim() === 'Charging' || statusStr.trim() === 'Full';
            return { isCharging, currentCharge };
        }
        catch {
            return null;
        }
    })();
}
function queryBattery() {
    if (process.platform === 'linux')
        return queryBatteryLinux();
    return new Promise((resolve) => {
        (0, child_process_1.exec)('powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json"', { timeout: 5000 }, (err, stdout) => {
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
            }
            catch {
                resolve(null);
            }
        });
    });
}
class BatteryWatcher {
    onChange;
    lastSnapshot = null;
    interval = null;
    // Each poll spawns a PowerShell process; setInterval won't wait for the async callback, so a
    // probe that outlives its interval would let probes stack up rather than skip a beat.
    polling = false;
    constructor(onChange, pollIntervalMs = 30000) {
        this.onChange = onChange;
        this.poll();
        this.interval = setInterval(() => this.poll(), pollIntervalMs);
    }
    async poll() {
        if (this.polling)
            return;
        this.polling = true;
        try {
            await this.pollOnce();
        }
        finally {
            this.polling = false;
        }
    }
    async pollOnce() {
        const current = await queryBattery();
        if (!current)
            return; // no battery on this machine
        if (!this.lastSnapshot ||
            this.lastSnapshot.isCharging !== current.isCharging ||
            this.lastSnapshot.currentCharge !== current.currentCharge) {
            this.lastSnapshot = current;
            this.onChange(current);
        }
    }
    /** Current known snapshot, for sending immediately on a fresh pairing (matches upstream's connected() -> explicit send). */
    current() {
        return this.lastSnapshot;
    }
    stop() {
        if (this.interval)
            clearInterval(this.interval);
    }
}
exports.BatteryWatcher = BatteryWatcher;
//# sourceMappingURL=battery.js.map