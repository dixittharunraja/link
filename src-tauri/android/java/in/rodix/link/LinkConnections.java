package in.rodix.link;

import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;

// Finding and keeping connections: LAN discovery (and the nearby list it feeds), connecting to and
// requesting pairing with a discovered or typed device, redialing paired devices with backoff, the
// subnet scan and network-change handling, and this device's own addresses.
final class LinkConnections extends LinkFeature {
    LinkConnections(LinkPlugin plugin) {
        super(plugin);
    }

    // An orphaned watcher keeps discovering and dialing peers through a stale deviceManager,
    // creating duplicate connections in a loop.
    static LinkDiscovery.Watcher sDiscoveryWatcher;
    static final java.util.Map<String, JSObject> sDiscoveredPeers = new java.util.concurrent.ConcurrentHashMap<>();
    // Lets requestPairing() wait for a discovered peer's identity handshake after connecting to
    // it (mirrors desktop's connect-then-wait in request_pairing() in core/transport.rs).
    static final java.util.Map<String, java.util.concurrent.CountDownLatch> sPendingConnectWaits = new java.util.concurrent.ConcurrentHashMap<>();
    static final java.util.Map<String, PendingIpWait> sPendingIpConnectWaits = new java.util.concurrent.ConcurrentHashMap<>();
    static class PendingIpWait {
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        String resolvedDeviceId;
    }

    LinkDiscovery.Watcher discoveryWatcher;

    @Override
    void stopPreviousInstance() {
        if (sDiscoveryWatcher != null) {
            try {
                sDiscoveryWatcher.stop();
            } catch (Exception e) {
                android.util.Log.e(TAG, "Error stopping previous DiscoveryWatcher", e);
            }
            sDiscoveryWatcher = null;
        }
    }

    final android.os.Handler trustedReconnectHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    Runnable trustedReconnectRunnable;
    private java.util.List<String> lastLocalIps = new java.util.ArrayList<>();

    // Prevents overlapping connectTo() attempts at a peer from successive discovery broadcasts.
    private final java.util.Set<String> connectingDeviceIds = java.util.concurrent.ConcurrentHashMap.newKeySet();
    // Exponential backoff for connect attempts that fail outright, such as a stale discovery entry
    // (mirrors core/reconnect.rs). Cleared on disconnect, so a peer that was connected and dropped
    // reconnects on the next broadcast without delay.
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

    void clearConnectBackoff(String deviceId) {
        reconnectBackoff.remove(deviceId);
    }

    private boolean canAttemptConnect(String deviceId) {
        Backoff b = reconnectBackoff.get(deviceId);
        return b == null || System.currentTimeMillis() >= b.nextAttemptAt;
    }

