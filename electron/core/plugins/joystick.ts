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
// Nefarius.ViGEm.Client library. Prebuilt ahead of time and vendored, integrity-checked with SHA256.

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';

const MAX_JOYSTICK_PADS = 4;
const LIVENESS_SWEEP_INTERVAL_MS = 3000;
const LIVENESS_TIMEOUT_MS = 8000;
const PING_INTERVAL_MS = 1000;

export type JoystickDriverStatus = 'unknown' | 'ready' | 'missing' | 'error';

export interface JoystickController {
  ip: string;
  name: string;
  padIndex: number;
}

// Regenerate via `certutil -hashfile desktop\vendor\joystick-helper\joystick-helper.exe SHA256`
// whenever joystick-helper.exe is intentionally rebuilt.
const JOYSTICK_HELPER_PINNED_SHA256 = '2252c609568bd230f9d43474d14ef7c2d2117cb59c26c1415e1437894b42208b';

// --- Helper Process Management ---
class JoystickHelper {
  private process: ChildProcess | null = null;
  private ready = false;
  private status: JoystickDriverStatus = 'unknown';
  private error: string | null = null;

  private onLineCallback: ((line: string) => void) | null = null;
  private onExitCallback: (() => void) | null = null;
  private onStatusChangeCallback: ((status: JoystickDriverStatus, error: string | null) => void) | null = null;
  private readyWaiters: Array<{ resolve: (ready: boolean) => void; timeout: NodeJS.Timeout }> = [];

  constructor(private vendorDir: string) {}

  getStatus(): { status: JoystickDriverStatus; error: string | null } {
    return { status: this.status, error: this.error };
  }

  isReady(): boolean {
    return this.ready;
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  onLine(cb: (line: string) => void) {
    this.onLineCallback = cb;
  }

  onExit(cb: () => void) {
    this.onExitCallback = cb;
  }

  onStatusChange(cb: (status: JoystickDriverStatus, error: string | null) => void) {
    this.onStatusChangeCallback = cb;
  }

  write(line: string): boolean {
    if (!this.process?.stdin) return false;
    try {
      this.process.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  async waitForReady(timeoutMs: number = 3000): Promise<boolean> {
    if (this.ready) return true;
    if (!this.start()) return false;
    if (this.ready) return true;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w.resolve !== resolve);
        resolve(this.ready);
      }, timeoutMs);

      this.readyWaiters.push({ resolve, timeout: timer });
    });
  }

  private resolveWaiters(isReady: boolean) {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const { resolve, timeout } of waiters) {
      clearTimeout(timeout);
      resolve(isReady);
    }
  }

  start(): boolean {
    if (this.process) return true;

    const helperExe = path.join(this.vendorDir, 'joystick-helper', 'joystick-helper.exe');
    if (!fs.existsSync(helperExe)) {
      console.error('[Joystick] joystick-helper.exe not found at', helperExe);
      this.setStatus('missing', 'helper_not_bundled');
      return false;
    }

    if (!JOYSTICK_HELPER_PINNED_SHA256) {
      console.error('[Joystick] JOYSTICK_HELPER_PINNED_SHA256 is not set — refusing to run an unpinned binary.');
      this.setStatus('missing', 'helper_not_pinned');
      return false;
    }

    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(helperExe)).digest('hex');
    if (actualHash !== JOYSTICK_HELPER_PINNED_SHA256) {
      console.error('[Joystick] joystick-helper.exe failed its integrity check — refusing to run it.');
      this.setStatus('error', 'helper_integrity_check_failed');
      return false;
    }

    try {
      this.process = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.ready = false;

      const rl = readline.createInterface({ input: this.process.stdout! });
      rl.on('line', (line) => this.onLineCallback?.(line));

      this.process.on('exit', () => {
        this.process = null;
        this.ready = false;
        this.setStatus('unknown');
        this.resolveWaiters(false);
        this.onExitCallback?.();
      });
    } catch (err) {
      console.error('[Joystick] Failed to start joystick-helper.exe:', err);
      this.setStatus('error', 'spawn_failed');
      return false;
    }

    return true;
  }

  markReady(): void {
    this.ready = true;
    this.setStatus('ready');
    this.resolveWaiters(true);
  }

  markError(reason: string): void {
    this.ready = false;
    this.setStatus(reason === 'driver_not_found' ? 'missing' : 'error', reason);
    this.resolveWaiters(false);
  }

  private setStatus(status: JoystickDriverStatus, error: string | null = null) {
    this.status = status;
    this.error = error;
    this.onStatusChangeCallback?.(status, error);
  }
}

