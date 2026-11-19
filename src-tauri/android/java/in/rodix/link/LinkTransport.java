package in.rodix.link;

// TLS transport, the Java counterpart of desktop's core/transport.rs. Java sockets are blocking,
// so each connection gets its own reader thread. Trust model: trust-on-first-use with pinned
// certificates.

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
    // TCP port of the TLS control channel. Discovery broadcasts on UDP 1716 (LinkDiscovery,
    // core/discovery.rs) and the input relay listens on UDP 1717. Other device-sync apps use the
    // same ports, so Link cannot run beside them on one device.
    public static final int LINK_PORT = 1739;
    // Port layout matches desktop. LINK_PORT + 2 is the File System WebSocket server (LinkFsServer).
    // Audio Relay control channel (TLS WebSocket); matches AUDIO_SINK_PORT in core/audio_sink.rs.
    public static final int AUDIO_RELAY_PORT = LINK_PORT + 3;
    // Audio Relay audio frames over UDP, avoiding TCP head-of-line blocking; matches
    // AUDIO_SINK_UDP_PORT.
    public static final int AUDIO_RELAY_UDP_PORT = AUDIO_RELAY_PORT + 1;
    // Portal Mode file transfer with unpaired guests, kept apart from the trusted connection;
    // matches PORTAL_PORT in core/portal.rs.
    public static final int PORTAL_TRANSFER_PORT = LINK_PORT + 7;
    // Walkie Talkie signaling for unpaired guests (manual IP + PIN). Paired devices signal over
    // the main connection, and the audio itself is WebRTC in the WebView. Matches desktop's
    // WALKIE_TALKIE_PORT.
    public static final int WALKIE_TALKIE_PORT = LINK_PORT + 8;
    public static final int JOYSTICK_PORT = LINK_PORT + 9;
    public static final int INPUT_GUEST_PORT = LINK_PORT + 10;
    public static final String PACKET_TYPE_IDENTITY = "link.identity";
    // Transport-level liveness packet (TCP keepalive is too slow to detect a dead peer); handled
    // here rather than passed to onPacket. Matches PACKET_TYPE_HEARTBEAT in core/packet.rs.
    public static final String PACKET_TYPE_HEARTBEAT = "link.heartbeat";
    // A connection silent this long loses a duplicate-connection tie-break to a fresh one, and is
    // dropped when the peer turns up at another address. Well above the 10 s heartbeat, so a live
    // connection between two pings is never taken for a dead one. Matches STALE_AFTER_MS in
    // core/transport.rs.
    public static final long STALE_AFTER_MS = 10000;
    // A read that blocks this long ends the connection. The heartbeat cycle normally closes a silent
    // connection after 30 s; this also covers a socket that never finishes its TLS handshake or never
    // identifies itself (the cycle only sees identified peers). Generous, so a phone whose timers are
    // delayed by Doze is not dropped while the peer still pings it every 10 s.
    static final int READ_TIMEOUT_MS = 60000;
    // A connection that has not identified itself by then is closed (matches IDENTIFY_TIMEOUT in
    // core/transport.rs), and at most this many inbound ones may be waiting to do so.
    static final long IDENTIFY_TIMEOUT_MS = 30000;
    static final int MAX_UNIDENTIFIED = 32;

    private static final java.security.SecureRandom TOKEN_RANDOM = new java.security.SecureRandom();

    /** A fresh 128-bit secret as 32 hex characters, for the UDP input relay: the receiver hands
     *  one to each sender over TLS, and every input datagram carries it (see core/input_relay.rs). */
    static String newInputToken() {
        byte[] bytes = new byte[16];
        TOKEN_RANDOM.nextBytes(bytes);
        StringBuilder hex = new StringBuilder(32);
        for (byte b : bytes) hex.append(String.format("%02x", b & 0xff));
        return hex.toString();
    }

    /** Accepts any certificate at the TLS layer — verification happens manually after identity exchange. */
    private static class TrustAllManager implements X509TrustManager {
        public void checkClientTrusted(X509Certificate[] chain, String authType) {}
        public void checkServerTrusted(X509Certificate[] chain, String authType) {}
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    // Building a context (key store, key manager, SecureRandom seeding) is costly and every dial and
    // server did it afresh; the identity is fixed for the life of the process, so the last one is kept
    // and handed out again for the same certificate and key. SSLContext is thread-safe.
    private static SSLContext cachedContext;
    private static X509Certificate cachedCert;
    private static PrivateKey cachedKey;

    // Package-visible so the other TLS servers and LinkPayloadTransfer share this setup.
    static synchronized SSLContext buildSslContext(X509Certificate cert, PrivateKey key) throws Exception {
        if (cachedContext != null && cert == cachedCert && key == cachedKey) {
            return cachedContext;
        }
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
        cachedContext = context;
        cachedCert = cert;
        cachedKey = key;
        return context;
    }

    public interface ConnectionListener {
        void onIdentity(LinkIdentity.Identity identity, X509Certificate peerCert);
        void onPacket(LinkPacket packet);
        void onHeartbeat(String poolHash);
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
        /** Timestamp of the last inbound byte, of any kind — used to detect a dead peer ourselves instead of waiting on TCP keepalive.
         *  Set only by the reader: this side's own sends (heartbeats included) prove nothing about the peer. */
        public volatile long lastRxAt = System.currentTimeMillis();
        public java.util.concurrent.Callable<String> poolHashProvider;
        private final long openedAt = System.currentTimeMillis();
        // An inbound connection's place among those not yet identified (Server); given back once.
        private volatile Runnable releaseSlot;

        private void releaseSlot() {
            Runnable release = releaseSlot;
            releaseSlot = null;
            if (release != null) release.run();
        }

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
                    lastRxAt = System.currentTimeMillis();
                    // However it trickles bytes, a peer gets IDENTIFY_TIMEOUT_MS to say who it is.
                    if (peerIdentity == null && lastRxAt - openedAt > IDENTIFY_TIMEOUT_MS) {
                        android.util.Log.w("LinkTransport", "Peer never identified itself; closing");
                        break;
                    }
                    // push() throws once a line runs past the limit, which ends this connection.
                    for (LinkPacket packet : reader.push(buf, n)) {
                        if (packet.type.equals(PACKET_TYPE_IDENTITY)) {
                            handleIdentity(packet);
                            if (peerIdentity != null) reader.setLimit(LinkPacket.MAX_LINE);
                        } else if (packet.type.equals(PACKET_TYPE_HEARTBEAT)) {
                            String poolHash = packet.body != null ? packet.body.optString("poolHash", null) : null;
                            if (listener != null) {
                                listener.onHeartbeat(poolHash);
                            }
                            boolean isReply = packet.body != null && packet.body.optBoolean("reply", false);
                            if (!isReply) {
                                String myHash = null;
                                if (poolHashProvider != null) {
                                    try { myHash = poolHashProvider.call(); } catch (Exception ignored) {}
                                }
                                sendHeartbeat(true, myHash);
                            }
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
                    releaseSlot();
                    listener.onIdentity(peerIdentity, peerCert);
                }
            } catch (Exception e) {
                android.util.Log.e("LinkTransport", "handleIdentity error", e);
                close();
            }
        }

        public void send(LinkPacket packet) {
            // close() shuts down writeExecutor, so a send racing a close would throw an uncaught
            // RejectedExecutionException. Such sends are dropped; there is nothing to deliver to.
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
                // Closed between the check above and execute(); drop the packet.
            }
        }

        public void sendHeartbeat() {
            sendHeartbeat(false, null);
        }

        public void sendHeartbeat(boolean isReply) {
            sendHeartbeat(isReply, null);
        }

        public void sendHeartbeat(boolean isReply, String poolHash) {
            try {
                JSONObject body = new JSONObject();
                body.put("reply", isReply);
                if (poolHash != null) body.put("poolHash", poolHash);
                send(new LinkPacket(PACKET_TYPE_HEARTBEAT, body));
            } catch (Exception ignored) {}
        }

        /** True if nothing at all has arrived from the peer in longer than timeoutMs — treat as dead. */
        public boolean isStale(long timeoutMs) {
            return System.currentTimeMillis() - lastRxAt > timeoutMs;
        }

        public void closeGracefully() {
            releaseSlot();
            if (closed.compareAndSet(false, true)) {
                writeExecutor.execute(() -> {
                    try { socket.close(); } catch (Exception ignored) {}
                    writeExecutor.shutdown();
                });
                if (listener != null) listener.onClose();
            }
        }

        public void close() {
            releaseSlot();
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
        // Read for every accepted connection, so a rename reaches new connections.
        private volatile LinkIdentity.Identity myIdentity;
        private volatile boolean running = true;
        // Accepted connections that have not identified themselves yet.
        private final java.util.concurrent.atomic.AtomicInteger unidentified = new java.util.concurrent.atomic.AtomicInteger();

        public void updateMyIdentity(LinkIdentity.Identity newIdentity) {
            this.myIdentity = newIdentity;
        }

        public Server(X509Certificate cert, PrivateKey key, LinkIdentity.Identity myIdentity, int port, ServerListener listener) throws Exception {
            this.myIdentity = myIdentity;
            SSLContext context = buildSslContext(cert, key);
            serverSocket = (SSLServerSocket) context.getServerSocketFactory().createServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new java.net.InetSocketAddress(port));
            in.rodix.link.connection.LinkCryptoProvider.configureServerSocket(serverSocket);
            // Request the client certificate (as desktop's AnyClientCert does); without it the
            // client never presents one and getPeerCertificates() throws.
            serverSocket.setWantClientAuth(true);

            Thread acceptThread = new Thread(() -> {
                while (running) {
                    try {
                        SSLSocket socket = (SSLSocket) serverSocket.accept();
                        if (unidentified.incrementAndGet() > MAX_UNIDENTIFIED) {
                            unidentified.decrementAndGet();
                            android.util.Log.w("LinkTransport", "Refusing a connection: too many have not identified themselves");
                            try { socket.close(); } catch (Exception ignored) {}
                            continue;
                        }
                        PeerConnection conn;
                        try {
                            in.rodix.link.connection.LinkCryptoProvider.configureTlsSocket(socket);
                            socket.setTcpNoDelay(true);
                            socket.setKeepAlive(true);
                            socket.setSoTimeout(READ_TIMEOUT_MS);
                            conn = new PeerConnection(socket, this.myIdentity, false);
                        } catch (Exception e) {
                            unidentified.decrementAndGet();
                            try { socket.close(); } catch (Exception ignored) {}
                            continue;
                        }
                        conn.releaseSlot = unidentified::decrementAndGet;
                        listener.onConnection(conn);
                    } catch (Exception e) {
                        if (running) {
                            // Keep accepting; one bad connection must not stop the server.
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

    // The default TCP connect timeout can be tens of seconds for an unreachable peer, which would
    // stall discovery's periodic reconnect attempts. A plain socket is connected with a short
    // timeout first and then upgraded to TLS.
    private static final int CONNECT_TIMEOUT_MS = 4000;

    public static PeerConnection connectToPeer(String host, int port, X509Certificate cert, PrivateKey key, LinkIdentity.Identity myIdentity) throws Exception {
        SSLContext context = buildSslContext(cert, key);
        java.net.Socket rawSocket = new java.net.Socket();
        rawSocket.setTcpNoDelay(true);
        rawSocket.setKeepAlive(true);
        rawSocket.connect(new java.net.InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
        SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket(rawSocket, host, port, true);
        in.rodix.link.connection.LinkCryptoProvider.configureTlsSocket(socket);
        socket.setTcpNoDelay(true);
        socket.setKeepAlive(true);
        socket.setSoTimeout(READ_TIMEOUT_MS);
        return new PeerConnection(socket, myIdentity, true);
    }
}
