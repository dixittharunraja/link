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

    /** Mirrors desktop's checkDevicePermission() — defaults to allowed if unset. */
    public static boolean check(Context context, String deviceId, String permKey) {
        try {
            JSONObject all = getAll(context);
            JSONObject devPerms = all.optJSONObject(deviceId);
            if (devPerms != null && devPerms.has(permKey)) {
                return devPerms.optBoolean(permKey, true);
            }
        } catch (Exception ignored) {}
        return true;
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

    // Every per-device-gated permission key that exists anywhere in the app (both platforms
    // combined) — mirrors desktop main.ts's ALL_PERMISSION_KEYS, used only to seed a brand-new
    // pairing with everything OFF by default. check()'s own "unset means allowed" default above
    // is left untouched for already-paired devices predating this change.
    private static final String[] ALL_PERMISSION_KEYS = {
        "fileaccess", "lock", "runcommand", "presenter", "flashlight", "touchpad", "digitizer",
        "systemvolume", "mpris", "telephony", "notification", "dnd", "clipboard",
    };

    /** Called once, right when a NEW pairing completes — writes an explicit all-denied
     * permissions record for that device, so the user has to deliberately opt each permission in
     * via the Permissions dialog rather than every gated feature being silently available by
     * default the moment a new device pairs. Mirrors desktop's
     * initializeDeniedPermissionsForNewDevice() in main.ts. */
    public static void initializeDeniedPermissionsForNewDevice(Context context, String deviceId) {
        try {
            JSONObject all = getAll(context);
            JSONObject denied = new JSONObject();
            for (String key : ALL_PERMISSION_KEYS) {
                denied.put(key, false);
            }
            all.put(deviceId, denied);
            setAll(context, all);
        } catch (Exception e) {
            android.util.Log.e("LinkDevicePermissions", "Failed to initialize default-denied permissions", e);
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
