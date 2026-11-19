package in.rodix.link;

// Tauri mobile plugin bridge: exposes the native LinkDeviceManager and feature servers to the
// WebView. The Android counterpart of desktop's commands.rs (called from src/utils/bridge.ts):
// the WebView never touches sockets, it only calls plugin methods and listens for events.
//
// This class owns the lifecycle: load() builds the identity, LinkDeviceManager and file server,
// registers the system hooks (receivers, watchers, the worker and torch threads, the heartbeat) that
// releaseSystemHooks() undoes on a reattach, and dispatches renderer calls and peer packets. Each
// feature area is a LinkFeature (LinkRemoteFiles, LinkInputRelay, LinkAudioSessions, ...) holding its
// own state, @LinkMethod handlers and packet handlers; call() and dispatchPacket() route to them.

import app.tauri.annotation.Command;
import app.tauri.annotation.Permission;
import app.tauri.annotation.TauriPlugin;
import app.tauri.plugin.Invoke;
import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;
import app.tauri.plugin.Plugin;
import android.Manifest;
import android.app.Activity;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONArray;
import org.json.JSONObject;

@TauriPlugin(
    permissions = {
        @Permission(
            // Bundled with READ_CALL_LOG: since Android 10, EXTRA_INCOMING_NUMBER is stripped
            // from the phone-state broadcast for apps without it, so caller ID silently breaks
            // (shows "Unknown Caller") even though READ_PHONE_STATE alone is still granted.
            alias = "phoneState",
            strings = { Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG, Manifest.permission.ANSWER_PHONE_CALLS }
        ),
        @Permission(
            alias = "contacts",
            strings = { Manifest.permission.READ_CONTACTS }
        ),
        @Permission(
            alias = "notifications",
            strings = { "android.permission.POST_NOTIFICATIONS" }
        ),
        // Hosting Audio Relay: AudioPlaybackCaptureConfiguration requires this in addition to the
        // MediaProjection consent dialog (see startAudioSink()).
        @Permission(
            alias = "microphone",
            strings = { Manifest.permission.RECORD_AUDIO }
        ),
        @Permission(
            alias = "camera",
            strings = { Manifest.permission.CAMERA }
        ),
        // Locate (LinkLocation): a paired device allowed to may ask where this one is.
        @Permission(
            alias = "location",
            strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }
        )
    }
)
public class LinkPlugin extends Plugin {
    private static final String TAG = "LinkPlugin";
    // Key under which the Rust-side `link_call` command nests the renderer's arguments, next to
    // the "method" name (see call()).
    static final String ARGS_KEY = "args";

    private final Activity activity;
    // @LinkMethod name -> handler, and the object (this plugin or one of its features) it runs on.
    private final java.util.Map<String, java.lang.reflect.Method> methods = new java.util.HashMap<>();
    private final java.util.Map<String, Object> methodTargets = new java.util.HashMap<>();
    // Serial: handlers assume one-at-a-time execution, and blocking ones (requestPairing's connect
    // wait) must stay off Tauri's IPC thread.
    private final java.util.concurrent.ExecutorService callExecutor = java.util.concurrent.Executors.newFixedThreadPool(4);

    /** Handles one packet type from a connected peer; see packetHandlers. */
    interface PacketHandler {
        void handle(String deviceId, LinkPacket packet);
    }

    // Exact packet type -> handler, filled by the plugin and every feature in the constructor.
    // Families addressed by prefix (link.share.*, link.walkietalkie.*) are in packetPrefixHandlers.
    private final java.util.Map<String, PacketHandler> packetHandlers = new java.util.HashMap<>();
    private final java.util.LinkedHashMap<String, PacketHandler> packetPrefixHandlers = new java.util.LinkedHashMap<>();

    public LinkPlugin(Activity activity) {
        super(activity);
        this.activity = activity;
        features = new LinkFeature[] {
            remoteFiles = new LinkRemoteFiles(this),
            inputRelay = new LinkInputRelay(this),
            new LinkInputGuests(this),
            remoteControl = new LinkRemoteControl(this),
            new LinkWalkieTalkie(this),
            audioSessions = new LinkAudioSessions(this),
            portal = new LinkPortal(this),
            telephony = new LinkTelephonyNotifications(this),
            media = new LinkMediaVolume(this),
            connections = new LinkConnections(this),
            pairing = new LinkPairing(this),
            controls = new LinkDeviceControls(this),
            new LinkSystemSettings(this),
        };
        registerMethods(this);
        for (LinkFeature feature : features) registerMethods(feature);
        registerPackets();
        for (LinkFeature feature : features) {
            feature.registerPackets(packetHandlers);
            feature.registerPacketPrefixes(packetPrefixHandlers);
        }
    }

    private void registerMethods(Object target) {
        for (java.lang.reflect.Method method : target.getClass().getDeclaredMethods()) {
            if (!method.isAnnotationPresent(LinkMethod.class)) continue;
            method.setAccessible(true);
            if (methods.put(method.getName(), method) != null) {
                throw new IllegalStateException("Duplicate @LinkMethod " + method.getName());
            }
            methodTargets.put(method.getName(), target);
        }
    }

