package in.rodix.link;

// Trust store: persists paired devices and their pinned certificates. Java counterpart of
// core/trust.rs.
//
// Several instances may be open on the same file (the device manager keeps one, other code opens
// its own), so each instance re-reads the file when it changed on disk since it last looked: a
// cheap check (modification time and length) instead of parsing the file on every lookup. Writes
// replace the file whole (temp file, then rename), so an interrupted write cannot lose every pairing.

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.HashMap;
import java.util.Map;

public class LinkTrustStore {
    public static class TrustedDevice {
        public final String deviceId;
        public final String deviceName;
        public final byte[] certDer;
        public final long pairedAt;
        public String lastKnownIp;
        /** The device's Tailscale address, learned while connected; used to reach it away from the LAN. */
        public String tailscaleIp;

        public TrustedDevice(String deviceId, String deviceName, byte[] certDer, long pairedAt) {
            this(deviceId, deviceName, certDer, pairedAt, null);
        }

        public TrustedDevice(String deviceId, String deviceName, byte[] certDer, long pairedAt, String lastKnownIp) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.certDer = certDer;
            this.pairedAt = pairedAt;
            this.lastKnownIp = lastKnownIp;
        }

        public X509Certificate certificate() throws Exception {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            return (X509Certificate) cf.generateCertificate(new java.io.ByteArrayInputStream(certDer));
        }
    }

    private final File file;
    private final Map<String, TrustedDevice> devices = new HashMap<>();
    // What the file looked like when this instance last read or wrote it.
    private long loadedModified = -1;
    private long loadedLength = -1;
    // computePoolHash() runs on every heartbeat; it only changes with the device list.
    private String cachedPoolHash;

    private static LinkTrustStore instance;

    /** One shared, already-parsed store per process; all methods are synchronized. */
    public static synchronized LinkTrustStore getInstance(Context context) {
        if (instance == null) instance = new LinkTrustStore(context.getApplicationContext());
        return instance;
    }

    public LinkTrustStore(Context context) {
        file = new File(context.getFilesDir(), "link-config/trusted-devices.json");
        load();
    }

    private void load() {
        long modified = file.lastModified();
        long length = file.length();
        try {
            if (file.exists()) {
                String raw = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
                JSONArray arr = new JSONArray(raw);
                Map<String, TrustedDevice> parsed = new HashMap<>();
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject obj = arr.getJSONObject(i);
                    String deviceId = obj.getString("deviceId");
                    byte[] certDer = android.util.Base64.decode(obj.getString("certDer"), android.util.Base64.DEFAULT);
                    TrustedDevice loaded = new TrustedDevice(
                            deviceId,
                            obj.getString("deviceName"),
                            certDer,
                            obj.optLong("pairedAt", 0),
                            obj.optString("lastKnownIp", null));
                    loaded.tailscaleIp = obj.optString("tailscaleIp", null);
                    parsed.put(deviceId, loaded);
                }
                devices.clear();
                devices.putAll(parsed);
            } else {
                devices.clear();
            }
        } catch (Exception e) {
            // Corrupt file: keep what this instance already had (empty on first load).
        }
        loadedModified = modified;
        loadedLength = length;
        cachedPoolHash = null;
    }

    /** Picks up a write made through another instance since this one last looked. */
    private void refreshIfChanged() {
        if (file.lastModified() != loadedModified || file.length() != loadedLength) {
            load();
        }
    }

    private void persist() {
        cachedPoolHash = null;
        try {
            file.getParentFile().mkdirs();
            JSONArray arr = new JSONArray();
            for (TrustedDevice d : devices.values()) {
                JSONObject obj = new JSONObject();
                obj.put("deviceId", d.deviceId);
                obj.put("deviceName", d.deviceName);
                obj.put("certDer", android.util.Base64.encodeToString(d.certDer, android.util.Base64.DEFAULT));
                obj.put("pairedAt", d.pairedAt);
                if (d.lastKnownIp != null) obj.put("lastKnownIp", d.lastKnownIp);
                if (d.tailscaleIp != null) obj.put("tailscaleIp", d.tailscaleIp);
                arr.put(obj);
            }
            // Written beside the real file and renamed over it, so a crash mid-write leaves the old list.
            File tmp = new File(file.getParentFile(), file.getName() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(arr.toString(2).getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (!tmp.renameTo(file)) {
                tmp.delete();
                throw new java.io.IOException("rename failed");
            }
            loadedModified = file.lastModified();
            loadedLength = file.length();
        } catch (Exception e) {
            throw new RuntimeException("Failed to persist trust store", e);
        }
    }

    public synchronized boolean isPaired(String deviceId) {
        refreshIfChanged();
        return devices.containsKey(deviceId);
    }

    public synchronized TrustedDevice get(String deviceId) {
        refreshIfChanged();
        return devices.get(deviceId);
    }

    public synchronized void pair(TrustedDevice device) {
        refreshIfChanged();
        // Pairing it again lifts the removal, and is newer than it even when the clocks disagree.
        java.util.Map<String, Long> removals = loadRemovals();
        Long removedAt = removals.remove(device.deviceId);
        if (removedAt != null) {
            saveRemovals(removals);
            if (device.pairedAt <= removedAt) {
                TrustedDevice bumped = new TrustedDevice(device.deviceId, device.deviceName, device.certDer,
                        removedAt + 1, device.lastKnownIp);
                bumped.tailscaleIp = device.tailscaleIp;
                device = bumped;
            }
        }
        devices.put(device.deviceId, device);
        persist();
    }

    // Removals, as device id -> when (ms). Pool membership is a last-writer-wins set: a device is in the
    // pool when its pairing is newer than its removal. A removal is kept (and passed on in pool lists)
    // so a member that was offline when it happened cannot bring the device back (core/trust.rs).
    private File removedFile() {
        return new File(file.getParentFile(), "removed-devices.json");
    }

    private java.util.Map<String, Long> loadRemovals() {
        java.util.Map<String, Long> out = new HashMap<>();
        try {
            File f = removedFile();
            if (f.exists()) {
                JSONArray arr = new JSONArray(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.getJSONObject(i);
                    out.put(o.getString("deviceId"), o.getLong("removedAt"));
                }
            }
        } catch (Exception ignored) {}
        return out;
    }

    private void saveRemovals(java.util.Map<String, Long> removals) {
        try {
            file.getParentFile().mkdirs();
            JSONArray arr = new JSONArray();
            for (java.util.Map.Entry<String, Long> e : removals.entrySet()) {
                arr.put(new JSONObject().put("deviceId", e.getKey()).put("removedAt", e.getValue()));
            }
            File tmp = new File(file.getParentFile(), "removed-devices.json.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(arr.toString().getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (!tmp.renameTo(removedFile())) tmp.delete();
        } catch (Exception ignored) {}
    }

    /** When this device was removed from the pool, or null. */
    public synchronized Long removedAt(String deviceId) {
        return loadRemovals().get(deviceId);
    }

    /** Every removal this device knows of, for pool lists. */
    public synchronized java.util.Map<String, Long> removals() {
        return loadRemovals();
    }

    /** Records that deviceId was removed at `at` and drops it if its pairing is not newer. Returns whether
     *  anything changed, so a removal is only passed on once. */
    public synchronized boolean removeDevice(String deviceId, long at) {
        refreshIfChanged();
        boolean changed = false;
        java.util.Map<String, Long> removals = loadRemovals();
        Long known = removals.get(deviceId);
        if (known == null || known < at) {
            removals.put(deviceId, at);
            saveRemovals(removals);
            changed = true;
        }
        TrustedDevice dev = devices.get(deviceId);
        if (dev != null && dev.pairedAt <= at) {
            devices.remove(deviceId);
            persist();
            changed = true;
        }
        return changed;
    }

    /** Removes trust for a device. Both sides of an unpair call this. */
    public synchronized void unpair(String deviceId) {
        refreshIfChanged();
        devices.remove(deviceId);
        persist();
    }

    /** The paired device whose certificate carries this public key (SubjectPublicKeyInfo), or null.
     *  Guest servers only see the connecting key; a match means the device is already paired. */
    public TrustedDevice findByPublicKey(byte[] publicKeyDer) {
        if (publicKeyDer == null) return null;
        for (TrustedDevice device : list()) {
            try {
                if (java.util.Arrays.equals(device.certificate().getPublicKey().getEncoded(), publicKeyDer)) return device;
            } catch (Exception ignored) {}
        }
        return null;
    }

    /** A snapshot of the paired devices, safe to iterate while the store changes. */
    public synchronized java.util.Collection<TrustedDevice> list() {
        refreshIfChanged();
        return new java.util.ArrayList<>(devices.values());
    }

    public synchronized void rename(String deviceId, String newName) {
        refreshIfChanged();
        TrustedDevice dev = devices.get(deviceId);
        if (dev != null) {
            TrustedDevice renamed = new TrustedDevice(
                dev.deviceId,
                newName,
                dev.certDer,
                dev.pairedAt,
                dev.lastKnownIp
            );
            renamed.tailscaleIp = dev.tailscaleIp;
            devices.put(deviceId, renamed);
            persist();
        }
    }

    /** Records a paired device's Tailscale address. */
    public synchronized void updateTailscaleIp(String deviceId, String ip) {
        refreshIfChanged();
        TrustedDevice dev = devices.get(deviceId);
        if (dev != null && LinkTailscale.isTailscaleAddr(ip) && !ip.equals(dev.tailscaleIp)) {
            dev.tailscaleIp = ip;
            persist();
        }
    }

    public synchronized void updateLastKnownIp(String deviceId, String ip) {
        // The LAN address is what is remembered here; an address through Tailscale is kept apart.
        if (LinkTailscale.isTailscaleAddr(ip)) {
            updateTailscaleIp(deviceId, ip);
            return;
        }
        refreshIfChanged();
        TrustedDevice dev = devices.get(deviceId);
        if (dev != null && (dev.lastKnownIp == null || !dev.lastKnownIp.equals(ip))) {
            dev.lastKnownIp = ip;
            persist();
        }
    }

    public synchronized String computePoolHash() {
        refreshIfChanged();
        if (cachedPoolHash != null) return cachedPoolHash;
        java.util.List<TrustedDevice> list = new java.util.ArrayList<>(devices.values());
        list.sort((a, b) -> a.deviceId.compareTo(b.deviceId));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            TrustedDevice d = list.get(i);
            if (i > 0) sb.append("|");
            sb.append(d.deviceId).append(":");
            try {
                sb.append(LinkTls.fingerprint(d.certificate()));
            } catch (Exception e) {
                sb.append("unknown");
            }
        }
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            cachedPoolHash = hexString.substring(0, Math.min(16, hexString.length()));
            return cachedPoolHash;
        } catch (Exception e) {
            return "";
        }
    }
}

