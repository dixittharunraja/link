// Single-value settings persistence helper (discovery visibility, pause-music, screensaver-inhibit).

import * as fs from 'fs';
import * as path from 'path';

// Returns defaultValue if file missing/corrupt.
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

export function saveSetting(configDir: string, fileName: string, key: string, value: unknown) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const filePath = path.join(configDir, fileName);
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {}
    }
    existing[key] = value;
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Link] Failed to save setting ${key} to ${fileName}:`, err);
  }
}

export interface BlocklistEntry {
  id: string;
  label: string;
  type: 'device' | 'ip';
  blockedAt: number;
  deviceType?: string; // For UI icon display.
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

