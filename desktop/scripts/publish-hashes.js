// Supply-chain hardening: publish SHA-256 checksums of the release artifacts so a downloader can
// verify the file they got (or reassembled from parts) is byte-for-byte what we built — catching a
// tampered download page, a swapped part, or a MITM'd transfer. Runs after split-installer.js in
// the build:desktop chain. Emits rodix/public/installers/SHA256SUMS.txt next to the published
// installer parts, and includes the Android APK if a release build is present.
//
// NOTE: this proves integrity (the bytes weren't changed), not authenticity (who built it) — that
// is what code-signing provides. The two are complementary; see docs/backlog.txt security notes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function publishHashes() {
  const distDir = path.join(__dirname, '../dist_electron');
  const outDir = path.resolve(__dirname, '../../../rodix/public/installers');
  const entries = [];

  // 1. Windows installer — hash the full .exe in dist_electron. The parts served from outDir
  //    reassemble to exactly this file, so this is the hash a user verifies after reassembly.
  try {
    const exe = fs.readdirSync(distDir).find((f) => f.endsWith('.exe') && !f.includes('blockmap'));
    if (exe) {
      entries.push([sha256(path.join(distDir, exe)), 'Link-Setup.exe']);
      console.log(`🔒 Hashed Windows installer: ${exe}`);
    } else {
      console.warn('⚠️  No .exe installer found in dist_electron/ — skipping.');
    }
  } catch (err) {
    console.warn(`⚠️  Could not hash Windows installer: ${err.message}`);
  }

  // 2. Android APK — include the release build if it exists (built separately via Gradle).
  const apkCandidates = [
    path.resolve(__dirname, '../../mobile/android/app/build/outputs/apk/release/app-release.apk'),
    path.resolve(__dirname, '../../../rodix/public/link.apk'),
  ];
  for (const apk of apkCandidates) {
    if (fs.existsSync(apk)) {
      entries.push([sha256(apk), path.basename(apk)]);
      console.log(`🔒 Hashed Android APK: ${path.basename(apk)}`);
      break;
    }
  }

  if (entries.length === 0) {
    console.warn('⚠️  No artifacts to hash — nothing published.');
    return;
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  // sha256sum-compatible format: "<hash>  <name>" (two spaces), so users can verify with the
  // standard `sha256sum -c SHA256SUMS.txt` tool.
  const body = entries.map(([hash, name]) => `${hash}  ${name}`).join('\n') + '\n';
  const outFile = path.join(outDir, 'SHA256SUMS.txt');
  fs.writeFileSync(outFile, body);
  console.log(`🏁 Wrote ${entries.length} checksum(s) to ${outFile}`);
}

publishHashes();
