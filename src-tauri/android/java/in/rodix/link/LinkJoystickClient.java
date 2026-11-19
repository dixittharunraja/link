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
        /** inputToken: the secret this controller's UDP "js" lines must carry, or null when the
         *  host issues none. */
        void onAdmitted(int padIndex, String inputToken);
        void onRumble(int large, int small);
        void onPing();
        void onClosed(String reason);
        void onError(String message);
    }

    private final Listener listener;
    private WebSocketClient client;
    private boolean pinComputedLocally = false;
    private volatile boolean resolved = false;
    private final java.util.List<WebSocketClient> pendingClients = new java.util.concurrent.CopyOnWriteArrayList<>();

    public LinkJoystickClient(Listener listener) {
        this.listener = listener;
    }

    // The one address that actually answered. A scanned QR lists every address of the host
    // ("a,b"), which is only meaningful for connecting; the controller's UDP stream needs the real
    // one, or InetAddress cannot resolve it and every input packet is silently dropped.
    private volatile String resolvedHost;

    public String getResolvedHost() {
        return resolvedHost;
    }

    private String sanitizeHost(String raw) {
        if (raw == null) return "";
        String clean = raw.trim();
        if (clean.startsWith("link:")) {
            String[] parts = clean.split(":");
            if (parts.length >= 2) clean = parts[1];
        } else if (clean.startsWith("http://") || clean.startsWith("https://")) {
            clean = clean.replaceFirst("^https?://", "").split("/")[0].split(":")[0];
        } else if (clean.contains(":")) {
            clean = clean.split(":")[0];
        }
        return clean.trim();
    }

    public void connect(final String host, final int port, final String deviceName, final X509Certificate myCert, final PrivateKey myKey) {
        String[] rawHosts = host.split(",");
        java.util.List<String> validHosts = new java.util.ArrayList<>();
        for (String rh : rawHosts) {
            String sanitized = sanitizeHost(rh);
            if (!sanitized.isEmpty() && !validHosts.contains(sanitized)) {
                validHosts.add(sanitized);
            }
        }

        if (validHosts.isEmpty()) {
            listener.onError("Invalid host address");
            return;
        }

        if (validHosts.size() == 1) {
            connectSingle(validHosts.get(0), port, deviceName, myCert, myKey);
            return;
        }

        resolved = false;
        pendingClients.clear();

        try {
            final SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);

            for (final String singleHost : validHosts) {
                new Thread(() -> {
                    try {
                        // A scanned QR names the host's key and carries a one-time token (see LinkGuestAccess).
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
                                synchronized (LinkJoystickClient.this) {
                                    if (resolved) {
                                        try { close(); } catch (Exception ignored) {}
                                        return;
                                    }
                                    resolved = true;
                                    client = this;

                                    for (WebSocketClient c : pendingClients) {
                                        if (c != this) {
                                            try { c.close(); } catch (Exception ignored) {}
                                        }
                                    }
                                    pendingClients.clear();
                                }

                                resolvedHost = singleHost;
                                Log.i(TAG, "onOpen (" + singleHost + ") — joystick guest connected");
                                reportPin(scan, myCert);
                                try {
                                    JSONObject msg = new JSONObject();
                                    msg.put("type", "join-guest");
                                    msg.put("deviceName", deviceName);
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
                        Log.w(TAG, "Failed connection attempt to " + singleHost, e);
                    }
                }).start();
            }
        } catch (Exception e) {
            listener.onError("Failed to connect: " + e.getMessage());
        }
    }

    private void connectSingle(String host, int port, String deviceName, X509Certificate myCert, PrivateKey myKey) {
        try {
            // A scanned QR names the host's key and carries a one-time token (see LinkGuestAccess).
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
                int padIndex = obj.optInt("padIndex", 0);
                String inputToken = obj.has("inputToken") ? obj.optString("inputToken") : null;
                listener.onAdmitted(padIndex, inputToken);
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
        for (WebSocketClient c : pendingClients) {
            try { c.close(); } catch (Exception ignored) {}
        }
        pendingClients.clear();
    }
}
