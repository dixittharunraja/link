#!/usr/bin/env node
// One entry point for building Link, so nobody has to remember the per-machine setup.
//
//   npm run doctor          check that this machine can build (prints exactly what is missing)
//   npm run build:windows   build the drive driver (when its sources changed) and the Windows installer
//   npm run build:android   build the signed Android APKs (phone and TV)
//   npm run build:all       both
//   npm run clean           delete build output (add --deep to also delete the Rust build cache)
//
// The outputs stay where Tauri and Gradle put them (printed at the end); npm run release publishes
// them from there.
//
//   node scripts/build.mjs <doctor|driver|windows|android|all|clean> [--deep] [--dry-run]
//
// It also fixes the two things that usually break a first build: it puts Cargo and CMake on PATH when they
// are installed but missing from it, and it sets CMAKE_POLICY_VERSION_MINIMUM so CMake 4 can build Opus.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--')) ?? 'help';
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dryRun = flags.has('--dry-run');

const androidProject = path.join(root, 'src-tauri', 'gen', 'android');
// Two APKs of the same app, same key, so either can update the other:
//   link.apk     64-bit ARM only: every phone Link supports, and the smaller download.
//   link-tv.apk  64- and 32-bit ARM: many Android TVs and TV sticks run 32-bit Android even on a 64-bit chip,
//                and would refuse an APK without a 32-bit library. Also works on 32-bit phones.
// scripts/upload-release.mjs publishes them from this folder (inside the git-ignored build output).
const apkOutDir = path.join(androidProject, 'app', 'build', 'outputs', 'link-release');
const androidApks = [
  { label: 'Android APK (phone)', file: 'link.apk', targets: ['aarch64'] },
  { label: 'Android APK (TV)', file: 'link-tv.apk', targets: ['aarch64', 'armv7'] },
];
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// The WinFsp drive driver is built from source into vendor/, which the installer bundles.
const driverSource = path.join(root, 'native', 'link-fs-driver');
const driverOut = path.join(root, 'vendor', 'link-fs-driver');
const driverFiles = ['link-fs-driver.exe', 'winfsp-msil.dll'];
// The Windows 11 virtual camera (Media Foundation), a C++ DLL built with CMake into vendor/.
const vcamSource = path.join(root, 'native', 'link-vcam');
const vcamOut = path.join(root, 'vendor', 'link-vcam');
const vcamFile = 'link-vcam-mf.dll';
const winfspAssembly = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'WinFsp', 'bin', 'winfsp-msil.dll');

// ---------------------------------------------------------------- environment

function prepareEnv() {
  const env = { ...process.env };
  const sep = isWindows ? ';' : ':';
  const extra = [];
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
  if (fs.existsSync(cargoBin)) extra.push(cargoBin);
  const cmakeBin = isWindows ? 'C:\\Program Files\\CMake\\bin' : '';
  if (cmakeBin && fs.existsSync(cmakeBin)) extra.push(cmakeBin);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [...extra, env[pathKey] ?? ''].join(sep);
  // CMake 4 refuses the old project files that Opus ships with unless told to accept them.
  env.CMAKE_POLICY_VERSION_MINIMUM ??= '3.5';
  return env;
}

const env = prepareEnv();

function run(cmd, cmdArgs, { cwd = root, quiet = false } = {}) {
  return spawnSync(cmd, cmdArgs, { cwd, env, stdio: quiet ? 'pipe' : 'inherit', shell: isWindows, encoding: 'utf8' });
}

function output(cmd, cmdArgs) {
  const r = run(cmd, cmdArgs, { quiet: true });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : null;
}

// ---------------------------------------------------------------- checks

