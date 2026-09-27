"use strict";
// System volume plugin.
// Default playback device default sink only. Field names/shapes match protocol so the wire format
// itself is compatible.
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
exports.VolumeWatcher = exports.PACKET_TYPE_SYSTEMVOLUME_REQUEST = exports.PACKET_TYPE_SYSTEMVOLUME = void 0;
exports.createSystemVolumePacket = createSystemVolumePacket;
exports.isSystemVolumePacket = isSystemVolumePacket;
exports.isSystemVolumeRequestPacket = isSystemVolumeRequestPacket;
exports.createSetVolumeRequestPacket = createSetVolumeRequestPacket;
exports.createSetMuteRequestPacket = createSetMuteRequestPacket;
exports.queryVolumeList = queryVolumeList;
exports.setVolume = setVolume;
exports.setMuted = setMuted;
exports.handleSystemVolumeRequest = handleSystemVolumeRequest;
const child_process_1 = require("child_process");
const readline = __importStar(require("readline"));
const path = __importStar(require("path"));
const packet_1 = require("../packet");
exports.PACKET_TYPE_SYSTEMVOLUME = 'link.systemvolume';
exports.PACKET_TYPE_SYSTEMVOLUME_REQUEST = 'link.systemvolume.request';
const SINK_NAME = 'default';
const SINK_DESCRIPTION = 'System volume';
const MAX_VOLUME = 100;
function createSystemVolumePacket(sinks) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_SYSTEMVOLUME, {
        sinkList: sinks,
    });
}
function isSystemVolumePacket(packet) {
    return packet.type === exports.PACKET_TYPE_SYSTEMVOLUME;
}
function isSystemVolumeRequestPacket(packet) {
    return packet.type === exports.PACKET_TYPE_SYSTEMVOLUME_REQUEST;
}
function createSetVolumeRequestPacket(sinkName, volume) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_SYSTEMVOLUME_REQUEST, {
        name: sinkName,
        volume,
    });
}
function createSetMuteRequestPacket(sinkName, muted) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_SYSTEMVOLUME_REQUEST, {
        name: sinkName,
        muted,
    });
}
const SCRIPT_PATH = path.join(__dirname, '../../scripts/audio-endpoint-volume.ps1');
class PersistentVolumeRunner {
    process = null;
    reader = null;
    pendingResolvers = [];
    constructor() {
        this.start();
    }
    start() {
        if (process.platform === 'linux')
            return; // wpctl is called directly, no persistent REPL needed
        this.process = (0, child_process_1.spawn)('powershell', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            SCRIPT_PATH,
        ]);
        this.reader = readline.createInterface({
            input: this.process.stdout,
        });
        this.reader.on('line', (line) => {
            const resolver = this.pendingResolvers.shift();
            if (resolver) {
                resolver.resolve(line.trim());
            }
        });
        this.process.on('close', () => {
            this.process = null;
            this.reader = null;
            const resolvers = this.pendingResolvers;
            this.pendingResolvers = [];
            for (const r of resolvers) {
                r.reject(new Error('PowerShell volume runner exited unexpectedly'));
            }
        });
    }
    runCommand(cmd) {
        if (!this.process) {
            this.start();
        }
        return new Promise((resolve, reject) => {
            this.pendingResolvers.push({ resolve, reject });
            this.process.stdin.write(cmd + '\n');
        });
    }
}
const runner = new PersistentVolumeRunner();
function queryVolumeListLinux() {
    return new Promise((resolve) => {
        (0, child_process_1.exec)('wpctl get-volume @DEFAULT_AUDIO_SINK@', (err, stdout) => {
            if (err || !stdout.trim()) {
                resolve([]);
                return;
            }
            const match = stdout.match(/Volume: (\d+\.?\d*)( \[MUTED\])?/);
            if (!match) {
                resolve([]);
                return;
            }
            resolve([{
                    name: SINK_NAME,
                    description: SINK_DESCRIPTION,
                    volume: Math.round(parseFloat(match[1]) * 100),
                    muted: !!match[2],
                    maxVolume: MAX_VOLUME,
                    enabled: true,
                }]);
        });
    });
}
async function queryVolumeList() {
    if (process.platform === 'linux')
        return queryVolumeListLinux();
    try {
        const stdout = await runner.runCommand('get');
        const parsed = JSON.parse(stdout);
        if (!Array.isArray(parsed))
            return [];
        return parsed.map((item) => ({
            name: item.id,
            description: item.name,
            volume: item.volume,
            muted: item.muted,
            maxVolume: MAX_VOLUME,
            enabled: true,
        }));
    }
    catch (e) {
        console.error('[Link] Error querying volume list:', e);
        return [];
    }
}
async function setVolume(deviceId, volume) {
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    if (process.platform === 'linux') {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${v}%`, () => resolve());
        });
    }
    await runner.runCommand(`set-volume|${deviceId}|${v}`);
}
async function setMuted(deviceId, muted) {
    if (process.platform === 'linux') {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(`wpctl set-mute @DEFAULT_AUDIO_SINK@ ${muted ? 1 : 0}`, () => resolve());
        });
    }
    await runner.runCommand(`set-mute|${deviceId}|${muted ? 'true' : 'false'}`);
}
/** Applies an incoming phone request and returns the resulting state to broadcast back. */
async function handleSystemVolumeRequest(packet) {
    const body = packet.body;
    if (body.name) {
        if (typeof body.volume === 'number')
            await setVolume(body.name, body.volume);
        if (typeof body.muted === 'boolean')
            await setMuted(body.name, body.muted);
    }
    return queryVolumeList();
}
class VolumeWatcher {
    onChange;
    lastSinks = [];
    interval = null;
    // setInterval does not wait for an async callback, so a poll that outran the interval used to
    // let the next one start anyway. Each overlapping call queues another entry on the runner's
    // pendingResolvers list, which is matched to output strictly by line order — so a backlog both
    // grew without bound and desynced every later reply by one position.
    polling = false;
    constructor(onChange, pollIntervalMs = 2000) {
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
        const current = await queryVolumeList();
        if (current.length === 0)
            return;
        let changed = this.lastSinks.length !== current.length;
        if (!changed) {
            for (let i = 0; i < current.length; i++) {
                if (this.lastSinks[i].volume !== current[i].volume ||
                    this.lastSinks[i].muted !== current[i].muted ||
                    this.lastSinks[i].name !== current[i].name) {
                    changed = true;
                    break;
                }
            }
        }
        if (changed) {
            this.lastSinks = current;
            this.onChange(current);
        }
    }
    current() {
        return this.lastSinks;
    }
    stop() {
        if (this.interval)
            clearInterval(this.interval);
    }
}
exports.VolumeWatcher = VolumeWatcher;
//# sourceMappingURL=systemvolume.js.map