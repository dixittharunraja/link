package in.rodix.link;

// Presenter plugin — port of kdeconnect-android's plugins/presenter/PresenterPlugin.kt's
// sendPointer/stopPointer. Only the pointer-dot-movement half — slide navigation
// (next/prev/fullscreen/esc) goes over touchpad.request with real key injection, deferred
// separately. See desktop/src/core/plugins/presenter.ts's header comment and docs/features.txt.
//
// Input source note: real upstream drives dx/dy from the phone's gyroscope (tilt control). Our
// mobile dev harness uses touch-drag instead — the wire packet format is identical either way.

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
