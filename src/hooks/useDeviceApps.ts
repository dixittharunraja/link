import { useCallback, useEffect, useRef, useState } from 'react';
import { LinkApi } from '../vite-env';

export interface DeviceApp {
  package: string;
  label: string;
  /** Base64 PNG, without a data: prefix. */
  icon?: string;
}

const pinnedKey = (deviceId: string) => `link-pinned-apps:${deviceId}`;
const appsKey = (deviceId: string) => `link-device-apps:${deviceId}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: the pins simply do not persist
  }
}

/**
 * The apps installed on another device (a TV) and the few pinned as favourites for one-tap launching
 * from the remote. The list comes from the device itself; it is cached per device so the favourites
 * show at once, before the device answers. Pins are kept in this device's local storage.
 */
export function useDeviceApps(deviceId: string, enabled: boolean) {
  const linkApi = (window as any).link as LinkApi;
  const [apps, setApps] = useState<DeviceApp[]>(() => readJson<DeviceApp[]>(appsKey(deviceId), []));
  const [pinned, setPinned] = useState<DeviceApp[]>(() => readJson<DeviceApp[]>(pinnedKey(deviceId), []));
  const [loading, setLoading] = useState(false);
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (!linkApi?.requestDeviceApps) return;
    setLoading(true);
    if (loadingTimer.current) clearTimeout(loadingTimer.current);
    // The device may be asleep or not allow this: stop showing "loading" rather than wait forever.
    loadingTimer.current = setTimeout(() => setLoading(false), 8000);
    linkApi.requestDeviceApps(deviceId).catch(() => setLoading(false));
  }, [deviceId, linkApi]);

  useEffect(() => {
    if (!enabled || !linkApi?.onDeviceAppsReceived) return;
    const unsub = linkApi.onDeviceAppsReceived((fromId, list) => {
      if (fromId !== deviceId) return;
      setApps(list);
      writeJson(appsKey(deviceId), list);
      // Keep a pin's name and icon current with what the device reports.
      setPinned((prev) => {
        const next = prev.map((pin) => list.find((a) => a.package === pin.package) ?? pin);
        writeJson(pinnedKey(deviceId), next);
        return next;
      });
      setLoading(false);
      if (loadingTimer.current) clearTimeout(loadingTimer.current);
    });
    refresh();
    return () => {
      unsub?.();
      if (loadingTimer.current) clearTimeout(loadingTimer.current);
    };
  }, [deviceId, enabled, linkApi, refresh]);

  const isPinned = useCallback((pkg: string) => pinned.some((p) => p.package === pkg), [pinned]);

  const togglePin = useCallback(
    (app: DeviceApp) => {
      setPinned((prev) => {
        const next = prev.some((p) => p.package === app.package)
          ? prev.filter((p) => p.package !== app.package)
          : [...prev, app];
        writeJson(pinnedKey(deviceId), next);
        return next;
      });
    },
    [deviceId],
  );

  const launch = useCallback(
    (pkg: string) => {
      linkApi?.launchDeviceApp?.(deviceId, pkg)?.catch(() => {});
    },
    [deviceId, linkApi],
  );

  return { apps, pinned, loading, refresh, isPinned, togglePin, launch };
}
