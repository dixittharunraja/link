// System volume plugin.
// Default playback device default sink only. Field names/shapes match protocol so the wire format
// itself is compatible.

import { spawn } from 'child_process';
import * as readline from 'readline';
import { LinkPacket, createPacket } from '../packet';
import { resolveScriptPath } from '../script-path';

const PACKET_TYPE_SYSTEMVOLUME = 'link.systemvolume';
const PACKET_TYPE_SYSTEMVOLUME_REQUEST = 'link.systemvolume.request';

const MAX_VOLUME = 100;

interface SinkState {
  name: string;
  description: string;
  volume: number;
  muted: boolean;
  maxVolume: number;
  enabled: boolean;
}

interface SystemVolumeBody {
  sinkList: SinkState[];
}

interface SystemVolumeRequestBody {
  requestSinks?: boolean;
  name?: string;
  volume?: number;
  muted?: boolean;
}

export function createSystemVolumePacket(sinks: SinkState[]): LinkPacket<SystemVolumeBody> {
  return createPacket(PACKET_TYPE_SYSTEMVOLUME, {
    sinkList: sinks,
  });
}

export function isSystemVolumePacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_SYSTEMVOLUME;
}

export function isSystemVolumeRequestPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_SYSTEMVOLUME_REQUEST;
}

export function createSetVolumeRequestPacket(sinkName: string, volume: number): LinkPacket {
  return createPacket(PACKET_TYPE_SYSTEMVOLUME_REQUEST, {
    name: sinkName,
    volume,
  });
}

export function createSetMuteRequestPacket(sinkName: string, muted: boolean): LinkPacket {
  return createPacket(PACKET_TYPE_SYSTEMVOLUME_REQUEST, {
    name: sinkName,
    muted,
  });
}

const SCRIPT_PATH = resolveScriptPath('audio-endpoint-volume.ps1');

class PersistentVolumeRunner {
  private process: any = null;
  private reader: readline.Interface | null = null;
  private pendingResolvers: Array<{ resolve: (val: string) => void; reject: (err: Error) => void }> = [];

  constructor() {
    this.start();
  }

  private start() {
    this.process = spawn('powershell', [
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

  public runCommand(cmd: string): Promise<string> {
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

async function queryVolumeList(): Promise<SinkState[]> {
  try {
    const stdout = await runner.runCommand('get');
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: any) => ({
      name: item.id,
      description: item.name,
      volume: item.volume,
      muted: item.muted,
      maxVolume: MAX_VOLUME,
      enabled: true,
    }));
  } catch (e) {
    console.error('[Link] Error querying volume list:', e);
    return [];
  }
}

async function setVolume(deviceId: string, volume: number): Promise<void> {
  await runner.runCommand(`set-volume|${deviceId}|${Math.max(0, Math.min(100, Math.round(volume)))}`);
}

async function setMuted(deviceId: string, muted: boolean): Promise<void> {
  await runner.runCommand(`set-mute|${deviceId}|${muted ? 'true' : 'false'}`);
}

/** Applies an incoming phone request and returns the resulting state to broadcast back. */
export async function handleSystemVolumeRequest(packet: LinkPacket): Promise<SinkState[] | null> {
  const body = packet.body as SystemVolumeRequestBody;

  if (body.name) {
    if (typeof body.volume === 'number') await setVolume(body.name, body.volume);
    if (typeof body.muted === 'boolean') await setMuted(body.name, body.muted);
  }
  return queryVolumeList();
}

export class VolumeWatcher {
  private lastSinks: SinkState[] = [];
  private interval: NodeJS.Timeout | null = null;
  // setInterval does not wait for an async callback, so a poll that outran the interval used to
  // let the next one start anyway. Each overlapping call queues another entry on the runner's
  // pendingResolvers list, which is matched to output strictly by line order — so a backlog both
  // grew without bound and desynced every later reply by one position.
  private polling = false;

  constructor(private onChange: (sinks: SinkState[]) => void, pollIntervalMs = 2000) {
    this.poll();
    this.interval = setInterval(() => this.poll(), pollIntervalMs);
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce() {
    const current = await queryVolumeList();
    if (current.length === 0) return;

    let changed = this.lastSinks.length !== current.length;
    if (!changed) {
      for (let i = 0; i < current.length; i++) {
        if (
          this.lastSinks[i].volume !== current[i].volume ||
          this.lastSinks[i].muted !== current[i].muted ||
          this.lastSinks[i].name !== current[i].name
        ) {
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

  current(): SinkState[] {
    return this.lastSinks;
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }
}
