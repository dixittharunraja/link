link-fs-driver.exe and winfsp-msil.dll are built here from native/link-fs-driver by
`npm run build:windows` (or `node scripts/build.mjs driver`). They are not committed.

Building them needs the .NET 8 SDK and WinFsp installed (WinFsp provides winfsp-msil.dll).
The Windows installer bundles this folder; the app finds the driver here when run from source.
