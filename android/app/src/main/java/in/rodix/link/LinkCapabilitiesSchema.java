package in.rodix.link;

// Centralized permission/capability keys and metadata.
// Mirrors desktop's capabilities-schema.ts.

public class LinkCapabilitiesSchema {

    // Every per-device-gated permission key that exists anywhere in the app (both platforms
    // combined). Used to seed a brand-new pairing with everything OFF by default.
    public static final String[] ALL_PERMISSION_KEYS = {
        "fileaccess", "lock", "runcommand", "presenter", "flashlight", "touchpad",
        "systemvolume", "mpris", "telephony", "notification", "notificationMirroring", "dnd", "clipboard", "remoteinput", "remotecontrol"
    };

    // Packet type strings for all supported capabilities.
    public static final String[] CAPABILITIES = {
        "link.clipboard", "link.clipboard.connect", "link.battery", "link.findmydevice.request",
        "link.runcommand", "link.runcommand.request", "link.presenter",
        "link.systemvolume", "link.systemvolume.request", "link.lock", "link.lock.request",
        "link.connectivity", "link.touchpad.request", "link.mpris", "link.mpris.request",
        "link.telephony", "link.telephony.request", "link.notification", "link.notification.reply",
        "link.flashlight", "link.dnd", "link.rename", "link.rename.request",
        "link.digitizer.session", "link.digitizer", "link.remoteinput.send",
        "link.remotecontrol.signal", "link.remotecontrol.stream", "link.remotecontrol.input"
    };

    // Permissions announced to peers so a control shows up on THEIR device (mirrors desktop's
    // GATED_CAPABILITY_KEYS in capabilities-schema.ts — keep both lists in sync). flashlight was
    // missing here, which meant this device never told a peer it supports link.flashlight, so the
    // Flashlight button stayed hidden on the peer's control panel even after granting the
    // permission — the same silent-hide bug the other entries here exist to avoid.
    public static final String[] GATED_CAPABILITY_KEYS = {
        "presenter", "touchpad", "systemvolume", "mpris", "lock", "runcommand", "remoteinput", "fileaccess", "flashlight", "remotecontrol"
    };

    private LinkCapabilitiesSchema() {
        // Utility class, non-instantiable
    }
}
