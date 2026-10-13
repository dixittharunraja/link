package in.rodix.link;

// Lock Device plugin — Mobile/TV side.
//
// Remote locking works via:
// 1. Controlling connected Desktop PCs (sending link.lock.request).
// 2. Receiving lock commands locally via LinkAccessibilityService (GLOBAL_ACTION_LOCK_SCREEN, Android 9+),
//    requiring zero Device Admin policies and allowing standard uninstallation.

import android.content.Context;
import org.json.JSONObject;

public class LinkLock {
    public static final String PACKET_TYPE_LOCK = "link.lock";
    public static final String PACKET_TYPE_LOCK_REQUEST = "link.lock.request";

    public static boolean lockDevice() {
        LinkAccessibilityService service = LinkAccessibilityService.getInstance();
        if (service != null) {
            return service.lockScreen();
        }
        return false;
    }

    public static boolean isDeviceLocked(Context context) {
        if (context == null) return false;
        android.app.KeyguardManager km = (android.app.KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    public static LinkPacket createLockPacket(Context context, Boolean lockResult) {
        try {
            JSONObject body = new JSONObject();
            body.put("isLocked", isDeviceLocked(context));
            if (lockResult != null) {
                body.put("lockResult", lockResult);
            }
            return new LinkPacket(PACKET_TYPE_LOCK, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createLockRequestPacket(Boolean setLocked, Boolean requestLocked) {
        try {
            JSONObject body = new JSONObject();
            if (setLocked != null) {
                body.put("setLocked", setLocked);
            }
            if (requestLocked != null) {
                body.put("requestLocked", requestLocked);
            }
            return new LinkPacket(PACKET_TYPE_LOCK_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static boolean isLockPacket(LinkPacket packet) {
        return PACKET_TYPE_LOCK.equals(packet.type);
    }

    public static boolean isLockRequestPacket(LinkPacket packet) {
        return PACKET_TYPE_LOCK_REQUEST.equals(packet.type);
    }
}
