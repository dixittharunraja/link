## What this changes

<!-- One purpose per pull request. Say why, not only what. -->

## How it was tested

<!-- Many Link features need two real devices. Say which devices and OS versions you used. -->

- [ ] `npx tsc --noEmit -p .`, `npm run lint` and `npm test` pass
- [ ] `cargo test --lib --manifest-path src-tauri/Cargo.toml` passes (if Rust changed)
- [ ] Tried on a real device (if the phone app or a device feature changed)

## Checklist

- [ ] Anything that exposes data or acts on a device is behind a per-device permission, checked on the exposed device
- [ ] Nothing runs in the background unless it is being used
- [ ] No keys, keystores, tokens or personal paths are included
