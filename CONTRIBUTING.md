# Contributing to Link

Thanks for helping. This page covers how to set up, what we check, and what a good change looks like.

## Getting set up

The README's **Getting started** section lists the prerequisites (Node, Rust, the Windows C++ build tools and CMake,
and for the phone app the Android SDK, NDK and a signing keystore) and the commands.

```bash
npm install
npm run dev            # desktop app with hot reload
```

## Before you open a pull request

Run the checks that CI runs:

```bash
npx tsc --noEmit -p .                               # TypeScript
npm run lint                                        # ESLint
npm test                                            # UI unit tests (Vitest)
cargo test --lib --manifest-path src-tauri/Cargo.toml  # Rust unit tests (Windows; needs CMake, see the README)
```

The Rust tests cover trust, permissions, pairing codes, wire parsing and the virtual camera. A few tests that need
the network are marked `#[ignore]`; run them with `cargo test --lib -- --ignored` when you change that code.
If you change something that must agree with the Android side (the pairing code or the pool hash), keep the fixed
test vectors in `src-tauri/src/core/tests/` passing; they were computed independently of the Rust code.

If you touched the Android code under `src-tauri/android`, also build it once with `npm run build:android` and, if you
can, try the change on a real phone. Many Link features need two real devices, so please say in the pull request what
you tested and on what.

## What makes a change easy to review

- **One purpose per pull request.** A bug fix, a feature, or a clean-up, not all three.
- **Explain why**, not only what. Comments in the code should say why something is done a certain way.
- **Keep the design.** The protocol and permission model are described in the README. If a change needs
  to alter them, open an issue first so we can talk about it.
- **No new always-on background work.** Link should cost nothing when nothing is using it. Features that use the
  camera, the microphone or the screen must start only when asked and stop when done.
- **Permissions matter.** Anything that exposes data or acts on a device must be behind a per-device permission, and
  the check must happen on the device that is exposed, not only in the other device's UI.
- **Match the surrounding style.** `.editorconfig` and ESLint cover the basics.

## Versions

The version is written in `package.json` only; the desktop app, the Android app and the in-app update check all read
it from there (also keep `version` in `src-tauri/Cargo.toml` in step). Record user-visible changes under
**Unreleased** in `CHANGELOG.md`. Maintainers publish releases as described in the README's **Releasing** section.

## Reporting bugs and asking for features

Use the issue templates. For a bug, the app version, the Windows and Android versions, and the relevant lines from the
log are the most useful things. On Windows the log is `%LOCALAPPDATA%\in.rodix.link\logs\Link.log`.

**Security problems must not go in public issues.** See `SECURITY.md`.

## Licence

Link is GPL-3.0-only. By contributing you agree that your contribution is licensed under the same terms.
