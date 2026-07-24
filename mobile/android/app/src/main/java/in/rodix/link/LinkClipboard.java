package in.rodix.link;

// Clipboard plugin — Java port of desktop/src/core/plugins/clipboard.ts, itself a faithful port
// of kdeconnect-kde's plugins/clipboard/clipboardplugin.cpp. Supports text, image, and file sync
// using the link.clipboard.file packet type.

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;

import org.json.JSONObject;

public class LinkClipboard {
    public static final String PACKET_TYPE_CLIPBOARD = "link.clipboard";
    public static final String PACKET_TYPE_CLIPBOARD_CONNECT = "link.clipboard.connect";
    public static final String PACKET_TYPE_CLIPBOARD_FILE = "link.clipboard.file";

    public static LinkPacket createClipboardPacket(String content) {
        try {
            JSONObject body = new JSONObject();
            body.put("content", content);
            return new LinkPacket(PACKET_TYPE_CLIPBOARD, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createConnectPacket(String content, long timestamp) {
        try {
            JSONObject body = new JSONObject();
            body.put("content", content);
            body.put("timestamp", timestamp);
            return new LinkPacket(PACKET_TYPE_CLIPBOARD_CONNECT, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createClipboardFilePacket(String filename) {
        try {
            JSONObject body = new JSONObject();
            body.put("filename", filename);
            return new LinkPacket(PACKET_TYPE_CLIPBOARD_FILE, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static boolean isClipboardPacket(LinkPacket packet) {
        return PACKET_TYPE_CLIPBOARD.equals(packet.type) || 
               PACKET_TYPE_CLIPBOARD_CONNECT.equals(packet.type) ||
               PACKET_TYPE_CLIPBOARD_FILE.equals(packet.type);
    }

    /**
     * Extracts the text to apply locally from an incoming clipboard packet, or null if it should
     * be ignored.
     */
    public static String extractIncomingText(LinkPacket packet, long lastKnownTimestamp) {
        if (PACKET_TYPE_CLIPBOARD.equals(packet.type)) {
            return packet.body.has("content") ? packet.body.optString("content", null) : null;
        }
        if (PACKET_TYPE_CLIPBOARD_CONNECT.equals(packet.type)) {
            long timestamp = packet.body.optLong("timestamp", 0);
            if (timestamp == 0 || timestamp < lastKnownTimestamp) return null;
            return packet.body.has("content") ? packet.body.optString("content", null) : null;
        }
        return null;
    }

    public interface Listener {
        void onLocalTextChange(String content);
        void onLocalFileChange(String filename, byte[] data);
    }

    /** Watches the system clipboard for local changes and reports them, suppressing our own echo. */
    public static class Watcher {
        private final ClipboardManager clipboardManager;
        private String lastSeenText;
        private String lastSeenUri = "";
        private long lastUpdateTimestamp = System.currentTimeMillis();
        private volatile boolean suppressNextChange = false;
        private final Listener listener;

        public Watcher(Context context, Listener listener) {
            this.listener = listener;
            clipboardManager = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            lastSeenText = readCurrentText();

            clipboardManager.addPrimaryClipChangedListener(() -> {
                if (suppressNextChange) {
                    suppressNextChange = false;
                    return;
                }

                ClipData clip = clipboardManager.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return;

                ClipData.Item item = clip.getItemAt(0);
                Uri uri = item.getUri();
                if (uri != null) {
                    String uriStr = uri.toString();
                    if (uriStr.equals(lastSeenUri)) return;
                    lastSeenUri = uriStr;
                    lastSeenText = "";

                    new Thread(() -> {
                        try {
                            String filename = queryFileName(context, uri);
                            if (filename == null) filename = "ClipboardFile_" + System.currentTimeMillis();

                            java.io.InputStream in = context.getContentResolver().openInputStream(uri);
                            if (in != null) {
                                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                                byte[] buf = new byte[4096];
                                int n;
                                while ((n = in.read(buf)) != -1) {
                                    out.write(buf, 0, n);
                                }
                                in.close();
                                byte[] data = out.toByteArray();
                                if (data.length > 0) {
                                    lastUpdateTimestamp = System.currentTimeMillis();
                                    listener.onLocalFileChange(filename, data);
                                }
                            }
                        } catch (Exception e) {
                            android.util.Log.e("LinkClipboard", "Failed to read clipboard URI", e);
                        }
                    }, "link-clipboard-uri-read").start();
                    return;
                }

                CharSequence text = item.getText();
                String current = text != null ? text.toString() : "";
                if (current.isEmpty() || current.equals(lastSeenText)) return;
                lastSeenText = current;
                lastSeenUri = "";
                lastUpdateTimestamp = System.currentTimeMillis();
                listener.onLocalTextChange(current);
            });
        }

        private String readCurrentText() {
            try {
                if (!clipboardManager.hasPrimaryClip()) return "";
                ClipData clip = clipboardManager.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return "";
                CharSequence text = clip.getItemAt(0).getText();
                return text != null ? text.toString() : "";
            } catch (Exception e) {
                return "";
            }
        }

        public static String queryFileName(Context context, Uri uri) {
            String name = null;
            if ("content".equals(uri.getScheme())) {
                try (android.database.Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                        if (index != -1) {
                            name = cursor.getString(index);
                        }
                    }
                }
            }
            if (name == null) {
                name = uri.getLastPathSegment();
            }
            return name;
        }

        /** Called when we write a peer's clipboard content locally. */
        public void applyRemote(String content) {
            suppressNextChange = true;
            clipboardManager.setPrimaryClip(ClipData.newPlainText("link", content));
            lastSeenText = content;
            lastSeenUri = "";
        }

        /** Called when we write a peer's clipboard file locally. */
        public void applyRemoteFile(Context context, String filename, byte[] data) {
            try {
                suppressNextChange = true;

                java.io.File cacheFile = new java.io.File(context.getCacheDir(), filename);
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(cacheFile)) {
                    out.write(data);
                }

                Uri contentUri = androidx.core.content.FileProvider.getUriForFile(
                        context, context.getPackageName() + ".fileprovider", cacheFile);

                ClipData clip = ClipData.newUri(context.getContentResolver(), "File", contentUri);
                clipboardManager.setPrimaryClip(clip);

                lastSeenUri = contentUri.toString();
                lastSeenText = "";
            } catch (Exception e) {
                android.util.Log.e("LinkClipboard", "Failed to apply remote clipboard file", e);
            }
        }

        public String currentContent() {
            return lastSeenText;
        }

        public long currentTimestamp() {
            return lastUpdateTimestamp;
        }
    }
}
