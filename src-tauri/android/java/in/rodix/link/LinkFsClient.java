package in.rodix.link;

// Client for a peer's file server: another phone's LinkFsServer, or a PC's core/fs_server.rs, which
// speak the same protocol (see the header of fs_server.rs). One TLS WebSocket carries requests that
// each have an id, echoed by their reply:
//   text request  { id, action, ... }                  text reply   { id, success, error?, ...fields }
//   binary request int header length, header, bytes    binary reply int header length, { id, success }, bytes
// Metadata and bulk bytes use separate connections, so a listing never queues behind megabyte reads.
// The server's certificate must be the peer's pinned one; the peer in turn serves only the pinned
// certificate of a paired device.

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;

public class LinkFsClient {
    /** A reply: its JSON (the header, for a binary reply) and, for read and thumbnail, the bytes. */
    public static final class Reply {
        public final JSONObject json;
        public final byte[] data;

        Reply(JSONObject json, byte[] data) {
            this.json = json;
            this.data = data;
        }
    }

    private static final int CONNECT_TIMEOUT_MS = 5000;
    // A request with no answer (dozing radio, dropped link) must fail instead of hanging a transfer.
    private static final long REQUEST_TIMEOUT_MS = 30_000;
    private static final int MAX_HEADER = 64 * 1024;

    private final String host;
    private final int port;
    private final String pinnedFingerprint;
    private final SSLContext context;
    private Conn meta;
    private Conn bulk;
    private volatile boolean closed;

    public LinkFsClient(String host, int port, X509Certificate cert, PrivateKey key, String pinnedFingerprint) throws Exception {
        if (host == null || pinnedFingerprint == null || port <= 0) throw new IOException("Device is not reachable");
        this.host = host;
        this.port = port;
        this.pinnedFingerprint = pinnedFingerprint;
        this.context = LinkTransport.buildSslContext(cert, key);
    }

    public boolean isClosed() {
        return closed;
    }

    public void close() {
        closed = true;
        Conn m, b;
        synchronized (this) {
            m = meta;
            b = bulk;
            meta = null;
            bulk = null;
        }
        if (m != null) m.shutdown();
        if (b != null) b.shutdown();
    }

    /** A metadata request (listRoots, readdir, stat, create, delete, rename). Throws the peer's error. */
    public JSONObject request(String action, JSONObject args) throws Exception {
        return send(false, action, args, null, 0).json;
    }

    /** A request answered with bytes (read, thumbnail), on the bulk connection. */
    public byte[] requestData(String action, JSONObject args) throws Exception {
        Reply reply = send(true, action, args, null, 0);
        if (reply.data == null) throw new IOException("The device sent no data");
        return reply.data;
    }

    /** Writes `len` bytes of `data` at `offset` of a file on the peer. */
    public void write(String path, long offset, byte[] data, int len) throws Exception {
        JSONObject args = new JSONObject();
        args.put("path", path);
        args.put("offset", offset);
        send(true, "write", args, data, len);
    }

    private Reply send(boolean onBulk, String action, JSONObject args, byte[] data, int len) throws Exception {
        try {
            return conn(onBulk).send(action, args, data, len);
        } catch (IOException e) {
            // A connection that died while idle (peer restarted, Wi-Fi roamed): retry once on a fresh one.
            if (closed) throw e;
            return conn(onBulk).send(action, args, data, len);
        }
    }

    private Conn conn(boolean onBulk) throws Exception {
        synchronized (this) {
            if (closed) throw new IOException("File connection closed");
            Conn c = onBulk ? bulk : meta;
            if (c != null && c.isOpen()) return c;
            c = new Conn();
            c.open();
            if (onBulk) bulk = c; else meta = c;
            return c;
        }
    }

    /** One WebSocket, with the requests waiting on it. */
    private final class Conn {
        private final Map<String, CompletableFuture<Reply>> pending = new ConcurrentHashMap<>();
        private WebSocketClient ws;

