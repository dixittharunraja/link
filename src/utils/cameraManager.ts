import { useSyncExternalStore } from 'react';
import { LinkApi } from '../vite-env';
import { CameraInfo, desiredCameraId, parseLenses, residualZoom, zoomRange } from './cameraLens';

const linkApi = (window as any).link as LinkApi;

// One place that owns the connection to a paired phone's camera, so the Camera preview and the
// virtual webcam share a single stream instead of each opening their own.
//
// Virtual webcam, on demand: while "Phone as virtual webcam" is on, the virtual camera
// (named in `cameraName`) stays open. The moment another program (Zoom, Chrome, ...) opens it, the
// phone's camera is requested and its video is fed in. A few seconds after the program lets go, the
// phone camera is released again, so nothing runs, drains the phone's battery or uses bandwidth while
// the camera is not in use.
//
// The phone's video reaches the virtual camera natively (Rust decodes it, core/camera_rx.rs), which
// needs Cisco's H.264 component; the virtual webcam asks for it with the same download prompt screen
// sharing uses. The Camera panel shares that same native session and draws a preview Rust encodes for
// it (camera_preview_frame), so the virtual camera keeps its picture while the panel is open.

type CameraPhase = 'idle' | 'connecting' | 'live' | 'denied' | 'ended';

/** What the virtual camera shows. Applied to the live output and to the preview alike. */
interface CameraConfig {
  mirror: boolean;
  /** Fill the whole frame (cropping) instead of fitting inside it with bars. */
  fill: boolean;
  /** Overall zoom, 1 = the main camera. Below 1 uses the ultra-wide lens, above uses the telephoto and crops. */
  zoom: number;
  front: boolean;
}

const DEFAULT_CONFIG: CameraConfig = { mirror: false, fill: false, zoom: 1, front: false };
const CONFIG_KEY = 'link.vcam.config';

interface CameraSnapshot {
  deviceId: string | null;
  phase: CameraPhase;
  cameras: CameraInfo[];
  currentCamera: string;
  facing: 'back' | 'front';
  config: CameraConfig;
  /** How much of the zoom is still done by cropping, after the best lens has been chosen. */
  residualZoom: number;
  zoomMin: number;
  zoomMax: number;
  hasFront: boolean;
  /** The name other programs list the virtual camera under. */
  cameraName: string;
  /** Phones that could feed the virtual camera right now (connected, camera allowed). */
  phones: { id: string; name: string }[];
  /** The phone the user pinned, or '' for automatic. */
  preferredPhone: string;
  /** The phone the virtual camera will use right now. */
  activePhone: string;
  /** The virtual webcam is installed and usable on this PC. */
  supported: boolean;
  virtualEnabled: boolean;
  virtualBusy: boolean;
  virtualError: string | null;
  /** Another program is using the virtual camera right now. */
  appConnected: boolean;
}

const POLL_MS = 1000;
// How long the camera must stay unused before the phone is released. Apps briefly close and reopen a
// camera (switching devices, a page reload), and a restart costs a second or two.
const IDLE_RELEASE_MS = 5000;
// A native session that has the phone's offer but shows nothing for this long is given up on.
const NATIVE_NO_PICTURE_MS = 12000;
// Starting right after a stop can cross the stop with the new request on the phone.
const RESTART_GAP_MS = 700;
const AUTO_KEY = 'link.vcam.auto';
// The phone last opened in the Camera panel, and the phone the user pinned in Settings (which wins).
const PHONE_KEY = 'link.vcam.phone';
const PINNED_PHONE_KEY = 'link.vcam.phone.pinned';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable; the setting then simply does not persist */
  }
}

function vlog(message: string) {
  console.log('[VCam]', message);
  linkApi?.vcamLog?.(message)?.catch?.(() => {});
}

/** One connection to one phone's camera. */
class Session {
  phase: CameraPhase = 'connecting';
  cameras: CameraInfo[] = [];
  currentCamera = '';
  facing: 'back' | 'front';
  endedAt = 0;

