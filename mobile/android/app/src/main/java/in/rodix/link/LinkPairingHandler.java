package in.rodix.link;

// Pairing state machine. Trust-on-first-use: no PIN, no shared-secret
// proof. See docs/PROTOCOL.md §6 for why this is intentional for this pass.

import org.json.JSONObject;

import java.security.MessageDigest;
import java.security.PublicKey;
import java.util.Locale;

public class LinkPairingHandler {
    public enum PairState { NOT_PAIRED, REQUESTED, REQUESTED_BY_PEER, PAIRED }

    public static final String PACKET_TYPE_PAIR = "link.pair";
    private static final long PAIRING_TIMEOUT_MS = 30 * 1000;
    private static final long ALLOWED_TIMESTAMP_DIFF_SECONDS = 1800; // 30 min, matches upstream

    public interface Listener {
        void onSendPacket(LinkPacket packet);
        void onIncomingPairRequest();
        void onPairingFailed(String reason);
        void onPairingSuccessful();
        void onUnpaired();
    }

    private PairState state;
    private long pairingTimestamp = 0;
    private final PublicKey myPublicKey;
    private final PeerKeyProvider peerKeyProvider;
    private final Listener listener;
    private final android.os.Handler timeoutHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable timeoutRunnable;

    public interface PeerKeyProvider {
        PublicKey get();
    }

    public LinkPairingHandler(PairState initialState, PublicKey myPublicKey, PeerKeyProvider peerKeyProvider, Listener listener) {
        this.state = initialState;
        this.myPublicKey = myPublicKey;
        this.peerKeyProvider = peerKeyProvider;
        this.listener = listener;
    }

    public PairState getState() {
        return state;
    }

    /**
     * Snapshot/restore in-flight state across a connection swap — mirrors desktop's
     * PairingHandler.snapshot()/restore() in pairing.ts. Discovery auto-connects both sides to
     * each other, so a simultaneous double-dial race (most likely right during a fresh
     * first-ever pairing) can cause LinkDeviceManager's tie-break to replace a connection
     * mid-handshake. Without carrying this over, the replacement handler always started fresh
     * from trust-store state alone — silently dropping a REQUESTED/REQUESTED_BY_PEER in-flight
     * pairing, which caused a duplicate incoming-request prompt on one side and a "never
     * actually registers as paired" result on the other.
     */
    public static class Snapshot {
        final PairState state;
        final long pairingTimestamp;
        Snapshot(PairState state, long pairingTimestamp) {
            this.state = state;
            this.pairingTimestamp = pairingTimestamp;
        }
    }

    public Snapshot snapshot() {
        return new Snapshot(state, pairingTimestamp);
    }

    public void restore(Snapshot snapshot) {
        this.state = snapshot.state;
        this.pairingTimestamp = snapshot.pairingTimestamp;
        if (this.state == PairState.REQUESTED || this.state == PairState.REQUESTED_BY_PEER) {
            startTimeout();
        }
    }

    private void clearTimeout() {
        if (timeoutRunnable != null) {
            timeoutHandler.removeCallbacks(timeoutRunnable);
            timeoutRunnable = null;
        }
    }

    private void startTimeout() {
        clearTimeout();
        timeoutRunnable = this::onTimeout;
        timeoutHandler.postDelayed(timeoutRunnable, PAIRING_TIMEOUT_MS);
    }

    private void onTimeout() {
        sendPairPacket(false, -1);
        state = PairState.NOT_PAIRED;
        listener.onPairingFailed("Timed out");
    }

