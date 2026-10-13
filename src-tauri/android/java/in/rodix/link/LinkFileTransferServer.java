package in.rodix.link;

// Portal Mode — Android-as-receiver side. Ports desktop's portal-transfer-server.ts protocol onto
// the same TLS/WebSocketServer skeleton LinkFsServer.java/LinkAudioSinkServer.java already
// established for this codebase — see portal-transfer-server.ts's header comment for the full
// wire protocol (guest PIN path vs already-paired token path, both converging on admit(); then
// {"type":"file-info"} JSON followed by binary WS frames totaling exactly `size` bytes, then a
// {"type":"received"} ack). Completely isolated from LinkDeviceManager/LinkTrustStore — an
// admitted sender here is never added to the paired-device mesh.
//
// Saves to the PUBLIC Downloads/Link folder — visible in the system Files app and any other file
// manager, matching desktop's Downloads\Link convention. On API 29+ this goes through MediaStore's
// Downloads collection (MediaStore.Downloads.EXTERNAL_CONTENT_URI with a RELATIVE_PATH of
// "Download/Link"), which needs ZERO runtime permission — scoped storage explicitly allows any
// app to insert into its own app-attributed slice of the shared Downloads collection with no
// permission ceremony at all. Below API 29 (pre-scoped-storage), there's no MediaStore Downloads
// collection to insert into, so this falls back to the old app-private
// getExternalFilesDir(DIRECTORY_DOWNLOADS)/Link location for that narrow legacy range only —
// requesting WRITE_EXTERNAL_STORAGE just for API 23-28 wasn't judged worth the extra permission
// surface for how few real devices are still on it.
//
// Since every incoming chunk is already written in strict arrival order (see onMessage(ByteBuffer)
// below), destination writes never need random-access seeking — a plain sequential OutputStream
// works identically whether it's backed by a MediaStore item or a real File, which is what lets
// both code paths share one ActiveTransfer/write implementation instead of forking it.

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.DefaultSSLWebSocketServerFactory;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ByteChannel;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLPeerUnverifiedException;

public class LinkFileTransferServer extends WebSocketServer {
    private static final String TAG = "LinkFileTransferServer";
    private static final long GUEST_CONFIRM_TIMEOUT_MS = 30000;
    private static final long MAX_FILE_BYTES = 100L * 1024 * 1024 * 1024 * 1024; // 100TB (effectively no limit)

