import type { LinkApi } from '../vite-env';

// Locate: positions reported by paired devices (link.location, see LinkLocation.java). The newest
// fix per device is kept on this device, so a phone that is later lost and offline still shows
// where it was last seen. Kept in localStorage: it is this device's own record, never shared.

export interface DeviceFix {
  latitude: number;
  longitude: number;
  /** Radius in metres within which the device is likely to be (about 68% confidence). */
  accuracy?: number;
  altitude?: number;
  speed?: number;
  provider?: string;
  /** When the device took the fix (ms since epoch); an old remembered fix can arrive now. */
  time: number;
  /** Taken for this request, not a remembered one. */
  fresh: boolean;
  /** When this device received it. */
  receivedAt: number;
}

/** What the located device said besides a fix. */
export type LocateStatus = 'noPermission' | 'notAllowed' | 'off' | 'unavailable' | 'done';

type Listener = (deviceId: string, fix: DeviceFix | null, status: LocateStatus | null) => void;

const STORAGE_PREFIX = 'link.lastLocation.';
const listeners = new Set<Listener>();
let started = false;

const linkApi = () => (window as any).link as LinkApi | undefined;

function read(deviceId: string): DeviceFix | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + deviceId);
    return raw ? (JSON.parse(raw) as DeviceFix) : null;
  } catch {
    return null;
  }
}

function write(deviceId: string, fix: DeviceFix) {
  try {
    localStorage.setItem(STORAGE_PREFIX + deviceId, JSON.stringify(fix));
  } catch {
    // Storage full or blocked: the fix still reaches an open Locate screen.
  }
}

/** The newest position known for a device, or null. */
export function lastLocation(deviceId: string): DeviceFix | null {
  return read(deviceId);
}

export function forgetLocation(deviceId: string) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + deviceId);
  } catch {
    // Nothing stored, or storage blocked.
  }
}

/** Whether `next` should replace `current` as the device's position. */
function better(next: DeviceFix, current: DeviceFix | null): boolean {
  if (!current) return true;
  // A newer fix wins unless it is far less accurate and taken within a minute of the current one.
  if (next.time > current.time + 60_000) return true;
  if (next.time < current.time - 60_000) return false;
  return (next.accuracy ?? Infinity) <= (current.accuracy ?? Infinity) || next.time > current.time;
}

function handle(deviceId: string, body: any) {
  if (!body || typeof body !== 'object') return;
  if (body.status === 'fix' && Number.isFinite(body.latitude) && Number.isFinite(body.longitude)) {
    const fix: DeviceFix = {
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: Number.isFinite(body.accuracy) ? body.accuracy : undefined,
      altitude: Number.isFinite(body.altitude) ? body.altitude : undefined,
      speed: Number.isFinite(body.speed) ? body.speed : undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      time: Number.isFinite(body.time) ? body.time : Date.now(),
      fresh: !!body.fresh,
      receivedAt: Date.now(),
    };
    if (better(fix, read(deviceId))) write(deviceId, fix);
    listeners.forEach((l) => l(deviceId, fix, null));
  } else if (typeof body.status === 'string') {
    listeners.forEach((l) => l(deviceId, null, body.status as LocateStatus));
  }
}

/** Listens for positions from every paired device; called once at startup so "last seen" is kept
 *  even while no Locate screen is open. */
export function startLocationTracking() {
  const api = linkApi();
  if (started || !api?.onLocationReceived) return;
  started = true;
  api.onLocationReceived((deviceId, body) => handle(deviceId, body));
}

export function onLocation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestLocation(deviceId: string) {
  startLocationTracking();
  return linkApi()?.requestDeviceLocation?.(deviceId);
}

/** "3 min ago", "2 h ago", or a date. */
export function ago(time: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(time).toLocaleDateString();
}

export function formatAccuracy(accuracy?: number): string {
  if (accuracy === undefined) return 'accuracy unknown';
  if (accuracy < 1000) return `±${Math.round(accuracy)} m`;
  return `±${(accuracy / 1000).toFixed(1)} km`;
}

export function mapsUrl(fix: DeviceFix): string {
  return `https://www.google.com/maps/search/?api=1&query=${fix.latitude},${fix.longitude}`;
}

/** An OpenStreetMap view framed on the fix, wide enough to show its accuracy radius. */
export function embedMapUrl(fix: DeviceFix): string {
  const radius = Math.min(Math.max(fix.accuracy ?? 100, 60), 20_000) * 2.5;
  const dLat = radius / 111_320;
  const dLon = radius / (111_320 * Math.max(Math.cos((fix.latitude * Math.PI) / 180), 0.01));
  const bbox = [fix.longitude - dLon, fix.latitude - dLat, fix.longitude + dLon, fix.latitude + dLat].map((v) => v.toFixed(6)).join(',');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${fix.latitude},${fix.longitude}`;
}
