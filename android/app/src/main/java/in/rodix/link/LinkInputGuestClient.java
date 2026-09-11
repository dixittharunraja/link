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

public class LinkInputGuestClient {
    private static final String TAG = "LinkInputGuestClient";

    public interface Listener {
        void onPinComputed(String pin);
        void onAdmitted(String mode);
        void onClosed(String reason);
        void onError(String message);
    }

    private final Listener listener;
    private WebSocketClient client;
    private boolean pinComputedLocally = false;

    public LinkInputGuestClient(Listener listener) {
        this.listener = listener;
    }

    public void connect(String host, int port, String deviceName, String mode, X509Certificate myCert, PrivateKey myKey) {
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
                        msg.put("mode", mode);
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
                String mode = obj.optString("mode", "touchpad");
                listener.onAdmitted(mode);
            } else if ("pin".equals(type) && !pinComputedLocally) {
                listener.onPinComputed(obj.optString("code"));
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
