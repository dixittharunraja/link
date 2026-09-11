package in.rodix.link;

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

public class LinkJoystickClient {
    private static final String TAG = "LinkJoystickClient";

    public interface Listener {
        void onPinComputed(String pin);
        void onAdmitted(int padIndex);
        void onRumble(int large, int small);
        void onPing();
        void onClosed(String reason);
        void onError(String message);
    }

    private final Listener listener;
    private WebSocketClient client;
    private boolean pinComputedLocally = false;

    public LinkJoystickClient(Listener listener) {
        this.listener = listener;
    }

    public void connect(String host, int port, String deviceName, X509Certificate myCert, PrivateKey myKey) {
        try {
            URI uri = new URI("wss://" + host + ":" + port);
            SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);

            client = new WebSocketClient(uri) {
                @Override
                public void onOpen(ServerHandshake handshakedata) {
                    computeAndReportPin(myCert);
                    try {
                        JSONObject msg = new JSONObject();
                        msg.put("type", "join-guest");
                        msg.put("deviceName", deviceName);
                        client.send(msg.toString());
                    } catch (Exception e) {
                        listener.onError("Failed to send join message: " + e.getMessage());
                    }
                }

                @Override
                public void onMessage(String message) {
                    handleControlMessage(message);
                }

                @Override
                public void onMessage(java.nio.ByteBuffer bytes) {}

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    // Stale-instance guard, mirroring LinkAudioSinkClient.java/
                    // LinkWalkieTalkieClient.java's identical check — disconnect() below nulls
                    // the outer `client` field synchronously, so by the time THIS async callback
                    // lands after our own intentional disconnect, `client` no longer points at `this`
                    // and the (now-meaningless) close reason/code is silently dropped instead of
                    // surfacing as an error the user never asked about (e.g. "code 1000").
                    if (client != this) return;
                    Log.i(TAG, "onClose code=" + code + " reason=" + reason + " remote=" + remote);
                    listener.onClosed(reason != null && !reason.isEmpty() ? reason : ("code " + code));
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
        } catch (Exception ignored) {}
    }

    private void handleControlMessage(String message) {
        try {
            JSONObject obj = new JSONObject(message);
            String type = obj.optString("type");
            if ("admitted".equals(type)) {
                int padIndex = obj.optInt("padIndex", 0);
                listener.onAdmitted(padIndex);
            } else if ("pin".equals(type) && !pinComputedLocally) {
                listener.onPinComputed(obj.optString("code"));
            } else if ("rumble".equals(type)) {
                int large = obj.optInt("large", 0);
                int small = obj.optInt("small", 0);
                listener.onRumble(large, small);
            } else if ("ping".equals(type)) {
                listener.onPing();
            }
        } catch (Exception ignored) {}
    }

    public void disconnect() {
        if (client != null) {
            try { client.close(); } catch (Exception ignored) {}
            client = null;
        }
    }
}
