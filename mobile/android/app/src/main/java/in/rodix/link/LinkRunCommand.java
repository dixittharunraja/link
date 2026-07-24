package in.rodix.link;

// Run Command plugin — Java port of kdeconnect-android's plugins/runcommand/RunCommandPlugin.java.
// The phone NEVER executes anything locally — it only requests, displays, and triggers by key.
// The desktop is the only side that ever runs a command, and only from its own hardcoded
// whitelist. See desktop/src/core/plugins/runcommand.ts for the matching security note.

import org.json.JSONObject;

public class LinkRunCommand {
    public static final String PACKET_TYPE_RUNCOMMAND = "link.runcommand";
    public static final String PACKET_TYPE_RUNCOMMAND_REQUEST = "link.runcommand.request";

    public static LinkPacket createRequestListPacket() {
        try {
            JSONObject body = new JSONObject();
            body.put("requestCommandList", true);
            return new LinkPacket(PACKET_TYPE_RUNCOMMAND_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createTriggerPacket(String key) {
        try {
            JSONObject body = new JSONObject();
            body.put("key", key);
            return new LinkPacket(PACKET_TYPE_RUNCOMMAND_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static boolean isCommandListPacket(LinkPacket packet) {
        return PACKET_TYPE_RUNCOMMAND.equals(packet.type) && packet.body.has("commandList");
    }

    /** Parsed {key -> {name, command}} from an incoming commandList packet — command is never executed here, only displayed. */
    public static JSONObject parseCommandList(LinkPacket packet) {
        try {
            return new JSONObject(packet.body.getString("commandList"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
