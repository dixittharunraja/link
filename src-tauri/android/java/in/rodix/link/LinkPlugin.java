package in.rodix.link;

// Tauri mobile plugin bridge — exposes the native LinkDeviceManager to the WebView. Mirrors
// desktop's IPC bridge (preload.ts <-> main.ts) in spirit: the WebView never touches sockets
// directly, it only calls plugin methods and listens for events.

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
        // Audio Relay Android-as-host: AudioPlaybackCaptureConfiguration + AudioRecord require
        // this in addition to the separate MediaProjection consent dialog (see startAudioSink()).
        @Permission(
            alias = "microphone",
            strings = { Manifest.permission.RECORD_AUDIO }
        ),
        @Permission(
            alias = "camera",
            strings = { Manifest.permission.CAMERA }
        )
    }
)
public class LinkPlugin extends Plugin {
    private static final String TAG = "LinkPlugin";
    // Key under which the Rust-side `link_call` command nests the renderer's own arguments, next
    // to the "method" name — see call() below.
    static final String ARGS_KEY = "args";

    private final Activity activity;
    private final java.util.Map<String, java.lang.reflect.Method> methods = new java.util.HashMap<>();
    // Serial, like the former plugin HandlerThread was: handlers are written against one-at-a-time
    // execution, and blocking ones (requestPairing's connect wait) must stay off Tauri's IPC thread.
    private final java.util.concurrent.ExecutorService callExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();

    public LinkPlugin(Activity activity) {
        super(activity);
        this.activity = activity;
        for (java.lang.reflect.Method method : LinkPlugin.class.getDeclaredMethods()) {
            if (method.isAnnotationPresent(LinkMethod.class)) {
                method.setAccessible(true);
                methods.put(method.getName(), method);
            }
        }
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

    @Command
    public void call(Invoke invoke) {
        String name = invoke.getArgs().getString("method", null);
        java.lang.reflect.Method method = name != null ? methods.get(name) : null;
        if (method == null) {
            invoke.reject("Unknown Link method: " + name);
            return;
        }
        callExecutor.execute(() -> {
            try {
                method.invoke(this, new LinkCall(invoke));
            } catch (java.lang.reflect.InvocationTargetException e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                android.util.Log.e(TAG, name + " failed", cause);
                invoke.reject(String.valueOf(cause.getMessage()));
            } catch (ReflectiveOperationException e) {
                invoke.reject("Cannot dispatch " + name + ": " + e);
            }
        });
    }

    // CAPABILITIES is now imported from LinkCapabilitiesSchema.java — see that file for the
    // authoritative list. Joystick has no TLS packet type (see desktop's joystick.ts header
    // comment); it rides the raw UDP:1717 line channel, IP-identified only, like Audio Sink guests.

    // Mirrors desktop main.ts's ENABLED_PLUGINS kill-switch for the systematic re-verification
    // pass: everything in test.txt starts disabled so core connection (discovery/pairing/trust/
    // TLS) can be solidified in isolation first, then plugins re-enabled one at a time. Only gates
    // wiring in this file — no plugin's own logic (Link*.java) is touched. Speed Test, System
    // Volume, and MPRIS have graduated out of this — confirmed working, so their gates were
    // removed entirely rather than left toggled on here.
    private static final java.util.Set<String> ENABLED_PLUGINS = new java.util.HashSet<>(java.util.Arrays.asList(
        "Clipboard", "Battery", "Flashlight", "DND", "Connectivity", "Lock", "Notification", "RunCommand",
        "Presenter", "Digitizer", "Touchpad", "Telephony", "MPRIS", "Joystick", "RemoteControl"
    ));
    // Package-private (not private) so LinkSendClipboard, in the same package, can reuse it.
    static boolean isEnabled(String name) {
        return ENABLED_PLUGINS.contains(name);
    }

    // Shared by every plugin that broadcasts state updates to all connected peers, gated on each
    // peer's own permission for that key — previously this exact loop (trustedConnectedDeviceIds
    // + per-peer LinkDevicePermissions.check + sendTo) was copy-pasted at 10+ call sites (MPRIS,
    // Notification, Telephony, System Volume, Flashlight, DND). Mirrors desktop's
    // broadcastToPermittedPeers() in main.ts.
    private void broadcastToPermittedPeers(String permKey, LinkPacket packet) {
        for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
            if (!LinkDevicePermissions.check(getContext(), peerId, permKey)) continue;
            deviceManager.sendTo(peerId, packet);
        }
    }

