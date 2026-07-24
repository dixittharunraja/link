package in.rodix.link;

import android.app.Notification;
import android.service.notification.StatusBarNotification;
import org.json.JSONObject;

public class LinkNotification {
    public static final String PACKET_TYPE_NOTIFICATION = "link.notification";

    // App icons are static per install, so resolving+encoding once per package (not once per
    // notification — chat apps fire many notifications per conversation) is a real cost saving.
    private static final java.util.Map<String, String> iconCache = new java.util.concurrent.ConcurrentHashMap<>();

    /** Resolves the source app's own launcher icon as a small base64-encoded PNG, so the desktop
     * can show e.g. WhatsApp's real icon instead of the generic Link app icon. Returns null if
     * resolution fails for any reason — the desktop falls back to its own icon in that case. */
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

        // Filter out foreground services, ongoing events, local-only, or group-summary
        // notifications (exactly like KDE Connect). Group summary is the important one for
        // bundled notifications (WhatsApp, Gmail, etc. post a "3 new messages"-style summary
        // alongside each individual notification) — without this, both the summary and the real
        // notification get synced, showing up as two separate desktop notifications for what the
        // user experiences as one new message.
        if ((notification.flags & Notification.FLAG_FOREGROUND_SERVICE) != 0
                || (notification.flags & Notification.FLAG_ONGOING_EVENT) != 0
                || (notification.flags & Notification.FLAG_LOCAL_ONLY) != 0
                || (notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) {
            return false;
        }

        String packageName = sbn.getPackageName();
        if (packageName == null) return false;

        // Don't sync notifications from our own app
        if (packageName.equals(myPackageName)) {
            return false;
        }

        // Ignore standard Android System UI low battery notifications
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
