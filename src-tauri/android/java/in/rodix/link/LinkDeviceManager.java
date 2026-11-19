package in.rodix.link;

// Ties transport, pairing and trust together per connection, and keeps the trusted pool in sync
// between paired devices. Java counterpart of DeviceManager in core/transport.rs.

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
        void onIncomingPairRequest(String deviceId, String deviceName, String deviceType, String verificationKey, boolean viaQr);
        /** A second device presented a QR token that had already been used. */
        void onPairingBlocked(String deviceName);
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
        boolean notifiedNotPaired;
        // The request now waiting for approval came from a device that scanned this device's QR.
        volatile boolean pendingViaQr;
        LinkIdentity.Identity identity;
        long createdAt = System.currentTimeMillis();
    }

    private LinkIdentity.Identity myIdentity;
    private final X509Certificate myCert;
    private final java.security.PrivateKey myKey;
    private final LinkTrustStore trustStore;
    private final Listener listener;
    private final Map<String, ManagedPeer> peers = new ConcurrentHashMap<>();
    // Serialises the duplicate-connection decision in onIdentity.
    private final Object attachLock = new Object();
    // When new devices may pair, and the one-time token in this device's QR.
    private final LinkPairingWindow pairingWindow = new LinkPairingWindow();
    // Device Visibility, read when a request arrives; set by LinkPlugin.
    private volatile java.util.function.BooleanSupplier visibility = () -> false;

    public void setVisibilitySupplier(java.util.function.BooleanSupplier supplier) {
        this.visibility = supplier;
    }

    public void updateMyIdentity(LinkIdentity.Identity newIdentity) {
        this.myIdentity = newIdentity;
        if (server != null) {
            server.updateMyIdentity(newIdentity);
        }
    }
    private LinkTransport.Server server;

    public LinkDeviceManager(LinkIdentity.Identity myIdentity, X509Certificate myCert,
                              java.security.PrivateKey myKey, LinkTrustStore trustStore, Listener listener) {
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
     * Stops the server and closes every peer connection. LinkForegroundService keeps the process
     * alive after the Activity is gone, so LinkPlugin.load() can run again in the same process
     * and must be able to bind the port afresh.
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

                // The address this peer can be reached at through Tailscale: the one this connection
                // runs over if it is a tailnet address, else the one the peer advertises.
                String peerTailscaleIp = LinkTailscale.isTailscaleAddr(conn.remoteAddress)
                        ? conn.remoteAddress.replace("::ffff:", "").split(":")[0]
                        : identity.tailscaleIp;
                if (existing != null && peerTailscaleIp != null) {
                    trustStore.updateTailscaleIp(identity.deviceId, peerTailscaleIp);
                }

                boolean trusted = existing != null;
                // Two connections to one device can identify at once on their own reader threads. The
                // look-up, the tie-break and the put happen as one step, or both could see no existing
                // peer and one would silently overwrite the other, leaving a connection nobody closes.
                synchronized (attachLock) {
                    ManagedPeer existingPeer = peers.get(identity.deviceId);
                    if (existingPeer != null) {
                        if (existingPeer.conn == conn) {
                            return;
                        }

                        // When both devices dial each other at once, both sides keep the same socket:
                        // the smaller deviceId keeps its outbound connection, the larger its inbound.
                        // A stale existing connection is always replaced.
                        boolean shouldKeepOutbound = myIdentity.deviceId.compareTo(identity.deviceId) < 0;
                        boolean currentIsOutbound = conn.isOutgoing();
                        // A LAN connection always beats one through Tailscale, so coming home leaves the
                        // data-using remote link; between two of the same kind the id rule decides.
                        boolean existingRemote = LinkTailscale.isTailscaleAddr(existingPeer.conn.remoteAddress);
                        boolean newRemote = LinkTailscale.isTailscaleAddr(conn.remoteAddress);

                        if (existingPeer.conn.isStale(LinkTransport.STALE_AFTER_MS)) {
                            android.util.Log.i("LinkPool", "[Link] Replacing stale connection to " + identity.deviceId.substring(0, Math.min(8, identity.deviceId.length())) + " with fresh connection.");
                            existingPeer.conn.close();
                        } else if (existingRemote != newRemote) {
                            if (existingRemote) {
                                android.util.Log.i("LinkPool", "[Link] Back on the LAN: replacing the remote connection to " + identity.deviceId.substring(0, Math.min(8, identity.deviceId.length())) + ".");
                                existingPeer.conn.close();
                            } else {
                                conn.close();
                                return;
                            }
                        } else if (currentIsOutbound == shouldKeepOutbound) {
                            android.util.Log.i("LinkPool", "[Link] Deterministic tie-breaker: keeping current connection to " + identity.deviceId.substring(0, Math.min(8, identity.deviceId.length())) + ".");
                            existingPeer.conn.close();
                        } else {
                            android.util.Log.i("LinkPool", "[Link] Deterministic tie-breaker: dropping current duplicate connection to " + identity.deviceId.substring(0, Math.min(8, identity.deviceId.length())) + ".");
                            conn.close();
                            return;
                        }
                    }

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
                                    ManagedPeer asking = peers.get(identity.deviceId);
                                    listener.onIncomingPairRequest(identity.deviceId, identity.deviceName, identity.deviceType, pairingHandlerVerificationKey(identity.deviceId), asking != null && asking.pendingViaQr);
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
                                                    System.currentTimeMillis()));
                                            String remoteIp = conn.remoteAddress != null ? conn.remoteAddress.replace("::ffff:", "").split(":")[0] : null;
                                            if (remoteIp != null && !remoteIp.isEmpty()) {
                                                trustStore.updateLastKnownIp(identity.deviceId, remoteIp);
                                            }
                                            // Remember how to reach it through Tailscale, learned while it was only connected.
                                            if (peerTailscaleIp != null) {
                                                trustStore.updateTailscaleIp(identity.deviceId, peerTailscaleIp);
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
                }

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
                        // A peer that says it is paired but is not in the trust store is not told who is in the pool.
                        if (deviceId != null) upgradePeerIfTrusted(deviceId);
                    }
                    return;
                }

                if (packet.type.equals("link.pool.sync")) {
                    // Anyone can open a connection, so a list from a device that is not paired would let it vouch for
                    // itself. Only a paired device may say who else to trust.
                    if (!peer.trusted) {
                        android.util.Log.w("LinkPool", "[Link] Ignored a pool list from a device that is not paired");
                        return;
                    }
                    onPoolSync(conn, deviceId, packet);
                    return;
                }

                if (packet.type.equals("link.pool.remove")) {
                    onPoolRemove(deviceId, packet);
                    return;
                }

                if (packet.type.equals(LinkPairingHandler.PACKET_TYPE_PAIR)) {
                    android.util.Log.i("LinkPool", "Received link.pair packet, wantsPair=" + packet.body.optBoolean("pair", false));
                    // A request (as opposed to an answer to ours) is judged first: a visible device takes
                    // ordinary requests, a hidden one only a QR's one-time token, which works once. Anything
                    // else is refused without a prompt.
                    boolean isRequest = packet.body.optBoolean("pair", false) && packet.body.has("timestamp");
                    if (isRequest && peer.pairing.getState() != LinkPairingHandler.PairState.REQUESTED) {
                        LinkPairingWindow.Admission admission = pairingWindow.admit(packet.body.optString("token", null), visibility.getAsBoolean(), System.currentTimeMillis());
                        if (admission == LinkPairingWindow.Admission.CLOSED
                                || admission == LinkPairingWindow.Admission.BAD_TOKEN
                                || admission == LinkPairingWindow.Admission.CONFLICT) {
                            android.util.Log.w("LinkPool", "Refused a pair request: " + admission);
                            try {
                                conn.send(new LinkPacket(LinkPairingHandler.PACKET_TYPE_PAIR, new org.json.JSONObject().put("pair", false)));
                            } catch (Exception ignored) {}
                            if (admission == LinkPairingWindow.Admission.CONFLICT) {
                                listener.onPairingBlocked(peer.identity != null ? peer.identity.deviceName : null);
                            }
                            return;
                        }
                        peer.pendingViaQr = admission == LinkPairingWindow.Admission.QR;
                    }
                    peer.pairing.packetReceived(packet);
                    return;
                }

                if (!peer.trusted) {
                    // The sender considers itself paired but this device has no record of it. That is only
                    // worth telling it when this device REMOVED it (so it drops this device); a device that
                    // simply has not heard of the sender yet learns of it from the pool and must not be
                    // unpaired by the sender's confusion. Once.
                    if (!peer.notifiedNotPaired && deviceId != null && trustStore.get(deviceId) == null
                            && trustStore.removedAt(deviceId) != null
                            && peer.pairing.getState() == LinkPairingHandler.PairState.NOT_PAIRED) {
                        peer.notifiedNotPaired = true;
                        try {
                            conn.send(new LinkPacket(LinkPairingHandler.PACKET_TYPE_PAIR,
                                    new org.json.JSONObject().put("pair", false).put("unpair", true)));
                        } catch (Exception ignored) {}
                    }
                    return; // feature packets from unpaired devices are ignored
                }



                if (deviceId != null) listener.onPacket(deviceId, packet);
            }

            @Override
            public void onClose() {
                ManagedPeer closingPeer = findPeerByConnection(conn);
                if (closingPeer != null && closingPeer.identity != null) {
                    String devId = closingPeer.identity.deviceId;
                    // Ignore the close if this connection was already replaced by a newer one.
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
        return requestPairing(deviceId, null);
    }

    /** As above, carrying the one-time token of a scanned QR code. */
    public String requestPairing(String deviceId, String token) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) {
            peer.pairing.requestPairing(token);
            return peer.pairing.verificationKey();
        }
        return null;
    }

    /** The key fingerprint of the device on this connection, as seen in its TLS certificate. */
    public String connectedFingerprintOf(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer == null || peer.conn == null || peer.conn.peerCert == null) return null;
        try { return LinkTls.fingerprint(peer.conn.peerCert); } catch (Exception e) { return null; }
    }

    /** The connected device holding this key, whatever address it came from; null when none does. */
    public String deviceIdForFingerprint(String fingerprint) {
        if (fingerprint == null || fingerprint.isEmpty()) return null;
        for (String deviceId : peers.keySet()) {
            if (fingerprint.equalsIgnoreCase(connectedFingerprintOf(deviceId))) return deviceId;
        }
        return null;
    }

    /** Opens pairing and returns the token for the QR now on screen. */
    public String openPairingWindow() {
        return pairingWindow.open(System.currentTimeMillis());
    }

    /** A fresh QR token; null when pairing is closed. */
    public String refreshPairingToken() {
        return pairingWindow.refresh(System.currentTimeMillis());
    }

    public void closePairingWindow() {
        pairingWindow.close();
    }

    /** This device's key fingerprint, the one the QR carries. */
    public String fingerprint() {
        return myCertFingerprint();
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
                body.put("unpair", true);
                peer.conn.send(new LinkPacket(LinkPairingHandler.PACKET_TYPE_PAIR, body));
            } catch (Exception ignored) {}
            peer.pairing.unpair();
            peer.conn.closeGracefully(); // lets the queued unpair packet go out first
            peers.remove(deviceId);
        }
        trustStore.unpair(deviceId);
        listener.onUnpaired(deviceId);
    }

    public void closeConnection(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) peer.conn.close();
    }



    // Peers that are not paired connections: a guest admitted to a tool is addressed through the
    // socket it joined on, so tool code can keep sending to "a device id" as it does for paired ones.
    private final Map<String, java.util.function.Consumer<LinkPacket>> virtualPeers = new java.util.concurrent.ConcurrentHashMap<>();

    public void registerVirtualPeer(String id, java.util.function.Consumer<LinkPacket> sink) {
        virtualPeers.put(id, sink);
    }

    public void unregisterVirtualPeer(String id) {
        virtualPeers.remove(id);
    }

    public void sendTo(String deviceId, LinkPacket packet) {
        java.util.function.Consumer<LinkPacket> virtualPeer = virtualPeers.get(deviceId);
        if (virtualPeer != null) {
            virtualPeer.accept(packet);
            return;
        }
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null && peer.trusted) peer.conn.send(packet);
    }

    /** This device's TLS certificate, for plugins that open their own payload connections. */
    public X509Certificate getMyCert() {
        return myCert;
    }

    public java.security.PrivateKey getMyKey() {
        return myKey;
    }

    /** IDs of all connected, paired devices. */
    public java.util.List<String> trustedConnectedDeviceIds() {
        java.util.List<String> result = new java.util.ArrayList<>();
        for (Map.Entry<String, ManagedPeer> entry : peers.entrySet()) {
            if (entry.getValue().trusted) result.add(entry.getKey());
        }
        return result;
    }

    /** The peer's self-reported device type ("phone", "tv", ...), or null when it is not connected. */
    public String deviceTypeOf(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer == null || peer.conn == null || peer.conn.peerIdentity == null) return null;
        return peer.conn.peerIdentity.deviceType;
    }

    /** The peer's IP for an active connection, e.g. to download a payload it announced. */
    public String remoteAddressOf(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        return peer != null ? peer.conn.remoteAddress : null;
    }

    /** Identifies the sender of an unauthenticated fast-path packet (e.g. the UDP presenter or
     *  touchpad relay) by source IP among connected trusted peers. Mirrors paired_device_at() in
     *  core/host.rs. */
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

    /** Pinned certificate fingerprint of a paired device, for verifying payload connections. */
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

    /** True when nothing has arrived from this device for timeoutMs (heartbeats arrive about every 10 s). */
    public boolean isPeerStale(String deviceId, long timeoutMs) {
        ManagedPeer peer = peers.get(deviceId);
        return peer != null && peer.conn.isStale(timeoutMs);
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
     * Identity and trust state of every connected peer; mirrors connected_peers() in
     * core/transport.rs. A WebView reload rebuilds only the JS layer while these connections stay
     * up, so the UI uses this to restore their state.
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
     * Called periodically by LinkPlugin. Closes connections silent for longer than timeoutMs
     * (faster than TCP keepalive) and sends a heartbeat on idle ones so live connections never go
     * stale. Mirrors the per-connection heartbeat in core/transport.rs.
     */
    public void runHeartbeatCycle(long timeoutMs) {
        String currentHash = trustStore.computePoolHash();
        long now = System.currentTimeMillis();
        for (ManagedPeer peer : peers.values()) {
            if (peer.conn.isStale(timeoutMs)) {
                peer.conn.close();
            } else if (now - peer.conn.lastRxAt >= 4000) {
                // Only once the peer has been quiet 4 s, to save battery and radio wakeups: anything it
                // sent more recently already proves it is alive. Its answer refreshes lastRxAt.
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
                String pem = "-----BEGIN CERTIFICATE-----\n" +
                        android.util.Base64.encodeToString(d.certDer, android.util.Base64.DEFAULT) +
                        "-----END CERTIFICATE-----";
                obj.put("certPem", pem);
                String ip = d.lastKnownIp;
                if (ip == null || ip.isEmpty()) {
                    ip = remoteAddressOf(d.deviceId);
                }
                obj.put("lastKnownIp", ip != null ? ip : "");
                obj.put("pairedAt", d.pairedAt);
                list.put(obj);
            } catch (Exception ignored) {}
        }

        // This device is part of the pool too.
        try {
            org.json.JSONObject self = new org.json.JSONObject();
            self.put("deviceId", myIdentity.deviceId);
            self.put("deviceName", myIdentity.deviceName);
            String myPem = "-----BEGIN CERTIFICATE-----\n" +
                    android.util.Base64.encodeToString(myCert.getEncoded(), android.util.Base64.DEFAULT) +
                    "-----END CERTIFICATE-----";
            self.put("certPem", myPem);
            self.put("lastKnownIp", "");
            list.put(self);
        } catch (Exception ignored) {}

        return list;
    }

    /** The pairings and the removals this device knows of: what a device that was offline needs to catch up. */
    private org.json.JSONObject poolSyncBody() throws org.json.JSONException {
        org.json.JSONObject body = new org.json.JSONObject();
        body.put("trustList", getPoolSyncList());
        org.json.JSONArray removed = new org.json.JSONArray();
        for (java.util.Map.Entry<String, Long> e : trustStore.removals().entrySet()) {
            removed.put(new org.json.JSONObject().put("deviceId", e.getKey()).put("removedAt", e.getValue()));
        }
        body.put("removed", removed);
        return body;
    }

    private void sendPoolSync(LinkTransport.PeerConnection conn) {
        try {
            conn.send(new LinkPacket("link.pool.sync", poolSyncBody()));
        } catch (Exception ignored) {}
    }

    public void broadcastPoolSync() {
        try {
            LinkPacket packet = new LinkPacket("link.pool.sync", poolSyncBody());
            for (ManagedPeer peer : peers.values()) {
                if (peer.trusted) {
                    peer.conn.send(packet);
                }
            }
        } catch (Exception ignored) {}
    }

    /** A pool list arrived from a paired device: merge its pairings and removals (see core/pool.rs). */
    private void onPoolSync(LinkTransport.PeerConnection conn, String senderId, LinkPacket packet) {
        try {
            if (packet.body == null) return;
            org.json.JSONArray trustList = packet.body.optJSONArray("trustList");
            org.json.JSONArray removals = packet.body.optJSONArray("removed");
            String senderIp = conn.remoteAddress != null ? conn.remoteAddress.replace("::ffff:", "").split(":")[0] : null;
            boolean updated = false;
            java.util.List<String> dropped = new java.util.ArrayList<>();
            java.util.List<String> admitted = new java.util.ArrayList<>();

            if (removals != null) {
                for (int i = 0; i < removals.length(); i++) {
                    org.json.JSONObject r = removals.getJSONObject(i);
                    String id = r.optString("deviceId", "");
                    long at = r.optLong("removedAt", 0);
                    // Nobody removes this device, or the one vouching, from this device's own pool.
                    if (id.isEmpty() || id.equals(myIdentity.deviceId) || id.equals(senderId)) continue;
                    boolean wasPaired = trustStore.isPaired(id);
                    if (trustStore.removeDevice(id, at) && wasPaired && !trustStore.isPaired(id)) {
                        dropped.add(id);
                        updated = true;
                    }
                }
            }

            if (trustList != null) {
                for (int i = 0; i < trustList.length(); i++) {
                    org.json.JSONObject dev = trustList.getJSONObject(i);
                    String devId = dev.optString("deviceId", "");
                    if (devId.isEmpty() || devId.equals(myIdentity.deviceId)) continue;

                    String effectiveIp = dev.optString("lastKnownIp", "");
                    if (effectiveIp.isEmpty() && devId.equals(senderId) && senderIp != null) {
                        effectiveIp = senderIp;
                    }

                    if (!trustStore.isPaired(devId)) {
                        long pairedAt = dev.optLong("pairedAt", 0);
                        Long removedAt = trustStore.removedAt(devId);
                        if (removedAt != null && pairedAt <= removedAt) {
                            // Removed here, but the sender still lists it: it missed the removal.
                            if (!devId.equals(senderId)) {
                                sendTo(senderId, new LinkPacket("link.pool.remove",
                                        new org.json.JSONObject().put("deviceId", devId).put("removedAt", removedAt)));
                            }
                            continue;
                        }
                        byte[] certBytes = null;
                        String certPem = dev.optString("certPem", "");
                        if (!certPem.isEmpty()) {
                            String clean = certPem.replace("-----BEGIN CERTIFICATE-----", "")
                                    .replace("-----END CERTIFICATE-----", "")
                                    .replaceAll("\\s", "");
                            certBytes = android.util.Base64.decode(clean, android.util.Base64.DEFAULT);
                        }
                        if (certBytes != null) {
                            android.util.Log.i("LinkPool", "[Link] Auto-learning trust for pool peer " + dev.optString("deviceName", "") + " (" + devId.substring(0, Math.min(8, devId.length())) + ")");
                            trustStore.pair(new LinkTrustStore.TrustedDevice(
                                    devId,
                                    dev.optString("deviceName", ""),
                                    certBytes,
                                    pairedAt > 0 ? pairedAt : System.currentTimeMillis()
                            ));
                            if (!effectiveIp.isEmpty()) {
                                trustStore.updateLastKnownIp(devId, effectiveIp);
                            }
                            admitted.add(devId);
                            updated = true;
                        }
                    } else if (!effectiveIp.isEmpty()) {
                        LinkTrustStore.TrustedDevice existing = trustStore.get(devId);
                        if (existing != null && !effectiveIp.equals(existing.lastKnownIp)) {
                            trustStore.updateLastKnownIp(devId, effectiveIp);
                            updated = true;
                        }
                    }
                }
            }

            for (String id : dropped) {
                android.util.Log.i("LinkPool", "[Link] Dropped " + id.substring(0, Math.min(8, id.length())) + " from the pool: removed, as the sender told");
                unpair(id);
            }
            // A connection already open to a new member was made before it was trusted: trust it now.
            for (String id : admitted) upgradePeerIfTrusted(id);
            for (ManagedPeer p : new java.util.ArrayList<>(peers.values())) {
                if (p.identity != null && !p.trusted) upgradePeerIfTrusted(p.identity.deviceId);
            }
            if (updated) {
                listener.onTrustListUpdated();
                broadcastPoolSync();
            }
        } catch (Exception e) {
            android.util.Log.w("LinkPool", "[Link] failed to merge link.pool.sync: " + e.getMessage());
        }
    }

    /** A paired device asks for another to be removed from the pool. Only a removal not yet known is applied
     *  and passed on, so it cannot loop. */
    private void onPoolRemove(String senderId, LinkPacket packet) {
        ManagedPeer sender = peers.get(senderId);
        if (sender == null || !sender.trusted || packet.body == null) return;
        try {
            String target = packet.body.optString("deviceId", "");
            if (target.isEmpty() || target.equals(myIdentity.deviceId) || target.equals(senderId)) return;
            long at = packet.body.optLong("removedAt", System.currentTimeMillis());
            if (!trustStore.removeDevice(target, at)) return;
            android.util.Log.i("LinkPool", "[Link] Peer " + senderId.substring(0, Math.min(8, senderId.length())) + " requested removal of " + target.substring(0, Math.min(8, target.length())) + " from pool.");
            LinkPacket forward = new LinkPacket("link.pool.remove", new org.json.JSONObject().put("deviceId", target).put("removedAt", at));
            for (String otherId : trustedConnectedDeviceIds()) {
                if (!otherId.equals(senderId) && !otherId.equals(target)) {
                    sendTo(otherId, forward);
                }
            }
            unpair(target);
        } catch (Exception e) {
            android.util.Log.w("LinkPool", "Failed to apply link.pool.remove: " + e.getMessage());
        }
    }

    /** The user removed a device: every member is told (and the ones offline learn it from the lists they get
     *  when they return), then this device lets go of it. */
    public void unpairFromPool(String deviceId) {
        long at = System.currentTimeMillis();
        trustStore.removeDevice(deviceId, at);
        try {
            LinkPacket packet = new LinkPacket("link.pool.remove", new org.json.JSONObject().put("deviceId", deviceId).put("removedAt", at));
            for (String otherId : trustedConnectedDeviceIds()) {
                if (!otherId.equals(deviceId)) sendTo(otherId, packet);
            }
        } catch (Exception ignored) {}
        unpair(deviceId);
    }
}