    // Broadcast to ALL pool members, but check notification permission for each
    private void broadcastNotificationsToPool(LinkPacket packet) {
        for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
            // Check if this device has permission to send notifications to peer
            if (LinkDevicePermissions.check(getContext(), peerId, "notificationMirroring")) {
                deviceManager.sendTo(peerId, packet);
            }
        }
    }

    // Broadcast to ALL pool members without permission gates (for other mesh-wide sync)
    private void broadcastToAllPeers(LinkPacket packet) {
        for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, packet);
        }
    }

    private LinkIdentity.Identity myIdentity;
    private LinkDeviceManager deviceManager;
    // Last effective-capabilities list each connected peer pushed us — cached so a WebView reload
    // can re-hydrate gated-plugin visibility via getConnectedDevices without waiting for the peer
    // to re-push (mirrors desktop main.ts's peerCapabilities; fixes the "reload ping-pong").
    private final java.util.Map<String, org.json.JSONArray> peerCapabilities = new java.util.concurrent.ConcurrentHashMap<>();
    public static LinkDeviceManager sDeviceManager;
    // Static so a second LinkPlugin.load() in the same still-alive process (see shutdown note on
    // LinkDeviceManager.shutdown()) can find and stop the previous instance's FS server too.
    private static LinkFsServer sFsServer;
    // Static for the same reason as sDeviceManager/sFsServer above: a second LinkPlugin.load() in
    // the same still-alive process (app reload without a real process restart) must stop the
    // PREVIOUS instance's discovery watcher too. Without this, the old instance's UDP rx/tx
    // threads kept running forever, orphaned — still discovering peers and independently dialing
    // out through their own stale `deviceManager` reference, creating rogue duplicate connections
    // that got closed by the tie-break almost immediately. That was the actual cause of the
    // infinite "Discovered peer ... Connecting..." loop every ~3s after a reload.
    private static LinkDiscovery.Watcher sDiscoveryWatcher;
    private static final java.util.Map<String, JSObject> sDiscoveredPeers = new java.util.concurrent.ConcurrentHashMap<>();
    // Lets requestPairing() (below) block until a specific deviceId's identity handshake actually
    // completes, after triggering a connect for a purely-discovered-but-never-auto-connected
    // peer — see requestPairing()'s comment for why this is needed (mirrors desktop's
    // 'deviceConnected' event-based wait in main.ts's 'request-pairing' handler).
    private static final java.util.Map<String, java.util.concurrent.CountDownLatch> sPendingConnectWaits = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.Map<String, PendingIpWait> sPendingIpConnectWaits = new java.util.concurrent.ConcurrentHashMap<>();
    private static class PendingIpWait {
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        String resolvedDeviceId;
    }
    private LinkSettings settings;
    private LinkClipboard.Watcher clipboardWatcher;
    private volatile long lastKnownClipboardTimestamp = 0;
    private LinkBattery.Watcher batteryWatcher;
    private LinkConnectivity.Watcher connectivityWatcher;
    private LinkDiscovery.Watcher discoveryWatcher;
    private LinkFsServer fsServer;
    // Audio Relay — listener-only on Android in v1 (no capture/host role yet, tracked in
    // docs/backlog.txt). Deliberately independent of deviceManager/LinkTrustStore.
    // Static for the same reason as sDeviceManager/sFsServer/sDiscoveryWatcher above: a second
    // LinkPlugin.load() in the same still-alive process (app reload without a real process
    // restart — e.g. the WebView's renderer process getting killed/reclaimed by the OS mid-
    // session) must be able to find and disconnect the PREVIOUS instance's connection too. This
    // was a real, confirmed bug (not just a theoretical risk like the others' comments describe):
    // without this, the old instance's live WebSocket connection became completely unreachable —
    // no reference to it survives losing the old LinkPlugin instance — so it just sat on the
    // host's relay server forever, never disconnected, while the reloaded UI opened a SECOND
    // connection for the same device. Host-side "Listeners" list showed the same paired device
    // twice as a direct result.
    private static LinkAudioSinkClient sAudioSinkClient;
    private static String sAudioSinkHostLabel = "";
    // Android-as-host counterpart to sAudioSinkClient above — same static-field reattach reason.
    // No non-static instance field is needed alongside it (nothing else in this class needs a
    // non-static handle), mirroring how sAudioSinkClient also has none.
    private static LinkAudioSinkServer sAudioSinkServer;
    private static LinkRemoteMicServer sRemoteMicServer;
    private static LinkFileTransferServer sPortalTransferServer;
    private static LinkFileTransferClient sPortalTransferClient;
    // Walkie Talkie's guest-facing signaling — see LinkWalkieTalkieServer.java's header
    // comment. Only relevant for an unpaired participant (manual IP + PIN); already-paired members
    // use the existing trusted connection instead (handleWalkieTalkieSignalPacket above).
    private static LinkWalkieTalkieServer sWalkieTalkieGuestServer;
    private static LinkWalkieTalkieClient sWalkieTalkieGuestClient;
    private static LinkJoystickServer sJoystickServer;
    private static LinkJoystickClient sJoystickClient;
    private static LinkInputGuestServer sInputGuestServer;
    private static LinkInputGuestClient sInputGuestClient;
    private static LinkRemoteControlServer sRemoteControlServer;
    private LinkPacket lastTelephonyPacket = null;
    private String lastCallState = "";
    private String lastIncomingNumber = null;
    private final android.os.Handler trustedReconnectHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable trustedReconnectRunnable;
    private java.util.List<String> lastLocalIps = new java.util.ArrayList<>();
    // See telephonyReceiver's RINGING branch: some carriers/devices fire the very first RINGING
    // broadcast with EXTRA_INCOMING_NUMBER still null, followed almost immediately by a second one
    // with the real number. Broadcasting immediately on the first caused every call to visibly
    // flash "Unknown Caller" + a generic icon before being overwritten a moment later.
    private final android.os.Handler telephonyHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable pendingRingingBroadcast = null;
    private String activeRingerDeviceId = null;
    // Guards against firing overlapping connectTo() attempts at the same peer while a previous
    // one from an earlier discovery broadcast is still in flight — see discoveryWatcher below.
    private final java.util.Set<String> connectingDeviceIds = java.util.concurrent.ConcurrentHashMap.newKeySet();
    // Backoff for reconnect attempts that can't even establish a connection (e.g. a stale
    // discovery entry for a peer that's genuinely offline) — mirrors desktop's main.ts
    // reconnectBackoff. Without this, such a peer got retried on every single discovery broadcast
    // (~every 5s) with zero cooldown. Deliberately does NOT apply to a peer that connects and
    // later disconnects (app restart, brief Wi-Fi drop, etc.) — that case should always reconnect
    // immediately on the next broadcast, no penalty, for reconnection to feel seamless.
    private static class Backoff { long nextAttemptAt; int failCount; }
    private final java.util.Map<String, Backoff> reconnectBackoff = new java.util.concurrent.ConcurrentHashMap<>();
    private static final long MIN_BACKOFF_MS = 1000;
    private static final long MAX_BACKOFF_MS = 15000;

    private void recordConnectFailure(String deviceId) {
        Backoff b = reconnectBackoff.computeIfAbsent(deviceId, k -> new Backoff());
        b.failCount++;
        long delayMs = Math.min((long) (MIN_BACKOFF_MS * Math.pow(2, b.failCount - 1)), MAX_BACKOFF_MS);
        b.nextAttemptAt = System.currentTimeMillis() + delayMs;
    }

    private void clearConnectBackoff(String deviceId) {
        reconnectBackoff.remove(deviceId);
    }

    private boolean canAttemptConnect(String deviceId) {
        Backoff b = reconnectBackoff.get(deviceId);
        return b == null || System.currentTimeMillis() >= b.nextAttemptAt;
    }
    public static final String ACTION_NOTIFICATION_DISMISSED = "in.rodix.link.ACTION_NOTIFICATION_DISMISSED";
    public static final String ACTION_MUTE_REMOTE_RINGER = "in.rodix.link.ACTION_MUTE_REMOTE_RINGER";
    public static final String EXTRA_MUTE_DEVICE_ID = "deviceId";
    static final int NOTIFICATION_ID = 9991; // package-visible: shared with LinkForegroundService
    private static final String CHANNEL_ID = "link_foreground_channel";

    // Active Audio Relay / Remote Mic session notification — separate from NOTIFICATION_ID above
    // (which is the generic always-on "Link is active" connectivity notification and never goes
    // away). This one only exists while a session is actually running, on its own channel/id, so
    // it can be posted/updated/cancelled independently without disturbing the connectivity one.
    private static final int SESSION_NOTIFICATION_ID = 9992;
    private static final String SESSION_CHANNEL_ID = "link_session_channel";
    public static final String ACTION_SESSION_MUTE_TOGGLE = "in.rodix.link.ACTION_SESSION_MUTE_TOGGLE";
    public static final String ACTION_SESSION_END = "in.rodix.link.ACTION_SESSION_END";
    public static final String EXTRA_SESSION_KIND = "sessionKind";
    // The three sessions this notification can represent — checked in this priority order if more
    // than one happens to be active at once (a real but rare edge case: e.g. hosting Audio Relay
    // while also hosting Remote Mic). Only one is ever shown at a time to keep the notification
    // simple; this is a documented simplification, not a correctness bug.
    private static final String SESSION_KIND_AUDIOSINK_HOST = "audiosink_host";
    private static final String SESSION_KIND_AUDIOSINK_LISTEN = "audiosink_listen";
    private static final String SESSION_KIND_REMOTEMIC_HOST = "remotemic_host";
    private final java.util.Map<String, LinkRepliableNotification> pendingReplies = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.concurrent.ExecutorService udpSendExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
    private java.net.DatagramSocket outboundUdpSocket = null;

    private LinkSpeedTest speedTest;
    private String lastMprisState = null; // Cache to avoid broadcasting unchanged state
    private final android.os.Handler mprisPollHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable mprisPollRunnable = new Runnable() {
        @Override
        public void run() {
            if (deviceManager != null && !deviceManager.trustedConnectedDeviceIds().isEmpty()) {
                broadcastMprisState();
            }
            mprisPollHandler.postDelayed(this, 3000);
        }
    };

    // App-level heartbeat/liveness cycle — 5s idle interval with 15s timeout for mobile battery efficiency.
    private static final long HEARTBEAT_INTERVAL_MS = 5000;
    private static final long HEARTBEAT_TIMEOUT_MS = 15000;
    private final android.os.Handler heartbeatHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable heartbeatRunnable = new Runnable() {
        @Override
        public void run() {
            if (deviceManager != null) {
                deviceManager.runHeartbeatCycle(HEARTBEAT_TIMEOUT_MS);
            }
            heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
        }
    };

    private void broadcastMprisState() {
        if (deviceManager == null) return;
        LinkPacket packet = LinkMpris.createLocalStatePacket(getContext());
        String currentState = packet.body.toString(); // Serialize to JSON string for comparison
        // Only broadcast if state actually changed — prevents UI flicker from polling same state every 3s
        if (currentState.equals(lastMprisState)) return;
        lastMprisState = currentState;
        // Outbound gate — a peer denied 'mpris' shouldn't passively learn what's currently
        // playing just because someone else (permitted) triggered this broadcast.
        broadcastToPermittedPeers("mpris", packet);
    }

    @Override
    public void load(WebView webView) {
        android.util.Log.i(TAG, "load() starting");
        try {
            // Start the keep-alive foreground service immediately so Android doesn't kill this
            // process (and every socket LinkDeviceManager below holds) when the app is swiped
            // away from Recents. See LinkForegroundService for why this is necessary. Caught on
            // its own so a failure here (background-start restrictions, OS quirks) degrades to
            // "no background persistence" instead of aborting the rest of load() — the sockets
            // and trust store below are the critical part that must still come up.
            try {
                androidx.core.content.ContextCompat.startForegroundService(
                    getContext(), new android.content.Intent(getContext(), LinkForegroundService.class));
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to start LinkForegroundService", e);
            }

            // The app process can outlive an individual Activity/Plugin instance (that's the
            // whole point of LinkForegroundService — surviving the task being cleared from
            // Recents). If the user reopens the app while the process is still alive, Tauri
            // creates a NEW LinkPlugin and calls load() again in the SAME process. Without this
            // guard, the previous (orphaned but still-running) DeviceManager/FsServer would still
            // be holding the TCP ports, and starting new ones would throw BindException —
            // uncaught, that left the plugin bridge stuck mid-init, which is what caused the
            // "reopen after clearing from Recents hangs on a white screen" bug.
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
            if (sDiscoveryWatcher != null) {
                try {
                    sDiscoveryWatcher.stop();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error stopping previous DiscoveryWatcher", e);
                }
                sDiscoveryWatcher = null;
            }
            if (sAudioSinkClient != null) {
                try {
                    sAudioSinkClient.disconnect();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error disconnecting previous AudioSinkClient", e);
                }
                sAudioSinkClient = null;
            }
            if (sAudioSinkServer != null) {
                try {
                    sAudioSinkServer.stop();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error stopping previous AudioSinkServer", e);
                }
                sAudioSinkServer = null;
            }
            if (sPortalTransferClient != null) {
                sPortalTransferClient.disconnect();
                sPortalTransferClient = null;
            }
            if (sPortalTransferServer != null) {
                try {
                    sPortalTransferServer.stop();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error stopping previous PortalTransferServer", e);
                }
                sPortalTransferServer = null;
            }
            if (sWalkieTalkieGuestClient != null) {
                sWalkieTalkieGuestClient.disconnect();
                sWalkieTalkieGuestClient = null;
            }
            if (sWalkieTalkieGuestServer != null) {
                try {
                    sWalkieTalkieGuestServer.stop();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error stopping previous WalkieTalkieServer", e);
                }
                sWalkieTalkieGuestServer = null;
            }
            if (sInputUdpSocket != null) {
                try {
                    sInputUdpSocket.close();
                } catch (Exception ignored) {}
                sInputUdpSocket = null;
            }


            myIdentity = LinkIdentity.loadOrCreate(getContext(), LinkCapabilitiesSchema.CAPABILITIES, LinkCapabilitiesSchema.CAPABILITIES);
            android.util.Log.i(TAG, "identity loaded: " + myIdentity.deviceId + " / " + myIdentity.deviceName);
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), myIdentity.deviceId);
            android.util.Log.i(TAG, "tls identity loaded");
            LinkTrustStore trustStore = new LinkTrustStore(getContext());

            try {
                fsServer = new LinkFsServer(getContext(), tls.certificate, tls.privateKey, LinkTransport.LINK_PORT + 2);
                fsServer.start();
                sFsServer = fsServer;
                android.util.Log.i(TAG, "FS Server started on port " + (LinkTransport.LINK_PORT + 2));
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to start FS Server", e);
            }


            deviceManager = new LinkDeviceManager(getContext(), myIdentity, tls.certificate, tls.privateKey,
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
                    java.util.concurrent.CountDownLatch pending = sPendingConnectWaits.remove(identity.deviceId);
                    if (pending != null) pending.countDown();
                    String remoteIpMatch = deviceManager.remoteAddressOf(identity.deviceId);
                    if (remoteIpMatch != null) {
                        PendingIpWait ipWait = sPendingIpConnectWaits.remove(remoteIpMatch);
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
                        if (trusted) {
                            LinkTrustStore trustStore = deviceManager != null ? deviceManager.getTrustStore() : new LinkTrustStore(getContext());
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
                    // Always clear backoff on disconnect — a peer that was actually connected and
                    // then dropped (app restart, brief Wi-Fi blip) should be eligible to reconnect
                    // the instant the next broadcast arrives, not wait out a penalty. Backoff only
                    // ever applies to connect attempts that fail outright (see discoveryWatcher).
                    clearConnectBackoff(deviceId);
                    peerCapabilities.remove(deviceId); // drop cached caps — a fresh connect re-pushes

                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
                    notifyListeners("deviceDisconnected", data);
                }

                @Override
                public void onIncomingPairRequest(String deviceId, String deviceName, String deviceType, String verificationKey) {
                    if (LinkBlocklist.isBlocked(getContext(), deviceId)) {
                        deviceManager.rejectPairing(deviceId);
                        return;
                    }
                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
                    data.put("deviceName", deviceName);
                    data.put("deviceType", deviceType);
                    data.put("verificationKey", verificationKey);
                    notifyListeners("incomingPairRequest", data);
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
                    LinkDevicePermissions.deletePermissionsForDevice(getContext(), deviceId);
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
                            clearConnectBackoff(d.deviceId);
                        }
                    }
                    attemptTrustedReconnects();
                    JSObject data = new JSObject();
                    notifyListeners("trustListUpdated", data);
                }


                @Override
                public void onPacket(String deviceId, LinkPacket packet) {
                    android.util.Log.i(TAG, "onPacket type=" + packet.type + " from " + deviceId);
                    if (packet.type.equals("link.resync.request")) {
                        // Peer's UI (re)loaded and is asking us to re-push our full state now, so its
                        // sections repopulate immediately instead of waiting for our next periodic
                        // broadcast. Reciprocal of resyncDevices — mirrors desktop main.ts.
                        sendInitialSync(deviceId);
                        return;
                    }
                    if (LinkClipboard.isClipboardPacket(packet)) {
                        handleClipboardPacket(deviceId, packet);
                    } else if (LinkBattery.isBatteryPacket(packet)) {
                        handleBatteryPacket(deviceId, packet);
                    } else if (LinkFindMyDevice.isFindMyDevicePacket(packet)) {
                        handleFindMyDevicePacket(deviceId, packet);
                    } else if (LinkRunCommand.isCommandListPacket(packet)) {
                        handleRunCommandListPacket(deviceId, packet);
                    } else if (packet.type.equals(LinkSystemVolume.PACKET_TYPE_SYSTEMVOLUME)) {
                        handleSystemVolumePacket(deviceId, packet);
                    } else if (packet.type.equals(LinkSystemVolume.PACKET_TYPE_SYSTEMVOLUME_REQUEST)) {
                        handleSystemVolumeRequestPacket(deviceId, packet);
                    } else if (LinkCapabilities.isCapabilitiesPacket(packet)) {
                        handleCapabilitiesPacket(deviceId, packet);
                    } else if (LinkTelephony.isTelephonyPacket(packet)) {
                        handleTelephonyPacket(deviceId, packet);
                    } else if (LinkTelephony.isTelephonyRequestPacket(packet)) {
                        handleTelephonyRequestPacket(deviceId, packet);
                    } else if (packet.type.equals(LinkFlashlight.PACKET_TYPE_FLASHLIGHT)) {
                        handleFlashlightPacket(deviceId, packet);
                    } else if (packet.type.equals(LinkDND.PACKET_TYPE_DND)) {
                        handleDndPacket(deviceId, packet);
                    } else if ("link.input.kicked".equals(packet.type)) {
                        // The device we were controlling removed us: the presenter / touchpad screen must close.
                        JSObject kicked = new JSObject();
                        kicked.put("deviceId", deviceId);
                        notifyListeners("inputKicked", kicked);
                    } else if (packet.type.equals(LinkPresenter.PACKET_TYPE_PRESENTER)) {
                        handlePresenterPacket(deviceId, packet);
                    } else if (packet.getType().equals("link.digitizer.session")) {
                        handleDigitizerSessionPacket(deviceId, packet);
                    } else if (packet.getType().equals("link.digitizer")) {
                        handleDigitizerPacket(deviceId, packet);
                    } else if (LinkLock.isLockPacket(packet)) {
                        handleLockPacket(deviceId, packet);
                    } else if (LinkLock.isLockRequestPacket(packet)) {
                        handleLockRequestPacket(deviceId, packet);
                    } else if (packet.type.equals("link.rename.request")) {
                        handleRenameRequestPacket(deviceId, packet);
                    } else if (packet.type.equals("link.rename")) {
                        handleRenamePacket(deviceId, packet);
                    } else if (packet.type.equals(LinkConnectivity.PACKET_TYPE_CONNECTIVITY)) {
                        handleConnectivityPacket(deviceId, packet);
                    } else if (LinkMpris.isMprisPacket(packet)) {
                        handleMprisStatePacket(deviceId, packet);
                    } else if (packet.type.equals(LinkMpris.PACKET_TYPE_MPRIS_REQUEST)) {
                        handleMprisRequestPacket(deviceId, packet);
                    } else if ("link.notification.reply".equals(packet.type)) {
                        handleNotificationReplyPacket(deviceId, packet);
                    } else if ("link.speedtest.request".equals(packet.type)) {
                        handleSpeedTestRequestPacket(deviceId, packet);
                    } else if ("link.speedtest.response".equals(packet.type)) {
                        handleSpeedTestResponsePacket(packet);
                    } else if ("link.audiosink.started".equals(packet.type)) {
                        handleAudioSinkStartedPacket(deviceId, packet);
                    } else if ("link.audiosink.ended".equals(packet.type)) {
                        handleAudioSinkEndedPacket(deviceId);
                    } else if ("link.audiosink.query".equals(packet.type)) {
                        handleAudioSinkQueryPacket(deviceId);
                    } else if ("link.remotemic.query".equals(packet.type)) {
                        handleRemoteMicQueryPacket(deviceId);
                    } else if (LinkRemoteInput.isRemoteInputPacket(packet)) {
                        if (LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
                            LinkRemoteInput.handleRemoteInput(getContext(), packet);
                        } else {
                            android.util.Log.w(TAG, "Blocked remoteinput packet from " + deviceId + " — permission denied");
                        }
                    } else if (packet.type != null && packet.type.startsWith("link.walkietalkie.")) {
                        handleWalkieTalkieSignalPacket(deviceId, packet);
                    } else if ("link.remotecontrol.signal".equals(packet.type)) {
                        handleRemoteControlSignalPacket(deviceId, packet);
                    } else if ("link.remotecontrol.stream".equals(packet.type)) {
                        handleRemoteControlStreamPacket(deviceId, packet);
                    } else if ("link.remotecontrol.input".equals(packet.type)) {
                        handleRemoteControlInputPacket(deviceId, packet);
                    } else if ("link.fs.request".equals(packet.type)) {
                          handleFsRequestPacket(deviceId, packet);
                      } else if ("link.fs.response".equals(packet.type)) {
                        handleFsResponsePacket(packet);
                    }
                }
            });
            speedTest = new LinkSpeedTest(deviceManager);

            batteryWatcher = new LinkBattery.Watcher(getContext(), (isCharging, currentCharge, thresholdEvent) -> {
                for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                    deviceManager.sendTo(peerId, LinkBattery.createPacket(isCharging, currentCharge, thresholdEvent));
                }
            });

            connectivityWatcher = new LinkConnectivity.Watcher(getContext(), (states) -> {
                for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                    deviceManager.sendTo(peerId, LinkConnectivity.createPacket(states));
                }
            });

            clipboardWatcher = new LinkClipboard.Watcher(getContext(), new LinkClipboard.Listener() {
                @Override
                public void onLocalTextChange(String content) {
                    lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
                    if (!isEnabled("Clipboard")) return;
                    broadcastToPermittedPeers("clipboard", LinkClipboard.createClipboardPacket(content));
                }

                @Override
                public void onLocalFileChange(String filename, byte[] data) {
                    // File clipboard sync disabled
                }
            });

            LinkNotificationReceiver.setListener(new LinkNotificationReceiver.Listener() {
                @Override
                public void onNotificationPosted(android.service.notification.StatusBarNotification sbn) {
                    if (LinkNotification.isEligible(sbn, getContext().getPackageName())) {
                        String appName = sbn.getPackageName();
                        try {
                            android.content.pm.PackageManager pm = getContext().getPackageManager();
                            appName = pm.getApplicationLabel(pm.getApplicationInfo(sbn.getPackageName(), 0)).toString();
                        } catch (Exception ignored) {}

                        LinkRepliableNotification rn = LinkNotification.extractRepliable(sbn.getNotification());
                        String replyId = null;
                        if (rn != null) {
                            replyId = rn.id;
                            pendingReplies.put(rn.id, rn);
                        }

                        LinkPacket np = LinkNotification.createPostedPacket(getContext(), sbn, appName, replyId);
                        broadcastToPermittedPeers("notification", np);

                        // Mesh-wide notification sync: broadcast to pool members with notificationMirroring permission
                        String deviceName = myIdentity != null ? myIdentity.deviceName : "Unknown Device";
                        LinkPacket meshNotif = LinkNotificationBroadcast.createNotificationBroadcastPacket(sbn, deviceName);
                        if (meshNotif != null) {
                            broadcastNotificationsToPool(meshNotif);
                        }
                    }
                }

                @Override
                public void onNotificationRemoved(android.service.notification.StatusBarNotification sbn) {
                    if (LinkNotification.isEligible(sbn, getContext().getPackageName())) {
                        LinkPacket np = LinkNotification.createCancelPacket(sbn);
                        broadcastToPermittedPeers("notification", np);
                    }
                }
            });

            // Recover the "enabled but not actually bound" NotificationListenerService state.
            // Android caches the listener binding against a specific APK; after an app UPDATE/
            // reinstall the binding points at the old package and is never re-established, so the
            // service shows as enabled in Settings yet onNotificationPosted never fires — nothing
            // mirrors, with no error anywhere. requestRebind() (API 24+) is the documented remedy:
            // it asks the system to reconnect the listener. Harmless/no-op if already bound, so
            // it's safe to call on every load(); only meaningful when access is actually granted.
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N
                    && LinkNotificationReceiver.isPermissionGranted(getContext())) {
                try {
                    android.service.notification.NotificationListenerService.requestRebind(
                            new android.content.ComponentName(getContext(), LinkNotificationReceiver.class));
                    android.util.Log.i(TAG, "Requested NotificationListenerService rebind");
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Failed to request notification listener rebind", e);
                }
            }

            android.content.BroadcastReceiver telephonyReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, android.content.Intent intent) {
                    if (android.telephony.TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) {
                        String state = intent.getStringExtra(android.telephony.TelephonyManager.EXTRA_STATE);
                        String number = intent.getStringExtra(android.telephony.TelephonyManager.EXTRA_INCOMING_NUMBER);

                        boolean stateChanged = state != null && !state.equals(lastCallState);
                        boolean numberArrived = state != null && state.equals(lastCallState) && number != null && lastIncomingNumber == null;

                        if (stateChanged || numberArrived) {
                            // Capture the number from the PREVIOUS (e.g. ringing) event before
                            // overwriting it below — the IDLE transition's own EXTRA_INCOMING_NUMBER
                            // is essentially always null, and the missed-call fallback further down
                            // needs the ringing number that was stored here on the prior broadcast.
                            String previousIncomingNumber = lastIncomingNumber;
                            lastCallState = state;
                            lastIncomingNumber = number;

                            if (pendingRingingBroadcast != null) {
                                telephonyHandler.removeCallbacks(pendingRingingBroadcast);
                                pendingRingingBroadcast = null;
                            }

                            String contactName = LinkTelephony.lookupContactName(getContext(), number);
                            String contactPhoto = LinkTelephony.lookupContactPhotoBase64(getContext(), number);

                            if (android.telephony.TelephonyManager.EXTRA_STATE_RINGING.equals(state) && number == null) {
                                // Number not in yet — wait briefly for the follow-up broadcast
                                // instead of showing "Unknown Caller" and correcting it a moment
                                // later. If it genuinely never arrives (blocked caller ID, no
                                // READ_CALL_LOG, etc.) this still shows after the short delay.
                                pendingRingingBroadcast = () -> {
                                    if (!android.telephony.TelephonyManager.EXTRA_STATE_RINGING.equals(lastCallState)) return;
                                    String n = lastIncomingNumber;
                                    String cName = LinkTelephony.lookupContactName(getContext(), n);
                                    String cPhoto = LinkTelephony.lookupContactPhotoBase64(getContext(), n);
                                    LinkPacket np2 = LinkTelephony.createCallPacket("ringing", n, cName, cPhoto);
                                    lastTelephonyPacket = np2;
                                    broadcastToPermittedPeers("telephony", np2);
                                };
                                telephonyHandler.postDelayed(pendingRingingBroadcast, 800);
                            } else if (android.telephony.TelephonyManager.EXTRA_STATE_RINGING.equals(state)) {
                                LinkPacket np = LinkTelephony.createCallPacket("ringing", number, contactName, contactPhoto);
                                lastTelephonyPacket = np;
                                broadcastToPermittedPeers("telephony", np);
                            } else if (android.telephony.TelephonyManager.EXTRA_STATE_OFFHOOK.equals(state)) {
                                String talkingNumber = number != null ? number : (previousIncomingNumber != null ? previousIncomingNumber : lastIncomingNumber);
                                String talkingContact = LinkTelephony.lookupContactName(getContext(), talkingNumber);
                                String talkingPhoto = LinkTelephony.lookupContactPhotoBase64(getContext(), talkingNumber);
                                LinkPacket np = LinkTelephony.createCallPacket("talking", talkingNumber, talkingContact, talkingPhoto);
                                lastTelephonyPacket = np;
                                broadcastToPermittedPeers("telephony", np);
                            } else if (android.telephony.TelephonyManager.EXTRA_STATE_IDLE.equals(state)) {
                                if (lastTelephonyPacket != null) {
                                    LinkPacket cancelNp = LinkTelephony.createCancelPacket(lastTelephonyPacket);
                                    broadcastToPermittedPeers("telephony", cancelNp);

                                    if ("ringing".equals(lastTelephonyPacket.body.optString("event"))) {
                                        String missedNumber = number != null ? number : previousIncomingNumber;
                                        String missedContact = LinkTelephony.lookupContactName(getContext(), missedNumber);
                                        String missedContactPhoto = LinkTelephony.lookupContactPhotoBase64(getContext(), missedNumber);
                                        LinkPacket missedNp = LinkTelephony.createCallPacket("missedCall", missedNumber, missedContact, missedContactPhoto);
                                        broadcastToPermittedPeers("telephony", missedNp);
                                    }
                                    lastTelephonyPacket = null;
                                }
                                lastIncomingNumber = null; // Clear incoming number tracker when idle
                            }
                        }
                    }
                }
            };
            android.content.IntentFilter filter = new android.content.IntentFilter(android.telephony.TelephonyManager.ACTION_PHONE_STATE_CHANGED);
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                getContext().registerReceiver(telephonyReceiver, filter, android.content.Context.RECEIVER_EXPORTED);
            } else {
                getContext().registerReceiver(telephonyReceiver, filter);
            }

            // Tapped from the "Mute" action on a peer's incoming-call notification (see
            // LinkTelephony.showRemoteCallNotification) — this device isn't the one ringing, so
            // "mute" means relaying a request back to the peer to silence ITS ringer, reusing the
            // existing systemvolume "ring" stream mute path (LinkSystemVolume.handleLocalVolumeRequest).
            // Never sent by another app — NOT_EXPORTED, only this app's own PendingIntents fire it.
            android.content.BroadcastReceiver muteRemoteRingerReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, android.content.Intent intent) {
                    String targetDeviceId = intent.getStringExtra(EXTRA_MUTE_DEVICE_ID);
                    if (targetDeviceId == null || deviceManager == null) return;
                    deviceManager.sendTo(targetDeviceId, LinkSystemVolume.createSetMutePacket("ring", true));
                }
            };
            android.content.IntentFilter muteFilter = new android.content.IntentFilter(ACTION_MUTE_REMOTE_RINGER);
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                getContext().registerReceiver(muteRemoteRingerReceiver, muteFilter, android.content.Context.RECEIVER_NOT_EXPORTED);
            } else {
                getContext().registerReceiver(muteRemoteRingerReceiver, muteFilter);
            }

            // Mute/Unmute + End Session/Disconnect buttons on the active Audio Relay/Remote Mic
            // session notification (see updateSessionNotification()). Never sent by another app —
            // NOT_EXPORTED, only this app's own PendingIntents fire it.
            android.content.BroadcastReceiver sessionActionReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, android.content.Intent intent) {
                    String kind = intent.getStringExtra(EXTRA_SESSION_KIND);
                    boolean isEnd = ACTION_SESSION_END.equals(intent.getAction());
                    if (SESSION_KIND_AUDIOSINK_HOST.equals(kind)) {
                        if (isEnd) {
                            stopAudioSinkHosting();
                        } else if (sAudioSinkServer != null) {
                            sAudioSinkServer.setMuted(!sAudioSinkServer.isMuted());
                        }
                    } else if (SESSION_KIND_AUDIOSINK_LISTEN.equals(kind)) {
                        if (isEnd) {
                            if (sAudioSinkClient != null) sAudioSinkClient.disconnect();
                            sAudioSinkClient = null;
                        } else if (sAudioSinkClient != null) {
                            sAudioSinkClient.toggleLocalMute();
                        }
                    } else if (SESSION_KIND_REMOTEMIC_HOST.equals(kind)) {
                        if (isEnd) {
                            stopRemoteMicHosting();
                        } else if (sRemoteMicServer != null) {
                            sRemoteMicServer.setMuted(!sRemoteMicServer.isMuted());
                        }
                    }
                    updateSessionNotification();
                }
            };
            android.content.IntentFilter sessionFilter = new android.content.IntentFilter();
            sessionFilter.addAction(ACTION_SESSION_MUTE_TOGGLE);
            sessionFilter.addAction(ACTION_SESSION_END);
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                getContext().registerReceiver(sessionActionReceiver, sessionFilter, android.content.Context.RECEIVER_NOT_EXPORTED);
            } else {
                getContext().registerReceiver(sessionActionReceiver, sessionFilter);
            }

            try {
                deviceManager.startServer(LinkTransport.LINK_PORT);
                android.util.Log.i(TAG, "server started on port " + LinkTransport.LINK_PORT);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to start server on port " + LinkTransport.LINK_PORT, e);
            }

            startInputUdpServer();

            String myFingerprint = "";
            try {
                myFingerprint = LinkTls.fingerprint(tls.certificate);
            } catch (Exception ignored) {}
            discoveryWatcher = new LinkDiscovery.Watcher(getContext(), myIdentity, myFingerprint, (ip, peer) -> {
                if (LinkBlocklist.isBlocked(getContext(), peer.deviceId) || LinkBlocklist.isBlocked(getContext(), ip)) {
                    return;
                }

                LinkTrustStore discoveryStore = new LinkTrustStore(getContext());
                boolean isPaired = discoveryStore.isPaired(peer.deviceId);

                // Invisible to strangers: if an unpaired device has visibility OFF, hide it completely.
                if (!isPaired && !peer.visibility) {
                    return;
                }

                String displayName = peer.deviceName != null ? peer.deviceName : peer.deviceId.substring(0, Math.min(8, peer.deviceId.length()));
                if (isPaired) {
                    LinkTrustStore.TrustedDevice dev = discoveryStore.get(peer.deviceId);
                    if (dev != null && dev.deviceName != null) {
                        displayName = dev.deviceName;
                    }
                }

                JSObject info = new JSObject();
                info.put("deviceId", peer.deviceId);
                info.put("deviceName", displayName);
                info.put("deviceType", peer.deviceType != null ? peer.deviceType : "desktop");
                info.put("ipAddress", ip);
                info.put("trusted", isPaired);
                info.put("connected", deviceManager.hasPeer(peer.deviceId));
                sDiscoveredPeers.put(peer.deviceId, info);
                notifyListeners("deviceDiscovered", info);

                if (!isPaired) {
                    return; // Do NOT auto-connect untrusted devices over TCP!
                }

                String currentIp = deviceManager != null ? deviceManager.remoteAddressOf(peer.deviceId) : null;
                // A multi-homed PC broadcasts from whichever adapter it likes, so a different source
                // address alone is no sign the connection is stale; closing a live one here made
                // it drop and redial on every broadcast. Only a connection gone quiet is replaced.
                if (currentIp != null && !currentIp.equals(ip) && deviceManager.isPeerStale(peer.deviceId, 9000)) {
                    android.util.Log.i(TAG, "[Link] Closing stale connection to peer " + peer.deviceId.substring(0, Math.min(8, peer.deviceId.length())) + " at old IP " + currentIp);
                    if (deviceManager != null) {
                        deviceManager.closeConnection(peer.deviceId);
                    }
                }
                discoveryStore.updateLastKnownIp(peer.deviceId, ip);

                // Auto-connect to trusted peers whenever we hear them
                if (deviceManager != null && isPaired) {
                    if (deviceManager.upgradePeerIfTrusted(peer.deviceId)) {
                        return;
                    }
                    if (!deviceManager.hasTrustedPeer(peer.deviceId) && canAttemptConnect(peer.deviceId)
                            && connectingDeviceIds.add(peer.deviceId)) {
                        if (deviceManager.hasPeer(peer.deviceId)) {
                            deviceManager.closeConnection(peer.deviceId);
                        }
                        android.util.Log.i(TAG, "Discovered trusted peer " + peer.deviceName + " at " + ip + ". Connecting...");
                        new Thread(() -> {
                            try {
                                deviceManager.connectTo(ip, LinkTransport.LINK_PORT);
                                clearConnectBackoff(peer.deviceId);
                            } catch (Exception e) {
                                android.util.Log.e(TAG, "Failed connecting to discovered peer " + ip, e);
                                recordConnectFailure(peer.deviceId);
                            } finally {
                                connectingDeviceIds.remove(peer.deviceId);
                            }
                        }, "link-connect-discovered").start();
                    }
                }
            }, expiredDeviceId -> {
                sDiscoveredPeers.remove(expiredDeviceId);
                JSObject data = new JSObject();
                data.put("deviceId", expiredDeviceId);
                notifyListeners("deviceExpired", data);

                if (deviceManager != null) {
                    for (LinkDeviceManager.ConnectedPeerInfo info : deviceManager.connectedPeers()) {
                        if (info.identity.deviceId.equals(expiredDeviceId) && !info.trusted) {
                            android.util.Log.i(TAG, "Closing stale connection to undiscoverable peer " + expiredDeviceId.substring(0, Math.min(8, expiredDeviceId.length())));
                            deviceManager.closeConnection(expiredDeviceId);
                            break;
                        }
                    }
                }
            });
            this.settings = new LinkSettings(getContext());
            this.settings.load();
            discoveryWatcher.start(this.settings.discoveryVisibility);
            sDiscoveryWatcher = discoveryWatcher;



            // On-demand trusted reconnect: attempt to connect to all trusted devices at startup / on demand.
            this.trustedReconnectRunnable = new Runnable() {
                @Override
                public void run() {
                    attemptTrustedReconnects();
                }
            };
            trustedReconnectHandler.removeCallbacksAndMessages(null);
            trustedReconnectHandler.post(this.trustedReconnectRunnable);
            watchNetwork();


            // Volume broadcast receiver to sync local volume changes to peers
            android.content.BroadcastReceiver volumeReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, android.content.Intent intent) {
                    if ("android.media.VOLUME_CHANGED_ACTION".equals(intent.getAction())) {
                        android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
                        LinkPacket np = LinkSystemVolume.createLocalSinksPacket(audio);
                        broadcastToPermittedPeers("systemvolume", np);
                    }
                }
            };
            android.content.IntentFilter volumeFilter = new android.content.IntentFilter("android.media.VOLUME_CHANGED_ACTION");
            getContext().registerReceiver(volumeReceiver, volumeFilter);

            // Flashlight torch callback — detects real torch state changes made outside the app
            // (Quick Settings tile, another app) and pushes them to peers in real time.
            // registerTorchCallback() itself (not just callback dispatch) synchronously
            // enumerates/queries camera hardware and was observed blocking the calling thread
            // for 1-1.3s on this device (MIUI) — logcat showed "Long monitor contention with
            // owner main ... at CameraManager$CameraManagerGlobal.registerTorchCallback" during
            // every app launch, directly causing the black-screen-on-open symptom since load()
            // runs synchronously inside MainActivity.onCreate(). Moved to a background thread so
            // it can take however long it wants without blocking activity startup/rendering.
            // Passing null as the Handler means "deliver callbacks on the calling thread's
            // Looper" — a plain background Thread has no Looper, so this needs a real
            // HandlerThread (started, kept alive for the app's lifetime to keep receiving
            // callbacks) rather than a one-shot Thread.
            android.os.HandlerThread torchCallbackThread = new android.os.HandlerThread("link-torch-callback");
            torchCallbackThread.start();
            new android.os.Handler(torchCallbackThread.getLooper()).post(() -> {
                android.hardware.camera2.CameraManager cameraManager =
                    (android.hardware.camera2.CameraManager) getContext().getSystemService(android.content.Context.CAMERA_SERVICE);
                if (cameraManager == null) return;
                try {
                    cameraManager.registerTorchCallback(new android.hardware.camera2.CameraManager.TorchCallback() {
                        @Override
                        public void onTorchModeChanged(String cameraId, boolean enabled) {
                            LinkFlashlight.setTorchState(enabled);
                            LinkPacket np = LinkFlashlight.createStatusPacket(enabled);
                            broadcastToPermittedPeers("flashlight", np);
                        }
                    }, new android.os.Handler(torchCallbackThread.getLooper()));
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Failed to register torch callback", e);
                }
            });

            // DND broadcast receiver — detects real interruption-filter changes made outside the
            // app (Quick Settings, system UI) and pushes them to peers in real time.
            android.content.BroadcastReceiver dndReceiver = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, android.content.Intent intent) {
                    // This system broadcast fires for ANY app's interruption-filter changes, not
                    // just ours — it can fire even if we were never granted DND access ourselves.
                    if (!LinkDND.isDndGranted(getContext())) return;
                    LinkPacket np = LinkDND.createStatusPacket(getContext());
                    broadcastToPermittedPeers("dnd", np);
                }
            };
            getContext().registerReceiver(dndReceiver,
                new android.content.IntentFilter(android.app.NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED));

            // Lock/keyguard receiver — detects real screen lock/unlock (including OS-driven
            // timeouts, not just Link-triggered locks) and pushes state to peers in real time.
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
            getContext().registerReceiver(lockReceiver, lockFilter);

            // Start MPRIS local status polling loop
            mprisPollHandler.post(mprisPollRunnable);
            // Start heartbeat/liveness cycle
            heartbeatHandler.post(heartbeatRunnable);

            // Note: "Send Clipboard" no longer goes through a broadcast receiver here — it's
            // handled by LinkSendClipboard (an invisible trampoline launched directly from the
            // notification's PendingIntent), since Android 10+ denies clipboard reads to apps not
            // currently in focus and a background broadcast receiver never counts as in focus.
            // ACTION_NOTIFICATION_DISMISSED is handled by LinkForegroundService.

            // Display the status notification
            showActiveNotification();

            sDeviceManager = deviceManager;
        } catch (Exception e) {
            android.util.Log.e(TAG, "load() failed gracefully", e);
        }
    }

    @Override
    public void onResume(AppCompatActivity resumedActivity) {
        super.onResume(resumedActivity);
        notifyListeners("appResumed", new JSObject());
        if (discoveryWatcher != null) {
            discoveryWatcher.broadcastNow();
        }
        attemptTrustedReconnects();
    }

    // Each packet type gets its own private handler below (previously one 290-line if-else chain
    // inside the deviceManager Listener's onPacket) — purely organizational, same instance fields/
    // methods accessible either way, identical dispatch order/logic, so behavior is unchanged.
    // Java has no local/nested method declarations (unlike the TS side's equivalent cleanup in
    // main.ts), so these live as private instance methods instead of closures.

    private void handleClipboardPacket(String deviceId, LinkPacket packet) {
        if (!isEnabled("Clipboard")) return;
        // No receive-side gate — Clipboard is sending-only now (see canSendClipboardTo): the
        // peer already decided whether to share via their own outbound permission-for-us.
        if (!LinkClipboard.PACKET_TYPE_CLIPBOARD_FILE.equals(packet.type)) {
            String text = LinkClipboard.extractIncomingText(packet, lastKnownClipboardTimestamp);
            if (text != null) {
                clipboardWatcher.applyRemote(text);
                lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
                android.util.Log.i(TAG, "CLIPBOARD RECEIVED: \"" + text + "\"");
                JSObject data = new JSObject();
                data.put("deviceId", deviceId);
                notifyListeners("clipboardReceived", data);
            }
        }
    }

    private void handleBatteryPacket(String deviceId, LinkPacket packet) {
        boolean isCharging = packet.body.optBoolean("isCharging", false);
        int currentCharge = packet.body.optInt("currentCharge", -1);
        android.util.Log.i(TAG, "BATTERY RECEIVED: " + currentCharge + "% charging=" + isCharging);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("isCharging", isCharging);
        data.put("currentCharge", currentCharge);
        notifyListeners("batteryReceived", data);
    }

    private void handleFindMyDevicePacket(String deviceId, LinkPacket packet) {
        // No kill-switch or per-device permission gate — ring is inherently available to any
        // connected, trusted device, same as rename.
        boolean cancel = packet.body.optBoolean("cancel", false);
        android.util.Log.i(TAG, "FIND MY DEVICE (cancel=" + cancel + ") triggered by " + deviceId);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        if (cancel) {
            LinkFindMyDevice.stopRinging(getContext());
            activeRingerDeviceId = null;
            notifyListeners("findMyPhoneStopped", data);
            notifyListeners("findMyDeviceStopped", data);
        } else {
            activeRingerDeviceId = deviceId;
            LinkFindMyDevice.ring(getContext());
            notifyListeners("findMyPhoneTriggered", data);
            notifyListeners("findMyDeviceTriggered", data);
        }
    }

    private void handleRunCommandListPacket(String deviceId, LinkPacket packet) {
        org.json.JSONObject commands = LinkRunCommand.parseCommandList(packet);
        android.util.Log.i(TAG, "COMMAND LIST RECEIVED: " + commands.toString());
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("commands", commands.toString());
        notifyListeners("commandListReceived", data);
    }

    private void handleSystemVolumePacket(String deviceId, LinkPacket packet) {
        java.util.List<LinkSystemVolume.Sink> sinks = LinkSystemVolume.allSinks(packet);
        android.util.Log.i(TAG, "SYSTEM VOLUME RECEIVED: " + sinks.size() + " sinks");
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        org.json.JSONArray arr = new org.json.JSONArray();
        for (LinkSystemVolume.Sink sink : sinks) {
            try {
                org.json.JSONObject obj = new org.json.JSONObject();
                obj.put("name", sink.name);
                obj.put("description", sink.description);
                obj.put("volume", sink.volume);
                obj.put("muted", sink.muted);
                arr.put(obj);
            } catch (Exception ignored) {}
        }
        data.put("sinks", arr);
        notifyListeners("systemVolumeReceived", data);
    }

    private void handleSystemVolumeRequestPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "systemvolume")) {
            android.util.Log.i(TAG, "Blocked System Volume request from " + deviceId + " (Permission disabled)");
            return;
        }
        android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        LinkSystemVolume.handleLocalVolumeRequest(packet, audio);
        deviceManager.sendTo(deviceId, LinkSystemVolume.createLocalSinksPacket(audio));
    }

    private void handleCapabilitiesPacket(String deviceId, LinkPacket packet) {
        // Unified per-peer signal: exactly which of the peer's gated capabilities we're
        // currently allowed to use. The JS layer gates every button/section on membership in
        // this list — no per-plugin revoke marker needed.
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        org.json.JSONArray caps = packet.body.optJSONArray("capabilities");
        if (caps == null) caps = new org.json.JSONArray();
        android.util.Log.d(TAG, "Received capabilities from " + deviceId + ": " + caps.toString());
        peerCapabilities.put(deviceId, caps); // cache for WebView-reload re-hydration
        data.put("capabilities", caps);
        notifyListeners("peerCapabilitiesReceived", data);
    }

    private void handleTelephonyPacket(String deviceId, LinkPacket packet) {
        // Receiving/display half — previously entirely missing on Android, so an incoming call
        // on phone A never showed up on a connected phone B, only on a connected PC (which had
        // this half in main.ts). Mirrors that handler. No receive-side gate — Telephony is
        // owned by the SENDING phone, which already decided (via its own outbound permission-
        // for-us) whether to share this; the receiving side never gets its own say.
        String event = packet.body.optString("event", null);
        boolean isCancel = packet.body.optBoolean("isCancel", false);
        String effectiveEvent = isCancel ? "cancelled" : event;
        String phoneNumber = packet.body.has("phoneNumber") ? packet.body.optString("phoneNumber") : null;
        String contactName = packet.body.has("contactName") ? packet.body.optString("contactName") : null;
        String iconBase64 = packet.body.has("iconBase64") ? packet.body.optString("iconBase64") : null;
        LinkTelephony.showRemoteCallNotification(getContext(), deviceId, effectiveEvent, phoneNumber, contactName, iconBase64);
        LinkPauseMusic.onCallStateChanged(getContext(), effectiveEvent, isCancel);
    }

    private void handleTelephonyRequestPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "telephony")) {
            android.util.Log.w(TAG, "Blocked telephony request from " + deviceId + " (Permission disabled)");
            return;
        }
        String action = packet.body.optString("action", "");
        android.util.Log.i(TAG, "Received telephony request action: " + action + " from " + deviceId);
        if ("mute".equalsIgnoreCase(action)) {
            LinkTelephony.silenceRinger(getContext());
        } else if ("reject".equalsIgnoreCase(action) || "decline".equalsIgnoreCase(action)) {
            LinkTelephony.endCall(getContext());
        } else if ("accept".equalsIgnoreCase(action)) {
            LinkTelephony.acceptCall(getContext());
        }
    }

    private void handleFlashlightPacket(String deviceId, LinkPacket packet) {
        boolean enabled = packet.body.optBoolean("enabled", false);
        boolean isCommand = packet.body.optBoolean("isCommand", false);

        if (isCommand) {
            // This is a command from a peer trying to control THIS device's flashlight
            if (!LinkDevicePermissions.check(getContext(), deviceId, "flashlight")) {
                android.util.Log.i(TAG, "Blocked flashlight command from " + deviceId + " (Permission disabled)");
                return;
            }
            LinkFlashlight.setTorchMode(getContext(), enabled);
            // Do NOT notify UI of command execution — the torch callback listener will handle
            // broadcasting the real state change to peers when the torch actually changes.
            return;
        }

        // This is a state broadcast from a peer — display it on the UI
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("enabled", enabled);
        notifyListeners("flashlightStateReceived", data);
    }

    private void handleDndPacket(String deviceId, LinkPacket packet) {
        boolean enabled = packet.body.optBoolean("enabled", false);
        boolean isCommand = packet.body.optBoolean("isCommand", false);

        if (isCommand) {
            // This is a command from a peer trying to control THIS device's DND
            if (!LinkDevicePermissions.check(getContext(), deviceId, "dnd")) {
                android.util.Log.i(TAG, "Blocked DND command from " + deviceId + " (Permission disabled)");
                return;
            }
            // Without the OS-level "Do Not Disturb access" grant, we can't execute the command
            if (!LinkDND.isDndGranted(getContext())) {
                android.util.Log.i(TAG, "Cannot execute DND command from " + deviceId + " — app lacks 'Do Not Disturb access' permission in Android Settings");
                return;
            }
            LinkDND.setDnd(getContext(), enabled);
            // Do NOT notify UI of command execution — the receiver listener will handle
            // broadcasting the real state change to peers when DND actually changes.
            return;
        }

        // This is a state broadcast from a peer — display it on the UI
        // The peer's state is displayable regardless of whether THIS device has DND access
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("enabled", enabled);
        data.put("granted", LinkDND.isDndGranted(getContext()));
        notifyListeners("dndStateReceived", data);
    }

    // Mobile-to-mobile presenter: this device is the TARGET being controlled by a peer (e.g.
    // another phone). Mirrors desktop main.ts's showPresenterDot/hidePresenterDot — permission
    // gate first, then forward dx/dy (or stop) to the JS layer, which renders the in-app
    // full-screen pointer-dot overlay (mobile has no OS-level always-on-top window like Electron's
    // BrowserWindow, so the overlay lives inside this app's own WebView instead).
    private void handlePresenterPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "presenter")) {
            android.util.Log.i(TAG, "Blocked Presenter packet from " + deviceId + " (Permission disabled)");
            return;
        }
        boolean stop = packet.body.optBoolean("stop", false);
        if (stop) {
            // Hide both overlay implementations unconditionally — harmless no-op on whichever
            // one isn't currently active (permission may have changed mid-session).
            LinkPresenterOverlay.hide(true);
        }
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        if (stop) {
            data.put("stop", true);
        } else {
            data.put("dx", packet.body.optDouble("dx", 0));
            data.put("dy", packet.body.optDouble("dy", 0));
        }
        notifyListeners("presenterPositionReceived", data);
    }

    // Fixed coordinate space the sender's events are expressed in (see RemoteInputOverlay.tsx /
    // RemoteKeyboardOverlay.tsx — both send a 10000x10000 session by default), used to scale
    // incoming x/y onto this device's actual screen pixels for real touch injection below.
    private int digitizerSessionWidth = 10000;
    private int digitizerSessionHeight = 10000;

    private void handleDigitizerSessionPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
            android.util.Log.i(TAG, "Blocked Digitizer session from " + deviceId + " (Permission disabled)");
            return;
        }
        String action = packet.getBody().optString("action");
        if ("start".equals(action)) {
            digitizerSessionWidth = packet.getBody().optInt("width", 10000);
            digitizerSessionHeight = packet.getBody().optInt("height", 10000);
            if (LinkAccessibilityService.getInstance() == null) {
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                    android.widget.Toast.makeText(getContext(),
                        "Link Accessibility Service is disabled. Please enable it in Settings -> Accessibility to receive pen/digitizer input.",
                        android.widget.Toast.LENGTH_LONG).show());
            }
        } else {
            LinkAccessibilityService service = LinkAccessibilityService.getInstance();
            if (service != null) service.endDigitizerTouch();
        }
    }

    private void handleDigitizerPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
            return;
        }
        injectDigitizerEvent(
            packet.getBody().optInt("x", 0),
            packet.getBody().optInt("y", 0),
            packet.getBody().optBoolean("touching", false)
        );
    }

    // Maps the sender's fixed-space x/y onto this device's real screen pixels and injects a
    // genuine system-wide touch via AccessibilityService.dispatchGesture — see the comment on
    // LinkAccessibilityService.injectDigitizerTouch for why that's the mechanism used. Must run
    // on the main thread (dispatchGesture requires a Looper); callers here are the TLS packet
    // handler (Binder thread) and the UDP relay listener (its own background thread), neither of
    // which is guaranteed to already be on it.
    private void injectDigitizerEvent(int x, int y, boolean touching) {
        LinkAccessibilityService service = LinkAccessibilityService.getInstance();
        if (service == null) return;

        android.util.DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
        float px = (x / (float) digitizerSessionWidth) * dm.widthPixels;
        float py = (y / (float) digitizerSessionHeight) * dm.heightPixels;

        new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
            service.injectDigitizerTouch(px, py, touching));
    }

    private void handleRemoteControlSignalPacket(String deviceId, LinkPacket packet) {
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

    private void handleRemoteControlStreamPacket(String deviceId, LinkPacket packet) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        try {
            data.put("frame", new JSObject(packet.body.toString()));
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed parsing remote control frame json", e);
        }
        notifyListeners("remoteControlStreamReceived", data);
    }

    private void handleRemoteControlInputPacket(String deviceId, LinkPacket packet) {
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
            android.util.DisplayMetrics dm = getContext().getResources().getDisplayMetrics();

            if ("tap".equals(action) || "click".equals(action)) {
                double nx = body.optDouble("x", 0.5);
                double ny = body.optDouble("y", 0.5);
                float px = (float) (nx * dm.widthPixels);
                float py = (float) (ny * dm.heightPixels);
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                    service.injectTap(px, py);
                });
            } else if ("scroll".equals(action) || "swipe".equals(action)) {
                double sx = body.optDouble("startX", 0.5) * dm.widthPixels;
                double sy = body.optDouble("startY", 0.5) * dm.heightPixels;
                double ex = body.optDouble("endX", 0.5) * dm.widthPixels;
                double ey = body.optDouble("endY", 0.5) * dm.heightPixels;
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

    private void handleLockPacket(String deviceId, LinkPacket packet) {
        boolean isLocked = packet.body.optBoolean("isLocked", false);
        android.util.Log.i(TAG, "LOCK RECEIVED: locked=" + isLocked);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("isLocked", isLocked);
        notifyListeners("lockStateReceived", data);

        if (packet.body.has("lockResult")) {
            boolean lockResult = packet.body.optBoolean("lockResult", false);
            JSObject resultData = new JSObject();
            resultData.put("deviceId", deviceId);
            resultData.put("success", lockResult);
            notifyListeners("lockResultReceived", resultData);
        }
    }

    private void handleLockRequestPacket(String deviceId, LinkPacket packet) {
        // Locking is open to every paired device, like the desktop side: it needs no permission.
        Boolean lockResult = null;
        if (packet.body != null && packet.body.optBoolean("setLocked", false)) {
            lockResult = LinkLock.lockDevice();
            android.util.Log.i(TAG, "Remote lock executed: success=" + lockResult);
        }
        deviceManager.sendTo(deviceId, LinkLock.createLockPacket(getContext(), lockResult));
    }

    private void handleRenameRequestPacket(String deviceId, LinkPacket packet) {
        // Rename isn't gated by the test.txt kill-switch — it's inherently available on any
        // valid connection, not an optional plugin. A peer asked US to rename ourselves. Device
        // names are self-owned, so apply it locally then broadcast the authoritative result to
        // every connected peer (including back to the requester) — mirrors desktop's
        // isRenameRequestPacket handling in main.ts.
        String requestedName = packet.body.optString("deviceName", null);
        if (requestedName != null) {
            String applied = LinkIdentity.saveDeviceName(getContext(), requestedName);
            try {
                myIdentity = LinkIdentity.loadOrCreate(getContext(), LinkCapabilitiesSchema.CAPABILITIES, LinkCapabilitiesSchema.CAPABILITIES);
                if (deviceManager != null) {
                    deviceManager.updateMyIdentity(myIdentity);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to reload identity after rename request", e);
            }
            JSObject ownData = new JSObject();
            ownData.put("newName", applied);
            notifyListeners("ownDeviceRenamed", ownData);
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("deviceName", applied);
                LinkPacket renamePacket = new LinkPacket("link.rename", body);
                for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                    deviceManager.sendTo(peerId, renamePacket);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to broadcast rename", e);
            }
        }
    }

    private void handleRenamePacket(String deviceId, LinkPacket packet) {
        // Authoritative name change from a peer — sync our local trust-store alias and reflect
        // it live without needing a reconnect.
        String newName = packet.body.optString("deviceName", null);
        if (newName != null) {
            LinkTrustStore store = new LinkTrustStore(getContext());
            store.rename(deviceId, newName);
            if (deviceManager != null) {
                deviceManager.updatePeerName(deviceId, newName);
            }
            JSObject data = new JSObject();
            data.put("deviceId", deviceId);
            data.put("newName", newName);
            notifyListeners("deviceRenamed", data);
        }
    }

    private void handleConnectivityPacket(String deviceId, LinkPacket packet) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        try {
            data.put("signalStrengths", new JSObject(packet.body.getJSONObject("signalStrengths").toString()));
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed parsing connectivity report", e);
        }
        notifyListeners("connectivityReceived", data);
    }

    private void handleMprisStatePacket(String deviceId, LinkPacket packet) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        try {
            data.put("state", new JSObject(packet.body.toString()));
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed parsing mpris json", e);
        }
        notifyListeners("mprisStateReceived", data);
    }

    private void handleMprisRequestPacket(String deviceId, LinkPacket packet) {
        String action = packet.body.optString("action");
        if (!LinkDevicePermissions.check(getContext(), deviceId, "mpris")) {
            android.util.Log.i(TAG, "Blocked MPRIS request from " + deviceId + " (Permission disabled)");
            return;
        }
        LinkMpris.handleMediaRequest(getContext(), packet);
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            broadcastMprisState();
        }, 150);
    }

    private void handleNotificationReplyPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "notification")) {
            android.util.Log.i(TAG, "Blocked notification reply from " + deviceId + " (Permission disabled)");
            return;
        }
        String replyId = packet.body.optString("requestReplyId");
        String message = packet.body.optString("message");
        if (replyId != null && message != null) {
            replyToNotification(replyId, message);
        }
    }

    private void handleSpeedTestRequestPacket(String deviceId, LinkPacket packet) {
        // Delegates to LinkSpeedTest, which uses the real binary payload channel for both
        // "upload" and "download" responder roles. This used to be a separate stale inline
        // handler predating that mechanism — it ACKed "upload" instantly without ever reading
        // the payload channel, and answered "download" with a hardcoded 5MB string embedded in
        // JSON, producing impossibly large computed speeds (a JSON round-trip's duration, not a
        // real transfer's) whenever this device was the responder.
        if (speedTest != null) {
            speedTest.handleIncomingRequest(packet, deviceId);
        }
    }

    private void handleSpeedTestResponsePacket(LinkPacket packet) {
        speedTest.handleResponse(packet);
    }

    private void handleAudioSinkStartedPacket(String deviceId, LinkPacket packet) {
        String token = packet.body.optString("token", null);
        // The host address is resolved HERE, from the sender's own connection — never taken from
        // the packet. A sender cannot name the address the receiver should dial: its own view of
        // the link is the receiver's IP, so echoing that back would aim the join at this device
        // itself and fail with ECONNREFUSED on the audio port.
        String host = deviceManager != null ? deviceManager.remoteAddressOf(deviceId) : null;
        if (token == null || host == null) return;
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("token", token);
        data.put("host", host);
        notifyListeners("audioSinkPairedSessionStarted", data);
    }

    private void handleAudioSinkEndedPacket(String deviceId) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        notifyListeners("audioSinkPairedSessionEnded", data);
    }

    /** Real display name for a peer, for labeling Audio Relay/Remote Mic listeners — those server
     *  classes deliberately have no trust-store access of their own (see their own issueToken()
     *  comments), so this is looked up here and passed in at token-issue time instead of falling
     *  back to a truncated device ID or a generic placeholder. */
    private String getDeviceDisplayName(String deviceId) {
        try {
            LinkTrustStore.TrustedDevice dev = new LinkTrustStore(getContext()).get(deviceId);
            if (dev != null && dev.deviceName != null) return dev.deviceName;
        } catch (Exception ignored) {}
        return deviceId;
    }

    /** Mirrors desktop main.ts's blockUntrustedGuest() — see its comment for the full reasoning.
     *  Blocking an untrusted-tool guest (Audio Sink/Remote Mic/Walkie Talkie/Joystick/File
     *  Transfer) by bare IP always produced a generic "Guest (ip)" entry, visually different from
     *  blocking the same physical device via reject+block on a pairing request. If this IP
     *  resolves to a device this app can actually identify — paired, or just visible via LAN
     *  discovery even though never paired — block it by deviceId with its real name/type instead,
     *  so the Blocklist entry looks identical regardless of which surface the block came from. */
    private void blockUntrustedGuest(String remoteAddress, String selfReportedName) {
        String cleanIp = remoteAddress != null ? remoteAddress.replace("::ffff:", "").split(":")[0] : null;
        if (cleanIp == null) return;

        String pairedId = deviceManager != null ? deviceManager.deviceIdForAddress(cleanIp) : null;
        if (pairedId != null) {
            String name = getDeviceDisplayName(pairedId);
            LinkBlocklist.add(getContext(), pairedId, name != null ? name : (selfReportedName != null ? selfReportedName : "Guest (" + cleanIp + ")"), "device", null, cleanIp);
            return;
        }

        for (JSObject peer : sDiscoveredPeers.values()) {
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

    /** Mirrors desktop main.ts's link.audiosink.query handler exactly: if we're currently
     *  hosting, mint a fresh one-time token for the asking peer and reply — same mechanism used
     *  when a session first starts (see the token-issuing loop in onMediaProjectionResult()), just
     *  triggered by a peer opening its Audio Relay tab late instead of at session-start time. */
    private void handleAudioSinkQueryPacket(String deviceId) {
        if (sAudioSinkServer == null || deviceManager == null) return;
        String token = sAudioSinkServer.issueToken(deviceId, getDeviceDisplayName(deviceId));
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("port", LinkTransport.AUDIO_RELAY_PORT);
            // No "host" — the receiver resolves it from this connection (see
            // handleAudioSinkStartedPacket); anything we put here would be their address, not ours.
            deviceManager.sendTo(deviceId, new LinkPacket("link.audiosink.started", body));
        } catch (Exception ignored) {}
    }

    private void handleRemoteMicQueryPacket(String deviceId) {
        if (sRemoteMicServer == null || deviceManager == null) return;
        String token = sRemoteMicServer.issueToken(deviceId, getDeviceDisplayName(deviceId));
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
            deviceManager.sendTo(deviceId, new LinkPacket("link.remotemic.started", body));
        } catch (Exception ignored) {}
    }

    // ===== Walkie Talkie (real-time multi-party voice, WebRTC full mesh) =====
    // Pure signaling relay, same as main.ts's — session membership + SDP/ICE negotiation logic all
    // lives in WalkieTalkieTab.tsx (shared with desktop). This class never parses `body`, just
    // forwards it as an opaque JSON string; getUserMedia/RTCPeerConnection run in the WebView
    // itself (wry's RustWebChromeClient already grants RECORD_AUDIO for getUserMedia), so
    // no native audio code exists on this side of the feature at all. No per-device permission
    // gate — same as Joystick: pairing itself is the trust decision for this ephemeral session
    // tool, not a standing capability to grant/deny separately.
    private void handleWalkieTalkieSignalPacket(String deviceId, LinkPacket packet) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("type", packet.type);
        data.put("body", packet.body != null ? packet.body.toString() : "{}");
        notifyListeners("walkieTalkieSignal", data);
    }

    @LinkMethod
    public void sendWalkieTalkieSignal(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (deviceManager != null && deviceId != null && type != null) {
            try {
                deviceManager.sendTo(deviceId, new LinkPacket(type, new JSONObject(bodyStr)));
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @LinkMethod
    public void broadcastWalkieTalkieSignal(LinkCall call) {
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (deviceManager != null && type != null) {
            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                try {
                    deviceManager.sendTo(peerId, new LinkPacket(type, new JSONObject(bodyStr)));
                } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    // --- Guest-facing (an unpaired participant reaches us via manual IP + PIN instead) ---
    @LinkMethod
    public void startWalkieTalkieGuestListener(LinkCall call) {
        if (sWalkieTalkieGuestServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.WALKIE_TALKIE_PORT);
            call.resolve(ret);
            return;
        }
        if (deviceManager == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Not initialized");
            call.resolve(ret);
            return;
        }
        try {
            LinkWalkieTalkieServer server = new LinkWalkieTalkieServer(
                getContext(), deviceManager.getMyCert(), deviceManager.getMyKey(), LinkTransport.WALKIE_TALKIE_PORT,
                new LinkWalkieTalkieServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("walkieTalkieGuestPinPending", data);
                    }
                    @Override
                    public void onTrustedGuestJoined(String connId, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("walkieTalkieGuestJoined", data);
                    }
                    @Override
                    public void onSignal(String connId, String type, String bodyJson) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("type", type);
                        data.put("body", bodyJson);
                        notifyListeners("walkieTalkieGuestSignal", data);
                    }
                    @Override
                    public void onGuestLeft(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("walkieTalkieGuestLeft", data);
                    }
                    @Override
                    public void onError(String message) {
                        android.util.Log.e(TAG, "Walkie Talkie guest listener error: " + message);
                    }
                },
                idOrIp -> LinkBlocklist.isBlocked(getContext(), idOrIp));
            server.start();
            sWalkieTalkieGuestServer = server;
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
            return;
        }
        JSObject ret = new JSObject();
        ret.put("started", true);
        ret.put("port", LinkTransport.WALKIE_TALKIE_PORT);
        call.resolve(ret);
    }

    @LinkMethod
    public void stopWalkieTalkieGuestListener(LinkCall call) {
        if (sWalkieTalkieGuestServer != null) {
            try { sWalkieTalkieGuestServer.stop(); } catch (Exception ignored) {}
            sWalkieTalkieGuestServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void acceptWalkieTalkieGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) sWalkieTalkieGuestServer.acceptGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void rejectWalkieTalkieGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) sWalkieTalkieGuestServer.rejectGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockWalkieTalkieGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) {
            String ip = sWalkieTalkieGuestServer.getPendingGuestRemoteAddress(connId);
            if (ip != null) blockUntrustedGuest(ip, null);
            sWalkieTalkieGuestServer.rejectGuest(connId);
            sWalkieTalkieGuestServer.kickGuest(connId);
        }
        call.resolve();
    }

    // Plain kick — disconnects an already-admitted guest without touching the Blocklist, so they
    // can rejoin later. Mirrors main.ts's kick-walkie-talkie-guest handler (desktop-hosting side);
    // this is the same method for when a PHONE is the one hosting instead.
    @LinkMethod
    public void kickWalkieTalkieGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) sWalkieTalkieGuestServer.kickGuest(connId);
        call.resolve();
    }

    // A PAIRED member being blocked isn't a "guest" the signal server knows about at all — it's an
    // existing trusted device, so this is a plain device-id Blocklist entry, mirroring main.ts's
    // block-walkie-talkie-member handler (desktop-hosting side). Captures their current IP too
    // (see LinkBlocklist.isBlocked's cross-check) — without this, blocking them by deviceId
    // wouldn't stop the same device from reconnecting as an untrusted-tool guest, which only ever
    // checks by IP.
    @LinkMethod
    public void blockWalkieTalkieMember(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String label = call.getString("label", deviceId);
        if (deviceId != null) {
            String ip = deviceManager != null ? deviceManager.remoteAddressOf(deviceId) : null;
            LinkBlocklist.add(getContext(), deviceId, label, "device", null, ip);
        }
        call.resolve();
    }

    @LinkMethod
    public void sendWalkieTalkieGuestSignal(LinkCall call) {
        String connId = call.getString("connId");
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (sWalkieTalkieGuestServer != null && connId != null && type != null) {
            sWalkieTalkieGuestServer.sendTo(connId, type, bodyStr);
        }
        call.resolve();
    }

    // --- Guest-side (us joining someone else's session via manual IP, unpaired) ---
    @LinkMethod
    public void joinWalkieTalkieGuest(LinkCall call) {
        String host = call.getString("host");
        if (deviceManager == null || host == null) {
            call.resolve();
            return;
        }
        if (sWalkieTalkieGuestClient != null) sWalkieTalkieGuestClient.disconnect();
        LinkWalkieTalkieClient client = new LinkWalkieTalkieClient(new LinkWalkieTalkieClient.Listener() {
            @Override
            public void onPinComputed(String pin) {
                JSObject data = new JSObject();
                data.put("pin", pin);
                notifyListeners("walkieTalkieGuestPinComputed", data);
            }
            @Override
            public void onAdmitted() {
                // No dedicated event needed — the host follows admission with a join-accepted
                // signal (same as the trusted-mesh flow), which onSignal already forwards.
            }
            @Override
            public void onSignal(String type, String bodyJson) {
                JSObject data = new JSObject();
                data.put("type", type);
                data.put("body", bodyJson);
                notifyListeners("walkieTalkieHostSignal", data);
            }
            @Override
            public void onEnded(String reason) {
                sWalkieTalkieGuestClient = null;
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("walkieTalkieHostEnded", data);
            }
            @Override
            public void onClosed(String reason) {
                sWalkieTalkieGuestClient = null;
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("walkieTalkieHostClosed", data);
            }
            @Override
            public void onError(String message) {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("walkieTalkieHostError", data);
            }
        });
        sWalkieTalkieGuestClient = client;
        client.connect(host, LinkTransport.WALKIE_TALKIE_PORT, deviceManager.getMyCert(), deviceManager.getMyKey(), myIdentity != null ? myIdentity.deviceName : "Guest");
        call.resolve();
    }

    @LinkMethod
    public void leaveWalkieTalkieGuest(LinkCall call) {
        if (sWalkieTalkieGuestClient != null) {
            sWalkieTalkieGuestClient.disconnect();
            sWalkieTalkieGuestClient = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void sendWalkieTalkieGuestMessage(LinkCall call) {
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (sWalkieTalkieGuestClient != null && type != null) {
            sWalkieTalkieGuestClient.send(type, bodyStr);
        }
        call.resolve();
    }

    private void sendInitialSync(String deviceId) {
        if (deviceManager == null) return;
        // Ensure permissions are upgraded to new defaults (especially for devices paired
        // before communication features defaulted to ALLOWED). This is a no-op for freshly
        // paired devices, but upgrades existing devices to have DND/flashlight/etc. enabled.
        LinkDevicePermissions.initializeDeniedPermissionsForNewDevice(getContext(), deviceId);
        // 0. Effective capabilities — lets the peer's UI know upfront exactly which of our gated
        // features it's currently allowed to use, before any state packets below even arrive.
        deviceManager.sendTo(deviceId, LinkCapabilities.createCapabilitiesPacket(getContext(), deviceId));
        // Send current local media playback status immediately
        if (LinkDevicePermissions.check(getContext(), deviceId, "mpris")) {
            deviceManager.sendTo(deviceId, LinkMpris.createLocalStatePacket(getContext()));
        }

        // 1. Clipboard
        if (isEnabled("Clipboard") && clipboardWatcher != null && LinkDevicePermissions.canSendClipboardTo(getContext(), deviceId)) {
            deviceManager.sendTo(deviceId, LinkClipboard.createConnectPacket(
                    clipboardWatcher.currentContent(), clipboardWatcher.currentTimestamp()));
        }
        // 2. Battery
        if (batteryWatcher != null && batteryWatcher.lastKnownIsCharging() != null) {
            deviceManager.sendTo(deviceId, LinkBattery.createPacket(
                    batteryWatcher.lastKnownIsCharging(), batteryWatcher.lastKnownCharge(), 0));
        }
        // 3. Connectivity status
        if (connectivityWatcher != null && !connectivityWatcher.lastKnownStates().isEmpty()) {
            deviceManager.sendTo(deviceId, LinkConnectivity.createPacket(connectivityWatcher.lastKnownStates()));
        }
        // 4. Run commands list — mesh case: ask the peer for its whitelist (Android has no
        // executor/whitelist of its own to serve back, only desktop does).
        deviceManager.sendTo(deviceId, LinkRunCommand.createRequestListPacket());
        // 5. System Volume Sinks
        if (LinkDevicePermissions.check(getContext(), deviceId, "systemvolume")) {
            android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
            deviceManager.sendTo(deviceId, LinkSystemVolume.createLocalSinksPacket(audio));
        }
        // 6. Flashlight
        if (LinkDevicePermissions.check(getContext(), deviceId, "flashlight")) {
            deviceManager.sendTo(deviceId, LinkFlashlight.createStatusPacket(LinkFlashlight.isTorchOn()));
        }
        // 7. DND — send state if permission allows (grant check only matters for execution,
        // not for advertising state)
        if (LinkDevicePermissions.check(getContext(), deviceId, "dnd")) {
            deviceManager.sendTo(deviceId, LinkDND.createStatusPacket(getContext()));
        }
        // 8. Lock state
        deviceManager.sendTo(deviceId, LinkLock.createLockPacket(getContext(), null));
    }

    @LinkMethod
    public void toggleFlashlight(LinkCall call) {
        boolean res = LinkFlashlight.toggle(getContext());
        LinkPacket packet = LinkFlashlight.createStatusPacket(res);
        if (deviceManager != null) {
            broadcastToPermittedPeers("flashlight", packet);
        }
        JSObject ret = new JSObject();
        ret.put("enabled", res);
        call.resolve(ret);
    }

    @LinkMethod
    public void setDnd(LinkCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        LinkDND.setDnd(getContext(), enabled);
        LinkPacket packet = LinkDND.createStatusPacket(getContext());
        if (deviceManager != null && LinkDND.isDndGranted(getContext())) {
            broadcastToPermittedPeers("dnd", packet);
        }
        JSObject ret = new JSObject();
        ret.put("enabled", LinkDND.isDndEnabled(getContext()));
        ret.put("granted", LinkDND.isDndGranted(getContext()));
        call.resolve(ret);
    }

    @LinkMethod
    public void checkDndPermission(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", LinkDND.isDndGranted(getContext()));
        call.resolve(ret);
    }

    @LinkMethod
    public void requestDndPermission(LinkCall call) {
        // Always open the settings screen, granted or not — like notification-listener access,
        // this is a toggle the OS owns on its own settings page, so the same intent serves both
        // granting and revoking. Previously this only fired when NOT yet granted, so tapping the
        // toggle to revoke an already-granted permission silently did nothing.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
            if (getActivity() != null) {
                getActivity().startActivity(intent);
            } else {
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void sendFlashlightToggle(LinkCall call) {
        String deviceId = call.getString("deviceId");
        boolean enabled = call.getBoolean("enabled", false);
        if (deviceManager != null && deviceId != null) {
            deviceManager.sendTo(deviceId, LinkFlashlight.createCommandPacket(enabled));
        }
        call.resolve();
    }

    // ===== Audio Relay (host + listener) =====
    @LinkMethod
    public void joinAudioSinkGuest(LinkCall call) {
        String host = call.getString("host");
        if (host == null || deviceManager == null) {
            call.reject("Missing host, or not initialized");
            return;
        }
        startAudioSinkListener(host, null);
        call.resolve();
    }

    @LinkMethod
    public void joinAudioSinkPaired(LinkCall call) {
        String host = call.getString("host");
        String token = call.getString("token");
        if (host == null || token == null || deviceManager == null) {
            call.reject("Missing host/token, or not initialized");
            return;
        }
        startAudioSinkListener(host, token);
        call.resolve();
    }

    @LinkMethod
    public void leaveAudioSink(LinkCall call) {
        if (sAudioSinkClient != null) {
            sAudioSinkClient.disconnect();
            sAudioSinkClient = null;
        }
        sAudioSinkHostLabel = "";
        updateSessionNotification();
        call.resolve();
    }

    @LinkMethod
    public void setAudioSinkListenerVolume(LinkCall call) {
        Double volume = call.getDouble("volume");
        if (sAudioSinkClient != null && volume != null) {
            sAudioSinkClient.setVolume(volume.floatValue());
        }
        call.resolve();
    }

    /** Called once when the Audio Relay tab opens — the one-shot 'link.audiosink.started'
     *  broadcast a host sends only ever reaches a peer that was connected AND had this screen
     *  open at that exact moment, with no way to catch up otherwise. Handled symmetrically by
     *  handleAudioSinkQueryPacket() above when THIS device is the one being asked. */
    @LinkMethod
    public void queryAudioSinkSessions(LinkCall call) {
        if (deviceManager != null) {
            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                deviceManager.sendTo(peerId, new LinkPacket("link.audiosink.query", new JSONObject()));
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void setAudioSinkMuted(LinkCall call) {
        Boolean muted = call.getBoolean("muted");
        if (sAudioSinkServer != null && muted != null) sAudioSinkServer.setMuted(muted);
        updateSessionNotification();
        call.resolve();
    }

    @LinkMethod
    public void acceptAudioSinkGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.acceptGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void rejectAudioSinkGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.rejectGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockAudioSinkGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) {
            String remoteAddress = sAudioSinkServer.getPendingGuestRemoteAddress(connId);
            if (remoteAddress != null) {
                blockUntrustedGuest(remoteAddress, null);
            }
            sAudioSinkServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void kickAudioSinkListener(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.kickListener(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockAudioSinkListener(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) {
            LinkAudioSinkServer.ListenerBlockInfo info = sAudioSinkServer.getListenerBlockInfo(connId);
            if (info != null) {
                if (info.deviceId != null) {
                    // Captures their current IP too (mirrors desktop's isBlocked fix) — without
                    // this, blocking a paired listener by deviceId wouldn't stop the same device
                    // from reconnecting as an untrusted-tool guest, which only ever checks by IP.
                    LinkBlocklist.add(getContext(), info.deviceId, getDeviceDisplayName(info.deviceId), "device", null, info.remoteAddress);
                } else {
                    blockUntrustedGuest(info.remoteAddress, null);
                }
            }
            sAudioSinkServer.kickListener(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void getAudioSinkListeners(LinkCall call) {
        JSObject ret = new JSObject();
        JSArray arr = new JSArray();
        if (sAudioSinkServer != null) {
            for (LinkAudioSinkServer.ListenerInfo l : sAudioSinkServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    // Was missing from the mobile bridge entirely — AudioSinkTab.tsx queries this on every
    // mount to restore "currently hosting"/"currently listening" state (e.g. after the tab was
    // closed and reopened), so without it the UI always fell back to the fresh idle screen even
    // mid-session. Mirrors desktop main.ts's 'get-audio-sink-status' handler: mobile is never a
    // listener for its own hosted Audio Relay session (this device only ever hosts OR joins
    // someone else's, never both), so "listening" here can't currently be true, but the shape
    // matches the desktop response for a consistent contract either way.
    @LinkMethod
    public void getAudioSinkStatus(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("hosting", sAudioSinkServer != null);
        ret.put("listening", sAudioSinkClient != null);
        ret.put("hostLabel", sAudioSinkHostLabel);
        JSArray arr = new JSArray();
        if (sAudioSinkServer != null) {
            for (LinkAudioSinkServer.ListenerInfo l : sAudioSinkServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    @LinkMethod
    public void endAudioSink(LinkCall call) {
        stopAudioSinkHosting();
        call.resolve();
    }

    /** Shared teardown for both the explicit "End Session" button (endAudioSink above) and the
     *  OS revoking capture via its own "Stop casting" control (MediaProjection.Callback.onStop()
     *  in onMediaProjectionResult()) — neither path has anything more to do than this. */
    private void stopAudioSinkHosting() {
        if (sAudioSinkServer == null) return;
        if (deviceManager != null) {
            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                deviceManager.sendTo(peerId, new LinkPacket("link.audiosink.ended", new JSONObject()));
            }
        }
        try {
            sAudioSinkServer.stop();
        } catch (Exception e) {
            android.util.Log.e(TAG, "Error stopping AudioSinkServer", e);
        }
        sAudioSinkServer = null;
        updateSessionNotification();
    }

    /** Requires Android 10+ (AudioPlaybackCaptureConfiguration) — minSdkVersion is 23, so this
     *  fails gracefully here rather than the UI pre-emptively hiding the Start Session button.
     *  Order: RECORD_AUDIO (mundane runtime permission) is checked/requested BEFORE the heavier
     *  MediaProjection system consent dialog, to avoid asking for the big scary dialog only to
     *  then need the small one afterward, and because building the capture config without
     *  RECORD_AUDIO already granted throws a SecurityException. */
    @LinkMethod
    public void startAudioSink(LinkCall call) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Requires Android 10 (API 29) or newer");
            call.resolve(ret);
            return;
        }
        if (sAudioSinkServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("microphone") != app.tauri.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call.invoke(), "onRecordAudioPermissionResult");
            return;
        }
        launchMediaProjectionConsent(call);
    }

    @app.tauri.annotation.PermissionCallback
    private void onRecordAudioPermissionResult(Invoke invoke) {
        LinkCall call = new LinkCall(invoke);
        if (getPermissionState("microphone") != app.tauri.PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Microphone permission denied");
            call.resolve(ret);
            return;
        }
        launchMediaProjectionConsent(call);
    }

    private void launchMediaProjectionConsent(LinkCall call) {
        android.media.projection.MediaProjectionManager mgr =
            (android.media.projection.MediaProjectionManager) getContext().getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE);
        android.content.Intent intent = mgr.createScreenCaptureIntent();
        startActivityForResult(call.invoke(), intent, "onMediaProjectionResult");
    }

    @app.tauri.annotation.ActivityCallback
    private void onMediaProjectionResult(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Audio capture permission was not granted");
            call.resolve(ret);
            return;
        }
        if (deviceManager == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Not initialized");
            call.resolve(ret);
            return;
        }
        try {
            android.media.projection.MediaProjectionManager mgr =
                (android.media.projection.MediaProjectionManager) getContext().getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE);
            android.media.projection.MediaProjection projection = mgr.getMediaProjection(result.getResultCode(), result.getData());

            LinkAudioSinkServer server = new LinkAudioSinkServer(
                getContext(), deviceManager.getMyCert(), deviceManager.getMyKey(), LinkTransport.AUDIO_RELAY_PORT,
                new LinkAudioSinkServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("audioSinkGuestPinPending", data);
                    }
                    @Override
                    public void onListenerJoined(String connId, String label) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("label", label);
                        notifyListeners("audioSinkListenerJoined", data);
                    }
                    @Override
                    public void onListenerLeft(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("audioSinkListenerLeft", data);
                    }
                    @Override
                    public void onError(String message) {
                        JSObject data = new JSObject();
                        data.put("message", message);
                        notifyListeners("audioSinkError", data);
                    }
                }, idOrIp -> LinkBlocklist.isBlocked(getContext(), idOrIp));
            server.start();

            // Revocation via the OS "Stop casting" notification-shade control must tear down
            // exactly like the explicit End Session path — otherwise the Host card would stay
            // stuck showing "hosting" with a capture that's actually already dead.
            projection.registerCallback(new android.media.projection.MediaProjection.Callback() {
                @Override
                public void onStop() {
                    JSObject data = new JSObject();
                    data.put("message", "Capture stopped by the system");
                    notifyListeners("audioSinkError", data);
                    stopAudioSinkHosting();
                }
            }, new android.os.Handler(android.os.Looper.getMainLooper()));

            server.startCapture(projection);
            sAudioSinkServer = server;

            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                String token = server.issueToken(peerId, getDeviceDisplayName(peerId));
                try {
                    JSONObject body = new JSONObject();
                    body.put("token", token);
                    body.put("port", LinkTransport.AUDIO_RELAY_PORT);
                    // No "host" — see handleAudioSinkQueryPacket.
                    deviceManager.sendTo(peerId, new LinkPacket("link.audiosink.started", body));
                } catch (Exception ignored) {}
            }

            updateSessionNotification();
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT);
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start Audio Relay hosting", e);
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    private void stopRemoteMicHosting() {
        if (sRemoteMicServer == null) return;
        if (deviceManager != null) {
            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                deviceManager.sendTo(peerId, new LinkPacket("link.remotemic.ended", new JSONObject()));
            }
        }
        try {
            sRemoteMicServer.stop();
        } catch (Exception e) {
            android.util.Log.e(TAG, "Error stopping RemoteMicServer", e);
        }
        sRemoteMicServer = null;
        updateSessionNotification();
    }

    @LinkMethod
    public void startRemoteMic(LinkCall call) {
        if (sRemoteMicServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("microphone") != app.tauri.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call.invoke(), "onRecordAudioPermissionResultMic");
            return;
        }
        launchRemoteMic(call);
    }

    @app.tauri.annotation.PermissionCallback
    private void onRecordAudioPermissionResultMic(Invoke invoke) {
        LinkCall call = new LinkCall(invoke);
        if (getPermissionState("microphone") != app.tauri.PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Microphone permission denied");
            call.resolve(ret);
            return;
        }
        launchRemoteMic(call);
    }

    private void launchRemoteMic(LinkCall call) {
        if (deviceManager == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Not initialized");
            call.resolve(ret);
            return;
        }
        try {
            LinkRemoteMicServer server = new LinkRemoteMicServer(
                getContext(), deviceManager.getMyCert(), deviceManager.getMyKey(), LinkTransport.AUDIO_RELAY_PORT + 2,
                new LinkRemoteMicServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("remoteMicGuestPinPending", data);
                    }
                    @Override
                    public void onListenerJoined(String connId, String label) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("label", label);
                        notifyListeners("remoteMicListenerJoined", data);
                    }
                    @Override
                    public void onListenerLeft(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("remoteMicListenerLeft", data);
                    }
                    @Override
                    public void onError(String message) {
                        JSObject data = new JSObject();
                        data.put("message", message);
                        notifyListeners("remoteMicError", data);
                    }
                }, idOrIp -> LinkBlocklist.isBlocked(getContext(), idOrIp));
            server.start();
            server.startCapture();
            sRemoteMicServer = server;

            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                String token = server.issueToken(peerId, getDeviceDisplayName(peerId));
                try {
                    JSONObject body = new JSONObject();
                    body.put("token", token);
                    body.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
                    deviceManager.sendTo(peerId, new LinkPacket("link.remotemic.started", body));
                } catch (Exception ignored) {}
            }

            updateSessionNotification();
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start Remote Mic hosting", e);
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    // Was missing entirely — RemoteMicTab.tsx's Mute Mic button calls
    // linkApi?.setRemoteMicMuted?.(next), which silently no-op'd on Android since neither this
    // plugin method nor a bridge.ts entry existed, even though LinkRemoteMicServer.setMuted()
    // itself was already fully implemented and working.
    @LinkMethod
    public void setRemoteMicMuted(LinkCall call) {
        Boolean muted = call.getBoolean("muted");
        if (sRemoteMicServer != null && muted != null) sRemoteMicServer.setMuted(muted);
        updateSessionNotification();
        call.resolve();
    }

    @LinkMethod
    public void acceptRemoteMicGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.acceptGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void rejectRemoteMicGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.rejectGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockRemoteMicGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) {
            String remoteAddress = sRemoteMicServer.getPendingGuestRemoteAddress(connId);
            if (remoteAddress != null) {
                blockUntrustedGuest(remoteAddress, sRemoteMicServer.getPendingGuestDeviceName(connId));
            }
            sRemoteMicServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void kickRemoteMicListener(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.kickListener(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockRemoteMicListener(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) {
            LinkRemoteMicServer.ListenerBlockInfo info = sRemoteMicServer.getListenerBlockInfo(connId);
            if (info != null) {
                if (info.deviceId != null) {
                    // Captures their current IP too (mirrors desktop's isBlocked fix) — without
                    // this, blocking a paired listener by deviceId wouldn't stop the same device
                    // from reconnecting as an untrusted-tool guest, which only ever checks by IP.
                    LinkBlocklist.add(getContext(), info.deviceId, getDeviceDisplayName(info.deviceId), "device", null, info.remoteAddress);
                } else {
                    blockUntrustedGuest(info.remoteAddress, null);
                }
            }
            sRemoteMicServer.kickListener(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void getRemoteMicListeners(LinkCall call) {
        JSObject ret = new JSObject();
        JSArray arr = new JSArray();
        if (sRemoteMicServer != null) {
            for (LinkRemoteMicServer.ListenerInfo l : sRemoteMicServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    // Was missing from the mobile bridge entirely — RemoteMicTab.tsx queries this on every mount
    // to restore "currently hosting" state (e.g. after the tab was closed and reopened), so
    // without it the UI always fell back to the fresh idle screen even mid-session. No "streaming"
    // field here — Android is never a Remote Mic listener (this device only ever hosts one), only
    // desktop's implementation has a listening role. Also includes the listeners snapshot (same
    // shape getRemoteMicListeners() returns) — without it, reopening the tab correctly restored
    // "hosting" but the "Connected Receivers" list came back empty even though the underlying
    // session (and its already-connected desktop listener) was still very much alive; the listener
    // list only ever got populated by onRemoteMicListenerJoined, which is a fresh subscription per
    // mount and has no memory of listeners that joined during a previous mount.
    @LinkMethod
    public void getRemoteMicStatus(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("hosting", sRemoteMicServer != null);
        JSArray arr = new JSArray();
        if (sRemoteMicServer != null) {
            for (LinkRemoteMicServer.ListenerInfo l : sRemoteMicServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    @LinkMethod
    public void endRemoteMic(LinkCall call) {
        stopRemoteMicHosting();
        call.resolve();
    }

    // ===== Remote Control =====
    @LinkMethod
    public void sendRemoteControlSignal(LinkCall call) {
        String deviceId = call.getString("deviceId");
        JSObject signalObj = call.getObject("signal");
        if (deviceId == null || signalObj == null || deviceManager == null) {
            call.reject("Missing arguments");
            return;
        }
        try {
            JSONObject body = new JSONObject(signalObj.toString());
            deviceManager.sendTo(deviceId, new LinkPacket("link.remotecontrol.signal", body));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @LinkMethod
    public void sendRemoteControlInput(LinkCall call) {
        String deviceId = call.getString("deviceId");
        JSObject inputObj = call.getObject("input");
        if (deviceId == null || inputObj == null || deviceManager == null) {
            call.reject("Missing arguments");
            return;
        }
        try {
            JSONObject body = new JSONObject(inputObj.toString());
            deviceManager.sendTo(deviceId, new LinkPacket("link.remotecontrol.input", body));
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

    @app.tauri.annotation.ActivityCallback
    private void onMediaProjectionResultRemoteControl(Invoke invoke, androidx.activity.result.ActivityResult result) {
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
                deviceManager
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

    @LinkMethod
    public void stopRemoteControlHost(LinkCall call) {
        android.util.Log.i(TAG, "stopRemoteControlHost called");
        if (sRemoteControlServer != null) {
            sRemoteControlServer.stop();
            sRemoteControlServer = null;
        }
        call.resolve();
    }

    // ===== Portal Mode (one-time file transfer to an untrusted/unpaired device) =====
    // Guest-only for v1, matching the actual ask — mirrors desktop's main.ts scoping exactly (see
    // that file's Portal Mode section comment). LinkPortalTransferServer/Client both already
    // support a paired-token fast path too, left unwired here rather than removed.

    /** Android's equivalent of Electron's dialog.showOpenDialog({multiSelections: true}) — no
     *  direct filesystem-path picker exists, so this launches the standard document picker
     *  (EXTRA_ALLOW_MULTIPLE) and hands back an array of content:// Uri strings for the renderer
     *  to pass straight back into joinPortalGuest(), which re-parses each via Uri.parse() before
     *  handing them off to LinkPortalTransferClient.sendFiles(). */
    @LinkMethod
    public void pickPortalFiles(LinkCall call) {
        android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        intent.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.setType("*/*");
        startActivityForResult(call.invoke(), intent, "onPortalFilesPicked");
    }

    @app.tauri.annotation.ActivityCallback
    private void onPortalFilesPicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject());
            return;
        }
        android.content.Intent data = result.getData();
        java.util.List<android.net.Uri> uris = new java.util.ArrayList<>();
        // EXTRA_ALLOW_MULTIPLE gives back a ClipData with one item per selected file when the user
        // picks more than one; picking exactly one file still comes back as a plain getData() Uri
        // instead (documented Android behavior, not a bug in this code).
        if (data.getClipData() != null) {
            android.content.ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                android.net.Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        // Persist read access across the app process — without this, the grant only lasts for the
        // immediate call and a later sendFiles() (e.g. after the user first entered the receiver's
        // IP, which can take a while) could fail with a SecurityException.
        JSArray uriStrings = new JSArray();
        for (android.net.Uri uri : uris) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}
            uriStrings.put(uri.toString());
        }
        JSObject ret = new JSObject();
        ret.put("uris", uriStrings);
        call.resolve(ret);
    }

    @LinkMethod
    public void startPortalReceive(LinkCall call) {
        if (sPortalTransferServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.PORTAL_TRANSFER_PORT);
            ret.put("saveDir", "Link");
            call.resolve(ret);
            return;
        }
        if (deviceManager == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Not initialized");
            call.resolve(ret);
            return;
        }
        try {
            LinkFileTransferServer server = new LinkFileTransferServer(
                getContext(), deviceManager.getMyCert(), deviceManager.getMyKey(), LinkTransport.PORTAL_TRANSFER_PORT,
                myIdentity != null ? myIdentity.deviceName : "Device",
                new LinkFileTransferServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("portalGuestPinPending", data);
                    }
                    @Override
                    public void onConnectionAdmitted(String connId, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("deviceName", deviceName);
                        notifyListeners("portalConnectionAdmitted", data);
                    }
                    @Override
                    public void onConnectionClosed(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("portalConnectionClosed", data);
                    }
                    @Override
                    public void onPeerFilesChanged(String connId, org.json.JSONArray files) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("files", files);
                        notifyListeners("portalPeerFilesChanged", data);
                    }
                    @Override
                    public void onTransferStarted(String connId, String name, long size) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("name", name);
                        data.put("size", size);
                        notifyListeners("portalTransferStarted", data);
                    }
                    @Override
                    public void onTransferProgress(String connId, long received, long size) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("received", received);
                        data.put("size", size);
                        notifyListeners("portalTransferProgress", data);
                    }
                    @Override
                    public void onTransferComplete(String connId, String destPath) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("destPath", destPath);
                        notifyListeners("portalTransferComplete", data);
                    }
                    @Override
                    public void onFileStarted(int fileIndex, int fileCount, String name) {
                        JSObject data = new JSObject();
                        data.put("fileIndex", fileIndex);
                        data.put("fileCount", fileCount);
                        data.put("name", name);
                        notifyListeners("portalFileStarted", data);
                    }
                    @Override
                    public void onSendProgress(long sent, long total) {
                        JSObject data = new JSObject();
                        data.put("sent", sent);
                        data.put("total", total);
                        notifyListeners("portalSendProgress", data);
                    }
                    @Override
                    public void onSendComplete() {
                        notifyListeners("portalSendComplete", new JSObject());
                    }
                    @Override
                    public void onError(String message) {
                        JSObject data = new JSObject();
                        data.put("message", message);
                        notifyListeners("portalError", data);
                    }
                }, idOrIp -> LinkBlocklist.isBlocked(getContext(), idOrIp));
            server.start();
            sPortalTransferServer = server;

            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.PORTAL_TRANSFER_PORT);
            ret.put("saveDir", "Link");
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start Portal receive", e);
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    @LinkMethod
    public void acceptPortalGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) sPortalTransferServer.acceptGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void rejectPortalGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) sPortalTransferServer.rejectGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockPortalGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) {
            String ip = sPortalTransferServer.getPendingGuestRemoteAddress(connId);
            String name = sPortalTransferServer.getPendingGuestDeviceName(connId);
            if (ip != null) blockUntrustedGuest(ip, name);
            sPortalTransferServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void endPortalReceive(LinkCall call) {
        if (sPortalTransferServer != null) {
            try { sPortalTransferServer.stop(); } catch (Exception ignored) {}
            sPortalTransferServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void joinPortalGuest(LinkCall call) {
        String host = call.getString("host");
        if (deviceManager == null) {
            call.resolve();
            return;
        }
        java.util.List<android.net.Uri> fileUris = portalUris(call.getData().optJSONArray("uris"));

        // If we are hosting the connection with an admitted client, update available downloads!
        if (sPortalTransferServer != null && sPortalTransferServer.getAdmittedConnectionIds().size() > 0) {
            if (fileUris.size() > 0) {
                sPortalTransferServer.setAvailableDownloads(getContext(), fileUris);
            }
            call.resolve();
            return;
        }

        if (sPortalTransferClient != null && sPortalTransferClient.isConnected()) {
            if (fileUris.size() > 0) {
                sPortalTransferClient.setAvailableDownloads(getContext(), fileUris);
            }
            call.resolve();
            return;
        }

        if (host == null) {
            call.resolve();
            return;
        }

        if (sPortalTransferClient != null) sPortalTransferClient.disconnect();
        LinkFileTransferClient client = new LinkFileTransferClient(getContext(), new LinkFileTransferClient.Listener() {
            @Override
            public void onPinComputed(String pin) {
                JSObject data = new JSObject();
                data.put("pin", pin);
                notifyListeners("portalPinComputed", data);
            }
            @Override
            public void onAdmitted(String receiverDeviceName) {
                JSObject admittedData = new JSObject();
                admittedData.put("deviceName", receiverDeviceName);
                notifyListeners("portalAdmitted", admittedData);
            }
            @Override
            public void onPeerFilesChanged(org.json.JSONArray files) {
                JSObject data = new JSObject();
                data.put("files", files);
                notifyListeners("portalPeerFilesChanged", data);
            }
            @Override
            public void onFileStarted(int fileIndex, int fileCount, String name) {
                JSObject data = new JSObject();
                data.put("fileIndex", fileIndex);
                data.put("fileCount", fileCount);
                data.put("name", name);
                notifyListeners("portalFileStarted", data);
            }
            @Override
            public void onProgress(long sent, long total) {
                JSObject data = new JSObject();
                data.put("sent", sent);
                data.put("total", total);
                notifyListeners("portalSendProgress", data);
            }
            @Override
            public void onComplete() {
                notifyListeners("portalSendComplete", new JSObject());
            }
            @Override
            public void onTransferStarted(String name, long size) {
                JSObject data = new JSObject();
                data.put("connId", "client-conn");
                data.put("name", name);
                data.put("size", size);
                notifyListeners("portalTransferStarted", data);
            }
            @Override
            public void onTransferProgress(long received, long size) {
                JSObject data = new JSObject();
                data.put("connId", "client-conn");
                data.put("received", received);
                data.put("size", size);
                notifyListeners("portalTransferProgress", data);
            }
            @Override
            public void onTransferComplete(String destPath) {
                JSObject data = new JSObject();
                data.put("connId", "client-conn");
                data.put("destPath", destPath);
                notifyListeners("portalTransferComplete", data);
            }
            @Override
            public void onEnded() {
                sPortalTransferClient = null;
                notifyListeners("portalEnded", new JSObject());
            }
            @Override
            public void onClosed(String reason) {
                sPortalTransferClient = null;
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("portalClosed", data);
            }
            @Override
            public void onError(String message) {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("portalError", data);
                sPortalTransferClient = null;
            }
        });
        sPortalTransferClient = client;
        client.connect(host, LinkTransport.PORTAL_TRANSFER_PORT, deviceManager.getMyCert(), deviceManager.getMyKey(), null, myIdentity != null ? myIdentity.deviceName : "Guest");
        call.resolve();
    }

    @LinkMethod
    public void leavePortalSend(LinkCall call) {
        if (sPortalTransferClient != null) {
            sPortalTransferClient.disconnect();
            sPortalTransferClient = null;
        }
        call.resolve();
    }

    /** Files the user staged, as the screen sends them: plain URI strings or {name, localPath}
     *  objects. Anything unreadable is skipped, and the count is logged so an empty announcement
     *  can be told apart from a list that never arrived. */
    private java.util.List<android.net.Uri> portalUris(org.json.JSONArray items) {
        java.util.List<android.net.Uri> uris = new java.util.ArrayList<>();
        int received = items != null ? items.length() : 0;
        for (int i = 0; i < received; i++) {
            Object item = items.opt(i);
            String raw = item instanceof org.json.JSONObject ? ((org.json.JSONObject) item).optString("localPath", "") : String.valueOf(item);
            if (raw != null && !raw.isEmpty() && !"null".equals(raw)) uris.add(android.net.Uri.parse(raw));
        }
        android.util.Log.i(TAG, "Portal downloads: " + uris.size() + " usable of " + received + " staged");
        return uris;
    }

    @LinkMethod
    public void setPortalDownloads(LinkCall call) {
        java.util.List<android.net.Uri> uris = portalUris(call.getData().optJSONArray("files"));
        if (sPortalTransferServer != null) {
            sPortalTransferServer.setAvailableDownloads(getContext(), uris);
        }
        if (sPortalTransferClient != null) {
            sPortalTransferClient.setAvailableDownloads(getContext(), uris);
        }
        call.resolve();
    }

    @LinkMethod
    public void requestPortalDownload(LinkCall call) {
        String fileId = call.getString("fileId");
        if (fileId != null) {
            if (sPortalTransferServer != null && sPortalTransferServer.getAdmittedConnectionIds().size() > 0) {
                String connId = sPortalTransferServer.getAdmittedConnectionIds().get(0);
                sPortalTransferServer.requestDownload(connId, fileId);
            } else if (sPortalTransferClient != null && sPortalTransferClient.isConnected()) {
                sPortalTransferClient.requestDownload(fileId);
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void getPortalStatus(LinkCall call) {
        JSObject ret = new JSObject();
        boolean isHost = sPortalTransferServer != null && sPortalTransferServer.hasConnectedPeers();
        boolean isGuest = sPortalTransferClient != null && sPortalTransferClient.isConnected();
        java.util.Map.Entry<String, String> hostPeer = isHost ? sPortalTransferServer.getConnectedPeer() : null;
        String guestPeerName = isGuest ? sPortalTransferClient.getPeerDeviceName() : null;

        ret.put("receiving", sPortalTransferServer != null);
        ret.put("sending", sPortalTransferClient != null);
        ret.put("connected", isHost || isGuest);
        ret.put("isHost", isHost);
        ret.put("peerName", isHost ? (hostPeer != null ? hostPeer.getValue() : "Peer") : (isGuest ? guestPeerName : null));
        ret.put("connId", isHost ? (hostPeer != null ? hostPeer.getKey() : null) : null);
        ret.put("transferring", sPortalTransferServer != null && sPortalTransferServer.hasActiveTransfer());
        call.resolve(ret);
    }

    /** Fallback for the hardware back button when no in-app view claims it (see MainActivity's
     *  onBackPressed() and the renderer's backNav.ts) — sends the app to background the same way
     *  the OS default back-at-root behavior would, without killing the process. */
    @LinkMethod
    public void minimizeApp(LinkCall call) {
        if (getActivity() != null) {
            getActivity().moveTaskToBack(true);
        }
        call.resolve();
    }

    /** token == null means the guest (PIN-confirmation) path; non-null means the already-paired
     *  fast path. Both end up on the exact same LinkAudioSinkClient/relay server — see that
     *  class's header comment. */
    private void startAudioSinkListener(String host, String token) {
        if (sAudioSinkClient != null) {
            sAudioSinkClient.disconnect();
        }
        sAudioSinkClient = new LinkAudioSinkClient(getContext(), new LinkAudioSinkClient.Listener() {
            @Override
            public void onPinComputed(String pin) {
                JSObject data = new JSObject();
                data.put("pin", pin);
                notifyListeners("audioSinkPinComputed", data);
            }

            @Override
            public void onAdmitted(String hostName) {
                sAudioSinkHostLabel = hostName != null ? hostName : "";
                updateSessionNotification();
                JSObject data = new JSObject();
                data.put("hostName", hostName);
                notifyListeners("audioSinkAdmitted", data);
            }

            @Override
            public void onFormat(int sampleRate, int channels, int bitsPerSample, boolean isFloat) {
                JSObject data = new JSObject();
                data.put("sampleRate", sampleRate);
                data.put("channels", channels);
                data.put("bitsPerSample", bitsPerSample);
                data.put("isFloat", isFloat);
                notifyListeners("audioSinkFormat", data);
            }

            @Override
            public void onHostMuted(boolean muted) {
                JSObject data = new JSObject();
                data.put("muted", muted);
                notifyListeners("audioSinkHostMuted", data);
            }

            @Override
            public void onEnded() {
                // Clearing sAudioSinkClient here (not just forwarding to JS) is what makes
                // getAudioSinkStatus report listening:false after a kick/host-end — otherwise the
                // socket is already dead but the static field still points at it, so reopening the
                // tool keeps showing "still connected" forever.
                sAudioSinkClient = null;
                sAudioSinkHostLabel = "";
                updateSessionNotification();
                notifyListeners("audioSinkEnded", new JSObject());
            }

            @Override
            public void onClosed(String reason) {
                sAudioSinkClient = null;
                sAudioSinkHostLabel = "";
                updateSessionNotification();
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("audioSinkClosed", data);
            }

            @Override
            public void onError(String message) {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("audioSinkError", data);
            }

            @Override
            public void onStats(long latencyMs, int bufferMs, int underruns, int dropped, boolean clockSynced) {
                JSObject data = new JSObject();
                data.put("latencyMs", latencyMs);
                data.put("bufferMs", bufferMs);
                data.put("underruns", underruns);
                data.put("dropped", dropped);
                data.put("clockSynced", clockSynced);
                notifyListeners("audioSinkStats", data);
            }
        });
        sAudioSinkClient.connect(host, LinkTransport.AUDIO_RELAY_PORT, deviceManager.getMyCert(), deviceManager.getMyKey(), token, myIdentity != null ? myIdentity.deviceName : "Guest");
    }

    @LinkMethod
    public void sendDndSet(LinkCall call) {
        String deviceId = call.getString("deviceId");
        boolean enabled = call.getBoolean("enabled", false);
        if (deviceManager != null && deviceId != null) {
            deviceManager.sendTo(deviceId, LinkDND.createCommandPacket(enabled));
        }
        call.resolve();
    }

    // Android's own Wi-Fi Hotspot (tethering) always brings its interface up on this subnet — a
    // long-standing AOSP default, distinct from Windows' own 192.168.137.x ICS default (see
    // desktop main.ts's WINDOWS_HOTSPOT_SUBNET_PREFIX for that side of the same class of bug).
    // Relevant here for the reverse direction: this phone hosting Audio Sink/Remote Mic/etc. while
    // ALSO connected to a Wi-Fi network — without preferring this subnet, a PC joined to the
    // phone's hotspot could get handed the phone's regular Wi-Fi address instead, which it has no
    // route to.
    private static final String ANDROID_HOTSPOT_SUBNET_PREFIX = "192.168.43.";

    /** Lower = prioritized as primary display / default bind.
     *  Tier 0: Physical Wi-Fi / WLAN adapters
     *  Tier 1: Hotspot / Tethering subnets
     *  Tier 2: Other LAN interfaces */
    private static int localIpPriority(String address, String ifaceNameLower) {
        if (ifaceNameLower.contains("wlan") || ifaceNameLower.contains("wifi") || ifaceNameLower.contains("eth")) return 0;
        if (address.startsWith(ANDROID_HOTSPOT_SUBNET_PREFIX)) return 1;
        return 2;
    }

    private java.util.List<String> getAllLocalIpAddresses() {
        java.util.List<String> ips = new java.util.ArrayList<>();
        try {
            java.util.List<java.net.NetworkInterface> interfaces = java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces());
            for (java.net.NetworkInterface intf : interfaces) {
                if (intf.isLoopback() || !intf.isUp()) continue;
                String lowerName = intf.getName() == null ? "" : intf.getName().toLowerCase();
                for (java.net.InetAddress addr : java.util.Collections.list(intf.getInetAddresses())) {
                    if (addr.isLoopbackAddress() || !(addr instanceof java.net.Inet4Address)) continue;
                    String ip = addr.getHostAddress();
                    if (ip != null && !ip.isEmpty() && !ips.contains(ip)) {
                        if (localIpPriority(ip, lowerName) <= 1) {
                            ips.add(0, ip); // high-priority wifi/hotspot first
                        } else {
                            ips.add(ip);
                        }
                    }
                }
            }
        } catch (Exception ex) {
            android.util.Log.e(TAG, "Error getting all IP addresses", ex);
        }
        if (ips.isEmpty()) {
            ips.add("127.0.0.1");
        }
        return ips;
    }

    private String getLocalIpAddress() {
        java.util.List<String> all = getAllLocalIpAddresses();
        return all.isEmpty() ? "127.0.0.1" : all.get(0);
    }

    @Override
    public void onDestroy(AppCompatActivity destroyedActivity) {
        // Discovery and the network watcher deliberately keep running: LinkForegroundService keeps
        // the process (and the TCP server) alive after the activity goes, and without them nothing
        // would redial a dropped connection until the app is opened again. A reattach in the same
        // process (see load()) replaces them.
        super.onDestroy(destroyedActivity);
    }

    @LinkMethod
    public void getDiscoveredDevices(LinkCall call) {
        JSArray arr = new JSArray();
        for (JSObject obj : sDiscoveredPeers.values()) {
            arr.put(obj);
        }
        JSObject ret = new JSObject();
        ret.put("devices", arr);
        call.resolve(ret);
    }

    @LinkMethod
    public void getIdentity(LinkCall call) {
        JSObject data = new JSObject();
        data.put("deviceId", myIdentity.deviceId);
        data.put("deviceName", myIdentity.deviceName);
        data.put("deviceType", myIdentity.deviceType);
        java.util.List<String> allIps = getAllLocalIpAddresses();
        data.put("ipAddress", allIps.isEmpty() ? "127.0.0.1" : allIps.get(0));
        JSArray arr = new JSArray();
        for (String ip : allIps) {
            arr.put(ip);
        }
        data.put("ipAddresses", arr);
        call.resolve(data);
    }

    @LinkMethod
    public void getVisibility(LinkCall call) {
        if (settings == null) settings = new LinkSettings(getContext());
        settings.load();
        JSObject data = new JSObject();
        data.put("enabled", settings.discoveryVisibility);
        call.resolve(data);
    }

    @LinkMethod
    public void setVisibility(LinkCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        if (settings == null) settings = new LinkSettings(getContext());
        settings.saveDiscoveryVisibility(enabled);
        // visibilityEnabled only controls whether this device BROADCASTS its identity over UDP.
        // It does NOT affect receiving — we still listen for and connect to peers that broadcast
        // to us. This makes the toggle mean "am I visible to others" not "can I see others".
        LinkDiscovery.Watcher watcher = discoveryWatcher != null ? discoveryWatcher : sDiscoveryWatcher;
        if (watcher != null) {
            watcher.setVisibility(enabled);
        }

        // Proactively disconnect untrusted peers the instant visibility goes off, rather than
        // passively waiting up to ~9-12s for each peer's own discovery-expiry timeout to notice
        // the silence — see main.ts's set-visibility handler for the full reasoning (mirrors it
        // exactly). Trusted/paired devices are left connected; pool membership is unaffected.
        if (!enabled && deviceManager != null) {
            for (LinkDeviceManager.ConnectedPeerInfo info : deviceManager.connectedPeers()) {
                if (!info.trusted) {
                    deviceManager.closeConnection(info.identity.deviceId);
                }
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void connectTo(LinkCall call) {
        String host = call.getString("host");
        Integer portVal = call.getInt("port");
        int port = (portVal == null || portVal == 0) ? LinkTransport.LINK_PORT : portVal;

        if ("127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host)) {
            call.reject("A device cannot connect to itself.");
            return;
        }

        try {
            java.util.List<java.net.NetworkInterface> interfaces = java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces());
            for (java.net.NetworkInterface intf : interfaces) {
                java.util.List<java.net.InetAddress> addrs = java.util.Collections.list(intf.getInetAddresses());
                for (java.net.InetAddress addr : addrs) {
                    if (addr.getHostAddress().equals(host)) {
                        call.reject("A device cannot connect to itself.");
                        return;
                    }
                }
            }
        } catch (Exception ignored) {}

        try {
            deviceManager.connectTo(host, port);
            call.resolve();
        } catch (Exception e) {
            call.reject("Connect failed: " + e.getMessage());
        }
    }

    @LinkMethod
    public void requestPairing(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String pin = deviceManager.requestPairing(deviceId);
        if (pin != null) {
            JSObject ret = new JSObject();
            ret.put("verificationKey", pin);
            call.resolve(ret);
            return;
        }

        // Came back null — expected for a device that only exists in the "Nearby Discovered
        // Devices" list: those are announced purely from UDP discovery broadcasts and
        // deliberately never auto-connected over TCP (see discoveryWatcher above — auto-connect
        // only fires for already-PAIRED devices), so there's no live connection yet for
        // requestPairing() to compute a verification PIN against. Connect now using the IP we
        // already know from discovery, then wait for the identity handshake to actually finish —
        // connectTo() returns as soon as the raw TLS handshake completes, BEFORE identity packets
        // are exchanged, so calling requestPairing() again immediately after would still race and
        // come back null a second time.
        JSObject discovered = sDiscoveredPeers.get(deviceId);
        String ip = discovered != null ? discovered.getString("ipAddress") : null;
        if (ip == null) {
            JSObject ret = new JSObject();
            ret.put("verificationKey", (Object) null);
            call.resolve(ret);
            return;
        }

        // @LinkMethod calls already run off the main/UI thread (see connectTo() above, which
        // already blocks on deviceManager.connectTo() directly) — no separate thread needed here.
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        sPendingConnectWaits.put(deviceId, latch);
        boolean connected = false;
        try {
            deviceManager.connectTo(ip, LinkTransport.LINK_PORT);
            connected = latch.await(10, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to connect before pairing", e);
            sPendingConnectWaits.remove(deviceId);
        }

        JSObject ret = new JSObject();
        ret.put("verificationKey", connected ? deviceManager.requestPairing(deviceId) : null);
        call.resolve(ret);
    }

    @LinkMethod
    public void requestPairingByIp(LinkCall call) {
        String ipListStr = call.getString("ip");
        if (ipListStr == null) {
            JSObject ret = new JSObject();
            ret.put("pin", (Object) null);
            call.resolve(ret);
            return;
        }

        String[] ips = ipListStr.split(",");
        for (int i = 0; i < ips.length; i++) {
            ips[i] = ips[i].trim();
        }

        // Try existing device ID check for any of the IPs first
        for (String singleIp : ips) {
            String existingDeviceId = deviceManager.anyDeviceIdForAddress(singleIp);
            if (existingDeviceId != null) {
                JSObject ret = new JSObject();
                ret.put("pin", deviceManager.requestPairing(existingDeviceId));
                ret.put("deviceId", existingDeviceId);
                call.resolve(ret);
                return;
            }
        }

        final PendingIpWait ipWait = new PendingIpWait();
        for (String singleIp : ips) {
            sPendingIpConnectWaits.put(singleIp, ipWait);
        }

        boolean connected = false;
        try {
            for (final String singleIp : ips) {
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            deviceManager.connectTo(singleIp, LinkTransport.LINK_PORT);
                        } catch (Exception e) {
                            android.util.Log.e(TAG, "Failed to connect to " + singleIp + " before pairing", e);
                            sPendingIpConnectWaits.remove(singleIp);
                        }
                    }
                }).start();
            }
            connected = ipWait.latch.await(10, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to connect before pairing by IP list", e);
        } finally {
            for (String singleIp : ips) {
                sPendingIpConnectWaits.remove(singleIp);
            }
        }

        JSObject ret = new JSObject();
        if (connected && ipWait.resolvedDeviceId != null) {
            ret.put("pin", deviceManager.requestPairing(ipWait.resolvedDeviceId));
            ret.put("deviceId", ipWait.resolvedDeviceId);
        } else {
            ret.put("pin", (Object) null);
        }
        call.resolve(ret);
    }

    @LinkMethod
    public void acceptPairing(LinkCall call) {
        deviceManager.acceptPairing(call.getString("deviceId"));
        call.resolve();
    }

    @LinkMethod
    public void cancelPairing(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceManager != null && deviceId != null) {
            deviceManager.cancelPairing(deviceId);
        }
        call.resolve();
    }

    @LinkMethod
    public void rejectPairing(LinkCall call) {
        String deviceId = call.getString("deviceId");
        deviceManager.rejectPairing(deviceId);
        Boolean shouldBlock = call.getBoolean("shouldBlock");
        if (Boolean.TRUE.equals(shouldBlock) && deviceId != null) {
            String deviceName = call.getString("deviceName");
            String label = deviceName != null ? deviceName : (deviceId.length() >= 8 ? deviceId.substring(0, 8) : deviceId);
            // Captures their current IP too (see LinkBlocklist.isBlocked's cross-check) — without
            // this, blocking them by deviceId wouldn't stop the same device from reconnecting as
            // an untrusted-tool guest, which only ever checks by IP.
            String ip = deviceManager != null ? deviceManager.remoteAddressOf(deviceId) : null;
            LinkBlocklist.add(getContext(), deviceId, label, "device", call.getString("deviceType"), ip);
        }
        call.resolve();
    }

    @LinkMethod
    public void getBlocklist(LinkCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("entries", new JSArray(LinkBlocklist.getAll(getContext()).toString()));
        } catch (Exception ignored) {}
        call.resolve(ret);
    }

    @LinkMethod
    public void blockDevice(LinkCall call) {
        String id = call.getString("id");
        String label = call.getString("label");
        String type = call.getString("type");
        if (id != null) {
            // Captures their current IP too (see LinkBlocklist.isBlocked's cross-check) — without
            // this, blocking a device by deviceId wouldn't stop it from reconnecting as an
            // untrusted-tool guest, which only ever checks by IP. Mirrors desktop's block-device.
            String ip = "device".equals(type) && deviceManager != null ? deviceManager.remoteAddressOf(id) : null;
            LinkBlocklist.add(getContext(), id, label != null ? label : id, type != null ? type : "device", null, ip);
            if ("device".equals(type) && deviceManager != null) {
                deviceManager.closeConnection(id);
            }
        }
        getBlocklist(call);
    }

    @LinkMethod
    public void unblockDevice(LinkCall call) {
        String id = call.getString("id");
        if (id != null) LinkBlocklist.remove(getContext(), id);
        getBlocklist(call);
    }

    @LinkMethod
    public void unpair(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceManager != null && deviceId != null) {
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("deviceId", deviceId);
                LinkPacket packet = new LinkPacket("link.pool.remove", body);
                for (String otherId : deviceManager.trustedConnectedDeviceIds()) {
                    if (!otherId.equals(deviceId)) {
                        deviceManager.sendTo(otherId, packet);
                    }
                }
            } catch (Exception ignored) {}
            deviceManager.unpair(deviceId);
        }
        call.resolve();
    }

    @LinkMethod
    public void exitPool(LinkCall call) {
        if (deviceManager != null) {
            LinkTrustStore store = new LinkTrustStore(getContext());
            for (LinkTrustStore.TrustedDevice d : store.list()) {
                deviceManager.unpair(d.deviceId);
            }
        }
        call.resolve();
    }


    @LinkMethod
    public void getTrustedDevices(LinkCall call) {
        try {
            LinkTrustStore store = new LinkTrustStore(getContext());
            JSArray arr = new JSArray();
            for (LinkTrustStore.TrustedDevice d : store.list()) {
                JSObject obj = new JSObject();
                obj.put("deviceId", d.deviceId);
                obj.put("deviceName", d.deviceName);
                if (d.lastKnownIp != null) obj.put("ipAddress", d.lastKnownIp);
                obj.put("deviceType", "desktop"); // default assume desktop, updated dynamically on connect
                obj.put("trusted", true);
                obj.put("connected", false);
                arr.put(obj);
            }
            JSObject result = new JSObject();
            result.put("devices", arr);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to list trusted devices: " + e.getMessage());
        }
    }

    // Re-runs the full initial-sync push for every currently-connected trusted peer.
    // sendInitialSync() only ever fires once, at the moment a TCP connection is established — a
    // WebView reload wipes all that data from the UI's in-memory state without the connection
    // itself dropping, so nothing re-populates it until some unrelated future change happens to
    // broadcast again. Calling this on JS mount closes that gap. Mirrors desktop's resync-devices
    // IPC handler in main.ts.
    @LinkMethod
    public void resyncDevices(LinkCall call) {
        if (trustedReconnectRunnable != null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).post(trustedReconnectRunnable);
        }
        if (deviceManager != null) {
            for (String deviceId : deviceManager.trustedConnectedDeviceIds()) {
                // Push OUR state to the peer...
                sendInitialSync(deviceId);
                // ...and PULL theirs: ask the peer to re-push its full state so a reload repopulates
                // its battery/volume/MPRIS/connectivity sections in one round-trip instead of
                // trickling in over ~10s. Peer answers via its 'link.resync.request' handler.
                try {
                    deviceManager.sendTo(deviceId, new LinkPacket("link.resync.request", new org.json.JSONObject()));
                } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    // Real, file-backed per-device permissions — see LinkDevicePermissions for why this didn't
    // exist natively before (every toggle was decorative, backed only by WebView localStorage).
    @LinkMethod
    public void getPermissions(LinkCall call) {
        JSObject result = new JSObject();
        try {
            result = new JSObject(LinkDevicePermissions.getAll(getContext()).toString());
        } catch (Exception ignored) {}
        call.resolve(result);
    }

    @LinkMethod
    public void setPermissions(LinkCall call) {
        org.json.JSONObject newPermissions = call.getData();
        org.json.JSONObject oldPermissions = LinkDevicePermissions.getAll(getContext());
        LinkDevicePermissions.setAll(getContext(), newPermissions);

        // Push the peer's updated effective-capabilities list first — this alone is what drives
        // visibility (see LinkCapabilities): the renderer hides a section the instant a key is
        // absent from this list, regardless of any stale value it still has cached from before.
        // No per-plugin "revoked" marker needed anymore. Separately, still push a fresh REAL state
        // snapshot when systemvolume/mpris/flashlight/dnd just flipped ON — sendInitialSync only
        // ever runs once at connection time, so without this a peer granted access mid-session
        // would see the section appear but empty until some unrelated future state change
        // happened to broadcast again.
        // Mirrors desktop's set-permissions IPC handler in main.ts, including the same default-
        // allowed semantics as LinkDevicePermissions.check() (unset means allowed, so "was/now
        // allowed" must be a !=false test, not optBoolean(..., false)).
        if (deviceManager != null) {
            java.util.Iterator<String> keys = newPermissions.keys();
            while (keys.hasNext()) {
                String deviceId = keys.next();
                if (!deviceManager.trustedConnectedDeviceIds().contains(deviceId)) continue;
                org.json.JSONObject oldPerm = oldPermissions.optJSONObject(deviceId);
                org.json.JSONObject newPerm = newPermissions.optJSONObject(deviceId);
                if (newPerm == null) continue;

                deviceManager.sendTo(deviceId, LinkCapabilities.createCapabilitiesPacket(getContext(), deviceId));

                boolean volumeWasAllowed = oldPerm == null || oldPerm.optBoolean("systemvolume", true);
                boolean volumeNowAllowed = newPerm.optBoolean("systemvolume", true);
                if (volumeNowAllowed && !volumeWasAllowed) {
                    android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
                    deviceManager.sendTo(deviceId, LinkSystemVolume.createLocalSinksPacket(audio));
                }

                boolean mprisWasAllowed = oldPerm == null || oldPerm.optBoolean("mpris", true);
                boolean mprisNowAllowed = newPerm.optBoolean("mpris", true);
                if (mprisNowAllowed && !mprisWasAllowed) {
                    deviceManager.sendTo(deviceId, LinkMpris.createLocalStatePacket(getContext()));
                }

                boolean flashlightWasAllowed = oldPerm == null || oldPerm.optBoolean("flashlight", true);
                boolean flashlightNowAllowed = newPerm.optBoolean("flashlight", true);
                if (flashlightNowAllowed && !flashlightWasAllowed) {
                    deviceManager.sendTo(deviceId, LinkFlashlight.createStatusPacket(LinkFlashlight.isTorchOn()));
                }

                boolean dndWasAllowed = oldPerm == null || oldPerm.optBoolean("dnd", true);
                boolean dndNowAllowed = newPerm.optBoolean("dnd", true);
                if (dndNowAllowed && !dndWasAllowed) {
                    deviceManager.sendTo(deviceId, LinkDND.createStatusPacket(getContext()));
                }
            }
        }

        call.resolve();
    }

    // Real current connection state — see LinkDeviceManager.connectedPeers()'s comment for why
    // the JS layer needs this in addition to getTrustedDevices() (which always reports
    // connected:false).
    @LinkMethod
    public void getConnectedDevices(LinkCall call) {
        try {
            JSArray arr = new JSArray();
            if (deviceManager != null) {
                LinkTrustStore store = new LinkTrustStore(getContext());
                for (LinkDeviceManager.ConnectedPeerInfo info : deviceManager.connectedPeers()) {
                    JSObject obj = new JSObject();
                    obj.put("deviceId", info.identity.deviceId);
                    LinkTrustStore.TrustedDevice trustedDev = store.get(info.identity.deviceId);
                    String name = (trustedDev != null && trustedDev.deviceName != null) ? trustedDev.deviceName : info.identity.deviceName;
                    obj.put("deviceName", name);
                    String remoteIp = deviceManager.remoteAddressOf(info.identity.deviceId);
                    if (remoteIp != null) obj.put("ipAddress", remoteIp);
                    obj.put("deviceType", info.identity.deviceType);
                    obj.put("protocolVersion", info.identity.protocolVersion);
                    obj.put("incomingCapabilities", new JSArray(info.identity.incomingCapabilities));
                    obj.put("outgoingCapabilities", new JSArray(info.identity.outgoingCapabilities));
                    // Re-hydrate the peer's effective caps from cache so a WebView reload restores
                    // gated-plugin visibility without waiting for the peer to re-push.
                    org.json.JSONArray cachedCaps = peerCapabilities.get(info.identity.deviceId);
                    obj.put("allowedCapabilities", cachedCaps != null ? cachedCaps : new org.json.JSONArray());
                    obj.put("trusted", info.trusted);
                    arr.put(obj);
                }
            }
            JSObject result = new JSObject();
            result.put("devices", arr);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to list connected devices: " + e.getMessage());
        }
    }

    @LinkMethod
    public void renameTrustedDevice(LinkCall call) {
        // Device names are self-owned — send the peer a REQUEST rather than editing our local
        // alias directly. The peer applies it to itself and broadcasts the authoritative result
        // back (handled by the "link.rename" branch above), which is what actually updates our
        // trust store. This only works while the peer is reachable; there is no queued/offline
        // rename. Mirrors desktop's rename-trusted-device IPC handler in main.ts.
        String deviceId = call.getString("deviceId");
        String name = call.getString("name");
        if (deviceId == null || name == null) {
            call.reject("Missing deviceId or name");
            return;
        }
        if (deviceManager == null || !deviceManager.trustedConnectedDeviceIds().contains(deviceId)) {
            call.reject("Device must be connected to be renamed");
            return;
        }
        try {
            org.json.JSONObject body = new org.json.JSONObject();
            body.put("deviceName", name);
            deviceManager.sendTo(deviceId, new LinkPacket("link.rename.request", body));
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to send rename request: " + e.getMessage());
        }
    }

    @LinkMethod
    public void sendFindMyDevice(LinkCall call) {
        String deviceId = call.getString("deviceId");
        deviceManager.sendTo(deviceId, LinkFindMyDevice.createPacket());
        call.resolve();
    }

    @LinkMethod
    public void sendFindMyPhone(LinkCall call) {
        sendFindMyDevice(call);
    }

    @LinkMethod
    public void stopFindMyDevice(LinkCall call) {
        LinkFindMyDevice.stopRinging(getContext());
        String deviceId = call.getString("deviceId");
        if (deviceId == null) {
            deviceId = activeRingerDeviceId;
        }
        if (deviceId != null) {
            deviceManager.sendTo(deviceId, LinkFindMyDevice.createPacket(true));
            JSObject data = new JSObject();
            data.put("deviceId", deviceId);
            notifyListeners("findMyPhoneStopped", data);
            notifyListeners("findMyDeviceStopped", data);
            activeRingerDeviceId = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void stopFindMyPhone(LinkCall call) {
        stopFindMyDevice(call);
    }

    @LinkMethod
    public void triggerCommand(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String key = call.getString("key");
        deviceManager.sendTo(deviceId, LinkRunCommand.createTriggerPacket(key));
        call.resolve();
    }



    // Manual test hooks for the telephony/pausemusic path — the real telephonyReceiver above
    // reacts to a genuine android.intent.action.PHONE_STATE broadcast, which is a
    // system-protected broadcast that even `adb shell am broadcast` can't send
    // (SecurityException: not allowed to send broadcast ... from a shell uid). These reuse the
    // exact same LinkTelephony packet builders and deviceManager.sendTo() path, just triggered by
    // a button tap instead of a real call, to verify the desktop's reaction without needing an
    // actual second phone to call this device.


    @LinkMethod
    public void sendRemoteInput(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String text = call.getString("text");
        String specialKey = call.getString("specialKey");
        if (deviceManager != null && deviceId != null) {
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                if (text != null) body.put("text", text);
                if (specialKey != null) body.put("specialKey", specialKey);
                deviceManager.sendTo(deviceId, new LinkPacket(LinkRemoteInput.PACKET_TYPE_REMOTEINPUT_SEND, body));
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to send remote input packet", e);
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void sendPresenterMove(LinkCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "pmove " + dx + " " + dy);
        call.resolve();
    }

    // Presenter/digitizer "Switch Screen" — cycle which monitor the peer targets for the absolute-
    // positioned features. Sent over TCP (reliable) since it's a rare control action, not a
    // high-rate move; the desktop handles it in main.ts's packet router (link.target.display).
    @LinkMethod
    public void cycleTargetDisplay(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceManager != null && deviceId != null) {
            try {
                deviceManager.sendTo(deviceId, new LinkPacket("link.target.display", new org.json.JSONObject()));
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @LinkMethod
    public void checkOverlayPermission(LinkCall call) {
        JSObject data = new JSObject();
        data.put("enabled", LinkPresenterOverlay.isPermissionGranted(getContext()));
        call.resolve(data);
    }

    @LinkMethod
    public void requestOverlayPermission(LinkCall call) {
        LinkPresenterOverlay.requestPermission(getContext());
        call.resolve();
    }

    @LinkMethod
    public void sendSetVolume(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String sinkName = call.getString("name", "default");
        int volume = call.getInt("volume", 0);
        deviceManager.sendTo(deviceId, LinkSystemVolume.createSetVolumePacket(sinkName, volume));
        call.resolve();
    }

    @LinkMethod
    public void sendSetMute(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String sinkName = call.getString("name", "default");
        boolean muted = call.getBoolean("muted", false);
        deviceManager.sendTo(deviceId, LinkSystemVolume.createSetMutePacket(sinkName, muted));
        call.resolve();
    }

    @LinkMethod
    public void sendPresenterStop(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceId != null) {
            deviceManager.sendTo(deviceId, LinkPresenter.createStopPacket());
            sendUdpMessage(deviceId, "pstop");
        }
        call.resolve();
    }

    @LinkMethod
    public void sendLockRequest(LinkCall call) {
        String deviceId = call.getString("deviceId");
        boolean setLocked = call.getBoolean("setLocked", true);
        deviceManager.sendTo(deviceId, LinkLock.createLockRequestPacket(setLocked, null));
        call.resolve();
    }

    @LinkMethod
    public void sendLockQuery(LinkCall call) {
        String deviceId = call.getString("deviceId");
        deviceManager.sendTo(deviceId, LinkLock.createLockRequestPacket(null, true));
        call.resolve();
    }

    @LinkMethod
    public void checkNotificationAccess(LinkCall call) {
        boolean enabled = androidx.core.app.NotificationManagerCompat
                .getEnabledListenerPackages(getContext())
                .contains(getContext().getPackageName());
        JSObject data = new JSObject();
        data.put("enabled", enabled);
        call.resolve(data);
    }

    @LinkMethod
    public void requestNotificationAccess(LinkCall call) {
        try {
            android.content.Intent intent = new android.content.Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open notification settings: " + e.getMessage());
        }
    }

    // MANAGE_EXTERNAL_STORAGE ("All files access") — needed to see real files via plain
    // java.io.File on Android 11+ (scoped storage otherwise silently returns empty listings for
    // anything outside the app's own sandbox/media collections). Kept around for the future
    // file-system protocol rebuild (see docs/backlog.txt) even though nothing currently consumes
    // it. This isn't a normal runtime permission the plugin's checkPermissions/requestPermissions
    // can grant — it only has a user-facing toggle in a dedicated Settings screen, same pattern
    // as notification access above.
    @LinkMethod
    public void checkAllFilesAccess(LinkCall call) {
        boolean enabled = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R
                || android.os.Environment.isExternalStorageManager();
        JSObject data = new JSObject();
        data.put("enabled", enabled);
        call.resolve(data);
    }

    @LinkMethod
    public void checkDndAccess(LinkCall call) {
        boolean granted = LinkDND.isDndGranted(getContext());
        JSObject data = new JSObject();
        data.put("granted", granted);
        call.resolve(data);
    }

    @LinkMethod
    public void requestAllFilesAccess(LinkCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                android.content.Intent fallback = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Failed to open all-files-access settings: " + e2.getMessage());
            }
        }
    }

    @LinkMethod
    public void requestDndAccess(LinkCall call) {
        // Open the Do Not Disturb access permission page in settings
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open DND settings: " + e.getMessage());
        }
    }

    @LinkMethod
    public void openAppSettings(LinkCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            android.net.Uri uri = android.net.Uri.fromParts("package", getContext().getPackageName(), null);
            intent.setData(uri);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open app settings: " + e.getMessage());
        }
    }

    @LinkMethod
    public void sendMouseMove(LinkCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "move " + dx + " " + dy);
        call.resolve();
    }

    @LinkMethod
    public void sendSpecialKey(LinkCall call) {
        String deviceId = call.getString("deviceId");
        int specialKey = call.getInt("specialKey", 0);
        sendUdpMessage(deviceId, "special " + specialKey);
        call.resolve();
    }

    @LinkMethod
    public void sendMouseClick(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String clickType = call.getString("clickType", "left");
        sendUdpMessage(deviceId, "click " + clickType);
        call.resolve();
    }

    @LinkMethod
    public void sendMouseDrag(LinkCall call) {
        String deviceId = call.getString("deviceId");
        boolean hold = call.getBoolean("hold", false);
        sendUdpMessage(deviceId, hold ? "hold left" : "release left");
        call.resolve();
    }

    @LinkMethod
    public void sendMouseScroll(LinkCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "scroll " + dx + " " + dy);
        call.resolve();
    }

    @LinkMethod
    public void sendMprisAction(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String player = call.getString("player", "Global Media Control");
        String action = call.getString("action");
        deviceManager.sendTo(deviceId, LinkMpris.createActionPacket(player, action));
        call.resolve();
    }

    @LinkMethod
    public void renameDevice(LinkCall call) {
        String newName = call.getString("name");
        String applied = LinkIdentity.saveDeviceName(getContext(), newName);
        try {
            myIdentity = LinkIdentity.loadOrCreate(getContext(), LinkCapabilitiesSchema.CAPABILITIES, LinkCapabilitiesSchema.CAPABILITIES);
            if (deviceManager != null) {
                deviceManager.updateMyIdentity(myIdentity);
            }
            if (discoveryWatcher != null) {
                discoveryWatcher.updateLocalIdentity(myIdentity);
            }
            if (sDiscoveryWatcher != null) {
                sDiscoveryWatcher.updateLocalIdentity(myIdentity);
            }
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to reload identity in renameDevice", e);
        }
        // Broadcast our new authoritative name to every currently-connected peer so their view
        // of us updates live instead of waiting for their next reconnect/handshake. Not gated by
        // the test.txt kill-switch — rename is inherently available on any valid connection.
        if (deviceManager != null) {
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("deviceName", applied);
                LinkPacket renamePacket = new LinkPacket("link.rename", body);
                for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                    deviceManager.sendTo(peerId, renamePacket);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to broadcast own rename", e);
            }
        }
        JSObject data = new JSObject();
        data.put("name", applied);
        call.resolve(data);
    }

    @LinkMethod
    public void sendDigitizerSession(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String action = call.getString("action");
        if (deviceManager != null && deviceId != null) {
            if ("start".equals(action)) {
                int width = call.getInt("width", 0);
                int height = call.getInt("height", 0);
                int resolutionX = call.getInt("resolutionX", 100);
                int resolutionY = call.getInt("resolutionY", 100);
                deviceManager.sendTo(deviceId, LinkDigitizer.createSessionStart(width, height, resolutionX, resolutionY));
            } else {
                deviceManager.sendTo(deviceId, LinkDigitizer.createSessionEnd());
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void sendDigitizerEvent(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceId != null) {
            Integer x = call.getInt("x");
            Integer yVal = call.getInt("y");
            Boolean touching = call.getBoolean("touching", false);
            sendUdpMessage(deviceId, "dig " + (x != null ? x : 0) + " " + (yVal != null ? yVal : 0) + " " + touching);
        }
        call.resolve();
    }

    /** Digitizer toolbar undo/redo — sends the bare "undo"/"redo" line over the same fast UDP
     *  input relay the pen events use; the desktop maps it to Ctrl+Z / Ctrl+Y. */
    @LinkMethod
    public void sendDigitizerAction(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String action = call.getString("action");
        if (deviceId != null && ("undo".equals(action) || "redo".equals(action))) {
            sendUdpMessage(deviceId, action);
        }
        call.resolve();
    }

    /** Join request — Joystick has no pairing/permission step at all (see LinkPlugin's CAPABILITIES
     *  comment and desktop's joystick.ts header comment), so this just fires the raw "hello <name>"
     *  UDP line directly at whatever IP the user scanned/typed (UntrustedConnectUI), same trust
     *  model as joining an Audio Sink guest session. The reply ("hello-ack ...") arrives async via
     *  the joystickHelloAck listener, through startInputUdpServer's receive loop below. */
    @LinkMethod
    public void sendJoystickHello(LinkCall call) {
        String host = call.getString("host");
        String name = call.getString("name", "Controller");
        if (host != null) {
            if (sJoystickClient != null) sJoystickClient.disconnect();
            sJoystickClient = new LinkJoystickClient(new LinkJoystickClient.Listener() {
                @Override
                public void onPinComputed(String pin) {
                    JSObject data = new JSObject();
                    data.put("pin", pin);
                    notifyListeners("joystickPinRequired", data);
                }

                @Override
                public void onAdmitted(int padIndex) {
                    LinkJoystickClient admittedClient = sJoystickClient;
                    if (admittedClient != null && admittedClient.getResolvedHost() != null) {
                        sUdpHostOverrides.put(host, admittedClient.getResolvedHost());
                    }
                    JSObject data = new JSObject();
                    data.put("ok", true);
                    data.put("padIndex", padIndex);
                    notifyListeners("joystickHelloAck", data);
                }

                @Override
                public void onRumble(int large, int small) {
                    vibrateNative(getContext(), Math.max(large, small), 100);
                }

                @Override
                public void onPing() {
                    notifyListeners("joystickPing", new JSObject());
                }

                @Override
                public void onClosed(String reason) {
                    JSObject data = new JSObject();
                    data.put("ok", false);
                    data.put("error", reason);
                    notifyListeners("joystickHelloAck", data);
                    notifyListeners("joystickForcedDisconnect", new JSObject().put("reason", reason));
                }

                @Override
                public void onError(String message) {
                    JSObject data = new JSObject();
                    data.put("ok", false);
                    data.put("error", message);
                    notifyListeners("joystickHelloAck", data);
                }
            });
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), myIdentity != null ? myIdentity.deviceId : "device");
            sJoystickClient.connect(host, LinkTransport.JOYSTICK_PORT, name, tls.certificate, tls.privateKey);
        }
        call.resolve();
    }

    @LinkMethod
    public void sendJoystickBye(LinkCall call) {
        if (sJoystickClient != null) {
            sJoystickClient.disconnect();
            sJoystickClient = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void startJoystickHost(LinkCall call) {
        if (sJoystickServer != null) {
            call.resolve();
            return;
        }
        try {
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), myIdentity != null ? myIdentity.deviceId : "device");
            sJoystickServer = new LinkJoystickServer(getContext(), LinkTransport.JOYSTICK_PORT, tls.certificate, tls.privateKey, new LinkJoystickServer.Listener() {
                @Override
                public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                    JSObject data = new JSObject();
                    data.put("connId", connId);
                    data.put("pin", pin);
                    data.put("remoteAddress", remoteAddress);
                    data.put("name", deviceName);
                    notifyListeners("joystickGuestPinPending", data);
                }

                @Override
                public void onControllerJoined(String remoteAddress, String deviceName, int padIndex) {
                    notifyListeners("joystickRosterChanged", new JSObject());
                }

                @Override
                public void onControllerLeft(String remoteAddress) {
                    notifyListeners("joystickRosterChanged", new JSObject());
                }

                @Override
                public void onDriverStatusChanged(String status, String error) {
                    JSObject data = new JSObject();
                    data.put("status", status);
                    data.put("error", error);
                    notifyListeners("joystickDriverStatus", data);
                }

                @Override
                public void onError(String message) {
                    android.util.Log.e(TAG, "JoystickServer error: " + message);
                }
            });
            sJoystickServer.start();
            call.resolve();
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start JoystickServer", e);
            call.reject("Failed to start Joystick host: " + e.getMessage());
        }
    }

    @LinkMethod
    public void stopJoystickHost(LinkCall call) {
        if (sJoystickServer != null) {
            sJoystickServer.stopServer();
            sJoystickServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void getJoystickStatus(LinkCall call) {
        JSObject ret = new JSObject();
        boolean hosting = sJoystickServer != null;
        ret.put("hosting", hosting);

        JSArray controllers = new JSArray();
        if (sJoystickServer != null) {
            for (LinkJoystickServer.ControllerInfo ci : sJoystickServer.getConnectedControllers()) {
                JSObject c = new JSObject();
                c.put("ip", ci.ip);
                c.put("name", ci.name);
                c.put("padIndex", ci.padIndex);
                controllers.put(c);
            }
            LinkUinputGamepad driver = sJoystickServer.getGamepadDriver();
            boolean shizukuReady = driver != null && driver.hasShizukuPermission();
            boolean shizukuRunning = driver != null && driver.isShizukuAvailable();
            ret.put("driverStatus", shizukuReady ? "ready" : "missing");
            ret.put("driverError", shizukuReady ? null : (shizukuRunning ? "permission_needed" : "shizuku_not_running"));
        } else {
            ret.put("driverStatus", "unknown");
            ret.put("driverError", null);
        }
        ret.put("connectedControllers", controllers);
        call.resolve(ret);
    }

    @LinkMethod
    public void checkJoystickDriver(LinkCall call) {
        JSObject ret = new JSObject();
        LinkUinputGamepad driver = sJoystickServer != null ? sJoystickServer.getGamepadDriver() : new LinkUinputGamepad(getContext(), null);
        boolean shizukuReady = driver.hasShizukuPermission();
        boolean shizukuRunning = driver.isShizukuAvailable();
        ret.put("driverStatus", shizukuReady ? "ready" : "missing");
        ret.put("driverError", shizukuReady ? null : (shizukuRunning ? "permission_needed" : "shizuku_not_running"));
        call.resolve(ret);
    }

    @LinkMethod
    public void requestShizukuPermission(LinkCall call) {
        LinkUinputGamepad driver = sJoystickServer != null ? sJoystickServer.getGamepadDriver() : new LinkUinputGamepad(getContext(), null);
        driver.requestShizukuPermission(1748);
        call.resolve();
    }

    @LinkMethod
    public void acceptJoystickGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sJoystickServer != null && connId != null) {
            sJoystickServer.acceptGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void rejectJoystickGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sJoystickServer != null && connId != null) {
            sJoystickServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void blockJoystickGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sJoystickServer != null && connId != null) {
            sJoystickServer.blockGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void kickJoystickController(LinkCall call) {
        String ip = call.getString("ip");
        if (sJoystickServer != null && ip != null) {
            sJoystickServer.kickController(ip, "removed by host");
        }
        call.resolve();
    }

    @LinkMethod
    public void joinInputGuest(LinkCall call) {
        String host = call.getString("host");
        String name = call.getString("name", myIdentity != null && myIdentity.deviceName != null ? myIdentity.deviceName : "Phone Remote");
        String mode = call.getString("mode", "touchpad");
        if (host != null) {
            if (sInputGuestClient != null) sInputGuestClient.disconnect();
            sInputGuestClient = new LinkInputGuestClient(new LinkInputGuestClient.Listener() {
                @Override
                public void onPinComputed(String pin) {
                    JSObject data = new JSObject();
                    data.put("pin", pin);
                    notifyListeners("inputGuestPinRequired", data);
                }

                @Override
                public void onAdmitted(String admittedMode, String resolvedHost, String hostDeviceType) {
                    JSObject data = new JSObject();
                    data.put("ok", true);
                    data.put("mode", admittedMode);
                    if (resolvedHost != null) data.put("host", resolvedHost);
                    if (hostDeviceType != null) data.put("hostDeviceType", hostDeviceType);
                    notifyListeners("inputGuestAdmitted", data);
                }

                @Override
                public void onMessage(String json) {
                    JSObject data = new JSObject();
                    data.put("message", json);
                    notifyListeners("inputGuestMessage", data);
                }

                @Override
                public void onClosed(String reason) {
                    JSObject data = new JSObject();
                    data.put("ok", false);
                    data.put("error", reason);
                    notifyListeners("inputGuestClosed", data);
                }

                @Override
                public void onError(String message) {
                    JSObject data = new JSObject();
                    data.put("ok", false);
                    data.put("error", message);
                    notifyListeners("inputGuestError", data);
                }
            });
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), myIdentity != null ? myIdentity.deviceId : "device");
            sInputGuestClient.connect(host, LinkTransport.INPUT_GUEST_PORT, name, mode, tls.certificate, tls.privateKey);
        }
        call.resolve();
    }

    @LinkMethod
    public void startInputGuestHost(LinkCall call) {
        if (sInputGuestServer != null) {
            call.resolve();
            return;
        }
        try {
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), myIdentity != null ? myIdentity.deviceId : "device");
            sInputGuestServer = new LinkInputGuestServer(getContext(), LinkTransport.INPUT_GUEST_PORT, tls.certificate, tls.privateKey, myIdentity != null ? myIdentity.deviceType : "phone", new LinkInputGuestServer.Listener() {
                // Guards against resolving/rejecting `call` more than once — onStarted()/onError()
                // fire exactly once for the start attempt itself, but onError() can ALSO fire
                // later for an unrelated per-connection problem on an already-running server, by
                // which point this call has long since been resolved.
                private boolean startResultSent = false;

                @Override
                public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName, String mode) {
                    JSObject data = new JSObject();
                    data.put("connId", connId);
                    data.put("pin", pin);
                    data.put("remoteAddress", remoteAddress);
                    data.put("name", deviceName);
                    data.put("mode", mode);
                    notifyListeners("inputGuestPinPending", data);
                }

                @Override
                public void onGuestJoined(String remoteAddress, String deviceName, String mode) {
                    if ("remotecontrol".equals(mode) && deviceManager != null) {
                        // The screen-share code addresses its viewer by device id; a guest gets a
                        // stand-in id whose packets travel over the socket it joined on.
                        deviceManager.registerVirtualPeer(LinkRemoteControlServer.GUEST_PREFIX + remoteAddress, packet -> {
                            LinkInputGuestServer server = sInputGuestServer;
                            if (server != null) server.sendPacket(remoteAddress, packet);
                        });
                    }
                    notifyListeners("inputGuestRosterChanged", new JSObject());
                }

                @Override
                public void onGuestLeft(String remoteAddress) {
                    String guestId = LinkRemoteControlServer.GUEST_PREFIX + remoteAddress;
                    if (deviceManager != null) deviceManager.unregisterVirtualPeer(guestId);
                    // The guest was the viewer: stop sharing the screen with nobody.
                    if (sRemoteControlServer != null && guestId.equals(sRemoteControlServer.getTargetDeviceId())) {
                        sRemoteControlServer.stop();
                        sRemoteControlServer = null;
                    }
                    notifyListeners("inputGuestRosterChanged", new JSObject());
                }

                @Override
                public void onGuestPacket(String remoteAddress, String packetType, String bodyJson) {
                    String guestId = LinkRemoteControlServer.GUEST_PREFIX + remoteAddress;
                    try {
                        LinkPacket packet = new LinkPacket(packetType, new org.json.JSONObject(bodyJson));
                        if ("link.remotecontrol.signal".equals(packetType)) {
                            handleRemoteControlSignalPacket(guestId, packet);
                        } else if ("link.remotecontrol.input".equals(packetType)) {
                            handleRemoteControlInputPacket(guestId, packet);
                        }
                    } catch (Exception e) {
                        android.util.Log.w(TAG, "Bad packet from remote control guest " + remoteAddress, e);
                    }
                }

                @Override
                public void onStarted() {
                    if (!startResultSent) {
                        startResultSent = true;
                        call.resolve();
                    }
                }

                @Override
                public void onError(String message) {
                    android.util.Log.e(TAG, "InputGuestServer error: " + message);
                    if (!startResultSent) {
                        startResultSent = true;
                        // The bind itself failed — sInputGuestServer is not actually usable, so
                        // clear it (matching the catch block below) rather than leaving a dead
                        // reference that would make every future call here think it's running.
                        sInputGuestServer = null;
                        call.reject("Failed to start Input Guest server: " + message);
                    }
                }
            });
            sInputGuestServer.start();
        } catch (Exception e) {
            sInputGuestServer = null;
            android.util.Log.e(TAG, "Failed to start InputGuestServer", e);
            call.reject("Failed to start Input Guest server: " + e.getMessage());
        }
    }

    @LinkMethod
    public void stopInputGuestHost(LinkCall call) {
        if (sInputGuestServer != null) {
            sInputGuestServer.stopServer();
            sInputGuestServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void getInputGuestStatus(LinkCall call) {
        JSObject ret = new JSObject();
        boolean hosting = sInputGuestServer != null;
        ret.put("hosting", hosting);

        JSArray guests = new JSArray();
        if (sInputGuestServer != null) {
            for (LinkInputGuestServer.GuestInfo gi : sInputGuestServer.getAdmittedGuests()) {
                JSObject g = new JSObject();
                g.put("ip", gi.ip);
                g.put("name", gi.name);
                g.put("mode", gi.mode);
                guests.put(g);
            }
        }
        ret.put("admittedGuests", guests);

        // A paired device controlling this screen through its device panel has no guest socket;
        // the screen share itself is the session.
        JSArray pairedSessions = new JSArray();
        LinkRemoteControlServer sharing = sRemoteControlServer;
        String viewerId = sharing != null && sharing.isRunning() ? sharing.getTargetDeviceId() : null;
        if (viewerId != null && !viewerId.startsWith(LinkRemoteControlServer.GUEST_PREFIX)) {
            LinkTrustStore.TrustedDevice viewer = deviceManager != null ? deviceManager.getTrustStore().get(viewerId) : null;
            JSObject session = new JSObject();
            session.put("deviceId", viewerId);
            session.put("name", viewer != null ? viewer.deviceName : viewerId);
            session.put("mode", "remotecontrol");
            pairedSessions.put(session);
        }
        ret.put("pairedSessions", pairedSessions);
        call.resolve(ret);
    }

    @LinkMethod
    public void acceptInputGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sInputGuestServer != null && connId != null) {
            sInputGuestServer.acceptGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void rejectInputGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sInputGuestServer != null && connId != null) {
            sInputGuestServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void blockInputGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sInputGuestServer != null && connId != null) {
            sInputGuestServer.blockGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void kickInputGuest(LinkCall call) {
        String ip = call.getString("ip");
        if (sInputGuestServer != null && ip != null) {
            sInputGuestServer.kickGuest(ip);
        }
        // The argument is a device id when the session belongs to a paired device.
        if (ip != null && sRemoteControlServer != null && ip.equals(sRemoteControlServer.getTargetDeviceId())) {
            sRemoteControlServer.stop("ended");
            sRemoteControlServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void sendInputGuestMessage(LinkCall call) {
        String message = call.getString("message");
        if (sInputGuestClient != null && message != null) sInputGuestClient.send(message);
        call.resolve();
    }

    @LinkMethod
    public void leaveInputGuest(LinkCall call) {
        if (sInputGuestClient != null) {
            sInputGuestClient.disconnect();
            sInputGuestClient = null;
        }
        call.resolve();
    }

    /** High-frequency (~60Hz) stick/button/trigger state — raw UDP, no TLS envelope, addressed
     *  directly to `host` (not a paired deviceId — see sendJoystickHello above). See joystick.ts
     *  for the desktop-side parser and the exact "js lx ly rx ry lt rt buttons" field layout. */
    @LinkMethod
    public void sendJoystickState(LinkCall call) {
        String host = call.getString("host");
        if (host == null) { call.resolve(); return; }
        int lx = call.getInt("lx", 0);
        int ly = call.getInt("ly", 0);
        int rx = call.getInt("rx", 0);
        int ry = call.getInt("ry", 0);
        int lt = call.getInt("lt", 0);
        int rt = call.getInt("rt", 0);
        int buttons = call.getInt("buttons", 0);
        sendUdpMessageToHost(host, "js " + lx + " " + ly + " " + rx + " " + ry + " " + lt + " " + rt + " " + buttons);
        call.resolve();
    }

    /** Local haptic pulse — used for the rumble-from-PC receive path (startInputUdpServer's
     *  "rumble " branch, which fires from a background socket thread with no pending LinkCall
     *  to resolve) and for JoystickOverlay.tsx's local button-press tap feedback. */
    @LinkMethod
    public void vibrate(LinkCall call) {
        int amplitude = call.getInt("amplitude", 128);
        long durationMs = call.getInt("durationMs", 100);
        vibrateNative(getContext(), amplitude, durationMs);
        call.resolve();
    }

    static void vibrateNative(android.content.Context context, int amplitude, long durationMs) {
        android.os.Vibrator vibrator = (android.os.Vibrator) context.getSystemService(android.content.Context.VIBRATOR_SERVICE);
        if (vibrator == null || !vibrator.hasVibrator()) return;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            int clampedAmplitude = Math.max(1, Math.min(255, amplitude));
            vibrator.vibrate(android.os.VibrationEffect.createOneShot(durationMs, clampedAmplitude));
        } else {
            vibrator.vibrate(durationMs);
        }
    }

    private void replyToNotification(String replyId, String message) {
        LinkRepliableNotification rn = pendingReplies.remove(replyId);
        if (rn == null) return;

        android.content.Intent localIntent = new android.content.Intent();
        localIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        android.os.Bundle localBundle = new android.os.Bundle();
        for (android.app.RemoteInput remoteInput : rn.remoteInputs) {
            localBundle.putCharSequence(remoteInput.getResultKey(), message);
        }
        android.app.RemoteInput.addResultsToIntent(rn.remoteInputs, localIntent, localBundle);
        try {
            rn.pendingIntent.send(getContext(), 0, localIntent);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to reply to notification", e);
        }
    }

    @LinkMethod
    public void isBatteryOptimizationIgnored(LinkCall call) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
            boolean isIgnoring = pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            JSObject ret = new JSObject();
            ret.put("isIgnoring", isIgnoring);
            call.resolve(ret);
        } else {
            JSObject ret = new JSObject();
            ret.put("isIgnoring", true);
            call.resolve(ret);
        }
    }

    @LinkMethod
    public void requestIgnoreBatteryOptimizations(LinkCall call) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
            try {
                if (!pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
                    android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);

                    try {
                        getContext().startActivity(intent);
                    } catch (android.content.ActivityNotFoundException e) {
                        // Fallback to general settings list
                        android.content.Intent fallback = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                        fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(fallback);
                    }
                } else {
                    // Revoking or viewing: open the battery optimization settings list (doesn't take data)
                    android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        getContext().startActivity(intent);
                    } catch (android.content.ActivityNotFoundException e) {
                        android.content.Intent fallback = new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        fallback.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                        fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(fallback);
                    }
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to launch battery optimization settings", e);
            }
        }
        call.resolve();
    }

    // Remote Input's D-pad/keyboard (LinkRemoteInput/LinkAccessibilityService) needs the
    // accessibility service enabled — there is no runtime-permission dialog for this, and no API
    // for an app to silently turn on its own accessibility service (by design, for security). The
    // only thing an app can do is open the system Accessibility settings screen and ask the user
    // to find and enable it themselves.
    @LinkMethod
    public void checkAccessibility(LinkCall call) {
        boolean enabled = false;
        try {
            String enabledServices = android.provider.Settings.Secure.getString(
                getContext().getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            String myService = getContext().getPackageName() + "/" + LinkAccessibilityService.class.getName();
            enabled = enabledServices != null && enabledServices.contains(myService);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to check accessibility service state", e);
        }
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @LinkMethod
    public void requestAccessibility(LinkCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to launch accessibility settings", e);
        }
        call.resolve();
    }

    @LinkMethod
    public void setImmersiveMode(LinkCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                try {
                    android.view.Window window = getActivity().getWindow();
                    if (window != null) {
                        androidx.core.view.WindowInsetsControllerCompat controller =
                            androidx.core.view.WindowCompat.getInsetsController(window, window.getDecorView());
                        if (controller != null) {
                            if (enabled) {
                                controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
                                controller.setSystemBarsBehavior(
                                    androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                                );
                            } else {
                                controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars());
                            }
                        }
                    }
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Failed to set immersive mode: " + e.getMessage());
                }
            });
        }
        call.resolve();
    }

    // Remote Control's fullscreen mirror needs EVERY touch — including ones starting at a screen
    // edge — to reach the WebView and get forwarded to the mirrored device, not get intercepted
    // by this phone's own edge-swipe back gesture. setImmersiveMode above hides the system bars
    // but Android's gesture nav still claims edge swipes independently of that; excluding the
    // whole decor view from system gesture handling is the documented way to give an app real
    // control over edge touches (same technique games/drawing apps use). Only applied while this
    // one fullscreen surface is active — cleared on unmount — so it doesn't affect the rest of
    // the app's normal back-gesture navigation.
    @LinkMethod
    public void setSystemGestureExclusion(LinkCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (getActivity() != null && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            getActivity().runOnUiThread(() -> {
                try {
                    android.view.View decorView = getActivity().getWindow().getDecorView();
                    if (enabled) {
                        decorView.post(() -> {
                            java.util.List<android.graphics.Rect> rects = new java.util.ArrayList<>();
                            rects.add(new android.graphics.Rect(0, 0, decorView.getWidth(), decorView.getHeight()));
                            decorView.setSystemGestureExclusionRects(rects);
                        });
                    } else {
                        decorView.setSystemGestureExclusionRects(java.util.Collections.emptyList());
                    }
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Failed to set system gesture exclusion: " + e.getMessage());
                }
            });
        }
        call.resolve();
    }

    @LinkMethod
    public void runSpeedTest(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceId == null) {
            call.reject("Missing deviceId");
            return;
        }

        if (speedTest == null) {
            call.reject("Speed test manager not initialized");
            return;
        }

        speedTest.startTest(deviceId, new LinkSpeedTest.Listener() {
            @Override
            public void onProgress(String message) {
                JSObject data = new JSObject();
                data.put("deviceId", deviceId);
                data.put("message", message);
                notifyListeners("speedTestProgress", data);
            }

            @Override
            public void onComplete(int latencyMs, double uploadSpeedMbps, double downloadSpeedMbps) {
                JSObject result = new JSObject();
                result.put("latencyMs", latencyMs);
                result.put("uploadSpeedMbps", Math.round(uploadSpeedMbps * 10) / 10.0);
                result.put("downloadSpeedMbps", Math.round(downloadSpeedMbps * 10) / 10.0);
                call.resolve(result);
            }

            @Override
            public void onError(String error) {
                call.reject(error);
            }
        });
    }

    /**
     * Builds the persistent "Link is active" notification. Shared with LinkForegroundService,
     * which posts this exact same NOTIFICATION_ID/CHANNEL_ID via startForeground() — reusing the
     * ID means the service's foreground notification and this plugin's notification are the
     * same notification, not a duplicate.
     */
    static android.app.Notification buildActiveNotification(android.content.Context context) {
        android.app.NotificationManager notificationManager = (android.app.NotificationManager) context.getSystemService(android.content.Context.NOTIFICATION_SERVICE);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            android.app.NotificationChannel channel = new android.app.NotificationChannel(
                CHANNEL_ID,
                "Link Active Status",
                android.app.NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows persistent status for Link connectivity");
            notificationManager.createNotificationChannel(channel);
        }

        // Launches the invisible LinkSendClipboard rather than firing a plain broadcast.
        // Android 10+ denies clipboard reads to apps not currently in focus, and a broadcast
        // receiver fired by tapping a notification action never counts as "in focus" — confirmed
        // via logcat: the receiver DID fire, but ClipboardManager.getPrimaryClip() came back
        // denied ("application is not in focus"). A no-UI Activity briefly puts the app in focus,
        // which satisfies that check; see LinkSendClipboard for the read/send/finish logic.
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

        android.app.Notification.Builder builder;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            builder = new android.app.Notification.Builder(context, CHANNEL_ID);
        } else {
            builder = new android.app.Notification.Builder(context);
        }

        builder.setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Link is active")
            .setContentText("Tap Send Clipboard to copy to connected devices")
            .setOngoing(true)
            .setDeleteIntent(deletePendingIntent);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            android.app.Notification.Action action = new android.app.Notification.Action.Builder(
                android.graphics.drawable.Icon.createWithResource(context, android.R.drawable.ic_menu_send),
                "Send Clipboard",
                sendPendingIntent
            ).build();
            builder.addAction(action);
        } else {
            builder.addAction(android.R.drawable.ic_menu_send, "Send Clipboard", sendPendingIntent);
        }

        return builder.build();
    }

    private void showActiveNotification() {
        android.content.Context context = getContext();
        android.app.NotificationManager notificationManager = (android.app.NotificationManager) context.getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        notificationManager.notify(NOTIFICATION_ID, buildActiveNotification(context));
    }

    /** Posts/updates/cancels the active-session notification. Must be called from every place a
     *  session's state can change: start/end/mute of Audio Relay hosting, Audio Relay listening,
     *  and Remote Mic hosting — see the call sites next to each of those. Rebuilding the whole
     *  notification on every change (rather than trying to patch it in place) is simplest and
     *  cheap; NotificationManager.notify() with the same ID just replaces it. Cancels outright
     *  when no session is active, since "no session" for a normally-ongoing notification would
     *  otherwise leave a stale one sitting in the shade forever. */
    void updateSessionNotification() {
        android.content.Context context = getContext();
        if (context == null) return;
        android.app.NotificationManager notificationManager =
            (android.app.NotificationManager) context.getSystemService(android.content.Context.NOTIFICATION_SERVICE);

        String kind = null;
        String title = null;
        boolean muted = false;
        if (sAudioSinkServer != null) {
            kind = SESSION_KIND_AUDIOSINK_HOST;
            title = "Hosting Audio Relay";
            muted = sAudioSinkServer.isMuted();
        } else if (sAudioSinkClient != null) {
            kind = SESSION_KIND_AUDIOSINK_LISTEN;
            title = "Listening to Audio Relay";
            muted = sAudioSinkClient.isLocallyMuted();
        } else if (sRemoteMicServer != null) {
            kind = SESSION_KIND_REMOTEMIC_HOST;
            title = "Hosting Remote Mic";
            muted = sRemoteMicServer.isMuted();
        }

        if (kind == null) {
            notificationManager.cancel(SESSION_NOTIFICATION_ID);
            return;
        }

        boolean isHost = !SESSION_KIND_AUDIOSINK_LISTEN.equals(kind);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            android.app.NotificationChannel channel = new android.app.NotificationChannel(
                SESSION_CHANNEL_ID,
                "Active Audio Session",
                android.app.NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows controls for an active Audio Relay or Remote Mic session");
            notificationManager.createNotificationChannel(channel);
        }

        android.content.Intent muteIntent = new android.content.Intent(ACTION_SESSION_MUTE_TOGGLE);
        muteIntent.setPackage(context.getPackageName());
        muteIntent.putExtra(EXTRA_SESSION_KIND, kind);
        android.app.PendingIntent mutePendingIntent = android.app.PendingIntent.getBroadcast(
            context, 1, muteIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
        );

        android.content.Intent endIntent = new android.content.Intent(ACTION_SESSION_END);
        endIntent.setPackage(context.getPackageName());
        endIntent.putExtra(EXTRA_SESSION_KIND, kind);
        android.app.PendingIntent endPendingIntent = android.app.PendingIntent.getBroadcast(
            context, 2, endIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
        );

        android.app.Notification.Builder builder;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            builder = new android.app.Notification.Builder(context, SESSION_CHANNEL_ID);
        } else {
            builder = new android.app.Notification.Builder(context);
        }

        builder.setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(muted ? "Muted" : "Live")
            .setOngoing(true);

        String muteLabel = muted ? "Unmute" : "Mute";
        String endLabel = isHost ? "End Session" : "Disconnect";

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            builder.addAction(new android.app.Notification.Action.Builder(
                android.graphics.drawable.Icon.createWithResource(context, muted ? android.R.drawable.ic_lock_silent_mode_off : android.R.drawable.ic_lock_silent_mode),
                muteLabel, mutePendingIntent
            ).build());
            builder.addAction(new android.app.Notification.Action.Builder(
                android.graphics.drawable.Icon.createWithResource(context, android.R.drawable.ic_menu_close_clear_cancel),
                endLabel, endPendingIntent
            ).build());
        } else {
            builder.addAction(0, muteLabel, mutePendingIntent);
            builder.addAction(0, endLabel, endPendingIntent);
        }

        notificationManager.notify(SESSION_NOTIFICATION_ID, builder.build());
    }

    private static java.net.DatagramSocket sInputUdpSocket;

    // Receiving half of the high-speed raw UDP input relay (port 1717) — mirrors desktop
    // main.ts's inputUdpSocket listener. Only "pmove"/"pstop" (presenter) are handled here;
    // touchpad/digitizer stay desktop-target-only for now (see PLUGIN_REGISTRY comment on
    // desktop's DeviceControlPanel.tsx). Sender is identified by source IP against the trusted+
    // connected peer list, same trust boundary as the TCP session packets (no envelope/deviceId
    // of its own, so this can't just reuse the TLS-authenticated onPacket path).
    private void startInputUdpServer() {
        new Thread(() -> {
            try {
                java.net.DatagramSocket socket = new java.net.DatagramSocket(null);
                socket.setReuseAddress(true);
                socket.bind(new java.net.InetSocketAddress(java.net.InetAddress.getByName("0.0.0.0"), 1717));
                sInputUdpSocket = socket;
                android.util.Log.i(TAG, "High-speed UDP Input Relay listening on port 1717");
                byte[] buf = new byte[1024];
                while (sInputUdpSocket != null && !sInputUdpSocket.isClosed()) {
                    java.net.DatagramPacket packet = new java.net.DatagramPacket(buf, buf.length);
                    sInputUdpSocket.receive(packet);
                    String senderIp = packet.getAddress().getHostAddress();
                    String line = new String(packet.getData(), 0, packet.getLength(), "UTF-8").trim();

                    // Joystick replies (from whatever PC we sent "hello"/"js ..." to) are handled
                    // BEFORE the paired-device senderId gate below — Joystick has no pairing step
                    // at all, deliberately (see desktop's joystick.ts header comment), so the PC on
                    // the other end is never expected to be a known/paired device.
                    if (line.startsWith("hello-ack ")) {
                        String[] parts = line.split(" ");
                        JSObject data = new JSObject();
                        if (parts.length >= 3 && "pin".equals(parts[1])) {
                            data.put("pin", parts[2]);
                            notifyListeners("joystickPinRequired", data);
                        } else {
                            boolean ok = parts.length >= 2 && "ok".equals(parts[1]);
                            data.put("ok", ok);
                            data.put("padIndex", ok && parts.length >= 3 ? Integer.parseInt(parts[2]) : null);
                            data.put("error", !ok && parts.length >= 3 ? parts[2] : null);
                            notifyListeners("joystickHelloAck", data);
                        }
                        continue;
                    } else if (line.startsWith("rumble ")) {
                        // Counts as proof the host is alive, exactly like an explicit "ping" — any
                        // inbound joystick traffic proves the link is up, and during heavy rumble
                        // these are far more frequent than the heartbeat.
                        notifyListeners("joystickPing", new JSObject());
                        String[] parts = line.split(" ");
                        int large = Integer.parseInt(parts[1]);
                        int small = Integer.parseInt(parts[2]);
                        // "Vibrate until told otherwise": ViGEm's force-feedback events represent a
                        // held motor state (e.g. sustained engine rumble), not discrete pulses — a
                        // fixed-duration pulse per packet would make continuous rumble stutter. A
                        // long-duration one-shot plus an explicit cancel() on the all-zero
                        // "motors off" packet approximates "sustained until changed" on Android,
                        // which has no true indefinite-vibrate primitive.
                        if (large == 0 && small == 0) {
                            android.os.Vibrator vibrator = (android.os.Vibrator) getContext().getSystemService(android.content.Context.VIBRATOR_SERVICE);
                            if (vibrator != null) vibrator.cancel();
                        } else {
                            int amplitude = Math.max(large, small);
                            vibrateNative(getContext(), amplitude, 60000);
                        }
                        continue;
                    } else if (line.equals("ping")) {
                        // Heartbeat — see desktop's joystick.ts header comment. JoystickOverlay.tsx
                        // tracks how long it's been since the last one and closes itself if the host
                        // goes quiet for too long (a real network drop, which neither side otherwise
                        // finds out about over UDP).
                        notifyListeners("joystickPing", new JSObject());
                        continue;
                    } else if (line.startsWith("bye ")) {
                        // Forced disconnect — the host deliberately dropped us (kicked/blocked) or
                        // its driver crashed. Unlike the heartbeat above, this closes the overlay
                        // immediately rather than waiting out the timeout.
                        JSObject data = new JSObject();
                        data.put("reason", line.substring(4));
                        notifyListeners("joystickForcedDisconnect", data);
                        continue;
                    } else if (line.startsWith("js ")) {
                        // High-speed UDP Joystick report arriving at Android Host
                        if (sJoystickServer != null) {
                            String[] parts = line.split(" ");
                            if (parts.length >= 8) {
                                int lx = Integer.parseInt(parts[1]);
                                int ly = Integer.parseInt(parts[2]);
                                int rx = Integer.parseInt(parts[3]);
                                int ry = Integer.parseInt(parts[4]);
                                int lt = Integer.parseInt(parts[5]);
                                int rt = Integer.parseInt(parts[6]);
                                int buttons = Integer.parseInt(parts[7]);
                                sJoystickServer.handleUdpJoystickReport(senderIp, lx, ly, rx, ry, lt, rt, buttons);
                            }
                        }
                        continue;
                    }

                    String senderId = deviceManager != null ? deviceManager.deviceIdForAddress(senderIp) : null;
                    boolean isPresenterAllowed = (senderId != null && LinkDevicePermissions.check(getContext(), senderId, "presenter"))
                            || (sInputGuestServer != null && sInputGuestServer.isAdmitted(senderIp, "presenter"));
                    boolean isRemoteInputAllowed = (senderId != null && LinkDevicePermissions.check(getContext(), senderId, "remoteinput"))
                            || (sInputGuestServer != null && sInputGuestServer.isAdmitted(senderIp, "touchpad"));

                    if (line.startsWith("pmove ")) {
                        if (!isPresenterAllowed) continue;
                        String[] parts = line.split(" ");
                        double dx = Double.parseDouble(parts[1]);
                        double dy = Double.parseDouble(parts[2]);

                        if (LinkPresenterOverlay.isPermissionGranted(getContext())) {
                            // True system-level overlay — draws over whatever app is currently in
                            // the foreground (slides, PDF viewer, etc.), not just this app's WebView.
                            android.util.DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
                            double aspectRatio = (double) dm.widthPixels / dm.heightPixels;
                            LinkPresenterOverlay.updatePosition(getContext(), dx, dy, aspectRatio);
                        } else {
                            // Fallback: in-app-only dot (PresenterDotOverlay.tsx) — only visible
                            // while Link itself is the foreground app.
                            JSObject data = new JSObject();
                            data.put("deviceId", senderId != null ? senderId : senderIp);
                            data.put("dx", dx);
                            data.put("dy", dy);
                            notifyListeners("presenterPositionReceived", data);
                        }
                    } else if (line.equals("pstop")) {
                        if (!isPresenterAllowed) continue;
                        LinkPresenterOverlay.hide(true);
                        JSObject data = new JSObject();
                        data.put("deviceId", senderId != null ? senderId : senderIp);
                        data.put("stop", true);
                        notifyListeners("presenterPositionReceived", data);
                    } else if (line.startsWith("special ")) {
                        if (!isPresenterAllowed && !isRemoteInputAllowed) continue;
                        String[] parts = line.split(" ");
                        int key = Integer.parseInt(parts[1]);
                        LinkRemoteInput.injectSpecialKey(getContext(), key);
                    } else if (line.startsWith("dig ")) {
                        if (!isRemoteInputAllowed) continue;
                        String[] parts = line.split(" ");
                        int x = Integer.parseInt(parts[1]);
                        int y = Integer.parseInt(parts[2]);
                        boolean touching = Boolean.parseBoolean(parts[3]);
                        injectDigitizerEvent(x, y, touching);
                    }
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "UDP Input Relay error", e);
            }
        }, "udp-input-listener").start();
    }

    private synchronized java.net.DatagramSocket getOrCreateOutboundSocket() {
        if (outboundUdpSocket == null || outboundUdpSocket.isClosed()) {
            try {
                outboundUdpSocket = new java.net.DatagramSocket();
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to create outbound UDP socket", e);
            }
        }
        return outboundUdpSocket;
    }

    private void sendUdpMessage(String deviceId, String message) {
        if (deviceId == null) return;
        String ip = deviceManager != null ? deviceManager.remoteAddressOf(deviceId) : null;
        if (ip == null) {
            // Could be raw IP or host from an ephemeral guest session
            sendUdpMessageToHost(deviceId, message);
            return;
        }

        udpSendExecutor.execute(() -> {
            try {
                java.net.DatagramSocket socket = getOrCreateOutboundSocket();
                if (socket == null) return;
                byte[] buffer = message.getBytes("UTF-8");
                java.net.InetAddress address = java.net.InetAddress.getByName(ip);
                java.net.DatagramPacket packet = new java.net.DatagramPacket(buffer, buffer.length, address, 1717);
                socket.send(packet);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to send UDP input message: " + message, e);
            }
        });
    }

    /** Same wire behavior as sendUdpMessage above, but addressed to a raw IP directly instead of
     *  resolving one from a paired deviceId — Joystick's only send path, since it has no pairing
     *  step at all (see sendJoystickHello's doc comment). */
    // Raw host strings (possibly several comma-separated addresses) mapped to the address that
    // actually answered, for the UDP streams that follow a guest connection.
    private static final java.util.Map<String, String> sUdpHostOverrides = new java.util.concurrent.ConcurrentHashMap<>();

    private void sendUdpMessageToHost(String host, String message) {
        if (host == null) return;
        String known = sUdpHostOverrides.get(host);
        if (known != null) host = known;
        else if (host.contains(",")) host = host.split(",")[0];
        String cleanHost = host.trim();
        if (cleanHost.startsWith("link:")) {
            String[] parts = cleanHost.split(":");
            if (parts.length >= 2) cleanHost = parts[1];
        } else if (cleanHost.startsWith("http://") || cleanHost.startsWith("https://")) {
            cleanHost = cleanHost.replaceFirst("^https?://", "").split("/")[0].split(":")[0];
        } else if (cleanHost.contains(":")) {
            cleanHost = cleanHost.split(":")[0];
        }
        final String targetIp = cleanHost;

        udpSendExecutor.execute(() -> {
            try {
                java.net.DatagramSocket socket = getOrCreateOutboundSocket();
                if (socket == null) return;
                byte[] buffer = message.getBytes("UTF-8");
                java.net.InetAddress address = java.net.InetAddress.getByName(targetIp);
                java.net.DatagramPacket packet = new java.net.DatagramPacket(buffer, buffer.length, address, 1717);
                socket.send(packet);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to send UDP message to host " + targetIp + ": " + message, e);
            }
        });
    }

    private java.util.List<String> getMyLocalIps() {
        java.util.List<String> ips = new java.util.ArrayList<>();
        try {
            java.util.List<java.net.NetworkInterface> interfaces = java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces());
            for (java.net.NetworkInterface intf : interfaces) {
                if (intf.isLoopback() || !intf.isUp()) continue;
                for (java.net.InterfaceAddress addr : intf.getInterfaceAddresses()) {
                    java.net.InetAddress ip = addr.getAddress();
                    if (ip instanceof java.net.Inet4Address) {
                        ips.add(ip.getHostAddress());
                    }
                }
            }
        } catch (Exception ignored) {}
        java.util.Collections.sort(ips);
        return ips;
    }

    private java.util.List<String> getSubnetIPs() {
        java.util.List<String> ips = new java.util.ArrayList<>();
        try {
            java.util.List<java.net.NetworkInterface> interfaces = java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces());
            for (java.net.NetworkInterface intf : interfaces) {
                if (intf.isLoopback() || !intf.isUp()) continue;
                for (java.net.InterfaceAddress addr : intf.getInterfaceAddresses()) {
                    java.net.InetAddress ip = addr.getAddress();
                    if (ip instanceof java.net.Inet4Address) {
                        short prefixLen = addr.getNetworkPrefixLength();
                        if (prefixLen == 24) { // /24 Class C subnet
                            String ipStr = ip.getHostAddress();
                            String[] parts = ipStr.split("\\.");
                            if (parts.length == 4) {
                                String prefix = parts[0] + "." + parts[1] + "." + parts[2];
                                int myLastOctet = Integer.parseInt(parts[3]);
                                for (int i = 1; i <= 254; i++) {
                                    if (i != myLastOctet) {
                                        ips.add(prefix + "." + i);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return ips;
    }

    private final java.util.Map<String, LinkCall> pendingFsCalls = new java.util.concurrent.ConcurrentHashMap<>();
    private int fsRequestCounter = 0;

    private void sendFsRequest(LinkCall call, String action, JSObject payload) {
        try {
            String deviceId = call.getString("deviceId");
            if (deviceId == null) {
                call.reject("Missing deviceId");
                return;
            }
            String requestId = "fs-req-" + System.currentTimeMillis() + "-" + (fsRequestCounter++);
            pendingFsCalls.put(requestId, call);

            org.json.JSONObject body = new org.json.JSONObject();
            body.put("requestId", requestId);
            body.put("action", action);
            if (payload != null) {
                java.util.Iterator<String> keys = payload.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    body.put(key, payload.get(key));
                }
            }

            LinkPacket packet = new LinkPacket("link.fs.request", body);
            deviceManager.sendTo(deviceId, packet);

            // Timeout safety: 30 seconds
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                LinkCall pending = pendingFsCalls.remove(requestId);
                if (pending != null) {
                    pending.reject("FileSystem request timed out");
                }
            }, 30000);
        } catch (Exception e) {
            call.reject("Failed to send FS request: " + e.getMessage());
        }
    }

    @LinkMethod
    public void fsListRoots(LinkCall call) {
        sendFsRequest(call, "listRoots", null);
    }

    @LinkMethod
    public void fsReaddir(LinkCall call) {
        String path = call.getString("path");
        JSObject payload = new JSObject();
        payload.put("path", path);
        sendFsRequest(call, "readdir", payload);
    }

    @LinkMethod
    public void fsStat(LinkCall call) {
        String path = call.getString("path");
        JSObject payload = new JSObject();
        payload.put("path", path);
        sendFsRequest(call, "stat", payload);
    }

    @LinkMethod
    public void fsCreateDirectory(LinkCall call) {
        String path = call.getString("path");
        JSObject payload = new JSObject();
        payload.put("path", path);
        payload.put("isDirectory", true);
        sendFsRequest(call, "create", payload);
    }

    @LinkMethod
    public void fsDelete(LinkCall call) {
        String path = call.getString("path");
        JSObject payload = new JSObject();
        payload.put("path", path);
        sendFsRequest(call, "delete", payload);
    }

    @LinkMethod
    public void fsRename(LinkCall call) {
        String path = call.getString("path");
        String newPath = call.getString("newPath");
        JSObject payload = new JSObject();
        payload.put("path", path);
        payload.put("newPath", newPath);
        sendFsRequest(call, "rename", payload);
    }

    // ===== File Explorer download/upload (chunked read/write over the same link.fs.request/
    // response packet-relay protocol used above for listRoots/readdir/etc — mirrors desktop's
    // LinkSocketFsClient.read()/write(), which is what a desktop peer's handleFsRequest already
    // understands, so this works against a desktop target out of the box. A phone target natively supports this via handleFsRequestPacket, enabling phone-to-phone browsing and transfer. Unlike sendFsRequest/pendingFsCalls above (one LinkCall per request, used
    // for the single-shot metadata ops), a download or upload needs MANY sequential request/
    // response round-trips per single JS-facing call, so it gets its own callback-based dispatch
    // (pendingFsCallbacks) that isn't tied to resolving/rejecting a LinkCall directly. =====

    private final java.util.Map<String, java.util.function.Consumer<org.json.JSONObject>> pendingFsCallbacks = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Set<String> cancelledTransfers = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    // Atomic because streaming issues reads from several worker threads at once (see
    // LinkFsStreamServer's pool). A racy ++ here could mint the same requestId twice within one
    // millisecond, so one read's callback would overwrite the other's and that request would hang
    // until its 35s timeout — a stall mid-playback rather than a visible error.
    private final java.util.concurrent.atomic.AtomicInteger fsInternalRequestCounter =
        new java.util.concurrent.atomic.AtomicInteger();
    private static final int FS_CHUNK_SIZE = 256 * 1024;

    private void sendFsAction(String deviceId, String action, org.json.JSONObject extra, java.util.function.Consumer<org.json.JSONObject> onResponse) {
        try {
            String requestId = "fs-int-" + System.currentTimeMillis() + "-" + fsInternalRequestCounter.getAndIncrement();
            pendingFsCallbacks.put(requestId, onResponse);

            org.json.JSONObject body = new org.json.JSONObject();
            body.put("requestId", requestId);
            body.put("action", action);
            if (extra != null) {
                java.util.Iterator<String> keys = extra.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    body.put(key, extra.get(key));
                }
            }
            deviceManager.sendTo(deviceId, new LinkPacket("link.fs.request", body));

            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                java.util.function.Consumer<org.json.JSONObject> pending = pendingFsCallbacks.remove(requestId);
                if (pending != null) pending.accept(fsErrorBody("FileSystem request timed out"));
            }, 30000);
        } catch (Exception e) {
            onResponse.accept(fsErrorBody("Failed to send FS request: " + e.getMessage()));
        }
    }

    private org.json.JSONObject fsErrorBody(String message) {
        org.json.JSONObject body = new org.json.JSONObject();
        try {
            body.put("success", false);
            body.put("error", message);
        } catch (Exception ignored) {}
        return body;
    }

    /** Blocks the calling (already-background) thread until the response arrives — every download/
     *  upload call site below is sequential I/O anyway (each chunk depends on the previous one
     *  completing), so this collapses the callback into ordinary straight-line code instead of a
     *  chain of nested lambdas. */
    private org.json.JSONObject sendFsActionSync(String deviceId, String action, org.json.JSONObject extra) {
        final org.json.JSONObject[] holder = new org.json.JSONObject[1];
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        sendFsAction(deviceId, action, extra, (body) -> {
            holder[0] = body;
            latch.countDown();
        });
        try {
            if (!latch.await(35, java.util.concurrent.TimeUnit.SECONDS)) {
                return fsErrorBody("FileSystem request timed out");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return fsErrorBody("Interrupted");
        }
        return holder[0] != null ? holder[0] : fsErrorBody("No response");
    }

    private byte[] extractBufferBytes(Object result) throws org.json.JSONException {
        org.json.JSONObject bufObj = (org.json.JSONObject) result;
        org.json.JSONArray dataArr = bufObj.getJSONArray("data");
        byte[] out = new byte[dataArr.length()];
        for (int i = 0; i < dataArr.length(); i++) {
            out[i] = (byte) dataArr.getInt(i);
        }
        return out;
    }

    private org.json.JSONObject bufferToJson(byte[] chunk) throws org.json.JSONException {
        org.json.JSONObject buf = new org.json.JSONObject();
        buf.put("type", "Buffer");
        org.json.JSONArray arr = new org.json.JSONArray();
        for (byte b : chunk) {
            arr.put(b & 0xFF); // unsigned byte value — matches Node Buffer's 0-255 entries
        }
        buf.put("data", arr);
        return buf;
    }

    private void emitFsTransferProgress(String transferId, String direction, String deviceId, String path, long transferred, long total) {
        JSObject data = new JSObject();
        data.put("transferId", transferId);
        data.put("direction", direction);
        data.put("deviceId", deviceId);
        data.put("path", path);
        data.put("transferred", transferred);
        data.put("total", total);
        notifyListeners("fsTransferProgress", data);
    }

    private String joinRemotePath(String parent, String name) {
        return (parent.endsWith("/") || parent.endsWith("\\")) ? parent + name : parent + "/" + name;
    }

    private java.io.File uniqueDestFile(java.io.File dir, String fileName) {
        java.io.File destFile = new java.io.File(dir, fileName);
        int counter = 1;
        String base = fileName;
        String ext = "";
        int dot = fileName.lastIndexOf('.');
        if (dot > 0) {
            base = fileName.substring(0, dot);
            ext = fileName.substring(dot);
        }
        while (destFile.exists()) {
            destFile = new java.io.File(dir, base + " (" + counter + ")" + ext);
            counter++;
        }
        return destFile;
    }

    @LinkMethod
    public void fsDownloadFile(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String remotePath = call.getString("remotePath");
        if (deviceId == null || remotePath == null || deviceManager == null) {
            call.reject("Missing deviceId/remotePath, or not initialized");
            return;
        }
        String transferId = "fs-" + System.currentTimeMillis() + "-" + Math.random();
        new Thread(() -> downloadFsFile(call, deviceId, remotePath, transferId), "link-fs-download").start();
    }

    private void downloadFsFile(LinkCall call, String deviceId, String remotePath, String transferId) {
        try {
            org.json.JSONObject statPayload = new org.json.JSONObject();
            statPayload.put("path", remotePath);
            org.json.JSONObject statBody = sendFsActionSync(deviceId, "stat", statPayload);
            if (!statBody.optBoolean("success", false)) {
                call.reject(statBody.optString("error", "Failed to stat remote file"));
                return;
            }
            org.json.JSONObject statInfo = statBody.getJSONObject("result");
            boolean isDir = statInfo.optBoolean("isDirectory", false);

            String name = remotePath.substring(Math.max(remotePath.lastIndexOf('/'), remotePath.lastIndexOf('\\')) + 1);
            if (name.isEmpty()) name = "download";
            java.io.File dir = new java.io.File(android.os.Environment.getExternalStorageDirectory(), "Link/Downloads");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();

            // Total is known upfront so the progress bar has a real denominator — for a folder
            // that means walking the remote tree first (readdir already reports child sizes, so
            // only subdirectories need recursing into).
            long total = isDir ? computeRemoteSize(deviceId, remotePath, transferId) : statInfo.optLong("size", 0);
            long[] transferred = {0};
            long[] lastEmitAt = {0};

            if (isDir) {
                java.io.File destDir = uniqueDestFile(dir, name);
                //noinspection ResultOfMethodCallIgnored
                destDir.mkdirs();
                downloadRemoteDir(deviceId, remotePath, destDir, transferred, total, lastEmitAt, transferId);
            } else {
                java.io.File destFile = uniqueDestFile(dir, name);
                downloadRemoteFile(deviceId, remotePath, destFile, statInfo.optLong("size", 0),
                    transferred, total, lastEmitAt, transferId);
            }
            emitFsTransferProgress(transferId, "download", deviceId, remotePath, transferred[0], total);
            call.resolve();
        } catch (Exception e) {
            call.reject("Download failed: " + e.getMessage());
        } finally {
            cancelledTransfers.remove(transferId);
        }
    }

    private long computeRemoteSize(String deviceId, String remotePath, String transferId) throws Exception {
        if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
        org.json.JSONObject payload = new org.json.JSONObject();
        payload.put("path", remotePath);
        org.json.JSONObject body = sendFsActionSync(deviceId, "readdir", payload);
        if (!body.optBoolean("success", false)) {
            throw new Exception(body.optString("error", "readdir failed"));
        }
        org.json.JSONArray items = body.getJSONArray("result");
        long total = 0;
        for (int i = 0; i < items.length(); i++) {
            org.json.JSONObject item = items.getJSONObject(i);
            String childName = item.optString("name", "");
            if (childName.isEmpty()) continue;
            if (item.optBoolean("isDirectory", false)) {
                total += computeRemoteSize(deviceId, joinRemotePath(remotePath, childName), transferId);
            } else {
                total += item.optLong("size", 0);
            }
        }
        return total;
    }

    private void downloadRemoteDir(String deviceId, String remotePath, java.io.File localDir,
                                   long[] transferred, long total, long[] lastEmitAt, String transferId) throws Exception {
        if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
        //noinspection ResultOfMethodCallIgnored
        localDir.mkdirs();
        org.json.JSONObject payload = new org.json.JSONObject();
        payload.put("path", remotePath);
        org.json.JSONObject body = sendFsActionSync(deviceId, "readdir", payload);
        if (!body.optBoolean("success", false)) {
            throw new Exception(body.optString("error", "readdir failed"));
        }
        org.json.JSONArray items = body.getJSONArray("result");
        for (int i = 0; i < items.length(); i++) {
            if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
            org.json.JSONObject item = items.getJSONObject(i);
            String childName = item.optString("name", "");
            if (childName.isEmpty()) continue;
            String childRemote = joinRemotePath(remotePath, childName);
            java.io.File childLocal = new java.io.File(localDir, childName);
            if (item.optBoolean("isDirectory", false)) {
                downloadRemoteDir(deviceId, childRemote, childLocal, transferred, total, lastEmitAt, transferId);
            } else {
                downloadRemoteFile(deviceId, childRemote, childLocal, item.optLong("size", 0),
                    transferred, total, lastEmitAt, transferId);
            }
        }
    }

    private void downloadRemoteFile(String deviceId, String remotePath, java.io.File destFile, long size,
                                    long[] transferred, long total, long[] lastEmitAt, String transferId) throws Exception {
        java.io.File parent = destFile.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(destFile, "rw")) {
            long offset = 0;
            while (offset < size) {
                if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
                int length = (int) Math.min(FS_CHUNK_SIZE, size - offset);
                org.json.JSONObject readPayload = new org.json.JSONObject();
                readPayload.put("path", remotePath);
                readPayload.put("offset", offset);
                readPayload.put("length", length);
                org.json.JSONObject readBody = sendFsActionSync(deviceId, "read", readPayload);
                if (!readBody.optBoolean("success", false)) {
                    throw new Exception(readBody.optString("error", "Read failed"));
                }
                byte[] chunk = extractBufferBytes(readBody.get("result"));
                if (chunk.length == 0) break;
                raf.write(chunk);
                offset += chunk.length;
                transferred[0] += chunk.length;

                long now = System.currentTimeMillis();
                if (now - lastEmitAt[0] >= 100) {
                    lastEmitAt[0] = now;
                    emitFsTransferProgress(transferId, "download", deviceId, remotePath, transferred[0], total);
                }
            }
        }
    }

    @LinkMethod
    public void fsUploadItem(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String localPath = call.getString("localPath");
        String remoteParentPath = call.getString("remoteParentPath");
        if (deviceId == null || localPath == null || remoteParentPath == null || deviceManager == null) {
            call.reject("Missing deviceId/localPath/remoteParentPath, or not initialized");
            return;
        }
        String transferId = "fs-" + System.currentTimeMillis() + "-" + Math.random();
        new Thread(() -> uploadFsItem(call, deviceId, android.net.Uri.parse(localPath), remoteParentPath, transferId), "link-fs-upload").start();
    }

    private static final String[] FS_DOC_PROJECTION = {
        android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,
        android.provider.DocumentsContract.Document.COLUMN_SIZE,
    };

    private void uploadFsItem(LinkCall call, String deviceId, android.net.Uri uri, String remoteParentPath, String transferId) {
        try {
            if (android.provider.DocumentsContract.isTreeUri(uri)) {
                String rootDocId = android.provider.DocumentsContract.getTreeDocumentId(uri);
                String treeName = queryDocumentDisplayName(uri, rootDocId);
                if (treeName == null || treeName.isEmpty()) treeName = "Folder";
                long total = computeTreeUploadSize(uri, rootDocId);
                long[] transferred = {0};
                String remoteRootPath = joinRemotePath(remoteParentPath, treeName);
                createRemoteDir(deviceId, remoteRootPath);
                uploadTreeRecursively(deviceId, uri, rootDocId, remoteRootPath, transferred, total, transferId);
            } else {
                String name = "file";
                long size = 0;
                try (android.database.Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int nameIdx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                        int sizeIdx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE);
                        if (nameIdx >= 0) name = cursor.getString(nameIdx);
                        if (sizeIdx >= 0) size = cursor.getLong(sizeIdx);
                    }
                } catch (Exception ignored) {}
                String remotePath = joinRemotePath(remoteParentPath, name);
                long[] transferred = {0};
                uploadFileBytes(deviceId, uri, remotePath, transferred, size, transferId);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Upload failed: " + e.getMessage());
        } finally {
            cancelledTransfers.remove(transferId);
        }
    }

    private String queryDocumentDisplayName(android.net.Uri treeUri, String documentId) {
        android.net.Uri docUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
        try (android.database.Cursor cursor = getContext().getContentResolver().query(
                docUri, new String[]{android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {}
        return null;
    }

    private long computeTreeUploadSize(android.net.Uri treeUri, String documentId) {
        long total = 0;
        android.net.Uri childrenUri = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
        try (android.database.Cursor cursor = getContext().getContentResolver().query(childrenUri, FS_DOC_PROJECTION, null, null, null)) {
            if (cursor == null) return 0;
            while (cursor.moveToNext()) {
                String childId = cursor.getString(0);
                String mime = cursor.getString(2);
                if (android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    total += computeTreeUploadSize(treeUri, childId);
                } else {
                    total += cursor.getLong(3);
                }
            }
        }
        return total;
    }

    private void uploadTreeRecursively(String deviceId, android.net.Uri treeUri, String documentId, String remoteParentPath, long[] transferred, long total, String transferId) throws Exception {
        if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
        android.net.Uri childrenUri = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
        try (android.database.Cursor cursor = getContext().getContentResolver().query(childrenUri, FS_DOC_PROJECTION, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
                String childId = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                if (name == null || name.isEmpty()) name = "item";
                String remotePath = joinRemotePath(remoteParentPath, name);
                if (android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    createRemoteDir(deviceId, remotePath);
                    uploadTreeRecursively(deviceId, treeUri, childId, remotePath, transferred, total, transferId);
                } else {
                    android.net.Uri fileUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, childId);
                    uploadFileBytes(deviceId, fileUri, remotePath, transferred, total, transferId);
                }
            }
        }
    }

    private void createRemoteDir(String deviceId, String remotePath) throws Exception {
        org.json.JSONObject payload = new org.json.JSONObject();
        payload.put("path", remotePath);
        payload.put("isDirectory", true);
        org.json.JSONObject resp = sendFsActionSync(deviceId, "create", payload);
        if (!resp.optBoolean("success", false)) {
            throw new Exception(resp.optString("error", "Failed to create remote directory"));
        }
    }

    private void uploadFileBytes(String deviceId, android.net.Uri fileUri, String remotePath, long[] transferred, long total, String transferId) throws Exception {
        if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
        org.json.JSONObject createPayload = new org.json.JSONObject();
        createPayload.put("path", remotePath);
        createPayload.put("isDirectory", false);
        org.json.JSONObject createResp = sendFsActionSync(deviceId, "create", createPayload);
        if (!createResp.optBoolean("success", false)) {
            throw new Exception(createResp.optString("error", "Failed to create remote file"));
        }

        try (java.io.InputStream in = getContext().getContentResolver().openInputStream(fileUri)) {
            if (in == null) throw new Exception("Failed to open file for reading");
            byte[] buffer = new byte[FS_CHUNK_SIZE];
            long offset = 0;
            long lastEmitAt = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
                byte[] chunk = read == buffer.length ? buffer : java.util.Arrays.copyOf(buffer, read);
                org.json.JSONObject writePayload = new org.json.JSONObject();
                writePayload.put("path", remotePath);
                writePayload.put("offset", offset);
                writePayload.put("buffer", bufferToJson(chunk));
                org.json.JSONObject writeResp = sendFsActionSync(deviceId, "write", writePayload);
                if (!writeResp.optBoolean("success", false)) {
                    throw new Exception(writeResp.optString("error", "Write failed"));
                }
                offset += read;
                transferred[0] += read;

                long now = System.currentTimeMillis();
                if (now - lastEmitAt >= 100 || transferred[0] >= total) {
                    lastEmitAt = now;
                    emitFsTransferProgress(transferId, "upload", deviceId, remotePath, transferred[0], total);
                }
            }
        }
    }

    @LinkMethod
    public void fsPickUploadItems(LinkCall call) {
        String mode = call.getString("mode", "file");
        if ("directory".equals(mode)) {
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT_TREE);
            startActivityForResult(call.invoke(), intent, "onFsUploadTreePicked");
        } else {
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
            intent.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.setType("*/*");
            startActivityForResult(call.invoke(), intent, "onFsUploadFilesPicked");
        }
    }

    // ===== Media streaming =====
    // One loopback HTTP server shared by every device (the deviceId travels in the URL), started
    // lazily on the first playback request and left running for the process lifetime — restarting
    // it per file would invalidate URLs a player might still be seeking within.

    // Instance-scoped, unlike the hosting servers above (sAudioSinkServer et al) which are static
    // so a session survives the plugin being recreated. The Source below captures this plugin
    // instance to reach sendFsActionSync/deviceManager, so a static server outliving its creator
    // would keep serving through a dead instance.
    private LinkFsStreamServer fsStreamServer;

    private synchronized LinkFsStreamServer ensureStreamServer() throws java.io.IOException {
        if (fsStreamServer == null || !fsStreamServer.isRunning()) {
            fsStreamServer = new LinkFsStreamServer(new LinkFsStreamServer.Source() {
                @Override
                public long size(String deviceId, String path) throws Exception {
                    org.json.JSONObject payload = new org.json.JSONObject();
                    payload.put("path", path);
                    org.json.JSONObject body = sendFsActionSync(deviceId, "stat", payload);
                    if (!body.optBoolean("success", false)) {
                        throw new Exception(body.optString("error", "stat failed"));
                    }
                    return body.getJSONObject("result").optLong("size", 0);
                }

                @Override
                public byte[] read(String deviceId, String path, long offset, int length) throws Exception {
                    org.json.JSONObject payload = new org.json.JSONObject();
                    payload.put("path", path);
                    payload.put("offset", offset);
                    payload.put("length", length);
                    org.json.JSONObject body = sendFsActionSync(deviceId, "read", payload);
                    if (!body.optBoolean("success", false)) {
                        throw new Exception(body.optString("error", "read failed"));
                    }
                    return extractBufferBytes(body.get("result"));
                }
            });
            fsStreamServer.start();
        }
        return fsStreamServer;
    }

    @LinkMethod
    public void fsGetStreamUrl(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String remotePath = call.getString("remotePath");
        if (deviceId == null || remotePath == null || deviceManager == null) {
            call.reject("Missing deviceId/remotePath, or not initialized");
            return;
        }
        try {
            LinkFsStreamServer server = ensureStreamServer();
            JSObject ret = new JSObject();
            ret.put("url", server.buildUrl(deviceId, remotePath));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not start stream server: " + e.getMessage());
        }
    }

    /** Hands a stream URL to whatever app the user has registered for that media type. Restricted
     *  to the loopback URLs this app itself minted — ACTION_VIEW on an arbitrary caller-supplied
     *  URL would let the web layer launch any registered handler on the device. */
    @LinkMethod
    public void openExternal(LinkCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("http://127.0.0.1:")) {
            call.reject("Refusing to open a non-loopback URL");
            return;
        }
        try {
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            // setDataAndType, not setData — without an explicit MIME type Android resolves the
            // chooser off the http scheme alone and offers browsers instead of media players.
            intent.setDataAndType(android.net.Uri.parse(url), LinkFsStreamServer.mimeFor(url));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app available to open this file: " + e.getMessage());
        }
    }

    /** Documents don't stream — see desktop's fs-open-document handler for the reasoning; the same
     *  applies here, with the added constraint that Android document viewers expect a content://
     *  Uri and mostly refuse an http:// one. The file is fetched into the app cache and handed
     *  over through the FileProvider already declared in AndroidManifest.xml, whose file_paths.xml
     *  exposes the whole cache dir. Read-only for the same reason as desktop: the copy has no way
     *  back to the peer, so an edit saved into it would be silently lost. */
    @LinkMethod
    public void fsOpenDocument(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String remotePath = call.getString("remotePath");
        if (deviceId == null || remotePath == null || deviceManager == null) {
            call.reject("Missing deviceId/remotePath, or not initialized");
            return;
        }
        String transferId = "fs-" + System.currentTimeMillis() + "-" + Math.random();
        new Thread(() -> openFsDocument(call, deviceId, remotePath, transferId), "link-fs-doc").start();
    }

    private void openFsDocument(LinkCall call, String deviceId, String remotePath, String transferId) {
        try {
            org.json.JSONObject statPayload = new org.json.JSONObject();
            statPayload.put("path", remotePath);
            org.json.JSONObject statBody = sendFsActionSync(deviceId, "stat", statPayload);
            if (!statBody.optBoolean("success", false)) {
                call.reject(statBody.optString("error", "Failed to stat remote file"));
                return;
            }
            org.json.JSONObject statInfo = statBody.getJSONObject("result");
            if (statInfo.optBoolean("isDirectory", false)) {
                call.reject("Cannot open a directory");
                return;
            }
            long size = statInfo.optLong("size", 0);

            String name = remotePath.substring(Math.max(remotePath.lastIndexOf('/'), remotePath.lastIndexOf('\\')) + 1);
            if (name.isEmpty()) name = "document";
            // Fresh subdirectory per open: same-named documents from different folders would
            // otherwise collide, and the read-only bit set below would block overwriting a stale
            // copy on the next open.
            java.io.File dir = new java.io.File(getContext().getCacheDir(),
                "documents/" + System.currentTimeMillis());
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            java.io.File destFile = new java.io.File(dir, name);

            long[] transferred = {0};
            long[] lastEmitAt = {0};
            downloadRemoteFile(deviceId, remotePath, destFile, size, transferred, size, lastEmitAt, transferId);
            emitFsTransferProgress(transferId, "download", deviceId, remotePath, transferred[0], size);

            //noinspection ResultOfMethodCallIgnored
            destFile.setReadOnly();

            android.net.Uri contentUri = androidx.core.content.FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", destFile);
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(contentUri, LinkFsStreamServer.mimeFor(name));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(intent);
            call.resolve();
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("No app installed that can open this file type");
        } catch (Exception e) {
            call.reject("Could not open document: " + e.getMessage());
        } finally {
            cancelledTransfers.remove(transferId);
        }
    }

    @LinkMethod
    public void fsCancelTransfer(LinkCall call) {
        String transferId = call.getString("transferId");
        if (transferId != null) {
            cancelledTransfers.add(transferId);
            call.resolve();
        } else {
            call.reject("Missing transferId");
        }
    }

    @app.tauri.annotation.ActivityCallback
    private void onFsUploadFilesPicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject());
            return;
        }
        android.content.Intent data = result.getData();
        java.util.List<android.net.Uri> uris = new java.util.ArrayList<>();
        if (data.getClipData() != null) {
            android.content.ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                android.net.Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        JSArray uriStrings = new JSArray();
        for (android.net.Uri uri : uris) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}
            uriStrings.put(uri.toString());
        }
        JSObject ret = new JSObject();
        ret.put("paths", uriStrings);
        call.resolve(ret);
    }

    @app.tauri.annotation.ActivityCallback
    private void onFsUploadTreePicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject());
            return;
        }
        android.net.Uri treeUri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri,
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {}
        JSArray uriStrings = new JSArray();
        uriStrings.put(treeUri.toString());
        JSObject ret = new JSObject();
        ret.put("paths", uriStrings);
        call.resolve(ret);
    }

        private void handleFsRequestPacket(String deviceId, LinkPacket packet) {
        try {
            org.json.JSONObject body = packet.body;
            String requestId = body.optString("requestId");
            String action = body.optString("action");

            org.json.JSONObject resp = new org.json.JSONObject();
            resp.put("requestId", requestId);

            if (!LinkDevicePermissions.check(getContext(), deviceId, "fileaccess")) {
                resp.put("success", false);
                resp.put("error", "Permission denied");
                deviceManager.sendTo(deviceId, new LinkPacket("link.fs.response", resp));
                return;
            }

            if ("listRoots".equals(action)) {
                org.json.JSONArray roots = new org.json.JSONArray();
                java.io.File primary = android.os.Environment.getExternalStorageDirectory();
                org.json.JSONObject primaryObj = new org.json.JSONObject();
                primaryObj.put("name", "Internal Storage");
                primaryObj.put("path", primary.getAbsolutePath());
                primaryObj.put("totalSpace", primary.getTotalSpace());
                primaryObj.put("freeSpace", primary.getUsableSpace());
                roots.put(primaryObj);
                
                java.io.File storageDir = new java.io.File("/storage");
                if (storageDir.exists() && storageDir.isDirectory()) {
                    java.io.File[] files = storageDir.listFiles();
                    if (files != null) {
                        for (java.io.File f : files) {
                            if (f.isDirectory() && f.canRead() && !f.getName().equals("self") && !f.getName().equals("emulated")) {
                                org.json.JSONObject root = new org.json.JSONObject();
                                root.put("name", f.getName());
                                root.put("path", f.getAbsolutePath());
                                root.put("totalSpace", f.getTotalSpace());
                                root.put("freeSpace", f.getUsableSpace());
                                roots.put(root);
                            }
                        }
                    }
                }
                resp.put("success", true);
                resp.put("result", roots);
            } else if ("readdir".equals(action)) {
                String path = body.getString("path");
                java.io.File dir = new java.io.File(path);
                if (!dir.exists() || !dir.isDirectory()) {
                    resp.put("success", false);
                    resp.put("error", "Directory not found");
                } else {
                    org.json.JSONArray files = new org.json.JSONArray();
                    java.io.File[] list = dir.listFiles();
                    if (list != null) {
                        for (java.io.File f : list) {
                            org.json.JSONObject fileObj = new org.json.JSONObject();
                            fileObj.put("name", f.getName());
                            fileObj.put("isDirectory", f.isDirectory());
                            fileObj.put("size", f.isDirectory() ? 0 : f.length());
                            fileObj.put("mtime", f.lastModified());
                            files.put(fileObj);
                        }
                    }
                    resp.put("success", true);
                    resp.put("result", files);
                }
            } else if ("stat".equals(action)) {
                String path = body.getString("path");
                java.io.File f = new java.io.File(path);
                if (!f.exists()) {
                    resp.put("success", false);
                    resp.put("error", "File not found");
                } else {
                    org.json.JSONObject fileObj = new org.json.JSONObject();
                    fileObj.put("name", f.getName());
                    fileObj.put("isDirectory", f.isDirectory());
                    fileObj.put("size", f.isDirectory() ? 0 : f.length());
                    fileObj.put("mtime", f.lastModified());
                    resp.put("success", true);
                    resp.put("result", fileObj);
                }
            } else if ("create".equals(action)) {
                String path = body.getString("path");
                boolean isDirectory = body.getBoolean("isDirectory");
                java.io.File f = new java.io.File(path);
                boolean created = false;
                if (isDirectory) {
                    created = f.mkdirs();
                } else {
                    java.io.File parent = f.getParentFile();
                    if (parent != null && !parent.exists()) parent.mkdirs();
                    created = f.createNewFile();
                }
                resp.put("success", true);
                resp.put("result", created || f.exists());
            } else if ("delete".equals(action)) {
                String path = body.getString("path");
                java.io.File f = new java.io.File(path);
                boolean deleted = false;
                if (f.isDirectory()) {
                    java.io.File[] list = f.listFiles();
                    if (list != null) {
                        for (java.io.File child : list) { child.delete(); }
                    }
                }
                deleted = f.delete();
                resp.put("success", true);
                resp.put("result", deleted);
                        } else if ("read".equals(action)) {
                String path = body.getString("path");
                long offset = body.getLong("offset");
                int length = body.getInt("length");
                java.io.File f = new java.io.File(path);
                if (!f.exists() || f.isDirectory()) {
                    resp.put("success", false);
                    resp.put("error", "File not found");
                } else {
                    long fileLen = f.length();
                    int toRead = (int) Math.min(length, fileLen - offset);
                    if (toRead <= 0) {
                        resp.put("success", true);
                        resp.put("result", bufferToJson(new byte[0]));
                    } else {
                        byte[] buffer = new byte[toRead];
                        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
                            raf.seek(offset);
                            raf.readFully(buffer);
                        }
                        resp.put("success", true);
                        resp.put("result", bufferToJson(buffer));
                    }
                }
            } else if ("write".equals(action)) {
                String path = body.getString("path");
                long offset = body.getLong("offset");
                byte[] data = extractBufferBytes(body.get("buffer"));
                java.io.File f = new java.io.File(path);
                java.io.File parent = f.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "rw")) {
                    raf.seek(offset);
                    raf.write(data);
                }
                resp.put("success", true);
                resp.put("result", true);
            } else if ("rename".equals(action)) {
                String path = body.getString("path");
                String newPath = body.getString("newPath");
                java.io.File src = new java.io.File(path);
                java.io.File dest = new java.io.File(newPath);
                java.io.File parent = dest.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                boolean renamed = src.renameTo(dest);
                resp.put("success", true);
                resp.put("result", renamed);
            } else {
                resp.put("success", false);
                resp.put("error", "Unsupported action: " + action);
            }

            deviceManager.sendTo(deviceId, new LinkPacket("link.fs.response", resp));
        } catch (Exception e) {
            try {
                org.json.JSONObject err = new org.json.JSONObject();
                err.put("requestId", packet.body.optString("requestId"));
                err.put("success", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
                deviceManager.sendTo(deviceId, new LinkPacket("link.fs.response", err));
            } catch (Exception ignored) {}
        }
    }


    private void handleFsResponsePacket(LinkPacket packet) {
        try {
            org.json.JSONObject body = packet.body;
            String requestId = body.getString("requestId");

            java.util.function.Consumer<org.json.JSONObject> internalCb = pendingFsCallbacks.remove(requestId);
            if (internalCb != null) {
                internalCb.accept(body);
                return;
            }

            LinkCall call = pendingFsCalls.remove(requestId);
            if (call != null) {
                boolean success = body.optBoolean("success", false);
                if (success) {
                    JSObject result = new JSObject();
                    if (body.has("result")) {
                        Object res = body.get("result");
                        if (res instanceof org.json.JSONArray) {
                            result.put("result", (org.json.JSONArray) res);
                        } else if (res instanceof org.json.JSONObject) {
                            result.put("result", (org.json.JSONObject) res);
                        } else {
                            result.put("result", res);
                        }
                    }
                    call.resolve(result);
                } else {
                    call.reject(body.optString("error", "Request failed"));
                }
            }
        } catch (Exception e) {
            android.util.Log.e(TAG, "Error handling FS response packet", e);
        }
    }

    private void scanSubnet() {
        android.util.Log.i(TAG, "[Link] LAN change detected or startup: scanning local subnet...");
        java.util.List<String> targets = getSubnetIPs();
        if (targets.isEmpty()) return;

        java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newFixedThreadPool(32);
        for (String ip : targets) {
            executor.submit(() -> {
                try {
                    java.net.Socket socket = new java.net.Socket();
                    socket.connect(new java.net.InetSocketAddress(ip, LinkTransport.LINK_PORT), 1000);
                    socket.close();
                    if (deviceManager != null && deviceManager.deviceIdForAddress(ip) != null) return;
                    android.util.Log.i(TAG, "[Link] Subnet scan found active listener at " + ip + ". Connecting...");
                    new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                        new Thread(() -> {
                            try {
                                deviceManager.connectTo(ip, LinkTransport.LINK_PORT);
                            } catch (Exception ignored) {}
                        }).start();
                    });
                } catch (Exception ignored) {}
            });
        }
        executor.shutdown();
    }

    // Static like sDiscoveryWatcher: it outlives the activity, and a reattach replaces it.
    private static android.net.ConnectivityManager.NetworkCallback sNetworkCallback;

    /** Reacts to the device changing networks. Connections made over the old network are dead but
     *  would otherwise only be noticed by the heartbeat timeout, and the backoff built up while
     *  offline should not delay the first attempt on the new network. */
    private void watchNetwork() {
        android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        if (sNetworkCallback != null) {
            try { cm.unregisterNetworkCallback(sNetworkCallback); } catch (Exception ignored) {}
            sNetworkCallback = null;
        }
        final android.net.ConnectivityManager.NetworkCallback callback = new android.net.ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(android.net.Network network) {
                refreshConnections(false);
            }

            @Override
            public void onLinkPropertiesChanged(android.net.Network network, android.net.LinkProperties properties) {
                refreshConnections(false);
            }

            @Override
            public void onLost(android.net.Network network) {
                refreshConnections(true);
            }
        };
        try {
            cm.registerDefaultNetworkCallback(callback);
            sNetworkCallback = callback;
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not watch network changes", e);
        }
    }

    private void refreshConnections(boolean dropConnections) {
        trustedReconnectHandler.post(() -> {
            if (deviceManager == null) return;
            for (LinkTrustStore.TrustedDevice d : deviceManager.getTrustStore().list()) {
                clearConnectBackoff(d.deviceId);
                if (dropConnections && deviceManager.hasPeer(d.deviceId)) {
                    deviceManager.closeConnection(d.deviceId);
                }
            }
            if (discoveryWatcher != null) discoveryWatcher.broadcastNow();
            attemptTrustedReconnects();
        });
    }

    private void attemptTrustedReconnects() {
        if (deviceManager == null) return;

        java.util.List<String> currentIps = getMyLocalIps();
        if (!currentIps.equals(lastLocalIps)) {
            lastLocalIps = currentIps;
            scanSubnet();
        }

        java.util.List<String[]> targets = new java.util.ArrayList<>(); // {deviceId, ip}
        boolean hasPeerWithoutIp = false;
        for (LinkTrustStore.TrustedDevice dev : deviceManager.getTrustStore().list()) {
            if (deviceManager.upgradePeerIfTrusted(dev.deviceId)) continue;
            if (dev.lastKnownIp != null && !dev.lastKnownIp.isEmpty()) {
                targets.add(new String[]{dev.deviceId, dev.lastKnownIp});
            } else if (!deviceManager.hasTrustedPeer(dev.deviceId)) {
                hasPeerWithoutIp = true;
            }
        }

        if (hasPeerWithoutIp) {
            scanSubnet();
        }

        for (int i = 0; i < targets.size(); i++) {
            final String targetDeviceId = targets.get(i)[0];
            final String targetIp = targets.get(i)[1];
            if (deviceManager.upgradePeerIfTrusted(targetDeviceId)) continue;
            if (deviceManager.hasTrustedPeer(targetDeviceId) || !canAttemptConnect(targetDeviceId)) continue;
            if (deviceManager.hasPeer(targetDeviceId)) {
                deviceManager.closeConnection(targetDeviceId);
            }
            final int delay = i * 250;
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (deviceManager == null || deviceManager.hasTrustedPeer(targetDeviceId) || !connectingDeviceIds.add(targetDeviceId)) return;
                new Thread(() -> {
                    try {
                        deviceManager.connectTo(targetIp, LinkTransport.LINK_PORT);
                        clearConnectBackoff(targetDeviceId);
                    } catch (Exception e) {
                        recordConnectFailure(targetDeviceId);
                    } finally {
                        connectingDeviceIds.remove(targetDeviceId);
                    }
                }, "link-trusted-reconnect").start();
            }, delay);
        }
    }
}
