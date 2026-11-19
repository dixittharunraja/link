package in.rodix.link;

import app.tauri.plugin.Invoke;
import app.tauri.plugin.JSObject;

import org.json.JSONObject;

// Remote control and camera hosting: this phone's screen (after the MediaProjection consent) or its
// camera streamed to a paired device through LinkRemoteControlServer, the WebRTC signaling for it,
// and the viewer's taps, swipes and keys injected through LinkAccessibilityService.
final class LinkRemoteControl extends LinkFeature {
    LinkRemoteControl(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {
        handlers.put("link.remotecontrol.signal", this::handleRemoteControlSignalPacket);
        handlers.put("link.remotecontrol.input", this::handleRemoteControlInputPacket);
    }

    static LinkRemoteControlServer sRemoteControlServer;

    void handleRemoteControlSignalPacket(String deviceId, LinkPacket packet) {
        if (sRemoteControlServer != null && sRemoteControlServer.isRunning() && packet.body != null) {
            sRemoteControlServer.handleRemoteSignal(packet.body);
        }
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        try {
            data.put("signal", new JSObject(packet.body.toString()));
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed parsing remote control signal json", e);
        }
        notifyListeners("remoteControlSignalReceived", data);
    }

    void handleRemoteControlInputPacket(String deviceId, LinkPacket packet) {
        // A guest was let in by the user's own accept; there is no permission entry to look up.
        boolean admittedGuest = deviceId.startsWith(LinkRemoteControlServer.GUEST_PREFIX);
        if (!admittedGuest && !LinkDevicePermissions.check(getContext(), deviceId, "remotecontrol")) {
            android.util.Log.i(TAG, "Blocked Remote Control input from " + deviceId + " (Permission disabled)");
            return;
        }
        LinkAccessibilityService service = LinkAccessibilityService.getInstance();
        if (service == null) return;

        try {
            org.json.JSONObject body = packet.getBody();
            String action = body.optString("action");
            // The picture the viewer sees is the whole physical screen, so its 0..1 positions map onto that.
            int[] screen = LinkRemoteControlServer.realScreenSize(getContext());

            if ("tap".equals(action) || "click".equals(action)) {
                double nx = body.optDouble("x", 0.5);
                double ny = body.optDouble("y", 0.5);
                float px = (float) (nx * screen[0]);
                float py = (float) (ny * screen[1]);
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                    service.injectTap(px, py);
                });
            } else if ("scroll".equals(action) || "swipe".equals(action)) {
                double sx = body.optDouble("startX", 0.5) * screen[0];
                double sy = body.optDouble("startY", 0.5) * screen[1];
                double ex = body.optDouble("endX", 0.5) * screen[0];
                double ey = body.optDouble("endY", 0.5) * screen[1];
                long dur = body.optLong("duration", 100);
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                    service.injectScroll((float) sx, (float) sy, (float) ex, (float) ey, dur);
                });
            } else if ("text".equals(action)) {
                String text = body.optString("text", "");
                LinkRemoteInput.injectText(text);
            } else if ("key".equals(action)) {
                String key = body.optString("key", "");
                LinkRemoteInput.injectSpecialKey(getContext(), key);
            }
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed handling remote control input packet", e);
        }
    }

    // ===== Remote Control =====
    @LinkMethod
    public void sendRemoteControlSignal(LinkCall call) {
        String deviceId = call.getString("deviceId");
        JSObject signalObj = call.getObject("signal");
        if (deviceId == null || signalObj == null || plugin.deviceManager == null) {
            call.reject("Missing arguments");
            return;
        }
        try {
            JSONObject body = new JSONObject(signalObj.toString());
            plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.remotecontrol.signal", body));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @LinkMethod
    public void sendRemoteControlInput(LinkCall call) {
        String deviceId = call.getString("deviceId");
        JSObject inputObj = call.getObject("input");
        if (deviceId == null || inputObj == null || plugin.deviceManager == null) {
            call.reject("Missing arguments");
            return;
        }
        try {
            JSONObject body = new JSONObject(inputObj.toString());
            plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.remotecontrol.input", body));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private String pendingRemoteControlDeviceId = null;

    @LinkMethod
    public void requestRemoteControlHost(LinkCall call) {
        pendingRemoteControlDeviceId = call.getString("deviceId");
        android.util.Log.i(TAG, "requestRemoteControlHost called for device: " + pendingRemoteControlDeviceId);

        if (sRemoteControlServer != null && sRemoteControlServer.isRunning()) {
            android.util.Log.i(TAG, "Remote control host is already running, resuming active session without re-prompting");
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }

        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                launchMediaProjectionConsentForRemoteControl(call);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed launching MediaProjection consent for remote control", e);
                JSObject ret = new JSObject();
                ret.put("granted", false);
                ret.put("error", e.getMessage());
                call.resolve(ret);
            }
        });
    }

    private void launchMediaProjectionConsentForRemoteControl(LinkCall call) {
        android.media.projection.MediaProjectionManager mgr =
            (android.media.projection.MediaProjectionManager) getContext().getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE);
        if (mgr == null) {
            android.util.Log.e(TAG, "MediaProjectionManager is null");
            JSObject ret = new JSObject();
            ret.put("granted", false);
            ret.put("error", "MediaProjectionManager unavailable");
            call.resolve(ret);
            return;
        }
        android.content.Intent intent = mgr.createScreenCaptureIntent();
        startActivityForResult(call.invoke(), intent, "onMediaProjectionResultRemoteControl");
    }

    // Called through LinkPlugin's @ActivityCallback of the same name.
    void onMediaProjectionResultRemoteControl(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        android.util.Log.i(TAG, "onMediaProjectionResultRemoteControl: resultCode=" + result.getResultCode());
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("granted", false);
            ret.put("error", "Screen capture permission was denied");
            call.resolve(ret);
            return;
        }

        try {
            if (sRemoteControlServer != null) {
                sRemoteControlServer.stop();
                sRemoteControlServer = null;
            }

            android.media.projection.MediaProjectionManager mgr =
                (android.media.projection.MediaProjectionManager) getContext().getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE);
            android.media.projection.MediaProjection projection = mgr.getMediaProjection(result.getResultCode(), result.getData());

            sRemoteControlServer = new LinkRemoteControlServer(
                getContext(),
                projection,
                pendingRemoteControlDeviceId,
                plugin.deviceManager
            );
            sRemoteControlServer.start();

            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed initializing remote control server", e);
            JSObject ret = new JSObject();
            ret.put("granted", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    // ===== Camera host: this phone's camera streamed to a paired PC (used as a webcam) =====
    // Unlike screen sharing there is no system consent dialog, so the per-device "camera"
    // permission is the gate (on by default, like the others; turned off per device).
    private String pendingCameraDeviceId = null;
    private boolean pendingCameraFront = false;

    @LinkMethod
    public void requestCameraHost(LinkCall call) {
        pendingCameraDeviceId = call.getString("deviceId");
        pendingCameraFront = "front".equals(call.getString("facing"));
        if (pendingCameraDeviceId == null || !LinkDevicePermissions.check(getContext(), pendingCameraDeviceId, "camera")) {
            android.util.Log.i(TAG, "Blocked camera request from " + pendingCameraDeviceId + " (permission off)");
            JSObject ret = new JSObject();
            ret.put("granted", false);
            ret.put("error", "Camera access is off for this device");
            call.resolve(ret);
            return;
        }
        if (sRemoteControlServer != null && sRemoteControlServer.isRunning()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("camera") != app.tauri.PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call.invoke(), "onCameraPermissionResult");
            return;
        }
        startCameraHostNow(call);
    }

    // Called through LinkPlugin's @PermissionCallback of the same name.
    void onCameraPermissionResult(Invoke invoke) {
        LinkCall call = new LinkCall(invoke);
        if (getPermissionState("camera") != app.tauri.PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", false);
            ret.put("error", "Camera permission denied");
            call.resolve(ret);
            return;
        }
        startCameraHostNow(call);
    }

    private void startCameraHostNow(LinkCall call) {
        try {
            if (sRemoteControlServer != null) {
                sRemoteControlServer.stop();
                sRemoteControlServer = null;
            }
            sRemoteControlServer = new LinkRemoteControlServer(getContext(), pendingCameraDeviceId, plugin.deviceManager, pendingCameraFront);
            sRemoteControlServer.start();
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed starting camera host", e);
            JSObject ret = new JSObject();
            ret.put("granted", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    @LinkMethod
    public void stopRemoteControlHost(LinkCall call) {
        android.util.Log.i(TAG, "stopRemoteControlHost called");
        if (sRemoteControlServer != null) {
            sRemoteControlServer.stop();
            sRemoteControlServer = null;
        }
        call.resolve();
    }
}
