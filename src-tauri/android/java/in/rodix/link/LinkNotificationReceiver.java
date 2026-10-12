package in.rodix.link;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

public class LinkNotificationReceiver extends NotificationListenerService {
    public static LinkNotificationReceiver instance = null;

    public interface Listener {
        void onNotificationPosted(StatusBarNotification sbn);
        void onNotificationRemoved(StatusBarNotification sbn);
    }

    private static Listener listener = null;

    public static void setListener(Listener l) {
        listener = l;
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        instance = this;
    }

    @Override
    public void onListenerDisconnected() {
        super.onListenerDisconnected();
        instance = null;
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (listener != null) {
            listener.onNotificationPosted(sbn);
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (listener != null) {
            listener.onNotificationRemoved(sbn);
        }
    }

    public static boolean isPermissionGranted(android.content.Context context) {
        String enabledListeners = android.provider.Settings.Secure.getString(
                context.getContentResolver(), "enabled_notification_listeners");
        if (enabledListeners == null) return false;
        String thisComponentName = new android.content.ComponentName(context, LinkNotificationReceiver.class).flattenToString();
        return enabledListeners.contains(thisComponentName);
    }
}
