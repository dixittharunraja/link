package in.rodix.link;

// Capacitor plugin bridge — exposes the native LinkDeviceManager to the WebView. Mirrors
// desktop's IPC bridge (preload.ts <-> main.ts) in spirit: the WebView never touches sockets
// directly, it only calls plugin methods and listens for events.

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import android.Manifest;

import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "Link",
    permissions = {
        @Permission(
            // Bundled with READ_CALL_LOG: since Android 10, EXTRA_INCOMING_NUMBER is stripped
            // from the phone-state broadcast for apps without it, so caller ID silently breaks
            // (shows "Unknown Caller") even though READ_PHONE_STATE alone is still granted.
            alias = "phoneState",
            strings = { Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG }
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
    // link.digitizer.session/link.digitizer added — Android already sends these (sendDigitizerSession/
    // sendDigitizerEvent) but never declared the capability, so peers had no way to discover support.
    // link.remoteinput.send added — handleRemoteInput() (see LinkPlugin's packet dispatch below)
    // already executes these, but the capability itself was never declared, so a desktop peer had
    // no way to discover this phone can receive keyboard/D-Pad remote-input packets.
    // Joystick has no capability entry here — it has no TLS packet type at all, deliberately (see
    // desktop's joystick.ts header comment). Its whole protocol, including the join handshake,
    // rides the raw UDP:1717 line channel, IP-identified only, same as an Audio Sink guest.
    private static final String[] CAPABILITIES = {"link.clipboard", "link.clipboard.connect", "link.battery", "link.findmydevice.request", "link.runcommand", "link.runcommand.request", "link.presenter", "link.systemvolume", "link.systemvolume.request", "link.lock", "link.lock.request", "link.connectivity", "link.touchpad.request", "link.mpris", "link.mpris.request", "link.telephony", "link.notification", "link.notification.reply", "link.flashlight", "link.dnd", "link.rename", "link.rename.request", "link.digitizer.session", "link.digitizer", "link.remoteinput.send"};

    // Mirrors desktop main.ts's ENABLED_PLUGINS kill-switch for the systematic re-verification
    // pass: everything in test.txt starts disabled so core connection (discovery/pairing/trust/
    // TLS) can be solidified in isolation first, then plugins re-enabled one at a time. Only gates
    // wiring in this file — no plugin's own logic (Link*.java) is touched. Speed Test, System
    // Volume, and MPRIS have graduated out of this — confirmed working, so their gates were
    // removed entirely rather than left toggled on here.
    private static final java.util.Set<String> ENABLED_PLUGINS = new java.util.HashSet<>(java.util.Arrays.asList(
        "Clipboard", "Battery", "Flashlight", "DND", "Connectivity", "Lock", "Notification", "RunCommand",
        "Presenter", "Digitizer", "Touchpad", "Telephony", "MPRIS", "Joystick"
    ));
    // Package-private (not private) so SendClipboardActivity, in the same package, can reuse it.
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
    private static LinkPortalTransferServer sPortalTransferServer;
    private static LinkPortalTransferClient sPortalTransferClient;
    // Walkie Talkie's guest-facing signaling — see LinkWalkieTalkieSignalServer.java's header
    // comment. Only relevant for an unpaired participant (manual IP + PIN); already-paired members
    // use the existing trusted connection instead (handleWalkieTalkieSignalPacket above).
    private static LinkWalkieTalkieSignalServer sWalkieTalkieGuestServer;
    private static LinkWalkieTalkieSignalClient sWalkieTalkieGuestClient;
    private static LinkJoystickClient sJoystickClient;
    private LinkPacket lastTelephonyPacket = null;
    private String lastCallState = "";
    private String lastIncomingNumber = null;
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

    // App-level heartbeat/liveness cycle — detects a genuinely dead peer within ~9s instead of
    // depending on OS TCP keepalive timing (which only lets Java toggle keepalive on/off, not
    // configure the interval/count, so real-world detection could silently take much longer).
    // Mirrors desktop main.ts's heartbeat interval.
    private static final long HEARTBEAT_INTERVAL_MS = 3000;
    private static final long HEARTBEAT_TIMEOUT_MS = 9000;
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
    public void load() {
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
            // Recents). If the user reopens the app while the process is still alive, Capacitor
            // creates a NEW LinkPlugin and calls load() again in the SAME process. Without this
            // guard, the previous (orphaned but still-running) DeviceManager/FsServer would still
            // be holding the TCP ports, and starting new ones would throw BindException —
            // uncaught, that left the Capacitor bridge stuck mid-init, which is what caused the
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
                    android.util.Log.e(TAG, "Error stopping previous WalkieTalkieSignalServer", e);
                }
                sWalkieTalkieGuestServer = null;
            }

            myIdentity = LinkIdentity.loadOrCreate(getContext(), CAPABILITIES, CAPABILITIES);
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
                        data.put("incomingCapabilities", new com.getcapacitor.JSArray(identity.incomingCapabilities));
                        data.put("outgoingCapabilities", new com.getcapacitor.JSArray(identity.outgoingCapabilities));
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
                    if (trustedReconnectRunnable != null) {
                        new android.os.Handler(android.os.Looper.getMainLooper()).post(trustedReconnectRunnable);
                    }
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
                    } else if (packet.type.equals(LinkFlashlight.PACKET_TYPE_FLASHLIGHT)) {
                        handleFlashlightPacket(deviceId, packet);
                    } else if (packet.type.equals(LinkDND.PACKET_TYPE_DND)) {
                        handleDndPacket(deviceId, packet);
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
                                LinkPacket np = LinkTelephony.createCallPacket("talking", number, contactName, contactPhoto);
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

            deviceManager.startServer(LinkTransport.LINK_PORT);
            android.util.Log.i(TAG, "server started on port " + LinkTransport.LINK_PORT);

            startInputUdpServer();

            discoveryWatcher = new LinkDiscovery.Watcher(getContext(), myIdentity, (ip, peer) -> {
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

                // Auto-connect to trusted peers whenever we hear them
                // CRITICAL: Prevent simultaneous bidirectional connection attempts — only larger deviceId connects
                if (!deviceManager.hasPeer(peer.deviceId) && canAttemptConnect(peer.deviceId)
                        && myIdentity.deviceId.compareTo(peer.deviceId) > 0
                        && connectingDeviceIds.add(peer.deviceId)) {
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
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("link_prefs", android.content.Context.MODE_PRIVATE);
            boolean visibility = prefs.getBoolean("discovery_visibility", false);
            discoveryWatcher.start(visibility);
            sDiscoveryWatcher = discoveryWatcher;

            // Periodic trusted reconnect: attempt to connect to all trusted devices at their last known IP,
            // every 10s. Works even when visibility is OFF and therefore no UDP broadcasts are sent.
            this.trustedReconnectRunnable = new Runnable() {
                @Override
                public void run() {
                    if (deviceManager == null) return;

                    java.util.List<String> currentIps = getMyLocalIps();
                    if (!currentIps.equals(lastLocalIps)) {
                        lastLocalIps = currentIps;
                        scanSubnet();
                    }
                    java.util.List<String[]> targets = new java.util.ArrayList<>(); // {deviceId, ip}
                    for (LinkTrustStore.TrustedDevice dev : new LinkTrustStore(getContext()).list()) {
                        if (dev.lastKnownIp != null && !dev.lastKnownIp.isEmpty()) {
                            targets.add(new String[]{dev.deviceId, dev.lastKnownIp});
                        }
                    }

                    for (int i = 0; i < targets.size(); i++) {
                        final String targetDeviceId = targets.get(i)[0];
                        final String targetIp = targets.get(i)[1];
                        if (deviceManager.hasPeer(targetDeviceId) || !canAttemptConnect(targetDeviceId)) continue;
                        final int delay = i * 250;
                        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                            if (deviceManager == null || deviceManager.hasPeer(targetDeviceId) || !connectingDeviceIds.add(targetDeviceId)) return;
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
                    new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(this, 10000);
                }
            };
            new android.os.Handler(android.os.Looper.getMainLooper()).post(this.trustedReconnectRunnable);


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
            // handled by SendClipboardActivity (an invisible trampoline launched directly from the
            // notification's PendingIntent), since Android 10+ denies clipboard reads to apps not
            // currently in focus and a background broadcast receiver never counts as in focus.
            // ACTION_NOTIFICATION_DISMISSED is handled by LinkForegroundService.

            // Display the status notification
            showActiveNotification();

            sDeviceManager = deviceManager;
        } catch (Exception e) {
            android.util.Log.e(TAG, "load() failed", e);
            throw new RuntimeException("Failed to initialize Link core", e);
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyListeners("appResumed", new JSObject());
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
            LinkPresenterOverlay.hide();
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

    private void handleDigitizerSessionPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "digitizer")) {
            android.util.Log.i(TAG, "Blocked Digitizer session from " + deviceId + " (Permission disabled)");
            return;
        }
        String action = packet.getBody().optString("action");
        int width = packet.getBody().optInt("width", 0);
        int height = packet.getBody().optInt("height", 0);

        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("action", action);
        data.put("width", width);
        data.put("height", height);
        notifyListeners("digitizerSessionReceived", data);
    }

    private void handleDigitizerPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "digitizer")) {
            return;
        }
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("x", packet.getBody().optInt("x", 0));
        data.put("y", packet.getBody().optInt("y", 0));
        data.put("touching", packet.getBody().optBoolean("touching", false));
        data.put("active", packet.getBody().optBoolean("active", true));
        notifyListeners("digitizerEventReceived", data);
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
        if (!LinkDevicePermissions.check(getContext(), deviceId, "lock")) {
            android.util.Log.i(TAG, "Blocked Lock request from " + deviceId + " (Permission disabled)");
            return;
        }
        boolean setLocked = packet.body.optBoolean("setLocked", false);
        if (setLocked) {
            boolean res = LinkLock.lock(getContext());
            deviceManager.sendTo(deviceId, LinkLock.createLockPacket(getContext(), res));
        } else {
            // Either an explicit status query, or (defensively) a setLocked:false "unlock"
            // request — no mainstream OS exposes a way to unlock a screen without the user's
            // real credentials, so there is nothing to do for that case. Always reply with the
            // REAL current state instead of silently ignoring it, which previously left the
            // requester's optimistic "unlocked" UI permanently stuck out of sync.
            deviceManager.sendTo(deviceId, LinkLock.createLockPacket(getContext(), null));
        }
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
                myIdentity = LinkIdentity.loadOrCreate(getContext(), CAPABILITIES, CAPABILITIES);
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
    // itself (Capacitor's BridgeWebChromeClient already grants RECORD_AUDIO for getUserMedia), so
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

    @PluginMethod
    public void sendWalkieTalkieSignal(PluginCall call) {
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

    @PluginMethod
    public void broadcastWalkieTalkieSignal(PluginCall call) {
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
    @PluginMethod
    public void startWalkieTalkieGuestListener(PluginCall call) {
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
            LinkWalkieTalkieSignalServer server = new LinkWalkieTalkieSignalServer(
                getContext(), deviceManager.getMyCert(), deviceManager.getMyKey(), LinkTransport.WALKIE_TALKIE_PORT,
                new LinkWalkieTalkieSignalServer.Listener() {
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

    @PluginMethod
    public void stopWalkieTalkieGuestListener(PluginCall call) {
        if (sWalkieTalkieGuestServer != null) {
            try { sWalkieTalkieGuestServer.stop(); } catch (Exception ignored) {}
            sWalkieTalkieGuestServer = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void acceptWalkieTalkieGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) sWalkieTalkieGuestServer.acceptGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void rejectWalkieTalkieGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) sWalkieTalkieGuestServer.rejectGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void blockWalkieTalkieGuest(PluginCall call) {
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
    @PluginMethod
    public void kickWalkieTalkieGuest(PluginCall call) {
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
    @PluginMethod
    public void blockWalkieTalkieMember(PluginCall call) {
        String deviceId = call.getString("deviceId");
        String label = call.getString("label", deviceId);
        if (deviceId != null) {
            String ip = deviceManager != null ? deviceManager.remoteAddressOf(deviceId) : null;
            LinkBlocklist.add(getContext(), deviceId, label, "device", null, ip);
        }
        call.resolve();
    }

    @PluginMethod
    public void sendWalkieTalkieGuestSignal(PluginCall call) {
        String connId = call.getString("connId");
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (sWalkieTalkieGuestServer != null && connId != null && type != null) {
            sWalkieTalkieGuestServer.sendTo(connId, type, bodyStr);
        }
        call.resolve();
    }

    // --- Guest-side (us joining someone else's session via manual IP, unpaired) ---
    @PluginMethod
    public void joinWalkieTalkieGuest(PluginCall call) {
        String host = call.getString("host");
        if (deviceManager == null || host == null) {
            call.resolve();
            return;
        }
        if (sWalkieTalkieGuestClient != null) sWalkieTalkieGuestClient.disconnect();
        LinkWalkieTalkieSignalClient client = new LinkWalkieTalkieSignalClient(new LinkWalkieTalkieSignalClient.Listener() {
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

    @PluginMethod
    public void leaveWalkieTalkieGuest(PluginCall call) {
        if (sWalkieTalkieGuestClient != null) {
            sWalkieTalkieGuestClient.disconnect();
            sWalkieTalkieGuestClient = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void sendWalkieTalkieGuestMessage(PluginCall call) {
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

    @PluginMethod
    public void toggleFlashlight(PluginCall call) {
        boolean res = LinkFlashlight.toggle(getContext());
        LinkPacket packet = LinkFlashlight.createStatusPacket(res);
        if (deviceManager != null) {
            broadcastToPermittedPeers("flashlight", packet);
        }
        JSObject ret = new JSObject();
        ret.put("enabled", res);
        call.resolve(ret);
    }

    @PluginMethod
    public void setDnd(PluginCall call) {
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

    @PluginMethod
    public void checkDndPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", LinkDND.isDndGranted(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void requestDndPermission(PluginCall call) {
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

    @PluginMethod
    public void sendFlashlightToggle(PluginCall call) {
        String deviceId = call.getString("deviceId");
        boolean enabled = call.getBoolean("enabled", false);
        if (deviceManager != null && deviceId != null) {
            deviceManager.sendTo(deviceId, LinkFlashlight.createCommandPacket(enabled));
        }
        call.resolve();
    }

    // ===== Audio Relay (host + listener) =====
    @PluginMethod
    public void joinAudioSinkGuest(PluginCall call) {
        String host = call.getString("host");
        if (host == null || deviceManager == null) {
            call.reject("Missing host, or not initialized");
            return;
        }
        startAudioSinkListener(host, null);
        call.resolve();
    }

    @PluginMethod
    public void joinAudioSinkPaired(PluginCall call) {
        String host = call.getString("host");
        String token = call.getString("token");
        if (host == null || token == null || deviceManager == null) {
            call.reject("Missing host/token, or not initialized");
            return;
        }
        startAudioSinkListener(host, token);
        call.resolve();
    }

    @PluginMethod
    public void leaveAudioSink(PluginCall call) {
        if (sAudioSinkClient != null) {
            sAudioSinkClient.disconnect();
            sAudioSinkClient = null;
        }
        sAudioSinkHostLabel = "";
        updateSessionNotification();
        call.resolve();
    }

    @PluginMethod
    public void setAudioSinkListenerVolume(PluginCall call) {
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
    @PluginMethod
    public void queryAudioSinkSessions(PluginCall call) {
        if (deviceManager != null) {
            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                deviceManager.sendTo(peerId, new LinkPacket("link.audiosink.query", new JSONObject()));
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void setAudioSinkMuted(PluginCall call) {
        Boolean muted = call.getBoolean("muted");
        if (sAudioSinkServer != null && muted != null) sAudioSinkServer.setMuted(muted);
        updateSessionNotification();
        call.resolve();
    }

    @PluginMethod
    public void acceptAudioSinkGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.acceptGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void rejectAudioSinkGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.rejectGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void blockAudioSinkGuest(PluginCall call) {
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

    @PluginMethod
    public void kickAudioSinkListener(PluginCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.kickListener(connId);
        call.resolve();
    }

    @PluginMethod
    public void blockAudioSinkListener(PluginCall call) {
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

    @PluginMethod
    public void getAudioSinkListeners(PluginCall call) {
        JSObject ret = new JSObject();
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
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
    @PluginMethod
    public void getAudioSinkStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("hosting", sAudioSinkServer != null);
        ret.put("listening", sAudioSinkClient != null);
        ret.put("hostLabel", sAudioSinkHostLabel);
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
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

    @PluginMethod
    public void endAudioSink(PluginCall call) {
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
    @PluginMethod
    public void startAudioSink(PluginCall call) {
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
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "onRecordAudioPermissionResult");
            return;
        }
        launchMediaProjectionConsent(call);
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void onRecordAudioPermissionResult(PluginCall call) {
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Microphone permission denied");
            call.resolve(ret);
            return;
        }
        launchMediaProjectionConsent(call);
    }

    private void launchMediaProjectionConsent(PluginCall call) {
        android.media.projection.MediaProjectionManager mgr =
            (android.media.projection.MediaProjectionManager) getContext().getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE);
        android.content.Intent intent = mgr.createScreenCaptureIntent();
        startActivityForResult(call, intent, "onMediaProjectionResult");
    }

    @com.getcapacitor.annotation.ActivityCallback
    private void onMediaProjectionResult(PluginCall call, androidx.activity.result.ActivityResult result) {
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

    @PluginMethod
    public void startRemoteMic(PluginCall call) {
        if (sRemoteMicServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "onRecordAudioPermissionResultMic");
            return;
        }
        launchRemoteMic(call);
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void onRecordAudioPermissionResultMic(PluginCall call) {
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Microphone permission denied");
            call.resolve(ret);
            return;
        }
        launchRemoteMic(call);
    }

    private void launchRemoteMic(PluginCall call) {
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
    @PluginMethod
    public void setRemoteMicMuted(PluginCall call) {
        Boolean muted = call.getBoolean("muted");
        if (sRemoteMicServer != null && muted != null) sRemoteMicServer.setMuted(muted);
        updateSessionNotification();
        call.resolve();
    }

    @PluginMethod
    public void acceptRemoteMicGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.acceptGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void rejectRemoteMicGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.rejectGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void blockRemoteMicGuest(PluginCall call) {
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

    @PluginMethod
    public void kickRemoteMicListener(PluginCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.kickListener(connId);
        call.resolve();
    }

    @PluginMethod
    public void blockRemoteMicListener(PluginCall call) {
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

    @PluginMethod
    public void getRemoteMicListeners(PluginCall call) {
        JSObject ret = new JSObject();
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
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
    @PluginMethod
    public void getRemoteMicStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("hosting", sRemoteMicServer != null);
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
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

    @PluginMethod
    public void endRemoteMic(PluginCall call) {
        stopRemoteMicHosting();
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
    @PluginMethod
    public void pickPortalFiles(PluginCall call) {
        android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        intent.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.setType("*/*");
        startActivityForResult(call, intent, "onPortalFilesPicked");
    }

    @com.getcapacitor.annotation.ActivityCallback
    private void onPortalFilesPicked(PluginCall call, androidx.activity.result.ActivityResult result) {
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
        com.getcapacitor.JSArray uriStrings = new com.getcapacitor.JSArray();
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

    @PluginMethod
    public void startPortalReceive(PluginCall call) {
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
            LinkPortalTransferServer server = new LinkPortalTransferServer(
                getContext(), deviceManager.getMyCert(), deviceManager.getMyKey(), LinkTransport.PORTAL_TRANSFER_PORT,
                myIdentity != null ? myIdentity.deviceName : "Device",
                new LinkPortalTransferServer.Listener() {
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

    @PluginMethod
    public void acceptPortalGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) sPortalTransferServer.acceptGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void rejectPortalGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) sPortalTransferServer.rejectGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void blockPortalGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) {
            String ip = sPortalTransferServer.getPendingGuestRemoteAddress(connId);
            String name = sPortalTransferServer.getPendingGuestDeviceName(connId);
            if (ip != null) blockUntrustedGuest(ip, name);
            sPortalTransferServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @PluginMethod
    public void endPortalReceive(PluginCall call) {
        if (sPortalTransferServer != null) {
            try { sPortalTransferServer.stop(); } catch (Exception ignored) {}
            sPortalTransferServer = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void joinPortalGuest(PluginCall call) {
        String host = call.getString("host");
        com.getcapacitor.JSArray uriStrings = call.getArray("uris");
        if (host == null || deviceManager == null) {
            call.resolve();
            return;
        }
        java.util.List<android.net.Uri> fileUris = new java.util.ArrayList<>();
        if (uriStrings != null) {
            try {
                for (int i = 0; i < uriStrings.length(); i++) {
                    fileUris.add(android.net.Uri.parse(uriStrings.getString(i)));
                }
            } catch (Exception e) {
                call.resolve();
                return;
            }
        }

        if (sPortalTransferClient != null && sPortalTransferClient.isConnected()) {
            if (fileUris.size() > 0) {
                new Thread(() -> {
                    if (sPortalTransferClient != null) {
                        sPortalTransferClient.sendFiles(getContext(), fileUris);
                    }
                }, "link-portal-send").start();
            }
            call.resolve();
            return;
        }

        if (sPortalTransferClient != null) sPortalTransferClient.disconnect();
        LinkPortalTransferClient client = new LinkPortalTransferClient(new LinkPortalTransferClient.Listener() {
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
                if (fileUris.size() > 0) {
                    // Runs the actual send on a dedicated thread — sendFiles() blocks on file I/O and
                    // WebSocketClient.send()'s underlying socket write, same reasoning as every other
                    // blocking network call in this codebase (see e.g. connectToPeer()).
                    new Thread(() -> {
                        if (sPortalTransferClient != null) {
                            sPortalTransferClient.sendFiles(getContext(), fileUris);
                        }
                    }, "link-portal-send").start();
                }
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

    @PluginMethod
    public void leavePortalSend(PluginCall call) {
        if (sPortalTransferClient != null) {
            sPortalTransferClient.disconnect();
            sPortalTransferClient = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void getPortalStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("receiving", sPortalTransferServer != null);
        ret.put("sending", sPortalTransferClient != null);
        // See LinkPortalTransferServer.hasActiveTransfer()'s comment — distinct from `receiving`,
        // which reflects "Receive Files" mode being armed at all, not whether anything is
        // actually transferring right now.
        ret.put("transferring", sPortalTransferServer != null && sPortalTransferServer.hasActiveTransfer());
        call.resolve(ret);
    }

    /** Settings -> Biometric Unlock: reports whether this device has usable biometric hardware
     *  AND at least one fingerprint/face enrolled. BIOMETRIC_STRONG only (not DEVICE_CREDENTIAL) —
     *  a PIN/pattern fallback is already handled entirely in JS by the existing app PIN-lock
     *  screen, so this only needs to answer "can I show a fingerprint/face prompt at all." */
    @PluginMethod
    public void checkBiometricAvailable(PluginCall call) {
        androidx.biometric.BiometricManager manager = androidx.biometric.BiometricManager.from(getContext());
        int result = manager.canAuthenticate(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG);
        JSObject ret = new JSObject();
        ret.put("available", result == androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(ret);
    }

    /** Shows the system fingerprint/face prompt and resolves once the user succeeds, cancels, or
     *  fails — never rejects, matching this codebase's convention of resolving with a
     *  success/error shape (see e.g. startAudioSink) rather than throwing across the JS bridge.
     *  Must run on the UI thread (BiometricPrompt requirement); the callback then hops back onto
     *  it too since PluginCall.resolve() is safe from any thread but the Handler inside
     *  BiometricPrompt's callback already delivers on the main thread by contract. */
    @PluginMethod
    public void authenticateBiometric(PluginCall call) {
        androidx.fragment.app.FragmentActivity activity = (androidx.fragment.app.FragmentActivity) getActivity();
        if (activity == null) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("error", "No activity available");
            call.resolve(ret);
            return;
        }

        androidx.biometric.BiometricPrompt.PromptInfo promptInfo = new androidx.biometric.BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock Link")
                .setSubtitle("Use your fingerprint or face to continue")
                .setNegativeButtonText("Use PIN instead")
                .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .build();

        activity.runOnUiThread(() -> {
            androidx.biometric.BiometricPrompt prompt = new androidx.biometric.BiometricPrompt(
                    activity,
                    androidx.core.content.ContextCompat.getMainExecutor(getContext()),
                    new androidx.biometric.BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(androidx.biometric.BiometricPrompt.AuthenticationResult result) {
                            JSObject ret = new JSObject();
                            ret.put("success", true);
                            call.resolve(ret);
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, CharSequence errString) {
                            JSObject ret = new JSObject();
                            ret.put("success", false);
                            ret.put("error", errString != null ? errString.toString() : ("error " + errorCode));
                            call.resolve(ret);
                        }

                        @Override
                        public void onAuthenticationFailed() {
                            // A single rejected fingerprint/face — NOT terminal, BiometricPrompt keeps
                            // showing the same dialog for further attempts. Only onAuthenticationError
                            // (user cancels, too many attempts, etc.) actually closes the prompt.
                        }
                    });
            prompt.authenticate(promptInfo);
        });
    }

    /** Fallback for the hardware back button when no in-app view claims it (see MainActivity's
     *  onBackPressed() and the renderer's backNav.ts) — sends the app to background the same way
     *  the OS default back-at-root behavior would, without killing the process. */
    @PluginMethod
    public void minimizeApp(PluginCall call) {
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
        });
        sAudioSinkClient.connect(host, LinkTransport.AUDIO_RELAY_PORT, deviceManager.getMyCert(), deviceManager.getMyKey(), token, myIdentity != null ? myIdentity.deviceName : "Guest");
    }

    @PluginMethod
    public void sendDndSet(PluginCall call) {
        String deviceId = call.getString("deviceId");
        boolean enabled = call.getBoolean("enabled", false);
        if (deviceManager != null && deviceId != null) {
            deviceManager.sendTo(deviceId, LinkDND.createCommandPacket(enabled));
        }
        call.resolve();
    }

    @PluginMethod
    public void checkDeviceAdmin(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("active", LinkLock.isAdminActive(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void requestDeviceAdmin(PluginCall call) {
        // Toggling this off when already active: re-firing ACTION_ADD_DEVICE_ADMIN for an
        // already-active admin doesn't lead anywhere useful (no revoke UI), so deactivate directly
        // instead — see LinkLock.deactivate()'s comment for why that's safe to do with no prompt.
        if (LinkLock.isAdminActive(getContext())) {
            LinkLock.deactivate(getContext());
            call.resolve();
            return;
        }
        android.content.ComponentName cn = new android.content.ComponentName(getContext(), LinkDeviceAdminReceiver.class);
        android.content.Intent intent = new android.content.Intent(android.app.admin.DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
        intent.putExtra(android.app.admin.DevicePolicyManager.EXTRA_DEVICE_ADMIN, cn);
        intent.putExtra(android.app.admin.DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Enables remote locking of your device from paired PCs or mobile devices.");
        if (getActivity() != null) {
            getActivity().startActivity(intent);
        } else {
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
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

    /** Lower = tried first — mirrors desktop main.ts's localIpPriority. */
    private static int localIpPriority(String address, String ifaceNameLower) {
        if (address.startsWith(ANDROID_HOTSPOT_SUBNET_PREFIX)) return 0;
        if (ifaceNameLower.contains("wlan") || ifaceNameLower.contains("wifi")) return 1;
        return 2;
    }

    private String getLocalIpAddress() {
        try {
            String best = null;
            int bestPriority = Integer.MAX_VALUE;
            for (java.net.NetworkInterface intf : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
                String lowerName = intf.getName() == null ? "" : intf.getName().toLowerCase();
                for (java.net.InetAddress addr : java.util.Collections.list(intf.getInetAddresses())) {
                    if (addr.isLoopbackAddress() || !(addr instanceof java.net.Inet4Address)) continue;
                    int priority = localIpPriority(addr.getHostAddress(), lowerName);
                    if (priority < bestPriority) {
                        bestPriority = priority;
                        best = addr.getHostAddress();
                        if (bestPriority == 0) return best; // can't do better than the hotspot subnet
                    }
                }
            }
            if (best != null) return best;
        } catch (Exception ex) {
            android.util.Log.e(TAG, "Error getting IP address", ex);
        }
        return "127.0.0.1";
    }

    @Override
    protected void handleOnDestroy() {
        if (discoveryWatcher != null) {
            discoveryWatcher.stop();
            discoveryWatcher = null;
        }
        if (sDiscoveryWatcher != null) {
            sDiscoveryWatcher.stop();
            sDiscoveryWatcher = null;
        }
        sDiscoveredPeers.clear();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getDiscoveredDevices(PluginCall call) {
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        for (JSObject obj : sDiscoveredPeers.values()) {
            arr.put(obj);
        }
        JSObject ret = new JSObject();
        ret.put("devices", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void getIdentity(PluginCall call) {
        JSObject data = new JSObject();
        data.put("deviceId", myIdentity.deviceId);
        data.put("deviceName", myIdentity.deviceName);
        data.put("deviceType", myIdentity.deviceType);
        data.put("ipAddress", getLocalIpAddress());
        call.resolve(data);
    }

    @PluginMethod
    public void getVisibility(PluginCall call) {
        android.content.SharedPreferences prefs = getContext().getSharedPreferences("link_prefs", android.content.Context.MODE_PRIVATE);
        boolean visibility = prefs.getBoolean("discovery_visibility", false);
        JSObject data = new JSObject();
        data.put("enabled", visibility);
        call.resolve(data);
    }

    @PluginMethod
    public void setVisibility(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        android.content.SharedPreferences prefs = getContext().getSharedPreferences("link_prefs", android.content.Context.MODE_PRIVATE);
        prefs.edit().putBoolean("discovery_visibility", enabled).apply();
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

    @PluginMethod
    public void connectTo(PluginCall call) {
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

    @PluginMethod
    public void requestPairing(PluginCall call) {
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

        // @PluginMethod calls already run off the main/UI thread (see connectTo() above, which
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

    @PluginMethod
    public void requestPairingByIp(PluginCall call) {
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

    @PluginMethod
    public void acceptPairing(PluginCall call) {
        deviceManager.acceptPairing(call.getString("deviceId"));
        call.resolve();
    }

    @PluginMethod
    public void cancelPairing(PluginCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceManager != null && deviceId != null) {
            deviceManager.cancelPairing(deviceId);
        }
        call.resolve();
    }

    @PluginMethod
    public void rejectPairing(PluginCall call) {
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

    @PluginMethod
    public void getBlocklist(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("entries", new com.getcapacitor.JSArray(LinkBlocklist.getAll(getContext()).toString()));
        } catch (Exception ignored) {}
        call.resolve(ret);
    }

    @PluginMethod
    public void blockDevice(PluginCall call) {
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

    @PluginMethod
    public void unblockDevice(PluginCall call) {
        String id = call.getString("id");
        if (id != null) LinkBlocklist.remove(getContext(), id);
        getBlocklist(call);
    }

    @PluginMethod
    public void unpair(PluginCall call) {
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

    @PluginMethod
    public void exitPool(PluginCall call) {
        if (deviceManager != null) {
            LinkTrustStore store = new LinkTrustStore(getContext());
            for (LinkTrustStore.TrustedDevice d : store.list()) {
                deviceManager.unpair(d.deviceId);
            }
        }
        call.resolve();
    }


    @PluginMethod
    public void getTrustedDevices(PluginCall call) {
        try {
            LinkTrustStore store = new LinkTrustStore(getContext());
            com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
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
    @PluginMethod
    public void resyncDevices(PluginCall call) {
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
    @PluginMethod
    public void getPermissions(PluginCall call) {
        JSObject result = new JSObject();
        try {
            result = new JSObject(LinkDevicePermissions.getAll(getContext()).toString());
        } catch (Exception ignored) {}
        call.resolve(result);
    }

    @PluginMethod
    public void setPermissions(PluginCall call) {
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
    @PluginMethod
    public void getConnectedDevices(PluginCall call) {
        try {
            com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
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
                    obj.put("incomingCapabilities", new com.getcapacitor.JSArray(info.identity.incomingCapabilities));
                    obj.put("outgoingCapabilities", new com.getcapacitor.JSArray(info.identity.outgoingCapabilities));
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

    @PluginMethod
    public void renameTrustedDevice(PluginCall call) {
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

    @PluginMethod
    public void sendFindMyDevice(PluginCall call) {
        String deviceId = call.getString("deviceId");
        deviceManager.sendTo(deviceId, LinkFindMyDevice.createPacket());
        call.resolve();
    }

    @PluginMethod
    public void sendFindMyPhone(PluginCall call) {
        sendFindMyDevice(call);
    }

    @PluginMethod
    public void stopFindMyDevice(PluginCall call) {
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

    @PluginMethod
    public void stopFindMyPhone(PluginCall call) {
        stopFindMyDevice(call);
    }

    @PluginMethod
    public void triggerCommand(PluginCall call) {
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


    @PluginMethod
    public void sendRemoteInput(PluginCall call) {
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

    @PluginMethod
    public void sendPresenterMove(PluginCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "pmove " + dx + " " + dy);
        call.resolve();
    }

    // Presenter/digitizer "Switch Screen" — cycle which monitor the peer targets for the absolute-
    // positioned features. Sent over TCP (reliable) since it's a rare control action, not a
    // high-rate move; the desktop handles it in main.ts's packet router (link.target.display).
    @PluginMethod
    public void cycleTargetDisplay(PluginCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceManager != null && deviceId != null) {
            try {
                deviceManager.sendTo(deviceId, new LinkPacket("link.target.display", new org.json.JSONObject()));
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @PluginMethod
    public void checkOverlayPermission(PluginCall call) {
        JSObject data = new JSObject();
        data.put("enabled", LinkPresenterOverlay.isPermissionGranted(getContext()));
        call.resolve(data);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        LinkPresenterOverlay.requestPermission(getContext());
        call.resolve();
    }

    @PluginMethod
    public void sendSetVolume(PluginCall call) {
        String deviceId = call.getString("deviceId");
        String sinkName = call.getString("name", "default");
        int volume = call.getInt("volume", 0);
        deviceManager.sendTo(deviceId, LinkSystemVolume.createSetVolumePacket(sinkName, volume));
        call.resolve();
    }

    @PluginMethod
    public void sendSetMute(PluginCall call) {
        String deviceId = call.getString("deviceId");
        String sinkName = call.getString("name", "default");
        boolean muted = call.getBoolean("muted", false);
        deviceManager.sendTo(deviceId, LinkSystemVolume.createSetMutePacket(sinkName, muted));
        call.resolve();
    }

    @PluginMethod
    public void sendPresenterStop(PluginCall call) {
        String deviceId = call.getString("deviceId");
        deviceManager.sendTo(deviceId, LinkPresenter.createStopPacket());
        call.resolve();
    }

    @PluginMethod
    public void sendLockRequest(PluginCall call) {
        String deviceId = call.getString("deviceId");
        boolean setLocked = call.getBoolean("setLocked", true);
        deviceManager.sendTo(deviceId, LinkLock.createLockRequestPacket(setLocked, null));
        call.resolve();
    }

    @PluginMethod
    public void sendLockQuery(PluginCall call) {
        String deviceId = call.getString("deviceId");
        deviceManager.sendTo(deviceId, LinkLock.createLockRequestPacket(null, true));
        call.resolve();
    }

    @PluginMethod
    public void checkNotificationAccess(PluginCall call) {
        boolean enabled = androidx.core.app.NotificationManagerCompat
                .getEnabledListenerPackages(getContext())
                .contains(getContext().getPackageName());
        JSObject data = new JSObject();
        data.put("enabled", enabled);
        call.resolve(data);
    }

    @PluginMethod
    public void requestNotificationAccess(PluginCall call) {
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
    // it. This isn't a normal runtime permission Capacitor's checkPermissions/requestPermissions
    // can grant — it only has a user-facing toggle in a dedicated Settings screen, same pattern
    // as notification access above.
    @PluginMethod
    public void checkAllFilesAccess(PluginCall call) {
        boolean enabled = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R
                || android.os.Environment.isExternalStorageManager();
        JSObject data = new JSObject();
        data.put("enabled", enabled);
        call.resolve(data);
    }

    @PluginMethod
    public void checkDndAccess(PluginCall call) {
        boolean granted = LinkDND.isDndGranted(getContext());
        JSObject data = new JSObject();
        data.put("granted", granted);
        call.resolve(data);
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
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

    @PluginMethod
    public void requestDndAccess(PluginCall call) {
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

    @PluginMethod
    public void openAppSettings(PluginCall call) {
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

    @PluginMethod
    public void sendMouseMove(PluginCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "move " + dx + " " + dy);
        call.resolve();
    }

    @PluginMethod
    public void sendSpecialKey(PluginCall call) {
        String deviceId = call.getString("deviceId");
        int specialKey = call.getInt("specialKey", 0);
        sendUdpMessage(deviceId, "special " + specialKey);
        call.resolve();
    }

    @PluginMethod
    public void sendMouseClick(PluginCall call) {
        String deviceId = call.getString("deviceId");
        String clickType = call.getString("clickType", "left");
        sendUdpMessage(deviceId, "click " + clickType);
        call.resolve();
    }

    @PluginMethod
    public void sendMouseDrag(PluginCall call) {
        String deviceId = call.getString("deviceId");
        boolean hold = call.getBoolean("hold", false);
        sendUdpMessage(deviceId, hold ? "hold left" : "release left");
        call.resolve();
    }

    @PluginMethod
    public void sendMouseScroll(PluginCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "scroll " + dx + " " + dy);
        call.resolve();
    }

    @PluginMethod
    public void sendMprisAction(PluginCall call) {
        String deviceId = call.getString("deviceId");
        String player = call.getString("player", "Global Media Control");
        String action = call.getString("action");
        deviceManager.sendTo(deviceId, LinkMpris.createActionPacket(player, action));
        call.resolve();
    }

    @PluginMethod
    public void renameDevice(PluginCall call) {
        String newName = call.getString("name");
        String applied = LinkIdentity.saveDeviceName(getContext(), newName);
        try {
            myIdentity = LinkIdentity.loadOrCreate(getContext(), CAPABILITIES, CAPABILITIES);
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

    @PluginMethod
    public void sendDigitizerSession(PluginCall call) {
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

    @PluginMethod
    public void sendDigitizerEvent(PluginCall call) {
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
    @PluginMethod
    public void sendDigitizerAction(PluginCall call) {
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
    @PluginMethod
    public void sendJoystickHello(PluginCall call) {
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
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), myIdentity.deviceId);
            sJoystickClient.connect(host, LinkTransport.JOYSTICK_PORT, name, tls.certificate, tls.privateKey);
        }
        call.resolve();
    }

    @PluginMethod
    public void sendJoystickBye(PluginCall call) {
        if (sJoystickClient != null) {
            sJoystickClient.disconnect();
            sJoystickClient = null;
        }
        call.resolve();
    }

    /** High-frequency (~60Hz) stick/button/trigger state — raw UDP, no TLS envelope, addressed
     *  directly to `host` (not a paired deviceId — see sendJoystickHello above). See joystick.ts
     *  for the desktop-side parser and the exact "js lx ly rx ry lt rt buttons" field layout. */
    @PluginMethod
    public void sendJoystickState(PluginCall call) {
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
     *  "rumble " branch, which fires from a background socket thread with no pending PluginCall
     *  to resolve) and for JoystickOverlay.tsx's local button-press tap feedback. */
    @PluginMethod
    public void vibrate(PluginCall call) {
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

    @PluginMethod
    public void isBatteryOptimizationIgnored(PluginCall call) {
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

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
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
    @PluginMethod
    public void checkAccessibility(PluginCall call) {
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

    @PluginMethod
    public void requestAccessibility(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to launch accessibility settings", e);
        }
        call.resolve();
    }

    @PluginMethod
    public void runSpeedTest(PluginCall call) {
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

        // Launches the invisible SendClipboardActivity rather than firing a plain broadcast.
        // Android 10+ denies clipboard reads to apps not currently in focus, and a broadcast
        // receiver fired by tapping a notification action never counts as "in focus" — confirmed
        // via logcat: the receiver DID fire, but ClipboardManager.getPrimaryClip() came back
        // denied ("application is not in focus"). A no-UI Activity briefly puts the app in focus,
        // which satisfies that check; see SendClipboardActivity for the read/send/finish logic.
        android.content.Intent sendIntent = new android.content.Intent(context, SendClipboardActivity.class);
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

    private java.net.DatagramSocket inputUdpSocket;

    // Receiving half of the high-speed raw UDP input relay (port 1717) — mirrors desktop
    // main.ts's inputUdpSocket listener. Only "pmove"/"pstop" (presenter) are handled here;
    // touchpad/digitizer stay desktop-target-only for now (see PLUGIN_REGISTRY comment on
    // desktop's DeviceControlPanel.tsx). Sender is identified by source IP against the trusted+
    // connected peer list, same trust boundary as the TCP session packets (no envelope/deviceId
    // of its own, so this can't just reuse the TLS-authenticated onPacket path).
    private void startInputUdpServer() {
        new Thread(() -> {
            try {
                inputUdpSocket = new java.net.DatagramSocket(1717, java.net.InetAddress.getByName("0.0.0.0"));
                android.util.Log.i(TAG, "High-speed UDP Input Relay listening on port 1717");
                byte[] buf = new byte[1024];
                while (inputUdpSocket != null && !inputUdpSocket.isClosed()) {
                    java.net.DatagramPacket packet = new java.net.DatagramPacket(buf, buf.length);
                    inputUdpSocket.receive(packet);
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
                    }

                    String senderId = deviceManager != null ? deviceManager.deviceIdForAddress(senderIp) : null;
                    if (senderId == null) continue;

                    // Explicit stop travels over the reliable TCP channel instead (see
                    // handlePresenterPacket) — only continuous moves need this low-latency path.
                    if (line.startsWith("pmove ")) {
                        if (!LinkDevicePermissions.check(getContext(), senderId, "presenter")) continue;
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
                            data.put("deviceId", senderId);
                            data.put("dx", dx);
                            data.put("dy", dy);
                            notifyListeners("presenterPositionReceived", data);
                        }
                    } else if (line.startsWith("dig ")) {
                        if (!LinkDevicePermissions.check(getContext(), senderId, "digitizer")) continue;
                        String[] parts = line.split(" ");
                        int x = Integer.parseInt(parts[1]);
                        int y = Integer.parseInt(parts[2]);
                        boolean touching = Boolean.parseBoolean(parts[3]);

                        JSObject data = new JSObject();
                        data.put("deviceId", senderId);
                        data.put("x", x);
                        data.put("y", y);
                        data.put("touching", touching);
                        data.put("active", true);
                        notifyListeners("digitizerEventReceived", data);
                    }
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "UDP Input Relay error", e);
            }
        }, "udp-input-listener").start();
    }

    private void sendUdpMessage(String deviceId, String message) {
        if (deviceManager == null || deviceId == null) return;
        String ip = deviceManager.remoteAddressOf(deviceId);
        if (ip == null) return;

        new Thread(() -> {
            try (java.net.DatagramSocket socket = new java.net.DatagramSocket()) {
                byte[] buffer = message.getBytes("UTF-8");
                java.net.InetAddress address = java.net.InetAddress.getByName(ip);
                java.net.DatagramPacket packet = new java.net.DatagramPacket(buffer, buffer.length, address, 1717);
                socket.send(packet);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to send UDP input message: " + message, e);
            }
        }, "udp-input-sender").start();
    }

    /** Same wire behavior as sendUdpMessage above, but addressed to a raw IP directly instead of
     *  resolving one from a paired deviceId — Joystick's only send path, since it has no pairing
     *  step at all (see sendJoystickHello's doc comment). */
    private void sendUdpMessageToHost(String host, String message) {
        new Thread(() -> {
            try (java.net.DatagramSocket socket = new java.net.DatagramSocket()) {
                byte[] buffer = message.getBytes("UTF-8");
                java.net.InetAddress address = java.net.InetAddress.getByName(host);
                java.net.DatagramPacket packet = new java.net.DatagramPacket(buffer, buffer.length, address, 1717);
                socket.send(packet);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to send UDP message to host " + host + ": " + message, e);
            }
        }, "udp-input-sender-host").start();
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

    private final java.util.Map<String, PluginCall> pendingFsCalls = new java.util.concurrent.ConcurrentHashMap<>();
    private int fsRequestCounter = 0;

    private void sendFsRequest(PluginCall call, String action, JSObject payload) {
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
                PluginCall pending = pendingFsCalls.remove(requestId);
                if (pending != null) {
                    pending.reject("FileSystem request timed out");
                }
            }, 30000);
        } catch (Exception e) {
            call.reject("Failed to send FS request: " + e.getMessage());
        }
    }

    @PluginMethod
    public void fsListRoots(PluginCall call) {
        sendFsRequest(call, "listRoots", null);
    }

    @PluginMethod
    public void fsReaddir(PluginCall call) {
        String path = call.getString("path");
        JSObject payload = new JSObject();
        payload.put("path", path);
        sendFsRequest(call, "readdir", payload);
    }

    @PluginMethod
    public void fsStat(PluginCall call) {
        String path = call.getString("path");
        JSObject payload = new JSObject();
        payload.put("path", path);
        sendFsRequest(call, "stat", payload);
    }

    @PluginMethod
    public void fsCreateDirectory(PluginCall call) {
        String path = call.getString("path");
        JSObject payload = new JSObject();
        payload.put("path", path);
        payload.put("isDirectory", true);
        sendFsRequest(call, "create", payload);
    }

    @PluginMethod
    public void fsDelete(PluginCall call) {
        String path = call.getString("path");
        JSObject payload = new JSObject();
        payload.put("path", path);
        sendFsRequest(call, "delete", payload);
    }

    @PluginMethod
    public void fsRename(PluginCall call) {
        String path = call.getString("path");
        String newPath = call.getString("newPath");
        JSObject payload = new JSObject();
        payload.put("path", path);
        payload.put("newPath", newPath);
        sendFsRequest(call, "rename", payload);
    }

    private void handleFsResponsePacket(LinkPacket packet) {
        try {
            org.json.JSONObject body = packet.body;
            String requestId = body.getString("requestId");
            PluginCall call = pendingFsCalls.remove(requestId);
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
}
