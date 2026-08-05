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

public class LinkPortalTransferClient {
    private static final String TAG = "LinkPortalTransferClient";
    private static final int CHUNK_SIZE = 262144; // 256KB chunks for maximum throughput

    public interface Listener {
        void onPinComputed(String pin);
        /** receiverDeviceName is the receiving device's own name — null on an old peer that
         *  doesn't send it yet — so the UI can show "Connected with <name>" instead of a generic
         *  placeholder, the same way the receiver already knows the sender's name. */
        void onAdmitted(String receiverDeviceName);
        // fileIndex/fileCount let the UI show "file 2 of 5" — progress itself is still per-file
        // byte counts (sent/total for the CURRENT file), same shape as before this feature existed.
        void onFileStarted(int fileIndex, int fileCount, String name);
        void onProgress(long sent, long total);
        void onComplete();
        void onEnded();
        void onClosed(String reason);
        void onError(String message);
    }

    private final Listener listener;
    private WebSocketClient client;
    private boolean pinComputedLocally = false;

    public LinkPortalTransferClient(Listener listener) {
        this.listener = listener;
    }

    /** token null = guest path (PIN confirmation); token non-null = already-paired fast path
     *  (class supports it, mirroring the desktop client, but LinkPlugin.java doesn't wire it up
     *  yet — guest-only v1, matching the actual ask). */
    private String localDeviceName = "Guest";

    public void connect(String host, int port, X509Certificate myCert, PrivateKey myKey, String token, String localDeviceName) {
        this.localDeviceName = localDeviceName != null ? localDeviceName : "Guest";
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
                    Log.w(TAG, "Unexpected binary WebSocket message — ignoring");
                }

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    // Stale-instance guard, mirroring LinkAudioSinkClient.java/LinkJoystickClient.java's
                    // identical check — disconnect() below nulls the outer `client` field
                    // synchronously, so an intentional local disconnect (e.g. cancelling mid-connect,
                    // which java-websocket often reports as code -1/NEVER_CONNECTED rather than a
                    // clean 1000) never reaches here as a spurious "code -1" error the user never
                    // asked about.
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

    private void handleControlMessage(String message) {
        try {
            JSONObject obj = new JSONObject(message);
            String type = obj.optString("type");
            if ("admitted".equals(type)) {
                listener.onAdmitted(obj.optString("deviceName", null));
            } else if ("received".equals(type)) {
                listener.onComplete();
            } else if ("pin".equals(type) && !pinComputedLocally) {
                listener.onPinComputed(obj.optString("code"));
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse control message", e);
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
