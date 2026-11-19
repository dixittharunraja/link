# link-vcam

Link's Windows 11 virtual camera. It is a Media Foundation camera, so the Windows Camera app and Store apps
such as WhatsApp for Windows can see it, which they cannot do with the older DirectShow camera in
`vendor/softcam`; browsers and DirectShow apps see it too.

Windows 11 only (build 22000 or newer): it relies on `MFCreateVirtualCamera`. Link uses it there and keeps
the DirectShow camera for Windows 10 (`src-tauri/src/core/plugins/vcam.rs` chooses). On Windows 11 the
DirectShow camera is removed, because both would show up under the same name.

Tested with: a Media Foundation source reader (found by name, frames read through Frame Server), and Edge's
camera capture (listed, opened at 1280x720 and 30 fps, changing frames).

## How it works

`link-vcam-mf.dll` has two roles.

- **Media source (COM server).** Windows' Frame Server (a service running as LOCAL SERVICE) loads the DLL,
  asks the class factory for the activator, and reads video from its media source: one live NV12 stream,
  1280x720 at 30 fps. The DLL must be registered machine-wide (`regsvr32 link-vcam-mf.dll`, administrator),
  because the service reads the registry of the machine, not of the user.
- **Control library for Link.** Link loads the same DLL and calls `lvcStart` (creates the camera with
  `MFCreateVirtualCamera`), `lvcSendFrameBgr` (one picture), `lvcIsConnected` (an app is using the camera)
  and `lvcStop`. The camera lives only while Link runs.

Frames cross from Link to the service over the named pipe `\\.\pipe\LinkVirtualCamera`, which only the
owner, SYSTEM, administrators and LOCAL SERVICE (read only) can open. The media source shows black until Link
connects and again if Link goes away.

## Layout

| File | Purpose |
| --- | --- |
| `src/dllmain.cpp` | DLL entry points, class factory, registration, the `lvc*` control exports |
| `src/source.cpp` | Activator, media source and media stream |
| `src/feed.cpp` | The frame pipe (both ends) and the BGR to NV12 conversion |
| `test/lvc_test.cpp` | `lvc-test`, a development tool (not shipped) |

## Build

```
node scripts/build.mjs vcam
```

This needs Visual Studio's C++ build tools, CMake and the Windows 11 SDK. The result is
`vendor/link-vcam/link-vcam-mf.dll`. The runtime is linked in, so the DLL depends only on Windows itself.

## Testing

`lvc-test direct` loads the DLL, serves frames through the real pipe and reads them back through a Media
Foundation source reader, with no registration and no Frame Server. `lvc-test list` shows the cameras
Media Foundation and DirectShow each see. With the DLL registered, `lvc-test feed` and `lvc-test read` do the
same through Windows. If `C:\ProgramData\LinkVcamDebug` exists, the DLL writes a log there (development only).

Based on the structure of [VCamSample](https://github.com/smourier/VCamSample) (MIT, see
`LICENSE.VCamSample.txt`) and Microsoft's `MFCreateVirtualCamera` documentation.