    private final LinkFeature[] features;
    final LinkRemoteFiles remoteFiles;
    final LinkInputRelay inputRelay;
    final LinkRemoteControl remoteControl;
    final LinkAudioSessions audioSessions;
    final LinkPortal portal;
    final LinkTelephonyNotifications telephony;
    final LinkMediaVolume media;
    final LinkConnections connections;
    final LinkPairing pairing;
    final LinkDeviceControls controls;

    // Activity results are delivered by name to methods on the plugin class, so the features'
    // callbacks are forwarded from here.
    @app.tauri.annotation.ActivityCallback
    private void onFsUploadFilesPicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        remoteFiles.onFsUploadFilesPicked(invoke, result);
    }

    @app.tauri.annotation.ActivityCallback
    private void onFsUploadTreePicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        remoteFiles.onFsUploadTreePicked(invoke, result);
    }

    @app.tauri.annotation.ActivityCallback
    private void onPortalFilesPicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        portal.onPortalFilesPicked(invoke, result);
    }

    @app.tauri.annotation.PermissionCallback
    private void onRecordAudioPermissionResult(Invoke invoke) {
        audioSessions.onRecordAudioPermissionResult(invoke);
    }

    @app.tauri.annotation.ActivityCallback
    private void onMediaProjectionResult(Invoke invoke, androidx.activity.result.ActivityResult result) {
        audioSessions.onMediaProjectionResult(invoke, result);
    }

    @app.tauri.annotation.PermissionCallback
    private void onRecordAudioPermissionResultMic(Invoke invoke) {
        audioSessions.onRecordAudioPermissionResultMic(invoke);
    }

    @app.tauri.annotation.ActivityCallback
    private void onMediaProjectionResultRemoteControl(Invoke invoke, androidx.activity.result.ActivityResult result) {
        remoteControl.onMediaProjectionResultRemoteControl(invoke, result);
    }

    @app.tauri.annotation.PermissionCallback
    private void onCameraPermissionResult(Invoke invoke) {
        remoteControl.onCameraPermissionResult(invoke);
    }

    // Packet types this class handles itself; the features add theirs in registerPackets().
    private void registerPackets() {
        java.util.Map<String, PacketHandler> h = packetHandlers;
        // The peer's UI reloaded and asks for this device's full state (the receiving side of
        // resyncDevices; mirrors desktop's core/host.rs).
        h.put("link.resync.request", (deviceId, packet) -> sendInitialSync(deviceId));
        h.put(LinkClipboard.PACKET_TYPE_CLIPBOARD, this::handleClipboardPacket);
        h.put(LinkClipboard.PACKET_TYPE_CLIPBOARD_CONNECT, this::handleClipboardPacket);
        h.put(LinkClipboard.PACKET_TYPE_CLIPBOARD_FILE, this::handleClipboardPacket);
        packetPrefixHandlers.put("link.share.", (deviceId, packet) -> LinkShare.handlePacket(getContext(), deviceManager, deviceId, packet));
    }

    private void dispatchPacket(String deviceId, LinkPacket packet) {
        if (packet.type == null) return;
        PacketHandler handler = packetHandlers.get(packet.type);
        if (handler == null) {
            for (java.util.Map.Entry<String, PacketHandler> entry : packetPrefixHandlers.entrySet()) {
                if (packet.type.startsWith(entry.getKey())) {
                    handler = entry.getValue();
                    break;
                }
            }
        }
        if (handler != null) handler.handle(deviceId, packet);
    }

    Activity activity() {
        return activity;
    }

    private Activity getActivity() {
        return activity;
    }

    private android.content.Context getContext() {
        return activity;
    }

    private void notifyListeners(String event, JSObject data) {
        trigger(event, data != null ? data : new JSObject());
    }

    /** notifyListeners for the feature classes. */
    void emit(String event, JSObject data) {
        notifyListeners(event, data);
    }

    void startActivityForResultFor(Invoke invoke, android.content.Intent intent, String callbackName) {
        startActivityForResult(invoke, intent, callbackName);
    }

    void requestPermissionFor(String alias, Invoke invoke, String callbackName) {
        requestPermissionForAlias(alias, invoke, callbackName);
    }

    @Command
    public void call(Invoke invoke) {
        String name = invoke.getArgs().getString("method", null);
        java.lang.reflect.Method method = name != null ? methods.get(name) : null;
        if (method == null) {
            invoke.reject("Unknown Link method: " + name);
            return;
        }
        Object target = methodTargets.get(name);
        callExecutor.execute(() -> {
            try {
                method.invoke(target, new LinkCall(invoke));
            } catch (java.lang.reflect.InvocationTargetException e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                android.util.Log.e(TAG, name + " failed", cause);
                invoke.reject(String.valueOf(cause.getMessage()));
            } catch (ReflectiveOperationException e) {
                invoke.reject("Cannot dispatch " + name + ": " + e);
            }
        });
    }

    // Capability keys live in LinkCapabilitiesSchema.java.

    // Feature switch for plugin wiring in this file; a plugin not listed here is not wired up.
    // Features that are always available (rename, ring, Speed Test, ...) are not gated.
    private static final java.util.Set<String> ENABLED_PLUGINS = new java.util.HashSet<>(java.util.Arrays.asList(
        "Clipboard", "Battery", "Flashlight", "DND", "Lock", "Notification", "RunCommand",
        "Presenter", "Digitizer", "Touchpad", "Telephony", "MPRIS", "Joystick", "RemoteControl"
    ));
    // Package-private so LinkSendClipboard can use it.
    static boolean isEnabled(String name) {
        return ENABLED_PLUGINS.contains(name);
    }

    // Sends a state update to every connected trusted peer that holds permKey. Mirrors desktop's
    // broadcast_permitted() in core/host.rs.
    void broadcastToPermittedPeers(String permKey, LinkPacket packet) {
        for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
            if (!LinkDevicePermissions.check(getContext(), peerId, permKey)) continue;
            deviceManager.sendTo(peerId, packet);
        }
    }

    LinkIdentity.Identity myIdentity;
    LinkDeviceManager deviceManager;
    public static LinkDeviceManager sDeviceManager;
    // Static fields below let a second LinkPlugin.load() in the same still-alive process (the
    // foreground service keeps it running after the activity goes) find and stop the previous
    // instance's servers and sessions instead of leaving them orphaned.
    private static LinkFsServer sFsServer;
    LinkSettings settings;
    private LinkClipboard.Watcher clipboardWatcher;
    private volatile long lastKnownClipboardTimestamp = 0;
    private LinkBattery.Watcher batteryWatcher;
    LinkFsServer fsServer;
    // Files shared to "File Transfer (Link)" (see MainActivity), waiting for the page to take them.
    private static final java.util.List<String> sPendingSharedFiles = new java.util.ArrayList<>();
    private static LinkPlugin sInstance;

    // Events from a long-lived server must reach the CURRENT plugin instance, not the one that started it: the screen
    // (and with it the plugin) can be recreated while the server keeps running.
    static void emitStatic(String event, JSObject data) {
        LinkPlugin plugin = sInstance;
        if (plugin != null) plugin.notifyListeners(event, data);
    }

    /** Called by MainActivity with the content:// URIs of files shared in; the page is told and fetches them. */
    static void deliverSharedFiles(java.util.List<String> uris) {
        synchronized (sPendingSharedFiles) {
            sPendingSharedFiles.addAll(uris);
        }
        LinkPlugin plugin = sInstance;
        if (plugin != null) plugin.notifyListeners("sharedFiles", new JSObject());
    }

    @LinkMethod
    public void takePendingSharedFiles(LinkCall call) {
        JSArray uris = new JSArray();
        synchronized (sPendingSharedFiles) {
            for (String uri : sPendingSharedFiles) uris.put(uri);
            sPendingSharedFiles.clear();
        }
        JSObject ret = new JSObject();
        ret.put("uris", uris);
        call.resolve(ret);
    }
    // Call-state handling (contact lookups, photo encoding), media-session reads and volume
    // broadcasts run on this thread rather than the main thread that also draws the UI. Quit by
    // releaseSystemHooks() when a reattached plugin replaces this one.
    final android.os.HandlerThread workerThread = startWorkerThread();
    private static android.os.HandlerThread startWorkerThread() {
        android.os.HandlerThread thread = new android.os.HandlerThread("link-plugin-worker");
        thread.start();
        return thread;
    }
    // Some devices send the first RINGING broadcast without EXTRA_INCOMING_NUMBER and a second one
    // with it moments later; telephonyReceiver delays briefly so peers do not flash
    // "Unknown Caller" first.
    final android.os.Handler telephonyHandler = new android.os.Handler(workerThread.getLooper());

    public static final String ACTION_NOTIFICATION_DISMISSED = "in.rodix.link.ACTION_NOTIFICATION_DISMISSED";
    static final int NOTIFICATION_ID = 9991; // package-visible: shared with LinkForegroundService
    private static final String CHANNEL_ID = "link_foreground_channel";

    // LinkForegroundService holds its Wi-Fi lock only while a paired device is connected.
    private void updateWifiLock() {
        LinkDeviceManager manager = deviceManager;
        LinkForegroundService.setPeerConnected(manager != null && !manager.trustedConnectedDeviceIds().isEmpty());
    }

    // What load() hooked into the system, so releaseSystemHooks() can undo it.
    private final java.util.List<android.content.BroadcastReceiver> registeredReceivers = new java.util.ArrayList<>();

    /** Registers a receiver that releaseSystemHooks() unregisters. flags33 is the
     *  Context.RECEIVER_EXPORTED/NOT_EXPORTED flag API 33+ asks for, or 0 for system broadcasts. */
    void registerSystemReceiver(android.content.BroadcastReceiver receiver, android.content.IntentFilter filter, int flags33) {
        registeredReceivers.add(receiver);
        if (flags33 != 0 && android.os.Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(receiver, filter, flags33);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }
    private volatile android.os.HandlerThread torchCallbackThread;
    private volatile android.hardware.camera2.CameraManager.TorchCallback torchCallback;

    /** Undoes what load() hooked into the system. Called on the previous plugin when a reattach in
     *  the same process replaces it (see load()); otherwise each reattach would stack another set of
     *  receivers, watchers, callbacks and timers, and every event would reach peers once per copy.
     *  Not called from onDestroy(): the process outlives the activity (LinkForegroundService) and
     *  these keep peers informed until a new plugin takes over. */
    private void releaseSystemHooks() {
        android.content.Context context = getContext();
        for (android.content.BroadcastReceiver receiver : registeredReceivers) {
            // Receivers on a destroyed activity were already removed by the system.
            try { context.unregisterReceiver(receiver); } catch (Exception ignored) {}
        }
        registeredReceivers.clear();
        if (clipboardWatcher != null) clipboardWatcher.stop();
        if (batteryWatcher != null) batteryWatcher.stop();
        if (torchCallback != null) {
            try {
                android.hardware.camera2.CameraManager cameraManager =
                    (android.hardware.camera2.CameraManager) context.getSystemService(android.content.Context.CAMERA_SERVICE);
                if (cameraManager != null) cameraManager.unregisterTorchCallback(torchCallback);
            } catch (Exception ignored) {}
            torchCallback = null;
        }
        if (torchCallbackThread != null) {
            torchCallbackThread.quitSafely();
            torchCallbackThread = null;
        }
        heartbeatHandler.removeCallbacks(heartbeatRunnable);
        connections.trustedReconnectHandler.removeCallbacksAndMessages(null);
        telephonyHandler.removeCallbacksAndMessages(null);
        media.release();
        workerThread.quitSafely();
    }

    // App-level heartbeat; a relaxed interval and timeout favour battery life and data use.
    private static final long HEARTBEAT_INTERVAL_MS = 4000;
    private static final long HEARTBEAT_TIMEOUT_MS = 12000;
    private final android.os.Handler heartbeatHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable heartbeatRunnable = new Runnable() {
        @Override
        public void run() {
            if (deviceManager != null) {
                deviceManager.runHeartbeatCycle(HEARTBEAT_TIMEOUT_MS);
                connections.updateDiscoveryPace();
                connections.redialMissingIfDue();
                LinkShare.refreshShortcutsIfChanged(getContext(), deviceManager);
            }
            heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
        }
    };

    @Override
    public void load(WebView webView) {
        android.util.Log.i(TAG, "load() starting");
        try {
            // Keep-alive foreground service, so the process and its sockets survive the app being
            // swiped from Recents. A failure only loses background persistence; the rest of
            // load() must still run.
            try {
                androidx.core.content.ContextCompat.startForegroundService(
                    getContext(), new android.content.Intent(getContext(), LinkForegroundService.class));
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to start LinkForegroundService", e);
            }

            // The process can outlive the activity, so reopening the app calls load() on a new
            // LinkPlugin in the same process. The previous instance's receivers, watchers and timers
            // are released first, so they do not stack with the ones registered below.
            LinkPlugin previous = sInstance;
            if (previous != null && previous != this) {
                try {
                    previous.releaseSystemHooks();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error releasing the previous plugin's system hooks", e);
                }
            }
            // The previous DeviceManager/FsServer still hold the
            // TCP ports and must be shut down first, or binding fails and the bridge hangs
            // mid-init.
            if (sDeviceManager != null) {
                android.util.Log.i(TAG, "Reattaching in an already-running process — shutting down previous DeviceManager");
                try {
                    sDeviceManager.shutdown();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error shutting down previous DeviceManager", e);
                }
                sDeviceManager = null;
            }
            if (sFsServer != null) {
                try {
                    sFsServer.stop();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error stopping previous FsServer", e);
                }
                sFsServer = null;
            }
            for (LinkFeature feature : features) {
                try {
                    feature.stopPreviousInstance();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error stopping what the previous plugin left running", e);
                }
            }

            myIdentity = LinkIdentity.loadOrCreate(getContext(), LinkCapabilitiesSchema.CAPABILITIES, LinkCapabilitiesSchema.CAPABILITIES);
            android.util.Log.i(TAG, "identity loaded: " + myIdentity.deviceId + " / " + myIdentity.deviceName);
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), myIdentity.deviceId);
            android.util.Log.i(TAG, "tls identity loaded");
            LinkTrustStore trustStore = LinkTrustStore.getInstance(getContext());

            try {
                fsServer = new LinkFsServer(getContext(), tls.certificate, tls.privateKey, LinkTransport.LINK_PORT + 2);
                fsServer.start();
                sFsServer = fsServer;
                android.util.Log.i(TAG, "FS Server started on port " + (LinkTransport.LINK_PORT + 2));
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to start FS Server", e);
            }

            // A second guest presenting a tool QR code's token after it was used is reported like a second pairing.
            LinkGuestAccess.setConflictListener(name -> {
                JSObject data = new JSObject();
                data.put("deviceName", name);
                notifyListeners("pairingBlocked", data);
            });

            deviceManager = new LinkDeviceManager(myIdentity, tls.certificate, tls.privateKey,
                    trustStore, new LinkDeviceManager.Listener() {
                @Override
                public void onDeviceConnected(LinkIdentity.Identity identity, boolean trusted) {
                    if (LinkBlocklist.isBlocked(getContext(), identity.deviceId)) {
                        deviceManager.closeConnection(identity.deviceId);
                        return;
                    }
                    if (trusted) {
                        try {
                            if (!LinkDevicePermissions.getAll(getContext()).has(identity.deviceId)) {
                                android.util.Log.i(TAG, "[Link] Auto-initializing denied permissions for newly connected pool device: " + identity.deviceId);
                                LinkDevicePermissions.initializeDeniedPermissionsForNewDevice(getContext(), identity.deviceId);
                            }
                        } catch (Exception ignored) {}
                    }
                    java.util.concurrent.CountDownLatch pending = LinkConnections.sPendingConnectWaits.remove(identity.deviceId);
                    if (pending != null) pending.countDown();
                    String remoteIpMatch = deviceManager.remoteAddressOf(identity.deviceId);
                    if (remoteIpMatch != null) {
                        LinkConnections.PendingIpWait ipWait = LinkConnections.sPendingIpConnectWaits.remove(remoteIpMatch);
                        if (ipWait != null) {
                            ipWait.resolvedDeviceId = identity.deviceId;
                            ipWait.latch.countDown();
                        }
                    }
                    JSObject data = new JSObject();
                    data.put("deviceId", identity.deviceId);

                    String displayName = identity.deviceName;
                    if (trusted) {
                        LinkTrustStore.TrustedDevice dev = trustStore.get(identity.deviceId);
                        if (dev != null) {
                            displayName = dev.deviceName;
                        }
                    }

                    data.put("deviceName", displayName);
                    data.put("trusted", trusted);
                    String remoteIp = deviceManager.remoteAddressOf(identity.deviceId);
                    if (remoteIp != null) {
                        data.put("ipAddress", remoteIp);
                        data.put("link", LinkTailscale.isTailscaleAddr(remoteIp) ? "remote" : "lan");
                        if (trusted) {
                            LinkTrustStore trustStore = deviceManager != null ? deviceManager.getTrustStore() : LinkTrustStore.getInstance(getContext());
                            LinkTrustStore.TrustedDevice existing = trustStore.get(identity.deviceId);
                            boolean ipChanged = existing != null && !remoteIp.equals(existing.lastKnownIp);
                            trustStore.updateLastKnownIp(identity.deviceId, remoteIp);
                            if (ipChanged && deviceManager != null) {
                                deviceManager.broadcastPoolSync();
                            }
                        }
                    }
                    data.put("deviceType", identity.deviceType);
                    try {
                        data.put("incomingCapabilities", new JSArray(identity.incomingCapabilities));
                        data.put("outgoingCapabilities", new JSArray(identity.outgoingCapabilities));
                    } catch (Exception e) {
                        android.util.Log.e(TAG, "Failed to serialize capabilities", e);
                    }
                    notifyListeners("deviceConnected", data);
                    if (trusted) {
                        sendInitialSync(identity.deviceId);
                    }
                }

                @Override
                public void onDeviceDisconnected(String deviceId) {
                    // A peer that was connected and dropped may reconnect on the next broadcast;
                    // backoff only applies to attempts that fail outright.
                    connections.clearConnectBackoff(deviceId);
                    pairing.peerCapabilities.remove(deviceId); // a fresh connect resends them
                    LinkInputRelay.forgetInputTokens(deviceId);
                    telephony.notificationIconsSent.remove(deviceId); // a fresh connect gets the icons again
                    updateWifiLock();

                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
                    notifyListeners("deviceDisconnected", data);
                }

                @Override
                public void onIncomingPairRequest(String deviceId, String deviceName, String deviceType, String verificationKey, boolean viaQr) {
                    if (LinkBlocklist.isBlocked(getContext(), deviceId)) {
                        deviceManager.rejectPairing(deviceId);
                        return;
                    }
                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
                    data.put("deviceName", deviceName);
                    data.put("deviceType", deviceType);
                    data.put("verificationKey", verificationKey);
                    data.put("viaQr", viaQr);
                    notifyListeners("incomingPairRequest", data);
                }

                @Override
                public void onPairingBlocked(String deviceName) {
                    JSObject data = new JSObject();
                    data.put("deviceName", deviceName);
                    notifyListeners("pairingBlocked", data);
                }

                @Override
                public void onPairingSuccessful(String deviceId) {
                    LinkDevicePermissions.initializeDeniedPermissionsForNewDevice(getContext(), deviceId);
                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
                    notifyListeners("pairingSuccessful", data);
                    sendInitialSync(deviceId);
                }

                @Override
                public void onPairingFailed(String deviceId, String reason) {
                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
                    data.put("reason", reason);
                    notifyListeners("pairingFailed", data);
                }

                @Override
                public void onUnpaired(String deviceId) {
                    // A hidden paired device was listed as discovered; once removed it must not show as nearby.
                    LinkConnections.sDiscoveredPeers.remove(deviceId);
                    LinkDiscovery.Watcher watcher = connections.discoveryWatcher != null ? connections.discoveryWatcher : LinkConnections.sDiscoveryWatcher;
                    if (watcher != null) watcher.forget(deviceId);
                    LinkDevicePermissions.deletePermissionsForDevice(getContext(), deviceId);
                    LinkInputRelay.forgetInputTokens(deviceId);
                    updateWifiLock();
                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
                    notifyListeners("unpaired", data);
                }

                @Override
                public void onTrustMismatch(String deviceId) {
                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
                    notifyListeners("trustMismatch", data);
                }

                @Override
                public void onTrustListUpdated() {
                    if (deviceManager != null) {
                        for (LinkTrustStore.TrustedDevice d : deviceManager.getTrustStore().list()) {
                            connections.clearConnectBackoff(d.deviceId);
                        }
                    }
                    connections.attemptTrustedReconnects();
                    if (deviceManager != null) LinkShare.refreshShortcuts(getContext(), deviceManager);
                    JSObject data = new JSObject();
                    notifyListeners("trustListUpdated", data);
                }

                @Override
                public void onPacket(String deviceId, LinkPacket packet) {
                    dispatchPacket(deviceId, packet);
                }
            });
            controls.speedTest = new LinkSpeedTest(deviceManager);

            // A TV runs on mains power: it has no battery to report, and peers would show a meaningless 100%.
            android.app.UiModeManager uiModeForBattery = (android.app.UiModeManager) getContext().getSystemService(android.content.Context.UI_MODE_SERVICE);
            boolean isTvDevice = uiModeForBattery != null
                    && uiModeForBattery.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;
            if (!isTvDevice) {
            batteryWatcher = new LinkBattery.Watcher(getContext(), (isCharging, currentCharge, thresholdEvent) -> {
                for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                    deviceManager.sendTo(peerId, LinkBattery.createPacket(isCharging, currentCharge, thresholdEvent));
                }
            });
            }

            clipboardWatcher = new LinkClipboard.Watcher(getContext(), new LinkClipboard.Listener() {
                @Override
                public void onLocalTextChange(String content) {
                    lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
                    if (!isEnabled("Clipboard")) return;
                    broadcastToPermittedPeers("clipboard", LinkClipboard.createClipboardPacket(content));
                }
            });

            telephony.watchNotificationsAndCalls();

            // Mute and End buttons on the session notification (see
            // LinkAudioSessions.updateSessionNotification()). Not exported; only this app's
            // PendingIntents send it.
            android.content.BroadcastReceiver sessionActionReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, android.content.Intent intent) {
                    audioSessions.onSessionAction(intent);
                }
            };
            android.content.IntentFilter sessionFilter = new android.content.IntentFilter();
            sessionFilter.addAction(LinkAudioSessions.ACTION_SESSION_MUTE_TOGGLE);
            sessionFilter.addAction(LinkAudioSessions.ACTION_SESSION_END);
            registerSystemReceiver(sessionActionReceiver, sessionFilter, android.content.Context.RECEIVER_NOT_EXPORTED);

            try {
                deviceManager.startServer(LinkTransport.LINK_PORT);
                android.util.Log.i(TAG, "server started on port " + LinkTransport.LINK_PORT);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to start server on port " + LinkTransport.LINK_PORT, e);
            }

            inputRelay.startInputUdpServer();

            connections.startDiscovery(tls);

            media.watchVolume();

            // Torch callback: pushes torch changes made outside the app (Quick Settings, other
            // apps) to peers. registerTorchCallback() queries camera hardware synchronously and
            // can block for over a second on some devices, and load() runs inside
            // MainActivity.onCreate(), so it is registered on a long-lived HandlerThread that also
            // receives the callbacks.
            // Kept in fields so releaseSystemHooks() can unregister it and quit the thread.
            final android.os.HandlerThread torchThread = new android.os.HandlerThread("link-torch-callback");
            torchThread.start();
            torchCallbackThread = torchThread;
            new android.os.Handler(torchThread.getLooper()).post(() -> {
                if (torchCallbackThread != torchThread) return; // released before it got here
                android.hardware.camera2.CameraManager cameraManager =
                    (android.hardware.camera2.CameraManager) getContext().getSystemService(android.content.Context.CAMERA_SERVICE);
                if (cameraManager == null) return;
                try {
                    android.hardware.camera2.CameraManager.TorchCallback callback = new android.hardware.camera2.CameraManager.TorchCallback() {
                        @Override
                        public void onTorchModeChanged(String cameraId, boolean enabled) {
                            LinkFlashlight.setTorchState(enabled);
                            // Find My Device blinks the torch twice a second; peers hear only the
                            // final state once it stops (LinkFindMyDevice.stopRinging).
                            if (LinkFindMyDevice.isRinging()) return;
                            LinkPacket np = LinkFlashlight.createStatusPacket(enabled);
                            broadcastToPermittedPeers("flashlight", np);
                        }
                    };
                    cameraManager.registerTorchCallback(callback, new android.os.Handler(torchThread.getLooper()));
                    torchCallback = callback;
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Failed to register torch callback", e);
                }
            });

            // Pushes interruption-filter (DND) changes made outside the app to peers.
            android.content.BroadcastReceiver dndReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, android.content.Intent intent) {
                    // This broadcast fires even without DND access, which reading the state needs.
                    if (!LinkDND.isDndGranted(getContext())) return;
                    LinkPacket np = LinkDND.createStatusPacket(getContext());
                    broadcastToPermittedPeers("dnd", np);
                }
            };
            registerSystemReceiver(dndReceiver,
                new android.content.IntentFilter(android.app.NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED), 0);

            // Pushes every screen lock/unlock to peers, including OS timeouts.
            android.content.BroadcastReceiver lockReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, android.content.Intent intent) {
                    LinkPacket np = LinkLock.createLockPacket(getContext(), null);
                    for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                        deviceManager.sendTo(peerId, np);
                    }
                }
            };
            android.content.IntentFilter lockFilter = new android.content.IntentFilter();
            lockFilter.addAction(android.content.Intent.ACTION_SCREEN_OFF);
            lockFilter.addAction(android.content.Intent.ACTION_USER_PRESENT);
            registerSystemReceiver(lockReceiver, lockFilter, 0);

            media.watchMediaSessions();
            heartbeatHandler.post(heartbeatRunnable);

            // The notification's "Send Clipboard" action is handled by LinkSendClipboard (see
            // buildActiveNotification) and ACTION_NOTIFICATION_DISMISSED by LinkForegroundService.

            showActiveNotification();

            sDeviceManager = deviceManager;
            sInstance = this;
            LinkShare.refreshShortcuts(getContext(), deviceManager);
        } catch (Exception e) {
            android.util.Log.e(TAG, "load() failed gracefully", e);
        }
    }

    @Override
    public void onResume(AppCompatActivity resumedActivity) {
        super.onResume(resumedActivity);
        notifyListeners("appResumed", new JSObject());
        // Notification access may have just been granted in Settings.
        media.watchMediaSessions();
        if (connections.discoveryWatcher != null) {
            // Hear other devices while the app is open, even with every paired device connected.
            connections.discoveryWatcher.listenFor(LinkConnections.LISTEN_WHILE_IN_USE_MS);
            connections.discoveryWatcher.broadcastNow();
        }
        connections.attemptTrustedReconnectsAsync();
    }

    // ===== Packet handlers, dispatched from the deviceManager listener's onPacket =====

    private void handleClipboardPacket(String deviceId, LinkPacket packet) {
        if (!isEnabled("Clipboard")) return;
        // Not gated on this device's "clipboard" permission: that switch means "send this device
        // your clipboard" (the sender applies its own, see LinkDevicePermissions.canSendClipboardTo),
        // so it never refuses what a paired device sends in. The global Clipboard switch above does.
        if (!LinkClipboard.PACKET_TYPE_CLIPBOARD_FILE.equals(packet.type)) {
            String text = LinkClipboard.extractIncomingText(packet, lastKnownClipboardTimestamp);
            if (text != null) {
                clipboardWatcher.applyRemote(text);
                lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
                // The text itself is never logged: logcat is readable by other tools.
                android.util.Log.i(TAG, "Clipboard received from " + deviceId + " (" + text.length() + " chars)");
                JSObject data = new JSObject();
                data.put("deviceId", deviceId);
                notifyListeners("clipboardReceived", data);
            }
        }
    }

    /** Peer display name for labeling Audio Relay/Remote Mic listeners. Those servers have no
     *  trust-store access, so the name is passed to issueToken(). */
    String getDeviceDisplayName(String deviceId) {
        try {
            LinkTrustStore.TrustedDevice dev = LinkTrustStore.getInstance(getContext()).get(deviceId);
            if (dev != null && dev.deviceName != null) return dev.deviceName;
        } catch (Exception ignored) {}
        return deviceId;
    }

    /** Blocks a guest of an untrusted tool (mirrors block_guest() in core/guest.rs). If the IP
     *  belongs to a paired or discovered device, it is blocked by deviceId with its real name and
     *  type, so the entry matches one made from a pairing request; otherwise by IP. */
    void blockUntrustedGuest(String remoteAddress, String selfReportedName) {
        String cleanIp = remoteAddress != null ? remoteAddress.replace("::ffff:", "").split(":")[0] : null;
        if (cleanIp == null) return;

        String pairedId = deviceManager != null ? deviceManager.deviceIdForAddress(cleanIp) : null;
        if (pairedId != null) {
            String name = getDeviceDisplayName(pairedId);
            LinkBlocklist.add(getContext(), pairedId, name != null ? name : (selfReportedName != null ? selfReportedName : "Guest (" + cleanIp + ")"), "device", null, cleanIp);
            return;
        }

        for (JSObject peer : LinkConnections.sDiscoveredPeers.values()) {
            if (cleanIp.equals(peer.getString("ipAddress"))) {
                String deviceId = peer.getString("deviceId");
                String deviceName = peer.getString("deviceName");
                String deviceType = peer.getString("deviceType");
                LinkBlocklist.add(getContext(), deviceId, deviceName != null ? deviceName : (selfReportedName != null ? selfReportedName : "Guest (" + cleanIp + ")"), "device", deviceType, cleanIp);
                return;
            }
        }

        LinkBlocklist.add(getContext(), cleanIp, selfReportedName != null ? selfReportedName : "Guest (" + cleanIp + ")", "ip");
    }

    void sendInitialSync(String deviceId) {
        if (deviceManager == null) return;
        // Fills in defaults for permission keys this device has no entry for yet; existing
        // values are kept.
        LinkDevicePermissions.initializeDeniedPermissionsForNewDevice(getContext(), deviceId);
        // A paired device is connected: the foreground service holds its Wi-Fi lock, and media
        // changes are watched if notification access was granted since.
        updateWifiLock();
        media.watchMediaSessions();
        // Capabilities first, so the peer's UI knows which features it may use before any state
        // arrives.
        deviceManager.sendTo(deviceId, LinkCapabilities.createCapabilitiesPacket(getContext(), deviceId));
        inputRelay.sendInputToken(deviceId);
        // "Last seen": a device allowed to locate this one keeps the newest position it got, so it
        // still has one if this device is later lost and unreachable. Only the remembered fix is
        // sent; GPS is not switched on for it.
        if (LinkDevicePermissions.check(getContext(), deviceId, "location")) {
            LinkLocation.sendLastKnown(getContext(), (packet) -> deviceManager.sendTo(deviceId, packet));
        }
        if (LinkDevicePermissions.check(getContext(), deviceId, "mpris")) {
            deviceManager.sendTo(deviceId, LinkMpris.createLocalStatePacket(getContext()));
        }

        if (isEnabled("Clipboard") && clipboardWatcher != null && LinkDevicePermissions.canSendClipboardTo(getContext(), deviceId)) {
            deviceManager.sendTo(deviceId, LinkClipboard.createConnectPacket(
                    clipboardWatcher.currentContent(), clipboardWatcher.currentTimestamp()));
        }
        if (batteryWatcher != null && batteryWatcher.lastKnownIsCharging() != null) {
            deviceManager.sendTo(deviceId, LinkBattery.createPacket(
                    batteryWatcher.lastKnownIsCharging(), batteryWatcher.lastKnownCharge(), 0));
        }
        // Ask for the peer's run-command list; Android has no command executor of its own.
        deviceManager.sendTo(deviceId, LinkRunCommand.createRequestListPacket());
        if (LinkDevicePermissions.check(getContext(), deviceId, "systemvolume")) {
            android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
            deviceManager.sendTo(deviceId, LinkSystemVolume.createLocalSinksPacket(audio));
        }
        if (LinkDevicePermissions.check(getContext(), deviceId, "flashlight")) {
            deviceManager.sendTo(deviceId, LinkFlashlight.createStatusPacket(LinkFlashlight.isTorchOn()));
        }
        // DND state is sent even without the OS grant, which only matters for changing it.
        if (LinkDevicePermissions.check(getContext(), deviceId, "dnd")) {
            deviceManager.sendTo(deviceId, LinkDND.createStatusPacket(getContext()));
        }
        deviceManager.sendTo(deviceId, LinkLock.createLockPacket(getContext(), null));
    }

    @Override
    public void onDestroy(AppCompatActivity destroyedActivity) {
        // Discovery and the network watcher keep running: LinkForegroundService keeps the process
        // alive after the activity goes, and they redial dropped connections. A reattach in the
        // same process (see load()) replaces them.
        super.onDestroy(destroyedActivity);
    }

    /**
     * Builds the persistent "Link is active" notification. LinkForegroundService posts it with
     * the same NOTIFICATION_ID via startForeground(), so both are one notification.
     */
    static android.app.Notification buildActiveNotification(android.content.Context context) {
        android.app.NotificationManager notificationManager = (android.app.NotificationManager) context.getSystemService(android.content.Context.NOTIFICATION_SERVICE);

        android.app.NotificationChannel channel = new android.app.NotificationChannel(
            CHANNEL_ID,
            "Link Active Status",
            android.app.NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shows persistent status for Link connectivity");
        notificationManager.createNotificationChannel(channel);

        // Launches the invisible LinkSendClipboard activity instead of a broadcast: Android 10+
        // denies clipboard reads to apps without focus, and a broadcast receiver never has it.
        // A no-UI activity briefly gains focus, which allows the read.
        android.content.Intent sendIntent = new android.content.Intent(context, LinkSendClipboard.class);
        sendIntent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK | android.content.Intent.FLAG_ACTIVITY_NO_ANIMATION);
        android.app.PendingIntent sendPendingIntent = android.app.PendingIntent.getActivity(
            context,
            0,
            sendIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
        );

        android.content.Intent deleteIntent = new android.content.Intent(ACTION_NOTIFICATION_DISMISSED);
        deleteIntent.setPackage(context.getPackageName());
        android.app.PendingIntent deletePendingIntent = android.app.PendingIntent.getBroadcast(
            context,
            0,
            deleteIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
        );

        android.app.Notification.Builder builder = new android.app.Notification.Builder(context, CHANNEL_ID);

        builder.setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Link is active")
            .setContentText("Tap Send Clipboard to copy to connected devices")
            .setOngoing(true)
            .setDeleteIntent(deletePendingIntent);

        android.app.Notification.Action action = new android.app.Notification.Action.Builder(
            android.graphics.drawable.Icon.createWithResource(context, android.R.drawable.ic_menu_send),
            "Send Clipboard",
            sendPendingIntent
        ).build();
        builder.addAction(action);

        return builder.build();
    }

    private void showActiveNotification() {
        android.content.Context context = getContext();
        android.app.NotificationManager notificationManager = (android.app.NotificationManager) context.getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        notificationManager.notify(NOTIFICATION_ID, buildActiveNotification(context));
    }

}
