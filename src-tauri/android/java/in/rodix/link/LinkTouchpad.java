package in.rodix.link;

import org.json.JSONObject;

public class LinkTouchpad {
    public static final String PACKET_TYPE_TOUCHPAD_REQUEST = "link.touchpad.request";

    public static LinkPacket createMovePacket(double dx, double dy) {
        try {
            JSONObject body = new JSONObject();
            body.put("dx", dx);
            body.put("dy", dy);
            return new LinkPacket(PACKET_TYPE_TOUCHPAD_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createClickPacket(String clickType) {
        try {
            JSONObject body = new JSONObject();
            if ("right".equals(clickType)) {
                body.put("rightclick", true);
            } else if ("middle".equals(clickType)) {
                body.put("middleclick", true);
            } else if ("double".equals(clickType)) {
                body.put("doubleclick", true);
            } else {
                body.put("singleclick", true);
            }
            return new LinkPacket(PACKET_TYPE_TOUCHPAD_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createDragPacket(boolean hold) {
        try {
            JSONObject body = new JSONObject();
            if (hold) {
                body.put("singlehold", true);
            } else {
                body.put("singlerelease", true);
            }
            return new LinkPacket(PACKET_TYPE_TOUCHPAD_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createScrollPacket(double dx, double dy) {
        try {
            JSONObject body = new JSONObject();
            body.put("scroll", true);
            body.put("dx", dx);
            body.put("dy", dy);
            return new LinkPacket(PACKET_TYPE_TOUCHPAD_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