    public interface Listener {
        void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName);
        void onConnectionAdmitted(String connId, String deviceName);
        void onConnectionClosed(String connId);
        void onPeerFilesChanged(String connId, org.json.JSONArray files);
        void onTransferStarted(String connId, String name, long size);
        void onTransferProgress(String connId, long received, long size);
        void onTransferComplete(String connId, String destPath);
        void onFileStarted(int fileIndex, int fileCount, String name);
        void onSendProgress(long sent, long total);
        void onSendComplete();
        void onError(String message);
    }

    private static class TokenEntry {
        final String deviceId;
        final String deviceName;
        TokenEntry(String deviceId, String deviceName) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
        }
    }

    private static class PendingGuest {
        final WebSocket conn;
        final String pin;
        final ScheduledFuture<?> timeoutFuture;
        final String remoteAddress;
        final String deviceName;
        PendingGuest(WebSocket conn, String pin, ScheduledFuture<?> timeoutFuture, String remoteAddress, String deviceName) {
            this.conn = conn;
            this.pin = pin;
            this.timeoutFuture = timeoutFuture;
            this.remoteAddress = remoteAddress;
            this.deviceName = deviceName;
        }
    }

    private static class ActiveTransfer {
        final String name;
        final long size;
        long received;
        final OutputStream out;
        // What onTransferComplete reports back — a real path pre-API29, or the MediaStore item's
        // content:// Uri string on API29+ (there's no filesystem path for a MediaStore item).
        // JS-side this is already treated as an opaque display string either way.
        final String destDisplay;
        // Non-null only for the API29+ MediaStore path — needed to clear IS_PENDING once the
        // write finishes, so the file only becomes visible/usable to other apps once complete.
        final Uri mediaStoreUri;
        ActiveTransfer(String name, long size, OutputStream out, String destDisplay, Uri mediaStoreUri) {
            this.name = name;
            this.size = size;
            this.out = out;
            this.destDisplay = destDisplay;
            this.mediaStoreUri = mediaStoreUri;
        }
    }

    /** Tracks how many files a multi-file batch on this connection has announced/received —
     *  see portal-transfer-server.ts's header comment for the shared wire protocol. Absent means
     *  either no batch-info was sent (older client — implicit count of 1) or the batch already
     *  finished and was cleaned up. */
    private static class BatchState {
        int expected;
        int received;
        BatchState(int expected) {
            this.expected = expected;
        }
    }
    private final Map<WebSocket, BatchState> batchStates = new ConcurrentHashMap<>();

    private final Context context;
    private final Listener listener;
    private final byte[] myPublicKeyDer;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    private final Map<String, TokenEntry> validTokens = new ConcurrentHashMap<>();
    private final Map<String, PendingGuest> pendingGuests = new ConcurrentHashMap<>();
    private final Map<String, WebSocket> admittedConnections = new ConcurrentHashMap<>();
    private final Map<String, String> admittedDeviceNames = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> connIds = new ConcurrentHashMap<>();
    private final Map<WebSocket, byte[]> peerKeysByConn = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> remoteAddrByConn = new ConcurrentHashMap<>();
    private final Map<String, SSLEngine> pendingEngines = new ConcurrentHashMap<>();
    private final java.util.Set<WebSocket> firstMessageHandled = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final Map<WebSocket, ActiveTransfer> activeTransfers = new ConcurrentHashMap<>();

    public static class SharedFileEntry {
        public final String id;
        public final String name;
        public final long size;
        public final Uri uri;
        public SharedFileEntry(String id, String name, long size, Uri uri) {
            this.id = id;
            this.name = name;
            this.size = size;
            this.uri = uri;
        }
    }
    private final java.util.List<SharedFileEntry> availableDownloads = new java.util.concurrent.CopyOnWriteArrayList<>();

    public void setAvailableDownloads(Context context, java.util.List<Uri> uris) {
        availableDownloads.clear();
        android.content.ContentResolver resolver = context.getContentResolver();
        for (Uri uri : uris) {
            String name = "file";
            long size = 0;
            try (android.database.Cursor cursor = resolver.query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameIdx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                    int sizeIdx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE);
                    if (nameIdx >= 0) name = cursor.getString(nameIdx);
                    if (sizeIdx >= 0) size = cursor.getLong(sizeIdx);
                }
            } catch (Exception ignored) {}
            availableDownloads.add(new SharedFileEntry("file-" + java.util.UUID.randomUUID().toString().substring(0, 8), name, size, uri));
        }
        broadcastDownloadsAvailable();
    }

    private void broadcastDownloadsAvailable() {
        try {
            org.json.JSONArray arr = new org.json.JSONArray();
            for (SharedFileEntry entry : availableDownloads) {
                org.json.JSONObject item = new org.json.JSONObject();
                item.put("id", entry.id);
                item.put("name", entry.name);
                item.put("size", entry.size);
                arr.put(item);
            }
            org.json.JSONObject packet = new org.json.JSONObject();
            packet.put("type", "downloads-available");
            packet.put("files", arr);
            String text = packet.toString();
            for (WebSocket ws : admittedConnections.values()) {
                if (ws.isOpen()) {
                    try { ws.send(text); } catch (Exception ignored) {}
                }
            }
        } catch (Exception ignored) {}
    }

    public void requestDownload(String connId, String fileId) {
        WebSocket ws = admittedConnections.get(connId);
        if (ws != null && ws.isOpen()) {
            try {
                ws.send(new JSONObject().put("type", "request-download").put("fileId", fileId).toString());
            } catch (Exception ignored) {}
        }
    }

    private void handleDownloadRequest(WebSocket conn, String fileId) {
        for (SharedFileEntry entry : availableDownloads) {
            if (entry.id.equals(fileId)) {
                new Thread(() -> {
                    sendOneFile(conn, context, entry.uri, 0, 1);
                    try { conn.send(new JSONObject().put("type", "received").toString()); } catch (Exception ignored) {}
                    listener.onSendComplete();
                }, "link-portal-server-download-stream").start();
                break;
            }
        }
    }

    private void admit(WebSocket conn) {
        String connId = connIds.get(conn);
        if (connId == null) return;
        admittedConnections.put(connId, conn);
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending != null && pending.timeoutFuture != null) {
            pending.timeoutFuture.cancel(false);
        }
        String guestName = pending != null ? pending.deviceName : "Guest";
        admittedDeviceNames.put(connId, guestName);
        try {
            JSONObject obj = new JSONObject();
            obj.put("type", "admitted");
            obj.put("deviceName", deviceName);
            conn.send(obj.toString());
        } catch (Exception ignored) {}
        if (!availableDownloads.isEmpty()) {
            broadcastDownloadsAvailable();
        }
        listener.onConnectionAdmitted(connId, guestName);
    }

    public void acceptGuest(String connId) {
        PendingGuest pending = pendingGuests.get(connId);
        if (pending != null && pending.conn != null && pending.conn.isOpen()) {
            admit(pending.conn);
        }
    }

    public void rejectGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending != null) {
            if (pending.timeoutFuture != null) pending.timeoutFuture.cancel(false);
            try { pending.conn.close(4007, "rejected by host"); } catch (Exception ignored) {}
        }
    }

    public String getPendingGuestRemoteAddress(String connId) {
        PendingGuest pending = pendingGuests.get(connId);
        return pending != null ? pending.remoteAddress : null;
    }

    public String getPendingGuestDeviceName(String connId) {
        PendingGuest pending = pendingGuests.get(connId);
        return (pending != null && pending.deviceName != null && !pending.deviceName.trim().isEmpty()) ? pending.deviceName : "Guest";
    }

    private class ClientAuthSSLFactory extends DefaultSSLWebSocketServerFactory {
        ClientAuthSSLFactory(SSLContext sslContext) {
            super(sslContext);
        }

        @Override
        public ByteChannel wrapChannel(SocketChannel channel, SelectionKey key) throws java.io.IOException {
            SSLEngine engine = sslcontext.createSSLEngine();
            engine.setUseClientMode(false);
            engine.setWantClientAuth(true); // want, not need — same reasoning as LinkAudioSinkServer
            String k = channel.socket().getRemoteSocketAddress().toString();
            pendingEngines.put(k, engine);
            return new org.java_websocket.SSLSocketChannel2(channel, engine, exec, key);
        }
    }

    // Same mechanism as LinkAudioSinkServer's — see that class's BlockChecker comment.
    public interface BlockChecker {
        boolean isBlocked(String idOrIp);
    }
    private final BlockChecker blockChecker;

    // Sent back to the sender in the 'admitted' message so it can show "Connected with <name>"
    // instead of a generic placeholder — see admit() below.
    private final String deviceName;

    public LinkFileTransferServer(Context context, X509Certificate cert, PrivateKey key, int port, String deviceName, Listener listener) throws Exception {
        this(context, cert, key, port, deviceName, listener, idOrIp -> false);
    }

    public LinkFileTransferServer(Context context, X509Certificate cert, PrivateKey key, int port, String deviceName, Listener listener, BlockChecker blockChecker) throws Exception {
        super(new InetSocketAddress(port));
        this.context = context;
        this.deviceName = deviceName;
        this.listener = listener;
        this.blockChecker = blockChecker;
        this.myPublicKeyDer = cert.getPublicKey().getEncoded();

        SSLContext sslContext = LinkTransport.buildSslContext(cert, key);
        setWebSocketFactory(new ClientAuthSSLFactory(sslContext));
        setConnectionLostTimeout(20);
    }

    /** True only while bytes are actually flowing for at least one connection — distinct from "is
     *  the receive-mode server running at all" (which stays true between batches so a second
     *  sender can connect without the user restarting "Receive Files"). Mirrors desktop's
     *  identically-named method — see that file's comment for the full reasoning. */
    public boolean hasActiveTransfer() {
        return !activeTransfers.isEmpty();
    }

    public boolean hasConnectedPeers() {
        return !admittedConnections.isEmpty();
    }

    public Map.Entry<String, String> getConnectedPeer() {
        for (Map.Entry<String, WebSocket> entry : admittedConnections.entrySet()) {
            if (entry.getValue().isOpen()) {
                String name = admittedDeviceNames.get(entry.getKey());
                return new java.util.AbstractMap.SimpleEntry<>(entry.getKey(), name != null ? name : "Peer");
            }
        }
        return null;
    }

    public java.util.List<String> getAdmittedConnectionIds() {
        return new java.util.ArrayList<>(admittedConnections.keySet());
    }

    private static final int CHUNK_SIZE = 262144; // 256KB chunks

    public void sendFiles(String connId, Context context, java.util.List<Uri> fileUris) {
        WebSocket conn = admittedConnections.get(connId);
        if (conn == null || !conn.isOpen()) {
            listener.onError("Not connected");
            return;
        }
        try {
            conn.send(new JSONObject().put("type", "batch-info").put("count", fileUris.size()).toString());
        } catch (Exception e) {
            listener.onError("Failed to send batch-info: " + e.getMessage());
            return;
        }
        for (int i = 0; i < fileUris.size(); i++) {
            if (!conn.isOpen()) {
                listener.onError("Connection closed mid-transfer");
                return;
            }
            String name = sendOneFile(conn, context, fileUris.get(i), i, fileUris.size());
            if (name == null) return;
        }
    }

    private String sendOneFile(WebSocket conn, Context context, Uri fileUri, int fileIndex, int fileCount) {
        android.content.ContentResolver resolver = context.getContentResolver();
        String name = "file";
        long size = -1;
        try (android.database.Cursor cursor = resolver.query(fileUri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIdx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                int sizeIdx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE);
                if (nameIdx >= 0) name = cursor.getString(nameIdx);
                if (sizeIdx >= 0) size = cursor.getLong(sizeIdx);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to query file metadata, proceeding with defaults", e);
        }

        if (size < 0) {
            listener.onError("Could not determine file size");
            return null;
        }

        listener.onFileStarted(fileIndex, fileCount, name);
        try {
            conn.send(new JSONObject().put("type", "file-info").put("name", name).put("size", size).toString());
        } catch (Exception e) {
            listener.onError("Failed to send file-info: " + e.getMessage());
            return null;
        }

        long total = size;
        long sent = 0;
        try (java.io.InputStream in = resolver.openInputStream(fileUri)) {
            if (in == null) {
                listener.onError("Failed to open file for reading");
                return null;
            }
            byte[] buffer = new byte[CHUNK_SIZE];
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (!conn.isOpen()) {
                    listener.onError("Connection closed mid-transfer");
                    return null;
                }
                byte[] chunk = read == buffer.length ? buffer : java.util.Arrays.copyOf(buffer, read);
                conn.send(chunk);
                sent += read;
                listener.onSendProgress(sent, total);
            }
        } catch (Exception e) {
            listener.onError("Failed to read/send file: " + e.getMessage());
            return null;
        }
        return name;
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        try {
            java.lang.reflect.Method getSocketMethod = conn.getClass().getMethod("getSocket");
            java.net.Socket socket = (java.net.Socket) getSocketMethod.invoke(conn);
            if (socket != null) socket.setTcpNoDelay(true);
        } catch (Exception ignored) {}

        SocketAddress addr = conn.getRemoteSocketAddress();
        SSLEngine engine = addr != null ? pendingEngines.remove(addr.toString()) : null;
        byte[] peerPublicKeyDer;
        try {
            if (engine == null) throw new SSLPeerUnverifiedException("no engine for connection");
            Certificate[] chain = engine.getSession().getPeerCertificates();
            if (chain.length == 0) throw new SSLPeerUnverifiedException("empty chain");
            peerPublicKeyDer = chain[0].getPublicKey().getEncoded();
        } catch (SSLPeerUnverifiedException e) {
            conn.close(4001, "no client certificate presented");
            return;
        } catch (Exception e) {
            conn.close(4002, "invalid certificate");
            return;
        }

        String remoteAddress = addr != null ? addr.toString() : "unknown";
        if (blockChecker.isBlocked(remoteAddress)) {
            conn.close(4010, "blocked");
            return;
        }

        String connId = UUID.randomUUID().toString();
        connIds.put(conn, connId);
        peerKeysByConn.put(conn, peerPublicKeyDer);
        remoteAddrByConn.put(conn, remoteAddress);
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        if (activeTransfers.containsKey(conn)) return; // ignore stray text after file-info
        if (!firstMessageHandled.add(conn)) {
            // Any text message AFTER the first is expected to be file-info. Handled SYNCHRONOUSLY
            // (not dispatched to executor, unlike handleFirstMessage below) — the sender follows
            // file-info immediately with binary chunks on the same connection, and this library
            // delivers onMessage callbacks for one connection in order on the calling thread, so
            // activeTransfers must already contain this conn by the time this method returns, or
            // the very next onMessage(ByteBuffer) call could race ahead of it and be dropped.
            handleFileInfo(conn, message);
            return;
        }
        executor.execute(() -> handleFirstMessage(conn, message));
    }

    private void handleFirstMessage(WebSocket conn, String message) {
        String connId = connIds.get(conn);
        if (connId == null) return;

        JSONObject msg;
        try {
            msg = new JSONObject(message);
        } catch (Exception e) {
            conn.close(4003, "malformed join message");
            return;
        }

        String type = msg.optString("type", "");
        if ("join-token".equals(type)) {
            String token = msg.optString("token", null);
            TokenEntry entry = token != null ? validTokens.get(token) : null;
            if (entry == null) {
                conn.close(4005, "invalid or expired token");
                return;
            }
            validTokens.remove(token);
            if (blockChecker.isBlocked(entry.deviceId)) {
                conn.close(4010, "blocked");
                return;
            }
            admit(conn);
        } else if ("join-guest".equals(type)) {
            byte[] peerPublicKeyDer = peerKeysByConn.get(conn);
            String remoteAddress = remoteAddrByConn.get(conn);
            if (peerPublicKeyDer == null) {
                conn.close(4002, "invalid certificate");
                return;
            }
            String deviceName = msg.optString("deviceName", "Guest");
            // A paired device has already been vouched for; only strangers get the PIN prompt.
            LinkTrustStore.TrustedDevice trusted = new LinkTrustStore(context).findByPublicKey(peerPublicKeyDer);
            if (trusted != null) {
                pendingGuests.put(connId, new PendingGuest(conn, "", null, remoteAddress != null ? remoteAddress : "unknown", deviceName));
                admit(conn);
                return;
            }
            String pin = LinkVerification.computeCode(myPublicKeyDer, peerPublicKeyDer, "");
            ScheduledFuture<?> timeoutFuture = scheduler.schedule(() -> {
                pendingGuests.remove(connId);
                try { conn.close(4006, "confirmation timed out"); } catch (Exception ignored) {}
            }, GUEST_CONFIRM_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            pendingGuests.put(connId, new PendingGuest(conn, pin, timeoutFuture, remoteAddress != null ? remoteAddress : "unknown", deviceName));
            try {
                conn.send(new JSONObject().put("type", "pin").put("code", pin).toString());
            } catch (Exception ignored) {}
            listener.onGuestPinPending(connId, pin, remoteAddress != null ? remoteAddress : "unknown", deviceName);
        } else {
            conn.close(4004, "unknown join type");
        }
    }

    private void handleFileInfo(WebSocket conn, String message) {
        String connId = connIds.get(conn);
        if (connId == null) return;
        JSONObject msg;
        try {
            msg = new JSONObject(message);
        } catch (Exception e) {
            return;
        }
        String type = msg.optString("type", "");
        if ("downloads-available".equals(type)) {
            org.json.JSONArray files = msg.optJSONArray("files");
            if (files != null) listener.onPeerFilesChanged(connId, files);
            return;
        } else if ("request-download".equals(type)) {
            String fileId = msg.optString("fileId", "");
            handleDownloadRequest(conn, fileId);
            return;
        } else if ("batch-info".equals(type)) {
            int count = msg.optInt("count", 0);
            if (count > 0) batchStates.put(conn, new BatchState(count));
            return;
        } else if ("received".equals(type)) {
            listener.onSendComplete();
            return;
        }
        if (!"file-info".equals(type)) return;
        String name = msg.optString("name", "received-file");
        long size = msg.optLong("size", -1);
        if (size < 0 || size > MAX_FILE_BYTES) {
            conn.close(4008, "file too large");
            return;
        }

        // Split and sanitize relative path
        String[] parts = name.split("[/\\\\]");
        java.util.List<String> cleanParts = new java.util.ArrayList<>();
        for (String part : parts) {
            if (!part.isEmpty() && !".".equals(part) && !"..".equals(part)) {
                cleanParts.add(part);
            }
        }
        if (cleanParts.isEmpty()) {
            conn.close(4009, "invalid filename");
            return;
        }

        String displayName = cleanParts.get(cleanParts.size() - 1);
        StringBuilder relativeSubdir = new StringBuilder();
        for (int i = 0; i < cleanParts.size() - 1; i++) {
            relativeSubdir.append("/").append(cleanParts.get(i));
        }
        String subPath = relativeSubdir.toString(); // e.g. "/folder/subfolder" or ""

        try {
            ActiveTransfer transfer = openDestination(displayName, subPath, size);
            activeTransfers.put(conn, transfer);
            listener.onTransferStarted(connId, name, size);
        } catch (Exception e) {
            Log.e(TAG, "Failed to open destination file", e);
            conn.close(4009, "failed to open destination file");
        }
    }

    private ActiveTransfer openDestination(String safeName, String relativeSubdir, long size) throws Exception {
        File dir = new File(Environment.getExternalStorageDirectory(), "Link" + relativeSubdir);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File destFile = new File(dir, safeName);
        int counter = 1;
        String base = safeName;
        String ext = "";
        int dot = safeName.lastIndexOf('.');
        if (dot > 0) {
            base = safeName.substring(0, dot);
            ext = safeName.substring(dot);
        }
        while (destFile.exists()) {
            destFile = new File(dir, base + " (" + counter + ")" + ext);
            counter++;
        }
        return new ActiveTransfer(safeName, size, new java.io.FileOutputStream(destFile), destFile.getAbsolutePath(), null);
    }

    private void finishTransfer(ActiveTransfer transfer) throws Exception {
        transfer.out.close();
        android.media.MediaScannerConnection.scanFile(context, new String[]{transfer.destDisplay}, null, null);
    }

    @Override
    public void onMessage(WebSocket conn, ByteBuffer message) {
        // Deliberately synchronous, not dispatched to executor — binary chunks for one connection
        // must be written to disk in strict arrival order. Dispatching each call onto a cached
        // thread pool would let chunk N+1's task run before chunk N's finishes, corrupting the
        // file with a chunk written out of order. This library already delivers onMessage
        // callbacks for a given connection in order on the calling thread, so doing the (brief,
        // local-disk) write here preserves that ordering for free instead of having to rebuild it
        // with a per-connection queue. Writes are purely sequential (no seeking) for the same
        // reason — see this file's header comment.
        ActiveTransfer transfer = activeTransfers.get(conn);
        if (transfer == null) return; // binary arrived before file-info — ignore, protocol error
        try {
            byte[] chunk = new byte[message.remaining()];
            message.get(chunk);
            transfer.out.write(chunk);
            transfer.received += chunk.length;

            String connId = connIds.get(conn);
            if (connId != null) listener.onTransferProgress(connId, transfer.received, transfer.size);

            if (transfer.received >= transfer.size) {
                finishTransfer(transfer);
                activeTransfers.remove(conn);
                if (connId != null) listener.onTransferComplete(connId, transfer.destDisplay);

                // No batch-info at all (an older sender, or a genuinely single-file send) means an
                // implicit count of 1 — finish immediately, same as before this feature existed.
                BatchState batch = batchStates.get(conn);
                boolean batchDone = true;
                if (batch != null) {
                    batch.received += 1;
                    batchDone = batch.received >= batch.expected;
                    if (batchDone) batchStates.remove(conn);
                }
                if (batchDone) {
                    try { conn.send(new JSONObject().put("type", "received").toString()); } catch (Exception ignored) {}
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to write incoming file chunk", e);
            listener.onError("Failed to write incoming file: " + e.getMessage());
        }
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        String connId = connIds.remove(conn);
        if (connId != null) {
            admittedConnections.remove(connId);
            admittedDeviceNames.remove(connId);
            listener.onConnectionClosed(connId);
        }
        peerKeysByConn.remove(conn);
        remoteAddrByConn.remove(conn);
        firstMessageHandled.remove(conn);
        batchStates.remove(conn);
        ActiveTransfer transfer = activeTransfers.remove(conn);
        if (transfer != null) {
            try { transfer.out.close(); } catch (Exception ignored) {}
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        Log.e(TAG, "Portal Transfer server error", ex);
        listener.onError(ex != null ? ex.getMessage() : "Unknown server error");
    }

    @Override
    public void onStart() {
        Log.i(TAG, "Portal Transfer server started on port " + getPort());
    }

    /** deviceName is only ever used for display — the caller must supply the real name since
     *  this class has no trust-store access of its own. Left unwired in LinkPlugin.java for now
     *  (guest-only v1, matching the actual ask) — see portal-transfer-server.ts's header comment
     *  for the same design note on the desktop side. */
    public String issueToken(String deviceId, String deviceName) {
        byte[] randomBytes = new byte[16];
        new SecureRandom().nextBytes(randomBytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : randomBytes) sb.append(String.format("%02x", b));
        String token = sb.toString();
        validTokens.put(token, new TokenEntry(deviceId, deviceName));
        return token;
    }

    @Override
    public void stop() throws InterruptedException {
        for (PendingGuest p : pendingGuests.values()) {
            p.timeoutFuture.cancel(false);
            try { p.conn.close(1000, "receiver stopped"); } catch (Exception ignored) {}
        }
        pendingGuests.clear();
        validTokens.clear();
        for (ActiveTransfer t : activeTransfers.values()) {
            try { t.out.close(); } catch (Exception ignored) {}
        }
        activeTransfers.clear();
        batchStates.clear();
        super.stop();
    }
}