  private unsubscribe: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  // Once the phone's offer has arrived the connection is being set up; asking again would make the
  // phone throw it away and start over.
  private offerSeen = false;
  private lastOfferAt = 0;
  private gotVideo = false;
  private closed = false;
  /** When Rust first reported the phone's offer. */
  nativeOfferedAt = 0;

  /**
   * Rust receives the phone's video itself (see core/camera_rx.rs) and draws it straight into the
   * virtual camera; the Camera panel's preview also comes from Rust. No peer connection here.
   */
  constructor(
    readonly deviceId: string,
    facing: 'back' | 'front',
    private readonly notify: () => void,
    private readonly onNativeFailure: (reason: string) => void = () => {}
  ) {
    this.facing = facing;
  }

  /** The session learns about the connection from Rust's status. */
  applyNativeStatus(st: { offered: boolean; live: boolean }) {
    if (st.offered) {
      this.offerSeen = true;
      if (!this.nativeOfferedAt) this.nativeOfferedAt = Date.now();
    }
    if (st.live) {
      this.gotVideo = true;
      if (this.phase !== 'live') this.set('live');
    } else if (this.phase === 'live') {
      this.set('connecting');
    }
  }

  private send(body: any) {
    linkApi?.sendRemoteControlSignal?.(this.deviceId, body)?.catch?.(() => {});
  }

  private set(phase: CameraPhase) {
    if (this.phase === phase) return;
    vlog(`session ${this.deviceId.slice(0, 6)} phase ${this.phase} -> ${phase}`);
    this.phase = phase;
    if (phase === 'ended' || phase === 'denied') this.endedAt = Date.now();
    this.notify();
  }

  start() {
    this.closed = false;
    this.gotVideo = false;
    this.offerSeen = false;
    this.phase = 'connecting';
    this.notify();

    // Rust answers the phone's offer itself; this only listens for the phone's other notices.
    this.unsubscribe =
      linkApi?.onRemoteControlSignal?.((srcId: string, signal: any) => {
        if (srcId !== this.deviceId || !signal || this.closed) return;
        switch (signal.type) {
          case 'webrtc_offer':
            this.lastOfferAt = Date.now();
            break;
          case 'cameras':
            if (Array.isArray(signal.cameras)) this.cameras = signal.cameras;
            if (signal.current) this.currentCamera = String(signal.current);
            this.notify();
            break;
          case 'denied':
            this.set('denied');
            break;
          case 'stopped': {
            // The old session's notice can arrive after a new one has already started; only believe it
            // if no fresh offer shows up in the next moment.
            const stoppedAt = Date.now();
            setTimeout(() => {
              if (!this.closed && this.lastOfferAt < stoppedAt) this.set('ended');
            }, 1500);
            break;
          }
          case 'stop':
          case 'ended':
          case 'kicked':
            this.set('ended');
            break;
        }
      }) ?? null;

    const ask = () => this.send({ type: 'request', source: 'camera', facing: this.facing });
    const begin = () => {
      if (this.closed) return;
      ask();
      // The phone can miss the first request (app in the background); ask again until video arrives.
      this.retryTimer = setInterval(() => {
        if (!this.gotVideo && !this.offerSeen) ask();
      }, 4000);
    };
    // Rust must be ready for the offer before the phone is asked to make it.
    const started = linkApi?.vcamNativeStart?.(this.deviceId) ?? Promise.reject(new Error('native camera receiving is not available'));
    started
      .then(() => {
        // Stopped while Rust was still starting: make sure nothing is left running there.
        if (this.closed) linkApi?.vcamNativeStop?.(this.deviceId)?.catch?.(() => {});
        else begin();
      })
      .catch((err: any) => {
        if (this.closed) return;
        // Ended, so the monitor tries again a little later while a program still wants the camera.
        this.set('ended');
        this.onNativeFailure(typeof err === 'string' ? err : err?.message || 'native camera receiving failed');
      });
  }

