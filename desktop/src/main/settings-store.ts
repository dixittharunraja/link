// Tiny shared helper for the handful of single-value app settings persisted as their own small
// JSON file in configDir (discovery visibility, pause-music-enabled, screensaver-inhibit-enabled).
// Previously each of these duplicated the same try/read/parse and mkdir/write boilerplate inline
// in main.ts — this collapses that to one call per setting, at both load and save time.

import * as fs from 'fs';
import * as path from 'path';

/** Reads `configDir/fileName`, returns `data[key]` if present, otherwise `defaultValue`. Any
 * read/parse failure (missing file, corrupt JSON) is swallowed and treated as "use the default". */
export function loadSetting<T>(configDir: string, fileName: string, key: string, defaultValue: T): T {
  try {
    const filePath = path.join(configDir, fileName);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data[key] !== undefined) return data[key] as T;
    }
  } catch (err) {
    console.error(`[Link] Failed to load setting ${key} from ${fileName}:`, err);
  }
  return defaultValue;
}

/** Writes `{ [key]: value }` to `configDir/fileName`, creating configDir if needed. */
export function saveSetting(configDir: string, fileName: string, key: string, value: unknown) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const filePath = path.join(configDir, fileName);
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {}
    }
    existing[key] = value;
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Link] Failed to save setting ${key} to ${fileName}:`, err);
  }
}

export interface BlocklistEntry {
  id: string; // deviceId or IP address
  label: string; // Friendly name or IP label
  type: 'device' | 'ip';
  blockedAt: number;
  // Known only when available at the moment of blocking (e.g. rejecting an incoming pair
  // request, whose identity carries it) — undefined for IP-only guest blocks, where there's no
  // device identity at all. Lets the Blocklist UI show the same phone/desktop icon "Nearby
  // Discovered Devices" uses, falling back to a generic icon when unknown.
  deviceType?: string;
  ip?: string;
}

export function loadBlocklist(configDir: string): BlocklistEntry[] {
  try {
    const filePath = path.join(configDir, 'blocklist.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(data.entries)) {
        return data.entries as BlocklistEntry[];
      }
    }
  } catch (err) {
    console.error('[Link] Failed to load blocklist:', err);
  }
  return [];
}

export function saveBlocklist(configDir: string, entries: BlocklistEntry[]) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'blocklist.json'),
      JSON.stringify({ entries }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('[Link] Failed to save blocklist:', err);
  }
}

