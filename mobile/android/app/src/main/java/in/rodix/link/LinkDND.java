package in.rodix.link;

import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.util.Log;
import org.json.JSONObject;

public class LinkDND {
    public static final String PACKET_TYPE_DND = "link.dnd";
    private static final String TAG = "LinkDND";

    public static boolean isDndGranted(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            NotificationManager nm = (Context.NOTIFICATION_SERVICE != null) ?
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE) : null;
            return nm != null && nm.isNotificationPolicyAccessGranted();
        }
        return true;
    }

    public static void setDnd(Context context, boolean enabled) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null && nm.isNotificationPolicyAccessGranted()) {
                    int filter = enabled ? NotificationManager.INTERRUPTION_FILTER_PRIORITY : NotificationManager.INTERRUPTION_FILTER_ALL;
                    nm.setInterruptionFilter(filter);
                } else {
                    Log.w(TAG, "DND policy access not granted!");
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to set DND", e);
            }
        }
    }

    public static boolean isDndEnabled(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            int filter = nm.getCurrentInterruptionFilter();
            return filter != NotificationManager.INTERRUPTION_FILTER_ALL;
        }
        return false;
    }

    public static LinkPacket createStatusPacket(Context context) {
        try {
            JSONObject body = new JSONObject();
            body.put("enabled", isDndEnabled(context));
            body.put("granted", isDndGranted(context));
            return new LinkPacket(PACKET_TYPE_DND, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
