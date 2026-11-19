package in.rodix.link;

// File sharing between paired devices (Android side of core/share.rs).
//
// Wire protocol, all packets over the trusted control channel:
//   link.share.offer   sender -> receiver  {transferId, files:[{name,size}], totalSize}
//   link.share.answer  receiver -> sender  {transferId, accepted, reason?}
//   link.share.start   sender -> receiver  {transferId} + payloadTransferInfo {port}
//   link.share.done    receiver -> sender  {transferId, ok, saved, error?}
// The payload is every offered file's bytes back to back, in offer order, over a one-shot pinned
// TLS connection that the receiver opens to the sender (LinkPayloadTransfer).
//
// This phone never asks before receiving: an offer from a paired device with file access allowed
// is accepted at once and saved under <storage>/Link/ with a "copied" notification. The PC is the
// side that prompts.

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class LinkShare {
    private static final String TAG = "LinkShare";

    public static final String PACKET_OFFER = "link.share.offer";
    public static final String PACKET_ANSWER = "link.share.answer";
    public static final String PACKET_START = "link.share.start";
    public static final String PACKET_DONE = "link.share.done";

    private static final String CHANNEL_ID = "link_share";
    private static final int MAX_FILES = 10000;
    // The PC user has to press Accept and then pick a folder, so be generous.
    private static final long ANSWER_TIMEOUT_MS = 100_000; // a little over the PC prompt's 90 s
    private static final long RECEIVER_CONNECT_TIMEOUT_MS = 60_000;
    private static final long DONE_TIMEOUT_MS = 120_000;
    private static final long STALE_INCOMING_MS = 10 * 60_000;
    private static final String SHORTCUT_PREFIX = "link-share-";
    static final String SHORTCUT_CATEGORY = "in.rodix.link.category.SHARE_TARGET";

    private LinkShare() {
    }

    public static boolean isSharePacket(LinkPacket packet) {
        return packet != null && packet.type != null && packet.type.startsWith("link.share.");
    }

    // ---------------------------------------------------------------- shared helpers

    /** One file to send. Holds an open descriptor so the data stays readable after the share
     *  sheet's temporary URI grant lapses (the ShareActivity finishes before the PC answers). */
    public static class Item {
        public final String name;
        public final long size;
        final ParcelFileDescriptor pfd;
        final File file;

        public Item(String name, long size, ParcelFileDescriptor pfd, File file) {
            this.name = name;
            this.size = size;
            this.pfd = pfd;
            this.file = file;
        }

        InputStream open() throws IOException {
            if (pfd != null) return new ParcelFileDescriptor.AutoCloseInputStream(pfd);
            return new java.io.FileInputStream(file);
        }

        void release() {
            try { if (pfd != null) pfd.close(); } catch (Exception ignored) { }
            if (file != null) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    private static String deviceName(LinkDeviceManager dm, String deviceId) {
        try {
            for (LinkDeviceManager.ConnectedPeerInfo info : dm.connectedPeers()) {
                if (info.identity.deviceId.equals(deviceId) && info.identity.deviceName != null) {
                    return info.identity.deviceName;
                }
            }
            LinkTrustStore.TrustedDevice trusted = dm.getTrustStore().get(deviceId);
            if (trusted != null && trusted.deviceName != null) return trusted.deviceName;
        } catch (Exception ignored) {
        }
        return "device";
    }

    private static void reply(LinkDeviceManager dm, String deviceId, String type, JSONObject body) {
        dm.sendTo(deviceId, new LinkPacket(type, body));
    }

    // ---------------------------------------------------------------- notifications

    private static void ensureChannel(Context context) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "File sharing", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Files sent to and received from your other devices");
        nm.createNotificationChannel(channel);
    }

    private static int notificationId(String transferId) {
        return 7000 + (transferId.hashCode() & 0x7ff);
    }

    private static PendingIntent openAppIntent(Context context) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) launch = new Intent();
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** progress: -1 = no bar, -2 = indeterminate, 0..100 = determinate (ongoing). */
    private static void notifyTransfer(Context context, String transferId, String title, String text, int progress, PendingIntent tap) {
        try {
            ensureChannel(context);
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification.Builder builder = new Notification.Builder(context, CHANNEL_ID);
            builder.setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setOnlyAlertOnce(true)
                    .setContentIntent(tap != null ? tap : openAppIntent(context));
            if (progress == -1) {
                builder.setAutoCancel(true).setOngoing(false);
            } else {
                builder.setOngoing(true).setProgress(100, Math.max(progress, 0), progress == -2);
            }
            nm.notify(notificationId(transferId), builder.build());
        } catch (Exception e) {
            Log.w(TAG, "Could not post share notification", e);
        }
    }

    /** Throttles progress notifications to one per percent and no more than twice a second. */
    private static class ProgressNotifier {
        private final Context context;
        private final String transferId;
        private final String title;
        private final String text;
        private final long total;
        private int lastPercent = -1;
        private long lastAt = 0;

        ProgressNotifier(Context context, String transferId, String title, String text, long total) {
            this.context = context;
            this.transferId = transferId;
            this.title = title;
            this.text = text;
            this.total = total;
        }

        void update(long done) {
            if (total <= 0) return;
            int percent = (int) Math.min(100, done * 100 / total);
            long now = System.currentTimeMillis();
            if (percent == lastPercent || now - lastAt < 500) return;
            lastPercent = percent;
            lastAt = now;
            notifyTransfer(context, transferId, title, text, percent, null);
        }
    }

    // ---------------------------------------------------------------- packet dispatch

    /** Handles any link.share.* packet from a paired device. */
    public static void handlePacket(Context context, LinkDeviceManager dm, String deviceId, LinkPacket packet) {
        Context app = context.getApplicationContext();
        switch (packet.type) {
            case PACKET_OFFER:
                handleOffer(app, dm, deviceId, packet);
                break;
            case PACKET_ANSWER: {
                Outgoing out = outgoing.get(packet.body.optString("transferId", ""));
                if (out != null && out.deviceId.equals(deviceId)) {
                    out.accepted = packet.body.optBoolean("accepted", false);
                    out.reason = packet.body.optString("reason", "");
                    out.answered.countDown();
                }
                break;
            }
            case PACKET_START:
                handleStart(app, dm, deviceId, packet);
                break;
            case PACKET_DONE: {
                Outgoing out = outgoing.get(packet.body.optString("transferId", ""));
                if (out != null && out.deviceId.equals(deviceId)) {
                    out.doneOk = packet.body.optBoolean("ok", false);
                    out.doneError = packet.body.optString("error", "");
                    out.doneSaved = packet.body.optInt("saved", 0);
                    out.done.countDown();
                }
                break;
            }
            default:
                break;
        }
    }

    // ---------------------------------------------------------------- receiving

    private static class Incoming {
        final String deviceId;
        final String transferId;
        final String[][] parts;
        final long[] sizes;
        final long total;
        final long createdAt = System.currentTimeMillis();
        volatile boolean started;

        Incoming(String deviceId, String transferId, String[][] parts, long[] sizes, long total) {
            this.deviceId = deviceId;
            this.transferId = transferId;
            this.parts = parts;
            this.sizes = sizes;
            this.total = total;
        }
    }

    private static final Map<String, Incoming> incoming = new ConcurrentHashMap<>();

    /** Path components of a relative name, or null when any component is unsafe. */
    static String[] cleanParts(String name) {
        if (name == null || name.isEmpty() || name.length() > 1024) return null;
        if (name.indexOf('\\') >= 0 || name.indexOf(':') >= 0) return null;
        String[] parts = name.split("/", -1);
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part) || part.length() > 255) return null;
            for (int i = 0; i < part.length(); i++) {
                char c = part.charAt(i);
                if (c < 0x20 || c == 0x7f) return null;
            }
        }
        return parts;
    }

    private static void refuse(LinkDeviceManager dm, String deviceId, String transferId, String reason) {
        try {
            JSONObject body = new JSONObject();
            body.put("transferId", transferId);
            body.put("accepted", false);
            body.put("reason", reason);
            reply(dm, deviceId, PACKET_ANSWER, body);
        } catch (Exception ignored) {
        }
    }

    private static void handleOffer(Context context, LinkDeviceManager dm, String deviceId, LinkPacket packet) {
        String transferId = packet.body.optString("transferId", "");
        if (transferId.isEmpty()) return;
        if (!LinkDevicePermissions.check(context, deviceId, "fileaccess")) {
            refuse(dm, deviceId, transferId, "permission");
            return;
        }
        try {
            JSONArray files = packet.body.optJSONArray("files");
            if (files == null || files.length() == 0 || files.length() > MAX_FILES) {
                refuse(dm, deviceId, transferId, "invalid");
                return;
            }
            String[][] parts = new String[files.length()][];
            long[] sizes = new long[files.length()];
            long sum = 0;
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                parts[i] = cleanParts(f.optString("name", null));
                sizes[i] = f.optLong("size", -1);
                if (parts[i] == null || sizes[i] < 0) {
                    refuse(dm, deviceId, transferId, "invalid");
                    return;
                }
                sum += sizes[i];
            }
            long total = packet.body.optLong("totalSize", -1);
            if (total != sum) {
                refuse(dm, deviceId, transferId, "invalid");
                return;
            }

            long now = System.currentTimeMillis();
            for (Map.Entry<String, Incoming> e : incoming.entrySet()) {
                if (now - e.getValue().createdAt > STALE_INCOMING_MS) incoming.remove(e.getKey());
            }
            incoming.put(deviceId + "|" + transferId, new Incoming(deviceId, transferId, parts, sizes, total));

            JSONObject body = new JSONObject();
            body.put("transferId", transferId);
            body.put("accepted", true);
            reply(dm, deviceId, PACKET_ANSWER, body);
        } catch (Exception e) {
            Log.w(TAG, "Bad share offer", e);
            refuse(dm, deviceId, transferId, "invalid");
        }
    }

    private static void handleStart(Context context, LinkDeviceManager dm, String deviceId, LinkPacket packet) {
        String transferId = packet.body.optString("transferId", "");
        Incoming in = incoming.remove(deviceId + "|" + transferId);
        if (in == null || in.started || packet.payloadTransferInfo == null) return;
        in.started = true;
        int port = packet.payloadTransferInfo.optInt("port", 0);
        String host = dm.remoteAddressOf(deviceId);
        String fingerprint = dm.pinnedFingerprintOf(deviceId);
        String from = deviceName(dm, deviceId);
        new Thread(() -> receive(context, dm, in, host, port, fingerprint, from), "link-share-receive").start();
    }

    private static File linkRoot() {
        return new File(Environment.getExternalStorageDirectory(), "Link");
    }

    private static File uniqueFile(File dir, String name) {
        File dest = new File(dir, name);
        String base = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            base = name.substring(0, dot);
            ext = name.substring(dot);
        }
        int counter = 1;
        while (dest.exists()) {
            dest = new File(dir, base + " (" + counter + ")" + ext);
            counter++;
        }
        return dest;
    }

    private static void receive(Context context, LinkDeviceManager dm, Incoming in, String host, int port, String fingerprint, String from) {
        List<File> saved = new ArrayList<>();
        File[] currentPart = new File[1];
        String error = null;
        ProgressNotifier progress = new ProgressNotifier(context, in.transferId, "Receiving from " + from, in.parts.length + " file(s)", in.total);
        try {
            if (host == null || fingerprint == null || port <= 0) throw new IOException("Sender is not reachable");
            notifyTransfer(context, in.transferId, "Receiving from " + from, in.parts.length + " file(s)", in.total > 0 ? 0 : -2, null);
            LinkPayloadTransfer.downloadStream(host, port, dm.getMyCert(), dm.getMyKey(), fingerprint, stream -> {
                byte[] buffer = new byte[131072];
                long received = 0;
                for (int i = 0; i < in.parts.length; i++) {
                    String[] parts = in.parts[i];
                    File dir = linkRoot();
                    for (int p = 0; p < parts.length - 1; p++) dir = new File(dir, parts[p]);
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir.getName());
                    String fileName = parts[parts.length - 1];
                    File part = new File(dir, fileName + ".part");
                    currentPart[0] = part;
                    long remaining = in.sizes[i];
                    try (FileOutputStream out = new FileOutputStream(part)) {
                        while (remaining > 0) {
                            int n = stream.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                            if (n < 0) throw new IOException("Connection closed before all files arrived");
                            out.write(buffer, 0, n);
                            remaining -= n;
                            received += n;
                            progress.update(received);
                        }
                    }
                    File dest = uniqueFile(dir, fileName);
                    if (!part.renameTo(dest)) throw new IOException("Cannot save " + fileName);
                    currentPart[0] = null;
                    saved.add(dest);
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "Receiving files failed", e);
            error = e.getMessage() != null ? e.getMessage() : "Transfer failed";
            if (currentPart[0] != null) {
                //noinspection ResultOfMethodCallIgnored
                currentPart[0].delete();
            }
        }

        boolean ok = error == null;
        try {
            JSONObject body = new JSONObject();
            body.put("transferId", in.transferId);
            body.put("ok", ok);
            body.put("saved", saved.size());
            if (!ok) body.put("error", error);
            reply(dm, in.deviceId, PACKET_DONE, body);
        } catch (Exception ignored) {
        }

        if (!saved.isEmpty()) {
            String[] paths = new String[saved.size()];
            for (int i = 0; i < paths.length; i++) paths[i] = saved.get(i).getAbsolutePath();
            try {
                MediaScannerConnection.scanFile(context, paths, null, null);
            } catch (Exception ignored) {
            }
        }
        if (ok) {
            int n = saved.size();
            notifyTransfer(context, in.transferId, "Copied " + n + " file" + (n == 1 ? "" : "s"),
                    "From " + from + " — saved to Link folder", -1, n == 1 ? viewIntent(context, saved.get(0)) : null);
        } else {
            notifyTransfer(context, in.transferId, "Couldn't receive files", "From " + from + ": " + error, -1, null);
        }
    }

    /** Tap action for a single received file: open it in a viewer, via the app's FileProvider. */
    private static PendingIntent viewIntent(Context context, File file) {
        try {
            Uri uri = androidx.core.content.FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            String ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(file).toString());
            String mime = ext != null ? android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase()) : null;
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, mime != null ? mime : "*/*");
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            return PendingIntent.getActivity(context, file.getName().hashCode(), view, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- sending

    private static class Outgoing {
        final String deviceId;
        final CountDownLatch answered = new CountDownLatch(1);
        final CountDownLatch done = new CountDownLatch(1);
        volatile boolean accepted;
        volatile String reason = "";
        volatile boolean doneOk;
        volatile String doneError = "";
        volatile int doneSaved;

        Outgoing(String deviceId) {
            this.deviceId = deviceId;
        }
    }

    private static final Map<String, Outgoing> outgoing = new ConcurrentHashMap<>();

    /**
     * Offers the items to a connected paired device and streams them once it accepts. Runs on its
     * own thread and keeps going after the calling Activity is gone. Takes ownership of the items
     * (their descriptors and temp copies are released when the transfer ends).
     */
    public static void sendItems(Context context, String deviceId, List<Item> items) {
        Context app = context.getApplicationContext();
        new Thread(() -> send(app, deviceId, items), "link-share-send").start();
    }

    private static void send(Context context, String deviceId, List<Item> items) {
        String transferId = UUID.randomUUID().toString();
        LinkDeviceManager dm = LinkPlugin.sDeviceManager;
        Outgoing out = new Outgoing(deviceId);
        outgoing.put(transferId, out);
        String to = dm != null ? deviceName(dm, deviceId) : "device";
        String title = "Sending to " + to;
        String text = items.size() + " file" + (items.size() == 1 ? "" : "s");
        try {
            if (dm == null || !dm.hasTrustedPeer(deviceId)) throw new FailException(to + " isn't connected");
            long total = 0;
            JSONArray files = new JSONArray();
            for (Item item : items) {
                JSONObject f = new JSONObject();
                f.put("name", item.name);
                f.put("size", item.size);
                files.put(f);
                total += item.size;
            }
            JSONObject offer = new JSONObject();
            offer.put("transferId", transferId);
            offer.put("files", files);
            offer.put("totalSize", total);

            notifyTransfer(context, transferId, title, "Waiting for " + to + " to accept…", -2, null);
            reply(dm, deviceId, PACKET_OFFER, offer);

            if (!out.answered.await(ANSWER_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw new FailException(to + " didn't respond");
            if (!out.accepted) {
                if ("permission".equals(out.reason)) throw new FailException(to + " isn't allowing files from this phone");
                throw new FailException(to + " declined");
            }

            final long totalBytes = total;
            ProgressNotifier progress = new ProgressNotifier(context, transferId, title, text, totalBytes);
            List<LinkPayloadTransfer.StreamSource> sources = new ArrayList<>();
            for (Item item : items) {
                sources.add(new LinkPayloadTransfer.StreamSource() {
                    @Override public InputStream open() throws IOException { return item.open(); }
                    @Override public long size() { return item.size; }
                });
            }
            final Exception[] uploadError = new Exception[1];
            final CountDownLatch uploaded = new CountDownLatch(1);
            notifyTransfer(context, transferId, title, text, totalBytes > 0 ? 0 : -2, null);
            LinkPayloadTransfer.UploadHandle handle = LinkPayloadTransfer.startUploadStreams(
                    dm.getMyCert(), dm.getMyKey(), dm.pinnedFingerprintOf(deviceId), sources,
                    RECEIVER_CONNECT_TIMEOUT_MS, progress::update,
                    new LinkPayloadTransfer.UploadListener() {
                        @Override public void onComplete() { uploaded.countDown(); }
                        @Override public void onError(Exception e) { uploadError[0] = e; uploaded.countDown(); }
                    });
            JSONObject start = new JSONObject();
            start.put("transferId", transferId);
            LinkPacket startPacket = new LinkPacket(PACKET_START, start);
            startPacket.payloadSize = totalBytes;
            startPacket.payloadTransferInfo = new JSONObject().put("port", handle.port);
            dm.sendTo(deviceId, startPacket);

            // Wait for the bytes to leave, then for the receiver's verdict.
            uploaded.await();
            if (uploadError[0] != null) {
                Log.w(TAG, "Share upload failed", uploadError[0]);
                throw new FailException("Couldn't send to " + to);
            }
            if (!out.done.await(DONE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw new FailException(to + " didn't confirm receipt");
            if (!out.doneOk) throw new FailException("Couldn't send to " + to + (out.doneError.isEmpty() ? "" : ": " + out.doneError));

            int n = items.size();
            notifyTransfer(context, transferId, "Sent " + n + " file" + (n == 1 ? "" : "s"), "to " + to, -1, null);
        } catch (FailException e) {
            notifyTransfer(context, transferId, "Not sent", e.getMessage(), -1, null);
        } catch (Exception e) {
            Log.w(TAG, "Sending files failed", e);
            notifyTransfer(context, transferId, "Not sent", "Couldn't send to " + to, -1, null);
        } finally {
            outgoing.remove(transferId);
            for (Item item : items) item.release();
        }
    }

    private static class FailException extends Exception {
        FailException(String message) {
            super(message);
        }
    }

    // ---------------------------------------------------------------- Direct Share shortcuts

    /** Tells the system a device was just shared to, which ranks its share-sheet shortcut higher next time. */
    static void reportUsed(Context context, String deviceId) {
        try {
            androidx.core.content.pm.ShortcutManagerCompat.reportShortcutUsed(context.getApplicationContext(), SHORTCUT_PREFIX + deviceId);
        } catch (Exception ignored) {
        }
    }

    static String deviceIdFromShortcut(String shortcutId) {
        return shortcutId != null && shortcutId.startsWith(SHORTCUT_PREFIX) ? shortcutId.substring(SHORTCUT_PREFIX.length()) : null;
    }

    private static String publishedSignature = null;

    /** Publishes the share-sheet shortcuts again only when the paired devices (or their names) changed since last time. */
    public static void refreshShortcutsIfChanged(Context context, LinkDeviceManager dm) {
        StringBuilder signature = new StringBuilder();
        java.util.Map<String, String> liveTypes = knownTypes(context, dm);
        for (LinkTrustStore.TrustedDevice d : dm.getTrustStore().list()) {
            signature.append(d.deviceId).append('=').append(d.deviceName).append('=').append(typeFor(context, liveTypes, d.deviceId)).append(';');
        }
        String now = signature.toString();
        if (now.equals(publishedSignature)) return;
        publishedSignature = now;
        refreshShortcuts(context, dm);
    }

    /**
     * Publishes one share-sheet target per paired device (see res/xml/shortcuts.xml). Each shortcut is long-lived and
     * carries a Person, which is what makes the system share sheet offer it as its own "Direct Share" tile instead of
     * only the app's single row.
     */
    public static void refreshShortcuts(Context context, LinkDeviceManager dm) {
        try {
            Context app = context.getApplicationContext();
            List<androidx.core.content.pm.ShortcutInfoCompat> list = new ArrayList<>();
            int max = androidx.core.content.pm.ShortcutManagerCompat.getMaxShortcutCountPerActivity(app);
            if (max <= 0) max = 4;
            int rank = 0;
            java.util.Map<String, String> liveTypes = knownTypes(app, dm);
            for (LinkTrustStore.TrustedDevice d : dm.getTrustStore().list()) {
                if (list.size() >= max) break;
                androidx.core.graphics.drawable.IconCompat icon = deviceIcon(typeFor(app, liveTypes, d.deviceId));
                String label = (d.deviceName != null && !d.deviceName.isEmpty() ? d.deviceName : "Device") + " (Link)";
                Intent intent = new Intent(app, ShareActivity.class).setAction(Intent.ACTION_SEND);
                androidx.core.app.Person person = new androidx.core.app.Person.Builder()
                        .setName(label)
                        .setKey(SHORTCUT_PREFIX + d.deviceId)
                        .setIcon(icon)
                        .build();
                list.add(new androidx.core.content.pm.ShortcutInfoCompat.Builder(app, SHORTCUT_PREFIX + d.deviceId)
                        .setShortLabel(label)
                        .setLongLabel(label)
                        .setLongLived(true)
                        .setIsConversation()
                        .setPerson(person)
                        .setRank(rank++)
                        .setIcon(icon)
                        .setCategories(java.util.Collections.singleton(SHORTCUT_CATEGORY))
                        .setIntent(intent)
                        .build());
            }
            boolean ok = androidx.core.content.pm.ShortcutManagerCompat.setDynamicShortcuts(app, list);
            Log.i(TAG, "Published " + list.size() + " share shortcuts, accepted=" + ok);
        } catch (Exception e) {
            Log.w(TAG, "Could not publish share shortcuts", e);
        }
    }

    // ---- Device icons: each tile shows what kind of device it is (phone, laptop, tablet, TV); the system adds Link's own
    // badge in the corner. The type comes from the device when it connects, and is remembered for when it is offline.

    private static final String TYPES_PREFS = "link_share_device_types";

    private static java.util.Map<String, String> knownTypes(Context context, LinkDeviceManager dm) {
        android.content.SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(TYPES_PREFS, Context.MODE_PRIVATE);
        android.content.SharedPreferences.Editor edit = null;
        java.util.Map<String, String> live = new java.util.HashMap<>();
        for (LinkDeviceManager.ConnectedPeerInfo info : dm.connectedPeers()) {
            if (!info.trusted || info.identity == null || info.identity.deviceType == null || info.identity.deviceType.isEmpty()) continue;
            live.put(info.identity.deviceId, info.identity.deviceType);
            if (!info.identity.deviceType.equals(prefs.getString(info.identity.deviceId, null))) {
                if (edit == null) edit = prefs.edit();
                edit.putString(info.identity.deviceId, info.identity.deviceType);
            }
        }
        if (edit != null) edit.apply();
        return live;
    }

    private static String typeFor(Context context, java.util.Map<String, String> live, String deviceId) {
        String type = live.get(deviceId);
        if (type != null) return type;
        return context.getApplicationContext().getSharedPreferences(TYPES_PREFS, Context.MODE_PRIVATE).getString(deviceId, "phone");
    }

    // The same simple outline shapes as the app's own device icon (DeviceIcon.tsx), drawn on a round dark tile.
    private static androidx.core.graphics.drawable.IconCompat deviceIcon(String type) {
        final int size = 192;
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888);
        android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
        android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        paint.setColor(0xFF0F172A);
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint);

        paint.setStyle(android.graphics.Paint.Style.STROKE);
        paint.setStrokeCap(android.graphics.Paint.Cap.ROUND);
        paint.setStrokeJoin(android.graphics.Paint.Join.ROUND);
        paint.setStrokeWidth(8f);
        paint.setColor(0xFF60A5FA);
        // The shapes are laid out on a 24 x 24 grid; this maps the grid onto the middle of the tile.
        final float scale = 88f / 24f;
        final float offset = (size - 88f) / 2f;
        String t = type == null ? "phone" : type.toLowerCase(java.util.Locale.ROOT);
        if ("tablet".equals(t)) {
            canvas.drawRoundRect(box(4, 2, 20, 22, scale, offset), 3 * scale, 3 * scale, paint);
            canvas.drawPoint(offset + 12 * scale, offset + 18 * scale, paint);
        } else if ("laptop".equals(t) || "desktop".equals(t) || "pc".equals(t) || "computer".equals(t)) {
            canvas.drawRoundRect(box(2, 3, 22, 17, scale, offset), 2 * scale, 2 * scale, paint);
            canvas.drawLine(offset + 8 * scale, offset + 21 * scale, offset + 16 * scale, offset + 21 * scale, paint);
            canvas.drawLine(offset + 12 * scale, offset + 17 * scale, offset + 12 * scale, offset + 21 * scale, paint);
        } else if ("tv".equals(t)) {
            canvas.drawRoundRect(box(2, 3, 22, 17, scale, offset), 2 * scale, 2 * scale, paint);
            canvas.drawLine(offset + 10 * scale, offset + 21 * scale, offset + 14 * scale, offset + 21 * scale, paint);
        } else {
            canvas.drawRoundRect(box(5, 2, 19, 22, scale, offset), 2.5f * scale, 2.5f * scale, paint);
            canvas.drawPoint(offset + 12 * scale, offset + 18 * scale, paint);
        }
        return androidx.core.graphics.drawable.IconCompat.createWithBitmap(bitmap);
    }

    private static android.graphics.RectF box(float left, float top, float right, float bottom, float scale, float offset) {
        return new android.graphics.RectF(offset + left * scale, offset + top * scale, offset + right * scale, offset + bottom * scale);
    }
}
