# Link: guide for coding agents and contributors

Link is a cross-device suite (Windows PC and Android phone/TV) built on Tauri 2: a React + TypeScript UI, a Rust core
on the desktop, and Java/Kotlin for the Android side. This file is read by AI coding tools. People should start with
`README.md` and `CONTRIBUTING.md`, which this file does not replace.

## Layout

| Path | What lives there |
|---|---|
| `src/` | React UI shared by desktop and phone (`components/`, `hooks/`, `utils/`). `utils/bridge.ts` is the only place that talks to native code: `invoke(...)` on desktop, the Android plugin on the phone. |
| `src-tauri/src/` | Rust core. `core/` holds discovery, pairing, the transport, file server/client, streaming, audio, input, and the plugins. `commands.rs` is the list of commands the UI can call. |
| `src-tauri/android/java/in/rodix/link/` | The Android side: foreground service, discovery, file server, accessibility service, etc. It mirrors `core/` and has to agree with it on the wire. |
| `src-tauri/gen/android/` | Generated Gradle project plus the committed manifest, `build.gradle.kts` and ProGuard rules. |
| `native/` | C# Windows drive driver and the virtual camera. |
| `scripts/` | Build, install, signing and release scripts (`node scripts/build.mjs ...`). |
| `vendor/` | Third-party installers the Windows installer bundles. Do not add built binaries elsewhere. |
| `docs/` | **Ignored by git.** Private notes only; never put anything there that the repo needs. |

## Commands

```bash
npm install
npm run dev                  # desktop app with hot reload
npx tsc --noEmit -p .        # TypeScript
npm run lint                 # ESLint (src only)
npm test                     # Vitest
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --lib --manifest-path src-tauri/Cargo.toml   # Windows, needs CMake
npm run build:android        # when you touched src-tauri/android
npm run knip                 # unused files and exports
npm run dupes                # copy-pasted code
```

Run `tsc`, `lint` and `test` before calling a change done. If a change touches Rust, also run `cargo check`.
A pre-commit hook (husky) runs ESLint on staged files.

## Rules that are easy to get wrong

- **Battery and data matter.** Link must cost almost nothing when idle. No new always-on timers, polling,
  wake locks or infinite CSS animations. Anything that uses the camera, microphone or screen starts only when asked
  and stops when done. Poll only while the page is visible (`useVisibleInterval`).
- **Photos and thumbnails stay small and lazy.** Grids use the device's ~256 px thumbnails, the viewer a ~1280 px
  preview, and the original only on request. Never download whole files just to browse. Keep previews in memory,
  not on disk.
- **Permissions are enforced on the exposed device**, per paired device, not only in the other device's UI.
- **Opening URLs is allow-listed.** `open_external` (Rust) and `openExternal` (Android) accept only the local stream
  address and a few fixed links. Add a link there only for a fixed, known URL, never an arbitrary one.
- **Rust and Java must agree on the wire.** If you change a packet, the pairing code or the pool hash, change both
  sides and keep the fixed test vectors in `src-tauri/src/core/tests/` passing.
- **Files that need an outside app** (video, audio, documents) are handed to the system. If none can open the file,
  suggest VLC (Play Store on a phone, videolan.org on a PC); do not build a player.
- **No other products' names** in code, comments, docs or notices. Only vendors and dependencies Link actually
  ships or uses (listed in `THIRD_PARTY_NOTICES.md`) may be named.
- **Never commit** keystores, `keystore.properties`, `.env*`, `.exe`/`.apk` builds, or anything in `docs/`.
- **Line endings are LF** (`.editorconfig`). Windows editors sometimes write CRLF; Git normalises it, so do not
  "fix" whole files by hand.
- **Versions** live in `package.json`; keep `src-tauri/Cargo.toml` in step. Record user-visible changes under
  **Unreleased** in `CHANGELOG.md`.

## Making a change

One purpose per change. Explain why in comments, not what. Many features need two real devices; say in the
description what you tested and on what, and say clearly what you could not test.
