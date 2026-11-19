#!/usr/bin/env node
// Installs the release APK on every connected Android device at the same time.
//
//   npm run install:android
//
// Devices that are unauthorized or offline are skipped with a warning.
// Exits non-zero if no device is connected or any install fails.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
const adbName = process.platform === "win32" ? "adb.exe" : "adb";
const bundled = join(sdk, "platform-tools", adbName);
const adb = existsSync(bundled) ? bundled : "adb";
const apk = "src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk";

if (!existsSync(apk)) {
  console.error(`APK not found: ${apk}\nBuild it first (npm run build:android).`);
  process.exit(1);
}

const list = spawnSync(adb, ["devices"], { encoding: "utf8" });
if (list.error || list.status !== 0) {
  console.error(`Could not run adb (${adb}): ${list.error?.message || list.stderr}`);
  process.exit(1);
}

const devices = [];
for (const line of list.stdout.split(/\r?\n/).slice(1)) {
  const [serial, state] = line.trim().split(/\s+/);
  if (!serial) continue;
  if (state === "device") devices.push(serial);
  else console.warn(`Skipping ${serial}: ${state}`);
}

if (devices.length === 0) {
  console.error("No authorized Android devices connected.");
  process.exit(1);
}

console.log(`Installing on ${devices.length} device(s): ${devices.join(", ")}`);

const run = (serial) =>
  new Promise((resolve) => {
    const p = spawn(adb, ["-s", serial, "install", "-r", apk]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => resolve({ serial, ok: false, out: e.message }));
    p.on("close", (code) => resolve({ serial, ok: code === 0 && /Success/.test(out), out: out.trim() }));
  });

const results = await Promise.all(devices.map(run));
for (const r of results) {
  console.log(`${r.ok ? "OK  " : "FAIL"} ${r.serial}${r.ok ? "" : `\n${r.out}`}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