        void open() throws Exception {
            ws = new WebSocketClient(new URI("wss://" + host + ":" + port + "/fs")) {
                @Override
                protected void onSetSSLParameters(SSLParameters parameters) {
                    // No host-name check: peers have self-signed certificates and are trusted by pin.
                }

                @Override
                public void onOpen(ServerHandshake handshake) { }

                @Override
                public void onMessage(String message) {
                    try {
                        JSONObject json = new JSONObject(message);
                        complete(json, null);
                    } catch (Exception ignored) { }
                }

                @Override
                public void onMessage(ByteBuffer frame) {
                    try {
                        if (frame.remaining() < 4) return;
                        int headerLen = frame.getInt();
                        if (headerLen < 0 || headerLen > MAX_HEADER || headerLen > frame.remaining()) return;
                        byte[] head = new byte[headerLen];
                        frame.get(head);
                        byte[] data = new byte[frame.remaining()];
                        frame.get(data);
                        complete(new JSONObject(new String(head, StandardCharsets.UTF_8)), data);
                    } catch (Exception ignored) { }
                }

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    failAll(new IOException("File connection closed"));
                }

                @Override
                public void onError(Exception ex) { }
            };
            ws.setSocketFactory(context.getSocketFactory());
            ws.setConnectionLostTimeout(30);
            if (!ws.connectBlocking(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                ws.close();
                throw new IOException("Could not connect to the device's file server");
            }
            try {
                java.security.cert.Certificate[] chain = ((SSLSocket) ws.getSocket()).getSession().getPeerCertificates();
                if (chain.length == 0 || !pinnedFingerprint.equals(LinkTls.fingerprint((X509Certificate) chain[0]))) {
                    throw new IOException("File server certificate does not match the paired device");
                }
            } catch (Exception e) {
                ws.close();
                throw e instanceof IOException ? (IOException) e : new IOException(e.getMessage());
            }
        }

        boolean isOpen() {
            return ws != null && ws.isOpen();
        }

        void shutdown() {
            if (ws != null) ws.close();
            failAll(new IOException("File connection closed"));
        }

        private void complete(JSONObject json, byte[] data) {
            CompletableFuture<Reply> waiter = pending.remove(json.optString("id"));
            if (waiter != null) waiter.complete(new Reply(json, data));
        }

        private void failAll(Exception reason) {
            for (String id : pending.keySet()) {
                CompletableFuture<Reply> waiter = pending.remove(id);
                if (waiter != null) waiter.completeExceptionally(reason);
            }
        }

        Reply send(String action, JSONObject args, byte[] data, int len) throws Exception {
            String id = UUID.randomUUID().toString();
            JSONObject header = args != null ? new JSONObject(args.toString()) : new JSONObject();
            header.put("id", id);
            header.put("action", action);
            CompletableFuture<Reply> waiter = new CompletableFuture<>();
            pending.put(id, waiter);
            try {
                if (data == null) {
                    ws.send(header.toString());
                } else {
                    byte[] head = header.toString().getBytes(StandardCharsets.UTF_8);
                    ByteBuffer frame = ByteBuffer.allocate(4 + head.length + len);
                    frame.putInt(head.length).put(head).put(data, 0, len);
                    frame.flip();
                    ws.send(frame);
                }
            } catch (org.java_websocket.exceptions.WebsocketNotConnectedException e) {
                pending.remove(id);
                throw new IOException("File connection closed");
            }
            Reply reply;
            try {
                reply = waiter.get(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                pending.remove(id);
                throw new Exception("File request " + action + " timed out");
            } catch (ExecutionException e) {
                Throwable cause = e.getCause();
                throw cause instanceof Exception ? (Exception) cause : e;
            }
            if (!reply.json.optBoolean("success", false)) {
                throw new Exception(reply.json.optString("error", "The device could not " + action + " that item"));
            }
            return reply;
        }
    }
}
