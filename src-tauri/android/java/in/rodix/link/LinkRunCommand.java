package in.rodix.link;

// Run Command plugin. Android never
// executes commands: it requests the desktop's command list, displays it and triggers entries by
// key. Only the desktop runs commands, from its own list (core/plugins/runcommand.rs).

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

    /** Parses {key -> {name, command}} from a commandList packet, for display only. */
    public static JSONObject parseCommandList(LinkPacket packet) {
        try {
            return new JSONObject(packet.body.getString("commandList"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
