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
        /** inputToken: the secret this device's UDP input lines to the host must carry, or null. */
        void onAdmitted(String mode, String resolvedHost, String hostDeviceType, String inputToken);
        void onMessage(String json);
        void onClosed(String reason);
        void onError(String message);
    }

    private final Listener listener;
    private WebSocketClient client;
    private boolean pinComputedLocally = false;

    public LinkInputGuestClient(Listener listener) {
        this.listener = listener;
    }

    private volatile boolean resolved = false;
    private final java.util.List<WebSocketClient> pendingClients = new java.util.concurrent.CopyOnWriteArrayList<>();
    // The candidate address that answered. A scanned host string lists every address of the host
    // ("a,b"), which is only usable for connecting; the UDP movement relay (see
    // LinkInputRelay.sendUdpMessageToHost) needs the single real address, since InetAddress cannot
    // resolve the joined string and packets would be dropped silently.
    private volatile String resolvedHost;

    public void connect(final String host, final int port, final String deviceName, final String mode, final X509Certificate myCert, final PrivateKey myKey) {
        String[] hosts = host.split(",");
        for (int i = 0; i < hosts.length; i++) {
            hosts[i] = hosts[i].trim();
        }

        if (hosts.length <= 1) {
            connectSingle(host.trim(), port, deviceName, mode, myCert, myKey);
            return;
        }

        resolved = false;
        pendingClients.clear();

        try {
            final SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);

            for (final String singleHost : hosts) {
                if (singleHost.isEmpty()) continue;
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            final LinkGuestAccess.Scan scan = LinkGuestAccess.takeScan(singleHost);
                            URI uri = new URI(LinkGuestAccess.address(singleHost, port, scan));
                            final WebSocketClient ws = new WebSocketClient(uri) {
                                @Override
                                public void onOpen(ServerHandshake handshakedata) {
                                    if (!LinkGuestAccess.verifyHost(scan, this)) {
                                        listener.onError(LinkGuestAccess.MISMATCH);
                                        try { close(); } catch (Exception ignored) {}
                                        return;
                                    }
                                    synchronized (LinkInputGuestClient.this) {
                                        if (resolved) {
                                            try { close(); } catch (Exception ignored) {}
                                            return;
                                        }
                                        resolved = true;
                                        client = this;
                                        resolvedHost = singleHost;

                                        for (WebSocketClient c : pendingClients) {
                                            if (c != this) {
                                                try { c.close(); } catch (Exception ignored) {}
                                            }
                                        }
                                        pendingClients.clear();
                                    }

                                    Log.i(TAG, "onOpen (" + singleHost + ") — input guest connected");
                                    reportPin(scan, myCert);
                                    try {
                                        JSONObject msg = new JSONObject();
                                        msg.put("type", "join-guest");
                                        msg.put("deviceName", deviceName);
                                        msg.put("mode", mode);
                                        send(msg.toString());
                                    } catch (Exception e) {
                                        listener.onError("Failed to send join message: " + e.getMessage());
                                    }
                                }

                                @Override
                                public void onMessage(String message) {
                                    if (client == this) {
                                        handleControlMessage(message);
                                    }
                                }

                                @Override
                                public void onClose(int code, String reason, boolean remote) {
                                    if (client == this) {
                                        Log.i(TAG, "onClose code=" + code + " reason=" + reason + " remote=" + remote);
                                        listener.onClosed(reason != null && !reason.isEmpty() ? reason : ("code " + code));
                                    }
                                }

                                @Override
                                public void onError(Exception ex) {
                                    if (client == this) {
                                        Log.e(TAG, "onError (" + singleHost + ")", ex);
                                        listener.onError(ex.getMessage());
                                    }
                                }
                            };

                            ws.setSocketFactory(sslContext.getSocketFactory());
                            ws.setConnectionLostTimeout(10);
                            pendingClients.add(ws);
                            ws.connect();
                        } catch (Exception e) {
                            Log.w(TAG, "Failed to start connection attempt to " + singleHost, e);
                        }
                    }
                }).start();
            }
        } catch (Exception e) {
            listener.onError("Failed to connect: " + e.getMessage());
        }
    }

    private void connectSingle(String host, int port, String deviceName, String mode, X509Certificate myCert, PrivateKey myKey) {
        try {
            final LinkGuestAccess.Scan scan = LinkGuestAccess.takeScan(host);
            URI uri = new URI(LinkGuestAccess.address(host, port, scan));
            SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);

            client = new WebSocketClient(uri) {
                @Override
                public void onOpen(ServerHandshake handshakedata) {
                    if (!LinkGuestAccess.verifyHost(scan, this)) {
                        listener.onError(LinkGuestAccess.MISMATCH);
                        try { close(); } catch (Exception ignored) {}
                        return;
                    }
                    resolvedHost = host;
                    reportPin(scan, myCert);
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
            client.setConnectionLostTimeout(10);
            client.connect();
        } catch (Exception e) {
            listener.onError("Failed to connect: " + e.getMessage());
        }
    }

    // A scanned QR already verified the host, so there is no code to compare: the screen shows none.
    private void reportPin(LinkGuestAccess.Scan scan, X509Certificate myCert) {
        if (scan != null) {
            pinComputedLocally = true;
            listener.onPinComputed("");
            return;
        }
        computeAndReportPin(myCert);
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
                String hostDeviceType = obj.has("hostDeviceType") ? obj.optString("hostDeviceType") : null;
                String inputToken = obj.has("inputToken") ? obj.optString("inputToken") : null;
                listener.onAdmitted(mode, resolvedHost, hostDeviceType, inputToken);
            } else if ("pin".equals(type) && !pinComputedLocally) {
                listener.onPinComputed(obj.optString("code"));
            } else {
                // Remote control: the host's WebRTC signalling ({"type":"packet"}) rides this socket;
                // the screen itself arrives as a WebRTC video track.
                listener.onMessage(message);
            }
        } catch (Exception ignored) {}
    }

    public void send(String json) {
        WebSocketClient current = client;
        if (current != null && current.isOpen()) {
            try { current.send(json); } catch (Exception ignored) {}
        }
    }

    public void disconnect() {
        if (client != null) {
            try { client.close(); } catch (Exception ignored) {}
            client = null;
        }
    }
}
