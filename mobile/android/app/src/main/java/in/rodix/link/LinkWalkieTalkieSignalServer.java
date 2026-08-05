package in.rodix.link;

// Walkie Talkie — guest-facing signaling server. Mirrors LinkPortalTransferServer.java's guest-
// only TLS/WebSocketServer skeleton, minus any file-transfer logic — this carries no media at all
// (Walkie Talkie's audio is WebRTC, peer-to-peer via the WebView's own RTCPeerConnection), purely
// a channel for an unpaired guest to reach the same session-membership/SDP/ICE protocol that
// already-paired devices exchange over the main trusted connection (see LinkPlugin.java's
// link.walkietalkie.* packet relay). Deliberately isolated from LinkDeviceManager/LinkTrustStore,
// same as every other ephemeral Tools plugin.

import android.content.Context;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.DefaultSSLWebSocketServerFactory;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;

import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.channels.ByteChannel;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLPeerUnverifiedException;

public class LinkWalkieTalkieSignalServer extends WebSocketServer {
    private static final String TAG = "LinkWalkieTalkieSignalServer";
    private static final long GUEST_CONFIRM_TIMEOUT_MS = 30000;

    public interface Listener {
        void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName);
        void onSignal(String connId, String type, String body);
        void onGuestLeft(String connId);
        void onError(String message);
    }

    private static class PendingGuest {
        final WebSocket conn;
        final ScheduledFuture<?> timeoutFuture;
        final String remoteAddress;
        final String deviceName;
        PendingGuest(WebSocket conn, ScheduledFuture<?> timeoutFuture, String remoteAddress, String deviceName) {
            this.conn = conn;
            this.timeoutFuture = timeoutFuture;
            this.remoteAddress = remoteAddress;
            this.deviceName = deviceName;
        }
    }

    private final Listener listener;
    private final byte[] myPublicKeyDer;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    private final Map<String, PendingGuest> pendingGuests = new ConcurrentHashMap<>();
    private final Map<String, WebSocket> admittedGuests = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> connIds = new ConcurrentHashMap<>();
    private final Map<WebSocket, byte[]> peerKeysByConn = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> remoteAddrByConn = new ConcurrentHashMap<>();
    private final Map<String, SSLEngine> pendingEngines = new ConcurrentHashMap<>();

    private class ClientAuthSSLFactory extends DefaultSSLWebSocketServerFactory {
        ClientAuthSSLFactory(SSLContext sslContext) {
            super(sslContext);
        }

        @Override
        public ByteChannel wrapChannel(SocketChannel channel, SelectionKey key) throws java.io.IOException {
            SSLEngine engine = sslcontext.createSSLEngine();
            engine.setUseClientMode(false);
            engine.setWantClientAuth(true);
            String k = channel.socket().getRemoteSocketAddress().toString();
            pendingEngines.put(k, engine);
            return new org.java_websocket.SSLSocketChannel2(channel, engine, exec, key);
        }
    }

    public interface BlockChecker {
        boolean isBlocked(String idOrIp);
    }
    private final BlockChecker blockChecker;

    public LinkWalkieTalkieSignalServer(Context context, X509Certificate cert, PrivateKey key, int port, Listener listener, BlockChecker blockChecker) throws Exception {
        super(new InetSocketAddress(port));
        this.listener = listener;
        this.blockChecker = blockChecker;
        this.myPublicKeyDer = cert.getPublicKey().getEncoded();

        SSLContext sslContext = LinkTransport.buildSslContext(cert, key);
        setWebSocketFactory(new ClientAuthSSLFactory(sslContext));
        setConnectionLostTimeout(20);
    }

    public void acceptGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return;
        pending.timeoutFuture.cancel(false);
        admittedGuests.put(connId, pending.conn);
        try { pending.conn.send(new JSONObject().put("type", "admitted").toString()); } catch (Exception ignored) {}
    }

    public void rejectGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return;
        pending.timeoutFuture.cancel(false);
        try { pending.conn.close(4007, "rejected by host"); } catch (Exception ignored) {}
    }

    public void kickGuest(String connId) {
        WebSocket conn = admittedGuests.get(connId);
        if (conn == null) return;
        try { conn.close(1000, "removed by host"); } catch (Exception ignored) {}
    }

    public String getPendingGuestRemoteAddress(String connId) {
        PendingGuest pending = pendingGuests.get(connId);
        if (pending != null) return pending.remoteAddress;
        WebSocket conn = admittedGuests.get(connId);
        return conn != null ? remoteAddrByConn.get(conn) : null;
    }

    /** Sends an opaque {type, body} signaling message to one specific admitted guest — body
     *  travels as a JSON-encoded string, same convention LinkPlugin.java already uses for the
     *  paired-mesh relay, so WalkieTalkieTab.tsx's parsing code is identical either way. */
    public void sendTo(String connId, String type, String bodyJson) {
        WebSocket conn = admittedGuests.get(connId);
        if (conn == null) return;
        try {
            JSONObject wrapped = new JSONObject();
            wrapped.put("type", type);
            wrapped.put("body", new JSONObject(bodyJson));
            conn.send(wrapped.toString());
        } catch (Exception ignored) {}
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        try {
            java.lang.reflect.Method getSocketMethod = conn.getClass().getMethod("getSocket");
            java.net.Socket socket = (java.net.Socket) getSocketMethod.invoke(conn);
            if (socket != null) socket.setTcpNoDelay(true);
        } catch (Exception ignored) {}

        SocketAddress addr = conn.getRemoteSocketAddress();
        SSLEngine engine = addr != null ? pendingEngines.remove(addr.toString()) : null;
        byte[] peerPublicKeyDer;
        try {
            if (engine == null) throw new SSLPeerUnverifiedException("no engine for connection");
            Certificate[] chain = engine.getSession().getPeerCertificates();
            if (chain.length == 0) throw new SSLPeerUnverifiedException("empty chain");
            peerPublicKeyDer = chain[0].getPublicKey().getEncoded();
        } catch (SSLPeerUnverifiedException e) {
            conn.close(4001, "no client certificate presented");
            return;
        } catch (Exception e) {
            conn.close(4002, "invalid certificate");
            return;
        }

        String remoteAddress = addr != null ? addr.toString() : "unknown";
        if (blockChecker.isBlocked(remoteAddress)) {
            conn.close(4010, "blocked");
            return;
        }

        String connId = UUID.randomUUID().toString();
        connIds.put(conn, connId);
        peerKeysByConn.put(conn, peerPublicKeyDer);
        remoteAddrByConn.put(conn, remoteAddress);
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        String connId = connIds.get(conn);
        if (connId == null) return;

        JSONObject msg;
        try {
            msg = new JSONObject(message);
        } catch (Exception e) {
            conn.close(4003, "malformed message");
            return;
        }
        String type = msg.optString("type", "");

        if (admittedGuests.containsKey(connId)) {
            // Post-admission: every message is a generic signaling envelope.
            listener.onSignal(connId, msg.optString("type", ""), msg.optString("body", "{}"));
            return;
        }

        if (!"join-guest".equals(type)) {
            conn.close(4004, "unknown join type");
            return;
        }
        byte[] peerPublicKeyDer = peerKeysByConn.get(conn);
        String remoteAddress = remoteAddrByConn.get(conn);
        if (peerPublicKeyDer == null) {
            conn.close(4002, "invalid certificate");
            return;
        }
        String deviceName = msg.optString("deviceName", "Guest");
        String pin = LinkVerification.computeCode(myPublicKeyDer, peerPublicKeyDer, "");
        ScheduledFuture<?> timeoutFuture = scheduler.schedule(() -> {
            pendingGuests.remove(connId);
            try { conn.close(4006, "confirmation timed out"); } catch (Exception ignored) {}
        }, GUEST_CONFIRM_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        pendingGuests.put(connId, new PendingGuest(conn, timeoutFuture, remoteAddress != null ? remoteAddress : "unknown", deviceName));
        try {
            conn.send(new JSONObject().put("type", "pin").put("code", pin).toString());
        } catch (Exception ignored) {}
        listener.onGuestPinPending(connId, pin, remoteAddress != null ? remoteAddress : "unknown", deviceName);
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        String connId = connIds.remove(conn);
        peerKeysByConn.remove(conn);
        remoteAddrByConn.remove(conn);
        if (connId != null) {
            PendingGuest pending = pendingGuests.remove(connId);
            if (pending != null) pending.timeoutFuture.cancel(false);
            if (admittedGuests.remove(connId) != null) {
                listener.onGuestLeft(connId);
            }
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        listener.onError(ex != null ? ex.getMessage() : "Unknown server error");
    }

    @Override
    public void onStart() {
    }

    @Override
    public void stop() throws InterruptedException {
        for (PendingGuest p : pendingGuests.values()) {
            p.timeoutFuture.cancel(false);
            try { p.conn.close(1000, "session ended"); } catch (Exception ignored) {}
        }
        pendingGuests.clear();
        for (WebSocket conn : admittedGuests.values()) {
            try { conn.close(1000, "session ended"); } catch (Exception ignored) {}
        }
        admittedGuests.clear();
        scheduler.shutdown();
        super.stop();
    }
}
