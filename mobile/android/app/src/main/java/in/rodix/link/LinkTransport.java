package in.rodix.link;

// TLS transport — Java port of desktop/src/core/transport.ts, using javax.net.ssl since Java
// sockets are blocking (unlike Node's event loop) — each connection gets its own reader thread.
// See docs/PROTOCOL.md §5 for the trust model this implements.

import org.json.JSONObject;

import javax.net.ssl.KeyManager;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class LinkTransport {
    public static final int LINK_PORT = 1739; // arbitrary, distinct from KDE Connect's 1716/1717
    // File System's WebSocket server lives on LINK_PORT + 2 (see LinkFsServer.java). Audio
    // Relay's control-channel server (see LinkAudioRelayServer.java) lives on LINK_PORT + 3,
    // matching desktop's AUDIO_RELAY_PORT in core/transport.ts.
    public static final int AUDIO_RELAY_PORT = LINK_PORT + 3;
    // Dedicated UDP channel for the actual PCM stream — AUDIO_RELAY_PORT above now carries only
    // JSON control messages (join/admit/format/mute/end) over TLS/WebSocket; audio frames move
    // over UDP here to avoid TCP head-of-line blocking stalling playback behind one delayed/lost
    // packet. Matches desktop's AUDIO_RELAY_UDP_PORT.
    public static final int AUDIO_RELAY_UDP_PORT = AUDIO_RELAY_PORT + 1;
    public static final String PACKET_TYPE_IDENTITY = "link.identity";
    // Silent, transport-level-only packet — never forwarded to the listener, purely to prove
    // liveness and reset lastActivityAt. Mirrors desktop's transport.ts PACKET_TYPE_HEARTBEAT —
    // see that file's comment for why plain TCP keepalive alone wasn't fast/reliable enough.
    public static final String PACKET_TYPE_HEARTBEAT = "link.heartbeat";

    /** Accepts any certificate at the TLS layer — verification happens manually after identity exchange. */
    private static class TrustAllManager implements X509TrustManager {
        public void checkClientTrusted(X509Certificate[] chain, String authType) {}
        public void checkServerTrusted(X509Certificate[] chain, String authType) {}
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    // Package-visible (not private) so LinkPayloadTransfer can reuse the same TLS setup for
    // ephemeral upload/download connections.
    static SSLContext buildSslContext(X509Certificate cert, PrivateKey key) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        ks.setKeyEntry("link", key, "".toCharArray(), new X509Certificate[]{cert});

        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, "".toCharArray());

        SSLContext context = SSLContext.getInstance("TLS");
        context.init(
                kmf.getKeyManagers(),
                new TrustManager[]{new TrustAllManager()},
                new java.security.SecureRandom());
        return context;
    }

    public interface ConnectionListener {
        void onIdentity(LinkIdentity.Identity identity, X509Certificate peerCert);
        void onPacket(LinkPacket packet);
        void onClose();
    }

    /** Wraps one live TLS socket to a peer — either direction. */
    public static class PeerConnection {
        private final SSLSocket socket;
        private final LinkIdentity.Identity myIdentity;
        private final LinkPacket.StreamReader reader = new LinkPacket.StreamReader();
        private volatile ConnectionListener listener;
        public volatile LinkIdentity.Identity peerIdentity;
        public volatile X509Certificate peerCert;
        /** The peer's IP, regardless of which side dialed — needed for e.g. downloading a payload the peer announced. */
        public final String remoteAddress;
        private final AtomicBoolean closed = new AtomicBoolean(false);
        private final ExecutorService writeExecutor = Executors.newSingleThreadExecutor();
        private final boolean isOutgoing;
        /** Timestamp of the last inbound byte, of any kind — used to detect a dead peer ourselves instead of waiting on TCP keepalive. */
        public volatile long lastActivityAt = System.currentTimeMillis();

        PeerConnection(SSLSocket socket, LinkIdentity.Identity myIdentity, boolean isOutgoing) {
            this.socket = socket;
            this.myIdentity = myIdentity;
            this.isOutgoing = isOutgoing;
            this.remoteAddress = socket.getInetAddress() != null ? socket.getInetAddress().getHostAddress() : null;
        }

        public boolean isOutgoing() {
            return isOutgoing;
        }

        void start(ConnectionListener listener) {
            this.listener = listener;
            sendIdentity();
            Thread reader = new Thread(this::readLoop, "link-conn-reader");
            reader.setDaemon(true);
            reader.start();
        }

        private void sendIdentity() {
            try {
                JSONObject body = myIdentity.toJson();
                send(new LinkPacket(PACKET_TYPE_IDENTITY, body));
            } catch (Exception e) {
                close();
            }
        }

        private void readLoop() {
            try {
                InputStream in = socket.getInputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) != -1) {
                    lastActivityAt = System.currentTimeMillis();
                    for (LinkPacket packet : reader.push(buf, n)) {
                        if (packet.type.equals(PACKET_TYPE_IDENTITY)) {
                            handleIdentity(packet);
                        } else if (packet.type.equals(PACKET_TYPE_HEARTBEAT)) {
                            // lastActivityAt above already recorded it — nothing else to do.
                        } else {
                            listener.onPacket(packet);
                        }
                    }
                }
            } catch (Exception e) {
                android.util.Log.e("LinkTransport", "readLoop error", e);
            }
            close();
        }

        private void handleIdentity(LinkPacket packet) {
            try {
                peerIdentity = LinkIdentity.Identity.fromJson(packet.body);
                java.security.cert.Certificate[] chain = socket.getSession().getPeerCertificates();
                if (chain.length > 0) {
                    peerCert = (X509Certificate) chain[0];
                    listener.onIdentity(peerIdentity, peerCert);
                }
            } catch (Exception e) {
                android.util.Log.e("LinkTransport", "handleIdentity error", e);
                close();
            }
        }

        public void send(LinkPacket packet) {
            // close() shuts down writeExecutor; anything that races a send() against a
            // just-closed connection (a pairing reply, a heartbeat, a plugin action) used to
            // throw an uncaught RejectedExecutionException straight out of execute() and crash
            // the whole app — seen repeatedly in logcat as a fatal AndroidRuntime exception.
            // Since close() is happening anyway, silently dropping the send is correct: there's
            // no live connection left to deliver it over.
            if (closed.get()) return;
            try {
                writeExecutor.execute(() -> {
                    try {
                        OutputStream out = socket.getOutputStream();
                        out.write(packet.serialize());
                        out.flush();
                    } catch (Exception e) {
                        android.util.Log.e("LinkTransport", "send error", e);
                        close();
                    }
                });
            } catch (java.util.concurrent.RejectedExecutionException e) {
                // Lost the race against close() between the closed.get() check above and here —
                // harmless, there's nothing left to send to.
            }
        }

        public void sendHeartbeat() {
            try {
                send(new LinkPacket(PACKET_TYPE_HEARTBEAT, new JSONObject()));
            } catch (Exception ignored) {}
        }

        /** True if nothing at all has arrived from the peer in longer than timeoutMs — treat as dead. */
        public boolean isStale(long timeoutMs) {
            return System.currentTimeMillis() - lastActivityAt > timeoutMs;
        }

        public void close() {
            if (closed.compareAndSet(false, true)) {
                try { socket.close(); } catch (Exception ignored) {}
                writeExecutor.shutdown();
                if (listener != null) listener.onClose();
            }
        }
    }

    public interface ServerListener {
        void onConnection(PeerConnection connection);
    }

    public static class Server {
        private final SSLServerSocket serverSocket;
        private LinkIdentity.Identity myIdentity;
        private volatile boolean running = true;

        public void updateMyIdentity(LinkIdentity.Identity newIdentity) {
            this.myIdentity = newIdentity;
        }

        public Server(X509Certificate cert, PrivateKey key, LinkIdentity.Identity myIdentity, int port, ServerListener listener) throws Exception {
            this.myIdentity = myIdentity;
            SSLContext context = buildSslContext(cert, key);
            serverSocket = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(port);
            // Request (but don't require) the client's certificate — mirrors the desktop Node
            // server's `requestCert: true`. Without this, the peer's certificate never gets
            // presented during the handshake at all, and getPeerCertificates() throws
            // SSLPeerUnverifiedException the moment we try to read the peer's identity.
            serverSocket.setWantClientAuth(true);

            Thread acceptThread = new Thread(() -> {
                while (running) {
                    try {
                        SSLSocket socket = (SSLSocket) serverSocket.accept();
                        // See connectToPeer()'s keepalive comment — same half-open-connection risk
                        // applies to inbound connections (e.g. a PC dialing into this phone).
                        socket.setKeepAlive(true);
                        PeerConnection conn = new PeerConnection(socket, myIdentity, false);
                        listener.onConnection(conn);
                    } catch (Exception e) {
                        if (running) {
                            // Log and keep accepting — a single bad connection shouldn't kill the server.
                        }
                    }
                }
            }, "link-server-accept");
            acceptThread.setDaemon(true);
            acceptThread.start();
        }

        public void stop() {
            running = false;
            try { serverSocket.close(); } catch (Exception ignored) {}
        }
    }

    // A bare createSocket(host, port) blocks on the platform's default TCP connect timeout, which
    // can run into tens of seconds against an unreachable/firewalled peer (e.g. a stale discovery
    // entry, or a peer that dropped off Wi-Fi). Since discovery re-attempts this on every broadcast
    // (~every 5s) while hasPeer() is still false, a single hung attempt with no timeout was the
    // likely cause of "device stays invisible until the app is force-restarted" — nothing ever
    // failed to unblock the next retry. Connecting a plain socket first with an explicit short
    // timeout, then upgrading it to TLS, fails fast instead.
    private static final int CONNECT_TIMEOUT_MS = 4000;

    public static PeerConnection connectToPeer(String host, int port, X509Certificate cert, PrivateKey key, LinkIdentity.Identity myIdentity) throws Exception {
        SSLContext context = buildSslContext(cert, key);
        java.net.Socket rawSocket = new java.net.Socket();
        rawSocket.connect(new java.net.InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
        SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket(rawSocket, host, port, true);
        // A connection can go half-open (peer's radio slept, NAT/AP session dropped) without
        // either end noticing for a long time — the OS default TCP keepalive is hours. Without
        // this, a "connected" peer that's actually gone silently swallows anything sent to it
        // (including a pair request) instead of the socket ever reporting closed.
        socket.setKeepAlive(true);
        return new PeerConnection(socket, myIdentity, true);
    }
}
