package in.rodix.link;

import org.json.JSONObject;
import android.service.notification.StatusBarNotification;

public class LinkNotificationBroadcast {
    public static final String PACKET_TYPE_NOTIFICATION_BROADCAST = "link.notification.broadcast";

    public static LinkPacket createNotificationBroadcastPacket(StatusBarNotification sbn, String sourceDeviceName) {
        try {
            JSONObject body = new JSONObject();

            android.app.Notification notification = sbn.getNotification();
            String packageName = sbn.getPackageName();
            long postTime = sbn.getPostTime();
            String key = sbn.getKey();

            String title = "";
            String message = "";
            String ticker = "";

            if (notification != null) {
                if (notification.extras != null) {
                    title = notification.extras.getString(android.app.Notification.EXTRA_TITLE, "");
                    message = notification.extras.getString(android.app.Notification.EXTRA_TEXT, "");
                    ticker = notification.tickerText != null ? notification.tickerText.toString() : "";
                }
            }

            if (title.isEmpty()) {
                title = packageName;
            }

            body.put("id", key);
            body.put("timestamp", postTime);
            body.put("appName", packageName);
            body.put("title", title);
            body.put("message", message);
            body.put("ticker", ticker);
            body.put("sourceDeviceName", sourceDeviceName);

            // Rough classification by package name.
            boolean isCall = packageName.contains("phone") || packageName.contains("dialer") || packageName.contains("call");
            boolean isMessage = packageName.contains("sms") || packageName.contains("messages") ||
                               packageName.contains("telegram") || packageName.contains("whatsapp") ||
                               packageName.contains("messenger");

            body.put("isCall", isCall);
            body.put("isMessage", isMessage);

            android.util.Log.d("LinkNotificationBroadcast", "Creating broadcast packet: " + title + " from " + packageName);

            return new LinkPacket(PACKET_TYPE_NOTIFICATION_BROADCAST, body);
        } catch (Exception e) {
            android.util.Log.e("LinkNotificationBroadcast", "Error creating notification broadcast packet", e);
            return null;
        }
    }

    public static boolean isNotificationBroadcastPacket(LinkPacket packet) {
        return PACKET_TYPE_NOTIFICATION_BROADCAST.equals(packet.type);
    }
}
