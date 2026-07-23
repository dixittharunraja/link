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
    fs.writeFileSync(path.join(configDir, fileName), JSON.stringify({ [key]: value }), 'utf8');
  } catch (err) {
    console.error(`[Link] Failed to save setting ${key} to ${fileName}:`, err);
  }
}
