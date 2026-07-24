# Link

Your devices, connected. No cloud. No accounts. No compromise.

Link is a local-network device integration layer that connects your Android phone and Windows PC into a single seamless mesh — sharing clipboards, streaming files at full LAN speed, mirroring notifications, and giving you real-time remote control over each device from any other.

Everything runs peer-to-peer over TLS on your home or office network. Nothing leaves your LAN.

---

## What it does

- **Clipboard sync** — Copy on your phone, paste on your PC. Instantly, in both directions. Works for text, images, and files.
- **Notification mirroring** — Every phone notification appears on your desktop. Includes inline reply directly from the PC.
- **File system mount** — Browse your phone's storage as a native Windows drive (Z:) through Explorer. Drag, drop, open, edit.
- **Remote control** — Use your phone as a touchpad, a presenter clicker (with gyroscope tilt), or a drawing tablet. All over an ultra-low-latency UDP relay.
- **Audio relay** — Stream your PC's system audio to your phone in real time over the local network.
- **Remote microphone** — Use your phone's microphone as a virtual audio input on Windows — works with Zoom, Discord, and any other app that reads from an audio device.
- **Media control** — Control media playback on any device from any other. Your PC automatically pauses when your phone rings.
- **Device actions** — Lock screens, trigger alarms, toggle flashlight and DND, adjust volume — all remotely.
- **Speed test** — Measure real LAN throughput between devices using raw binary payloads.

---

## Architecture

Link forms a **decentralized N-to-N mesh**. There is no hub, no relay server, no coordinator. Every device is equal.

**Pairing is done once.** Your devices form a **Trusted Pool** — a set of your own devices that all trust each other. Trust flows through a single shared **owner key** (a per-person Ed25519 root of trust), not peer-to-peer or through blind authority. When a new device joins by pairing with *any* existing member (one PIN — the human gate), that member hands it the owner key and issues it an owner-signed **membership certificate** binding its TLS identity to the pool. Every other member then auto-trusts it by verifying that certificate against the owner key it already holds — no second pairing. Removing a device owner-signs a revocation that propagates across the pool.

**The transport is TLS everywhere.** Self-signed certificates, pinned on first contact (Trust-on-First-Use), verified on every subsequent connection. Mismatched fingerprints abort immediately.

**High-throughput transfers use ephemeral binary channels.** File transfers, clipboard payloads, and speed tests bypass JSON entirely — the sender opens a short-lived TLS server on a random port, the receiver connects directly and pulls raw bytes. This is what allows Link to actually saturate your LAN rather than fighting JSON overhead.

**Input events go over UDP.** Mouse movement, presenter pointer, and digitizer coordinates are sent via UDP on port 1717 instead of the TCP control channel. The result is frame-accurate, zero-jitter control with no head-of-line blocking.

---

## How it compares

Link started as a study of [KDE Connect](https://kdeconnect.kde.org) — the best prior art in this space. Over time it diverged substantially in architecture, transport, and implementation. Here is where it stands:

| | KDE Connect | Link |
|---|---|---|
| **Platform** | Qt / C++ desktop, native Android | Electron + TypeScript desktop, Capacitor + native Android |
| **Topology** | Primarily 1-to-1 pairing | N-to-N decentralized mesh; a Trusted Pool where pairing any one device auto-meshes it with all others |
| **Input transport** | TCP (control channel) | UDP relay — zero jitter, frame-accurate |
| **File transfer throughput** | Limited by JSON framing and small buffers | Raw binary channels, 128 KB buffers → fills your LAN |
| **Digitizer** | Basic relative mapping | Absolute landscape-mapped coordinates, stable on lift |
| **Audio** | Basic | System audio relay + phone-as-virtual-mic (Remote Microphone) |
| **Windows install** | Requires KDE runtime dependencies | Self-contained Electron binary |
| **Protocol** | KDE Connect wire format | KDE Connect-compatible wire format with extensions |

---

## Stack

| Layer | Technology |
|---|---|
| Desktop app | Electron · TypeScript · Node.js |
| Mobile app | Capacitor · Android Java |
| Transport | TLS 1.3 (self-signed, pinned) · UDP |
| File system | WebDAV-over-WSS · rclone mount |
| Input injection | Win32 mouse/keyboard APIs · C# helper |

---

## Acknowledgements

Link would not exist without KDE Connect. Their protocol design, feature thinking, and years of real-world testing gave us a solid foundation to build from. We diverged significantly — but we started from a great place because of their work.

**KDE Connect** — Albert Vaca Cintora and contributors. [kdeconnect.kde.org](https://kdeconnect.kde.org)

No KDE Connect source code is included in or distributed with this project.

---

## License

GPL-2.0. See `LICENSE`.


