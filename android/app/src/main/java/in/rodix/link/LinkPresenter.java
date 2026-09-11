package in.rodix.link;

// Presenter helper. Constructs movement/stop packets for the pointer overlay.

import org.json.JSONObject;

public class LinkPresenter {
    public static final String PACKET_TYPE_PRESENTER = "link.presenter";

    public static LinkPacket createMovePacket(double dx, double dy) {
        try {
            JSONObject body = new JSONObject();
            body.put("dx", dx);
            body.put("dy", dy);
            return new LinkPacket(PACKET_TYPE_PRESENTER, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createStopPacket() {
        try {
            JSONObject body = new JSONObject();
            body.put("stop", true);
            return new LinkPacket(PACKET_TYPE_PRESENTER, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
