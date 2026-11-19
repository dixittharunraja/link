
# Link

Your devices, connected. No cloud. No accounts. No compromise.

Link is a local-network device integration layer that connects your Android phone and Windows PC into a single seamless mesh — sharing clipboards, streaming files at full LAN speed, mirroring notifications, using your phone as a webcam, and giving you real-time remote control over each device from any other.

Everything runs peer-to-peer over TLS on your home or office network. Nothing leaves your LAN unless you turn on **Use Tailscale when away** (off by default; see below). The other exception is optional: on a PC without a hardware video encoder, or the first time you use a phone as this PC's webcam, Link asks before downloading Cisco's small H.264 video component (see below).

**Away from home.** Devices on the same network always connect directly and never need the internet. If you turn on **Use Tailscale when away** in Settings, Link reconnects through [Tailscale](https://tailscale.com) when a paired device is not on your network, and moves back to the LAN by itself when you return. It needs the Tailscale app installed and signed in on both devices, and it uses internet data while away. Link adds no server or account of its own, and the connection is still pinned to the device's certificate.

---

## Download

- **Windows 10/11 (64-bit):** [link-desktop-setup.exe](https://github.com/dixittharunraja/link/releases/latest/download/link-desktop-setup.exe)
- **Android phone (Android 10 or newer):** [link.apk](https://github.com/dixittharunraja/link/releases/latest/download/link.apk)
- **Android TV and TV sticks (Android 10 or newer):** [link-tv.apk](https://github.com/dixittharunraja/link/releases/latest/download/link-tv.apk).
  It is the same app built for 32-bit devices too, which many TVs are; on an older 32-bit phone, use this one as well.

These links always give the newest version. Every version, with its changes and SHA-256 checksums, is on the
[releases page](https://github.com/dixittharunraja/link/releases). To check the APK, compare its signing certificate
with the fingerprint under **Signing** below.

---

## What it does

- **Clipboard sync** — Copy on your phone, paste on your PC. Instantly, in both directions. Works for text, images, and files.
- **Notification mirroring** — Every phone notification appears on your desktop. Includes inline reply directly from the PC.
- **File system mount & explorer** — Browse your phone's storage as a native Windows drive (Z:) through Explorer, or from Link's own file explorer. Drag, drop, open, edit.
- **Remote control** — View and control a device's screen from another, in either direction. Video is H.264 over WebRTC, signalled over the encrypted control channel. Also: use your phone as a touchpad, a keyboard, a presenter clicker, or a drawing tablet over an ultra-low-latency UDP relay.
- **Phone as a webcam** — Your phone's camera becomes a virtual camera on Windows (**Link Virtual Camera**) that Zoom, Chrome, Teams, OBS and any other DirectShow app can pick. It works on demand: the phone's camera only turns on while an app is actually using it, so it costs no battery or bandwidth otherwise. Zoom, mirror and fit/fill are adjustable, and you can choose which phone to use.
- **Audio relay** — Stream your PC's system audio to your phone in real time over the local network.
- **Remote microphone** — Use your phone's microphone as an audio input on Windows (through a virtual audio cable) — works with Zoom, Discord, and any other app that reads from an audio device.
- **Walkie-talkie** — Voice calls between your devices over WebRTC.
- **Joystick** — Use your phone as a virtual Xbox controller on Windows.
- **Media control** — Control media playback on any device from any other. Your PC automatically pauses when your phone rings.
- **Device actions** — Lock screens, trigger alarms, toggle flashlight and DND, adjust volume — all remotely.
- **Web portal** — Send and receive files with any device that has a browser, without installing anything, using a PIN.
- **Speed test** — Measure real LAN throughput between devices using raw binary payloads.

### Permissions

Every paired device has its own permission switches. Simple controls (lock, volume, media, flashlight, DND, presenter and touchpad) are always allowed between your own devices. Sensitive features — clipboard sync, file access, remote input and control, run command, telephony and notification mirroring — can be switched off per device. Using a phone's **camera** is the one permission that is off until you turn it on, because nothing on the phone asks first.

---

## Architecture

Link forms a **decentralized N-to-N mesh**. There is no hub, no relay server, no coordinator. Every device is equal.

**Pairing is done once.** Your devices form a **Trusted Pool** — a set of your own devices that all trust each other. Trust is established by transitive introduction. When a new device joins by pairing with _any_ existing member (one PIN — the human gate), that member automatically syncs its trust list to the newcomer, enrolling it. The rest of the pool automatically learns the new member's cert and trusts it — no second pairing. Removing a device propagates a pool-wide unpair request that instructs all active members to drop the device and purge its configuration, returning it to a stranger state.

**The transport is TLS everywhere.** Self-signed certificates, pinned on first contact (Trust-on-First-Use), verified on every subsequent connection. Mismatched fingerprints abort immediately.

**High-throughput transfers use ephemeral binary channels.** File transfers, clipboard payloads, and speed tests bypass JSON entirely — the sender opens a short-lived TLS server on a random port, the receiver connects directly and pulls raw bytes. This is what allows Link to actually saturate your LAN rather than fighting JSON overhead.

**Input events go over UDP.** Mouse movement, presenter pointer, and digitizer coordinates are sent over UDP instead of the TCP control channel. The result is frame-accurate, zero-jitter control with no head-of-line blocking.

**Screen and camera video go over WebRTC.** The offer, answer and ICE candidates travel inside the existing TLS control channel, and the video itself is H.264 sent peer-to-peer over the LAN. No STUN or TURN server is involved.

**The H.264 encoder is downloaded, not bundled.** H.264 is covered by patents. Cisco pays the licence fees for its OpenH264 binaries on the condition that they are downloaded onto the user's own machine, so Link does not ship or compile its own copy. Screen sharing encodes on the PC's GPU (NVIDIA, AMD or Intel, through Media Foundation), so most PCs never need it. Link asks for it only when the PC has no working hardware encoder (a VM, for example) or when a phone's camera is used as this PC's webcam (the PC decodes that stream). It then downloads Cisco's library over HTTPS, checks it against a pinned SHA-256, and stores it in the app's data folder. Viewing a phone's screen never needs it. It is also available under Settings.

**The desktop app is a Rust core with a web UI.** The protocol, discovery, transfers, input injection and screen capture live in Rust (`src-tauri/src/core`). The React/TypeScript interface (`src`) runs in the system WebView and talks to it through Tauri commands. On Android the same interface runs against a Java implementation of the protocol (`src-tauri/android/java`).

---

## How it compares

Link is built from the ground up as a native-feeling, high-performance local network suite:

| Feature                      | Legacy Solutions           | Link                                                                                                  |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Platform**                 | Heavy native/Qt runtimes   | Tauri 2 desktop client with a Rust core + Tauri/Android mobile client                                 |
| **Topology**                 | Primarily 1-to-1 pairing   | N-to-N decentralized mesh; a Trusted Pool where pairing any one device auto-meshes it with all others |
| **Input transport**          | Jittery TCP streams        | Custom UDP relay — zero jitter, frame-accurate                                                        |
| **Screen and camera video**  | Not supported / cloud relayed | H.264 over WebRTC straight between your devices; the camera runs only while something uses it    |
| **File transfer throughput** | Small chunk buffers        | Raw binary channels with 128 KB buffers for maximum LAN bandwidth                                     |
| **Digitizer**                | Basic relative mapping     | Absolute landscape-mapped coordinates, stable on lift                                                 |
| **Audio**                    | Not supported / restricted | System audio relay + phone-as-virtual-mic (Remote Microphone)                                         |
| **Windows install**          | Bulky runtime dependencies | One installer that also sets up the drive, gamepad and virtual camera drivers when they are missing   |
| **Protocol**                 | Standard peer protocol     | Secure peer-to-peer wire format with mesh extensions                                                  |

---

## Stack

| Layer            | Technology                                                                  |
| ---------------- | --------------------------------------------------------------------------- |
| Desktop app      | Tauri 2 · Rust core · React + TypeScript UI (Vite) · WebView2               |
| Mobile app       | Tauri Android · Java · same React UI                                        |
| Transport        | TLS 1.3 (self-signed, pinned) · UDP · WebRTC (screen and camera video)      |
| Video            | H.264 — hardware encoder on the PC (Cisco's OpenH264, downloaded on first use, only when it has none) and on the phone |
| File system      | WinFsp driver (C#) on the PC · TLS WebSocket file server on the phone       |
| Input injection  | Win32 mouse/keyboard APIs (Rust)                                            |
| Virtual devices  | ViGEmBus (gamepad) · Softcam DirectShow filter (camera) and, on Windows 11, the Media Foundation link-vcam · a virtual audio cable (microphone) |

---

## Getting started

### Prerequisites

- **Node.js** 20 or newer.
- **Rust** (stable, 1.90 or newer) — <https://rustup.rs>.
- **Windows:** Visual Studio Build Tools with the C++ workload, the WebView2 runtime, and **CMake** (the Opus audio library is built from source).
  (With CMake 4 or newer the build script sets `CMAKE_POLICY_VERSION_MINIMUM=3.5` for you.)
  The drive feature's WinFsp driver is C#, so building the installer also needs the **.NET 8 SDK** and **WinFsp**.
- **Android (to build the phone app):** Android Studio (its bundled JDK), the Android SDK and an NDK, `rustup target add aarch64-linux-android`, Windows **Developer Mode** turned on (the build creates symbolic links), and a signing key (see **Signing** below).

After installing a tool, open a fresh terminal — the old one keeps the old PATH.

### Run and build

```bash
npm install
npm run doctor             # checks this machine and tells you exactly what is missing

npm run dev                # desktop app with hot reload (Tauri dev)
npm run build:windows      # Windows installer (also rebuilds the drive driver when its code changed)
npm run build:android      # signed Android APK
npm run build:all          # both
npm run clean              # delete build output (add --deep to drop the Rust cache too)
```

`npm run doctor` checks Node, Rust, the C++ build tools, CMake, the .NET SDK and WinFsp (when the drive driver needs
building), the Android SDK and NDK, the Android Rust target, Windows Developer Mode and the signing key. The build script also puts Cargo and CMake on PATH when they are
installed but missing from it, and sets `CMAKE_POLICY_VERSION_MINIMUM` for you, so those two common first-build
failures are handled.

`npm run install:windows` runs the installer just built, and `npm run install:android` installs the built APK over adb
(USB debugging on).

### Signing

The Android release APK must be signed, and a phone only accepts an update signed with the **same key** as the installed
app. Create your key once:

```bash
npm run signing:create -- --name Link --org <your org> --country <two-letter code>
```

This makes a 4096-bit RSA key valid for 30 years in `~/.link-signing/` (outside the repository), with a random password in
`src-tauri/gen/android/keystore.properties` (git-ignored). **Back up the key file and the password in two separate offline
places.** If you lose either, no installed copy can ever be updated. Anyone building Link themselves should use their own
key; release APKs are identified by the certificate fingerprint.

The official release key (owner `CN=Link, O=Rodix, C=IN`) has this SHA-256 fingerprint. Compare it with the
output of `apksigner verify --print-certs link.apk` (from the Android SDK build-tools; `keytool` cannot read APKs
that only use the newer signature schemes):

```
53:C2:FC:7E:49:6B:58:61:CA:CD:26:92:C6:D0:96:E0:52:FD:BD:39:46:C7:B9:70:61:00:BB:51:B4:EB:69:AC
```

The Windows installer is a separate matter: it needs a code-signing certificate (Authenticode), which is not the
Android key. Until the installer is signed, Windows SmartScreen shows "Unknown publisher". Free signing for open-source
projects is available through SignPath Foundation or Azure Trusted Signing; once you have a certificate, configure it in
`bundle.windows` in `src-tauri/tauri.conf.json`.

### Releasing

1. Set the new version in `package.json` (and `version` in `src-tauri/Cargo.toml`), and move the **Unreleased**
   notes in `CHANGELOG.md` under a heading for that version.
2. Commit and push.
3. `npm run build:all` — builds the installer and both APKs for that commit.
4. `npm run release -- --dry-run` to check, then `npm run release`.

The release script takes the files straight from the build output (and refuses ones built before the current commit),
creates release `v<version>` at the pushed commit, uploads the files as `link-desktop-setup.exe`,
`link.apk` (phone, 64-bit ARM) and `link-tv.apk` (TV, 64- and 32-bit ARM) with a `SHA256SUMS` file, and writes the
changelog, checksums and signing-key fingerprint into the notes. It refuses to overwrite an existing release, to publish
uncommitted or unpushed code, or to publish an APK signed with a key other than the one above. The app's update check
offers a TV `link-tv.apk` and a phone `link.apk`. It needs a GitHub token (`GITHUB_TOKEN`, or `gh auth login`). The app's
**Check for updates** reads the newest release from the same place.

### Drivers the app can use

The Windows installer sets these up when they are missing (they are bundled under `vendor/`):

- **WinFsp** — mounts the phone's storage as a drive.
- **ViGEmBus** — the virtual controller for the joystick tool.
- **Softcam** (`vendor/softcam`) — the "Link Virtual Camera". When running unpacked, the app registers it the first time you turn the virtual webcam on, behind one administrator prompt.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (how to help and what CI checks), [SECURITY.md](SECURITY.md) (how to report a vulnerability), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Authors & Acknowledgements

- **Author**: Dixit Tharun Raja P
- **Company**: Rodix

Link uses a secure, custom peer-to-peer protocol.

The virtual camera uses [Softcam](https://github.com/tshino/softcam) by tshino (MIT licence, see `vendor/softcam/LICENSE.txt`), built with only its display name changed.

---

## License

GPL-3.0-only. See [`LICENSE`](LICENSE).
