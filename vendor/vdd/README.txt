Virtual Display Driver 24.12.24, x64, unmodified (MIT, see LICENSE.txt). It is the virtual monitor
Second Screen extends onto. The driver DLL and its catalog are signed by SignPath Foundation, so Windows
trusts them without any certificate being installed.

Source: https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/tag/24.12.24
Asset:  Signed-Driver-v24.12.24-x64.zip  (SHA-256 F93E7CE3D640C83C419B1B72D2C83B2D8E34D83E8B7BA11F3328A40D2DA82FA4)

The Windows installer stages this package and registers the LinkDisplayHelper service, which adds the
virtual monitor while a phone is using it and removes it afterwards (src-tauri/src/core/display_helper.rs).
Without these files the installer simply skips the step and Second Screen needs a real second monitor.
