# joystick-helper

Native Windows helper for the Joystick plugin. Talks to ViGEmBus (via the `Nefarius.ViGEm.Client`
NuGet package) to emulate up to 4 virtual Xbox 360 controllers, one per connected phone.

This project is **not** built at runtime like `touchpad.ts`'s `mouse-helper.cs` — `csc.exe` (the
compiler bundled with Windows/.NET Framework, used for that helper) cannot resolve NuGet packages.
Instead, build it once with the .NET SDK and commit the output binary to
`desktop/vendor/joystick-helper/joystick-helper.exe`.

## Prerequisites

- [.NET 8 SDK](https://dotnet.microsoft.com/download) (not just the runtime)
- [ViGEmBus driver](https://github.com/ViGEm/ViGEmBus/releases) installed locally, for testing

## Build

```
cd desktop/native/joystick-helper
dotnet publish -c Release -o out
```

Copy `out/joystick-helper.exe` to `desktop/vendor/joystick-helper/joystick-helper.exe`, then
regenerate its pinned hash and update `JOYSTICK_HELPER_PINNED_SHA256` in
`desktop/src/core/plugins/joystick.ts`:

```
certutil -hashfile desktop\vendor\joystick-helper\joystick-helper.exe SHA256
```

Rebuild and re-vendor only when `Program.cs` or the `Nefarius.ViGEm.Client` package version
changes — this is a developer-time step, never something an end user needs to do.
