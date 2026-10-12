package in.rodix.link;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

// Effective-capabilities packet — Java port of desktop's capabilities.ts. A single, unified
// per-peer signal replacing ad-hoc per-plugin "revoked" flags (previously Flashlight/DND each
// carried their own bespoke revoked:true field). Sent to a specific peer whenever what they're
// currently allowed to do here changes (permission toggle, or connect-time initial sync). Lists
// exactly which of this device's own per-device-gated capability keys are CURRENTLY allowed for
// that peer. The receiving UI gates every button/section on membership in this list.
public class LinkCapabilities {
    public static final String PACKET_TYPE_CAPABILITIES = "link.capabilities";

    // GATED_CAPABILITY_KEYS is now centralized in LinkCapabilitiesSchema.java.
    // (Mirrors desktop's GATED_CAPABILITY_KEYS in capabilities-schema.ts.)

    public static boolean isCapabilitiesPacket(LinkPacket packet) {
        return PACKET_TYPE_CAPABILITIES.equals(packet.type);
    }

    public static JSONArray computeEffectiveCapabilities(Context context, String deviceId) {
        JSONArray result = new JSONArray();
        for (String key : LinkCapabilitiesSchema.GATED_CAPABILITY_KEYS) {
            if (!LinkDevicePermissions.check(context, deviceId, key)) continue;
            // Permission check gates visibility; OS-level grants are checked at execution time.
            // E.g., if A has permission to control B's DND, B advertises DND even if B can't
            // use DND itself — the execution check happens when B receives the command.
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
