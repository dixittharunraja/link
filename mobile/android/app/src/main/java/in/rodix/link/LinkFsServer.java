package in.rodix.link;

import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.util.Log;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.DefaultSSLWebSocketServerFactory;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.RandomAccessFile;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ByteChannel;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;

public class LinkFsServer extends WebSocketServer {
    private static final String TAG = "LinkFsServer";
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Context context;
    private final LinkTrustStore trustStore;

    // Keyed by remote socket address (unique per live TCP connection) — populated by the SSL
    // factory when it creates the engine for a channel, read back in onOpen() to pull the peer's
    // certificate out of the completed handshake. There is no other public way to get from a
    // WebSocket conn back to the SSLEngine that authenticated it in this library.
    private final Map<String, SSLEngine> pendingEngines = new ConcurrentHashMap<>();
    // Authenticated deviceId per live connection, set once in onOpen() after trust-store lookup
    // succeeds. Every action handler must check this before touching the filesystem.
    private final Map<WebSocket, String> connDeviceId = new ConcurrentHashMap<>();

    private final List<String> allowedRoots = new ArrayList<>();

    // High-performance Wi-Fi lock + partial wake lock, held only while at least one authenticated
    // FS client is connected (i.e. a drive is mounted on the PC). Android aggressively power-saves
    // the Wi-Fi radio between packets, which shows up as latency spikes and stalls on 2.4GHz/hotspot
    // links (5GHz masks it better) — holding WIFI_MODE_FULL_HIGH_PERF keeps the radio hot, and the
    // partial wake lock keeps the CPU serving reads even with the screen off. Reference-counted so
    // the pool's several sockets acquire once (on the first) and release once (on the last).
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private android.os.PowerManager.WakeLock wakeLock;
    private int activeConnections = 0;
    private final Object lockGuard = new Object();

    private class ClientAuthSSLFactory extends DefaultSSLWebSocketServerFactory {
        ClientAuthSSLFactory(SSLContext sslContext) {
            super(sslContext);
        }

        @Override
        public ByteChannel wrapChannel(SocketChannel channel, SelectionKey key) throws java.io.IOException {
            SSLEngine engine = sslcontext.createSSLEngine();
            engine.setUseClientMode(false);
            // Require (not just request) the client's certificate — an FS connection with no
            // presented cert, or one that doesn't match a paired device, must not be served.
            engine.setNeedClientAuth(true);
            String key2 = channel.socket().getRemoteSocketAddress().toString();
            pendingEngines.put(key2, engine);
            return new org.java_websocket.SSLSocketChannel2(channel, engine, exec, key);
        }
    }

