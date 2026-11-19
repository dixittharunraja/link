package in.rodix.link;

import android.app.Notification;
import android.service.notification.StatusBarNotification;
import org.json.JSONObject;

public class LinkNotification {
    public static final String PACKET_TYPE_NOTIFICATION = "link.notification";

    // Encoded app icons per package; chat apps post many notifications, and icons rarely change.
    private static final java.util.Map<String, String> iconCache = new java.util.concurrent.ConcurrentHashMap<>();

    // App display names per package, for the same reason.
    private static final java.util.Map<String, String> labelCache = new java.util.concurrent.ConcurrentHashMap<>();

    /** The app's display name, or its package name if it has none. */
    public static String getAppLabel(android.content.Context context, String packageName) {
        String cached = labelCache.get(packageName);
        if (cached != null) return cached;
        String label = packageName;
        try {
            android.content.pm.PackageManager pm = context.getPackageManager();
            label = pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
        } catch (Exception ignored) {}
        labelCache.put(packageName, label);
        return label;
    }

    /** A copy of a posted packet without the app icon, for a peer that already has it. */
    public static LinkPacket withoutIcon(LinkPacket packet) {
        try {
            JSONObject body = new JSONObject(packet.body.toString());
            body.remove("iconBase64");
            return new LinkPacket(packet.type, body);
        } catch (Exception e) {
            return packet;
        }
    }

    /** The source app's icon as a small base64 PNG so the desktop can show it, or null on
     *  failure (the desktop then uses its own icon). */
    private static String getAppIconBase64(android.content.Context context, String packageName) {
        String cached = iconCache.get(packageName);
        if (cached != null) return cached;
        try {
            android.content.pm.PackageManager pm = context.getPackageManager();
            android.graphics.drawable.Drawable drawable = pm.getApplicationIcon(packageName);
            int size = 64;
            android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888);
            android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(canvas);

            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, baos);
            String encoded = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP);
            iconCache.put(packageName, encoded);
            return encoded;
        } catch (Exception e) {
            return null;
        }
    }

    public static boolean isEligible(StatusBarNotification sbn, String myPackageName) {
        Notification notification = sbn.getNotification();
        if (notification == null) return false;

        // Skip foreground-service, ongoing, local-only, call and group-summary notifications.
        // Apps that bundle notifications post a summary alongside each message, which would
        // otherwise show up twice on the desktop.
        if ((notification.flags & Notification.FLAG_FOREGROUND_SERVICE) != 0
                || (notification.flags & Notification.FLAG_ONGOING_EVENT) != 0
                || (notification.flags & Notification.FLAG_LOCAL_ONLY) != 0
                || (notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0
                || Notification.CATEGORY_CALL.equals(notification.category)) {
            return false;
        }

        String packageName = sbn.getPackageName();
        if (packageName == null) return false;

        if (packageName.equals(myPackageName)) {
            return false;
        }

        // System UI's own low-battery warning is not mirrored.
        if ("com.android.systemui".equals(packageName) && "low_battery".equals(sbn.getTag())) {
            return false;
        }

        return true;
    }

    public static String getNotificationKey(StatusBarNotification sbn) {
        return sbn.getPackageName() + "|" + sbn.getId() + "|" + (sbn.getTag() != null ? sbn.getTag() : "");
    }

    public static LinkPacket createPostedPacket(android.content.Context context, StatusBarNotification sbn, String appDisplayName, String replyId) {
        try {
            Notification notification = sbn.getNotification();
            JSONObject body = new JSONObject();
            body.put("id", getNotificationKey(sbn));
            body.put("appName", appDisplayName != null ? appDisplayName : sbn.getPackageName());
            body.put("isClearable", sbn.isClearable());
            body.put("time", String.valueOf(sbn.getPostTime()));

            String iconBase64 = getAppIconBase64(context, sbn.getPackageName());
            if (iconBase64 != null) {
                body.put("iconBase64", iconBase64);
            }

            if (replyId != null) {
                body.put("requestReplyId", replyId);
            }

            CharSequence title = notification.extras.getCharSequence(Notification.EXTRA_TITLE);
            if (title != null) {
                body.put("title", title.toString());
            }

            CharSequence text = notification.extras.getCharSequence(Notification.EXTRA_TEXT);
            if (text == null) {
                text = notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
            }
            if (text != null) {
                body.put("text", text.toString());
            }

            CharSequence tickerText = notification.tickerText;
            if (tickerText != null) {
                body.put("ticker", tickerText.toString());
            }

            return new LinkPacket(PACKET_TYPE_NOTIFICATION, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createCancelPacket(StatusBarNotification sbn) {
        try {
            JSONObject body = new JSONObject();
            body.put("id", getNotificationKey(sbn));
            body.put("isCancel", true);
            return new LinkPacket(PACKET_TYPE_NOTIFICATION, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkRepliableNotification extractRepliable(Notification notification) {
        if (notification == null || notification.actions == null) return null;
        for (Notification.Action action : notification.actions) {
            if (action != null && action.getRemoteInputs() != null && action.actionIntent != null) {
                return new LinkRepliableNotification(action.actionIntent, action.getRemoteInputs());
            }
        }
        return null;
    }
}
