link-vcam-mf.dll is built here from native/link-vcam by `node scripts/build.mjs vcam`. It is not committed.

Building it needs Visual Studio's C++ build tools, CMake and the Windows 11 SDK (10.0.22000 or newer).
The Windows installer registers it (regsvr32) so Windows' camera service can load it.
