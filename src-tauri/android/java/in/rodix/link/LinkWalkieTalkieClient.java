package in.rodix.link;

// Walkie Talkie guest signaling client. Joins with the guest PIN flow (computing the PIN from the
// host's certificate, or using the host's "pin" message if that fails). Once admitted it only
// exchanges the opaque {type, body} signaling messages that paired devices send over the main
// connection; the audio itself is WebRTC.

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
        /** reason is "removed by host" when the coordinator kicked this device (it uses the same
         *  normal-closure code as a session end), otherwise null. */
        void onEnded(String reason);
        void onClosed(String reason);
        void onError(String message);
    }

    private final Listener listener;
    private WebSocketClient client;
    private boolean pinComputedLocally = false;
    // Sent in join-guest so the coordinator's participant list shows this device's name.
    private String localDeviceName = "Guest";

    public LinkWalkieTalkieClient(Listener listener) {
        this.listener = listener;
    }

    // How long to wait for any address to answer before giving up.
    private static final long CONNECT_TIMEOUT_MS = 15000;

    // A connect() call is one "attempt"; a newer call or disconnect() makes the older one stale.
    private final java.util.concurrent.atomic.AtomicInteger generation = new java.util.concurrent.atomic.AtomicInteger();
    private volatile boolean resolved = false;
    private final java.util.List<WebSocketClient> pendingClients = new java.util.concurrent.CopyOnWriteArrayList<>();

    /**
     * `host` is one address or several separated by commas: a host lists every address it has (Wi-Fi,
     * VPN, virtual adapters) and only some are reachable from here. All are tried together and the
     * first to answer is kept.
     */
    public void connect(final String host, final int port, final X509Certificate myCert, final PrivateKey myKey, String deviceName) {
        this.localDeviceName = deviceName != null ? deviceName : "Guest";
        final int attempt = generation.incrementAndGet();
        resolved = false;
        closePending(null);

        final java.util.List<String> hosts = new java.util.ArrayList<>();
        for (String h : host.split(",")) {
            String trimmed = h.trim();
            if (!trimmed.isEmpty()) hosts.add(trimmed);
        }
        if (hosts.isEmpty()) {
            listener.onError("No address to connect to");
            return;
        }

        final SSLContext sslContext;
        try {
            sslContext = LinkTransport.buildSslContext(myCert, myKey);
        } catch (Exception e) {
            listener.onError("Failed to connect: " + e.getMessage());
            return;
        }
        final java.util.concurrent.atomic.AtomicInteger remaining = new java.util.concurrent.atomic.AtomicInteger(hosts.size());

        for (final String singleHost : hosts) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        final LinkGuestAccess.Scan scan = LinkGuestAccess.takeScan(singleHost);
                        URI uri = new URI(LinkGuestAccess.address(singleHost, port, scan));
                        final WebSocketClient ws = new WebSocketClient(uri) {
                            private boolean failed = false;

                            // This address did not work out. Only when every one has failed is the user told.
                            private void fail(String message) {
                                synchronized (LinkWalkieTalkieClient.this) {
                                    if (failed) return;
                                    failed = true;
                                    if (resolved || generation.get() != attempt) return;
                                    if (remaining.decrementAndGet() > 0) return;
                                }
                                listener.onError(message != null && !message.isEmpty() ? message : "Could not reach the host");
                            }

                            @Override
                            public void onOpen(ServerHandshake handshakedata) {
                                if (!LinkGuestAccess.verifyHost(scan, this)) {
                                    fail(LinkGuestAccess.MISMATCH);
                                    try { close(); } catch (Exception ignored) {}
                                    return;
                                }
                                synchronized (LinkWalkieTalkieClient.this) {
                                    if (resolved || generation.get() != attempt) {
                                        try { close(); } catch (Exception ignored) {}
                                        return;
                                    }
                                    resolved = true;
                                    client = this;
                                    closePending(this);
                                }
                                Log.i(TAG, "onOpen (" + singleHost + ") — walkie-talkie guest connected");
                                reportPin(scan, myCert);
                                try {
                                    send(new JSONObject().put("type", "join-guest").put("deviceName", localDeviceName).toString());
                                } catch (Exception e) {
                                    listener.onError("Failed to send join message: " + e.getMessage());
                                }
                            }

                            @Override
                            public void onMessage(String message) {
                                if (client == this) handleControlMessage(message);
                            }

                            @Override
                            public void onMessage(java.nio.ByteBuffer bytes) {
                                // No binary traffic on this connection; the audio is WebRTC.
                            }

                            @Override
                            public void onClose(int code, String reason, boolean remote) {
                                // A socket that never became the connection just counts as a failed address.
                                if (client != this) {
                                    fail(reason);
                                    return;
                                }
                                Log.i(TAG, "onClose code=" + code + " reason=" + reason + " remote=" + remote);
                                if (code == 1000 || code == 1001) {
                                    listener.onEnded(reason != null && !reason.isEmpty() ? reason : null);
                                } else {
                                    listener.onClosed(reason != null && !reason.isEmpty() ? reason : ("code " + code));
                                }
                            }

                            @Override
                            public void onError(Exception ex) {
                                if (client != this) {
                                    Log.w(TAG, "Could not reach " + singleHost + ": " + ex);
                                    fail(ex.getMessage());
                                    return;
                                }
                                Log.e(TAG, "onError", ex);
                                listener.onError(ex.getMessage());
                            }
                        };
                        ws.setSocketFactory(sslContext.getSocketFactory());
                        pendingClients.add(ws);
                        ws.connect();
                    } catch (Exception e) {
                        Log.w(TAG, "Failed to start connection attempt to " + singleHost, e);
                        synchronized (LinkWalkieTalkieClient.this) {
                            if (resolved || generation.get() != attempt) return;
                            if (remaining.decrementAndGet() > 0) return;
                        }
                        listener.onError("Failed to connect: " + e.getMessage());
                    }
                }
            }).start();
        }

        // An address that never answers would otherwise leave the screen on "Connecting..." forever.
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Thread.sleep(CONNECT_TIMEOUT_MS);
                } catch (InterruptedException e) {
                    return;
                }
                synchronized (LinkWalkieTalkieClient.this) {
                    if (resolved || generation.get() != attempt) return;
                    generation.incrementAndGet();
                }
                closePending(null);
                listener.onError("Connection timed out");
            }
        }).start();
    }

    /** Closes every connection attempt still waiting, except `keep`. */
    private void closePending(WebSocketClient keep) {
        for (WebSocketClient c : pendingClients) {
            if (c != keep) {
                try { c.close(); } catch (Exception ignored) {}
            }
        }
        pendingClients.clear();
    }

    /** Computes the PIN from the host's certificate on the client's SSLSocket, when available. */
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
        } catch (Exception e) {
            // Fall back to the host's "pin" message (handleControlMessage).
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
        // Makes any attempt still in flight stale, so a late answer from an old address is ignored.
        generation.incrementAndGet();
        closePending(null);
        if (client != null) {
            try { client.close(); } catch (Exception ignored) {}
            client = null;
        }
    }
}
