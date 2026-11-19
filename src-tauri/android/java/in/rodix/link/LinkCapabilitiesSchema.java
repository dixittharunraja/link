package in.rodix.link;

// Permission and capability keys shared across the Android code. Desktop's counterpart is
// core/permissions.rs.

public class LinkCapabilitiesSchema {

    // Every per-device permission key on either platform. Used to seed a new pairing's
    // permissions (see LinkDevicePermissions.initializeDeniedPermissionsForNewDevice).
    public static final String[] ALL_PERMISSION_KEYS = {
        "fileaccess", "lock", "runcommand", "presenter", "flashlight", "touchpad",
        "systemvolume", "mpris", "telephony", "notification", "notificationMirroring", "dnd", "clipboard", "remoteinput", "remotecontrol", "camera", "location"
    };

    // Packet types this device supports.
    public static final String[] CAPABILITIES = {
        "link.clipboard", "link.clipboard.connect", "link.battery", "link.findmydevice.request",
        "link.runcommand", "link.runcommand.request", "link.presenter",
        "link.systemvolume", "link.systemvolume.request", "link.lock", "link.lock.request",
        "link.touchpad.request", "link.mpris", "link.mpris.request",
        "link.telephony", "link.telephony.request", "link.notification", "link.notification.reply",
        "link.flashlight", "link.dnd", "link.rename", "link.rename.request",
        "link.digitizer.session", "link.digitizer", "link.remoteinput.send",
        "link.remotecontrol.signal", "link.remotecontrol.input", "link.location.request", "link.location"
    };

    // Capabilities announced to peers via link.capabilities. A key missing here keeps the
    // matching control hidden on the peer even when the permission is granted. Keep the shared
    // keys in sync with IMPLEMENTED_KEYS in core/permissions.rs.
    public static final String[] GATED_CAPABILITY_KEYS = {
        "presenter", "touchpad", "systemvolume", "mpris", "lock", "runcommand", "remoteinput", "fileaccess", "flashlight", "dnd", "remotecontrol", "camera", "location"
    };

    private LinkCapabilitiesSchema() {
    }
}
