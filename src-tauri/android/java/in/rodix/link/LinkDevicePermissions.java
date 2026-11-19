package in.rodix.link;

// Per-device permission store, the Java port of core/permissions.rs. Stored in
// device-permissions.json as { deviceId: { permKey: bool } }, the same layout as desktop.

import android.content.Context;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class LinkDevicePermissions {
    private static final String FILE_NAME = "device-permissions.json";

    private static File file(Context context) {
        return new File(context.getFilesDir(), FILE_NAME);
    }

    /** Mirrors PermissionStore::check() in core/permissions.rs; an unset key is denied. */
    public static boolean check(Context context, String deviceId, String permKey) {
        // Low-risk features are always on and have no toggle; mirrors UNGATED_KEYS in permissions.rs.
        switch (permKey) {
            case "lock": case "systemvolume": case "mpris": case "presenter":
            case "touchpad": case "flashlight": case "dnd":
                return true;
            default:
                break;
        }
        try {
            JSONObject all = getAll(context);
            JSONObject devPerms = all.optJSONObject(deviceId);
            if (devPerms != null && devPerms.has(permKey)) {
                return devPerms.optBoolean(permKey, false);
            }
        } catch (Exception ignored) {}
        return false;
    }

    public static void deletePermissionsForDevice(Context context, String deviceId) {
        try {
            JSONObject all = getAll(context);
            if (all.has(deviceId)) {
                all.remove(deviceId);
                setAll(context, all);
                android.util.Log.i("LinkDevicePermissions", "[Link] Deleted all stored permissions for device " + deviceId.substring(0, Math.min(8, deviceId.length())));
            }
        } catch (Exception e) {
            android.util.Log.e("LinkDevicePermissions", "Failed to delete permissions for device", e);
        }
    }

    // In-memory copy of the file, replaced by setAll(). check() runs per peer on every gated
    // broadcast (LinkPlugin.broadcastToPermittedPeers), so it must not hit the disk each time.
    private static JSONObject cache = null;

    public static JSONObject getAll(Context context) {
        if (cache != null) return cache;
        try {
            File f = file(context);
            if (!f.exists()) {
                cache = new JSONObject();
                return cache;
            }
            String content = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            cache = new JSONObject(content);
            return cache;
        } catch (Exception e) {
            cache = new JSONObject();
            return cache;
        }
    }

    public static void setAll(Context context, JSONObject permissions) {
        try {
            Files.write(file(context).toPath(), permissions.toString(2).getBytes(StandardCharsets.UTF_8));
            cache = permissions;
        } catch (Exception e) {
            android.util.Log.e("LinkDevicePermissions", "Failed to write permissions", e);
        }
    }

    /** Seeds a device's permissions for every key in LinkCapabilitiesSchema.ALL_PERMISSION_KEYS,
     *  keeping any values already stored. Called on pairing, when a trusted device with no stored
     *  permissions connects, and on each initial sync so keys added later get a value. Every new
     *  key defaults to allowed. */
    public static void initializeDeniedPermissionsForNewDevice(Context context, String deviceId) {
        try {
            JSONObject all = getAll(context);
            JSONObject existing = all.optJSONObject(deviceId);
            JSONObject perms = new JSONObject();

            for (String key : LinkCapabilitiesSchema.ALL_PERMISSION_KEYS) {
                if (existing != null && existing.has(key)) {
                    perms.put(key, existing.getBoolean(key));
                } else {
                    perms.put(key, true);
                }
            }
            all.put(deviceId, perms);
            setAll(context, all);
        } catch (Exception e) {
            android.util.Log.e("LinkDevicePermissions", "Failed to initialize permissions for device", e);
        }
    }

    /** Whether this device's clipboard may be sent to the peer. Receiving is governed by the
     *  peer's own permission for this device. Mirrors the "clipboard" check in core/host.rs. */
    public static boolean canSendClipboardTo(Context context, String deviceId) {
        return check(context, deviceId, "clipboard");
    }
}
