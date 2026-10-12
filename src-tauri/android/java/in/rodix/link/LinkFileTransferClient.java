package in.rodix.link;

// Portal Mode — Android-as-sender side. Mirrors LinkAudioSinkClient.java's connect/PIN pattern
// and portal-transfer-client.ts's protocol exactly (see portal-transfer-server.ts's header
// comment for the full wire format). Once admitted, sends a batch-info announcing the file count,
// then streams each file in turn — read via ContentResolver from a content:// Uri (Android's file
// picker, ACTION_OPEN_DOCUMENT with EXTRA_ALLOW_MULTIPLE, hands back Uris, not filesystem paths —
// the one genuinely new piece of work this port needed beyond a straight translation of the
// desktop TypeScript, see LinkPlugin.java's pickPortalFiles()).

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;

public class LinkFileTransferClient {
    private static final String TAG = "LinkFileTransferClient";
    private static final int CHUNK_SIZE = 262144; // 256KB chunks for maximum throughput

    public interface Listener {
        void onPinComputed(String pin);
        void onAdmitted(String receiverDeviceName);
        void onPeerFilesChanged(org.json.JSONArray files);
        void onFileStarted(int fileIndex, int fileCount, String name);
        void onProgress(long sent, long total);
        void onComplete();
        void onTransferStarted(String name, long size);
        void onTransferProgress(long received, long size);
        void onTransferComplete(String destPath);
        void onEnded();
        void onClosed(String reason);
        void onError(String message);
    }

    private static class ActiveTransfer {
        final String name;
        final long size;
        long received;
        final java.io.OutputStream out;
        final String destDisplay;
        ActiveTransfer(String name, long size, java.io.OutputStream out, String destDisplay) {
            this.name = name;
            this.size = size;
            this.out = out;
            this.destDisplay = destDisplay;
        }
    }

    private static class BatchState {
        int expected;
        int received;
        BatchState(int expected) {
            this.expected = expected;
        }
    }

    private final Listener listener;
    private final Context context;
    private WebSocketClient client;
    private boolean pinComputedLocally = false;
    private ActiveTransfer activeTransfer = null;
    private BatchState batchState = null;

