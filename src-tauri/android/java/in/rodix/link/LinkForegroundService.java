package in.rodix.link;

// Keeps the app process alive in the background so the device connections owned by LinkPlugin
// survive the app being swiped away from Recents. Without a foreground service, Android (and
// more aggressively, OEM battery managers) kills a backgrounded process with no visible
// Activity, dropping every socket. This service has no networking logic; it only holds the
// startForeground() notification and, while a paired device is connected, a Wi-Fi lock.
public class LinkForegroundService extends android.app.Service {

    // Since Android 13 the user can swipe away a foreground service's notification without
    // stopping the service. That dismissal does not fire the notification's deleteIntent, so
    // instead the notification is re-posted when it is found missing: checked on a slow timer, and
    // at once when the screen turns on or the phone is unlocked, which is when the user would look.
    private static final long REPIN_INTERVAL_MS = 30_000;
    private final android.os.Handler repinHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable repinRunnable = new Runnable() {
        @Override
        public void run() {
            repinIfMissing();
            repinHandler.postDelayed(this, REPIN_INTERVAL_MS);
        }
    };
    private final android.content.BroadcastReceiver screenReceiver = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context context, android.content.Intent intent) {
            repinIfMissing();
        }
    };
    private boolean screenReceiverRegistered = false;

    // Built once: its content never changes, and building it creates the channel and two
    // PendingIntents each time.
    private android.app.Notification notification;

    private android.app.Notification activeNotification() {
        if (notification == null) {
            notification = LinkPlugin.buildActiveNotification(getApplicationContext());
        }
        return notification;
    }

    private void repinIfMissing() {
        try {
            android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(android.content.Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                for (android.service.notification.StatusBarNotification sbn : nm.getActiveNotifications()) {
                    if (sbn.getId() == LinkPlugin.NOTIFICATION_ID) return;
                }
            }
            startForegroundCompat();
        } catch (Exception e) {
            android.util.Log.e("LinkForegroundService", "Failed to re-pin notification", e);
        }
    }

    // Requests all service types at once. Because this service runs for the app's whole lifetime,
    // the mediaProjection and microphone types are already declared before Audio Relay or Remote
    // Mic capture starts, as API 34+ requires. The OS recording indicator only follows actual
    // capture, not the declared type. The microphone type also keeps AudioRecord from being
    // silenced while there is no visible Activity (e.g. screen off).
    // The location type is added only once location access is granted (Locate, LinkLocation), so a
    // paired device can still get a fix while Link is in the background.
    private void startForegroundCompat() {
        android.app.Notification n = activeNotification();
        int connected = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        int location = LinkLocation.hasPermission(this) ? android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
        // On API 34+, the mediaProjection and microphone types throw SecurityException without a
        // projection token or microphone grant, so fewer types are tried until one is accepted.
        int[] attempts = {
            connected | location
                | android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                | android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            connected | location,
            connected,
        };
        for (int types : attempts) {
            try {
                startForeground(LinkPlugin.NOTIFICATION_ID, n, types);
                return;
            } catch (Exception ignored) {
            }
        }
        startForeground(LinkPlugin.NOTIFICATION_ID, n);
    }

    /** Asks the running service to declare its types again, e.g. after location access was granted. */
    public static void refreshTypes(android.content.Context context) {
        try {
            android.content.Intent intent = new android.content.Intent(context, LinkForegroundService.class);
            intent.setAction(ACTION_REFRESH_TYPES);
            androidx.core.content.ContextCompat.startForegroundService(context, intent);
        } catch (Exception e) {
            android.util.Log.w("LinkForegroundService", "Could not refresh service types", e);
        }
    }

    private static final String ACTION_REFRESH_TYPES = "in.rodix.link.REFRESH_TYPES";

    // Keeps Wi-Fi out of its power-saving mode while the screen is off, which otherwise delays or
    // drops the packets of a live connection. Held only while a paired device is connected
    // (LinkPlugin calls setPeerConnected): with nobody connected there is nothing to keep fast, and
    // a high-performance lock held around the clock costs battery.
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private static volatile boolean sPeerConnected = false;
    private static LinkForegroundService sInstance;
    private static final android.os.Handler sMainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    /** Tells the service whether any paired device is connected; safe from any thread. */
    static void setPeerConnected(boolean connected) {
        sPeerConnected = connected;
        sMainHandler.post(() -> {
            LinkForegroundService service = sInstance;
            if (service != null) service.applyWifiLock();
        });
    }

    private void applyWifiLock() {
        try {
            if (sPeerConnected) {
                if (wifiLock == null) {
                    android.net.wifi.WifiManager wifi = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);
                    if (wifi == null) return;
                    wifiLock = wifi.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "link-connection");
                    wifiLock.setReferenceCounted(false);
                }
                if (!wifiLock.isHeld()) wifiLock.acquire();
            } else if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        } catch (Exception e) {
            android.util.Log.w("LinkForegroundService", "Could not update the Wi-Fi lock", e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            // Uses LinkPlugin's NOTIFICATION_ID so this replaces the plugin's "Link is active"
            // notification rather than adding a second one.
            startForegroundCompat();
        } catch (Exception e) {
            // A foreground-service type/permission mismatch (connectedDevice also needs e.g.
            // CHANGE_WIFI_STATE) must not crash the app; run without background persistence.
            android.util.Log.e("LinkForegroundService", "Failed to start foreground", e);
            stopSelf();
            return;
        }

        sInstance = this;
        applyWifiLock();
        repinHandler.postDelayed(repinRunnable, REPIN_INTERVAL_MS);
        try {
            android.content.IntentFilter filter = new android.content.IntentFilter();
            filter.addAction(android.content.Intent.ACTION_SCREEN_ON);
            filter.addAction(android.content.Intent.ACTION_USER_PRESENT);
            registerReceiver(screenReceiver, filter);
            screenReceiverRegistered = true;
        } catch (Exception e) {
            android.util.Log.w("LinkForegroundService", "Could not watch the screen state", e);
        }
    }

    @Override
    public int onStartCommand(android.content.Intent intent, int flags, int startId) {
        if (intent != null && ACTION_REFRESH_TYPES.equals(intent.getAction())) {
            try {
                startForegroundCompat();
            } catch (Exception e) {
                android.util.Log.w("LinkForegroundService", "Could not refresh service types", e);
            }
        }
        // If the process is killed under memory pressure, Android recreates the service later.
        return START_STICKY;
    }

    @Override
    public android.os.IBinder onBind(android.content.Intent intent) {
        return null; // Started service, not bound.
    }

    @Override
    public void onTaskRemoved(android.content.Intent rootIntent) {
        // Intentionally does not stop: the service must outlive removal from Recents.
    }

    @Override
    public void onDestroy() {
        repinHandler.removeCallbacks(repinRunnable);
        if (screenReceiverRegistered) {
            try { unregisterReceiver(screenReceiver); } catch (Exception ignored) {}
            screenReceiverRegistered = false;
        }
        if (sInstance == this) sInstance = null;
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }
}
