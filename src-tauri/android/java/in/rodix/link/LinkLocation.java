package in.rodix.link;

// Locate: answers a paired device's link.location.request with this device's position. Uses the
// platform LocationManager (GPS and network), so it needs no Google Play services. The last known
// fix goes out at once, then each fresh fix as it arrives, then a "done" status. Every fix carries
// its accuracy radius in metres, so the asking device can show how far to trust it.
//
// Per device, the "location" permission (on by default) decides who may ask, and the OS location
// permission must be granted on this device; neither can be prompted for remotely.

import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public final class LinkLocation {
    public static final String PACKET_TYPE_REQUEST = "link.location.request";
    public static final String PACKET_TYPE_LOCATION = "link.location";
    // A fresh fix that has not come by then is not coming (indoors, no sky): report what there is.
    private static final long FRESH_TIMEOUT_MS = 30000;

    public interface Sink {
        void send(LinkPacket packet);
    }

    private LinkLocation() {
    }

    public static boolean hasPermission(Context context) {
        return context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || context.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Whether precise (GPS) location was granted, not only approximate. */
    public static boolean hasPrecise(Context context) {
        return context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    public static LinkPacket createRequestPacket() {
        return new LinkPacket(PACKET_TYPE_REQUEST, new JSONObject());
    }

    /** A status without a position: "noPermission", "off", "unavailable" or "done". */
    static LinkPacket statusPacket(String status) {
        JSONObject body = new JSONObject();
        try {
            body.put("status", status);
        } catch (Exception ignored) {
        }
        return new LinkPacket(PACKET_TYPE_LOCATION, body);
    }

    static LinkPacket fixPacket(Location location, boolean fresh) {
        JSONObject body = new JSONObject();
        try {
            body.put("status", "fix");
            body.put("latitude", location.getLatitude());
            body.put("longitude", location.getLongitude());
            if (location.hasAccuracy()) body.put("accuracy", location.getAccuracy());
            if (location.hasAltitude()) body.put("altitude", location.getAltitude());
            if (location.hasSpeed()) body.put("speed", location.getSpeed());
            body.put("provider", location.getProvider() != null ? location.getProvider() : "");
            body.put("time", location.getTime());
            body.put("fresh", fresh);
        } catch (Exception ignored) {
        }
        return new LinkPacket(PACKET_TYPE_LOCATION, body);
    }

    private static LocationManager manager(Context context) {
        return (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
    }

    private static boolean locationEnabled(LocationManager lm) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return lm.isLocationEnabled();
        return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    /** The most recent fix any provider still remembers, or null. Never switches GPS on. */
    @SuppressWarnings("MissingPermission")
    static Location lastKnown(Context context) {
        if (!hasPermission(context)) return null;
        LocationManager lm = manager(context);
        if (lm == null) return null;
        Location best = null;
        for (String provider : lm.getProviders(true)) {
            try {
                Location l = lm.getLastKnownLocation(provider);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (Exception ignored) {
            }
        }
        return best;
    }

    /** Sends the last known fix, if any, without waking GPS: used when a paired device connects. */
    static void sendLastKnown(Context context, Sink sink) {
        Location last = lastKnown(context);
        if (last != null) sink.send(fixPacket(last, false));
    }

    /** Answers a request: last known fix, then fresh fixes from each provider, then "done". */
    @SuppressWarnings({"MissingPermission", "deprecation"})
    static void locate(Context context, Sink sink) {
        if (!hasPermission(context)) {
            sink.send(statusPacket("noPermission"));
            return;
        }
        LocationManager lm = manager(context);
        if (lm == null) {
            sink.send(statusPacket("unavailable"));
            return;
        }
        Location last = lastKnown(context);
        if (last != null) sink.send(fixPacket(last, false));
        if (!locationEnabled(lm)) {
            sink.send(statusPacket("off"));
            return;
        }

        List<String> providers = new ArrayList<>();
        // GPS is the precise one; network (Wi-Fi and cell) answers sooner, and indoors it may be all there is.
        if (hasPrecise(context) && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) providers.add(LocationManager.GPS_PROVIDER);
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) providers.add(LocationManager.NETWORK_PROVIDER);
        if (providers.isEmpty()) {
            sink.send(statusPacket(last != null ? "done" : "unavailable"));
            return;
        }

        Handler main = new Handler(Looper.getMainLooper());
        AtomicBoolean finished = new AtomicBoolean(false);
        AtomicInteger pending = new AtomicInteger(providers.size());
        CancellationSignal cancel = new CancellationSignal();
        List<LocationListener> listeners = new ArrayList<>();
        Runnable finish = () -> {
            if (!finished.compareAndSet(false, true)) return;
            cancel.cancel();
            for (LocationListener l : listeners) {
                try {
                    lm.removeUpdates(l);
                } catch (Exception ignored) {
                }
            }
            sink.send(statusPacket("done"));
        };
        main.postDelayed(finish, FRESH_TIMEOUT_MS);

        for (String provider : providers) {
            java.util.function.Consumer<Location> onFix = (location) -> {
                if (finished.get()) return;
                if (location != null) sink.send(fixPacket(location, true));
                if (pending.decrementAndGet() == 0) {
                    main.removeCallbacks(finish);
                    finish.run();
                }
            };
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    lm.getCurrentLocation(provider, cancel, context.getMainExecutor(), onFix);
                } else {
                    // Every method implemented: before API 30 the others are not default methods.
                    LocationListener listener = new LocationListener() {
                        @Override public void onLocationChanged(Location location) { onFix.accept(location); }
                        @Override public void onStatusChanged(String p, int status, android.os.Bundle extras) {}
                        @Override public void onProviderEnabled(String p) {}
                        @Override public void onProviderDisabled(String p) {}
                    };
                    listeners.add(listener);
                    lm.requestSingleUpdate(provider, listener, Looper.getMainLooper());
                }
            } catch (Exception e) {
                android.util.Log.w("LinkLocation", "Could not request a fix from " + provider, e);
                onFix.accept(null);
            }
        }
    }
}
