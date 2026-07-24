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
        void onIncomingPairRequest(String deviceId, String verificationKey);
        void onPairingSuccessful(String deviceId);
        void onPairingFailed(String deviceId, String reason);
        void onUnpaired(String deviceId);
        void onTrustMismatch(String deviceId);
        void onPacket(String deviceId, LinkPacket packet);
    }

    private static class ManagedPeer {
        LinkTransport.PeerConnection conn;
        LinkPairingHandler pairing;
        volatile boolean trusted;
    }

    private LinkIdentity.Identity myIdentity;
    private final X509Certificate myCert;
    private final java.security.PrivateKey myKey;
    private final LinkTrustStore trustStore;
    private final Listener listener;
    private final Context context; // Trusted Pool (Wave 2) — for LinkPool's Context-based storage.
    private final Map<String, ManagedPeer> peers = new ConcurrentHashMap<>();

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
        refreshMyPoolIdentity();
    }

    /** Stamp this device's current pool membership onto myIdentity, so every NEW connection
     *  advertises it. Mirrors desktop device-manager.ts refreshMyPoolIdentity(). */
    private void refreshMyPoolIdentity() {
        if (LinkPool.hasKey(context)) {
            myIdentity.ownerKeyFingerprint = LinkPool.fingerprint(context);
            myIdentity.membershipCert = LinkPool.getMembership(context);
        } else {
            myIdentity.ownerKeyFingerprint = null;
            myIdentity.membershipCert = null;
        }
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
        conn.start(new LinkTransport.ConnectionListener() {
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
                    boolean keepThis = myIdentity.deviceId.compareTo(identity.deviceId) > 0
                            ? conn.isOutgoing()
                            : !conn.isOutgoing();
                    if (!keepThis) {
                        conn.close();
                        return;
                    } else {
                        existingPeer.conn.close();
                    }
                }

                // Auto-mesh (Trusted Pool, item 8): a device we never manually paired with but
                // that presents a valid membership cert signed by OUR OWN owner key is one of our
                // own pool devices — trust it with no second PIN. Mirrors device-manager.ts.
                boolean trusted = existing != null;
                if (!trusted && tryAutoTrust(conn, identity)) {
                    trusted = true;
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
                                listener.onIncomingPairRequest(identity.deviceId, pairingHandlerVerificationKey(identity.deviceId));
                            }

                            @Override
                            public void onPairingFailed(String reason) {
                                listener.onPairingFailed(identity.deviceId, reason);
                            }

                            @Override
                            public void onPairingSuccessful() {
                                ManagedPeer peer = peers.get(identity.deviceId);
                                if (peer != null && conn.peerCert != null) {
                                    try {
                                        trustStore.pair(new LinkTrustStore.TrustedDevice(
                                                identity.deviceId,
                                                identity.deviceName,
                                                conn.peerCert.getEncoded(),
                                                identity.protocolVersion,
                                                System.currentTimeMillis()));
                                        peer.trusted = true;
                                    } catch (Exception ignored) {
                                    }
                                }
                                // Item 7: bootstrap the freshly-paired device into the pool (hand
                                // over owner key + issue its membership cert). See device-manager.ts.
                                enrollAfterPairing(conn, identity);
                                listener.onPairingSuccessful(identity.deviceId);
                            }

                            @Override
                            public void onUnpaired() {
                                trustStore.unpair(identity.deviceId);
                                ManagedPeer peer = peers.get(identity.deviceId);
                                if (peer != null) peer.trusted = false;
                                listener.onUnpaired(identity.deviceId);
                            }
                        });
                // Carry any in-flight pairing state over from the connection being replaced —
                // see LinkPairingHandler.snapshot()/restore() for why this matters.
                if (existingPeer != null) {
                    pairing.restore(existingPeer.pairing.snapshot());
                }

                ManagedPeer peer = new ManagedPeer();
                peer.conn = conn;
                peer.pairing = pairing;
                peer.trusted = trusted;
                peers.put(identity.deviceId, peer);

                listener.onDeviceConnected(identity, trusted);
            }

            @Override
            public void onPacket(LinkPacket packet) {
                ManagedPeer peer = findPeerByConnection(conn);
                if (peer == null) return;

                if (packet.type.equals(LinkPairingHandler.PACKET_TYPE_PAIR)) {
                    peer.pairing.packetReceived(packet);
                    return;
                }

                if (!peer.trusted) return; // ignore feature packets from unpaired devices

                // Pool control packets (items 7 & 9) — handled internally, never surfaced as
                // ordinary feature packets. Mirror device-manager.ts.
                if (packet.type.equals(LinkPool.PACKET_TYPE_POOL_ENROLL)) {
                    applyEnrollment(packet.body);
                    return;
                }
                if (packet.type.equals(LinkPool.PACKET_TYPE_POOL_REVOKE)) {
                    applyRevocation(LinkPool.Revocation.fromJson(packet.body.optJSONObject("revocation")), conn);
                    return;
                }

                String deviceId = findDeviceIdByConnection(conn);
                if (deviceId != null) listener.onPacket(deviceId, packet);
            }

            @Override
            public void onClose() {
                String deviceId = findDeviceIdByConnection(conn);
                if (deviceId != null) {
                    peers.remove(deviceId);
                    listener.onDeviceDisconnected(deviceId);
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

    public void rejectPairing(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) peer.pairing.cancelPairing();
    }

    public void unpair(String deviceId) {
        ManagedPeer peer = peers.get(deviceId);
        if (peer != null) {
            peer.pairing.unpair();
            peer.conn.close(); // Force close the socket immediately
        }
        trustStore.unpair(deviceId);
    }

    // ===== Trusted Pool (Wave 2) — mirrors device-manager.ts; see that file for the design =====

    /** Item 8: verify a peer's membership cert against OUR owner key + its actual TLS cert. */
    private boolean tryAutoTrust(LinkTransport.PeerConnection conn, LinkIdentity.Identity identity) {
        if (!LinkPool.hasKey(context)) return false;
        if (identity.membershipCert == null || identity.ownerKeyFingerprint == null) return false;
        if (conn.peerCert == null) return false;
        if (LinkPool.isRevoked(context, identity.deviceId)) return false;
        if (!identity.ownerKeyFingerprint.equals(LinkPool.fingerprint(context))) return false;
        LinkPool.OwnerKeyPair owner = LinkPool.getOwner(context);
        if (owner == null) return false;
        try {
            String peerCertFp = LinkTls.fingerprint(conn.peerCert);
            if (!LinkPool.verifyMembershipCert(identity.membershipCert, owner.publicKeyDerB64,
                    identity.deviceId, peerCertFp)) return false;
            trustStore.pair(new LinkTrustStore.TrustedDevice(identity.deviceId, identity.deviceName,
                    conn.peerCert.getEncoded(), identity.protocolVersion, System.currentTimeMillis()));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Item 7: after a manual pair, deterministically decide who enrolls whom and do it. */
    private void enrollAfterPairing(LinkTransport.PeerConnection conn, LinkIdentity.Identity identity) {
        if (conn.peerCert == null) return;
        String myFp = LinkPool.fingerprint(context);          // null if I'm not in a pool
        String peerFp = identity.ownerKeyFingerprint;         // null if the peer isn't
        if (myFp != null && peerFp != null) return;           // both in a pool: same=noop, diff=no-merge
        if (myFp == null && peerFp != null) return;           // peer enrolls me; wait for its packet
        if (myFp == null && peerFp == null) {
            // Neither in a pool → this pairing CREATES one; creator = larger deviceId (both agree).
            if (myIdentity.deviceId.compareTo(identity.deviceId) > 0) {
                LinkPool.OwnerKeyPair owner = LinkPool.generateOwnerKeyPair();
                LinkPool.MembershipCert myMembership =
                        LinkPool.issueMembershipCert(owner, myIdentity.deviceId, myCertFingerprint(), 1);
                LinkPool.setCredentials(context, owner, myMembership);
                refreshMyPoolIdentity();
                sendEnroll(conn, identity);
            }
            return;
        }
        // myFp != null && peerFp == null → I enroll the peer.
        sendEnroll(conn, identity);
    }

    private void sendEnroll(LinkTransport.PeerConnection conn, LinkIdentity.Identity identity) {
        LinkPool.OwnerKeyPair owner = LinkPool.getOwner(context);
        if (owner == null || conn.peerCert == null) return;
        try {
            String peerCertFp = LinkTls.fingerprint(conn.peerCert);
            LinkPool.MembershipCert membership =
                    LinkPool.issueMembershipCert(owner, identity.deviceId, peerCertFp, 1);
            JSONObject ownerJson = new JSONObject();
            ownerJson.put("publicKeyDerB64", owner.publicKeyDerB64);
            ownerJson.put("privateKeyDerB64", owner.privateKeyDerB64);
            JSONObject body = new JSONObject();
            body.put("owner", ownerJson);
            body.put("membership", membership.toJson());
            conn.send(new LinkPacket(LinkPool.PACKET_TYPE_POOL_ENROLL, body));
        } catch (Exception ignored) {}
    }

    private void applyEnrollment(JSONObject body) {
        if (LinkPool.hasKey(context)) return; // already in a pool — ignore
        if (body == null) return;
        JSONObject ownerJson = body.optJSONObject("owner");
        LinkPool.MembershipCert membership = LinkPool.MembershipCert.fromJson(body.optJSONObject("membership"));
        if (ownerJson == null || membership == null) return;
        LinkPool.OwnerKeyPair owner = new LinkPool.OwnerKeyPair(
                ownerJson.optString("publicKeyDerB64"), ownerJson.optString("privateKeyDerB64"));
        if (!LinkPool.verifyMembershipCert(membership, owner.publicKeyDerB64, myIdentity.deviceId, myCertFingerprint())) {
            return; // not a valid cert for THIS device
        }
        LinkPool.setCredentials(context, owner, membership);
        refreshMyPoolIdentity();
        closeUntrustedConnections();
    }

    private void closeUntrustedConnections() {
        for (ManagedPeer peer : new java.util.ArrayList<>(peers.values())) {
            if (!peer.trusted) peer.conn.close();
        }
    }

    private void applyRevocation(LinkPool.Revocation rev, LinkTransport.PeerConnection from) {
        if (rev == null) return;
        LinkPool.OwnerKeyPair owner = LinkPool.getOwner(context);
        if (owner == null || !LinkPool.verifyRevocation(rev, owner.publicKeyDerB64)) return;
        if (!LinkPool.addRevocation(context, rev)) return; // already seen — stop the flood

        if (rev.deviceId.equals(myIdentity.deviceId)) {
            // We were removed from the pool. Wipe credentials, drop everyone.
            LinkPool.clear(context);
            refreshMyPoolIdentity();
            for (Map.Entry<String, ManagedPeer> e : new java.util.ArrayList<>(peers.entrySet())) {
                trustStore.unpair(e.getKey());
                e.getValue().trusted = false;
                e.getValue().conn.close();
            }
            return;
        }

        ManagedPeer target = peers.get(rev.deviceId);
        trustStore.unpair(rev.deviceId);
        if (target != null) {
            target.trusted = false;
            target.conn.close();
            listener.onUnpaired(rev.deviceId);
        }
        // Flood onward to every OTHER trusted pool member.
        try {
            JSONObject body = new JSONObject();
            body.put("revocation", rev.toJson());
            for (ManagedPeer peer : peers.values()) {
                if (peer.trusted && peer.conn != from) {
                    peer.conn.send(new LinkPacket(LinkPool.PACKET_TYPE_POOL_REVOKE, body));
                }
            }
        } catch (Exception ignored) {}
    }

    /** Remove another device from the pool: owner-sign a revocation, apply + gossip it. */
    public void removeFromPool(String deviceId) {
        LinkPool.OwnerKeyPair owner = LinkPool.getOwner(context);
        if (owner != null) {
            LinkPool.Revocation rev = LinkPool.signRevocation(owner, deviceId);
            LinkPool.addRevocation(context, rev);
            try {
                JSONObject body = new JSONObject();
                body.put("revocation", rev.toJson());
                for (ManagedPeer peer : peers.values()) {
                    if (peer.trusted) peer.conn.send(new LinkPacket(LinkPool.PACKET_TYPE_POOL_REVOKE, body));
                }
            } catch (Exception ignored) {}
        }
        unpair(deviceId);
    }

    /** Leave the pool ourselves: self-sign a revocation so others drop us, wipe credentials. */
    public void exitPool() {
        LinkPool.OwnerKeyPair owner = LinkPool.getOwner(context);
        if (owner != null) {
            LinkPool.Revocation rev = LinkPool.signRevocation(owner, myIdentity.deviceId);
            try {
                JSONObject body = new JSONObject();
                body.put("revocation", rev.toJson());
                for (ManagedPeer peer : peers.values()) {
                    if (peer.trusted) peer.conn.send(new LinkPacket(LinkPool.PACKET_TYPE_POOL_REVOKE, body));
                }
            } catch (Exception ignored) {}
            LinkPool.clear(context);
            refreshMyPoolIdentity();
        }
        for (String id : new java.util.ArrayList<>(peers.keySet())) {
            unpair(id);
        }
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
        for (ManagedPeer peer : peers.values()) {
            if (peer.conn.isStale(timeoutMs)) {
                peer.conn.close();
            } else {
                peer.conn.sendHeartbeat();
            }
        }
    }

    public LinkTrustStore getTrustStore() {
        return trustStore;
    }
}
