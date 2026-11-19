package in.rodix.link;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Log;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

// Target of the system share sheet. Two ways in, both from the one activity:
//  - a paired device's own tile ("Shadow (Link)", a Direct Share shortcut): sends the files straight to that device;
//  - the "File Transfer (Link)" tile: opens the app's File Transfer tool with the files staged (MainActivity).
// Transparent: it opens the files and hands them to LinkShare, which carries on after this Activity is gone. The files are
// opened here, while the share sheet's URI grant is still valid.
public class ShareActivity extends Activity {
    private static final String TAG = "ShareActivity";
    private static final int MAX_FILES = 500;

    /** Sent to MainActivity with the shared files as ClipData; see MainActivity.handleSharedFiles. */
    static final String ACTION_SHARED_FILES = "in.rodix.link.action.SHARED_FILES";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        List<Uri> uris = collectUris(getIntent());
        if (uris.isEmpty()) {
            toast("Nothing to send — Link shares files, not text");
            finish();
            return;
        }

        // Direct Share: the tapped device's own tile ("Shadow (Link)"). The files go straight to that device.
        String targetId = LinkShare.deviceIdFromShortcut(getIntent().getStringExtra(Intent.EXTRA_SHORTCUT_ID));
        if (targetId != null) {
            LinkDeviceManager dm = LinkPlugin.sDeviceManager;
            if (dm == null) {
                toast("Open Link first, then share again");
                finish();
            } else if (dm.hasTrustedPeer(targetId)) {
                begin(uris, targetId);
            } else {
                LinkTrustStore.TrustedDevice d = dm.getTrustStore().get(targetId);
                toast((d != null ? d.deviceName : "That device") + " isn't connected");
                finish();
            }
            return;
        }

        // The "File Transfer (Link)" tile: continue in the app's own File Transfer tool, with these files staged
        // exactly as if they had been picked there. The grant on the files travels with the ClipData.
        List<Uri> chosen = uris.size() > MAX_FILES ? uris.subList(0, MAX_FILES) : uris;
        ClipData clip = ClipData.newRawUri("shared files", chosen.get(0));
        for (int i = 1; i < chosen.size(); i++) clip.addItem(new ClipData.Item(chosen.get(i)));
        Intent open = new Intent(this, MainActivity.class).setAction(ACTION_SHARED_FILES);
        open.setClipData(clip);
        open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(open);
        finish();
    }

    private void toast(String text) {
        Toast.makeText(getApplicationContext(), text, Toast.LENGTH_SHORT).show();
    }

    static List<Uri> collectUris(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (intent == null) return uris;
        try {
            if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            } else {
                Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (one != null) uris.add(one);
            }
            if (uris.isEmpty()) {
                ClipData clip = intent.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        Uri u = clip.getItemAt(i).getUri();
                        if (u != null) uris.add(u);
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read shared items", e);
        }
        return uris;
    }

    private void begin(List<Uri> uris, String deviceId) {
        new Thread(() -> {
            List<LinkShare.Item> items = new ArrayList<>();
            List<Uri> chosen = uris.size() > MAX_FILES ? uris.subList(0, MAX_FILES) : uris;
            if (uris.size() > MAX_FILES) runOnUiThread(() -> toast("Sending the first " + MAX_FILES + " files"));
            for (Uri uri : chosen) {
                try {
                    LinkShare.Item item = open(uri);
                    if (item != null) items.add(item);
                } catch (Exception e) {
                    Log.w(TAG, "Skipping unreadable item " + uri, e);
                }
            }
            if (items.isEmpty()) {
                runOnUiThread(() -> toast("Couldn't read the shared files"));
            } else {
                LinkShare.sendItems(getApplicationContext(), deviceId, items);
                // Tells the system this device was just used, so it climbs the share sheet's own device row over time.
                LinkShare.reportUsed(getApplicationContext(), deviceId);
            }
            runOnUiThread(() -> {
                finish();
                overridePendingTransition(0, 0);
            });
        }, "link-share-prepare").start();
    }

    private LinkShare.Item open(Uri uri) throws Exception {
        ContentResolver resolver = getContentResolver();
        String name = null;
        long columnSize = -1;
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int s = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n);
                if (s >= 0 && !cursor.isNull(s)) columnSize = cursor.getLong(s);
            }
        } catch (Exception ignored) {
        }
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        name = safeName(name);

        ParcelFileDescriptor pfd = null;
        try {
            pfd = resolver.openFileDescriptor(uri, "r");
        } catch (Exception ignored) {
        }
        if (pfd != null) {
            long size = pfd.getStatSize();
            boolean trustworthy = size > 0 || (size == 0 && columnSize <= 0);
            if (trustworthy) return new LinkShare.Item(name, size, pfd, null);
            try { pfd.close(); } catch (Exception ignored) { }
        }

        // Size unknown (a pipe or virtual file): copy it to the cache to learn the real length.
        File dir = new File(getCacheDir(), "share-out");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File copy = new File(dir, UUID.randomUUID().toString());
        long total = 0;
        try (InputStream in = resolver.openInputStream(uri); FileOutputStream out = new FileOutputStream(copy)) {
            if (in == null) return null;
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) != -1) {
                out.write(buffer, 0, n);
                total += n;
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            copy.delete();
            throw e;
        }
        return new LinkShare.Item(name, total, null, copy);
    }

    // The receiver rejects names with separators or odd characters, so flatten them here.
    private static String safeName(String raw) {
        if (raw == null) return "file";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            sb.append(c < 0x20 || c == 0x7f || c == '/' || c == '\\' || c == ':' ? '_' : c);
        }
        String name = sb.toString().trim();
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) return "file";
        return name.length() > 200 ? name.substring(name.length() - 200) : name;
    }
}
