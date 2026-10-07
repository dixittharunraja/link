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
        void onAdmitted(String mode, String resolvedHost, String hostDeviceType);
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
    // Which candidate host actually won the connection race — a QR/host-string like
    // "192.168.1.100,172.20.10.1" (this device's several local IPs, see useHostQrCode) is only
    // ever meaningful for CONNECTING (try each, use whichever answers). Reusing that same raw,
    // comma-joined string afterwards for anything address-shaped — e.g. the high-rate UDP relay
    // Presenter/Touchpad use for their actual movement data (see sendUdpMessageToHost) — silently
    // fails: InetAddress.getByName() can't resolve a comma-joined string as a single hostname, so
    // every packet after a successful connection was dropped with no visible error (an Android-
    // side exception, never surfaced to the desktop or the JS console). This is the one real IP
    // that was reached, for the caller to use for everything after admission.
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
                            URI uri = new URI("wss://" + singleHost + ":" + port);
                            final WebSocketClient ws = new WebSocketClient(uri) {
                                @Override
                                public void onOpen(ServerHandshake handshakedata) {
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
                                    computeAndReportPin(myCert);
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
                                public void onMessage(java.nio.ByteBuffer bytes) {}

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
            URI uri = new URI("wss://" + host + ":" + port);
            SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);

            client = new WebSocketClient(uri) {
                @Override
                public void onOpen(ServerHandshake handshakedata) {
                    resolvedHost = host;
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
            client.setConnectionLostTimeout(10);
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
                String hostDeviceType = obj.has("hostDeviceType") ? obj.optString("hostDeviceType") : null;
                listener.onAdmitted(mode, resolvedHost, hostDeviceType);
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
