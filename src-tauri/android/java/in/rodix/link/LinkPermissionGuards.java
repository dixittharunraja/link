package in.rodix.link;

import android.content.Context;
import android.util.Log;

// Consolidated permission checking helpers to eliminate repeated guard patterns.
// Mirrors desktop's permission-guards.ts.

public class LinkPermissionGuards {
    private static final String TAG = "LinkPermissionGuards";

    // Guard pattern: check permission, log if denied, return true only if allowed.
    // Usage: if (!guardPermission(context, deviceId, "presenter", "Presenter packet")) return;
    public static boolean guardPermission(Context context, String deviceId, String permKey, String featureName) {
        if (!LinkDevicePermissions.check(context, deviceId, permKey)) {
            Log.i(TAG, "[Link] Blocked " + featureName + " from " + deviceId + " (Permission disabled)");
            return false;
        }
        return true;
    }

    // Simpler version that just checks, for use in conditional logic without logging.
    public static boolean hasPermission(Context context, String deviceId, String permKey) {
        return LinkDevicePermissions.check(context, deviceId, permKey);
    }

    private LinkPermissionGuards() {
        // Utility class, non-instantiable
    }
}
