// Find My Device plugin. Same packet type is used in either direction. See docs/PROTOCOL.md §8.

import { exec, ChildProcess } from 'child_process';
import { LinkPacket, createPacket } from '../packet';

const PACKET_TYPE_FINDMYDEVICE_REQUEST = 'link.findmydevice.request';
export interface FindMyDeviceBody {
  cancel?: boolean;
}

export function createFindMyDevicePacket(cancel = false): LinkPacket<FindMyDeviceBody> {
  return createPacket(PACKET_TYPE_FINDMYDEVICE_REQUEST, cancel ? { cancel: true } : {});
}

export function isFindMyDevicePacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_FINDMYDEVICE_REQUEST;
}

let ringProcess: ChildProcess | null = null;
let ringTimeout: NodeJS.Timeout | null = null;

export function stopRinging(): void {
  if (ringTimeout) {
    clearTimeout(ringTimeout);
    ringTimeout = null;
  }
  if (ringProcess) {
    if (ringProcess.pid) {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${ringProcess.pid} /t /f`, { stdio: 'ignore' });
      } catch {}
    }
    try { ringProcess.kill('SIGKILL'); } catch {}
    ringProcess = null;
  }
}

/** Loops an alarm sound at system volume until stopped (or 60s safety timeout). */
export function ringThisDevice(): void {
  stopRinging();
  
  // Loop Alarm01.wav infinitely in the child process
  const proc = exec(
    `powershell -NoProfile -Command "$sound = New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav'; while ($true) { $sound.PlaySync() }"`
  );
  ringProcess = proc;
  
  proc.on('exit', () => {
    if (ringProcess === proc) {
      ringProcess = null;
    }
  });

  // 60-second safety-net timeout to auto-stop ringing
  ringTimeout = setTimeout(() => {
    stopRinging();
  }, 60000);
}