// --- Slot Allocation & State Tracking ---
class JoystickSlots {
  private ipToSlot = new Map<string, number>();
  private slotToIp = new Map<number, string>();
  private names = new Map<string, string>();
  private lastSeen = new Map<string, number>();

  isControllerConnected(ip: string): boolean {
    return this.ipToSlot.has(ip);
  }

  allocateSlot(ip: string, name: string): number {
    const existing = this.ipToSlot.get(ip);
    if (existing !== undefined) {
      this.names.set(ip, name);
      this.lastSeen.set(ip, Date.now());
      return existing;
    }

    for (let i = 0; i < MAX_JOYSTICK_PADS; i++) {
      if (!this.slotToIp.has(i)) {
        this.ipToSlot.set(ip, i);
        this.slotToIp.set(i, ip);
        this.names.set(ip, name);
        this.lastSeen.set(ip, Date.now());
        return i;
      }
    }
    return -1;
  }

  freeSlot(ip: string): number | undefined {
    const slot = this.ipToSlot.get(ip);
    if (slot === undefined) return undefined;
    this.ipToSlot.delete(ip);
    this.slotToIp.delete(slot);
    this.names.delete(ip);
    this.lastSeen.delete(ip);
    return slot;
  }

  getSlot(ip: string): number | undefined {
    return this.ipToSlot.get(ip);
  }

  getIp(slot: number): string | undefined {
    return this.slotToIp.get(slot);
  }

  updateLastSeen(ip: string): void {
    this.lastSeen.set(ip, Date.now());
  }

  sweepStale(): Array<[string, number]> {
    const now = Date.now();
    const stale: Array<[string, number]> = [];
    for (const [ip, seenAt] of Array.from(this.lastSeen.entries())) {
      if (now - seenAt > LIVENESS_TIMEOUT_MS) {
        const slot = this.freeSlot(ip);
        if (slot !== undefined) {
          stale.push([ip, slot]);
        }
      }
    }
    return stale;
  }

  getAllConnected(): JoystickController[] {
    return Array.from(this.ipToSlot.entries()).map(([ip, padIndex]) => ({
      ip,
      padIndex,
      name: this.names.get(ip) || ip,
    }));
  }

  getAllIps(): string[] {
    return Array.from(this.ipToSlot.keys());
  }

  clear(): void {
    this.ipToSlot.clear();
    this.slotToIp.clear();
    this.names.clear();
    this.lastSeen.clear();
  }
}

// --- Main Joystick Plugin Handler ---
export class JoystickHandler {
  private slots: JoystickSlots;
  private helper: JoystickHelper;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private onRumbleCallback: ((ip: string, large: number, small: number) => void) | null = null;
  private onDriverStatusChangeCallback: ((status: JoystickDriverStatus, error: string | null) => void) | null = null;
  private onRosterChangeCallback: (() => void) | null = null;
  private onControllerRemovedCallback: ((ip: string, reason: string) => void) | null = null;
  private onPingTickCallback: ((ips: string[]) => void) | null = null;
  private isBlocked: (idOrIp: string) => boolean = () => false;

