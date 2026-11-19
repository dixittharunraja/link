# link-fs-driver

WinFsp file system that mounts a paired phone as a drive letter. It turns every file operation into
an HTTP call against the loopback API in `src-tauri/src/core/mount.rs`.

`npm run build:windows` builds it when the sources change (or build it alone with `node scripts/build.mjs driver`).
That needs the .NET 8 SDK and WinFsp installed (WinFsp provides `winfsp-msil.dll`). The script runs
`dotnet publish` and copies `link-fs-driver.exe` and `winfsp-msil.dll` to `vendor/link-fs-driver/`, which the
installer bundles. The exe is a trimmed, compressed single file (about 12 MB); `winfsp-msil.dll` stays beside it
because WinFsp reads its own file path.
