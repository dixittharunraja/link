#!/usr/bin/env node
// Publishes a built version of Link as a GitHub release.
//
//   npm run build:all            build first (or build:windows and build:android)
//   npm run release -- --dry-run show what would be published, change nothing
//   npm run release              publish v<version> (version from package.json)
//   npm run release -- --legacy  also replace the downloads on the old shared releases repo
//
// What it does:
//   - takes the installer and both APKs straight from the build output, and refuses files built before
//     the current commit, so a stale build cannot be published by mistake
//   - checks each APK is signed with the official key (fingerprint in README.md)
//   - creates release v<version> on the Link repository, at the commit you are on
//     (that commit must already be pushed, so the release matches public source)
//   - uploads the files under fixed names, so these links always give the newest version:
//       https://github.com/<owner>/<repo>/releases/latest/download/link-desktop-setup.exe
//       https://github.com/<owner>/<repo>/releases/latest/download/link.apk      (phone, 64-bit ARM)
//       https://github.com/<owner>/<repo>/releases/latest/download/link-tv.apk   (TV, 64- and 32-bit ARM)
//   - adds SHA256SUMS and puts the checksums and the signing-key fingerprint in the notes
//
// It never overwrites a published release: to fix one, bump the version and publish again.
// Token: GITHUB_TOKEN or GH_TOKEN, or the GitHub CLI's login (gh auth token).
// Flags: --dry-run, --legacy, --allow-dirty (publish with uncommitted changes),
//        --allow-other-key (the APK is signed with a key other than the official one).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'dixittharunraja';
const REPO = 'link';
// The old shared download repository the website used before Link had its own releases.
const LEGACY_REPO = 'releases';
const LEGACY_TAG = 'latest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Where `tauri build` and `tauri android build` leave their outputs (see scripts/build.mjs).
const installerDir = path.join(root, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle', 'nsis');
// build.mjs copies each APK here under its published name.
const apkDir = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'link-release');
const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: false });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------- files

function findArtifacts() {
  // A build older than the commit being released may not contain it.
  const commitTime = Number(run('git', ['log', '-1', '--format=%ct'])) * 1000;
  const check = (file, what, command) => {
    if (!fs.existsSync(file)) fail(`No ${what} for ${version} (${path.relative(root, file)}). Run: ${command}`);
    if (commitTime && fs.statSync(file).mtimeMs < commitTime) {
      fail(`The ${what} was built before the current commit, so it may not contain it. Run: ${command}`);
    }
    return file;
  };
  return [
    {
      file: check(path.join(installerDir, `Link_${version}_x64-setup.exe`), 'Windows installer', 'npm run build:windows'),
      name: 'link-desktop-setup.exe',
      label: 'Windows installer',
    },
    { file: check(path.join(apkDir, 'link.apk'), 'Android phone APK', 'npm run build:android'), name: 'link.apk', label: 'Android phone' },
    { file: check(path.join(apkDir, 'link-tv.apk'), 'Android TV APK', 'npm run build:android'), name: 'link-tv.apk', label: 'Android TV (also 32-bit phones)' },
  ];
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------- signing key

function officialFingerprint() {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  return /\b((?:[0-9A-F]{2}:){31}[0-9A-F]{2})\b/.exec(readme)?.[1] ?? null;
}

function java() {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', exe),
    process.platform === 'win32' && path.join('C:\\Program Files\\Android\\Android Studio\\jbr\\bin', exe),
    process.platform === 'darwin' && '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? 'java';
}

// apksigner.jar from the newest installed Android build-tools.
function apksignerJar() {
  const sdk = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : path.join(os.homedir(), 'Android', 'Sdk'),
  ].find((p) => p && fs.existsSync(path.join(p, 'build-tools')));
  if (!sdk) return null;
  const versions = fs.readdirSync(path.join(sdk, 'build-tools'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions.map((v) => path.join(sdk, 'build-tools', v, 'lib', 'apksigner.jar')).find((j) => fs.existsSync(j)) ?? null;
}

// The SHA-256 fingerprint (AA:BB:...) of the certificate the APK is signed with, or null if apksigner is
// unavailable. Release APKs use APK Signature Scheme v2+, which keytool cannot read, so this uses apksigner.
function apkFingerprint(apk) {
  const jar = apksignerJar();
  const out = jar ? run(java(), ['-jar', jar, 'verify', '--print-certs', apk]) : null;
  const hex = out ? /certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(out)?.[1] : null;
  return hex ? hex.toUpperCase().match(/../g).join(':') : null;
}

// ---------------------------------------------------------------- git and GitHub

function token() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || run('gh', ['auth', 'token']);
}

function api(auth) {
  const headers = {
    Authorization: `Bearer ${auth}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'link-release-script',
  };
  return async (method, url, body) => {
    const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, data: text ? JSON.parse(text) : null };
  };
}

function upload(uploadUrl, file, name, auth, contentType, retries = 3) {
  const url = new URL(uploadUrl.replace(/\{\?.*\}$/, ''));
  url.searchParams.set('name', name);
  const size = fs.statSync(file).size;
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth}`,
          'Content-Type': contentType,
          'Content-Length': size,
          'User-Agent': 'link-release-script',
        },
        timeout: 300000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300
          ? resolve(JSON.parse(data))
          : reject(new Error(`upload of ${name} failed: HTTP ${res.statusCode} ${data}`))));
      });
      req.on('timeout', () => req.destroy(new Error('connection timed out')));
      req.on('error', (err) => {
        if (left > 0) {
          console.log(`    network error (${err.message}), retrying in 3s`);
          setTimeout(() => attempt(left - 1), 3000);
        } else reject(err);
      });
      fs.createReadStream(file).pipe(req);
    };
    attempt(retries);
  });
}

