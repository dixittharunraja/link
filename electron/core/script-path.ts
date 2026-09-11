import * as path from 'path';

// PowerShell scripts are run by powershell.exe — a separate process, not Electron — so they have
// to exist as real files on disk.
//
// In a packaged build everything under dist/ is bundled into app.asar. Electron patches its own
// `fs` to read through that archive, which is why anything using fs keeps working and why this
// never reproduces in `npm run dev` (no asar at all there). powershell.exe has no such patch: it
// sees app.asar as one opaque FILE, so a path like
//   ...\resources\app.asar\dist\scripts\audio-capture.ps1
// names a file inside a file. PowerShell can't load the script and exits 0xFFFD0000
// (4294770688) — a load/parse failure, before a single line of the script runs.
//
// electron-builder's asarUnpack copies matching files back out to app.asar.unpacked/ as ordinary
// files, so rewriting that one path segment gives a path that genuinely exists. In dev the
// segment isn't present and this is a no-op.
//
// This resolves against THIS module's own __dirname (dist/core/) rather than the caller's, so
// every call site gets the same dist/scripts/ location regardless of where it lives.
//
// Requires "dist/scripts/**" to stay listed under build.asarUnpack in package.json — without it
// the scripts stay inside the archive and every one of these spawns fails in the installed app.
export function resolveScriptPath(fileName: string): string {
  const packed = path.join(__dirname, '..', 'scripts', fileName);
  return packed.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}
