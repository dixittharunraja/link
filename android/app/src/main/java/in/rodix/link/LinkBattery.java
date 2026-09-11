package in.rodix.link;

// Battery plugin — Java port of kdeconnect-android's plugins/battery/BatteryPlugin.kt.
// Note: Android's threshold-low detection genuinely differs from the desktop C++ side (which
// hardcodes a 15%-and-discharging check) — Android relies on the OS's own ACTION_BATTERY_LOW/
// ACTION_BATTERY_OKAY signals instead. This isn't an inconsistency we introduced; it's upstream's
// actual per-platform behavior, and each of our platforms faithfully matches its own counterpart.

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;

import org.json.JSONObject;

public class LinkBattery {
    public static final String PACKET_TYPE_BATTERY = "link.battery";

    private static final int THRESHOLD_EVENT_NONE = 0;
    private static final int THRESHOLD_EVENT_BATTERY_LOW = 1;

    public static LinkPacket createPacket(boolean isCharging, int currentCharge, int thresholdEvent) {
        try {
            JSONObject body = new JSONObject();
            body.put("isCharging", isCharging);
            body.put("currentCharge", currentCharge);
            body.put("batteryQuantity", 1);
            body.put("thresholdEvent", thresholdEvent);
            return new LinkPacket(PACKET_TYPE_BATTERY, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static boolean isBatteryPacket(LinkPacket packet) {
        return PACKET_TYPE_BATTERY.equals(packet.type);
    }

    public interface Listener {
        void onChange(boolean isCharging, int currentCharge, int thresholdEvent);
    }

    /** Registers for battery broadcasts and reports changes, mirroring BatteryPlugin.kt's receiver exactly. */
    public static class Watcher {
        private final Context context;
        private final Listener listener;
        private final BroadcastReceiver receiver;

        private boolean isLowBattery = false;
        private int thresholdEvent = THRESHOLD_EVENT_NONE;
        private Boolean lastIsCharging = null;
        private Integer lastCurrentCharge = null;
        private Integer lastThresholdEvent = null;

        public Watcher(Context context, Listener listener) {
            this.context = context;
            this.listener = listener;

            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent batteryIntent) {
                    String action = batteryIntent.getAction();

                    if (!Intent.ACTION_BATTERY_CHANGED.equals(action)) {
                        if (Intent.ACTION_BATTERY_LOW.equals(action) && !isLowBattery) {
                            thresholdEvent = THRESHOLD_EVENT_BATTERY_LOW;
                        } else {
                            thresholdEvent = THRESHOLD_EVENT_NONE;
                        }

                        if (Intent.ACTION_BATTERY_OKAY.equals(action)) {
                            isLowBattery = false;
                        } else if (Intent.ACTION_BATTERY_LOW.equals(action)) {
                            isLowBattery = true;
                        }
                        // Intents with these two actions have no extras — wait for the next
                        // ACTION_BATTERY_CHANGED (which follows) to actually send the threshold event.
                        return;
                    }

                    int level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, 100);
                    int scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                    int plugged = batteryIntent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);

                    int currentCharge = level * 100 / scale;
                    boolean isCharging = plugged != 0;

                    boolean changed = lastIsCharging == null
                            || !lastIsCharging.equals(isCharging)
                            || !Integer.valueOf(currentCharge).equals(lastCurrentCharge)
                            || !Integer.valueOf(thresholdEvent).equals(lastThresholdEvent);

                    if (changed) {
                        lastIsCharging = isCharging;
                        lastCurrentCharge = currentCharge;
                        lastThresholdEvent = thresholdEvent;
                        listener.onChange(isCharging, currentCharge, thresholdEvent);

                        // Just sent the threshold event — reset so we don't re-notify on every
                        // subsequent change while still at low battery.
                        thresholdEvent = THRESHOLD_EVENT_NONE;
                    }
                }
            };

            IntentFilter filter = new IntentFilter();
            filter.addAction(Intent.ACTION_BATTERY_CHANGED);
            filter.addAction(Intent.ACTION_BATTERY_LOW);
            filter.addAction(Intent.ACTION_BATTERY_OKAY);
            Intent current = context.registerReceiver(receiver, filter);
            if (current != null) receiver.onReceive(context, current);
        }

        public void stop() {
            try {
                context.unregisterReceiver(receiver);
            } catch (Exception ignored) {
            }
        }

        public Boolean lastKnownIsCharging() {
            return lastIsCharging;
        }

        public Integer lastKnownCharge() {
            return lastCurrentCharge;
        }
    }
}
