package in.rodix.link;

// Walkie Talkie — guest-side signaling client. Mirrors LinkAudioSinkClient.java's guest-PIN
// connect pattern (independent PIN computation from the peer's TLS certificate, falling back to
// the host's own 'pin' message if that fails) but carries no media at all — once admitted, this
// just exchanges the same opaque {type, body} signaling messages LinkPlugin.java already relays
// for paired devices over the main trusted connection.

import android.util.Log;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

import java.net.Socket;
import java.net.URI;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;

public class LinkWalkieTalkieClient {
    private static final String TAG = "LinkWalkieTalkieClient";

    public interface Listener {
        void onPinComputed(String pin);
        void onAdmitted();
        void onSignal(String type, String bodyJson);
        /** reason is 'removed by host' for a coordinator-initiated kick (same normal-closure code
         *  a graceful session end uses — see onClose below), null otherwise. */
        void onEnded(String reason);
        void onClosed(String reason);
        void onError(String message);
    }

    private final Listener listener;
    private WebSocketClient client;
    private boolean pinComputedLocally = false;
    // Mirrors LinkAudioSinkClient.java's localDeviceName field/default — without this, the
    // desktop-side WalkieTalkieServer's join-guest handler falls back to the literal string
    // "Guest" (see its own deviceName-parsing comment), showing that instead of this device's real
    // name in the coordinator's participant list.
    private String localDeviceName = "Guest";

    public LinkWalkieTalkieClient(Listener listener) {
        this.listener = listener;
    }

    public void connect(String host, int port, X509Certificate myCert, PrivateKey myKey, String deviceName) {
        this.localDeviceName = deviceName != null ? deviceName : "Guest";
        try {
            URI uri = new URI("wss://" + host + ":" + port);
            SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);

            client = new WebSocketClient(uri) {
                @Override
                public void onOpen(ServerHandshake handshakedata) {
                    computeAndReportPin(myCert);
                    try {
                        client.send(new JSONObject().put("type", "join-guest").put("deviceName", localDeviceName).toString());
                    } catch (Exception e) {
                        listener.onError("Failed to send join message: " + e.getMessage());
                    }
                }

                @Override
                public void onMessage(String message) {
                    handleControlMessage(message);
                }

                @Override
                public void onMessage(java.nio.ByteBuffer bytes) {
                    // No binary traffic on this connection at all — the actual audio is WebRTC.
                }

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    // Stale-instance guard, mirroring LinkAudioSinkClient.java's identical check —
                    // matters if connect() was ever called again before this socket's own async
                    // close callback landed, so an old instance's late event can't act on behalf
                    // of whatever's currently live in the `client` field.
                    if (client != this) return;
                    Log.i(TAG, "onClose code=" + code + " reason=" + reason + " remote=" + remote);
                    if (code == 1000 || code == 1001) {
                        listener.onEnded(reason != null && !reason.isEmpty() ? reason : null);
                    } else {
                        listener.onClosed(reason != null && !reason.isEmpty() ? reason : ("code " + code));
                    }
                }

                @Override
                public void onError(Exception ex) {
                    if (client != this) return;
                    Log.e(TAG, "onError", ex);
                    listener.onError(ex.getMessage());
                }
            };
            client.setSocketFactory(sslContext.getSocketFactory());
            client.connect();
        } catch (Exception e) {
            listener.onError("Failed to connect: " + e.getMessage());
        }
    }

    /** Best-effort independent PIN computation — mirrors LinkAudioSinkClient's identical method,
     *  see that file's comment for the full reasoning (java-websocket's client uses a plain
     *  blocking SSLSocket, unlike the server side's NIO SSLEngine reflection trick). */
    private void computeAndReportPin(X509Certificate myCert) {
        try {
            Socket socket = client.getSocket();
            if (socket instanceof SSLSocket) {
                Certificate[] chain = ((SSLSocket) socket).getSession().getPeerCertificates();
                if (chain.length > 0) {
                    String pin = LinkVerification.computeCode(myCert.getPublicKey().getEncoded(), chain[0].getPublicKey().getEncoded(), "");
                    pinComputedLocally = true;
                    listener.onPinComputed(pin);
                }
            }
        } catch (Exception e) {
            // Falls back to the host's own 'pin' control message below.
        }
    }

    private void handleControlMessage(String message) {
        try {
            JSONObject obj = new JSONObject(message);
            String type = obj.optString("type");
            if ("admitted".equals(type)) {
                listener.onAdmitted();
            } else if ("pin".equals(type) && !pinComputedLocally) {
                listener.onPinComputed(obj.optString("code"));
            } else {
                listener.onSignal(type, obj.optString("body", "{}"));
            }
        } catch (Exception ignored) {}
    }

    public void send(String type, String bodyJson) {
        if (client == null) return;
        try {
            JSONObject wrapped = new JSONObject();
            wrapped.put("type", type);
            wrapped.put("body", new JSONObject(bodyJson));
            client.send(wrapped.toString());
        } catch (Exception ignored) {}
    }

    public void disconnect() {
        if (client != null) {
            try { client.close(); } catch (Exception ignored) {}
            client = null;
        }
    }
}