    public LinkFsServer(Context context, X509Certificate cert, PrivateKey key, int port) throws Exception {
        super(new InetSocketAddress(port));
        this.context = context;
        this.trustStore = new LinkTrustStore(context);

        File primary = Environment.getExternalStorageDirectory();
        allowedRoots.add(canonicalOrNull(primary));
        File storageDir = new File("/storage");
        if (storageDir.exists() && storageDir.isDirectory()) {
            File[] files = storageDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (f.isDirectory() && f.canRead() && !f.getName().equals("self") && !f.getName().equals("emulated")) {
                        allowedRoots.add(canonicalOrNull(f));
                    }
                }
            }
        }
        allowedRoots.removeIf(java.util.Objects::isNull);

        // Reuse the TLS setup from LinkTransport
        SSLContext sslContext = LinkTransport.buildSslContext(cert, key);
        setWebSocketFactory(new ClientAuthSSLFactory(sslContext));

        // Disable DNS resolution delays
        setConnectionLostTimeout(20);

        try {
            android.net.wifi.WifiManager wifiManager =
                (android.net.wifi.WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                // WIFI_MODE_FULL_HIGH_PERF (deprecated in API 29+ but still the only mode that works
                // reliably for a background foreground-service, unlike FULL_LOW_LATENCY which is
                // gated to a UI-foreground app) — disables the radio's power-save between packets.
                wifiLock = wifiManager.createWifiLock(
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Link:fs-wifi");
                wifiLock.setReferenceCounted(false);
            }
            android.os.PowerManager pm = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "Link:fs-cpu");
                wakeLock.setReferenceCounted(false);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to create Wi-Fi/wake locks — transfers will still work, just without power-save suppression", e);
        }
    }

    /** Called once per authenticated connection. Acquires the locks on the first, so the pool's
     *  several sockets don't each toggle them. */
    private void onAuthenticatedConnect() {
        synchronized (lockGuard) {
            activeConnections++;
            if (activeConnections == 1) {
                try { if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire(); } catch (Exception ignored) {}
                try { if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(); } catch (Exception ignored) {}
                Log.i(TAG, "FS client connected — acquired high-perf Wi-Fi + wake lock.");
            }
        }
    }

    /** Called once per authenticated disconnect. Releases the locks when the last client leaves. */
    private void onAuthenticatedDisconnect() {
        synchronized (lockGuard) {
            if (activeConnections > 0) activeConnections--;
            if (activeConnections == 0) {
                try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
                try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
                Log.i(TAG, "Last FS client disconnected — released Wi-Fi + wake lock.");
            }
        }
    }

    private static String canonicalOrNull(File f) {
        try {
            return f.getCanonicalPath();
        } catch (Exception e) {
            return null;
        }
    }

    /** Resolves and checks that `path` is inside one of the declared storage roots — the real
     *  containment check the previous cosmetic "/Android/data" substring test never was. */
    private boolean isPathAllowed(String path) {
        try {
            String canon = new File(path).getCanonicalPath();
            for (String root : allowedRoots) {
                if (canon.equals(root) || canon.startsWith(root + File.separator)) {
                    return true;
                }
            }
        } catch (Exception e) {
            // Unresolvable path (broken symlink, permission error while canonicalizing, ...) —
            // fail closed.
        }
        return false;
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        Log.i(TAG, "New WSS FS connection from " + conn.getRemoteSocketAddress());
        try {
            java.lang.reflect.Method getSocketMethod = conn.getClass().getMethod("getSocket");
            java.net.Socket socket = (java.net.Socket) getSocketMethod.invoke(conn);
            if (socket != null) {
                socket.setTcpNoDelay(true);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to optimize socket parameters", e);
        }

        String deviceId = authenticate(conn);
        if (deviceId == null) {
            Log.w(TAG, "Rejecting unauthenticated/untrusted FS connection from " + conn.getRemoteSocketAddress());
            conn.close();
            return;
        }
        connDeviceId.put(conn, deviceId);
        onAuthenticatedConnect();
    }

    /** Pulls the peer's TLS certificate out of the SSLEngine that authenticated this connection
     *  and matches it, by pinned fingerprint, against a currently paired device. Returns the
     *  matched deviceId, or null if the connection cannot be attributed to a trusted device. */
    private String authenticate(WebSocket conn) {
        SocketAddress addr = conn.getRemoteSocketAddress();
        if (addr == null) return null;
        SSLEngine engine = pendingEngines.remove(addr.toString());
        if (engine == null) return null;
        try {
            Certificate[] chain = engine.getSession().getPeerCertificates();
            if (chain.length == 0) return null;
            X509Certificate peerCert = (X509Certificate) chain[0];
            String peerFingerprint = LinkTls.fingerprint(peerCert);
            for (LinkTrustStore.TrustedDevice dev : trustStore.list()) {
                try {
                    if (LinkTls.fingerprint(dev.certificate()).equals(peerFingerprint)) {
                        return dev.deviceId;
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to authenticate FS peer", e);
        }
        return null;
    }

    /** Every action handler must call this first. Denies if the connection's authenticated
     *  device isn't the one being asked about, or hasn't been granted fileaccess. */
    private boolean checkPermission(WebSocket conn, String id) {
        String deviceId = connDeviceId.get(conn);
        if (deviceId == null || !LinkDevicePermissions.check(context, deviceId, "fileaccess")) {
            sendError(conn, id, "Permission denied");
            return false;
        }
        return true;
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        Log.i(TAG, "WSS FS connection closed: " + reason);
        // Only decrement for connections that were actually authenticated/counted — a rejected
        // connection also fires onClose, and must not release a lock it never acquired.
        if (connDeviceId.remove(conn) != null) {
            onAuthenticatedDisconnect();
        }
    }

    private static class PendingWrite {
        final String id;
        final String path;
        final long offset;

        PendingWrite(String id, String path, long offset) {
            this.id = id;
            this.path = path;
            this.offset = offset;
        }
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        executor.execute(() -> {
            try {
                JSONObject req = new JSONObject(message);
                String id = req.getString("id");
                String action = req.getString("action");
                Log.i(TAG, "Received request: action=" + action + ", id=" + id);

                if (!checkPermission(conn, id)) return;

                switch (action) {
                    case "listRoots":
                        handleListRoots(conn, id);
                        break;
                    case "readdir":
                        handleReaddir(conn, id, req.getString("path"));
                        break;
                    case "stat":
                        handleStat(conn, id, req.getString("path"));
                        break;
                    case "read":
                        handleRead(conn, id, req.getString("path"), req.getLong("offset"), req.getInt("length"));
                        break;
                    case "write":
                        conn.setAttachment(new PendingWrite(id, req.getString("path"), req.getLong("offset")));
                        break;
                    case "create":
                        handleCreate(conn, id, req.getString("path"), req.getBoolean("isDirectory"));
                        break;
                    case "delete":
                        handleDelete(conn, id, req.getString("path"));
                        break;
                    case "rename":
                        handleRename(conn, id, req.getString("path"), req.getString("newPath"));
                        break;
                    default:
                        sendError(conn, id, "Unknown action: " + action);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error parsing message", e);
            }
        });
    }

    @Override
    public void onMessage(WebSocket conn, ByteBuffer blob) {
        int length = blob.remaining();
        byte[] data = new byte[length];
        blob.get(data);
        ByteBuffer copy = ByteBuffer.wrap(data);

        executor.execute(() -> {
            try {
                if (copy.remaining() < 4) {
                    Log.e(TAG, "Malformed binary frame: too small");
                    return;
                }

                int headerLen = copy.getInt();
                if (headerLen < 0 || headerLen > copy.remaining()) {
                    Log.e(TAG, "Malformed binary frame: invalid header length. headerLen=" + headerLen + ", remaining=" + copy.remaining());
                    return;
                }

                byte[] headerBytes = new byte[headerLen];
                copy.get(headerBytes);
                String headerStr = new String(headerBytes, StandardCharsets.UTF_8);

                JSONObject req = new JSONObject(headerStr);
                String id = req.getString("id");
                String action = req.getString("action");
                Log.i(TAG, "Received binary request: action=" + action + ", id=" + id);

                if (!checkPermission(conn, id)) return;

                if ("write".equals(action)) {
                    handleWrite(conn, id, req.getString("path"), req.getLong("offset"), copy);
                } else {
                    sendError(conn, id, "Unsupported binary action: " + action);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error handling binary message", e);
            }
        });
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        Log.e(TAG, "WSS FS Server error", ex);
    }

    @Override
    public void onStart() {
        Log.i(TAG, "WSS FS Server started on port " + getPort());
    }

    private void handleListRoots(WebSocket conn, String id) {
        try {
            JSONArray roots = new JSONArray();

            // Primary storage
            File primary = Environment.getExternalStorageDirectory();
            JSONObject primaryObj = new JSONObject();
            primaryObj.put("name", "Internal Storage");
            primaryObj.put("path", primary.getAbsolutePath());
            primaryObj.put("totalSpace", primary.getTotalSpace());
            primaryObj.put("freeSpace", primary.getUsableSpace());
            roots.put(primaryObj);

            // Scan /storage/ for secondary cards
            File storageDir = new File("/storage");
            if (storageDir.exists() && storageDir.isDirectory()) {
                File[] files = storageDir.listFiles();
                if (files != null) {
                    for (File f : files) {
                        if (f.isDirectory() && f.canRead() && !f.getName().equals("self") && !f.getName().equals("emulated")) {
                            JSONObject root = new JSONObject();
                            root.put("name", f.getName());
                            root.put("path", f.getAbsolutePath());
                            root.put("totalSpace", f.getTotalSpace());
                            root.put("freeSpace", f.getUsableSpace());
                            roots.put(root);
                        }
                    }
                }
            }

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", true);
            resp.put("roots", roots);
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    private void handleReaddir(WebSocket conn, String id, String path) {
        if (!isPathAllowed(path)) {
            sendError(conn, id, "Access Denied (outside allowed roots)");
            return;
        }
        try {
            File dir = new File(path);
            if (!dir.exists() || !dir.isDirectory()) {
                sendError(conn, id, "Directory not found");
                return;
            }

            JSONArray files = new JSONArray();
            File[] list = dir.listFiles();
            if (list != null) {
                for (File f : list) {
                    JSONObject fileObj = new JSONObject();
                    fileObj.put("name", f.getName());
                    fileObj.put("isDirectory", f.isDirectory());
                    fileObj.put("size", f.isDirectory() ? 0 : f.length());
                    fileObj.put("mtime", f.lastModified());
                    files.put(fileObj);
                }
            }

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", true);
            resp.put("files", files);
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    private void handleStat(WebSocket conn, String id, String path) {
        if (!isPathAllowed(path)) {
            sendError(conn, id, "Access Denied (outside allowed roots)");
            return;
        }
        try {
            File f = new File(path);
            if (!f.exists()) {
                sendError(conn, id, "File not found");
                return;
            }

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", true);
            resp.put("name", f.getName());
            resp.put("isDirectory", f.isDirectory());
            resp.put("size", f.isDirectory() ? 0 : f.length());
            resp.put("mtime", f.lastModified());
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    private void handleRead(WebSocket conn, String id, String path, long offset, int length) {
        if (!isPathAllowed(path)) {
            sendError(conn, id, "Access Denied (outside allowed roots)");
            return;
        }
        try {
            File f = new File(path);
            if (!f.exists() || f.isDirectory()) {
                sendError(conn, id, "File not found");
                return;
            }

            long fileLen = f.length();
            if (offset >= fileLen) {
                sendBinaryData(conn, id, new byte[0]);
                return;
            }

            int toRead = (int) Math.min(length, fileLen - offset);
            byte[] buffer = new byte[toRead];

            try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                raf.seek(offset);
                int read = raf.read(buffer, 0, toRead);
                if (read < 0) {
                    sendBinaryData(conn, id, new byte[0]);
                } else if (read < toRead) {
                    byte[] shortBuffer = new byte[read];
                    System.arraycopy(buffer, 0, shortBuffer, 0, read);
                    sendBinaryData(conn, id, shortBuffer);
                } else {
                    sendBinaryData(conn, id, buffer);
                }
            }
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    private void handleWrite(WebSocket conn, String id, String path, long offset, ByteBuffer data) {
        if (!isPathAllowed(path)) {
            sendError(conn, id, "Access Denied (outside allowed roots)");
            return;
        }
        try {
            File f = new File(path);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }

            try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
                raf.seek(offset);
                byte[] bytesToWrite = new byte[data.remaining()];
                data.get(bytesToWrite);
                raf.write(bytesToWrite);
            }

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", true);
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    private void handleCreate(WebSocket conn, String id, String path, boolean isDirectory) {
        if (!isPathAllowed(path)) {
            sendError(conn, id, "Access Denied (outside allowed roots)");
            return;
        }
        try {
            File f = new File(path);
            boolean created;
            if (isDirectory) {
                created = f.mkdirs();
            } else {
                File parent = f.getParentFile();
                if (parent != null && !parent.exists()) {
                    parent.mkdirs();
                }
                created = f.createNewFile();
            }

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", created || f.exists());
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    private void handleDelete(WebSocket conn, String id, String path) {
        if (!isPathAllowed(path)) {
            sendError(conn, id, "Access Denied (outside allowed roots)");
            return;
        }
        try {
            File f = new File(path);
            boolean deleted = deleteRecursive(f);

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", deleted);
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    private boolean deleteRecursive(File file) {
        if (file.isDirectory()) {
            File[] list = file.listFiles();
            if (list != null) {
                for (File f : list) {
                    deleteRecursive(f);
                }
            }
        }
        return file.delete();
    }

    private void handleRename(WebSocket conn, String id, String path, String newPath) {
        if (!isPathAllowed(path) || !isPathAllowed(newPath)) {
            sendError(conn, id, "Access Denied (outside allowed roots)");
            return;
        }
        try {
            File src = new File(path);
            File dest = new File(newPath);
            File parent = dest.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }

            boolean renamed = src.renameTo(dest);

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", renamed);
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    private void sendBinaryData(WebSocket conn, String id, byte[] data) {
        try {
            JSONObject header = new JSONObject();
            header.put("id", id);
            header.put("success", true);
            byte[] headerBytes = header.toString().getBytes(StandardCharsets.UTF_8);

            ByteBuffer buffer = ByteBuffer.allocate(4 + headerBytes.length + data.length);
            buffer.putInt(headerBytes.length);
            buffer.put(headerBytes);
            buffer.put(data);
            buffer.flip();

            conn.send(buffer);
        } catch (Exception e) {
            Log.e(TAG, "Error sending binary packet", e);
        }
    }


    private void sendError(WebSocket conn, String id, String errorMsg) {
        try {
            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", false);
            resp.put("error", errorMsg);
            conn.send(resp.toString());
        } catch (Exception e) {
            Log.e(TAG, "Error sending error response", e);
        }
    }

    @Override
    public void stop() throws InterruptedException {
        super.stop();
        executor.shutdown();
        // Safety net: force-release the locks if the server is torn down while clients are still
        // counted, so we never leak a held Wi-Fi/wake lock (which would drain battery indefinitely).
        synchronized (lockGuard) {
            activeConnections = 0;
            try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
            try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        }
    }
}
