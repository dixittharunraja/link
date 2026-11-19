package in.rodix.link;

// Device identity: generated once per install and persisted. Java counterpart of
// core/identity.rs; keep both in sync. This is the only place the identity is created or loaded;
// transport, pairing and the plugin bridge read it from here.

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
    private static final Pattern NAME_INVALID_CHARS = Pattern.compile("[\"',;:.!?()\\[\\]<>]");
    private static final int MAX_NAME_LENGTH = 20;
    private static final Pattern DEVICE_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]{32,38}$");

    /** A device identity, either this device's own or a peer's. */
    public static class Identity {
        public final String deviceId;
        public String deviceName;
        public final String deviceType;
        public final String[] incomingCapabilities;
        public final String[] outgoingCapabilities;
        public boolean visibility = true;
        /** The Tailscale address the peer advertised (received identities only). */
        public String tailscaleIp;

        public Identity(String deviceId, String deviceName, String deviceType,
                         String[] incomingCapabilities, String[] outgoingCapabilities) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.deviceType = deviceType;
            this.incomingCapabilities = incomingCapabilities;
            this.outgoingCapabilities = outgoingCapabilities;
        }

        public JSONObject toJson() throws Exception {
            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId);
            body.put("deviceName", deviceName);
            body.put("deviceType", deviceType);
            body.put("incomingCapabilities", new JSONArray(incomingCapabilities));
            body.put("outgoingCapabilities", new JSONArray(outgoingCapabilities));
            body.put("visibility", visibility);
            String tailscale = LinkTailscale.localAddress();
            if (tailscale != null) body.put("tailscaleIp", tailscale);
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
                    incoming.toArray(new String[0]),
                    outgoing.toArray(new String[0]));
            id.visibility = body.optBoolean("visibility", true);
            String advertised = body.optString("tailscaleIp", "");
            id.tailscaleIp = LinkTailscale.isTailscaleAddr(advertised) ? advertised : null;
            return id;
        }
    }

    /** Same rule as filter_device_name in core/identity.rs, for own and received names. */
    public static String filterDeviceName(String input) {
        if (input == null) return "";
        String filtered = NAME_INVALID_CHARS.matcher(input).replaceAll("").replaceAll("\\p{Cntrl}", "");
        if (filtered.length() > MAX_NAME_LENGTH) filtered = filtered.substring(0, MAX_NAME_LENGTH);
        return filtered.trim();
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

    // UiModeManager reports TV mode on Android TV and Google TV devices. The type drives
    // TV-only features on peers, such as Remote Input's D-pad and Menu controls.
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
                    // An existing name from the 32-character days is cut the same way.
                    String stored = filterDeviceName(obj.optString("deviceName", ""));
                    storedName = stored.isEmpty() ? null : stored;
                }
            }
        } catch (Exception e) {
            // Corrupt file: regenerate below.
        }

        String deviceType = detectDeviceType(context);

        if (storedId == null) {
            storedId = generateDeviceId();
            String defaultName = Build.MODEL != null ? Build.MODEL : (deviceType.equals("tv") ? "Android TV" : "Android Phone");
            storedName = filterDeviceName(defaultName);
            persist(file, storedId, storedName);
        }
        // A stored name that filters to nothing keeps the id and gets a plain default.
        if (storedName == null) storedName = deviceType.equals("tv") ? "Android TV" : "Android Phone";

        if (deviceType.equals("tv")) {
            // A TV has no flashlight, and ringing it to find it is pointless (and loud in a living room),
            // so peers are not offered those controls.
            incomingCapabilities = withoutTvUnsupported(incomingCapabilities);
            outgoingCapabilities = withoutTvUnsupported(outgoingCapabilities);
        }

        return new Identity(storedId, storedName, deviceType, incomingCapabilities, outgoingCapabilities);
    }

    private static String[] withoutTvUnsupported(String[] capabilities) {
        java.util.List<String> kept = new java.util.ArrayList<>();
        for (String capability : capabilities) {
            // A TV stays where it is installed and has no GPS, so it is not offered for Locate either.
            if ("link.flashlight".equals(capability) || "link.findmydevice.request".equals(capability)
                    || LinkLocation.PACKET_TYPE_REQUEST.equals(capability)) continue;
            kept.add(capability);
        }
        return kept.toArray(new String[0]);
    }

    public static String saveDeviceName(Context context, String newName) {
        File file = identityFile(context);
        String filtered = filterDeviceName(newName);
        try {
            String raw = new String(Files.readAllBytes(file.toPath()));
            JSONObject obj = new JSONObject(raw);
            // Nothing usable left after filtering: keep the current name.
            if (filtered.isEmpty()) return obj.optString("deviceName", "");
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
