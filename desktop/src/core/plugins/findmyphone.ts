// Find My Phone / Find This Device plugin — port of kdeconnect-kde's plugins/findmyphone
// (desktop-finds-phone) and plugins/findthisdevice (phone-finds-desktop) — same packet type,
// used in either direction. See docs/PROTOCOL.md §8.
//
// Scoped down from upstream Android's actual behavior on purpose: real kdeconnect-android loops
// a ringtone at max ALARM volume, flashes the camera flashlight, and shows a full-screen
// notification that only stops when the user taps it — there's no "stop" packet in the protocol
// at all, it rings until manually acknowledged on the device. We don't have that notification/
// activity infrastructure built yet, so this implements the core "make noise to help locate it"
// behavior with a fixed auto-stop duration instead of tap-to-dismiss. Disclosed deviation, not a
// silent one — see docs/features.txt.

import { exec, ChildProcess } from 'child_process';
import { LinkPacket, createPacket } from '../packet';

export const PACKET_TYPE_FINDMYPHONE_REQUEST = 'link.findmyphone.request';
export interface FindMyPhoneBody {
  cancel?: boolean;
}

export function createFindMyPhonePacket(cancel = false): LinkPacket<FindMyPhoneBody> {
  return createPacket(PACKET_TYPE_FINDMYPHONE_REQUEST, cancel ? { cancel: true } : {});
}

export function isFindMyPhonePacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_FINDMYPHONE_REQUEST;
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
      } catch (e) {}
    }
    try { ringProcess.kill('SIGKILL'); } catch (e) {}
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
