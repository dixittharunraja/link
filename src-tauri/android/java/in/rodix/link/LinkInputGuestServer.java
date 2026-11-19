package in.rodix.link;

import android.content.Context;
import android.util.Log;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.DefaultSSLWebSocketServerFactory;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;

import java.net.InetSocketAddress;
import java.nio.channels.ByteChannel;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLPeerUnverifiedException;

/**
 * Accepts temporary guest sessions for Presenter and Remote Input (touchpad, pointer, stylus)
 * from devices that are not necessarily paired with this one.
 */
public class LinkInputGuestServer extends WebSocketServer {
    private static final String TAG = "LinkInputGuestServer";
    private static final long GUEST_CONFIRM_TIMEOUT_MS = 60000;

    public interface Listener {
        void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName, String mode);
        void onGuestJoined(String remoteAddress, String deviceName, String mode);
        void onGuestLeft(String remoteAddress);
        /** A packet an admitted remote-control guest sent over its socket. */
        void onGuestPacket(String remoteAddress, String packetType, String bodyJson);
        void onError(String message);
        // Fires once the server is actually bound. WebSocketServer.start() returns before the
        // bind happens on its own thread, so a bind failure is only reported via onError.
        void onStarted();
    }

    public static class GuestInfo {
        public final String ip;
        public final String name;
        public final String mode;
        GuestInfo(String ip, String name, String mode) {
            this.ip = ip;
            this.name = name;
            this.mode = mode;
        }
    }

    private static class PendingGuest {
        final WebSocket conn;
        final String pin;
        final String mode;
        final ScheduledFuture<?> timeoutFuture;
        final String remoteAddress;
        final String deviceName;
        PendingGuest(WebSocket conn, String pin, String mode, ScheduledFuture<?> timeoutFuture, String remoteAddress, String deviceName) {
            this.conn = conn;
            this.pin = pin;
            this.mode = mode;
            this.timeoutFuture = timeoutFuture;
            this.remoteAddress = remoteAddress;
            this.deviceName = deviceName;
        }
    }

    private static class AdmittedGuest {
        final WebSocket conn;
        final String remoteAddress;
        final String deviceName;
        final String mode;
        // Secret the guest's UDP input lines must carry (see LinkInputRelay.startInputUdpServer).
        final String inputToken;
        AdmittedGuest(WebSocket conn, String remoteAddress, String deviceName, String mode, String inputToken) {
            this.conn = conn;
            this.remoteAddress = remoteAddress;
            this.deviceName = deviceName;
            this.mode = mode;
            this.inputToken = inputToken;
        }
    }

    private final Context context;
    private final Listener listener;
    private final byte[] myPublicKeyDer;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    private final Map<String, PendingGuest> pendingGuests = new ConcurrentHashMap<>();
    private final Map<String, AdmittedGuest> admittedGuests = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> connIds = new ConcurrentHashMap<>();
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
            String key2 = channel.socket().getRemoteSocketAddress().toString();
            pendingEngines.put(key2, engine);
            return new org.java_websocket.SSLSocketChannel2(channel, engine, exec, key);
        }
    }

    private final String hostDeviceType;

    public LinkInputGuestServer(Context context, int port, X509Certificate myCert, PrivateKey myKey, String hostDeviceType, Listener listener) throws Exception {
        super(new InetSocketAddress(port));
        this.context = context;
        this.listener = listener;
        this.hostDeviceType = hostDeviceType != null ? hostDeviceType : "phone";
        this.myPublicKeyDer = myCert.getPublicKey().getEncoded();

        SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);
        setWebSocketFactory(new ClientAuthSSLFactory(sslContext));
        setReuseAddr(true);
    }

    private final Map<WebSocket, byte[]> peerKeysByConn = new ConcurrentHashMap<>();

    private final java.util.Map<WebSocket, String> guestTokens = new java.util.concurrent.ConcurrentHashMap<>();

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        String presentedToken = LinkGuestAccess.tokenFromDescriptor(handshake.getResourceDescriptor());
        if (presentedToken != null) guestTokens.put(conn, presentedToken);
        String connId = UUID.randomUUID().toString();
        connIds.put(conn, connId);

        // Matched only by this connection's own address: any other engine belongs to another
        // client, and taking it would hand this one that client's certificate and PIN.
        String socketKey = conn.getRemoteSocketAddress() != null ? conn.getRemoteSocketAddress().toString() : "";
        SSLEngine engine = pendingEngines.remove(socketKey);
        if (engine != null) {
            try {
                Certificate[] certs = engine.getSession().getPeerCertificates();
                if (certs.length > 0) {
                    peerKeysByConn.put(conn, certs[0].getPublicKey().getEncoded());
                }
            } catch (SSLPeerUnverifiedException ignored) {}
        }
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        guestTokens.remove(conn);
        peerKeysByConn.remove(conn);
        if (conn.getRemoteSocketAddress() != null) {
            pendingEngines.remove(conn.getRemoteSocketAddress().toString());
        }
        String connId = connIds.remove(conn);
        if (connId != null) {
            PendingGuest pending = pendingGuests.remove(connId);
            if (pending != null && pending.timeoutFuture != null) {
                pending.timeoutFuture.cancel(false);
            }
        }

        for (Map.Entry<String, AdmittedGuest> entry : admittedGuests.entrySet()) {
            if (entry.getValue().conn == conn) {
                String ip = entry.getKey();
                admittedGuests.remove(ip);
                if (listener != null) listener.onGuestLeft(ip);
                break;
            }
        }
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        try {
            JSONObject obj = new JSONObject(message);
            String type = obj.optString("type");

            if ("join-guest".equals(type)) {
                handleJoinGuest(conn, obj);
            } else if ("packet".equals(type)) {
                for (AdmittedGuest guest : admittedGuests.values()) {
                    if (guest.conn == conn && "remotecontrol".equals(guest.mode) && listener != null) {
                        JSONObject body = obj.optJSONObject("body");
                        listener.onGuestPacket(guest.remoteAddress, obj.optString("packetType"), body != null ? body.toString() : "{}");
                        break;
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling message", e);
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        Log.e(TAG, "WebSocket error", ex);
        if (listener != null) listener.onError(ex != null ? ex.getMessage() : "Unknown error");
    }

    @Override
    public void onStart() {
        Log.i(TAG, "LinkInputGuestServer started on port " + getPort());
        if (listener != null) listener.onStarted();
    }

    private void handleJoinGuest(WebSocket conn, JSONObject msg) {
        String connId = connIds.get(conn);
        if (connId == null) return;

        String remoteAddress = null;
        if (conn.getRemoteSocketAddress() != null) {
            remoteAddress = conn.getRemoteSocketAddress().getAddress().getHostAddress();
        }
        if (remoteAddress == null) remoteAddress = "unknown";

        byte[] peerPublicKeyDer = peerKeysByConn.remove(conn);
        if (peerPublicKeyDer == null) {
            String socketKey = conn.getRemoteSocketAddress() != null ? conn.getRemoteSocketAddress().toString() : "";
            SSLEngine engine = pendingEngines.remove(socketKey);
            if (engine != null) {
                try {
                    Certificate[] certs = engine.getSession().getPeerCertificates();
                    if (certs.length > 0) {
                        peerPublicKeyDer = certs[0].getPublicKey().getEncoded();
                    }
                } catch (SSLPeerUnverifiedException ignored) {}
            }
        }

        if (peerPublicKeyDer == null) {
            conn.close(4001, "no client certificate presented");
            return;
        }

        String deviceName = msg.optString("deviceName", "Remote Controller");
        String mode = msg.optString("mode", "touchpad");
        // Extend Screen targets computers only. Every scanner in the app accepts the same QR code, so a
        // phone host can be reached here by mistake. Presenter, remote input and remote control all work
        // on a phone (the pointer dot is drawn by LinkPresenterOverlay, input goes through accessibility).
        if ("extendscreen".equals(mode) && "phone".equals(hostDeviceType)) {
            conn.close(4011, "unsupported target");
            return;
        }
        // A paired device has already been vouched for; only strangers get the PIN prompt.
        LinkTrustStore.TrustedDevice trusted = LinkTrustStore.getInstance(context).findByPublicKey(peerPublicKeyDer);
        if (trusted != null) {
            admit(conn, remoteAddress, deviceName, mode);
            return;
        }
        String pin = LinkVerification.computeCode(myPublicKeyDer, peerPublicKeyDer, "");
        LinkPairingWindow.Admission admission = LinkGuestAccess.admit(getPort(), guestTokens.remove(conn));
        if (LinkGuestAccess.refuses(admission)) {
            if (admission == LinkPairingWindow.Admission.CONFLICT) LinkGuestAccess.reportConflict(deviceName);
            try { conn.close(4007, "refused"); } catch (Exception ignored) {}
            return;
        }
        String uiPin = admission == LinkPairingWindow.Admission.QR ? "" : pin;

        final String finalIp = remoteAddress;
        ScheduledFuture<?> timeout = scheduler.schedule(() -> {
            pendingGuests.remove(connId);
            try { conn.close(4006, "confirmation timed out"); } catch (Exception ignored) {}
        }, GUEST_CONFIRM_TIMEOUT_MS, TimeUnit.MILLISECONDS);

        pendingGuests.put(connId, new PendingGuest(conn, uiPin, mode, timeout, finalIp, deviceName));

        try {
            JSONObject pinMsg = new JSONObject();
            pinMsg.put("type", "pin");
            pinMsg.put("code", pin);
            conn.send(pinMsg.toString());
        } catch (Exception ignored) {}

        if (listener != null) {
            listener.onGuestPinPending(connId, uiPin, finalIp, deviceName, mode);
        }
    }

    public synchronized boolean acceptGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return false;
        if (pending.timeoutFuture != null) pending.timeoutFuture.cancel(false);
        admit(pending.conn, pending.remoteAddress, pending.deviceName, pending.mode);
        return true;
    }

    private synchronized void admit(WebSocket conn, String remoteAddress, String deviceName, String mode) {
        String inputToken = LinkTransport.newInputToken();
        admittedGuests.put(remoteAddress, new AdmittedGuest(conn, remoteAddress, deviceName, mode, inputToken));

        try {
            JSONObject res = new JSONObject();
            res.put("type", "admitted");
            res.put("mode", mode);
            res.put("inputToken", inputToken);
            // Lets the guest UI (e.g. PresenterOverlay) choose its layout for the target type.
            res.put("hostDeviceType", hostDeviceType);
            conn.send(res.toString());
        } catch (Exception ignored) {}

        if (listener != null) {
            listener.onGuestJoined(remoteAddress, deviceName, mode);
        }
    }

    /** Sends a packet to an admitted remote-control guest, wrapped the way the guest unwraps it. */
    public void sendPacket(String remoteAddress, LinkPacket packet) {
        AdmittedGuest guest = admittedGuests.get(remoteAddress);
        if (guest == null || !guest.conn.isOpen()) return;
        try {
            guest.conn.send(new JSONObject().put("type", "packet").put("packetType", packet.type).put("body", packet.body).toString());
        } catch (Exception ignored) {}
    }

    public void rejectGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return;
        if (pending.timeoutFuture != null) pending.timeoutFuture.cancel(false);
        try { pending.conn.close(4007, "rejected by host"); } catch (Exception ignored) {}
    }

    public void blockGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return;
        if (pending.timeoutFuture != null) pending.timeoutFuture.cancel(false);
        try { pending.conn.close(4010, "blocked"); } catch (Exception ignored) {}
    }

    public void kickGuest(String ip) {
        AdmittedGuest guest = admittedGuests.remove(ip);
        if (guest != null) {
            try { guest.conn.close(1000, "removed by host"); } catch (Exception ignored) {}
            if (listener != null) listener.onGuestLeft(ip);
        }
    }

    /** The mode of the guest admitted at this address with this UDP input token, or null.
     *  Mirrors input_guest_mode() in core/input_guest.rs. */
    public String modeForToken(String remoteAddress, String token) {
        if (remoteAddress == null || token == null) return null;
        AdmittedGuest guest = admittedGuests.get(remoteAddress);
        return guest != null && guest.inputToken.equals(token) ? guest.mode : null;
    }

    public List<GuestInfo> getAdmittedGuests() {
        List<GuestInfo> list = new ArrayList<>();
        for (AdmittedGuest g : admittedGuests.values()) {
            list.add(new GuestInfo(g.remoteAddress, g.deviceName, g.mode));
        }
        return list;
    }

    public void stopServer() {
        try {
            scheduler.shutdownNow();
            super.stop();
        } catch (Exception e) {
            Log.e(TAG, "Error stopping server", e);
        }
    }
}
