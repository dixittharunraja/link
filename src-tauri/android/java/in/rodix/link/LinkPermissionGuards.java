package in.rodix.link;

import android.content.Context;
import android.util.Log;

// Permission check helpers for incoming feature packets. Desktop's equivalent is
// DeviceManager::allowed() in core/host.rs.

public class LinkPermissionGuards {
    private static final String TAG = "LinkPermissionGuards";

    // Returns whether the device has the permission, logging when it does not.
    // Usage: if (!guardPermission(context, deviceId, "presenter", "Presenter packet")) return;
    public static boolean guardPermission(Context context, String deviceId, String permKey, String featureName) {
        if (!LinkDevicePermissions.check(context, deviceId, permKey)) {
            Log.i(TAG, "[Link] Blocked " + featureName + " from " + deviceId + " (Permission disabled)");
            return false;
        }
        return true;
    }

    // Same check without logging.
    public static boolean hasPermission(Context context, String deviceId, String permKey) {
        return LinkDevicePermissions.check(context, deviceId, permKey);
    }

    // Whether to act on something a peer pushed to this device (its clipboard, its calls). The
    // sender already applied its own permission, so only an explicit "off" stored for that device
    // here refuses it; a device with no stored value keeps working as before. Mirrors
    // DeviceManager::accepts_from() in core/host.rs.
    public static boolean acceptsFrom(Context context, String deviceId, String permKey) {
        try {
            org.json.JSONObject devPerms = LinkDevicePermissions.getAll(context).optJSONObject(deviceId);
            if (devPerms != null && devPerms.has(permKey)) {
                return devPerms.optBoolean(permKey, true);
            }
        } catch (Exception ignored) {}
        return true;
    }

    private LinkPermissionGuards() {
    }
}
