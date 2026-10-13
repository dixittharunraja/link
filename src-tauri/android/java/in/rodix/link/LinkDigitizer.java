package in.rodix.link;

import org.json.JSONObject;

public class LinkDigitizer {
    public static final String PACKET_TYPE_SESSION = "link.digitizer.session";
    public static final String PACKET_TYPE_EVENT = "link.digitizer";

    public static LinkPacket createSessionStart(int width, int height, int resolutionX, int resolutionY) {
        try {
            JSONObject body = new JSONObject();
            body.put("action", "start");
            body.put("width", width);
            body.put("height", height);
            body.put("resolutionX", resolutionX);
            body.put("resolutionY", resolutionY);
            return new LinkPacket(PACKET_TYPE_SESSION, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createSessionEnd() {
        try {
            JSONObject body = new JSONObject();
            body.put("action", "end");
            return new LinkPacket(PACKET_TYPE_SESSION, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createEvent(Integer x, Integer y, Boolean touching, Boolean active, Double pressure, String tool) {
        try {
            JSONObject body = new JSONObject();
            if (x != null) body.put("x", x);
            if (y != null) body.put("y", y);
            if (touching != null) body.put("touching", touching);
            if (active != null) body.put("active", active);
            if (pressure != null) body.put("pressure", pressure);
            if (tool != null) body.put("tool", tool);
            return new LinkPacket(PACKET_TYPE_EVENT, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
