package in.rodix.link;

// Wires transport + pairing + trust together per connection. Java port of
// desktop/src/core/device-manager.ts. See that file's comments for the overall design.

import android.content.Context;

import org.json.JSONObject;

import java.security.PublicKey;
import java.security.cert.X509Certificate;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class LinkDeviceManager {
    public interface Listener {
        void onDeviceConnected(LinkIdentity.Identity identity, boolean trusted);
        void onDeviceDisconnected(String deviceId);
        void onIncomingPairRequest(String deviceId, String deviceName, String deviceType, String verificationKey);
        void onPairingSuccessful(String deviceId);
        void onPairingFailed(String deviceId, String reason);
        void onUnpaired(String deviceId);
        void onTrustMismatch(String deviceId);
        void onPacket(String deviceId, LinkPacket packet);
        void onTrustListUpdated();
    }

    private static class ManagedPeer {
        LinkTransport.PeerConnection conn;
        LinkPairingHandler pairing;
        volatile boolean trusted;
        LinkIdentity.Identity identity;
        long createdAt = System.currentTimeMillis();
    }

    private LinkIdentity.Identity myIdentity;
    private final X509Certificate myCert;
    private final java.security.PrivateKey myKey;
    private final LinkTrustStore trustStore;
    private final Listener listener;
    private final Context context; // Trusted Pool — for LinkPool's Context-based storage.
    private final Map<String, ManagedPeer> peers = new ConcurrentHashMap<>();
    private java.util.Timer membershipGossipTimer;

    public void updateMyIdentity(LinkIdentity.Identity newIdentity) {
        this.myIdentity = newIdentity;
        if (server != null) {
            server.updateMyIdentity(newIdentity);
        }
    }
    private LinkTransport.Server server;

    public LinkDeviceManager(Context context, LinkIdentity.Identity myIdentity, X509Certificate myCert,
                              java.security.PrivateKey myKey, LinkTrustStore trustStore, Listener listener) {
        this.context = context.getApplicationContext();
        this.myIdentity = myIdentity;
        this.myCert = myCert;
        this.myKey = myKey;
        this.trustStore = trustStore;
        this.listener = listener;
    }

    private String myCertFingerprint() {
        try { return LinkTls.fingerprint(myCert); } catch (Exception e) { return null; }
    }

    public void startServer(int port) throws Exception {
        server = new LinkTransport.Server(myCert, myKey, myIdentity, port, this::attach);
    }

    /**
     * Stops the listening server and closes every peer connection. Needed because the app
     * process can outlive an individual Activity (LinkForegroundService keeps it alive across
     * the task being cleared from Recents), so a second LinkPlugin.load() can run in the SAME
     * process — without this, it would try to bind the same TCP port a second time and throw
     * BindException, which is what caused the "reopen after clearing from Recents hangs on a
     * white screen" bug (load() throwing left the Capacitor bridge stuck mid-initialization).
     */
    public void shutdown() {
        if (server != null) {
            server.stop();
            server = null;
        }
        for (ManagedPeer peer : peers.values()) {
            try {
                if (peer.conn != null) peer.conn.close();
            } catch (Exception ignored) {
            }
        }
        peers.clear();
    }

    public void connectTo(String host, int port) throws Exception {
        LinkTransport.PeerConnection conn = LinkTransport.connectToPeer(host, port, myCert, myKey, myIdentity);
        attach(conn);
    }

    private void attach(LinkTransport.PeerConnection conn) {
        conn.poolHashProvider = () -> trustStore.computePoolHash();
        conn.start(new LinkTransport.ConnectionListener() {
            @Override
            public void onHeartbeat(String poolHash) {
                if (poolHash != null && !poolHash.equals(trustStore.computePoolHash())) {
                    ManagedPeer peer = findPeerByConnection(conn);
                    if (peer != null && peer.trusted) {
                        sendPoolSync(conn);
                    }
                }
            }

            @Override
            public void onIdentity(LinkIdentity.Identity identity, X509Certificate peerCert) {
                LinkTrustStore.TrustedDevice existing = trustStore.get(identity.deviceId);
                if (existing != null) {
                    try {
                        String pinnedFingerprint = LinkTls.fingerprint(existing.certificate());
                        String currentFingerprint = LinkTls.fingerprint(peerCert);
                        if (!pinnedFingerprint.equals(currentFingerprint)) {
                            listener.onTrustMismatch(identity.deviceId);
                            conn.close();
                            return;
                        }
                    } catch (Exception e) {
                        conn.close();
                        return;
                    }
                }

                ManagedPeer existingPeer = peers.get(identity.deviceId);
                if (existingPeer != null) {
                    if (existingPeer.conn == conn) {
                        return;
                    }

                    // Deterministic collision tie-breaker:
                    // When two devices dial each other concurrently (double-dial), both sides resolve
                    // symmetrically: the device with lexicographically smaller deviceId keeps outbound,
                    // while the device with larger deviceId keeps inbound.
                    boolean shouldKeepOutbound = myIdentity.deviceId.compareTo(identity.deviceId) < 0;
                    boolean currentIsOutbound = conn.isOutgoing();

                    if (existingPeer.conn.isStale(9000)) {
                        android.util.Log.i("LinkPool", "[Link] Replacing stale connection to " + identity.deviceId.substring(0, Math.min(8, identity.deviceId.length())) + " with fresh connection.");
                        existingPeer.conn.close();
                    } else if (currentIsOutbound == shouldKeepOutbound) {
                        android.util.Log.i("LinkPool", "[Link] Deterministic tie-breaker: keeping current connection to " + identity.deviceId.substring(0, Math.min(8, identity.deviceId.length())) + ".");
                        existingPeer.conn.close();
                    } else {
                        android.util.Log.i("LinkPool", "[Link] Deterministic tie-breaker: dropping current duplicate connection to " + identity.deviceId.substring(0, Math.min(8, identity.deviceId.length())) + ".");
                        conn.close();
                        return;
                    }
                }

                boolean trusted = existing != null;
                LinkPairingHandler.PairState initial = trusted
                        ? LinkPairingHandler.PairState.PAIRED
                        : LinkPairingHandler.PairState.NOT_PAIRED;

                LinkPairingHandler pairing = new LinkPairingHandler(
                        initial,
                        myCert.getPublicKey(),
                        () -> conn.peerCert != null ? conn.peerCert.getPublicKey() : null,
                        new LinkPairingHandler.Listener() {
                            @Override
                            public void onSendPacket(LinkPacket packet) {
                                conn.send(packet);
                            }

                            @Override
                            public void onIncomingPairRequest() {
                                listener.onIncomingPairRequest(identity.deviceId, identity.deviceName, identity.deviceType, pairingHandlerVerificationKey(identity.deviceId));
                            }

                            @Override
                            public void onPairingFailed(String reason) {
                                listener.onPairingFailed(identity.deviceId, reason);
                            }

                            @Override
                            public void onPairingSuccessful() {
                                ManagedPeer peer = peers.get(identity.deviceId);
                                if (conn.peerCert != null) {
                                    try {
                                        trustStore.pair(new LinkTrustStore.TrustedDevice(
                                                identity.deviceId,
                                                identity.deviceName,
                                                conn.peerCert.getEncoded(),
                                                identity.protocolVersion,
                                                System.currentTimeMillis()));
                                        String remoteIp = conn.remoteAddress != null ? conn.remoteAddress.replace("::ffff:", "").split(":")[0] : null;
                                        if (remoteIp != null && !remoteIp.isEmpty()) {
                                            trustStore.updateLastKnownIp(identity.deviceId, remoteIp);
                                        }
                                        if (peer != null) {
                                            peer.trusted = true;
                                        }
                                    } catch (Exception ignored) {
                                    }
                                }
                                listener.onPairingSuccessful(identity.deviceId);
                                broadcastPoolSync();
                                sendPoolSync(conn);
                            }

                            @Override
                            public void onUnpaired() {
                                trustStore.unpair(identity.deviceId);
                                ManagedPeer peer = peers.get(identity.deviceId);
                                if (peer != null) peer.trusted = false;
                                listener.onUnpaired(identity.deviceId);
                            }
                        });
                if (existingPeer != null) {
                    pairing.restore(existingPeer.pairing.snapshot());
                }

                ManagedPeer peer = new ManagedPeer();
                peer.conn = conn;
                peer.pairing = pairing;
                peer.trusted = trusted;
                peer.identity = identity;
                peers.put(identity.deviceId, peer);

                listener.onDeviceConnected(identity, trusted);
                if (trusted) {
                    String remoteIp = conn.remoteAddress != null ? conn.remoteAddress.replace("::ffff:", "").split(":")[0] : null;
                    if (remoteIp != null && !remoteIp.isEmpty()) {
                        trustStore.updateLastKnownIp(identity.deviceId, remoteIp);
                    }
                    try {
                        org.json.JSONObject body = new org.json.JSONObject();
                        body.put("state", "Paired");
                        conn.send(new LinkPacket("link.pairing-state", body));
                    } catch (Exception ignored) {}
                    sendPoolSync(conn);
                    broadcastPoolSync();
                }
            }

            @Override
            public void onPacket(LinkPacket packet) {
                String deviceId = findDeviceIdByConnection(conn);
                ManagedPeer peer = findPeerByConnection(conn);
                if (peer == null) return;

                if (packet.type.equals("link.pairing-state")) {
                    String state = packet.body != null ? packet.body.optString("state", "") : "";
                    if (state.equals("Paired")) {
                        if (deviceId != null && !upgradePeerIfTrusted(deviceId)) {
                            // Peer claims paired, but not in our trust store yet — exchange pool sync immediately.
                            sendPoolSync(conn);
                        }
                    }
                    return;
                }

                if (packet.type.equals("link.pool.sync")) {
                    try {
                        org.json.JSONArray trustList = packet.body != null ? packet.body.optJSONArray("trustList") : null;
                        if (trustList != null) {
                            boolean updated = false;
                            String senderIp = conn.remoteAddress != null ? conn.remoteAddress.replace("::ffff:", "").split(":")[0] : null;
                            for (int i = 0; i < trustList.length(); i++) {
                                org.json.JSONObject dev = trustList.getJSONObject(i);
                                String devId = dev.optString("deviceId", "");
                                if (devId.isEmpty() || devId.equals(myIdentity.deviceId)) continue;

                                String effectiveIp = dev.optString("lastKnownIp", "");
                                if (effectiveIp.isEmpty() && devId.equals(deviceId) && senderIp != null) {
                                    effectiveIp = senderIp;
                                }

                                if (!trustStore.isPaired(devId)) {
                                    android.util.Log.i("LinkPool", "[Link] Auto-learning trust for pool peer " + dev.optString("deviceName", "") + " (" + devId.substring(0, Math.min(8, devId.length())) + ")");
                                    byte[] certBytes = null;
                                    String certPem = dev.optString("certPem", "");
                                    if (!certPem.isEmpty()) {
                                        String clean = certPem.replace("-----BEGIN CERTIFICATE-----", "")
                                                .replace("-----END CERTIFICATE-----", "")
                                                .replaceAll("\\s", "");
                                        certBytes = android.util.Base64.decode(clean, android.util.Base64.DEFAULT);
                                    }
                                    if (certBytes != null) {
                                        trustStore.pair(new LinkTrustStore.TrustedDevice(
                                                devId,
                                                dev.optString("deviceName", ""),
                                                certBytes,
                                                dev.optInt("protocolVersion", 1),
                                                System.currentTimeMillis()
                                        ));
                                        if (!effectiveIp.isEmpty()) {
                                            trustStore.updateLastKnownIp(devId, effectiveIp);
                                        }
                                        updated = true;
                                    }
                                } else {
                                    if (!effectiveIp.isEmpty()) {
                                        LinkTrustStore.TrustedDevice existing = trustStore.get(devId);
                                        if (existing != null && !effectiveIp.equals(existing.lastKnownIp)) {
                                            android.util.Log.i("LinkPool", "[Link] Updating IP for pool peer " + dev.optString("deviceName", "") + " (" + devId.substring(0, Math.min(8, devId.length())) + ") to " + effectiveIp);
                                            trustStore.updateLastKnownIp(devId, effectiveIp);
                                            updated = true;
                                        }
                                    }
                                }
                                upgradePeerIfTrusted(devId);
                            }
                            if (updated) {
                                listener.onTrustListUpdated();
                                broadcastPoolSync();
                            }
                        }
                    } catch (Exception e) {
                        android.util.Log.w("LinkPool", "[Link] failed to parse link.pool.sync: " + e.getMessage());
                    }
                    return;
                }

                if (packet.type.equals("link.pool.remove")) {
                    try {
                        String targetDeviceId = packet.body.optString("deviceId", "");
                        if (!targetDeviceId.isEmpty() && trustStore.isPaired(targetDeviceId)) {
                            android.util.Log.i("LinkPool", "[Link] Peer " + deviceId.substring(0, Math.min(8, deviceId.length())) + " requested removal of " + targetDeviceId.substring(0, Math.min(8, targetDeviceId.length())) + " from pool.");
                            unpair(targetDeviceId);

                            // Propagate to other trusted connected devices (excluding the sender and the target)
                            for (String otherId : trustedConnectedDeviceIds()) {
                                if (!otherId.equals(deviceId) && !otherId.equals(targetDeviceId)) {
                                    sendTo(otherId, packet);
                                }
                            }
                        }
                    } catch (Exception e) {
                        android.util.Log.w("LinkPool", "Failed to parse link.pool.remove: " + e.getMessage());
                    }
                    return;
                }

                if (packet.type.equals(LinkPairingHandler.PACKET_TYPE_PAIR)) {
                    android.util.Log.i("LinkPool", "Received link.pair packet, wantsPair=" + packet.body.optBoolean("pair", false));
                    peer.pairing.packetReceived(packet);
                    return;
                }

                if (!peer.trusted) return; // ignore feature packets from unpaired devices



                if (deviceId != null) listener.onPacket(deviceId, packet);
            }

            @Override
            public void onClose() {
                ManagedPeer closingPeer = findPeerByConnection(conn);
                if (closingPeer != null && closingPeer.identity != null) {
                    String devId = closingPeer.identity.deviceId;
                    // Only remove from map and notify listeners if this closing connection
                    // is still the active connection for this deviceId (not already replaced by a newer/winner connection)
                    ManagedPeer current = peers.get(devId);
                    if (current != null && current.conn == conn) {
                        peers.remove(devId);
                        listener.onDeviceDisconnected(devId);
                    }
                }
            }
        });
    }

    private ManagedPeer findPeerByConnection(LinkTransport.PeerConnection conn) {
        for (ManagedPeer peer : peers.values()) {
            if (peer.conn == conn) return peer;
        }
        return null;
    }

    private String findDeviceIdByConnection(LinkTransport.PeerConnection conn) {
        for (Map.Entry<String, ManagedPeer> entry : peers.entrySet()) {
            if (entry.getValue().conn == conn) return entry.getKey();
        }
        return null;
    }

    private String pairingHandlerVerificationKey(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        return peer != null ? peer.pairing.verificationKey() : null;
    }

    public String requestPairing(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) {
            peer.pairing.requestPairing();
            return peer.pairing.verificationKey();
        }
        return null;
    }

    public void acceptPairing(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) peer.pairing.acceptPairing();
    }

    public void cancelPairing(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) peer.pairing.cancelPairing();
    }

    public void rejectPairing(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) peer.pairing.cancelPairing();
    }

    public void unpair(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) {
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("pair", false);
                peer.conn.send(new LinkPacket(LinkPairingHandler.PACKET_TYPE_PAIR, body));
            } catch (Exception ignored) {}
            peer.pairing.unpair();
            peer.conn.closeGracefully(); // Close gracefully to allow pending packets to send
            peers.remove(deviceId);
        }
        trustStore.unpair(deviceId);
        listener.onUnpaired(deviceId);
    }

    public void closeConnection(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) peer.conn.close();
    }



    public void sendTo(String deviceId, LinkPacket packet) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null && peer.trusted) peer.conn.send(packet);
    }

    /** This device's own TLS identity — needed by plugins (e.g. share) that open their own ephemeral payload connections. */
    public X509Certificate getMyCert() {
        return myCert;
    }

    public java.security.PrivateKey getMyKey() {
        return myKey;
    }

    /** All currently-connected, paired device IDs — e.g. for broadcasting a local clipboard change to everyone. */
    public java.util.List<String> trustedConnectedDeviceIds() {
        java.util.List<String> result = new java.util.ArrayList<>();
        for (Map.Entry<String, ManagedPeer> entry : peers.entrySet()) {
            if (entry.getValue().trusted) result.add(entry.getKey());
        }
        return result;
    }

    /** The peer's IP for an active connection — e.g. for downloading a payload they announced. */
    public String remoteAddressOf(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        return peer != null ? peer.conn.remoteAddress : null;
    }

    /** Reverse of remoteAddressOf — identifies the sender of an unauthenticated fast-path packet
     * (e.g. the raw UDP presenter/touchpad relay) by matching source IP against the currently
     * trusted+connected peer list. Mirrors desktop main.ts's deviceIdForAddress(). */
    public String deviceIdForAddress(String ipAddress) {
        if (ipAddress == null) return null;
        for (Map.Entry<String, ManagedPeer> entry : peers.entrySet()) {
            ManagedPeer peer = entry.getValue();
            if (peer.trusted && ipAddress.equals(peer.conn.remoteAddress)) {
                return entry.getKey();
            }
        }
        return null;
    }

    public String anyDeviceIdForAddress(String ipAddress) {
        if (ipAddress == null) return null;
        for (Map.Entry<String, ManagedPeer> entry : peers.entrySet()) {
            ManagedPeer peer = entry.getValue();
            if (peer.conn != null && ipAddress.equals(peer.conn.remoteAddress)) {
                return entry.getKey();
            }
        }
        return null;
    }

    /** The pinned certificate fingerprint for a paired device — for verifying a payload connection's cert matches. */
    public String pinnedFingerprintOf(String deviceId) {
        LinkTrustStore.TrustedDevice trusted = trustStore.get(deviceId);
        if (trusted == null) return null;
        try {
            return LinkTls.fingerprint(trusted.certificate());
        } catch (Exception e) {
            return null;
        }
    }

    public boolean hasPeer(String deviceId) {
        return peers.containsKey(deviceId);
    }

    public boolean hasTrustedPeer(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        return peer != null && peer.trusted;
    }

    public boolean upgradePeerIfTrusted(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer == null) return false;
        if (peer.trusted) return true;
        LinkTrustStore.TrustedDevice trustedDev = trustStore.get(deviceId);
        if (trustedDev == null) return false;

        if (peer.conn.peerCert != null) {
            try {
                String pinnedFp = LinkTls.fingerprint(trustedDev.certificate());
                String actualFp = LinkTls.fingerprint(peer.conn.peerCert);
                if (!pinnedFp.equals(actualFp)) {
                    android.util.Log.w("LinkPool", "[Link] Pinned cert mismatch upgrading " + deviceId);
                    listener.onTrustMismatch(deviceId);
                    peer.conn.close();
                    return false;
                }
            } catch (Exception e) {
                peer.conn.close();
                return false;
            }
        }

        android.util.Log.i("LinkPool", "[Link] Upgraded peer " + deviceId.substring(0, Math.min(8, deviceId.length())) + " to trusted.");
        peer.trusted = true;
        peer.pairing.setPairState(LinkPairingHandler.PairState.PAIRED);
        String remoteIp = peer.conn.remoteAddress != null ? peer.conn.remoteAddress.replace("::ffff:", "").split(":")[0] : null;
        if (remoteIp != null && !remoteIp.isEmpty()) {
            trustStore.updateLastKnownIp(deviceId, remoteIp);
        }
        try {
            org.json.JSONObject body = new org.json.JSONObject();
            body.put("state", "Paired");
            peer.conn.send(new LinkPacket("link.pairing-state", body));
        } catch (Exception ignored) {}
        sendPoolSync(peer.conn);
        listener.onDeviceConnected(peer.identity, true);
        return true;
    }

    public void updatePeerName(String deviceId, String newName) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null && peer.conn != null && peer.conn.peerIdentity != null) {
            peer.conn.peerIdentity.deviceName = newName;
        }
    }

    public static class ConnectedPeerInfo {
        public final LinkIdentity.Identity identity;
        public final boolean trusted;
        ConnectedPeerInfo(LinkIdentity.Identity identity, boolean trusted) {
            this.identity = identity;
            this.trusted = trusted;
        }
    }

    /**
     * Every currently-connected peer's real identity + trust state — mirrors desktop's
     * device-manager.ts connectedPeers(). Needed because a WebView reload (dev live-reload, or
     * the Activity/WebView recreating without a real LinkPlugin.load() reattach) only tears down
     * and rebuilds the JS layer — this native DeviceManager keeps running undisturbed, so any
     * already-live connections are still perfectly fine. Without this, the JS bootstrap only had
     * getTrustedDevices() to fall back on, which hardcodes connected:false for everything.
     */
    public java.util.List<ConnectedPeerInfo> connectedPeers() {
        java.util.List<ConnectedPeerInfo> result = new java.util.ArrayList<>();
        for (ManagedPeer peer : peers.values()) {
            if (peer.conn.peerIdentity != null) {
                result.add(new ConnectedPeerInfo(peer.conn.peerIdentity, peer.trusted));
            }
        }
        return result;
    }

    /**
     * Called periodically (see LinkPlugin) for every connected peer: force-closes any connection
     * that has gone silent for longer than timeoutMs (dead peer, detected ourselves instead of
     * waiting on OS-level TCP keepalive), otherwise sends a heartbeat so a genuinely-alive-but-
     * idle connection never goes stale in the first place. Mirrors desktop's device-manager.ts
     * runHeartbeatCycle().
     */
    public void runHeartbeatCycle(long timeoutMs) {
        String currentHash = trustStore.computePoolHash();
        for (ManagedPeer peer : peers.values()) {
            if (peer.conn.isStale(timeoutMs)) {
                peer.conn.close();
            } else {
                peer.conn.sendHeartbeat(false, currentHash);
            }
        }
    }

    public LinkTrustStore getTrustStore() {
        return trustStore;
    }

    private org.json.JSONArray getPoolSyncList() {
        org.json.JSONArray list = new org.json.JSONArray();
        for (LinkTrustStore.TrustedDevice d : trustStore.list()) {
            try {
                org.json.JSONObject obj = new org.json.JSONObject();
                obj.put("deviceId", d.deviceId);
                obj.put("deviceName", d.deviceName);
                // Convert DER cert bytes to PEM string for transmission
                String pem = "-----BEGIN CERTIFICATE-----\n" +
                        android.util.Base64.encodeToString(d.certDer, android.util.Base64.DEFAULT) +
                        "-----END CERTIFICATE-----";
                obj.put("certPem", pem);
                obj.put("protocolVersion", d.protocolVersion);
                String ip = d.lastKnownIp;
                if (ip == null || ip.isEmpty()) {
                    ip = remoteAddressOf(d.deviceId);
                }
                obj.put("lastKnownIp", ip != null ? ip : "");
                list.put(obj);
            } catch (Exception ignored) {}
        }

        // Include ourselves in the pool list
        try {
            org.json.JSONObject self = new org.json.JSONObject();
            self.put("deviceId", myIdentity.deviceId);
            self.put("deviceName", myIdentity.deviceName);
            String myPem = "-----BEGIN CERTIFICATE-----\n" +
                    android.util.Base64.encodeToString(myCert.getEncoded(), android.util.Base64.DEFAULT) +
                    "-----END CERTIFICATE-----";
            self.put("certPem", myPem);
            self.put("protocolVersion", myIdentity.protocolVersion);
            self.put("lastKnownIp", "");
            list.put(self);
        } catch (Exception ignored) {}

        return list;
    }

    private void sendPoolSync(LinkTransport.PeerConnection conn) {
        try {
            org.json.JSONObject body = new org.json.JSONObject();
            body.put("trustList", getPoolSyncList());
            conn.send(new LinkPacket("link.pool.sync", body));
        } catch (Exception ignored) {}
    }

    public void broadcastPoolSync() {
        try {
            org.json.JSONObject body = new org.json.JSONObject();
            body.put("trustList", getPoolSyncList());
            LinkPacket packet = new LinkPacket("link.pool.sync", body);
            for (ManagedPeer peer : peers.values()) {
                if (peer.trusted) {
                    peer.conn.send(packet);
                }
            }
        } catch (Exception ignored) {}
    }
}
