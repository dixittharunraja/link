package in.rodix.link;

import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.provider.MediaStore;
import android.os.Environment;
import android.util.Log;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.DefaultSSLWebSocketServerFactory;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.RandomAccessFile;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ByteChannel;
import java.nio.channels.FileChannel;
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
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;

public class LinkFsServer extends WebSocketServer {
    private static final String TAG = "LinkFsServer";
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Context context;

    // ---- Shared FileChannel pool for concurrent write chunks --------------------------------
    // The PC writes a file as several concurrent 1MB chunks to the same path. One shared
    // FileChannel per path with positioned writes avoids reopening the file for every chunk.
    // Channels idle for CHANNEL_IDLE_MS are closed so handles do not leak.
    private static final long CHANNEL_IDLE_MS = 5000;

    // Writers and the reaper hold the OpenChannel's monitor while using lastUsed and retired, so a
    // channel is never closed under an in-progress write; a writer that finds it retired retries.
    private static class OpenChannel {
        final FileChannel channel;
        long lastUsed = System.currentTimeMillis();
        boolean retired;
        OpenChannel(FileChannel ch) { this.channel = ch; }
    }

    private final ConcurrentHashMap<String, OpenChannel> writeChannels = new ConcurrentHashMap<>();
    private final ScheduledExecutorService channelReaper = Executors.newSingleThreadScheduledExecutor();

    // Serialized so concurrent chunks for a new path share one channel instead of each opening one.
    private OpenChannel getOrOpenChannel(String canonPath) throws Exception {
        synchronized (writeChannels) {
            OpenChannel oc = writeChannels.get(canonPath);
            if (oc != null) return oc;
            // "rw" creates the file if absent.
            OpenChannel fresh = new OpenChannel(new RandomAccessFile(new File(canonPath), "rw").getChannel());
            writeChannels.put(canonPath, fresh);
            return fresh;
        }
    }

    private void startChannelReaper() {
        channelReaper.scheduleWithFixedDelay(() -> {
            long now = System.currentTimeMillis();
            for (Map.Entry<String, OpenChannel> e : writeChannels.entrySet()) {
                OpenChannel oc = e.getValue();
                synchronized (oc) {
                    if (oc.retired || now - oc.lastUsed <= CHANNEL_IDLE_MS) continue;
                    oc.retired = true;
                    writeChannels.remove(e.getKey(), oc);
                }
                try { oc.channel.force(true); oc.channel.close(); } catch (Exception ignored) {}
                Log.d(TAG, "Closed idle write channel: " + e.getKey());
            }
            for (Map.Entry<String, OpenChannel> e : readChannels.entrySet()) {
                OpenChannel oc = e.getValue();
                synchronized (oc) {
                    if (oc.retired || now - oc.lastUsed <= CHANNEL_IDLE_MS) continue;
                    oc.retired = true;
                    readChannels.remove(e.getKey(), oc);
                }
                try { oc.channel.close(); } catch (Exception ignored) {}
            }
        }, CHANNEL_IDLE_MS, CHANNEL_IDLE_MS, TimeUnit.MILLISECONDS);
    }
    // -----------------------------------------------------------------------------------------

    // SSLEngine per remote socket address, stashed by the SSL factory so onOpen() can read the
    // peer certificate; Java-WebSocket offers no other way to reach the engine from a connection.
    private final Map<String, SSLEngine> pendingEngines = new ConcurrentHashMap<>();
    // Authenticated deviceId per connection, set in onOpen(). Checked before every action.
    private final Map<WebSocket, String> connDeviceId = new ConcurrentHashMap<>();

    private final List<String> allowedRoots = new ArrayList<>();

