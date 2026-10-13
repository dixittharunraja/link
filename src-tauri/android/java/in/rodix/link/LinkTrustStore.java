package in.rodix.link;

// Trust store — persists which devices are paired and their pinned certificates.
// Java port of desktop/src/core/trust.ts.

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
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
        public final int protocolVersion;
        public final long pairedAt;
        public String lastKnownIp;

        public TrustedDevice(String deviceId, String deviceName, byte[] certDer, int protocolVersion, long pairedAt) {
            this(deviceId, deviceName, certDer, protocolVersion, pairedAt, null);
        }

        public TrustedDevice(String deviceId, String deviceName, byte[] certDer, int protocolVersion, long pairedAt, String lastKnownIp) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.certDer = certDer;
            this.protocolVersion = protocolVersion;
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

    public LinkTrustStore(Context context) {
        file = new File(context.getFilesDir(), "link-config/trusted-devices.json");
        load();
    }

    private void load() {
        try {
            if (file.exists()) {
                String raw = new String(Files.readAllBytes(file.toPath()));
                JSONArray arr = new JSONArray(raw);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject obj = arr.getJSONObject(i);
                    String deviceId = obj.getString("deviceId");
                    byte[] certDer = android.util.Base64.decode(obj.getString("certDer"), android.util.Base64.DEFAULT);
                    devices.put(deviceId, new TrustedDevice(
                            deviceId,
                            obj.getString("deviceName"),
                            certDer,
                            obj.optInt("protocolVersion", 1),
                            obj.optLong("pairedAt", 0),
                            obj.optString("lastKnownIp", null)));
                }
            }
        } catch (Exception e) {
            // Corrupt file — start fresh rather than crash.
        }
    }

    private void persist() {
        try {
            file.getParentFile().mkdirs();
            JSONArray arr = new JSONArray();
            for (TrustedDevice d : devices.values()) {
                JSONObject obj = new JSONObject();
                obj.put("deviceId", d.deviceId);
                obj.put("deviceName", d.deviceName);
                obj.put("certDer", android.util.Base64.encodeToString(d.certDer, android.util.Base64.DEFAULT));
                obj.put("protocolVersion", d.protocolVersion);
                obj.put("pairedAt", d.pairedAt);
                if (d.lastKnownIp != null) obj.put("lastKnownIp", d.lastKnownIp);
                arr.put(obj);
            }
            try (FileWriter writer = new FileWriter(file)) {
                writer.write(arr.toString(2));
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to persist trust store", e);
        }
    }

    public boolean isPaired(String deviceId) {
        return devices.containsKey(deviceId);
    }

    public TrustedDevice get(String deviceId) {
        return devices.get(deviceId);
    }

    public void pair(TrustedDevice device) {
        devices.put(device.deviceId, device);
        persist();
    }

    /** Removes trust for a device. Must be called on BOTH the initiating and receiving side of an unpair. */
    public void unpair(String deviceId) {
        devices.remove(deviceId);
        persist();
    }

    /** The paired device whose certificate carries this public key (SubjectPublicKeyInfo), or null.
     *  Guest servers see only the key of whoever connects; a match means it was already vouched for. */
    public TrustedDevice findByPublicKey(byte[] publicKeyDer) {
        if (publicKeyDer == null) return null;
        for (TrustedDevice device : list()) {
            try {
                if (java.util.Arrays.equals(device.certificate().getPublicKey().getEncoded(), publicKeyDer)) return device;
            } catch (Exception ignored) {}
        }
        return null;
    }

    public java.util.Collection<TrustedDevice> list() {
        return devices.values();
    }

    public void rename(String deviceId, String newName) {
        TrustedDevice dev = devices.get(deviceId);
        if (dev != null) {
            devices.put(deviceId, new TrustedDevice(
                dev.deviceId,
                newName,
                dev.certDer,
                dev.protocolVersion,
                dev.pairedAt,
                dev.lastKnownIp
            ));
            persist();
        }
    }

    public void updateLastKnownIp(String deviceId, String ip) {
        TrustedDevice dev = devices.get(deviceId);
        if (dev != null && (dev.lastKnownIp == null || !dev.lastKnownIp.equals(ip))) {
            dev.lastKnownIp = ip;
            persist();
        }
    }

    public String computePoolHash() {
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
            return hexString.substring(0, Math.min(16, hexString.length()));
        } catch (Exception e) {
            return "";
        }
    }
}

