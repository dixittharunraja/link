package in.rodix.link;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

// link.capabilities packet, the Java counterpart of the handling in core/host.rs. Sent to a peer
// on connect and whenever its permissions change; lists which of this device's gated
// capabilities (LinkCapabilitiesSchema.GATED_CAPABILITY_KEYS) that peer may currently use. The
// peer's UI shows or hides each control based on this list.
public class LinkCapabilities {
    public static final String PACKET_TYPE_CAPABILITIES = "link.capabilities";

    public static boolean isCapabilitiesPacket(LinkPacket packet) {
        return PACKET_TYPE_CAPABILITIES.equals(packet.type);
    }

    public static JSONArray computeEffectiveCapabilities(Context context, String deviceId) {
        JSONArray result = new JSONArray();
        for (String key : LinkCapabilitiesSchema.GATED_CAPABILITY_KEYS) {
            if (!LinkDevicePermissions.check(context, deviceId, key)) continue;
            // A device with no camera flash (a TV, some tablets) has no flashlight to offer.
            if ("flashlight".equals(key) && !context.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA_FLASH)) continue;
            // Only the per-device permission is checked here; OS-level grants (e.g. DND access)
            // are checked when the command is executed.
            result.put(key);
        }
        android.util.Log.d("LinkCapabilities", "Effective capabilities for peer " + deviceId + ": " + result.toString());
        return result;
    }

    public static LinkPacket createCapabilitiesPacket(Context context, String deviceId) {
        JSONObject body = new JSONObject();
        try {
            body.put("capabilities", computeEffectiveCapabilities(context, deviceId));
        } catch (Exception ignored) {}
        return new LinkPacket(PACKET_TYPE_CAPABILITIES, body);
    }
}
