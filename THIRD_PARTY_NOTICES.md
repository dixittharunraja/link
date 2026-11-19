# Third-party notices

Link itself is licensed GPL-3.0-only (see `LICENSE`). It uses and bundles the software below. Each part keeps its own
licence. The entries here are from each project's published terms; **check them again before a release**, especially
for anything that is shipped as a binary.

## Bundled with the Windows installer (`vendor/`)

| Component | What it is used for | Licence | Where |
| --- | --- | --- | --- |
| Softcam (tshino) | The "Link Virtual Camera" DirectShow filter, used on Windows 10 (Windows 11 uses `link-vcam-mf` below). Built from source with only its display name changed. | MIT | `vendor/softcam/` (licence text in `LICENSE.txt`), <https://github.com/tshino/softcam> |
| WinFsp | Mounts a phone's storage as a Windows drive. | GPL-3.0 with a FLOSS exception | <https://winfsp.dev> |
| ViGEmBus | The virtual game controller for the joystick tool. | BSD-3-Clause (upstream project is archived) | <https://github.com/nefarius/ViGEmBus> |
| Virtual Display Driver (VirtualDrivers) | The virtual monitor behind Second Screen, switched on only while a phone uses it. Bundled unmodified from the signed 24.12.24 release; the signature is by SignPath Foundation. | MIT | `vendor/vdd/` (licence text in `LICENSE.txt`), <https://github.com/VirtualDrivers/Virtual-Display-Driver> |
| `link-fs-driver` | Link's own WinFsp driver, built from `native/link-fs-driver`. | GPL-3.0-only (part of Link) | `native/link-fs-driver/` |
| `link-vcam-mf` | Link's Windows 11 virtual camera for Media Foundation apps, built from `native/link-vcam`. Its structure follows VCamSample (Simon Mourier, MIT, licence text in `native/link-vcam/LICENSE.VCamSample.txt`). | GPL-3.0-only (part of Link) | `native/link-vcam/`, <https://github.com/smourier/VCamSample> |

## Android app

| Component | Licence |
| --- | --- |
| stream-webrtc-android (a build of Google's WebRTC) | Apache-2.0 (WebRTC itself is BSD-3-Clause) |
| Bouncy Castle (`bcpkix`) | MIT |
| Java-WebSocket | MIT |
| Shizuku API and provider | Apache-2.0 |
| AndroidX libraries and Material Components | Apache-2.0 |

## Desktop app

| Component | Licence |
| --- | --- |
| Tauri and its plugins | MIT or Apache-2.0 |
| webrtc-rs (`webrtc`) | MIT or Apache-2.0 |
| OpenH264 | The source is BSD-2-Clause. Link does not include it: it downloads Cisco's own binary (version 2.7.0) on first use, under Cisco's terms (<https://www.openh264.org>). The `openh264` crate is only the loader. |
| Opus (through `audiopus`) | BSD-3-Clause |
| React and Vite | MIT |

**H.264 and patents:** H.264 is covered by patents in many countries. Cisco covers the licence fees for the OpenH264
binaries it builds and hosts, provided a product downloads them onto the user's device instead of shipping or compiling
its own. Link follows that: it downloads Cisco's file on first use (after asking), verifies it against a pinned
SHA-256, and never bundles it. That cover is limited to Cisco's binary and does not guarantee every possible claim
(see Cisco's FAQ). A phone's own hardware encoder and Windows' WebView decoder are covered by their vendors. This is
not legal advice; get your own if you distribute commercially.

## Full lists

- **Rust crates:** every dependency and its licence is listed in `src-tauri/Cargo.lock` and can be produced with
  `cargo about` or `cargo license`. Generate that list for each release.
- **npm packages:** see `package-lock.json`; `npx license-checker --production` prints the licences.
- **Fonts and icons:** check the licence of anything under `src/` that is not code before a release.