function androidSdk() {
  const candidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    isWindows ? path.join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function canCreateSymlink() {
  // The Android build links the Rust library into the Gradle project; Windows only allows that in Developer Mode.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-symlink-'));
  try {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// keystore.properties must exist and its storeFile must point at a real key file.
function signingKeyExists() {
  const propsFile = path.join(androidProject, 'keystore.properties');
  if (!fs.existsSync(propsFile)) return false;
  const line = fs.readFileSync(propsFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith('storeFile='));
  if (!line) return false;
  return fs.existsSync(path.resolve(androidProject, line.slice('storeFile='.length).trim()));
}

function checks(target) {
  const list = [];
  const add = (name, ok, hint, scope = ['windows', 'android']) => {
    if (target === 'all' || scope.includes(target)) list.push({ name, ok: !!ok, hint });
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('Node.js 20 or newer', nodeMajor >= 20, `Found ${process.versions.node}. Install Node 20+ from https://nodejs.org`);
  add('node_modules installed', fs.existsSync(path.join(root, 'node_modules')), 'Run: npm install');
  add('Rust (cargo)', output('cargo', ['--version']), 'Install Rust from https://rustup.rs, then open a new terminal');

  if (isWindows) {
    const vswhere = path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const vs = fs.existsSync(vswhere) ? output(`"${vswhere}"`, ['-products', '*', '-latest', '-property', 'displayName']) : null;
    add('Visual Studio C++ build tools', vs, 'Install "Build Tools for Visual Studio" with the "Desktop development with C++" workload', ['windows', 'android']);
    add('CMake', output('cmake', ['--version']), 'Install CMake (winget install Kitware.CMake), then open a new terminal');
    // Only needed when the virtual camera DLL has to be (re)built; see vcamIsCurrent().
    if (!vcamIsCurrent()) {
      add('Windows 11 SDK (builds the virtual camera)', vcamSdkHeader(), 'Install the Windows 11 SDK (10.0.22000 or newer) through the Visual Studio Installer', ['windows']);
    }
    // Only needed when the file-system driver has to be (re)built; see driverIsCurrent().
    if (!driverIsCurrent()) {
      add('.NET 8 SDK (builds the drive driver)', /^(8|9|\d{2,})\./m.test(output('dotnet', ['--list-sdks']) ?? ''), 'Install the .NET 8 SDK (winget install Microsoft.DotNet.SDK.8), then open a new terminal', ['windows']);
      add('WinFsp (builds the drive driver)', fs.existsSync(winfspAssembly), 'Install WinFsp from https://winfsp.dev, or run vendor/winfsp/*.msi', ['windows']);
    }
  }

  if (target === 'android' || target === 'all') {
    const sdk = androidSdk();
    add('Android SDK', sdk, 'Install Android Studio, or set ANDROID_HOME to your SDK folder', ['android']);
    const ndkDir = sdk ? path.join(sdk, 'ndk') : '';
    add('Android NDK', ndkDir && fs.existsSync(ndkDir) && fs.readdirSync(ndkDir).length > 0, 'Android Studio > SDK Manager > SDK Tools > NDK (Side by side)', ['android']);
    const targets = output('rustup', ['target', 'list', '--installed']) ?? '';
    add('Rust target aarch64-linux-android', targets.includes('aarch64-linux-android'), 'Run: rustup target add aarch64-linux-android', ['android']);
    add('Rust target armv7-linux-androideabi (TV APK)', targets.includes('armv7-linux-androideabi'), 'Run: rustup target add armv7-linux-androideabi', ['android']);
    if (isWindows) add('Windows Developer Mode (symbolic links)', canCreateSymlink(), 'Settings > System > For developers > Developer Mode', ['android']);
    add('Android signing key', signingKeyExists(), 'Run: npm run signing:create   (then back up the key file and its password)', ['android']);
  }
  return list;
}

function doctor(target) {
  const results = checks(target);
  console.log(`\nChecking this machine for: ${target}\n`);
  for (const r of results) console.log(`  ${r.ok ? '\u2713' : '\u2717'} ${r.name}${r.ok ? '' : `\n      -> ${r.hint}`}`);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nReady to build.\n' : `\n${failed.length} thing(s) to fix before building.\n`);
  return failed.length === 0;
}

// ---------------------------------------------------------------- build

function reportOutput(label, file) {
  console.log(`\n  ${label}: ${path.relative(root, file)}`);
}

function findFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(predicate).map((f) => path.join(dir, f));
}

// The driver is up to date when both output files exist and are newer than every source file.
function driverIsCurrent() {
  const outputs = driverFiles.map((f) => path.join(driverOut, f));
  if (!outputs.every((f) => fs.existsSync(f))) return false;
  const built = Math.min(...outputs.map((f) => fs.statSync(f).mtimeMs));
  const sources = findFiles(driverSource, (f) => f.endsWith('.cs') || f.endsWith('.csproj'));
  return sources.every((f) => fs.statSync(f).mtimeMs <= built);
}

function buildDriver() {
  if (driverIsCurrent()) {
    console.log('\n== Drive driver: up to date ==');
    return true;
  }
  console.log('\n== Drive driver (native/link-fs-driver) ==\n');
  // Published to a scratch folder first so only the two files the app needs reach vendor/.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'link-fs-driver-'));
  try {
    const r = run('dotnet', ['publish', path.join(driverSource, 'LinkFsDriver.csproj'), '-c', 'Release', '-o', tmp]);
    if (r.status !== 0) return false;
    fs.mkdirSync(driverOut, { recursive: true });
    for (const f of driverFiles) {
      if (!fs.existsSync(path.join(tmp, f))) {
        console.error(`dotnet publish did not produce ${f}.`);
        return false;
      }
      fs.copyFileSync(path.join(tmp, f), path.join(driverOut, f));
    }
    console.log(`  Drive driver: ${path.relative(root, driverOut)}`);
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The SDK header that declares MFCreateVirtualCamera; it exists only in SDK 10.0.22000 and newer.
function vcamSdkHeader() {
  const include = path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'Include');
  if (!fs.existsSync(include)) return '';
  const version = fs
    .readdirSync(include)
    .filter((d) => /^10\./.test(d))
    .sort()
    .reverse()
    .find((d) => fs.existsSync(path.join(include, d, 'um', 'mfvirtualcamera.h')));
  return version ? path.join(include, version, 'um', 'mfvirtualcamera.h') : '';
}

function vcamIsCurrent() {
  const out = path.join(vcamOut, vcamFile);
  if (!fs.existsSync(out)) return false;
  const built = fs.statSync(out).mtimeMs;
  const sources = [...findFiles(path.join(vcamSource, 'src'), () => true), path.join(vcamSource, 'CMakeLists.txt'), path.join(vcamSource, 'link-vcam-mf.def')];
  return sources.every((f) => fs.statSync(f).mtimeMs <= built);
}

function buildVcam() {
  if (!isWindows) return true;
  if (vcamIsCurrent()) {
    console.log('\n== Virtual camera: up to date ==');
    return true;
  }
  if (!vcamSdkHeader()) {
    console.error('The Windows 11 SDK (10.0.22000 or newer) is not installed; add it with the Visual Studio Installer.');
    return false;
  }
  console.log('\n== Windows 11 virtual camera (native/link-vcam) ==\n');
  const build = path.join(vcamSource, 'build'); // git-ignored
  // No -G: on Windows CMake picks the newest Visual Studio that is installed. Naming one ("Visual Studio 17 2022")
  // breaks the build on a machine, or a CI image, that has a different version.
  let r = run('cmake', ['-S', vcamSource, '-B', build, '-A', 'x64']);
  if (r.status !== 0) return false;
  r = run('cmake', ['--build', build, '--config', 'Release', '--target', 'link-vcam-mf']);
  if (r.status !== 0) return false;
  const built = path.join(build, 'Release', vcamFile);
  if (!fs.existsSync(built)) {
    console.error(`The build finished but ${vcamFile} was not produced.`);
    return false;
  }
  fs.mkdirSync(vcamOut, { recursive: true });
  fs.copyFileSync(built, path.join(vcamOut, vcamFile));
  console.log(`  Virtual camera: ${path.relative(root, path.join(vcamOut, vcamFile))}`);
  return true;
}

function buildWindows() {
  if (!isWindows) {
    console.error('The Windows installer can only be built on Windows.');
    return false;
  }
  if (!buildDriver() || !buildVcam()) return false;
  console.log('\n== Windows installer ==\n');
  const r = run('npx', ['tauri', 'build', '--target', 'x86_64-pc-windows-msvc']);
  if (r.status !== 0) return false;
  const bundle = path.join(root, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle', 'nsis');
  // Only this version's installer; the bundle folder can still hold ones from older builds.
  const installer = findFiles(bundle, (f) => f === `Link_${version}_x64-setup.exe`)[0];
  if (!installer) {
    console.error(`The build finished but Link_${version}_x64-setup.exe was not found in ${path.relative(root, bundle)}.`);
    return false;
  }
  reportOutput('Windows installer', installer);
  return true;
}

function buildAndroid() {
  const built = path.join(androidProject, 'app', 'build', 'outputs', 'apk', 'universal', 'release', 'app-universal-release.apk');
  // Tauri links each target's library into jniLibs/<abi> and leaves it there, and Gradle packs whatever it
  // finds. Without clearing it, the phone APK would also carry the 32-bit library from an earlier TV build.
  const jniLibs = path.join(androidProject, 'app', 'src', 'main', 'jniLibs');
  fs.mkdirSync(apkOutDir, { recursive: true });
  for (const apk of androidApks) {
    console.log(`\n== ${apk.label}: ${apk.targets.join(' + ')} ==\n`);
    fs.rmSync(jniLibs, { recursive: true, force: true });
    fs.rmSync(built, { force: true });
    const r = run('npx', ['tauri', 'android', 'build', '--apk', ...apk.targets.flatMap((t) => ['--target', t])]);
    if (r.status !== 0) return false;
    if (!fs.existsSync(built)) {
      console.error('The build finished but no APK was found. Check the signing keystore.');
      return false;
    }
    const out = path.join(apkOutDir, apk.file);
    fs.copyFileSync(built, out);
    reportOutput(apk.label, out);
  }
  return true;
}

// ---------------------------------------------------------------- clean

function clean() {
  const targets = [
    'dist',
    'src-tauri/gen/android/app/build',
    'src-tauri/gen/android/.gradle',
    'src-tauri/gen/android/app/src/main/jniLibs',
    'src-tauri/gen/android/app/src/main/java/in/rodix/link/generated',
  ];
  if (flags.has('--deep')) targets.push('src-tauri/target', 'node_modules/.vite');
  console.log(dryRun ? '\nWould delete:\n' : '\nDeleting build output:\n');
  for (const rel of targets) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    console.log(`  ${rel}`);
    if (!dryRun) fs.rmSync(full, { recursive: true, force: true });
  }
  console.log(flags.has('--deep') ? '' : '\n(The Rust build cache was kept. Use --deep to remove it too; the next build will be slow.)');
  console.log('Your keystore and source files are never touched.\n');
}

// ---------------------------------------------------------------- main

function usage() {
  console.log(`Usage: node scripts/build.mjs <command>

  doctor [windows|android]   check this machine (default: both)
  driver                     build the drive driver (native/link-fs-driver) into vendor/
  vcam                       build the Windows 11 virtual camera (native/link-vcam) into vendor/
  windows                    build the drive driver, the virtual camera and the Windows installer
  android                    build the Android APKs: link.apk (phone) and link-tv.apk (TV, also 32-bit)
  all                        build both
  clean [--deep] [--dry-run] delete build output
`);
}

const scope = args.find((a, i) => i > args.indexOf(command) && !a.startsWith('--')) ?? 'all';

switch (command) {
  case 'doctor':
    process.exit(doctor(scope) ? 0 : 1);
    break;
  case 'driver':
    process.exit(buildDriver() ? 0 : 1);
    break;
  case 'vcam':
    process.exit(buildVcam() ? 0 : 1);
    break;
  case 'windows':
    process.exit(doctor('windows') && buildWindows() ? 0 : 1);
    break;
  case 'android':
    process.exit(doctor('android') && buildAndroid() ? 0 : 1);
    break;
  case 'all': {
    if (!doctor(isWindows ? 'all' : 'android')) process.exit(1);
    const okWin = isWindows ? buildWindows() : true;
    const okAndroid = buildAndroid();
    console.log(okWin && okAndroid ? '\nDone. Publish with: npm run release\n' : '\nA build failed; see the output above.\n');
    process.exit(okWin && okAndroid ? 0 : 1);
    break;
  }
  case 'clean':
    clean();
    break;
  default:
    usage();
}
