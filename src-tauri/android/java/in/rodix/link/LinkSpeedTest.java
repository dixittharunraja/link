package in.rodix.link;

import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class LinkSpeedTest {
    public interface Listener {
        void onProgress(String message);
        void onComplete(int latencyMs, double uploadSpeedMbps, double downloadSpeedMbps);
        void onError(String error);
    }

    private static class ActiveTest {
        final String deviceId;
        final Listener listener;
        String step = "ping";
        long startTime = 0;
        final List<Integer> pings = new ArrayList<>();
        long uploadStart = 0;
        long downloadStart = 0;
        double uploadSpeedMbps = 0.0;
        static final int PAYLOAD_MB = 20; // size of each bulk transfer

        ActiveTest(String deviceId, Listener listener) {
            this.deviceId = deviceId;
            this.listener = listener;
        }
    }

    // The most a peer may ask this side to send, or send to it, in one leg (it asks PAYLOAD_MB).
    // Matches MAX_PAYLOAD_MB in core/speedtest.rs.
    private static final int MAX_PAYLOAD_MB = 64;
    // How long the peer has to connect to a payload this side offers.
    private static final long ACCEPT_TIMEOUT_MS = 60000;

    /** `size` zero bytes, produced as they are read rather than held in memory. */
    private static LinkPayloadTransfer.StreamSource zeros(long size) {
        return new LinkPayloadTransfer.StreamSource() {
            @Override public java.io.InputStream open() {
                return new java.io.InputStream() {
                    private long remaining = size;
                    @Override public int read() {
                        if (remaining <= 0) return -1;
                        remaining--;
                        return 0;
                    }
                    @Override public int read(byte[] b, int off, int len) {
                        if (remaining <= 0) return -1;
                        int n = (int) Math.min(len, remaining);
                        java.util.Arrays.fill(b, off, off + n, (byte) 0);
                        remaining -= n;
                        return n;
                    }
                };
            }
            @Override public long size() { return size; }
        };
    }

    /** Pulls a payload from the peer and counts it, never keeping it; stops past the cap. */
    private long countPayload(String host, int port, String fingerprint) throws Exception {
        final long[] total = {0};
        final long cap = (long) MAX_PAYLOAD_MB * 1024 * 1024;
        LinkPayloadTransfer.downloadStream(host, port, deviceManager.getMyCert(), deviceManager.getMyKey(), fingerprint, stream -> {
            byte[] chunk = new byte[131072];
            int n;
            while ((n = stream.read(chunk)) != -1) {
                total[0] += n;
                if (total[0] > cap) throw new java.io.IOException("The payload was larger than a speed test sends");
            }
        });
        return total[0];
    }

    private final LinkDeviceManager deviceManager;
    private final Map<String, ActiveTest> activeTests = new HashMap<>();

    public LinkSpeedTest(LinkDeviceManager deviceManager) {
        this.deviceManager = deviceManager;
    }

    /**
     * Answers a link.speedtest.request from a peer that started a test. Bulk data always goes
     * over the binary payload channel (LinkPayloadTransfer) so real transfer time is measured.
     * Matches answer_speed_test() in core/speedtest.rs.
     */
    public void handleIncomingRequest(LinkPacket packet, String fromDeviceId) {
        try {
            JSONObject body = packet.body;
            if (!body.has("testId")) return;
            String testId = body.getString("testId");
            String step = body.getString("step");

            if ("ping".equals(step)) {
                JSONObject respBody = new JSONObject();
                respBody.put("testId", testId);
                respBody.put("step", "ping");
                deviceManager.sendTo(fromDeviceId, new LinkPacket("link.speedtest.response", respBody));
            } else if ("upload".equals(step)) {
                JSONObject pti = packet.payloadTransferInfo;
                if (pti == null) return; // nothing to measure without a payload
                new Thread(() -> {
                    try {
                        String host = deviceManager.remoteAddressOf(fromDeviceId);
                        String fingerprint = deviceManager.pinnedFingerprintOf(fromDeviceId);
                        if (host == null || fingerprint == null) return;
                        int port = pti.getInt("port");
                        long received = countPayload(host, port, fingerprint);
                        // Report the bytes actually received rather than the requested size.
                        JSONObject respBody = new JSONObject();
                        respBody.put("testId", testId);
                        respBody.put("step", "upload");
                        respBody.put("payloadMb", received / (1024.0 * 1024.0));
                        deviceManager.sendTo(fromDeviceId, new LinkPacket("link.speedtest.response", respBody));
                    } catch (Exception e) {
                        android.util.Log.e("LinkSpeedTest", "Failed to receive upload payload", e);
                    }
                }, "link-speedtest-upload-responder").start();
            } else if ("download".equals(step)) {
                // The size is the peer's to choose, within reason; the bytes are streamed, not allocated.
                int mb = Math.max(1, Math.min(MAX_PAYLOAD_MB, body.optInt("payloadMb", ActiveTest.PAYLOAD_MB)));
                int bytes = mb * 1024 * 1024;
                try {
                    LinkPayloadTransfer.UploadHandle upload = LinkPayloadTransfer.startUploadStreams(
                            deviceManager.getMyCert(), deviceManager.getMyKey(),
                            deviceManager.pinnedFingerprintOf(fromDeviceId),
                            java.util.Collections.singletonList(zeros(bytes)), ACCEPT_TIMEOUT_MS, null,
                            new LinkPayloadTransfer.UploadListener() {
                                @Override public void onComplete() { }
                                @Override public void onError(Exception e) {
                                    android.util.Log.e("LinkSpeedTest", "Failed to send download payload", e);
                                }
                            });
                    JSONObject respBody = new JSONObject();
                    respBody.put("testId", testId);
                    respBody.put("step", "download");
                    respBody.put("payloadMb", mb);
                    LinkPacket resp = new LinkPacket("link.speedtest.response", respBody);
                    resp.payloadSize = (long) bytes;
                    resp.payloadTransferInfo = new JSONObject();
                    resp.payloadTransferInfo.put("port", upload.port);
                    deviceManager.sendTo(fromDeviceId, resp);
                } catch (Exception e) {
                    android.util.Log.e("LinkSpeedTest", "Failed to start download payload server", e);
                }
            }
        } catch (Exception e) {
            android.util.Log.e("LinkSpeedTest", "Failed to handle incoming speed test request", e);
        }
    }

    public synchronized void startTest(String deviceId, Listener listener) {
        String testId = "st-" + System.currentTimeMillis();
        ActiveTest test = new ActiveTest(deviceId, listener);
        activeTests.put(testId, test);

        listener.onProgress("Starting latency test...");
        sendPing(testId);
    }

    private void sendPing(String testId) {
        ActiveTest test = activeTests.get(testId);
        if (test == null) return;

        test.startTime = System.currentTimeMillis();
        try {
            JSONObject body = new JSONObject();
            body.put("testId", testId);
            body.put("step", "ping");
            deviceManager.sendTo(test.deviceId, new LinkPacket("link.speedtest.request", body));
        } catch (Exception e) {
            test.listener.onError(e.getMessage());
            activeTests.remove(testId);
        }
    }

    private void startUpload(String testId) {
        ActiveTest test = activeTests.get(testId);
        if (test == null) return;

        test.step = "upload";
        test.listener.onProgress("Measuring upload speed (sending 20MB data)...");

        // Zero-filled payload sent over the binary payload channel, produced as it is sent.
        final int payloadBytes = ActiveTest.PAYLOAD_MB * 1024 * 1024;

        test.uploadStart = System.currentTimeMillis();
        try {
            // Start the upload server off this thread, then tell the peer where to connect.
            new Thread(() -> {
                try {
                    LinkPayloadTransfer.UploadHandle upload = LinkPayloadTransfer.startUploadStreams(
                            deviceManager.getMyCert(),
                            deviceManager.getMyKey(),
                            deviceManager.pinnedFingerprintOf(test.deviceId),
                            java.util.Collections.singletonList(zeros(payloadBytes)),
                            ACCEPT_TIMEOUT_MS,
                            null,
                            new LinkPayloadTransfer.UploadListener() {
                                @Override public void onComplete() { }
                                @Override public void onError(Exception e) {
                                    synchronized (LinkSpeedTest.this) {
                                        ActiveTest t = activeTests.get(testId);
                                        if (t != null) t.listener.onError(e.getMessage());
                                        activeTests.remove(testId);
                                    }
                                }
                            });
                    JSONObject body = new JSONObject();
                    body.put("testId", testId);
                    body.put("step", "upload");
                    body.put("payloadMb", ActiveTest.PAYLOAD_MB);
                    LinkPacket packet = new LinkPacket("link.speedtest.request", body);
                    packet.payloadSize = (long) payloadBytes;
                    packet.payloadTransferInfo = new JSONObject();
                    packet.payloadTransferInfo.put("port", upload.port);
                    deviceManager.sendTo(test.deviceId, packet);
                } catch (Exception e) {
                    synchronized (LinkSpeedTest.this) {
                        ActiveTest t = activeTests.get(testId);
                        if (t != null) t.listener.onError(e.getMessage());
                        activeTests.remove(testId);
                    }
                }
            }, "link-speedtest-upload").start();
        } catch (Exception e) {
            test.listener.onError(e.getMessage());
            activeTests.remove(testId);
        }
    }

    private void startDownload(String testId) {
        ActiveTest test = activeTests.get(testId);
        if (test == null) return;

        test.step = "download";
        test.listener.onProgress("Measuring download speed (receiving 20MB data)...");

        test.downloadStart = System.currentTimeMillis();
        try {
            JSONObject body = new JSONObject();
            body.put("testId", testId);
            body.put("step", "download");
            body.put("payloadMb", ActiveTest.PAYLOAD_MB);
            deviceManager.sendTo(test.deviceId, new LinkPacket("link.speedtest.request", body));
        } catch (Exception e) {
            test.listener.onError(e.getMessage());
            activeTests.remove(testId);
        }
    }

    public synchronized void handleResponse(LinkPacket packet) {
        try {
            JSONObject body = packet.body;
            if (!body.has("testId")) return;
            String testId = body.getString("testId");
            String step = body.getString("step");

            ActiveTest test = activeTests.get(testId);
            if (test == null) return;

            if ("ping".equals(step)) {
                int rtt = (int) (System.currentTimeMillis() - test.startTime);
                test.pings.add(rtt);

                if (test.pings.size() < 5) {
                    sendPing(testId);
                } else {
                    double avgPing = 0;
                    for (int p : test.pings) avgPing += p;
                    avgPing /= test.pings.size();
                    test.startTime = (long) avgPing;
                    startUpload(testId);
                }
            } else if ("upload".equals(step)) {
                double durationSec = (System.currentTimeMillis() - test.uploadStart) / 1000.0;
                // The responder reports the received size in fractional megabytes.
                double mb = body.optDouble("payloadMb", ActiveTest.PAYLOAD_MB);
                test.uploadSpeedMbps = (mb * 8.0) / durationSec;
                startDownload(testId);
            } else if ("download".equals(step)) {
                // The peer offers the data on the payload channel; the timer started when the
                // request was sent, so the measured time covers the full round trip.
                if (packet.payloadTransferInfo != null) {
                    final ActiveTest finalTest = test;
                    final String finalTestId = testId;
                    new Thread(() -> {
                        try {
                            String host = deviceManager.remoteAddressOf(finalTest.deviceId);
                            int port = packet.payloadTransferInfo.getInt("port");
                            String fingerprint = deviceManager.pinnedFingerprintOf(finalTest.deviceId);
                            long received = countPayload(host, port, fingerprint);
                            double durationSec = (System.currentTimeMillis() - finalTest.downloadStart) / 1000.0;
                            double mb = received / (1024.0 * 1024.0);
                            double downloadSpeedMbps = (mb * 8.0) / durationSec;
                            synchronized (LinkSpeedTest.this) {
                                finalTest.listener.onComplete((int) finalTest.startTime, finalTest.uploadSpeedMbps, downloadSpeedMbps);
                                activeTests.remove(finalTestId);
                            }
                        } catch (Exception e) {
                            synchronized (LinkSpeedTest.this) {
                                ActiveTest t = activeTests.get(finalTestId);
                                if (t != null) t.listener.onError(e.getMessage());
                                activeTests.remove(finalTestId);
                            }
                        }
                    }, "link-speedtest-download").start();
                } else {
                    // Every responder offers the payload; as on desktop, a response without it
                    // cannot measure a real transfer.
                    test.listener.onError("Download response missing payloadTransferInfo");
                    activeTests.remove(testId);
                }
            }
        } catch (Exception e) {
            android.util.Log.e("LinkSpeedTest", "Failed to parse speedtest response", e);
        }
    }
}