    void startDiscovery(LinkTls.TlsIdentity tls) {
        String myFingerprint = "";
        try {
            myFingerprint = LinkTls.fingerprint(tls.certificate);
        } catch (Exception ignored) {}
        discoveryWatcher = new LinkDiscovery.Watcher(getContext(), plugin.myIdentity, myFingerprint, (ip, peer) -> {
            if (LinkBlocklist.isBlocked(getContext(), peer.deviceId) || LinkBlocklist.isBlocked(getContext(), ip)) {
                return;
            }

            // The device manager's store, not a fresh one per datagram (each would re-read the file).
            LinkTrustStore discoveryStore = plugin.deviceManager != null ? plugin.deviceManager.getTrustStore() : LinkTrustStore.getInstance(getContext());
            boolean isPaired = discoveryStore.isPaired(peer.deviceId);

            // An unpaired device with visibility off is hidden entirely.
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

            // Heard again after going quiet (its entry had expired) or at a new address: it just woke up or
            // moved, so it is dialled now rather than after the backoff its silence built up.
            JSObject before = sDiscoveredPeers.get(peer.deviceId);
            boolean heardAnew = before == null || !ip.equals(before.getString("ipAddress"));
            if (isPaired && heardAnew) clearConnectBackoff(peer.deviceId);

            JSObject info = new JSObject();
            info.put("deviceId", peer.deviceId);
            info.put("deviceName", displayName);
            info.put("deviceType", peer.deviceType != null ? peer.deviceType : "desktop");
            info.put("ipAddress", ip);
            info.put("trusted", isPaired);
            info.put("connected", plugin.deviceManager.hasPeer(peer.deviceId));
            sDiscoveredPeers.put(peer.deviceId, info);
            notifyListeners("deviceDiscovered", info);

            if (!isPaired) {
                return; // only paired devices are auto-connected
            }

            String currentIp = plugin.deviceManager != null ? plugin.deviceManager.remoteAddressOf(peer.deviceId) : null;
            // A multi-homed PC may broadcast from any adapter, so a new source address alone
            // does not mean the connection is stale. Only a connection gone quiet is replaced;
            // otherwise it would drop and redial on every broadcast.
            if (currentIp != null && !currentIp.equals(ip) && plugin.deviceManager.isPeerStale(peer.deviceId, LinkTransport.STALE_AFTER_MS)) {
                android.util.Log.i(TAG, "[Link] Closing stale connection to peer " + peer.deviceId.substring(0, Math.min(8, peer.deviceId.length())) + " at old IP " + currentIp);
                if (plugin.deviceManager != null) {
                    plugin.deviceManager.closeConnection(peer.deviceId);
                }
            }
            discoveryStore.updateLastKnownIp(peer.deviceId, ip);

            if (plugin.deviceManager != null && isPaired) {
                if (plugin.deviceManager.upgradePeerIfTrusted(peer.deviceId)) {
                    return;
                }
                // Heard on the LAN while connected through Tailscale: we are home. Dial the LAN
                // address and leave the remote link up; the duplicate rule drops it once the LAN one is in.
                boolean upgradeFromRemote = plugin.deviceManager.hasTrustedPeer(peer.deviceId) && isRemoteLink(peer.deviceId)
                        && !LinkTailscale.isTailscaleAddr(ip);
                if ((!plugin.deviceManager.hasTrustedPeer(peer.deviceId) || upgradeFromRemote) && canAttemptConnect(peer.deviceId)
                        && connectingDeviceIds.add(peer.deviceId)) {
                    if (!upgradeFromRemote && plugin.deviceManager.hasPeer(peer.deviceId)) {
                        plugin.deviceManager.closeConnection(peer.deviceId);
                    }
                    android.util.Log.i(TAG, "Discovered trusted peer " + peer.deviceName + " at " + ip + ". Connecting...");
                    new Thread(() -> {
                        try {
                            plugin.deviceManager.connectTo(ip, LinkTransport.LINK_PORT);
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

            if (plugin.deviceManager != null) {
                for (LinkDeviceManager.ConnectedPeerInfo info : plugin.deviceManager.connectedPeers()) {
                    if (info.identity.deviceId.equals(expiredDeviceId) && !info.trusted) {
                        android.util.Log.i(TAG, "Closing stale connection to undiscoverable peer " + expiredDeviceId.substring(0, Math.min(8, expiredDeviceId.length())));
                        plugin.deviceManager.closeConnection(expiredDeviceId);
                        break;
                    }
                }
            }
        });
        plugin.settings = new LinkSettings(getContext());
        plugin.settings.load();
        discoveryWatcher.start(plugin.settings.discoveryVisibility);
        // Pair requests are judged by Device Visibility: a hidden device takes only a QR code's token.
        plugin.deviceManager.setVisibilitySupplier(() -> plugin.settings != null && plugin.settings.discoveryVisibility);
        sDiscoveryWatcher = discoveryWatcher;

        trustedReconnectRunnable = new Runnable() {
            @Override
            public void run() {
                attemptTrustedReconnects();
            }
        };
        trustedReconnectHandler.removeCallbacksAndMessages(null);
        trustedReconnectHandler.post(trustedReconnectRunnable);
        watchNetwork();
    }

    // How long announcements are heard after the app is opened or the nearby list is read (LinkDiscovery.listenFor).
    static final long LISTEN_WHILE_IN_USE_MS = 60_000;
    // While a paired device is missing it is redialled this often, at its last known address. Without it the
    // phone redialled only on hearing an announcement, a network change or the app reopening, so a device
    // whose announcements never arrive (a hidden PC, a hotspot or router that drops broadcasts) was lost
    // until something else happened. The per-device backoff (canAttemptConnect) still applies.
    private static final long REDIAL_EVERY_MS = 10_000;
    private long lastRedialMs;
    private volatile boolean anyPairedMissing;

    /** Called from the app heartbeat: redials paired devices that are not connected, at most every REDIAL_EVERY_MS. */
    void redialMissingIfDue() {
        if (!anyPairedMissing) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastRedialMs < REDIAL_EVERY_MS) return;
        lastRedialMs = now;
        attemptTrustedReconnectsAsync();
    }

    // Announce quickly only while a paired device is missing (or nothing is paired yet); see LinkDiscovery.
    void updateDiscoveryPace() {
        LinkDiscovery.Watcher watcher = discoveryWatcher != null ? discoveryWatcher : sDiscoveryWatcher;
        if (watcher == null || plugin.deviceManager == null) return;
        java.util.Collection<LinkTrustStore.TrustedDevice> trusted = plugin.deviceManager.getTrustStore().list();
        java.util.List<String> connected = plugin.deviceManager.trustedConnectedDeviceIds();
        boolean allConnected = !trusted.isEmpty();
        boolean missing = false;
        for (LinkTrustStore.TrustedDevice device : trusted) {
            if (!connected.contains(device.deviceId)) {
                allConnected = false;
                missing = true;
            }
            // Keep listening for the LAN while connected through Tailscale, so coming home is noticed
            // (as core/reconnect.rs does).
            else if (isRemoteLink(device.deviceId)) allConnected = false;
        }
        anyPairedMissing = missing;
        watcher.setFastMode(!allConnected);
    }

    // AOSP's default Wi-Fi hotspot subnet. Preferred so that a PC joined to this phone's hotspot
    // is not given the phone's address on another Wi-Fi network, which it cannot reach.
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

    java.util.List<String> getAllLocalIpAddresses() {
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

    @LinkMethod
    public void getDiscoveredDevices(LinkCall call) {
        // The UI is showing nearby devices: keep hearing announcements while it does.
        LinkDiscovery.Watcher watcher = discoveryWatcher != null ? discoveryWatcher : sDiscoveryWatcher;
        if (watcher != null) watcher.listenFor(LISTEN_WHILE_IN_USE_MS);
        JSArray arr = new JSArray();
        for (JSObject obj : sDiscoveredPeers.values()) {
            arr.put(obj);
        }
        JSObject ret = new JSObject();
        ret.put("devices", arr);
        call.resolve(ret);
    }

    /** Whether a connected peer is reached through Tailscale rather than the LAN. */
    private boolean isRemoteLink(String deviceId) {
        return plugin.deviceManager != null && LinkTailscale.isTailscaleAddr(plugin.deviceManager.remoteAddressOf(deviceId));
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
            plugin.deviceManager.connectTo(host, port);
            call.resolve();
        } catch (Exception e) {
            call.reject("Connect failed: " + e.getMessage());
        }
    }

    @LinkMethod
    public void requestPairing(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String pin = plugin.deviceManager.requestPairing(deviceId);
        if (pin != null) {
            JSObject ret = new JSObject();
            ret.put("verificationKey", pin);
            call.resolve(ret);
            return;
        }

        // No connection yet: discovered but unpaired devices are not auto-connected, so there is
        // nothing to compute a PIN against. Connect to the discovered IP and wait for the identity
        // handshake, since connectTo() returns after TLS but before identity packets arrive.
        JSObject discovered = sDiscoveredPeers.get(deviceId);
        String ip = discovered != null ? discovered.getString("ipAddress") : null;
        if (ip == null) {
            JSObject ret = new JSObject();
            ret.put("verificationKey", (Object) null);
            call.resolve(ret);
            return;
        }

        // @LinkMethod calls run on callExecutor, off the main thread, so blocking here is fine.
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        sPendingConnectWaits.put(deviceId, latch);
        boolean connected = false;
        try {
            plugin.deviceManager.connectTo(ip, LinkTransport.LINK_PORT);
            connected = latch.await(10, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to connect before pairing", e);
            sPendingConnectWaits.remove(deviceId);
        }

        JSObject ret = new JSObject();
        ret.put("verificationKey", connected ? plugin.deviceManager.requestPairing(deviceId) : null);
        call.resolve(ret);
    }

    /**
     * A scanned QR names the device's key. Whoever answered must hold it, or something sits between this
     * phone and the device. True when there was no QR to check, or the key matches.
     */
    private boolean matchesScannedFingerprint(String deviceId, String scannedFingerprint) {
        if (scannedFingerprint == null || scannedFingerprint.isEmpty()) return true;
        String actual = plugin.deviceManager.connectedFingerprintOf(deviceId);
        return actual != null && actual.equalsIgnoreCase(scannedFingerprint);
    }

    @LinkMethod
    public void requestPairingByIp(LinkCall call) {
        String ipListStr = call.getString("ip");
        final String scannedFingerprint = call.getString("fingerprint");
        final String scannedToken = call.getString("token");
        final boolean fromQr = scannedFingerprint != null && !scannedFingerprint.isEmpty()
                && scannedToken != null && !scannedToken.isEmpty();
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

        // Reuse an existing connection first. With a QR the device is known by its key: it may already be
        // connected over another network (several LANs, USB tethering, a network that just changed), and a new
        // connection to it would be closed as a duplicate and never resolve the wait below.
        String byKey = fromQr ? plugin.deviceManager.deviceIdForFingerprint(scannedFingerprint) : null;
        if (byKey != null) {
            JSObject ret = new JSObject();
            ret.put("pin", plugin.deviceManager.requestPairing(byKey, scannedToken));
            ret.put("deviceId", byKey);
            ret.put("verified", true);
            call.resolve(ret);
            return;
        }
        for (String singleIp : ips) {
            String existingDeviceId = plugin.deviceManager.anyDeviceIdForAddress(singleIp);
            if (existingDeviceId != null) {
                if (fromQr && !matchesScannedFingerprint(existingDeviceId, scannedFingerprint)) {
                    call.reject("That is not the device in the QR code. Pairing stopped.");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("pin", plugin.deviceManager.requestPairing(existingDeviceId, fromQr ? scannedToken : null));
                ret.put("deviceId", existingDeviceId);
                ret.put("verified", fromQr);
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
                            plugin.deviceManager.connectTo(singleIp, LinkTransport.LINK_PORT);
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

        String resolved = connected ? ipWait.resolvedDeviceId : null;
        // The device may have come in on a connection of its own meanwhile (it dials paired and pairing
        // devices too); that one counts if it holds the key in the QR.
        if (resolved == null && fromQr) resolved = plugin.deviceManager.deviceIdForFingerprint(scannedFingerprint);
        if (resolved == null) {
            call.reject("No answer from " + ipListStr + ". Check that both devices are on the same network, then show the QR code again.");
            return;
        }
        if (fromQr && !matchesScannedFingerprint(resolved, scannedFingerprint)) {
            call.reject("That is not the device in the QR code. Pairing stopped.");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("pin", plugin.deviceManager.requestPairing(resolved, fromQr ? scannedToken : null));
        ret.put("deviceId", resolved);
        ret.put("verified", fromQr);
        call.resolve(ret);
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
                    if (plugin.deviceManager != null && plugin.deviceManager.deviceIdForAddress(ip) != null) return;
                    android.util.Log.i(TAG, "[Link] Subnet scan found active listener at " + ip + ". Connecting...");
                    new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                        new Thread(() -> {
                            try {
                                plugin.deviceManager.connectTo(ip, LinkTransport.LINK_PORT);
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

        // Wi-Fi without internet (a LAN-only router, a PC's hotspot) never becomes the default network, so the
        // callback above does not hear it come up. Paired devices are on exactly such networks, so Wi-Fi and
        // Ethernet are watched for themselves as well.
        if (sLanCallback != null) {
            try { cm.unregisterNetworkCallback(sLanCallback); } catch (Exception ignored) {}
            sLanCallback = null;
        }
        final android.net.ConnectivityManager.NetworkCallback lanCallback = new android.net.ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(android.net.Network network) {
                refreshConnections(false);
            }

            @Override
            public void onLost(android.net.Network network) {
                refreshConnections(true);
            }
        };
        try {
            android.net.NetworkRequest request = new android.net.NetworkRequest.Builder()
                    .addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                    .addTransportType(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)
                    .removeCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            cm.registerNetworkCallback(request, lanCallback);
            sLanCallback = lanCallback;
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not watch Wi-Fi networks", e);
        }
    }

    private static android.net.ConnectivityManager.NetworkCallback sLanCallback;

    // After a network change the first dial often fails: Wi-Fi reports itself up a moment before it carries
    // traffic, and the peer may still be rejoining too. So paired devices are redialled at these delays as well,
    // with no backoff, and the CPU is kept awake meanwhile: with the screen off the app's timers stop while the
    // CPU sleeps, and the next try would wait until the user picked up the phone.
    private static final long[] SETTLE_RETRIES_MS = {2_000, 5_000, 10_000, 20_000, 30_000};
    private final Object settleToken = new Object();
    private android.os.PowerManager.WakeLock settleWakeLock;

    void refreshConnections(boolean dropConnections) {
        trustedReconnectHandler.post(() -> {
            if (plugin.deviceManager == null) return;
            for (LinkTrustStore.TrustedDevice d : plugin.deviceManager.getTrustStore().list()) {
                clearConnectBackoff(d.deviceId);
                if (dropConnections && plugin.deviceManager.hasPeer(d.deviceId) && !stillReachable(d.deviceId)) {
                    plugin.deviceManager.closeConnection(d.deviceId);
                }
            }
            if (discoveryWatcher != null) discoveryWatcher.networkChanged();
            // The UI shows this device's addresses (in the pairing and tool QR codes) and reads them again.
            notifyListeners("localAddressesChanged", new JSObject());
            attemptTrustedReconnects();
            scheduleSettleRetries();
        });
    }

    /** Redials missing paired devices a few more times after a network change (SETTLE_RETRIES_MS). Main thread. */
    private void scheduleSettleRetries() {
        // A burst of network events (Wi-Fi up, then its addresses) starts the series over once.
        trustedReconnectHandler.removeCallbacksAndMessages(settleToken);
        long last = SETTLE_RETRIES_MS[SETTLE_RETRIES_MS.length - 1];
        try {
            if (settleWakeLock == null) {
                android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
                if (pm != null) {
                    settleWakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "Link:reconnect");
                    settleWakeLock.setReferenceCounted(false);
                }
            }
            // Timed, so it is let go even if the retries are cancelled; released early once all are connected.
            if (settleWakeLock != null) settleWakeLock.acquire(last + 5_000);
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not keep the CPU awake while reconnecting", e);
        }
        for (long delay : SETTLE_RETRIES_MS) {
            trustedReconnectHandler.postAtTime(() -> {
                if (plugin.deviceManager == null) return;
                java.util.List<String> connected = plugin.deviceManager.trustedConnectedDeviceIds();
                boolean missing = false;
                for (LinkTrustStore.TrustedDevice d : plugin.deviceManager.getTrustStore().list()) {
                    if (connected.contains(d.deviceId) && !isRemoteLink(d.deviceId)) continue;
                    missing = true;
                    clearConnectBackoff(d.deviceId);
                }
                if (!missing) {
                    trustedReconnectHandler.removeCallbacksAndMessages(settleToken);
                    releaseSettleWakeLock();
                    return;
                }
                if (discoveryWatcher != null) discoveryWatcher.broadcastNow();
                attemptTrustedReconnectsAsync();
                if (delay == last) releaseSettleWakeLock();
            }, settleToken, android.os.SystemClock.uptimeMillis() + delay);
        }
    }

    private void releaseSettleWakeLock() {
        try {
            if (settleWakeLock != null && settleWakeLock.isHeld()) settleWakeLock.release();
        } catch (Exception ignored) {
        }
    }

    /**
     * Whether a connection still runs over a network this device is on. "Default network lost" is reported
     * whenever Android swaps its default between Wi-Fi and mobile data (on a hotspot without validated
     * internet this happens repeatedly, and on the phone hosting the hotspot every mobile-data blip does it),
     * while connections over the hotspot or LAN are untouched. Closing those dropped the phone from every
     * device at once, and each then took its backoff to come back.
     */
    private boolean stillReachable(String deviceId) {
        String addr = plugin.deviceManager.remoteAddressOf(deviceId);
        if (addr == null) return false;
        String ip = addr.replace("::ffff:", "").split(":")[0];
        if (LinkTailscale.isTailscaleAddr(ip)) return LinkTailscale.localAddress() != null;
        return LinkTailscale.onLocalSubnet(ip);
    }

    private final java.util.concurrent.ExecutorService reconnectExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
    private long lastPeerlessScanMs;
    private static final long PEERLESS_SCAN_MIN_INTERVAL_MS = 60_000;

    /** Same as attemptTrustedReconnects, off the calling (UI) thread: it reads the trust store and settings files. */
    void attemptTrustedReconnectsAsync() {
        reconnectExecutor.execute(this::attemptTrustedReconnects);
    }

    synchronized void attemptTrustedReconnects() {
        if (plugin.deviceManager == null) return;

        java.util.List<String> currentIps = getMyLocalIps();
        if (!currentIps.equals(lastLocalIps)) {
            lastLocalIps = currentIps;
            scanSubnet();
        }

        java.util.List<String[]> targets = new java.util.ArrayList<>(); // {deviceId, ip}
        boolean hasPeerWithoutIp = false;
        // "Use Tailscale when away": reach a peer through the tailnet only when this device has
        // Tailscale connected and the peer's tailnet address is known.
        if (plugin.settings == null) plugin.settings = new LinkSettings(getContext());
        plugin.settings.load();
        boolean remoteAllowed = plugin.settings.remoteTailscale && LinkTailscale.localAddress() != null;
        for (LinkTrustStore.TrustedDevice dev : plugin.deviceManager.getTrustStore().list()) {
            if (plugin.deviceManager.upgradePeerIfTrusted(dev.deviceId)) continue;
            String lanIp = dev.lastKnownIp != null && !dev.lastKnownIp.isEmpty() ? dev.lastKnownIp : null;
            String remoteIp = remoteAllowed ? dev.tailscaleIp : null;
            Backoff attempts = reconnectBackoff.get(dev.deviceId);
            int failures = attempts == null ? 0 : attempts.failCount;
            // The LAN address wins; the remote one is used when that address is on a network this
            // device is no longer on, or did not answer.
            String target = (remoteIp != null && (lanIp == null || !LinkTailscale.onLocalSubnet(lanIp) || failures >= 1)) ? remoteIp : lanIp;
            if (target != null) {
                targets.add(new String[]{dev.deviceId, target});
            } else if (!plugin.deviceManager.hasTrustedPeer(dev.deviceId)) {
                hasPeerWithoutIp = true;
            }
        }

        long nowMs = android.os.SystemClock.elapsedRealtime();
        if (hasPeerWithoutIp && (lastPeerlessScanMs == 0 || nowMs - lastPeerlessScanMs >= PEERLESS_SCAN_MIN_INTERVAL_MS)) {
            lastPeerlessScanMs = nowMs;
            scanSubnet();
        }

        for (int i = 0; i < targets.size(); i++) {
            final String targetDeviceId = targets.get(i)[0];
            final String targetIp = targets.get(i)[1];
            if (plugin.deviceManager.upgradePeerIfTrusted(targetDeviceId)) continue;
            if (plugin.deviceManager.hasTrustedPeer(targetDeviceId) || !canAttemptConnect(targetDeviceId)) continue;
            if (plugin.deviceManager.hasPeer(targetDeviceId)) {
                plugin.deviceManager.closeConnection(targetDeviceId);
            }
            final int delay = i * 250;
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (plugin.deviceManager == null || plugin.deviceManager.hasTrustedPeer(targetDeviceId) || !connectingDeviceIds.add(targetDeviceId)) return;
                new Thread(() -> {
                    try {
                        plugin.deviceManager.connectTo(targetIp, LinkTransport.LINK_PORT);
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
