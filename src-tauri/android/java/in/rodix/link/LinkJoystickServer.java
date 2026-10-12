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
 * Android Joystick Host Server.
 * Handles TLS WebSocket handshake on port 1748 (JOYSTICK_PORT) and integrates with LinkUinputGamepad
 * to receive real-time UDP controller inputs on port 1717.
 */
public class LinkJoystickServer extends WebSocketServer {
    private static final String TAG = "LinkJoystickServer";
    private static final long GUEST_CONFIRM_TIMEOUT_MS = 60000;
    private static final int MAX_JOYSTICK_PADS = 4;

    public interface Listener {
        void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName);
        void onControllerJoined(String remoteAddress, String deviceName, int padIndex);
        void onControllerLeft(String remoteAddress);
        void onDriverStatusChanged(String status, String error);
        void onError(String message);
    }

    public static class ControllerInfo {
        public final String ip;
        public final String name;
        public final int padIndex;
        ControllerInfo(String ip, String name, int padIndex) {
            this.ip = ip;
            this.name = name;
            this.padIndex = padIndex;
        }
    }

    private static class PendingGuest {
        final WebSocket conn;
        final String pin;
        final ScheduledFuture<?> timeoutFuture;
        final String remoteAddress;
        final String deviceName;
        PendingGuest(WebSocket conn, String pin, ScheduledFuture<?> timeoutFuture, String remoteAddress, String deviceName) {
            this.conn = conn;
            this.pin = pin;
            this.timeoutFuture = timeoutFuture;
            this.remoteAddress = remoteAddress;
            this.deviceName = deviceName;
        }
    }

    private static class AdmittedGuest {
        final WebSocket conn;
        final String remoteAddress;
        final String deviceName;
        final int padIndex;
        AdmittedGuest(WebSocket conn, String remoteAddress, String deviceName, int padIndex) {
            this.conn = conn;
            this.remoteAddress = remoteAddress;
            this.deviceName = deviceName;
            this.padIndex = padIndex;
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

    private final boolean[] allocatedPads = new boolean[MAX_JOYSTICK_PADS];
    private final LinkUinputGamepad gamepadDriver;

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

    public LinkJoystickServer(Context context, int port, X509Certificate myCert, PrivateKey myKey, Listener listener) throws Exception {
        super(new InetSocketAddress(port));
        this.context = context;
        this.listener = listener;
        this.myPublicKeyDer = myCert.getPublicKey().getEncoded();

        SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);
        setWebSocketFactory(new ClientAuthSSLFactory(sslContext));
        setReuseAddr(true);

        this.gamepadDriver = new LinkUinputGamepad(context, (status, error) -> {
            if (this.listener != null) this.listener.onDriverStatusChanged(status, error);
        });
        this.gamepadDriver.initialize();
    }

    private final Map<WebSocket, byte[]> peerKeysByConn = new ConcurrentHashMap<>();

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        String connId = UUID.randomUUID().toString();
        connIds.put(conn, connId);

        String socketKey = conn.getRemoteSocketAddress() != null ? conn.getRemoteSocketAddress().toString() : "";
        SSLEngine engine = pendingEngines.remove(socketKey);
        if (engine == null && pendingEngines.size() == 1) {
            engine = pendingEngines.values().iterator().next();
            pendingEngines.clear();
        }
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
        peerKeysByConn.remove(conn);
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
                int padIndex = entry.getValue().padIndex;
                if (padIndex >= 0 && padIndex < MAX_JOYSTICK_PADS) {
                    synchronized (allocatedPads) {
                        allocatedPads[padIndex] = false;
                    }
                }
                admittedGuests.remove(ip);
                if (listener != null) listener.onControllerLeft(ip);
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
        Log.i(TAG, "LinkJoystickServer started on port " + getPort());
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
            // Check fallback directly from SSLEngine if onOpen missed
            String socketKey = conn.getRemoteSocketAddress() != null ? conn.getRemoteSocketAddress().toString() : "";
            SSLEngine engine = pendingEngines.remove(socketKey);
            if (engine == null && pendingEngines.size() == 1) {
                engine = pendingEngines.values().iterator().next();
                pendingEngines.clear();
            }
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

        String deviceName = msg.optString("deviceName", "Phone Controller");
        String pin = LinkVerification.computeCode(myPublicKeyDer, peerPublicKeyDer, "");

        final String finalIp = remoteAddress;
        ScheduledFuture<?> timeout = scheduler.schedule(() -> {
            pendingGuests.remove(connId);
            try { conn.close(4006, "confirmation timed out"); } catch (Exception ignored) {}
        }, GUEST_CONFIRM_TIMEOUT_MS, TimeUnit.MILLISECONDS);

        pendingGuests.put(connId, new PendingGuest(conn, pin, timeout, finalIp, deviceName));

        try {
            JSONObject pinMsg = new JSONObject();
            pinMsg.put("type", "pin");
            pinMsg.put("code", pin);
            conn.send(pinMsg.toString());
        } catch (Exception ignored) {}

        if (listener != null) {
            listener.onGuestPinPending(connId, pin, finalIp, deviceName);
        }
    }

    public synchronized boolean acceptGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return false;
        if (pending.timeoutFuture != null) pending.timeoutFuture.cancel(false);

        int padIndex = -1;
        synchronized (allocatedPads) {
            for (int i = 0; i < MAX_JOYSTICK_PADS; i++) {
                if (!allocatedPads[i]) {
                    allocatedPads[i] = true;
                    padIndex = i;
                    break;
                }
            }
        }

        if (padIndex == -1) {
            try { pending.conn.close(4008, "slots_full"); } catch (Exception ignored) {}
            return false;
        }

        admittedGuests.put(pending.remoteAddress, new AdmittedGuest(pending.conn, pending.remoteAddress, pending.deviceName, padIndex));

        try {
            JSONObject res = new JSONObject();
            res.put("type", "admitted");
            res.put("padIndex", padIndex);
            pending.conn.send(res.toString());
        } catch (Exception ignored) {}

        if (listener != null) {
            listener.onControllerJoined(pending.remoteAddress, pending.deviceName, padIndex);
        }
        return true;
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

    public void kickController(String ip, String reason) {
        AdmittedGuest guest = admittedGuests.remove(ip);
        if (guest != null) {
            int pad = guest.padIndex;
            if (pad >= 0 && pad < MAX_JOYSTICK_PADS) {
                synchronized (allocatedPads) {
                    allocatedPads[pad] = false;
                }
            }
            try { guest.conn.close(1000, reason != null ? reason : "removed by host"); } catch (Exception ignored) {}
            if (listener != null) listener.onControllerLeft(ip);
        }
    }

    public void handleUdpJoystickReport(String ip, int lx, int ly, int rx, int ry, int lt, int rt, int buttons) {
        AdmittedGuest guest = admittedGuests.get(ip);
        if (guest == null) return;
        gamepadDriver.reportState(guest.padIndex, lx, ly, rx, ry, lt, rt, buttons);
    }

    public List<ControllerInfo> getConnectedControllers() {
        List<ControllerInfo> list = new ArrayList<>();
        for (AdmittedGuest g : admittedGuests.values()) {
            list.add(new ControllerInfo(g.remoteAddress, g.deviceName, g.padIndex));
        }
        return list;
    }

    public LinkUinputGamepad getGamepadDriver() {
        return gamepadDriver;
    }

    public void stopServer() {
        try {
            scheduler.shutdownNow();
            gamepadDriver.release();
            super.stop();
        } catch (Exception e) {
            Log.e(TAG, "Error stopping server", e);
        }
    }
}