    private void sendPairPacket(boolean pair, long timestamp) {
        try {
            JSONObject body = new JSONObject();
            body.put("pair", pair);
            if (timestamp >= 0) body.put("timestamp", timestamp);
            listener.onSendPacket(new LinkPacket(PACKET_TYPE_PAIR, body));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Call with every incoming link.pair packet from this peer. */
    public void packetReceived(LinkPacket packet) {
        clearTimeout();
        boolean wantsPair = packet.body.optBoolean("pair", false);

        if (wantsPair) {
            switch (state) {
                case REQUESTED:
                    pairingDone();
                    break;
                case REQUESTED_BY_PEER:
                    // Ignore a second request before the first one times out.
                    break;
                case PAIRED:
                case NOT_PAIRED: {
                    if (state == PairState.PAIRED) {
                        state = PairState.NOT_PAIRED;
                        listener.onUnpaired();
                    }

                    if (!packet.body.has("timestamp")) {
                        state = PairState.NOT_PAIRED;
                        listener.onUnpaired();
                        return;
                    }
                    long timestamp = packet.body.optLong("timestamp", -1);
                    long nowSeconds = System.currentTimeMillis() / 1000;
                    if (Math.abs(timestamp - nowSeconds) > ALLOWED_TIMESTAMP_DIFF_SECONDS) {
                        state = PairState.NOT_PAIRED;
                        listener.onPairingFailed("Device clocks are out of sync");
                        return;
                    }

                    pairingTimestamp = timestamp;
                    state = PairState.REQUESTED_BY_PEER;
                    startTimeout();
                    listener.onIncomingPairRequest();
                    break;
                }
            }
        } else {
            switch (state) {
                case NOT_PAIRED:
                    break;
                case REQUESTED:
                case REQUESTED_BY_PEER:
                    state = PairState.NOT_PAIRED;
                    listener.onPairingFailed("Rejected by other peer");
                    break;
                case PAIRED:
                    state = PairState.NOT_PAIRED;
                    listener.onUnpaired();
                    break;
            }
        }
    }

    /** Call to initiate pairing with this peer (user tapped "Pair"). */
    public boolean requestPairing() {
        clearTimeout();

        if (state == PairState.PAIRED) {
            listener.onPairingFailed("Already paired");
            return false;
        }
        if (state == PairState.REQUESTED_BY_PEER) {
            return acceptPairing();
        }

        state = PairState.REQUESTED;
        startTimeout();
        pairingTimestamp = System.currentTimeMillis() / 1000;
        sendPairPacket(true, pairingTimestamp);
        return true;
    }

    /** Call to accept an incoming pair request (user tapped "Accept"). */
    public boolean acceptPairing() {
        clearTimeout();
        sendPairPacket(true, -1);
        pairingDone();
        return true;
    }

    /** Call to reject an incoming request, or cancel one this side sent. */
    public void cancelPairing() {
        clearTimeout();
        state = PairState.NOT_PAIRED;
        sendPairPacket(false, -1);
        listener.onPairingFailed("Cancelled by user");
    }

    /** Explicitly break an existing pairing. Must be mirrored by cleanup on BOTH sides. */
    public void unpair() {
        state = PairState.NOT_PAIRED;
        sendPairPacket(false, -1);
        listener.onUnpaired();
    }

    private void pairingDone() {
        state = PairState.PAIRED;
        listener.onPairingSuccessful();
    }

    /**
     * SHA-256 of both devices' public keys (larger DER first) plus the pairing timestamp — first
     * 8 hex chars, uppercased. Shown on both screens for the user to optionally compare.
     */
    public String verificationKey() {
        PublicKey peerKey = peerKeyProvider.get();
        if (peerKey == null) return null;

        byte[] a = myPublicKey.getEncoded();
        byte[] b = peerKey.getEncoded();
        if (compareBytes(a, b) < 0) {
            byte[] tmp = a;
            a = b;
            b = tmp;
        }

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(a);
            digest.update(b);
            digest.update(String.valueOf(pairingTimestamp).getBytes());
            byte[] hash = digest.digest();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 4; i++) sb.append(String.format("%02x", hash[i]));
            return sb.toString().toUpperCase(Locale.ROOT);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static int compareBytes(byte[] a, byte[] b) {
        int len = Math.min(a.length, b.length);
        for (int i = 0; i < len; i++) {
            int cmp = Integer.compare(a[i] & 0xFF, b[i] & 0xFF);
            if (cmp != 0) return cmp;
        }
        return Integer.compare(a.length, b.length);
    }
}