    public LinkFileTransferClient(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    /** token null = guest path (PIN confirmation); token non-null = already-paired fast path
     *  (class supports it, mirroring the desktop client, but LinkPlugin.java doesn't wire it up
     *  yet — guest-only v1, matching the actual ask). */
    private String localDeviceName = "Guest";

    private volatile boolean resolved = false;
    private final java.util.List<WebSocketClient> pendingClients = new java.util.concurrent.CopyOnWriteArrayList<>();

    public void connect(final String host, final int port, final X509Certificate myCert, final PrivateKey myKey, final String token, String localDeviceName) {
        this.localDeviceName = localDeviceName != null ? localDeviceName : "Guest";
        
        String[] hosts = host.split(",");
        for (int i = 0; i < hosts.length; i++) {
            hosts[i] = hosts[i].trim();
        }

        if (hosts.length <= 1) {
            connectSingle(host.trim(), port, myCert, myKey, token);
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
                                    synchronized (LinkFileTransferClient.this) {
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

                                    Log.i(TAG, "onOpen (" + singleHost + ") — TLS handshake complete, sending join message");
                                    if (token != null) {
                                        sendJoin("join-token", "token", token);
                                    } else {
                                        computeAndReportPin(myCert);
                                        sendJoin("join-guest", null, null);
                                    }
                                }

                                @Override
                                public void onMessage(String message) {
                                    if (client == this) {
                                        handleControlMessage(message);
                                    }
                                }

                                @Override
                                public void onMessage(ByteBuffer bytes) {
                                    if (client == this) {
                                        handleBinaryMessage(bytes);
                                    }
                                }

                                @Override
                                public void onClose(int code, String reason, boolean remote) {
                                    if (client == this) {
                                        if (activeTransfer != null) {
                                            try { activeTransfer.out.close(); } catch (Exception ignored) {}
                                            activeTransfer = null;
                                        }
                                        batchState = null;
                                        Log.i(TAG, "onClose code=" + code + " reason=" + reason + " remote=" + remote);
                                        if (code == 1000 || code == 1001) {
                                            listener.onEnded();
                                        } else {
                                            listener.onClosed(reason != null && !reason.isEmpty() ? reason : ("code " + code));
                                        }
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
            listener.onError("Failed to initialize TLS: " + e.getMessage());
        }
    }

    private void connectSingle(String host, int port, X509Certificate myCert, PrivateKey myKey, String token) {
        try {
            URI uri = new URI("wss://" + host + ":" + port);
            SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);

            client = new WebSocketClient(uri) {
                @Override
                public void onOpen(ServerHandshake handshakedata) {
                    if (token != null) {
                        sendJoin("join-token", "token", token);
                    } else {
                        computeAndReportPin(myCert);
                        sendJoin("join-guest", null, null);
                    }
                }

                @Override
                public void onMessage(String message) {
                    handleControlMessage(message);
                }

                @Override
                public void onMessage(ByteBuffer bytes) {
                    handleBinaryMessage(bytes);
                }

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    if (activeTransfer != null) {
                        try { activeTransfer.out.close(); } catch (Exception ignored) {}
                        activeTransfer = null;
                    }
                    batchState = null;
                    if (client != this) return;
                    Log.i(TAG, "onClose code=" + code + " reason=" + reason + " remote=" + remote);
                    if (code == 1000 || code == 1001) {
                        listener.onEnded();
                    } else {
                        listener.onClosed(reason != null && !reason.isEmpty() ? reason : ("code " + code));
                    }
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

    private void sendJoin(String type, String extraKey, String extraValue) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("type", type);
            if (extraKey != null) obj.put(extraKey, extraValue);
            if ("join-guest".equals(type)) {
                obj.put("deviceName", localDeviceName);
            }
            client.send(obj.toString());
        } catch (Exception e) {
            Log.e(TAG, "Failed to send join message", e);
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
        } catch (Exception e) {
            Log.w(TAG, "Could not independently verify PIN from peer certificate — will trust the host-reported PIN instead", e);
        }
    }

    private String peerDeviceName = null;

    public String getPeerDeviceName() {
        return peerDeviceName;
    }

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
        if (client == null || !client.isOpen()) return;
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
            client.send(packet.toString());
        } catch (Exception ignored) {}
    }

    public void requestDownload(String fileId) {
        if (client != null && client.isOpen()) {
            try {
                client.send(new JSONObject().put("type", "request-download").put("fileId", fileId).toString());
            } catch (Exception ignored) {}
        }
    }

    private void handleDownloadRequest(String fileId) {
        for (SharedFileEntry entry : availableDownloads) {
            if (entry.id.equals(fileId)) {
                new Thread(() -> {
                    sendOneFile(context, entry.uri, 0, 1);
                    try { client.send(new JSONObject().put("type", "received").toString()); } catch (Exception ignored) {}
                    listener.onComplete();
                }, "link-portal-client-download-stream").start();
                break;
            }
        }
    }

    private void handleControlMessage(String message) {
        try {
            JSONObject obj = new JSONObject(message);
            String type = obj.optString("type");
            if ("admitted".equals(type)) {
                peerDeviceName = obj.optString("deviceName", null);
                listener.onAdmitted(peerDeviceName);
                if (!availableDownloads.isEmpty()) {
                    broadcastDownloadsAvailable();
                }
            } else if ("downloads-available".equals(type)) {
                org.json.JSONArray files = obj.optJSONArray("files");
                if (files != null) listener.onPeerFilesChanged(files);
            } else if ("request-download".equals(type)) {
                String fileId = obj.optString("fileId", "");
                handleDownloadRequest(fileId);
            } else if ("received".equals(type)) {
                listener.onComplete();
            } else if ("pin".equals(type) && !pinComputedLocally) {
                listener.onPinComputed(obj.optString("code"));
            } else if ("batch-info".equals(type)) {
                int count = obj.optInt("count", 0);
                if (count > 0) batchState = new BatchState(count);
            } else if ("file-info".equals(type)) {
                String name = obj.optString("name", "received-file");
                long size = obj.optLong("size", -1);
                startReceiveTransfer(name, size);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse control message", e);
        }
    }

    private void startReceiveTransfer(String name, long size) {
        String[] parts = name.split("[/\\\\]");
        java.util.List<String> cleanParts = new java.util.ArrayList<>();
        for (String part : parts) {
            if (!part.isEmpty() && !".".equals(part) && !"..".equals(part)) {
                cleanParts.add(part);
            }
        }
        if (cleanParts.isEmpty()) return;

        String displayName = cleanParts.get(cleanParts.size() - 1);
        StringBuilder relativeSubdir = new StringBuilder();
        for (int i = 0; i < cleanParts.size() - 1; i++) {
            relativeSubdir.append("/").append(cleanParts.get(i));
        }
        String subPath = relativeSubdir.toString();

        try {
            java.io.File dir = new java.io.File(android.os.Environment.getExternalStorageDirectory(), "Link" + subPath);
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            java.io.File destFile = new java.io.File(dir, displayName);
            int counter = 1;
            String base = displayName;
            String ext = "";
            int dot = displayName.lastIndexOf('.');
            if (dot > 0) {
                base = displayName.substring(0, dot);
                ext = displayName.substring(dot);
            }
            while (destFile.exists()) {
                destFile = new java.io.File(dir, base + " (" + counter + ")" + ext);
                counter++;
            }
            activeTransfer = new ActiveTransfer(displayName, size, new java.io.FileOutputStream(destFile), destFile.getAbsolutePath());
            listener.onTransferStarted(name, size);
        } catch (Exception e) {
            Log.e(TAG, "Failed to open destination file", e);
        }
    }

    private void handleBinaryMessage(ByteBuffer bytes) {
        ActiveTransfer transfer = activeTransfer;
        if (transfer == null) return;
        try {
            byte[] chunk = new byte[bytes.remaining()];
            bytes.get(chunk);
            transfer.out.write(chunk);
            transfer.received += chunk.length;
            listener.onTransferProgress(transfer.received, transfer.size);

            if (transfer.received >= transfer.size) {
                transfer.out.close();
                if (context != null) {
                    android.media.MediaScannerConnection.scanFile(context, new String[]{transfer.destDisplay}, null, null);
                }
                activeTransfer = null;
                listener.onTransferComplete(transfer.destDisplay);

                boolean batchDone = true;
                if (batchState != null) {
                    batchState.received += 1;
                    batchDone = batchState.received >= batchState.expected;
                    if (batchDone) batchState = null;
                }
                if (batchDone && client != null && client.isOpen()) {
                    try { client.send(new JSONObject().put("type", "received").toString()); } catch (Exception ignored) {}
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to write incoming file chunk", e);
            listener.onError("Failed to write incoming file: " + e.getMessage());
        }
    }

    /** Streams every Uri in fileUris, in order, to the (already-admitted) receiver over the same
     *  connection — one batch-info announcing the count, then one file-info + binary frames per
     *  file. Runs synchronously on the calling thread — callers must invoke this off the main
     *  thread (see LinkPlugin.java's usage, same dedicated-thread pattern as every other blocking
     *  network call in this codebase). Stops at the first failure rather than skipping ahead,
     *  since the receiver expects exactly `count` files in this exact order. */
    public void sendFiles(Context context, java.util.List<Uri> fileUris) {
        if (client == null || !client.isOpen()) {
            listener.onError("Not connected");
            return;
        }
        try {
            client.send(new JSONObject().put("type", "batch-info").put("count", fileUris.size()).toString());
        } catch (Exception e) {
            listener.onError("Failed to send batch-info: " + e.getMessage());
            return;
        }
        for (int i = 0; i < fileUris.size(); i++) {
            if (client == null || !client.isOpen()) {
                listener.onError("Connection closed mid-transfer");
                return;
            }
            String name = sendOneFile(context, fileUris.get(i), i, fileUris.size());
            if (name == null) return; // sendOneFile already reported the error
        }
    }

    /** Returns the sent file's display name on success, or null if it failed (having already
     *  called listener.onError itself) — the caller uses that null to stop the batch early. */
    private String sendOneFile(Context context, Uri fileUri, int fileIndex, int fileCount) {
        ContentResolver resolver = context.getContentResolver();
        String name = "file";
        long size = -1;
        try (Cursor cursor = resolver.query(fileUri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE);
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
            client.send(new JSONObject().put("type", "file-info").put("name", name).put("size", size).toString());
        } catch (Exception e) {
            listener.onError("Failed to send file-info: " + e.getMessage());
            return null;
        }

        long total = size;
        long sent = 0;
        try (InputStream in = resolver.openInputStream(fileUri)) {
            if (in == null) {
                listener.onError("Failed to open file for reading");
                return null;
            }
            byte[] buffer = new byte[CHUNK_SIZE];
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (client == null || !client.isOpen()) {
                    listener.onError("Connection closed mid-transfer");
                    return null;
                }
                byte[] chunk = read == buffer.length ? buffer : java.util.Arrays.copyOf(buffer, read);
                // WebSocketClient.send(byte[]) blocks on the underlying (blocking-mode) Socket
                // write until the OS accepts the bytes — natural backpressure, no separate
                // buffered-amount check needed the way the Node desktop client needs one.
                client.send(chunk);
                sent += read;
                listener.onProgress(sent, total);
            }
        } catch (Exception e) {
            listener.onError("Failed to read/send file: " + e.getMessage());
            return null;
        }
        return name;
    }

    public boolean isConnected() {
        return client != null && client.isOpen();
    }

    public void disconnect() {
        if (client != null) {
            try { client.close(); } catch (Exception ignored) {}
            client = null;
        }
    }
}
