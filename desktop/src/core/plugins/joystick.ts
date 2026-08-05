// Joystick plugin — emulates up to 4 virtual Xbox 360 controllers on Windows via ViGEmBus, one
// per connected phone, so several friends can each use their phone as a local co-op controller.
//
// Unlike every other plugin in this app, Joystick is entirely IP-identified, not deviceId/pairing
// based — a controller is "an untrusted tool" by design (like Audio Sink/Walkie Talkie's guest
// mode): scan a QR code or type an IP, you're playing, no pairing/trust/permission step at all.
// So the whole protocol — including the initial handshake — rides the existing raw UDP:1717
// realtime channel as plain text lines, identified purely by source IP:
//   phone -> desktop:  "hello <name>"                          join, allocate a pad slot
//                      "js lx ly rx ry lt rt buttons"           60Hz full controller state
//                      "bye"                                    explicit leave
//   desktop -> phone:  "hello-ack ok <padIndex>" | "hello-ack error <reason>"
//                      "rumble <large> <small>"                 force-feedback passthrough
//                      "ping"                                    liveness heartbeat (see below)
//                      "bye <reason>"                            forced disconnect (see below)
//
// UDP has no connection state, so neither side otherwise finds out when the other one vanishes.
// Two mechanisms cover this (both consumed by JoystickOverlay.tsx to auto-close the controller
// UI — see its onDisconnected handling):
//   - Forced disconnect: when the HOST deliberately drops a controller (kick, block, or the
//     ViGEm helper crashing), it fires a "bye <reason>" at that phone so it finds out instantly
//     instead of continuing to send "js ..." into the void.
//   - Heartbeat: the host pings every currently-connected controller on the same cadence as its
//     own liveness sweep (LIVENESS_SWEEP_INTERVAL_MS). If a phone stops hearing pings — a real
//     network drop, not a deliberate disconnect — it notices on its own and closes itself, since
//     there's nothing for the host to detect or tell it in that case (the host can't reach it
//     either).
//
// Backed by a native helper process (joystick-helper.exe) that talks to ViGEmBus through the
// Nefarius.ViGEm.Client library. Unlike touchpad.ts's mouse-helper.cs — which is compiled on the
// end user's own machine at first run via the bundled csc.exe, since it only needs P/Invoke — this
// helper depends on a NuGet package that csc.exe cannot resolve, so it is prebuilt ahead of time
// and vendored (see desktop/native/joystick-helper/README.md), integrity-checked the same way
// fs-mount-service.ts pins rclone.exe before every spawn.

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';

export const MAX_JOYSTICK_PADS = 4;

// A UDP handshake/state stream has no clean "disconnect" — a dropped phone (Wi-Fi loss, app
// killed, walked out of range) never sends "bye". Any controller that hasn't sent a "js ..." line
// in this long is treated as gone and its pad slot freed, so a 5th friend isn't blocked forever
// by a stale slot. Comfortably above the 16ms/60Hz send interval JoystickOverlay.tsx uses, so any
// value here is really just "how long to tolerate a real network hiccup before giving up the slot".
const LIVENESS_TIMEOUT_MS = 8000;
const LIVENESS_SWEEP_INTERVAL_MS = 3000;

// Heartbeat cadence, deliberately faster than (and independent of) the sweep above. The phone
// declares the link dead after ~12s of total silence, so beating once a second means a dozen
// consecutive losses are needed to false-positive — heartbeats are plain unacknowledged UDP, and
// losing one or two in a row on a busy network is routine. Cheap: a handful of bytes per second
// per controller, against a 60Hz inbound stream.
const PING_INTERVAL_MS = 1000;

export interface JoystickController {
  ip: string;
  name: string;
  padIndex: number;
}

// Regenerate via `certutil -hashfile desktop\vendor\joystick-helper\joystick-helper.exe SHA256`
// whenever joystick-helper.exe is intentionally rebuilt — see
// desktop/native/joystick-helper/README.md. Left blank until the helper is first vendored; a
// blank pin makes getDriverStatus() report 'missing' rather than running an unverified binary.
const JOYSTICK_HELPER_PINNED_SHA256 = '582f22cb288b36fed41e1434ee48c61c9757ee9aa78e1211a696fb961dd6500d';

export type JoystickDriverStatus = 'unknown' | 'ready' | 'missing' | 'error';

export class JoystickHandler {
  private helperProcess: ChildProcess | null = null;
  private helperReady = false;
  private driverStatus: JoystickDriverStatus = 'unknown';
  private driverError: string | null = null;