    // Held while at least one authenticated FS client is connected (a drive is mounted on the
    // PC). Wi-Fi power saving between packets causes latency spikes, and the partial wake lock
    // keeps the CPU serving requests with the screen off. Counted so the pool's several sockets
    // acquire on the first connection and release on the last.
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
            // Require a client certificate; it must also match a paired device (see authenticate).
            engine.setNeedClientAuth(true);
            String key2 = channel.socket().getRemoteSocketAddress().toString();
            pendingEngines.put(key2, engine);
            return new org.java_websocket.SSLSocketChannel2(channel, engine, exec, key);
        }
    }

    public LinkFsServer(Context context, X509Certificate cert, PrivateKey key, int port) throws Exception {
        super(new InetSocketAddress(port));
        setReuseAddr(true);
        this.context = context;

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

        SSLContext sslContext = LinkTransport.buildSslContext(cert, key);
        setWebSocketFactory(new ClientAuthSSLFactory(sslContext));

        setConnectionLostTimeout(20);

        startChannelReaper();

        try {
            android.net.wifi.WifiManager wifiManager =
                (android.net.wifi.WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                // FULL_HIGH_PERF is deprecated on API 29+, but FULL_LOW_LATENCY only takes effect
                // while the app is in the foreground, which a mounted drive usually is not.
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

    /** True if the canonicalized path lies inside one of the storage roots. Fails closed. */
    private boolean isPathAllowed(String path) {
        try {
            String canon = new File(path).getCanonicalPath();
            for (String root : allowedRoots) {
                if (canon.equals(root) || canon.startsWith(root + File.separator)) {
                    return true;
                }
            }
        } catch (Exception e) {
            // Unresolvable path: deny.
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
            // Read fresh for every connection: a store loaded at server start would not know
            // devices paired since (a fresh install pairs after this server is already up).
            for (LinkTrustStore.TrustedDevice dev : LinkTrustStore.getInstance(context).list()) {
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

    // A drive mount issues hundreds of requests a second while Explorer browses, so a granted
    // permission is trusted for this long before it is read again. A revoke also unmounts the
    // drive on the PC, which closes these connections.
    private static final long PERMISSION_TTL_MS = 2000;
    private final Map<String, Long> permissionGrantedAt = new ConcurrentHashMap<>();

    /** Checked before every action: the connection's device must have the fileaccess permission. */
    private boolean checkPermission(WebSocket conn, String id) {
        String deviceId = connDeviceId.get(conn);
        boolean allowed = false;
        if (deviceId != null) {
            long now = System.currentTimeMillis();
            Long grantedAt = permissionGrantedAt.get(deviceId);
            if (grantedAt != null && now - grantedAt < PERMISSION_TTL_MS) {
                allowed = true;
            } else if (LinkDevicePermissions.check(context, deviceId, "fileaccess")) {
                permissionGrantedAt.put(deviceId, now);
                allowed = true;
            } else {
                permissionGrantedAt.remove(deviceId);
            }
        }
        if (!allowed) {
            Log.i(TAG, "FS request " + id + " refused: fileaccess is off for " + deviceId);
            sendError(conn, id, "Permission denied (fileaccess disabled for " + deviceId + ")");
            return false;
        }
        return true;
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        Log.i(TAG, "WSS FS connection closed: " + reason);
        // Rejected connections also reach onClose but were never counted.
        if (connDeviceId.remove(conn) != null) {
            onAuthenticatedDisconnect();
        }
    }

    // Protocol (shared with the PC's core/fs_server.rs, and spoken by LinkFsClient and core/fs_client.rs):
    // text requests { id, action, ... } answered by a text reply { id, success, error?, ...fields } or,
    // for read and thumbnail, a binary reply (int header length, { id, success }, bytes). A write is a
    // binary request (int header length, { id, action: "write", path, offset }, bytes).
    @Override
    public void onMessage(WebSocket conn, String message) {
        executor.execute(() -> {
            String id = null;
            try {
                JSONObject req = new JSONObject(message);
                id = req.optString("id", null);
                String action = req.optString("action", "");

                if (!checkPermission(conn, id)) return;

                switch (action) {
                    case "listRoots":
                        handleListRoots(conn, id);
                        break;
                    case "readdir":
                        handleReaddir(conn, id, req.getString("path"), req.optInt("offset", 0), req.optInt("limit", 0));
                        break;
                    case "stat":
                        handleStat(conn, id, req.getString("path"));
                        break;
                    case "read":
                        handleRead(conn, id, req.getString("path"), req.getLong("offset"), req.getInt("length"));
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
                    case "recentPhotos":
                        handleRecentPhotos(conn, id, req.optInt("limit", 30), req.optLong("before", 0));
                        break;
                    case "thumbnail":
                        handleThumbnail(conn, id, req.getString("path"), req.optInt("max", 256), req.optInt("quality", 70));
                        break;
                    default:
                        sendError(conn, id, "Unknown action: " + action);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error parsing message", e);
                if (id != null) {
                    sendError(conn, id, e.getMessage() != null ? e.getMessage() : "Internal FS error");
                }
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
            String id = null;
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
                id = req.optString("id", null);
                String action = req.optString("action", "");

                if (!checkPermission(conn, id)) return;

                if ("write".equals(action)) {
                    handleWrite(conn, id, req.getString("path"), req.getLong("offset"), copy);
                } else {
                    sendError(conn, id, "Unsupported binary action: " + action);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error handling binary message", e);
                if (id != null) {
                    sendError(conn, id, e.getMessage() != null ? e.getMessage() : "Internal FS error");
                }
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

            File primary = Environment.getExternalStorageDirectory();
            JSONObject primaryObj = new JSONObject();
            primaryObj.put("name", "Internal Storage");
            primaryObj.put("path", primary.getAbsolutePath());
            primaryObj.put("totalSpace", primary.getTotalSpace());
            primaryObj.put("freeSpace", primary.getUsableSpace());
            roots.put(primaryObj);

            // Secondary volumes (SD cards, USB) appear under /storage.
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
            Log.e(TAG, "handleListRoots failed for id=" + id, e);
            sendError(conn, id, e.getMessage());
        }
    }

    /**
     * One page of a folder: names sorted, so pages line up across requests, and only the page's
     * entries are stat'ed (three system calls each, the slow part of a camera folder with thousands
     * of photos). `limit` 0 means the rest of the folder. Reply: { files, hasMore }.
     */
    private void handleReaddir(WebSocket conn, String id, String path, int offset, int limit) {
        if (!isPathAllowed(path)) {
            sendError(conn, id, "Access Denied (outside allowed roots)");
            return;
        }
        try {
            File dir = new File(path);
            String[] names = dir.list();
            if (names == null) {
                sendError(conn, id, "Directory not found");
                return;
            }
            java.util.Arrays.sort(names);
            int start = Math.max(0, Math.min(offset, names.length));
            int end = limit <= 0 ? names.length : (int) Math.min((long) start + limit, names.length);

            JSONArray files = new JSONArray();
            for (int i = start; i < end; i++) {
                File f = new File(dir, names[i]);
                boolean isDirectory = f.isDirectory();
                JSONObject fileObj = new JSONObject();
                fileObj.put("name", names[i]);
                fileObj.put("isDirectory", isDirectory);
                fileObj.put("size", isDirectory ? 0 : f.length());
                fileObj.put("mtime", f.lastModified());
                files.put(fileObj);
            }

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", true);
            resp.put("files", files);
            resp.put("hasMore", end < names.length);
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

            int toRead = (int) Math.max(0, Math.min(length, fileLen - offset));
            // The bytes are read straight into the outgoing frame, after its header, instead of
            // into a separate array that would then be copied in.
            byte[] headerBytes = binaryHeader(id);
            ByteBuffer frame = ByteBuffer.allocate(4 + headerBytes.length + toRead);
            frame.putInt(headerBytes.length);
            frame.put(headerBytes);
            String canon = f.getCanonicalPath();
            while (true) {
                OpenChannel oc = getOrOpenReadChannel(canon);
                synchronized (oc) {
                    if (oc.retired) continue;
                    oc.lastUsed = System.currentTimeMillis();
                }
                try {
                    long pos = offset;
                    while (frame.hasRemaining()) {
                        int n = oc.channel.read(frame, pos);
                        if (n < 0) break;
                        pos += n;
                    }
                    break;
                } catch (java.nio.channels.ClosedByInterruptException interrupted) {
                    throw interrupted;
                } catch (java.nio.channels.ClosedChannelException closed) {
                    // Reaped between lookup and read: reopen and read the chunk again.
                    readChannels.remove(canon, oc);
                    frame.position(4 + headerBytes.length);
                }
            }
            frame.flip();
            conn.send(frame);
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    // Read handles are kept open per path like the write channels: a media player or the drive
    // mount reads one file as many consecutive chunks. Positioned reads leave no shared file
    // pointer to race on.
    private final ConcurrentHashMap<String, OpenChannel> readChannels = new ConcurrentHashMap<>();

    private OpenChannel getOrOpenReadChannel(String canonPath) throws Exception {
        synchronized (readChannels) {
            OpenChannel oc = readChannels.get(canonPath);
            // A size that no longer matches the path means the file was replaced (another app
            // deleted and rewrote it); the old handle would serve the old bytes.
            if (oc != null && oc.channel.isOpen() && oc.channel.size() == new File(canonPath).length()) return oc;
            if (oc != null) {
                synchronized (oc) { oc.retired = true; }
                try { oc.channel.close(); } catch (Exception ignored) {}
            }
            OpenChannel fresh = new OpenChannel(new RandomAccessFile(new File(canonPath), "r").getChannel());
            readChannels.put(canonPath, fresh);
            return fresh;
        }
    }

    /** A cached read handle would keep serving the old file after a write, rename or delete. */
    private void closeReadChannel(String path) {
        try {
            OpenChannel oc = readChannels.remove(new File(path).getCanonicalPath());
            if (oc != null) {
                synchronized (oc) { oc.retired = true; }
                oc.channel.close();
            }
        } catch (Exception ignored) {}
    }

    private static byte[] binaryHeader(String id) throws Exception {
        JSONObject header = new JSONObject();
        header.put("id", id);
        header.put("success", true);
        return header.toString().getBytes(StandardCharsets.UTF_8);
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

            // Positioned writes on the shared channel do not move its file pointer, so
            // concurrent chunks cannot clobber each other's offsets.
            String canon = f.getCanonicalPath();
            while (true) {
                OpenChannel oc = getOrOpenChannel(canon);
                synchronized (oc) {
                    if (oc.retired) continue; // reaped after lookup; open a fresh channel
                    if (!oc.channel.isOpen()) {
                        // Closed underneath us (e.g. by an interrupt); replace it.
                        oc.retired = true;
                        writeChannels.remove(canon, oc);
                        continue;
                    }
                    oc.lastUsed = System.currentTimeMillis();
                    oc.channel.write(data, offset);
                    break;
                }
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
            closeReadChannel(path);
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

            closeReadChannel(path);
            closeReadChannel(newPath);
            boolean renamed = src.renameTo(dest);

            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", renamed);
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage());
        }
    }

    // ---- Recent photos (the PC's "Recent photos" strip): a newest-first list and small JPEG thumbnails, read on demand ----

    private static final String[] IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif"};
    private static final int MAX_RECENT_PHOTOS = 60;

    private static boolean isImageName(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return false;
        String ext = name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        for (String known : IMAGE_EXTENSIONS) {
            if (known.equals(ext)) return true;
        }
        return false;
    }

    private static JSONObject photoJson(File f) throws Exception {
        JSONObject photo = new JSONObject();
        photo.put("path", f.getAbsolutePath());
        photo.put("name", f.getName());
        photo.put("size", f.length());
        photo.put("modified", f.lastModified());
        return photo;
    }

    // An image the PC may list or read: inside the storage roots, a real visible file, an image by extension.
    private boolean isListablePhoto(File f) {
        return f.isFile() && !f.getName().startsWith(".") && isImageName(f.getName()) && isPathAllowed(f.getAbsolutePath());
    }

    /**
     * Newest photos first. `limit` is capped at 60; `before` (milliseconds, optional) continues after the last photo
     * of the previous page. Reply: { success, photos: [{ path, name, size, modified }] }.
     */
    private void handleRecentPhotos(WebSocket conn, String id, int limit, long beforeMs) {
        try {
            int max = Math.max(1, Math.min(limit, MAX_RECENT_PHOTOS));
            List<File> found = new ArrayList<>();
            try (Cursor cursor = context.getContentResolver().query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Images.Media.DATA},
                    beforeMs > 0 ? MediaStore.Images.Media.DATE_MODIFIED + " < ?" : null,
                    beforeMs > 0 ? new String[]{Long.toString((beforeMs + 999) / 1000)} : null,
                    MediaStore.Images.Media.DATE_MODIFIED + " DESC")) {
                while (cursor != null && cursor.moveToNext() && found.size() < max) {
                    String path = cursor.getString(0);
                    if (path == null) continue;
                    File f = new File(path);
                    if (isListablePhoto(f) && (beforeMs <= 0 || f.lastModified() < beforeMs)) found.add(f);
                }
            } catch (Exception e) {
                // No media access or no such column on this device: fall back to the usual folders below.
                Log.w(TAG, "MediaStore query for recent photos failed", e);
            }
            if (found.isEmpty()) found = scanPhotoFolders(max, beforeMs);

            JSONArray photos = new JSONArray();
            for (File f : found) photos.put(photoJson(f));
            JSONObject resp = new JSONObject();
            resp.put("id", id);
            resp.put("success", true);
            resp.put("photos", photos);
            conn.send(resp.toString());
        } catch (Exception e) {
            sendError(conn, id, e.getMessage() != null ? e.getMessage() : "Could not list photos");
        }
    }

    // Fallback when the media database has nothing (or cannot be read): the folders photos usually land in.
    private List<File> scanPhotoFolders(int max, long beforeMs) {
        File dcim = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM);
        File pictures = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
        File[] folders = {new File(dcim, "Camera"), new File(dcim, "Screenshots"), new File(pictures, "Screenshots"), pictures, dcim};
        List<File> all = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (File folder : folders) {
            File[] files = folder.listFiles();
            if (files == null) continue;
            for (File f : files) {
                if (isListablePhoto(f) && (beforeMs <= 0 || f.lastModified() < beforeMs) && seen.add(f.getAbsolutePath())) all.add(f);
            }
        }
        java.util.Collections.sort(all, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        return all.size() > max ? new ArrayList<>(all.subList(0, max)) : all;
    }

    /**
     * A small JPEG of one photo, sent as a binary frame like "read". `max` is the longest side (64 to 4096; the strip asks
     * for about 256, a full-size conversion asks for more) and `quality` 30 to 95. Rotation from the photo's EXIF tag is
     * applied, and any format Android can decode (PNG, WebP, HEIC...) comes out as JPEG.
     */
    private void handleThumbnail(WebSocket conn, String id, String path, int maxSide, int quality) {
        File f = new File(path);
        if (!isPathAllowed(path) || !isListablePhoto(f)) {
            sendError(conn, id, "Not a photo this device can share");
            return;
        }
        Bitmap decoded = null;
        Bitmap scaled = null;
        try {
            int side = Math.max(64, Math.min(maxSide, 4096));
            int jpegQuality = Math.max(30, Math.min(quality, 95));

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                sendError(conn, id, "Cannot decode this image");
                return;
            }
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= side) sample *= 2;
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            decoded = BitmapFactory.decodeFile(path, options);
            if (decoded == null) {
                sendError(conn, id, "Cannot decode this image");
                return;
            }

            float ratio = Math.min(1f, (float) side / Math.max(decoded.getWidth(), decoded.getHeight()));
            Matrix matrix = new Matrix();
            if (ratio < 1f) matrix.postScale(ratio, ratio);
            int rotation = 0;
            try {
                int orientation = new android.media.ExifInterface(path).getAttributeInt(
                        android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL);
                if (orientation == android.media.ExifInterface.ORIENTATION_ROTATE_90) rotation = 90;
                else if (orientation == android.media.ExifInterface.ORIENTATION_ROTATE_180) rotation = 180;
                else if (orientation == android.media.ExifInterface.ORIENTATION_ROTATE_270) rotation = 270;
            } catch (Exception ignored) {
                // Formats without EXIF (PNG screenshots, for one) simply stay as they are.
            }
            if (rotation != 0) matrix.postRotate(rotation);
            scaled = Bitmap.createBitmap(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), matrix, true);

            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, jpegQuality, jpeg);
            sendBinaryData(conn, id, jpeg.toByteArray());
        } catch (OutOfMemoryError e) {
            sendError(conn, id, "The photo is too large to preview");
        } catch (Exception e) {
            sendError(conn, id, e.getMessage() != null ? e.getMessage() : "Could not make a thumbnail");
        } finally {
            if (scaled != null && scaled != decoded) scaled.recycle();
            if (decoded != null) decoded.recycle();
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
        channelReaper.shutdownNow();
        for (Map.Entry<String, OpenChannel> e : writeChannels.entrySet()) {
            try { e.getValue().channel.force(true); e.getValue().channel.close(); } catch (Exception ignored) {}
        }
        writeChannels.clear();
        for (Map.Entry<String, OpenChannel> e : readChannels.entrySet()) {
            try { e.getValue().channel.close(); } catch (Exception ignored) {}
        }
        readChannels.clear();
        // Release the locks even if clients are still counted, so they cannot leak.
        synchronized (lockGuard) {
            activeConnections = 0;
            try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
            try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        }
    }
}