// ---------------------------------------------------------------- notes

function changelogSection() {
  const file = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = text.search(new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start).split('\n').slice(1).join('\n');
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function releaseNotes(assets, fingerprint) {
  const base = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}`;
  const lines = [];
  const changes = changelogSection();
  if (changes) lines.push(changes, '');
  lines.push('### Downloads', '');
  for (const a of assets) lines.push(`- ${a.label}: [${a.name}](${base}/${a.name})`);
  lines.push('', '### Checksums (SHA-256)', '', '```');
  for (const a of assets) lines.push(`${a.hash}  ${a.name}`);
  lines.push('```', '');
  if (fingerprint) {
    lines.push('### Android signing certificate (SHA-256)', '', '```', fingerprint, '```', '');
    lines.push('Both APKs use this key. Check it with `apksigner verify --print-certs link.apk` (or `link-tv.apk`).', '');
    lines.push('Use `link.apk` on phones and `link-tv.apk` on Android TV and TV sticks. The TV one also runs on phones, including 32-bit ones.', '');
  }
  lines.push('The Windows installer is not code-signed yet, so SmartScreen shows "Unknown publisher".');
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`\nLink ${tag}${dryRun ? '  (dry run: nothing is changed)' : ''}\n`);

  const assets = findArtifacts().map((a) => ({ ...a, hash: sha256(a.file), size: fs.statSync(a.file).size }));
  for (const a of assets) {
    console.log(`  ${a.label}: ${path.relative(root, a.file)} -> ${a.name} (${(a.size / 1048576).toFixed(1)} MB)`);
  }

  // Every APK must be signed with the official key, or devices will refuse it as an update (and the
  // phone and TV builds could not update each other).
  const official = officialFingerprint();
  let actual = null;
  for (const apk of assets.filter((a) => a.name.endsWith('.apk'))) {
    const key = apkFingerprint(apk.file);
    if (!key) {
      console.log(`\n  apksigner (Android SDK build-tools) or Java not found, so ${apk.name}'s signature was not checked.`);
      continue;
    }
    if (official && key !== official && !flags.has('--allow-other-key')) {
      fail(`${apk.name} is signed with a different key than the official one in README.md:\n  ${key}\nUse --allow-other-key if that is intended.`);
    }
    if (actual && key !== actual) fail(`link.apk and link-tv.apk are signed with different keys, so neither could update the other.`);
    actual = key;
    console.log(`\n  ${apk.name} signing key: ${key}${key === official ? ' (official)' : ''}`);
  }
  const fingerprint = actual ?? official;

  // A release must match public source: a clean tree, at a commit that is already on GitHub.
  const commit = run('git', ['rev-parse', 'HEAD']);
  if (!commit) fail('Not a git repository, or there are no commits yet.');
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
  if (dirty && !flags.has('--allow-dirty')) {
    fail('There are uncommitted changes, so the build may not match any commit. Commit and push first (or use --allow-dirty).');
  }
  console.log(`  Commit: ${commit}`);

  const sumsFile = path.join(os.tmpdir(), `link-${version}-SHA256SUMS`);
  fs.writeFileSync(sumsFile, assets.map((a) => `${a.hash}  ${a.name}\n`).join(''));
  const notes = releaseNotes(assets, fingerprint);

  if (dryRun) {
    console.log(`\nWould create release ${tag} on ${OWNER}/${REPO} with these notes:\n`);
    console.log(notes.replace(/^/gm, '    '));
    if (flags.has('--legacy')) console.log(`\nWould also replace the downloads on ${OWNER}/${LEGACY_REPO} (tag "${LEGACY_TAG}").`);
    console.log('');
    return;
  }

  const auth = token();
  if (!auth) fail('No GitHub token. Set GITHUB_TOKEN, or log in with the GitHub CLI (gh auth login).');
  const gh = api(auth);

  const onGitHub = await gh('GET', `/repos/${OWNER}/${REPO}/commits/${commit}`);
  if (!onGitHub.ok) fail(`Commit ${commit.slice(0, 7)} is not on GitHub yet. Push it first.`);

  const existing = await gh('GET', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  if (existing.ok) fail(`Release ${tag} already exists: ${existing.data.html_url}\nBump the version in package.json to publish a new one.`);

  // Created as a draft so nobody sees a half-uploaded release; published once every file is up.
  console.log(`\nCreating release ${tag} on ${OWNER}/${REPO}...`);
  const created = await gh('POST', `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: tag,
    target_commitish: commit,
    name: `Link ${tag}`,
    body: notes,
    draft: true,
    prerelease: false,
  });
  if (!created.ok) fail(`Could not create the release: HTTP ${created.status} ${JSON.stringify(created.data)}`);
  const release = created.data;

  try {
    for (const a of assets) {
      console.log(`  uploading ${a.name}`);
      await upload(release.upload_url, a.file, a.name, auth, 'application/octet-stream');
    }
    console.log('  uploading SHA256SUMS');
    await upload(release.upload_url, sumsFile, 'SHA256SUMS', auth, 'text/plain');
  } catch (err) {
    fail(`${err.message}\nThe release was left as a draft: ${release.html_url}\nDelete the draft and run this again.`);
  }

  const published = await gh('PATCH', `/repos/${OWNER}/${REPO}/releases/${release.id}`, { draft: false, make_latest: 'true' });
  if (!published.ok) fail(`Uploaded, but could not publish the draft: HTTP ${published.status}. Publish it on GitHub: ${release.html_url}`);
  console.log(`\nPublished: ${published.data.html_url}`);

  if (flags.has('--legacy')) await mirrorToLegacy(gh, auth, assets);
  console.log('');
}

// Replaces the downloads (link-desktop-setup.exe, link.apk, link-tv.apk) on the old shared releases repo, for links that still point there.
async function mirrorToLegacy(gh, auth, assets) {
  console.log(`\nMirroring to ${OWNER}/${LEGACY_REPO} (tag "${LEGACY_TAG}")...`);
  const rel = await gh('GET', `/repos/${OWNER}/${LEGACY_REPO}/releases/tags/${LEGACY_TAG}`);
  if (!rel.ok) {
    console.log(`  No "${LEGACY_TAG}" release there (HTTP ${rel.status}); skipped.`);
    return;
  }
  for (const a of assets) {
    const old = rel.data.assets.find((x) => x.name === a.name);
    if (old) await gh('DELETE', `/repos/${OWNER}/${LEGACY_REPO}/releases/assets/${old.id}`);
    console.log(`  uploading ${a.name}`);
    await upload(rel.data.upload_url, a.file, a.name, auth, 'application/octet-stream');
  }
  console.log(`  Done: ${rel.data.html_url}`);
}

main().catch((err) => fail(err.stack || String(err)));
