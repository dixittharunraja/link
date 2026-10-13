# link-fs-driver

WinFsp file system that mounts a paired phone as a drive letter. It turns every file operation into
an HTTP call against the loopback API in `src-tauri/src/core/mount.rs`.

Build (needs the .NET 8 SDK and WinFsp installed, for `winfsp-msil.dll`):

    dotnet publish -c Release -r win-x64 -o out

Copy `out/link-fs-driver.exe` and `out/winfsp-msil.dll` to `vendor/link-fs-driver/`. The result is a
trimmed, compressed single file (about 12 MB); `winfsp-msil.dll` stays beside it because WinFsp
reads its own file path.
