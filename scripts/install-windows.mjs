// Runs the Windows installer that `npm run build:windows` produced. The wizard handles the
// administrator prompt and a running copy of the app.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = join('src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle', 'nsis');
let installers = [];
try {
  installers = readdirSync(dir).filter((f) => f.endsWith('-setup.exe')).map((f) => join(dir, f));
} catch {}
if (installers.length === 0) {
  console.error('No installer found. Run `npm run build:windows` first.');
  process.exit(1);
}
const newest = installers.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
console.log(`Installing ${newest}`);
const result = spawnSync('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${newest}' -Wait`], { stdio: 'inherit' });
process.exit(result.status ?? 1);