  private ipToSlot = new Map<string, number>();
  private slotToIp = new Map<number, string>();
  private names = new Map<string, string>();
  private lastSeen = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private onRumbleCallback: ((ip: string, large: number, small: number) => void) | null = null;
  private onDriverStatusChangeCallback: ((status: JoystickDriverStatus, error: string | null) => void) | null = null;
  private onRosterChangeCallback: (() => void) | null = null;
  // Fired for every controller removal EXCEPT a phone-initiated 'bye' (which already knows it's
  // leaving) — main.ts uses this to relay a "bye <reason>" back to the phone so its UI can close
  // itself immediately instead of only finding out via the (much slower) heartbeat timeout.
  private onControllerRemovedCallback: ((ip: string, reason: string) => void) | null = null;
  // Fired on the same cadence as the liveness sweep, with every currently-connected IP — main.ts
  // uses this to send each one a "ping" heartbeat (see this file's header comment).
  private onPingTickCallback: ((ips: string[]) => void) | null = null;
  private isBlocked: (idOrIp: string) => boolean = () => false;

  constructor(private vendorDir: string) {
    this.sweepTimer = setInterval(() => this.sweepStaleControllers(), LIVENESS_SWEEP_INTERVAL_MS);
    this.pingTimer = setInterval(() => {
      if (this.ipToSlot.size > 0) this.onPingTickCallback?.(Array.from(this.ipToSlot.keys()));
    }, PING_INTERVAL_MS);
  }

  public setIsBlocked(fn: (idOrIp: string) => boolean) {
    this.isBlocked = fn;
  }

  public isControllerConnected(ip: string): boolean {
    return this.ipToSlot.has(ip);
  }

  public onRumble(cb: (ip: string, large: number, small: number) => void) {
    this.onRumbleCallback = cb;
  }

  public onDriverStatusChange(cb: (status: JoystickDriverStatus, error: string | null) => void) {
    this.onDriverStatusChangeCallback = cb;
  }

  /** Fired whenever a controller joins, leaves, or times out — the host UI polls
   *  getConnectedControllers() on this signal rather than every tick. */
  public onRosterChange(cb: () => void) {
    this.onRosterChangeCallback = cb;
  }

  public onControllerRemoved(cb: (ip: string, reason: string) => void) {
    this.onControllerRemovedCallback = cb;
  }

  public onPingTick(cb: (ips: string[]) => void) {
    this.onPingTickCallback = cb;
  }

  public getDriverStatus(): { status: JoystickDriverStatus; error: string | null } {
    return { status: this.driverStatus, error: this.driverError };
  }

  /** Actively probes the driver (spawns the helper if it isn't already running) instead of just
   *  reading whatever was last cached — getDriverStatus() alone stays 'unknown' forever until the
   *  FIRST phone actually connects, since that's the only other thing that calls
   *  ensureHelperRunning(). This is what "Verify Installation" in JoystickTab.tsx should call. */
  public checkDriverNow(): { status: JoystickDriverStatus; error: string | null } {
    this.ensureHelperRunning();
    return this.getDriverStatus();
  }

  private setDriverStatus(status: JoystickDriverStatus, error: string | null = null) {
    this.driverStatus = status;
    this.driverError = error;
    this.onDriverStatusChangeCallback?.(status, error);
  }

  private ensureHelperRunning(): boolean {
    if (this.helperProcess) return true;

    const helperExe = path.join(this.vendorDir, 'joystick-helper', 'joystick-helper.exe');
    if (!fs.existsSync(helperExe)) {
      console.error('[Joystick] joystick-helper.exe not found at', helperExe);
      this.setDriverStatus('missing', 'helper_not_bundled');
      return false;
    }

    if (!JOYSTICK_HELPER_PINNED_SHA256) {
      console.error('[Joystick] JOYSTICK_HELPER_PINNED_SHA256 is not set — refusing to run an unpinned binary.');
      this.setDriverStatus('missing', 'helper_not_pinned');
      return false;
    }

    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(helperExe)).digest('hex');
    if (actualHash !== JOYSTICK_HELPER_PINNED_SHA256) {
      console.error('[Joystick] joystick-helper.exe failed its integrity check — refusing to run it.');
      this.setDriverStatus('error', 'helper_integrity_check_failed');
      return false;
    }

    try {
      // Unlike touchpad.ts's helper spawn (stdio: ['pipe','ignore','ignore']), this helper's
      // stdout is a live channel we must read — 'ready'/'error' at startup and 'rumble ...' lines
      // on force-feedback change — so stdout is piped, not ignored.
      this.helperProcess = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.helperReady = false;

      const rl = readline.createInterface({ input: this.helperProcess.stdout! });
      rl.on('line', (line) => this.handleHelperLine(line));

      this.helperProcess.on('exit', () => {
        // Capture before clearing — every currently-plugged controller needs to be told the
        // driver died out from under it, not just have its slot silently vanish.
        const strandedIps = Array.from(this.ipToSlot.keys());
        this.helperProcess = null;
        this.helperReady = false;
        this.ipToSlot.clear();
        this.slotToIp.clear();
        this.names.clear();
        this.lastSeen.clear();
        this.setDriverStatus('unknown');
        for (const ip of strandedIps) this.onControllerRemovedCallback?.(ip, 'host_error');
        this.onRosterChangeCallback?.();
      });
    } catch (err) {
      console.error('[Joystick] Failed to start joystick-helper.exe:', err);
      this.setDriverStatus('error', 'spawn_failed');
      return false;
    }

