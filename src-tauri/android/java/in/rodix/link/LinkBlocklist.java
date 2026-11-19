package in.rodix.link;

// Blocklist of device IDs and IPs, the Java port of the blocklist.json handling in
// core/settings.rs.

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.io.File;

public class LinkBlocklist {
    private static final String FILE_NAME = "blocklist.json";

    private static File file(Context context) {
        return new File(context.getFilesDir(), FILE_NAME);
    }

    // In-memory copy of the file: it is checked for every discovery broadcast, connection and
    // pair request.
    private static JSONArray cache = null;

    public static JSONArray getAll(Context context) {
        if (cache != null) return cache;
        try {
            File f = file(context);
            if (!f.exists()) {
                cache = new JSONArray();
                return cache;
            }
            String content = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            cache = new JSONArray(content);
            return cache;
        } catch (Exception e) {
            cache = new JSONArray();
            return cache;
        }
    }

    private static void setAll(Context context, JSONArray entries) {
        try {
            Files.write(file(context).toPath(), entries.toString(2).getBytes(StandardCharsets.UTF_8));
            cache = entries;
        } catch (Exception e) {
            android.util.Log.e("LinkBlocklist", "Failed to write blocklist", e);
        }
    }

    /** Mirrors is_blocked() in core/settings.rs: a plain string compare. Callers check both the
     *  device ID and the remote IP. */
    public static boolean isBlocked(Context context, String idOrIp) {
        if (idOrIp == null) return false;
        String cleanQuery = idOrIp.replace("::ffff:", "").split(":")[0];
        JSONArray all = getAll(context);
        for (int i = 0; i < all.length(); i++) {
            JSONObject entry = all.optJSONObject(i);
            if (entry != null) {
                String entryId = entry.optString("id");
                String entryIp = entry.optString("ip", null);
                if (cleanQuery.equals(entryId) || idOrIp.equals(entryId) || cleanQuery.equals(entryIp)) return true;
            }
        }
        return false;
    }

    public static void add(Context context, String id, String label, String type) {
        add(context, id, label, type, null, null);
    }

    public static void add(Context context, String id, String label, String type, String deviceType) {
        add(context, id, label, type, deviceType, null);
    }

    public static void add(Context context, String id, String label, String type, String deviceType, String ip) {
        String cleanId = id != null ? id.replace("::ffff:", "").split(":")[0] : null;
        String cleanIp = ip != null ? ip.replace("::ffff:", "").split(":")[0] : null;
        if (cleanId == null) return;
        JSONArray all = getAll(context);
        for (int i = 0; i < all.length(); i++) {
            JSONObject entry = all.optJSONObject(i);
            if (entry != null) {
                String entryId = entry.optString("id");
                String entryIp = entry.optString("ip", null);
                if (cleanId.equals(entryId) || id.equals(entryId) || (cleanIp != null && cleanIp.equals(entryIp))) return;
            }
        }
        try {
            JSONObject entry = new JSONObject();
            entry.put("id", cleanId);
            entry.put("label", label);
            entry.put("type", type);
            entry.put("blockedAt", System.currentTimeMillis());
            if (deviceType != null) entry.put("deviceType", deviceType);
            if (cleanIp != null) entry.put("ip", cleanIp);
            all.put(entry);
            setAll(context, all);
            android.util.Log.i("LinkBlocklist", "Blocked: " + label + " (" + cleanId + ")");
        } catch (Exception e) {
            android.util.Log.e("LinkBlocklist", "Failed to add blocklist entry", e);
        }
    }

    public static void remove(Context context, String id) {
        JSONArray all = getAll(context);
        JSONArray filtered = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject entry = all.optJSONObject(i);
            if (entry != null && !id.equals(entry.optString("id"))) filtered.put(entry);
        }
        setAll(context, filtered);
    }
}
