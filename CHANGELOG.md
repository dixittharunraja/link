# Changelog

User-visible changes to Link. Versions follow [Semantic Versioning](https://semver.org); while the version is 0.x,
a minor release may change things in ways that are not backward compatible.

## Unreleased

- **Re-pair your devices after updating.** Saved pairings change format (the stored address key is now `lastKnownIp`, and the unused protocol version is gone from the wire), so devices from earlier builds must be paired again.
- Android 10 is now the minimum version.
- Lower idle cost: reconnect and discovery pause when nothing is paired or everything is connected, a still screen is re-encoded less often, and Android camera sharing is capped at 4 Mbps and 30 fps.
- Dead guest and portal connections are now dropped after about 45 seconds of silence.
- **Locate** a paired phone or PC from any other paired device: its position on a map, with how accurate it is (a few
  metres outdoors with a phone's GPS, tens of metres indoors, often more on a PC), plus **Open in Maps** and **Copy**.
  It is on by default and can be switched off per device under **Allow Location**; a phone asks for Android's location
  permission during setup, and a PC needs Windows' Location services on. Each fix is kept as **Last seen**, shown on the device's card even while it is offline.
- Connection status updates faster: a dropped device shows as disconnected within about 12 seconds (was 30), and a
  network change (joining the same Wi-Fi, Tailscale coming up) triggers a reconnect within a few seconds. A phone
  coming home with its screen off reconnects within about 30 seconds (it could take minutes), including on Wi-Fi
  without internet such as a PC's hotspot.
- The virtual webcam no longer has a JPEG fallback: it always receives the phone's camera natively, so it needs the H.264 component.
- A **Recent photos** strip on a connected phone's card on the PC: the newest photos appear as thumbnails, loaded only as you scroll to them and only when you open the card. Nothing is synced or stored; choose **Save**, **Copy** (to the clipboard) or click a photo to open it.
- Send files and folders between paired devices without opening Link. On the phone, share from any app and pick the
  PC (several files at once; each paired device also shows up as a share-sheet shortcut). On the PC, right-click files
  in Explorer, then **Send to**, then the phone. A PC always asks first: **Accept** or **Reject**, then the folder to
  save into, every time. A phone saves straight into its `Link` folder and says so in a notification.

## 0.1.0

First public release.

- Pair an Android phone and Windows PCs into a Trusted Pool: pair once with a PIN, and every device in the pool
  trusts the new one. All traffic is TLS with pinned certificates, on the local network only.
- Clipboard sync, notification mirroring with reply, file transfer, and the phone's storage as a Windows drive.
- Remote control in either direction over WebRTC (H.264), plus touchpad, keyboard, presenter and drawing-tablet modes.
- The phone's camera as a Windows webcam (Link Virtual Camera), running only while an app uses it. On Windows 11 it
  is a Media Foundation camera, so Store apps such as WhatsApp and the Camera app can use it as well as browsers.
- System audio to the phone, the phone's microphone on the PC, walkie-talkie, and the phone as an Xbox controller.
- Media control, lock, ring, flashlight, do-not-disturb and volume on any device from any other.
- Per-device permissions, a browser file portal with a PIN, and a LAN speed test.
