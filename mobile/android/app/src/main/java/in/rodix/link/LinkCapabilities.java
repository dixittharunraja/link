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

    // The per-device-gated capability keys THIS device (mobile) itself executes/broadcasts.
    // Presenter/Touchpad/Digitizer are deliberately excluded — mobile only ever SENDS those
    // commands, it never executes an incoming one, so they don't belong in mobile's own list
    // (mirrors desktop excluding flashlight/dnd from its own list for the same reason in reverse).
    // 'lock' is included since both platforms execute it — was simply missed when this list was
    // first built; the permission check itself already existed.
    private static final String[] GATED_CAPABILITY_KEYS = {"flashlight", "dnd", "systemvolume", "mpris", "lock"};

    public static boolean isCapabilitiesPacket(LinkPacket packet) {
        return PACKET_TYPE_CAPABILITIES.equals(packet.type);
    }

    public static JSONArray computeEffectiveCapabilities(Context context, String deviceId) {
        JSONArray result = new JSONArray();
        for (String key : GATED_CAPABILITY_KEYS) {
            if (!LinkDevicePermissions.check(context, deviceId, key)) continue;
            // DND additionally requires the OS-level Notification Policy Access grant — if not
            // granted, stay silent (exclude entirely) rather than exposing why, per the same
            // "device A doesn't need to know why" doctrine used for its broadcast gating.
            if (key.equals("dnd") && !LinkDND.isDndGranted(context)) continue;
            result.put(key);
        }
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
