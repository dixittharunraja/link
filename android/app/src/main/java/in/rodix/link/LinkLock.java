package in.rodix.link;

// Lock Device plugin — Java port of desktop's lockdevice.ts.
//
// SCOPED DOWN deviation from potential bidirectional lock behavior:
// Android lock action itself (allowing PC to lock the phone) is not implemented.
// Programmatic screen locking on Android requires Device Policy Manager (Device Administrator)
// or an Accessibility Service. Since this project has not established a runtime-permission
// setup/activation flow for these specialized system controls yet, the phone only reports
// itself statically as unlocked (isLocked = false) and ignores incoming lock request commands.
// It fully functions as a controller to lock the desktop and query desktop lock status.
// Documented in docs/features.txt.

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import org.json.JSONObject;

public class LinkLock {
    public static final String PACKET_TYPE_LOCK = "link.lock";
    public static final String PACKET_TYPE_LOCK_REQUEST = "link.lock.request";

    public static boolean isAdminActive(Context context) {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName cn = new ComponentName(context, LinkDeviceAdminReceiver.class);
        return dpm != null && dpm.isAdminActive(cn);
    }

    // Unlike notification-listener/all-files-access/DND (which are toggle screens the OS owns —
    // opening the same settings intent works for both granting and revoking), device admin has no
    // "already active" settings deep link. But since this app is the admin, it can deactivate its
    // own registration directly with no confirmation prompt (an app lowering its own privilege
    // needs none) rather than needing to send the user hunting through Settings > Security.
    public static boolean deactivate(Context context) {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName cn = new ComponentName(context, LinkDeviceAdminReceiver.class);
        if (dpm != null && dpm.isAdminActive(cn)) {
            dpm.removeActiveAdmin(cn);
            return true;
        }
        return false;
    }

    public static boolean lock(Context context) {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName cn = new ComponentName(context, LinkDeviceAdminReceiver.class);
        if (dpm != null && dpm.isAdminActive(cn)) {
            dpm.lockNow();
            return true;
        }
        return false;
    }

    public static boolean isDeviceLocked(Context context) {
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