  constructor(vendorDir: string) {
    this.slots = new JoystickSlots();
    this.helper = new JoystickHelper(vendorDir);

    // Wire helper stdout to slot/rumble dispatch.
    this.helper.onLine((line) => this.handleHelperLine(line));
    this.helper.onExit(() => this.handleHelperCrash());
    this.helper.onStatusChange((status, error) => this.onDriverStatusChangeCallback?.(status, error));

    // Liveness sweep and heartbeat.
    this.sweepTimer = setInterval(() => this.sweepStaleControllers(), LIVENESS_SWEEP_INTERVAL_MS);
    this.pingTimer = setInterval(() => {
      const ips = this.slots.getAllIps();
      if (ips.length > 0) this.onPingTickCallback?.(ips);
    }, PING_INTERVAL_MS);
  }

  public setIsBlocked(fn: (idOrIp: string) => boolean) {
    this.isBlocked = fn;
  }

  public isControllerConnected(ip: string): boolean {
    return this.slots.isControllerConnected(ip);
  }

  public onRumble(cb: (ip: string, large: number, small: number) => void) {
    this.onRumbleCallback = cb;
  }

  public onDriverStatusChange(cb: (status: JoystickDriverStatus, error: string | null) => void) {
    this.onDriverStatusChangeCallback = cb;
  }

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
    return this.helper.getStatus();
  }

  public checkDriverNow(): { status: JoystickDriverStatus; error: string | null } {
    this.helper.start();
    return this.helper.getStatus();
  }

  public async handleHello(ip: string, name: string): Promise<{ padIndex?: number; error?: string }> {
    if (this.isBlocked(ip)) return { error: 'blocked' };
    if (!this.helper.start()) return { error: 'driver_missing' };
    const ready = await this.helper.waitForReady(3000);
    if (!ready) return { error: 'helper_not_ready' };

    const slot = this.slots.allocateSlot(ip, name);
    if (slot === -1) return { error: 'slots_full' };

    if (slot >= 0 && slot < MAX_JOYSTICK_PADS) {
      this.helper.write(`plug ${slot}`);
      console.log(`[Joystick] ${ip} (${name}) plugged as pad ${slot}`);
      this.onRosterChangeCallback?.();
    }
    return { padIndex: slot };
  }

  public handleBye(ip: string, reason: string = 'left') {
    const slot = this.slots.freeSlot(ip);
    if (slot === undefined) return;
    this.helper.write(`unplug ${slot}`);
    console.log(`[Joystick] ${ip} unplugged from pad ${slot} (${reason})`);
    if (reason !== 'left') this.onControllerRemovedCallback?.(ip, reason);
    this.onRosterChangeCallback?.();
  }

  public handleStickState(ip: string, line: string) {
    if (this.isBlocked(ip)) return;
    const slot = this.slots.getSlot(ip);
    if (slot === undefined) return;
    this.slots.updateLastSeen(ip);
    this.helper.write(`report ${slot} ${line}`);
  }

  public getConnectedControllers(): JoystickController[] {
    return this.slots.getAllConnected();
  }

  private handleHelperLine(line: string) {
    const parts = line.trim().split(' ');
    if (parts[0] === 'ready') {
      this.helper.markReady();
    } else if (parts[0] === 'error') {
      this.helper.markError(parts[1] || '');
    } else if (parts[0] === 'rumble' && parts.length >= 4) {
      const slot = parseInt(parts[1], 10);
      const large = parseInt(parts[2], 10);
      const small = parseInt(parts[3], 10);
      const ip = this.slots.getIp(slot);
      if (ip && this.onRumbleCallback) {
        this.onRumbleCallback(ip, large, small);
      }
    }
  }

  private handleHelperCrash() {
    const strandedIps = this.slots.getAllIps();
    this.slots.clear();
    for (const ip of strandedIps) {
      this.onControllerRemovedCallback?.(ip, 'host_error');
    }
    this.onRosterChangeCallback?.();
  }

  private sweepStaleControllers() {
    const stale = this.slots.sweepStale();
    for (const [ip, slot] of stale) {
      this.helper.write(`unplug ${slot}`);
      console.log(`[Joystick] ${ip} timed out — freed pad ${slot}`);
      this.onControllerRemovedCallback?.(ip, 'timeout');
    }
    if (stale.length > 0) this.onRosterChangeCallback?.();
  }
}
