package in.rodix.link;

// Device identity — one per device, generated once, persisted forever.
// Java port of desktop/src/core/identity.ts — keep both in sync; see docs/PROTOCOL.md §4.
//
// Architectural rule: this is the ONE place identity is generated or loaded from disk on this
// device. Everything else (transport, pairing, plugin bridge) reads it from here.

import android.app.UiModeManager;
import android.content.Context;
import android.content.res.Configuration;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public class LinkIdentity {
    public static final int PROTOCOL_VERSION = 1;
    private static final Pattern NAME_INVALID_CHARS = Pattern.compile("[\"',;:.!?()\\[\\]<>]");
    private static final int MAX_NAME_LENGTH = 32;
    private static final Pattern DEVICE_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]{32,38}$");

    /** Plain data shape for a device identity — used both for our own identity and any peer's parsed one. */
    public static class Identity {
        public final String deviceId;
        public String deviceName;
        public final String deviceType;
        public final int protocolVersion;
        public final String[] incomingCapabilities;
        public final String[] outgoingCapabilities;
        public boolean visibility = true;

        public Identity(String deviceId, String deviceName, String deviceType, int protocolVersion,
                         String[] incomingCapabilities, String[] outgoingCapabilities) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.deviceType = deviceType;
            this.protocolVersion = protocolVersion;
            this.incomingCapabilities = incomingCapabilities;
            this.outgoingCapabilities = outgoingCapabilities;
        }

        public JSONObject toJson() throws Exception {
            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId);
            body.put("deviceName", deviceName);
            body.put("deviceType", deviceType);
            body.put("protocolVersion", protocolVersion);
            body.put("incomingCapabilities", new JSONArray(incomingCapabilities));
            body.put("outgoingCapabilities", new JSONArray(outgoingCapabilities));
            body.put("visibility", visibility);
            return body;
        }

        public static Identity fromJson(JSONObject body) {
            List<String> incoming = new ArrayList<>();
            List<String> outgoing = new ArrayList<>();
            JSONArray in = body.optJSONArray("incomingCapabilities");
            JSONArray out = body.optJSONArray("outgoingCapabilities");
            if (in != null) for (int i = 0; i < in.length(); i++) incoming.add(in.optString(i));
            if (out != null) for (int i = 0; i < out.length(); i++) outgoing.add(out.optString(i));

            Identity id = new Identity(
                    body.optString("deviceId", ""),
                    filterDeviceName(body.optString("deviceName", "")),
                    body.optString("deviceType", "unknown"),
                    body.optInt("protocolVersion", 0),
                    incoming.toArray(new String[0]),
                    outgoing.toArray(new String[0]));
            id.visibility = body.optBoolean("visibility", true);
            return id;
        }
    }

    public static String filterDeviceName(String input) {
        String filtered = NAME_INVALID_CHARS.matcher(input).replaceAll("");
        return filtered.length() > MAX_NAME_LENGTH ? filtered.substring(0, MAX_NAME_LENGTH) : filtered;
    }

    public static boolean isValidDeviceId(String id) {
        return id != null && DEVICE_ID_PATTERN.matcher(id).matches();
    }

    private static String generateDeviceId() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static File identityFile(Context context) {
        return new File(context.getFilesDir(), "link-config/identity.json");
    }

    // The standard, documented way to detect Android TV / Google TV at runtime — UiModeManager's
    // current mode reflects the actual running device (TV box, set-top box, Google TV), not just
    // a manifest guess. Previously this was hardcoded to "phone" unconditionally, which meant a
    // Link install running on a real Android TV device always misidentified itself, breaking any
    // TV-only feature gating (e.g. Remote Input's D-pad/Menu capability) at the source.
    private static String detectDeviceType(Context context) {
        try {
            UiModeManager uiModeManager = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
            if (uiModeManager != null && uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) {
                return "tv";
            }
        } catch (Exception ignored) {
        }
        return "phone";
    }

    public static Identity loadOrCreate(Context context, String[] incomingCapabilities, String[] outgoingCapabilities) {
        File file = identityFile(context);
        String storedId = null;
        String storedName = null;

        try {
            if (file.exists()) {
                String raw = new String(Files.readAllBytes(file.toPath()));
                JSONObject obj = new JSONObject(raw);
                String candidateId = obj.optString("deviceId", null);
                if (isValidDeviceId(candidateId)) {
                    storedId = candidateId;
                    storedName = obj.optString("deviceName", null);
                }
            }
        } catch (Exception e) {
            // Corrupt file — fall through and regenerate.
        }

        String deviceType = detectDeviceType(context);

        if (storedId == null) {
            storedId = generateDeviceId();
            String defaultName = Build.MODEL != null ? Build.MODEL : (deviceType.equals("tv") ? "Android TV" : "Android Phone");
            storedName = filterDeviceName(defaultName);
            persist(file, storedId, storedName);
        }

        return new Identity(storedId, storedName, deviceType, PROTOCOL_VERSION, incomingCapabilities, outgoingCapabilities);
    }

    public static String saveDeviceName(Context context, String newName) {
        File file = identityFile(context);
        String filtered = filterDeviceName(newName);
        try {
            String raw = new String(Files.readAllBytes(file.toPath()));
            JSONObject obj = new JSONObject(raw);
            obj.put("deviceName", filtered);
            file.getParentFile().mkdirs();
            try (FileWriter writer = new FileWriter(file)) {
                writer.write(obj.toString(2));
            }
        } catch (Exception e) {
            // Identity file should already exist by the time rename is possible.
        }
        return filtered;
    }

    private static void persist(File file, String deviceId, String deviceName) {
        try {
            file.getParentFile().mkdirs();
            JSONObject obj = new JSONObject();
            obj.put("deviceId", deviceId);
            obj.put("deviceName", deviceName);
            try (FileWriter writer = new FileWriter(file)) {
                writer.write(obj.toString(2));
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to persist identity", e);
        }
    }
}
