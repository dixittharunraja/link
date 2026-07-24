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
        // this in addition to the separate MediaProjection consent dialog (see startAudioRelay()).
        @Permission(
            alias = "microphone",
            strings = { Manifest.permission.RECORD_AUDIO }
        )
    }
)
public class LinkPlugin extends Plugin {
    private static final String TAG = "LinkPlugin";
    // link.digitizer.session/link.digitizer added — Android already sends these (sendDigitizerSession/
    // sendDigitizerEvent) but never declared the capability, so peers had no way to discover support.
    private static final String[] CAPABILITIES = {"link.clipboard", "link.clipboard.connect", "link.battery", "link.findmyphone.request", "link.runcommand", "link.runcommand.request", "link.presenter", "link.systemvolume", "link.systemvolume.request", "link.lock", "link.lock.request", "link.connectivity_report", "link.touchpad.request", "link.mpris", "link.mpris.request", "link.telephony", "link.notification", "link.notification.reply", "link.flashlight", "link.dnd", "link.rename", "link.rename.request", "link.digitizer.session", "link.digitizer"};

    // Mirrors desktop main.ts's ENABLED_PLUGINS kill-switch for the systematic re-verification
    // pass: everything in test.txt starts disabled so core connection (discovery/pairing/trust/
    // TLS) can be solidified in isolation first, then plugins re-enabled one at a time. Only gates
    // wiring in this file — no plugin's own logic (Link*.java) is touched. Speed Test, System
    // Volume, and MPRIS have graduated out of this — confirmed working, so their gates were
    // removed entirely rather than left toggled on here.
    private static final java.util.Set<String> ENABLED_PLUGINS = new java.util.HashSet<>(java.util.Arrays.asList(
        "Clipboard"
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
    private static LinkAudioRelayClient sAudioRelayClient;
    // Android-as-host counterpart to sAudioRelayClient above — same static-field reattach reason.
    // No non-static instance field is needed alongside it (nothing else in this class needs a
    // non-static handle), mirroring how sAudioRelayClient also has none.
    private static LinkAudioRelayServer sAudioRelayServer;
    private static LinkRemoteMicServer sRemoteMicServer;
    private LinkPacket lastTelephonyPacket = null;
    private String lastCallState = "";
    private String lastIncomingNumber = null;
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
    private final java.util.Map<String, LinkRepliableNotification> pendingReplies = new java.util.concurrent.ConcurrentHashMap<>();

    private LinkSpeedTest speedTest;
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
            if (sAudioRelayClient != null) {
                try {
                    sAudioRelayClient.disconnect();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error disconnecting previous AudioRelayClient", e);
                }
                sAudioRelayClient = null;
            }
            if (sAudioRelayServer != null) {
                try {
                    sAudioRelayServer.stop();
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Error stopping previous AudioRelayServer", e);
                }
                sAudioRelayServer = null;
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
                    // Was missing deviceType/incomingCapabilities/outgoingCapabilities entirely —
                    // App.tsx's onDeviceConnected handler falls back to an empty capabilities array
                    // when these are absent, which meant every capability-gated button (Ring, Lock,
                    // Presenter, Touchpad, Digitizer, ...) was silently hidden for every peer
                    // whenever viewed from mobile's own control panel, regardless of what that peer
                    // actually supports.
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
                public void onIncomingPairRequest(String deviceId, String verificationKey) {
                    JSObject data = new JSObject();
                    data.put("deviceId", deviceId);
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
                    } else if (LinkFindMyPhone.isFindMyPhonePacket(packet)) {
                        handleFindMyPhonePacket(deviceId, packet);
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
                    } else if ("link.audiorelay.started".equals(packet.type)) {
                        handleAudioRelayStartedPacket(deviceId, packet);
                    } else if ("link.audiorelay.ended".equals(packet.type)) {
                        handleAudioRelayEndedPacket(deviceId);
                    } else if ("link.audiorelay.query".equals(packet.type)) {
                        handleAudioRelayQueryPacket(deviceId);
                    } else if ("link.remotemic.started".equals(packet.type)) {
                        handleRemoteMicStartedPacket(deviceId, packet);
                    } else if ("link.remotemic.ended".equals(packet.type)) {
                        handleRemoteMicEndedPacket(deviceId);
                    } else if ("link.remotemic.query".equals(packet.type)) {
                        handleRemoteMicQueryPacket(deviceId);
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
                    lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
                    if (!isEnabled("Clipboard")) return;
                    for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                        if (!LinkDevicePermissions.canSendClipboardTo(getContext(), peerId)) continue;
                        try {
                            LinkPayloadTransfer.UploadHandle upload = LinkPayloadTransfer.startUpload(
                                    deviceManager.getMyCert(), deviceManager.getMyKey(), data,
                                    new LinkPayloadTransfer.UploadListener() {
                                        @Override
                                        public void onComplete() {
                                            android.util.Log.i(TAG, "Clipboard file upload completed");
                                        }

                                        @Override
                                        public void onError(Exception e) {
                                            android.util.Log.e(TAG, "Clipboard file upload failed", e);
                                        }
                                    });
                            LinkPacket packet = LinkClipboard.createClipboardFilePacket(filename);
                            packet.payloadTransferInfo = new org.json.JSONObject();
                            packet.payloadTransferInfo.put("port", upload.port);
                            deviceManager.sendTo(peerId, packet);
                        } catch (Exception e) {
                            android.util.Log.e(TAG, "Failed to upload clipboard file", e);
                        }
                    }
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
                                telephonyHandler.postDelayed(pendingRingingBroadcast, 350);
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

            deviceManager.startServer(LinkTransport.LINK_PORT);
            android.util.Log.i(TAG, "server started on port " + LinkTransport.LINK_PORT);

            discoveryWatcher = new LinkDiscovery.Watcher(getContext(), myIdentity, (ip, peer) -> {
                // Broadcasts repeat every ~5s while a peer stays undiscovered — without this
                // guard, a single slow/hung connect attempt (weak Wi-Fi, brief firewall stall)
                // used to get re-fired on every subsequent broadcast, stacking up overlapping
                // attempts to the same peer instead of just letting the one in flight finish or
                // time out. Combined with connectToPeer() now having an explicit timeout, a failed
                // attempt clears itself and the very next broadcast can retry cleanly.
                if (!deviceManager.hasPeer(peer.deviceId) && canAttemptConnect(peer.deviceId)
                        && connectingDeviceIds.add(peer.deviceId)) {
                    android.util.Log.i(TAG, "Discovered peer " + peer.deviceName + " at " + ip + ". Connecting...");
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
            });
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("link_prefs", android.content.Context.MODE_PRIVATE);
            boolean visibility = prefs.getBoolean("discovery_visibility", true);
            discoveryWatcher.start(visibility);
            sDiscoveryWatcher = discoveryWatcher;

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

    // Each packet type gets its own private handler below (previously one 290-line if-else chain
    // inside the deviceManager Listener's onPacket) — purely organizational, same instance fields/
    // methods accessible either way, identical dispatch order/logic, so behavior is unchanged.
    // Java has no local/nested method declarations (unlike the TS side's equivalent cleanup in
    // main.ts), so these live as private instance methods instead of closures.

    private void handleClipboardPacket(String deviceId, LinkPacket packet) {
        if (!isEnabled("Clipboard")) return;
        // No receive-side gate — Clipboard is sending-only now (see canSendClipboardTo): the
        // peer already decided whether to share via their own outbound permission-for-us.
        if (LinkClipboard.PACKET_TYPE_CLIPBOARD_FILE.equals(packet.type)) {
            new Thread(() -> {
                try {
                    String senderHost = deviceManager.remoteAddressOf(deviceId);
                    String expectedFingerprint = deviceManager.pinnedFingerprintOf(deviceId);
                    if (senderHost == null || expectedFingerprint == null) return;
                    org.json.JSONObject transferInfo = packet.payloadTransferInfo;
                    if (transferInfo == null || !transferInfo.has("port")) {
                        throw new Exception("clipboard.file packet missing port");
                    }
                    int port = transferInfo.getInt("port");
                    String filename = packet.body.getString("filename");
                    byte[] data = LinkPayloadTransfer.downloadPayload(
                            senderHost, port, deviceManager.getMyCert(), deviceManager.getMyKey(), expectedFingerprint);
                    clipboardWatcher.applyRemoteFile(getContext(), filename, data);
                    android.util.Log.i(TAG, "CLIPBOARD FILE RECEIVED: " + filename + " (" + data.length + " bytes)");
                    JSObject jsData = new JSObject();
                    jsData.put("deviceId", deviceId);
                    notifyListeners("clipboardReceived", jsData);
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Failed to receive clipboard file", e);
                }
            }, "link-clipboard-file-receive").start();
        } else {
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

    private void handleFindMyPhonePacket(String deviceId, LinkPacket packet) {
        // No kill-switch or per-device permission gate — ring is inherently available to any
        // connected, trusted device, same as rename.
        boolean cancel = packet.body.optBoolean("cancel", false);
        android.util.Log.i(TAG, "FIND MY PHONE (cancel=" + cancel + ") triggered by " + deviceId);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        if (cancel) {
            LinkFindMyPhone.stopRinging(getContext());
            activeRingerDeviceId = null;
            notifyListeners("findMyPhoneStopped", data);
        } else {
            activeRingerDeviceId = deviceId;
            LinkFindMyPhone.ring(getContext());
            notifyListeners("findMyPhoneTriggered", data);
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
        // This is the real executor — the actual enforcement point for "does this peer get to
        // control my flashlight."
        if (!LinkDevicePermissions.check(getContext(), deviceId, "flashlight")) {
            android.util.Log.i(TAG, "Blocked flashlight packet from " + deviceId + " (Permission disabled)");
            return;
        }
        boolean enabled = packet.body.optBoolean("enabled", false);
        LinkFlashlight.setTorchMode(getContext(), enabled);
        LinkPacket np = LinkFlashlight.createStatusPacket(enabled);
        // Outbound gate — a peer denied 'flashlight' shouldn't passively learn the resulting
        // state just because someone else (permitted) triggered it.
        broadcastToPermittedPeers("flashlight", np);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("enabled", enabled);
        notifyListeners("flashlightStateReceived", data);
    }

    private void handleDndPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "dnd")) {
            android.util.Log.i(TAG, "Blocked DND packet from " + deviceId + " (Permission disabled)");
            return;
        }
        // Without the OS-level "Do Not Disturb access" grant, setDnd() can't actually do
        // anything — silently drop instead of broadcasting a state nobody can act on. A's UI
        // just never sees this peer's DND controls at all, same as if the peer never supported
        // DND — it doesn't need to know why. The disclaimer to grant this lives on THIS
        // device's own Permissions tab, not in anything sent to peers.
        if (!LinkDND.isDndGranted(getContext())) return;
        boolean enabled = packet.body.optBoolean("enabled", false);
        LinkDND.setDnd(getContext(), enabled);
        LinkPacket np = LinkDND.createStatusPacket(getContext());
        broadcastToPermittedPeers("dnd", np);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("enabled", LinkDND.isDndEnabled(getContext()));
        data.put("granted", LinkDND.isDndGranted(getContext()));
        notifyListeners("dndStateReceived", data);
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

    private void handleAudioRelayStartedPacket(String deviceId, LinkPacket packet) {
        String token = packet.body.optString("token", null);
        String host = deviceManager != null ? deviceManager.remoteAddressOf(deviceId) : null;
        if (token == null || host == null) return;
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("token", token);
        data.put("host", host);
        notifyListeners("audioRelayPairedSessionStarted", data);
    }

    private void handleAudioRelayEndedPacket(String deviceId) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        notifyListeners("audioRelayPairedSessionEnded", data);
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

    /** Mirrors desktop main.ts's link.audiorelay.query handler exactly: if we're currently
     *  hosting, mint a fresh one-time token for the asking peer and reply — same mechanism used
     *  when a session first starts (see the token-issuing loop in onMediaProjectionResult()), just
     *  triggered by a peer opening its Audio Relay tab late instead of at session-start time. */
    private void handleAudioRelayQueryPacket(String deviceId) {
        if (sAudioRelayServer == null || deviceManager == null) return;
        if (!LinkDevicePermissions.check(getContext(), deviceId, "audiorelay")) return;
        String token = sAudioRelayServer.issueToken(deviceId, getDeviceDisplayName(deviceId));
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("port", LinkTransport.AUDIO_RELAY_PORT);
            deviceManager.sendTo(deviceId, new LinkPacket("link.audiorelay.started", body));
        } catch (Exception ignored) {}
    }

    private void handleRemoteMicStartedPacket(String deviceId, LinkPacket packet) {
        String token = packet.body.optString("token", null);
        String host = deviceManager != null ? deviceManager.remoteAddressOf(deviceId) : null;
        if (token == null || host == null) return;
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("token", token);
        data.put("host", host);
        notifyListeners("remoteMicPairedSessionStarted", data);
    }

    private void handleRemoteMicEndedPacket(String deviceId) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        notifyListeners("remoteMicPairedSessionEnded", data);
    }

    private void handleRemoteMicQueryPacket(String deviceId) {
        if (sRemoteMicServer == null || deviceManager == null) return;
        if (!LinkDevicePermissions.check(getContext(), deviceId, "audiorelay")) return;
        String token = sRemoteMicServer.issueToken(deviceId, getDeviceDisplayName(deviceId));
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
            deviceManager.sendTo(deviceId, new LinkPacket("link.remotemic.started", body));
        } catch (Exception ignored) {}
    }

    private void sendInitialSync(String deviceId) {
        if (deviceManager == null) return;
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
        // 7. DND
        if (LinkDND.isDndGranted(getContext()) && LinkDevicePermissions.check(getContext(), deviceId, "dnd")) {
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
            deviceManager.sendTo(deviceId, LinkFlashlight.createStatusPacket(enabled));
        }
        call.resolve();
    }

    // ===== Audio Relay (host + listener) =====
    @PluginMethod
    public void joinAudioRelayGuest(PluginCall call) {
        String host = call.getString("host");
        if (host == null || deviceManager == null) {
            call.reject("Missing host, or not initialized");
            return;
        }
        startAudioRelayListener(host, null);
        call.resolve();
    }

    @PluginMethod
    public void joinAudioRelayPaired(PluginCall call) {
        String host = call.getString("host");
        String token = call.getString("token");
        if (host == null || token == null || deviceManager == null) {
            call.reject("Missing host/token, or not initialized");
            return;
        }
        startAudioRelayListener(host, token);
        call.resolve();
    }

    @PluginMethod
    public void leaveAudioRelay(PluginCall call) {
        if (sAudioRelayClient != null) {
            sAudioRelayClient.disconnect();
            sAudioRelayClient = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void setAudioRelayListenerVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        if (sAudioRelayClient != null && volume != null) {
            sAudioRelayClient.setVolume(volume.floatValue());
        }
        call.resolve();
    }

    /** Called once when the Audio Relay tab opens — the one-shot 'link.audiorelay.started'
     *  broadcast a host sends only ever reaches a peer that was connected AND had this screen
     *  open at that exact moment, with no way to catch up otherwise. Handled symmetrically by
     *  handleAudioRelayQueryPacket() above when THIS device is the one being asked. */
    @PluginMethod
    public void queryAudioRelaySessions(PluginCall call) {
        if (deviceManager != null) {
            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                deviceManager.sendTo(peerId, new LinkPacket("link.audiorelay.query", new JSONObject()));
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void acceptAudioRelayGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sAudioRelayServer != null && connId != null) sAudioRelayServer.acceptGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void rejectAudioRelayGuest(PluginCall call) {
        String connId = call.getString("connId");
        if (sAudioRelayServer != null && connId != null) sAudioRelayServer.rejectGuest(connId);
        call.resolve();
    }

    @PluginMethod
    public void setAudioRelayMuted(PluginCall call) {
        Boolean muted = call.getBoolean("muted");
        if (sAudioRelayServer != null && muted != null) sAudioRelayServer.setMuted(muted);
        call.resolve();
    }

    @PluginMethod
    public void kickAudioRelayListener(PluginCall call) {
        String connId = call.getString("connId");
        if (sAudioRelayServer != null && connId != null) sAudioRelayServer.kickListener(connId);
        call.resolve();
    }

    @PluginMethod
    public void getAudioRelayListeners(PluginCall call) {
        JSObject ret = new JSObject();
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        if (sAudioRelayServer != null) {
            for (LinkAudioRelayServer.ListenerInfo l : sAudioRelayServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    // Was missing from the mobile bridge entirely — AudioRelayTab.tsx queries this on every
    // mount to restore "currently hosting"/"currently listening" state (e.g. after the tab was
    // closed and reopened), so without it the UI always fell back to the fresh idle screen even
    // mid-session. Mirrors desktop main.ts's 'get-audio-relay-status' handler: mobile is never a
    // listener for its own hosted Audio Relay session (this device only ever hosts OR joins
    // someone else's, never both), so "listening" here can't currently be true, but the shape
    // matches the desktop response for a consistent contract either way.
    @PluginMethod
    public void getAudioRelayStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("hosting", sAudioRelayServer != null);
        ret.put("listening", sAudioRelayClient != null);
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        if (sAudioRelayServer != null) {
            for (LinkAudioRelayServer.ListenerInfo l : sAudioRelayServer.listenersSnapshot()) {
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
    public void endAudioRelay(PluginCall call) {
        stopAudioRelayHosting();
        call.resolve();
    }

    /** Shared teardown for both the explicit "End Session" button (endAudioRelay above) and the
     *  OS revoking capture via its own "Stop casting" control (MediaProjection.Callback.onStop()
     *  in onMediaProjectionResult()) — neither path has anything more to do than this. */
    private void stopAudioRelayHosting() {
        if (sAudioRelayServer == null) return;
        if (deviceManager != null) {
            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                deviceManager.sendTo(peerId, new LinkPacket("link.audiorelay.ended", new JSONObject()));
            }
        }
        try {
            sAudioRelayServer.stop();
        } catch (Exception e) {
            android.util.Log.e(TAG, "Error stopping AudioRelayServer", e);
        }
        sAudioRelayServer = null;
    }

    /** Requires Android 10+ (AudioPlaybackCaptureConfiguration) — minSdkVersion is 23, so this
     *  fails gracefully here rather than the UI pre-emptively hiding the Start Session button.
     *  Order: RECORD_AUDIO (mundane runtime permission) is checked/requested BEFORE the heavier
     *  MediaProjection system consent dialog, to avoid asking for the big scary dialog only to
     *  then need the small one afterward, and because building the capture config without
     *  RECORD_AUDIO already granted throws a SecurityException. */
    @PluginMethod
    public void startAudioRelay(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Requires Android 10 (API 29) or newer");
            call.resolve(ret);
            return;
        }
        if (sAudioRelayServer != null) {
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

            LinkAudioRelayServer server = new LinkAudioRelayServer(
                getContext(), deviceManager.getMyCert(), deviceManager.getMyKey(), LinkTransport.AUDIO_RELAY_PORT,
                new LinkAudioRelayServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        notifyListeners("audioRelayGuestPinPending", data);
                    }
                    @Override
                    public void onListenerJoined(String connId, String label) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("label", label);
                        notifyListeners("audioRelayListenerJoined", data);
                    }
                    @Override
                    public void onListenerLeft(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("audioRelayListenerLeft", data);
                    }
                    @Override
                    public void onError(String message) {
                        JSObject data = new JSObject();
                        data.put("message", message);
                        notifyListeners("audioRelayError", data);
                    }
                });
            server.start();

            // Revocation via the OS "Stop casting" notification-shade control must tear down
            // exactly like the explicit End Session path — otherwise the Host card would stay
            // stuck showing "hosting" with a capture that's actually already dead.
            projection.registerCallback(new android.media.projection.MediaProjection.Callback() {
                @Override
                public void onStop() {
                    JSObject data = new JSObject();
                    data.put("message", "Capture stopped by the system");
                    notifyListeners("audioRelayError", data);
                    stopAudioRelayHosting();
                }
            }, new android.os.Handler(android.os.Looper.getMainLooper()));

            server.startCapture(projection);
            sAudioRelayServer = server;

            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                if (!LinkDevicePermissions.check(getContext(), peerId, "audiorelay")) continue;
                String token = server.issueToken(peerId, getDeviceDisplayName(peerId));
                try {
                    JSONObject body = new JSONObject();
                    body.put("token", token);
                    body.put("port", LinkTransport.AUDIO_RELAY_PORT);
                    deviceManager.sendTo(peerId, new LinkPacket("link.audiorelay.started", body));
                } catch (Exception ignored) {}
            }

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
                    public void onGuestPinPending(String connId, String pin, String remoteAddress) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
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
                });
            server.start();
            server.startCapture();
            sRemoteMicServer = server;

            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                if (!LinkDevicePermissions.check(getContext(), peerId, "remotemic")) continue;
                String token = server.issueToken(peerId, getDeviceDisplayName(peerId));
                try {
                    JSONObject body = new JSONObject();
                    body.put("token", token);
                    body.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
                    deviceManager.sendTo(peerId, new LinkPacket("link.remotemic.started", body));
                } catch (Exception ignored) {}
            }

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
        call.resolve();
    }

    @PluginMethod
    public void kickRemoteMicListener(PluginCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.kickListener(connId);
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

    // Was missing entirely — bridge.ts's queryRemoteMicSessions() called straight into
    // CapacitorLink.queryRemoteMicSessions() with no native @PluginMethod of that name to answer
    // it, on every single mount of RemoteMicTab.tsx (mobile or desktop), unconditionally. Mirrors
    // queryAudioRelaySessions(): asks every trusted peer "are you currently hosting?" via
    // link.remotemic.query, answered on the receiving end by handleRemoteMicQueryPacket(). A
    // no-op on a purely mobile-hosts/desktop-receives topology (no peer of a phone is ever a mic
    // host today), but the call still needs to resolve rather than not exist at all.
    @PluginMethod
    public void queryRemoteMicSessions(PluginCall call) {
        if (deviceManager != null) {
            for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                deviceManager.sendTo(peerId, new LinkPacket("link.remotemic.query", new JSONObject()));
            }
        }
        call.resolve();
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
     *  success/error shape (see e.g. startAudioRelay) rather than throwing across the JS bridge.
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
     *  fast path. Both end up on the exact same LinkAudioRelayClient/relay server — see that
     *  class's header comment. */
    private void startAudioRelayListener(String host, String token) {
        if (sAudioRelayClient != null) {
            sAudioRelayClient.disconnect();
        }
        sAudioRelayClient = new LinkAudioRelayClient(getContext(), new LinkAudioRelayClient.Listener() {
            @Override
            public void onPinComputed(String pin) {
                JSObject data = new JSObject();
                data.put("pin", pin);
                notifyListeners("audioRelayPinComputed", data);
            }

            @Override
            public void onAdmitted() {
                notifyListeners("audioRelayAdmitted", new JSObject());
            }

            @Override
            public void onFormat(int sampleRate, int channels, int bitsPerSample, boolean isFloat) {
                JSObject data = new JSObject();
                data.put("sampleRate", sampleRate);
                data.put("channels", channels);
                data.put("bitsPerSample", bitsPerSample);
                data.put("isFloat", isFloat);
                notifyListeners("audioRelayFormat", data);
            }

            @Override
            public void onHostMuted(boolean muted) {
                JSObject data = new JSObject();
                data.put("muted", muted);
                notifyListeners("audioRelayHostMuted", data);
            }

            @Override
            public void onEnded() {
                // Clearing sAudioRelayClient here (not just forwarding to JS) is what makes
                // getAudioRelayStatus report listening:false after a kick/host-end — otherwise the
                // socket is already dead but the static field still points at it, so reopening the
                // tool keeps showing "still connected" forever.
                sAudioRelayClient = null;
                notifyListeners("audioRelayEnded", new JSObject());
            }

            @Override
            public void onClosed(String reason) {
                sAudioRelayClient = null;
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("audioRelayClosed", data);
            }

            @Override
            public void onError(String message) {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("audioRelayError", data);
            }
        });
        sAudioRelayClient.connect(host, LinkTransport.AUDIO_RELAY_PORT, deviceManager.getMyCert(), deviceManager.getMyKey(), token);
    }

    @PluginMethod
    public void sendDndSet(PluginCall call) {
        String deviceId = call.getString("deviceId");
        boolean enabled = call.getBoolean("enabled", false);
        if (deviceManager != null && deviceId != null) {
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("enabled", enabled);
                deviceManager.sendTo(deviceId, new LinkPacket(LinkDND.PACKET_TYPE_DND, body));
            } catch (Exception ignored) {}
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

    private String getLocalIpAddress() {
        try {
            for (java.net.NetworkInterface intf : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
                for (java.net.InetAddress addr : java.util.Collections.list(intf.getInetAddresses())) {
                    if (!addr.isLoopbackAddress() && addr instanceof java.net.Inet4Address) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ex) {
            android.util.Log.e(TAG, "Error getting IP address", ex);
        }
        return "127.0.0.1";
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
        boolean visibility = prefs.getBoolean("discovery_visibility", true);
        JSObject data = new JSObject();
        data.put("enabled", visibility);
        call.resolve(data);
    }

    @PluginMethod
    public void setVisibility(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        android.content.SharedPreferences prefs = getContext().getSharedPreferences("link_prefs", android.content.Context.MODE_PRIVATE);
        prefs.edit().putBoolean("discovery_visibility", enabled).apply();
        if (discoveryWatcher != null) {
            discoveryWatcher.setVisibility(enabled);
        }
        call.resolve();
    }

    @PluginMethod
    public void connectTo(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", LinkTransport.LINK_PORT);
        try {
            deviceManager.connectTo(host, port);
            call.resolve();
        } catch (Exception e) {
            call.reject("Connect failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void requestPairing(PluginCall call) {
        String pin = deviceManager.requestPairing(call.getString("deviceId"));
        JSObject ret = new JSObject();
        ret.put("verificationKey", pin);
        call.resolve(ret);
    }

    @PluginMethod
    public void acceptPairing(PluginCall call) {
        deviceManager.acceptPairing(call.getString("deviceId"));
        call.resolve();
    }

    @PluginMethod
    public void rejectPairing(PluginCall call) {
        deviceManager.rejectPairing(call.getString("deviceId"));
        call.resolve();
    }

    @PluginMethod
    public void unpair(PluginCall call) {
        deviceManager.unpair(call.getString("deviceId"));
        call.resolve();
    }

    // Trusted Pool (Wave 2): removing a device owner-signs + gossips a revocation; exit leaves the pool.
    @PluginMethod
    public void removeFromPool(PluginCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceManager != null && deviceId != null) deviceManager.removeFromPool(deviceId);
        call.resolve();
    }

    @PluginMethod
    public void exitPool(PluginCall call) {
        if (deviceManager != null) deviceManager.exitPool();
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
                if (dndNowAllowed && !dndWasAllowed && LinkDND.isDndGranted(getContext())) {
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
                for (LinkDeviceManager.ConnectedPeerInfo info : deviceManager.connectedPeers()) {
                    JSObject obj = new JSObject();
                    obj.put("deviceId", info.identity.deviceId);
                    obj.put("deviceName", info.identity.deviceName);
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
    public void sendFindMyPhone(PluginCall call) {
        String deviceId = call.getString("deviceId");
        deviceManager.sendTo(deviceId, LinkFindMyPhone.createPacket());
        call.resolve();
    }

    @PluginMethod
    public void stopFindMyPhone(PluginCall call) {
        LinkFindMyPhone.stopRinging(getContext());
        String deviceId = call.getString("deviceId");
        if (deviceId == null) {
            deviceId = activeRingerDeviceId;
        }
        if (deviceId != null) {
            deviceManager.sendTo(deviceId, LinkFindMyPhone.createPacket(true));
            JSObject data = new JSObject();
            data.put("deviceId", deviceId);
            notifyListeners("findMyPhoneStopped", data);
            activeRingerDeviceId = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void requestCommandList(PluginCall call) {
        String deviceId = call.getString("deviceId");
        deviceManager.sendTo(deviceId, LinkRunCommand.createRequestListPacket());
        call.resolve();
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
                    // Granting: a one-shot per-app dialog exists for this specific direction.
                    android.content.Intent intent = new android.content.Intent();
                    intent.setAction(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                } else {
                    // Revoking: there's no per-app "un-request" intent, only the full list screen
                    // where the user finds this app and flips it back to optimized themselves.
                    // Previously this whole branch was skipped when already granted, so tapping
                    // the toggle to revoke silently did nothing.
                    android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to launch battery optimization settings", e);
            }
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
}