  /** Closes the connection. `tellPhone` also turns the phone's camera off. */
  stop(tellPhone: boolean) {
    this.closed = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    linkApi?.vcamNativeStop?.(this.deviceId)?.catch?.(() => {});
    if (tellPhone) this.send({ type: 'stop' });
  }

  selectCamera(id: string) {
    this.currentCamera = id;
    this.send({ type: 'select-camera', id });
    this.notify();
  }

  flip() {
    this.facing = this.facing === 'back' ? 'front' : 'back';
    this.send({ type: 'switch-camera' });
    this.notify();
  }
}

class CameraManager {
  private session: Session | null = null;
  private holders = new Map<string, string>(); // reason -> device id ('' = "whichever phone is chosen")
  private listeners = new Set<() => void>();
  private snapshot: CameraSnapshot;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStopAt = 0;

  private supported = false;
  private cameraName = 'Link Virtual Camera';
  private virtualEnabled = false;
  private virtualBusy = false;
  private virtualError: string | null = null;
  private appConnected = false;
  /** Whether "Link Virtual Camera" currently exists for other programs. */
  private deviceOpen = false;
  private deviceSync: Promise<void> = Promise.resolve();
  private phones: string[] = [];
  private phoneInfo: { id: string; name: string }[] = [];
  private facing: 'back' | 'front' = 'back';
  private config: CameraConfig = DEFAULT_CONFIG;
  private lensTimer: ReturnType<typeof setTimeout> | null = null;
  private lensKey = '';
  private nativeConfigKey = '';
  // The H.264 download prompt is offered once per run; after that the error stays in the panel.
  private h264Prompted = false;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private idleSince = 0;
  constructor() {
    try {
      const raw = readStorage(CONFIG_KEY);
      if (raw) this.config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      this.config = DEFAULT_CONFIG;
    }
    this.snapshot = this.buildSnapshot();
  }

