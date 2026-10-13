package in.rodix.link;

// Keeps the app process alive in the background so the TLS device connections (owned by
// LinkPlugin, a Tauri plugin tied to the WebView/Activity) survive the user swiping the app
// away from Recents.
//
// Root cause of the "disconnects when cleared from recents" bug: without any active foreground
// service, Android treats a backgrounded app with no visible Activity as a low-priority process
// and — especially once the task is explicitly removed from Recents — kills the whole process
// outright on stock Android and even more aggressively on OEM battery managers (Xiaomi/Samsung/
// OnePlus). That kills every socket LinkPlugin's LinkDeviceManager holds, which is what
// disconnects/reconnects/reloads the app.
//
// This service intentionally holds no networking logic of its own — LinkPlugin's existing
// DeviceManager, sockets, and packet handling are untouched. Its only job is to hold a
// startForeground() notification so Android treats this process as doing active foreground work
// and does not kill it just because the task was swiped away.
public class LinkForegroundService extends android.app.Service {

    // Since Android 13 (API 33), the OS lets users swipe away a foreground service's notification
    // without stopping the service — dismissing it does NOT kill this service or the connections,
    // it just hides the notification.
    //
    // A deleteIntent-based BroadcastReceiver was tried here first (matching how a normal
    // notification's dismiss is detected), but verified via logcat on a real device that it never
    // fires for this specific case: the system logs "Cancel FGS notification ... Reason:2" — a
    // distinct, special-cased internal path for hiding a foreground service's notification that
    // does NOT invoke deleteIntent the way a regular notification cancel does. Depending on that
    // callback firing was fundamentally the wrong approach for this specific dismiss path.
    //
    // Fixed instead with unconditional periodic re-assertion: just re-call startForeground() with
    // the same notification on a timer. This doesn't depend on detecting the dismiss event at
    // all, so it's immune to OEM/Android-version quirks in how that event is (or isn't) reported —
    // if the notification is showing, this is a harmless no-op re-post; if it was swiped away, it
    // reappears within one interval.
    // Kept short (not sub-second) since re-posting is just a cheap local Binder call to
    // NotificationManagerService on an already-alive process — no wakelock/AlarmManager/Doze
    // concerns to worry about, so there's no real cost to checking often.
    private static final long REPIN_INTERVAL_MS = 2_000;
    private final android.os.Handler repinHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable repinRunnable = new Runnable() {
        @Override
        public void run() {
            try {
                startForegroundCompat();
            } catch (Exception e) {
                android.util.Log.e("LinkForegroundService", "Failed to re-pin notification", e);
            }
            repinHandler.postDelayed(this, REPIN_INTERVAL_MS);
        }
    };

    // Always requests ALL types together rather than toggling mediaProjection/microphone on only
    // while Audio Relay/Remote Mic hosting is active: this service already runs unconditionally
    // for the app's whole foreground lifetime regardless of which features are in use, so by the
    // time hosting actually starts, the type has already been continuously declared — trivially
    // satisfying API 34+'s "startForeground() with that type must happen at or before the
    // MediaProjection/mic capture is used" rule. No privacy-indicator downside either: the OS's
    // persistent recording/casting status indicator is tied to an ACTIVE MediaProjection grant or
    // AudioRecord session actually being used, not to a foreground service merely declaring it's
    // allowed to hold one. Adding microphone here is what makes Remote Mic hosting survive the
    // screen turning off — without it, Android silently mutes AudioRecord input the moment there's
    // no visible Activity, even though this service already keeps the process itself alive.
    private void startForegroundCompat() {
        android.app.Notification n = LinkPlugin.buildActiveNotification(getApplicationContext());
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            try {
                startForeground(LinkPlugin.NOTIFICATION_ID, n,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                    | android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                    | android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } catch (Exception e) {
                // On Android 14+ (API 34+), declaring MEDIA_PROJECTION or MICROPHONE foreground service types
                // without an active projection token or microphone grant throws SecurityException during initial boot.
                // Fallback to CONNECTED_DEVICE type so background persistent notification runs cleanly immediately.
                try {
                    startForeground(LinkPlugin.NOTIFICATION_ID, n,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
                } catch (Exception ex) {
                    startForeground(LinkPlugin.NOTIFICATION_ID, n);
                }
            }
        } else {
            startForeground(LinkPlugin.NOTIFICATION_ID, n);
        }
    }

    // Keeps Wi-Fi out of its power-saving mode while the screen is off, which otherwise delays or
    // drops the discovery broadcasts and incoming connections the link depends on.
    private android.net.wifi.WifiManager.WifiLock wifiLock;

    private void holdWifi() {
        try {
            android.net.wifi.WifiManager wifi = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);
            if (wifi == null) return;
            int mode = android.os.Build.VERSION.SDK_INT >= 29
                    ? android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wifi.createWifiLock(mode, "link-connection");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (Exception e) {
            android.util.Log.w("LinkForegroundService", "Could not hold the Wi-Fi lock", e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            // Reuses LinkPlugin's exact NOTIFICATION_ID/CHANNEL_ID so this is the SAME
            // notification the plugin already shows ("Link is active"), not a duplicate one.
            startForegroundCompat();
        } catch (Exception e) {
            // A failure here (e.g. a manifest/permission mismatch for the declared foreground
            // service type) must never crash the whole app — degrade to "no background
            // persistence" rather than making the app unusable. See the FGS SecurityException
            // this project hit: connectedDevice type requires a companion permission
            // (CHANGE_WIFI_STATE/CHANGE_NETWORK_STATE/Bluetooth/etc.) beyond just
            // FOREGROUND_SERVICE_CONNECTED_DEVICE, uncaught it took the whole process down.
            android.util.Log.e("LinkForegroundService", "Failed to start foreground", e);
            stopSelf();
            return;
        }

        holdWifi();
        repinHandler.postDelayed(repinRunnable, REPIN_INTERVAL_MS);
    }

    @Override
    public int onStartCommand(android.content.Intent intent, int flags, int startId) {
        // START_STICKY: if Android still kills this process under memory pressure, it will
        // attempt to recreate and restart this service (with a null intent) once resources free
        // up, rather than leaving it dead until the user manually reopens the app.
        return START_STICKY;
    }

    @Override
    public android.os.IBinder onBind(android.content.Intent intent) {
        return null; // Started, not bound — nothing needs a live binder to this service.
    }

    @Override
    public void onTaskRemoved(android.content.Intent rootIntent) {
        // Deliberately does NOT call stopSelf() or super's default behavior of tearing down —
        // the entire point of this service is to keep running (and keep the process alive) after
        // the task is removed from Recents. An empty override is enough to prevent the base
        // Service from treating task removal as a stop signal.
    }

    @Override
    public void onDestroy() {
        repinHandler.removeCallbacks(repinRunnable);
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }
}
