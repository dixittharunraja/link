#!/usr/bin/env node
// Creates the key that signs the Android release APK, and the keystore.properties file the build reads.
//
//   npm run signing:create -- [--name Link] [--org Rodix] [--country IN] [--dir <folder>] [--years 30]
//
// The key file goes OUTSIDE the repository (default: ~/.link-signing/link-release.jks) so it cannot be committed or
// removed by a clean. keystore.properties (git-ignored) goes next to the Gradle project and points at it. The
// password is random and is written only to that file.
//
// IMPORTANT: Android only accepts an update signed with the same key as the installed app. Create this once, keep
// two offline backups of the .jks file AND its password, and never lose or share it. Anyone who builds Link
// themselves should make their own key; the published fingerprint tells users which key a release was signed with.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidProject = path.join(root, 'src-tauri', 'gen', 'android');
const propsFile = path.join(androidProject, 'keystore.properties');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const name = opt('name', 'Link');
const org = opt('org', 'Rodix');
const country = opt('country', 'IN');
const years = Number(opt('years', '30'));
const dir = path.resolve(opt('dir', path.join(os.homedir(), '.link-signing')));
const keyFile = path.join(dir, 'link-release.jks');

function findKeytool() {
  const exe = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
  const homes = [
    process.env.JAVA_HOME,
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/opt/android-studio/jbr',
  ].filter(Boolean);
  for (const home of homes) {
    const candidate = path.join(home, 'bin', exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return exe; // hope it is on PATH
}

if (fs.existsSync(keyFile) || fs.existsSync(propsFile)) {
  console.error(`
A signing key or keystore.properties already exists:
  ${fs.existsSync(keyFile) ? keyFile : propsFile}

Creating a new key would make existing installs impossible to update. If you really want a new one, move the old
files somewhere safe first.
`);
  process.exit(1);
}

if (!/^[A-Za-z]{2}$/.test(country)) {
  console.error('--country must be a two-letter code such as IN.');
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });
const password = crypto.randomBytes(24).toString('base64url');
const dname = `CN=${name}, O=${org}, C=${country.toUpperCase()}`;

const result = spawnSync(
  findKeytool(),
  [
    '-genkeypair',
    '-keystore', keyFile,
    '-alias', 'link',
    '-keyalg', 'RSA',
    '-keysize', '4096',
    '-validity', String(Math.round(years * 365)),
    '-dname', dname,
    '-storepass', password,
    '-keypass', password,
  ],
  { encoding: 'utf8' }
);

if (result.status !== 0) {
  console.error(`keytool failed:\n${result.stderr || result.stdout || result.error}`);
  process.exit(1);
}

fs.writeFileSync(propsFile, `storeFile=${keyFile.replace(/\\/g, '/')}\nstorePassword=${password}\nkeyAlias=link\nkeyPassword=${password}\n`);
try {
  fs.chmodSync(keyFile, 0o600);
  fs.chmodSync(propsFile, 0o600);
} catch {
  /* not supported on every file system */
}

const info = spawnSync(findKeytool(), ['-list', '-v', '-keystore', keyFile, '-storepass', password], { encoding: 'utf8' }).stdout ?? '';
const fingerprint = /SHA256:\s*([0-9A-F:]+)/i.exec(info)?.[1] ?? '(run keytool -list -v to read it)';

console.log(`
Signing key created.

  Key file:    ${keyFile}
  Settings:    ${path.relative(root, propsFile)}   (git-ignored; holds the password)
  Owner:       ${dname}
  Valid for:   ${years} years, RSA 4096
  SHA-256:     ${fingerprint}

Now:
  1. Back up the .jks file and the password (two separate offline places). If either is lost you can never
     update an installed copy.
  2. Publish the SHA-256 fingerprint above in your README and release notes so people can verify the APK.
  3. Build with: npm run build:android
`);
