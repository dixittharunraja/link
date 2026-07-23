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

        public TrustedDevice(String deviceId, String deviceName, byte[] certDer, int protocolVersion, long pairedAt) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.certDer = certDer;
            this.protocolVersion = protocolVersion;
            this.pairedAt = pairedAt;
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
                            obj.optLong("pairedAt", 0)));
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
                dev.pairedAt
            ));
            persist();
        }
    }
}