    return true;
  }

  private handleHelperLine(line: string) {
    const parts = line.trim().split(' ');
    if (parts[0] === 'ready') {
      this.helperReady = true;
      this.setDriverStatus('ready');
    } else if (parts[0] === 'error') {
      this.helperReady = false;
      this.setDriverStatus(parts[1] === 'driver_not_found' ? 'missing' : 'error', parts[1] || null);
    } else if (parts[0] === 'rumble' && parts.length >= 4) {
      const slot = parseInt(parts[1], 10);
      const large = parseInt(parts[2], 10);
      const small = parseInt(parts[3], 10);
      const ip = this.slotToIp.get(slot);
      if (ip && this.onRumbleCallback) {
        this.onRumbleCallback(ip, large, small);
      }
    }
  }

  /** "hello <name>" — join request from a phone at `ip`. Returns the assigned pad index, or an
   *  error the desktop relays back over UDP as "hello-ack error <reason>". */
  public handleHello(ip: string, name: string): { padIndex?: number; error?: string } {
    if (this.isBlocked(ip)) return { error: 'blocked' };
    if (!this.ensureHelperRunning()) return { error: 'driver_missing' };
    if (!this.helperReady) return { error: 'helper_not_ready' };

    const existing = this.ipToSlot.get(ip);
    if (existing !== undefined) {
      this.names.set(ip, name);
      this.lastSeen.set(ip, Date.now());
      return { padIndex: existing };
    }

    let slot = -1;
    for (let i = 0; i < MAX_JOYSTICK_PADS; i++) {
      if (!this.slotToIp.has(i)) { slot = i; break; }
    }
    if (slot === -1) return { error: 'slots_full' };

    this.ipToSlot.set(ip, slot);
    this.slotToIp.set(slot, ip);
    this.names.set(ip, name);
    this.lastSeen.set(ip, Date.now());
    this.helperProcess!.stdin!.write(`plug ${slot}\n`);
    console.log(`[Joystick] ${ip} (${name}) plugged as pad ${slot}`);
    this.onRosterChangeCallback?.();
    return { padIndex: slot };
  }

  /** `reason` is 'left' for a phone-initiated "bye" (default — it already knows it's leaving, so
   *  nothing needs to be relayed back) or one of 'kicked' | 'blocked' | 'timeout' | 'host_error'
   *  for a host-initiated removal, which DOES get relayed — see onControllerRemoved(). */
  public handleBye(ip: string, reason: string = 'left') {
    const slot = this.ipToSlot.get(ip);
    if (slot === undefined) return;
    this.ipToSlot.delete(ip);
    this.slotToIp.delete(slot);
    this.names.delete(ip);
    this.lastSeen.delete(ip);
    if (this.helperProcess?.stdin) {
      this.helperProcess.stdin.write(`unplug ${slot}\n`);
    }
    console.log(`[Joystick] ${ip} unplugged from pad ${slot} (${reason})`);
    if (reason !== 'left') this.onControllerRemovedCallback?.(ip, reason);
    this.onRosterChangeCallback?.();
  }

  private sweepStaleControllers() {
    const now = Date.now();
    for (const [ip, seenAt] of Array.from(this.lastSeen.entries())) {
      if (now - seenAt > LIVENESS_TIMEOUT_MS) {
        console.log(`[Joystick] ${ip} timed out — freeing its pad slot`);
        this.handleBye(ip, 'timeout');
      }
    }
  }

  /** `line` is the raw "js lx ly rx ry lt rt buttons" UDP payload, already stripped of the "js "
   *  prefix by the caller in main.ts. Silently ignored if `ip` hasn't said "hello" yet — this is
   *  the only membership check Joystick has, by design (see this file's header comment). */
  public handleStickState(ip: string, line: string) {
    if (this.isBlocked(ip)) return;
    const slot = this.ipToSlot.get(ip);
    if (slot === undefined || !this.helperProcess?.stdin) return;
    this.lastSeen.set(ip, Date.now());
    this.helperProcess.stdin.write(`report ${slot} ${line}\n`);
  }

  public getConnectedControllers(): JoystickController[] {
    return Array.from(this.ipToSlot.entries()).map(([ip, padIndex]) => ({
      ip, padIndex, name: this.names.get(ip) || ip,
    }));
  }
}
