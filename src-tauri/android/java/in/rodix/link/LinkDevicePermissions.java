package in.rodix.link;

// Per-device permission store — Java port of desktop's device-permissions.json handling in
// main.ts. Previously this didn't exist at all on Android: bridge.ts's getPermissions/
// setPermissions only read/wrote browser localStorage in the WebView, which no native code ever
// consulted — every per-device toggle (clipboard, touchpad, flashlight, etc.) was purely
// decorative on this platform. This gives Android the same real, file-backed enforcement desktop
// already has, keyed the same way: { deviceId: { permKey: bool } }.

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

    /** Mirrors desktop's checkDevicePermission() — defaults to false (denied/off) if unset. */
    public static boolean check(Context context, String deviceId, String permKey) {
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

    // In-memory cache, invalidated only by setAll (or process restart) — never by time. check()
    // is now called once per connected peer on every gated broadcast (see
    // LinkPlugin.broadcastToPermittedPeers: MPRIS/notification/telephony/flashlight/dnd/etc.),
    // which previously meant a synchronous Files.readAllBytes of the whole file on every single
    // check. This turns that into a plain object lookup after the first read. Mirrors desktop's
    // permissionsCache in permissions.ts.
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

    // ALL_PERMISSION_KEYS is now imported from LinkCapabilitiesSchema.java — see that file for the
    // authoritative list. Used here only to seed a brand-new pairing with everything OFF by
    // default. check()'s own "unset means allowed" default above is left untouched for already-
    // paired devices predating this change.

    /** Called on NEW pairing and also run on existing devices at app startup (via cache
     * invalidation check in LinkPlugin.initCapabilities) to ensure old all-denied permissions
     * are upgraded to new defaults. Sensitive operations (file access, command execution)
     * default to DENIED requiring opt-in. Common communication features (flashlight, DND,
     * media, lock) default to ALLOWED for better UX. */
    public static void initializeDeniedPermissionsForNewDevice(Context context, String deviceId) {
        try {
            JSONObject all = getAll(context);
            JSONObject existing = all.optJSONObject(deviceId);
            JSONObject perms = new JSONObject();

            for (String key : LinkCapabilitiesSchema.ALL_PERMISSION_KEYS) {
                if (existing != null && existing.has(key)) {
                    perms.put(key, existing.getBoolean(key));
                } else {
                    perms.put(key, false);
                }
            }
            all.put(deviceId, perms);
            setAll(context, all);
        } catch (Exception e) {
            android.util.Log.e("LinkDevicePermissions", "Failed to initialize permissions for device", e);
        }
    }

    /** Can I send my clipboard content to the peer? Clipboard is sending-only, like Telephony/
     * Notification/Flashlight/DND: this device owns its own clipboard, so this only controls
     * whether IT gets sent to that peer — receiving is controlled entirely by the peer's own
     * permission-for-us on their side, not by anything here. Mirrors desktop's
     * canSendClipboardTo() in main.ts. */
    public static boolean canSendClipboardTo(Context context, String deviceId) {
        return check(context, deviceId, "clipboard");
    }
}