  // ---- subscription (for React) ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private buildSnapshot(): CameraSnapshot {
    const s = this.session;
    return {
      deviceId: s?.deviceId ?? null,
      phase: s ? s.phase : 'idle',
      cameras: s?.cameras ?? [],
      currentCamera: s?.currentCamera ?? '',
      facing: s?.facing ?? this.facing,
      config: this.config,
      residualZoom: this.residualZoom(),
      zoomMin: this.zoomRange().min,
      zoomMax: this.zoomRange().max,
      hasFront: parseLenses(s?.cameras ?? []).some((l) => l.front),
      cameraName: this.cameraName,
      phones: this.phoneInfo,
      preferredPhone: readStorage(PINNED_PHONE_KEY) ?? '',
      activePhone: this.chosenPhone() ?? '',
      supported: this.supported,
      virtualEnabled: this.virtualEnabled,
      virtualBusy: this.virtualBusy,
      virtualError: this.virtualError,
      appConnected: this.appConnected,
    };
  }

  private emit = () => {
    // The first time a session reports its cameras, move to the lens the saved zoom calls for.
    const key = this.session ? `${this.session.deviceId}:${this.session.cameras.length}` : '';
    if (key !== this.lensKey) {
      this.lensKey = key;
      if (this.session && this.session.cameras.length > 0) this.applyLens();
    }
    this.snapshot = this.buildSnapshot();
    this.pushNativeConfig();
    this.listeners.forEach((l) => l());
  };

  // ---- native receiving ----

  /** Gives Rust the placing choices (mirror, fill, zoom) it applies to the picture. */
  private pushNativeConfig() {
    if (!this.session) {
      this.nativeConfigKey = '';
      return;
    }
    const zoom = this.residualZoom();
    const key = `${this.config.mirror}|${this.config.fill}|${zoom}`;
    if (key === this.nativeConfigKey) return;
    this.nativeConfigKey = key;
    linkApi?.vcamNativeConfig?.(this.config.mirror, this.config.fill, zoom)?.catch?.(() => {});
  }

  /** Native receiving could not start; shown in the panel. A missing H.264 component also brings up
   *  the download prompt, once per run. */
  private nativeFailed(reason: string) {
    vlog(`native camera receiving failed: ${reason}`);
    void Promise.resolve(linkApi?.h264Status?.())
      .then((st) => {
        if (!st || st.installed) {
          this.virtualError = `The phone's camera could not be received: ${reason}`;
        } else {
          this.virtualError = 'The virtual webcam needs the H.264 video component. Download it when asked, or from Settings.';
          this.promptH264();
        }
        this.emit();
      })
      .catch(() => {});
  }

  private promptH264() {
    if (this.h264Prompted) return;
    this.h264Prompted = true;
    linkApi?.requestH264Component?.('camera')?.catch?.(() => {});
  }

  // ---- what the virtual camera shows ----

  // The lens and crop maths lives in cameraLens.ts; these feed it the live session and settings.
  private zoomRange(): { min: number; max: number } {
    return zoomRange(this.session?.cameras ?? [], this.config.front);
  }

  private residualZoom(): number {
    return residualZoom(this.session?.cameras ?? [], this.session?.currentCamera ?? '', this.config.zoom);
  }

  private desiredCameraId(): string | null {
    return this.session ? desiredCameraId(this.session.cameras, this.config.front, this.config.zoom) : null;
  }

  private applyLens() {
    const id = this.desiredCameraId();
    if (id && this.session && id !== this.session.currentCamera) this.session.selectCamera(id);
  }

  setConfig(patch: Partial<CameraConfig>) {
    const next = { ...this.config, ...patch };
    const range = (() => {
      const prev = this.config;
      this.config = next;
      const r = this.zoomRange();
      this.config = prev;
      return r;
    })();
    next.zoom = Math.min(range.max, Math.max(range.min, next.zoom));
    this.config = next;
    writeStorage(CONFIG_KEY, JSON.stringify(next));
    // Switching lens interrupts the picture for a moment, so wait until the slider has settled.
    if (this.lensTimer) clearTimeout(this.lensTimer);
    this.lensTimer = setTimeout(() => {
      this.lensTimer = null;
      this.applyLens();
      this.emit();
    }, 350);
    this.emit();
  }

  resetConfig() {
    this.setConfig({ ...DEFAULT_CONFIG });
  }

  // ---- the phone session ----

  /** Which phone a request from `reason` should use. */
  private targetFor(reason: string): string | null {
    const wanted = this.holders.get(reason);
    if (wanted) return wanted;
    return this.chosenPhone();
  }

  /** The phone the virtual webcam uses: the one pinned in Settings if it is available, else the last one
   *  that was used if it is available, else the first. */
  private chosenPhone(): string | null {
    const pinned = readStorage(PINNED_PHONE_KEY);
    if (pinned && this.phones.includes(pinned)) return pinned;
    const remembered = readStorage(PHONE_KEY);
    if (remembered && this.phones.includes(remembered)) return remembered;
    return this.phones[0] ?? null;
  }

  /** Asks for a phone's camera. A preview names its phone; the virtual webcam passes '' for "whichever". */
  acquire(reason: 'preview' | 'virtual', deviceId = '') {
    vlog(`acquire ${reason} ${deviceId.slice(0, 6)}`);
    this.holders.set(reason, deviceId);
    if (reason === 'preview' && deviceId) writeStorage(PHONE_KEY, deviceId);
    this.scheduleReconcile(0);
  }

  release(reason: 'preview' | 'virtual') {
    if (!this.holders.delete(reason)) return;
    vlog(`release ${reason}`);
    // Debounced: React's dev-mode remount releases and re-acquires within the same tick, which must not
    // turn the phone's camera off and on.
    this.scheduleReconcile(300);
  }

  private scheduleReconcile(delayMs: number) {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.reconcile();
    }, delayMs);
  }

  private reconcile() {
    // A preview names its phone and wins; otherwise the virtual webcam's choice is used.
    const target = this.holders.has('preview') ? this.targetFor('preview') : this.holders.has('virtual') ? this.targetFor('virtual') : null;

    if (this.session && this.session.deviceId !== target) {
      vlog(`session stop (target ${this.session.deviceId.slice(0, 6)} -> ${target ? target.slice(0, 6) : 'none'})`);
      this.session.stop(true);
      this.session = null;
      this.lastStopAt = Date.now();
    }
    if (!this.session && target) {
      const sinceStop = Date.now() - this.lastStopAt;
      if (sinceStop < RESTART_GAP_MS) {
        this.scheduleReconcile(RESTART_GAP_MS - sinceStop);
      } else {
        vlog(`session start phone ${target.slice(0, 6)}`);
        this.session = new Session(target, this.facing, this.emit, (reason) => this.nativeFailed(reason));
        this.session.start();
        // The monitor also watches the session for failure or stall while only the panel is open.
        this.startMonitor();
      }
    }
    this.emit();
  }

  retry() {
    if (!this.session) return;
    vlog('retry');
    this.session.stop(true);
    this.session = null;
    this.lastStopAt = Date.now();
    // Reconcile starts a fresh session if anything still wants the camera.
    this.scheduleReconcile(RESTART_GAP_MS);
    this.emit();
  }

  selectCamera(id: string) {
    this.session?.selectCamera(id);
  }

  flipCamera() {
    this.facing = this.facing === 'back' ? 'front' : 'back';
    this.session?.flip();
    this.emit();
  }

  /** Phones that are connected and have allowed this PC to use their camera. */
  setPhones(phones: { id: string; name: string }[]) {
    const sorted = [...phones].sort((a, b) => a.id.localeCompare(b.id));
    const same =
      sorted.length === this.phoneInfo.length && sorted.every((p, i) => p.id === this.phoneInfo[i].id && p.name === this.phoneInfo[i].name);
    if (same) return;
    vlog(`eligible phones: ${sorted.map((p) => p.id.slice(0, 6)).join(',') || 'none'}`);
    this.phoneInfo = sorted;
    this.phones = sorted.map((p) => p.id);
    this.syncDevice();
    if (this.holders.has('virtual')) this.scheduleReconcile(0);
    this.emit();
  }

  /** Pins the phone the virtual camera uses; '' goes back to automatic (the last one used). */
  setPreferredPhone(id: string) {
    writeStorage(PINNED_PHONE_KEY, id || null);
    if (this.holders.has('virtual')) this.scheduleReconcile(0);
    this.emit();
  }

  // ---- virtual webcam ----

  async init() {
    try {
      const st: any = await linkApi?.vcamStatus?.();
      this.supported = !!st?.supported && !!st?.available;
      if (st?.cameraName) this.cameraName = String(st.cameraName);
    } catch {
      this.supported = false;
    }
    this.virtualEnabled = this.supported && readStorage(AUTO_KEY) === '1';
    // The camera itself is only created once a phone that can supply it is connected (see syncDevice).
    this.syncDevice();
    this.emit();
  }

  /**
   * Keeps the virtual camera listed in other programs only while it can actually work: the option is on
   * and a phone that allows it is connected. With no phone, other programs (and a browser choosing a
   * default camera) never see "Link Virtual Camera" at all.
   */
  private syncDevice() {
    this.deviceSync = this.deviceSync.then(async () => {
      const want = this.virtualEnabled && this.phones.length > 0;
      if (want === this.deviceOpen) return;
      try {
        if (want) {
          // Does not ask for administrator rights; if the camera is not installed it stays off.
          await linkApi?.vcamOpen?.();
          this.deviceOpen = true;
          this.startMonitor();
        } else {
          await linkApi?.vcamStop?.();
          this.deviceOpen = false;
          this.appConnected = false;
        }
      } catch (err: any) {
        if (want) {
          this.virtualEnabled = false;
          this.virtualError = typeof err === 'string' ? err : err?.message || null;
          this.stopMonitor();
        }
      }
      this.emit();
    });
  }

  async setVirtualEnabled(on: boolean) {
    if (on === this.virtualEnabled || this.virtualBusy) return;
    this.virtualError = null;
    if (on) {
      this.virtualBusy = true;
      this.emit();
      try {
        // The phone's video is decoded natively, which needs the H.264 component.
        const h264 = await linkApi?.h264Status?.();
        if (h264?.supported && !h264.installed) {
          this.virtualError = 'The virtual webcam needs the H.264 video component. Download it, then turn this on again.';
          this.h264Prompted = false;
          this.promptH264();
          return;
        }
        // The first time this installs the camera, which Windows asks administrator permission for.
        await linkApi?.vcamStart?.();
        this.virtualEnabled = true;
        this.deviceOpen = true;
        writeStorage(AUTO_KEY, '1');
        this.startMonitor();
        // With no phone connected the camera is taken down again right away.
        this.syncDevice();
      } catch (err: any) {
        this.virtualError = typeof err === 'string' ? err : err?.message || 'Could not start the virtual webcam.';
      } finally {
        this.virtualBusy = false;
      }
    } else {
      this.virtualEnabled = false;
      writeStorage(AUTO_KEY, '0');
      this.stopMonitor();
      this.release('virtual');
      linkApi?.vcamStop?.().catch(() => {});
      this.deviceOpen = false;
      this.appConnected = false;
    }
    this.emit();
  }

  private startMonitor() {
    if (this.pollTimer) return;
    this.idleSince = 0;
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
  }

  private stopMonitor() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll() {
    if (this.polling) return;
    // Runs for the virtual webcam, and for as long as the Camera panel keeps a session going.
    if (!this.virtualEnabled && !this.session) {
      this.stopMonitor();
      return;
    }
    this.polling = true;
    try {
      const connected = this.virtualEnabled && !!(await linkApi?.vcamConnected?.());
      const changed = connected !== this.appConnected;
      if (changed) vlog(`program connected = ${connected}`);
      this.appConnected = connected;
      const now = Date.now();
      await this.pollNative(now);
      if (connected) {
        this.idleSince = 0;
        if (!this.holders.has('virtual')) this.acquire('virtual');
        // A phone camera that ended on its own (app closed on the phone) is retried while a program still wants it.
        const s = this.session;
        if (s && s.phase === 'ended' && now - s.endedAt > 5000) this.retry();
      } else {
        if (!this.idleSince) this.idleSince = now;
        if (now - this.idleSince > IDLE_RELEASE_MS && this.holders.has('virtual')) {
          this.release('virtual');
        }
      }
      if (changed) this.emit();
    } catch {
      /* a failed poll is simply tried again */
    } finally {
      this.polling = false;
    }
  }

  /** Reads how native receiving is doing, and starts it again when it fails or stalls. */
  private async pollNative(now: number) {
    const session = this.session;
    if (!session) return;
    const st = await linkApi?.vcamNativeStatus?.(session.deviceId);
    if (!st || this.session !== session) return;
    session.applyNativeStatus(st);
    if (st.live && this.virtualError) {
      this.virtualError = null;
      this.emit();
    }
    if (st.error) {
      this.nativeFailed(st.error);
      this.retry();
    } else if (st.offered && !st.live && session.nativeOfferedAt && now - session.nativeOfferedAt > NATIVE_NO_PICTURE_MS) {
      vlog('the phone connected but no picture arrived; starting again');
      this.retry();
    }
  }
}

export const cameraManager = new CameraManager();

export function useCameraManager(): CameraSnapshot {
  return useSyncExternalStore(cameraManager.subscribe, cameraManager.getSnapshot);
}
