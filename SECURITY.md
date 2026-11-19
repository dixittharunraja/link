# Security Policy

Link pairs devices, moves files and clipboards between them, and can control a device's screen and camera. A
vulnerability here can be serious, so please report problems privately and give us a chance to fix them before they
are made public.

## Supported versions

Link is pre-1.0. Security fixes are made on the `main` branch and in the latest release only.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. If that
option is not available, open a normal issue that says only "I have a security report" with no details, and a
maintainer will arrange a private channel.

Please include:

- what you found and which part of Link it affects (pairing, the TLS transport, the file system mount, remote control,
  the camera, the browser portal, an Android or Windows component, and so on);
- the version or commit, and the platforms involved;
- steps to reproduce, or a proof of concept;
- what an attacker would gain, and what they need first (for example "an attacker on the same Wi-Fi network").

We aim to acknowledge a report within a few days, and to tell you what we plan to do about it within two weeks. You
will be credited in the fix unless you prefer not to be.

## What is in scope

- Bypassing pairing, the trusted pool, or certificate pinning.
- Reaching a feature (files, clipboard, remote control, camera, run command) without the per-device permission for it.
- Remote code execution, privilege escalation, or reading or writing files outside what a permission allows.
- Weaknesses in the PIN-gated browser portal and guest sessions.
- The bundled Windows components (the installer, the file system driver, the virtual camera registration).

## What is out of scope

- Attacks that need an already-compromised device, or physical access to an unlocked device.
- Denial of service by a device that is already paired and trusted.
- Issues in third-party software we bundle that are not caused by how Link uses it (report those upstream).
  See `THIRD_PARTY_NOTICES.md` for what is bundled.

## Design notes that help when reviewing

- Everything runs on the local network; there is no cloud service or relay.
- Devices authenticate with self-signed certificates pinned on first contact. A changed certificate aborts the
  connection.
- Camera access has no system prompt on the phone, so Link checks a per-device permission on the phone itself, and that
  permission is off until the user turns it on.

## Known design decisions

These are deliberate. They are written down so a reviewer does not have to rediscover them, and so you can tell a
reported issue from an intended trade-off.

- **A paired device starts with every permission on (Windows).** When a device is paired, the PC allows all of its
  per-device permissions, including file access, run command and remote control, and the user can turn each one off
  afterwards. The reasoning is that pairing already requires a PIN, and a device someone paired on purpose is one
  they want to use. The consequence is that a device the user pairs by mistake, or a paired phone that
  is later stolen unlocked, has full reach until the user revokes it. Removing a device from the trusted pool revokes
  everything at once. A change to deny-by-default would be a reasonable hardening and a welcome pull request.
- **The desktop web view has no Content Security Policy.** `tauri.conf.json` sets `csp` to `null`. The window loads
  only the bundled app from disk, with no remote pages and no remote scripts, so the usual cross-site scripting
  route is closed. A strict policy is not applied because the app's inline styles and WebRTC and image sources
  have not been tested under one. A tested policy is a welcome contribution.
- **The release profile keeps unwinding panics** (`panic = "unwind"`). The core relies on a panicking task or thread
  taking down only itself, so a fault in one feature does not close the app. Aborting would turn any such panic into a
  crash of the whole program.
- **A trusted device is trusted.** The threat model does not cover a device that is already paired and then misbehaves
  (see "What is out of scope"). Per-device permissions limit what such a device can reach, but they are not a sandbox.
