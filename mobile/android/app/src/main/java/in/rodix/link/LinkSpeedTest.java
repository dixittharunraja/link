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
        // Number of MB for bulk transfer tests
        static final int PAYLOAD_MB = 20;

        ActiveTest(String deviceId, Listener listener) {
            this.deviceId = deviceId;
            this.listener = listener;
        }
    }

    private final LinkDeviceManager deviceManager;
    private final Map<String, ActiveTest> activeTests = new HashMap<>();

    public LinkSpeedTest(LinkDeviceManager deviceManager) {
        this.deviceManager = deviceManager;
    }

    /**
     * Handles an incoming link.speedtest.request when we are the RESPONDER (the peer initiated
     * the test against us). This previously lived as a separate, stale inline handler in
     * LinkPlugin.java from before the binary payload-channel mechanism existed — it ACKed
     * "upload" requests instantly without ever touching the payload channel, and answered
     * "download" with a hardcoded 5MB string embedded directly in JSON. Whichever side received
     * a request through that dead code got an instant fake success response, producing
     * impossibly large computed speeds (e.g. tens of Gbps over WiFi) since the reported duration
     * was just a JSON round-trip, not a real transfer. Rebuilt here to use the same real binary
     * channel (LinkPayloadTransfer) the initiator side already uses, matching the desktop's
     * SpeedTestManager.handleIncomingRequest.
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
                if (pti == null) return; // no legacy no-payload fallback — always measure real bytes
                new Thread(() -> {
                    try {
                        String host = deviceManager.remoteAddressOf(fromDeviceId);
                        String fingerprint = deviceManager.pinnedFingerprintOf(fromDeviceId);
                        if (host == null || fingerprint == null) return;
                        int port = pti.getInt("port");
                        byte[] data = LinkPayloadTransfer.downloadPayload(
                                host, port, deviceManager.getMyCert(), deviceManager.getMyKey(), fingerprint);
                        // ACK with the REAL number of bytes received, not the nominally requested
                        // size — so the initiator's computed speed reflects what was actually
                        // transferred, not an assumption.
                        JSONObject respBody = new JSONObject();
                        respBody.put("testId", testId);
                        respBody.put("step", "upload");
                        respBody.put("payloadMb", data.length / (1024.0 * 1024.0));
                        deviceManager.sendTo(fromDeviceId, new LinkPacket("link.speedtest.response", respBody));
                    } catch (Exception e) {
                        android.util.Log.e("LinkSpeedTest", "Failed to receive upload payload", e);
                    }
                }, "link-speedtest-upload-responder").start();
            } else if ("download".equals(step)) {
                int mb = body.optInt("payloadMb", ActiveTest.PAYLOAD_MB);
                int bytes = mb * 1024 * 1024;
                byte[] payload = new byte[bytes];
                try {
                    LinkPayloadTransfer.UploadHandle upload = LinkPayloadTransfer.startUpload(
                            deviceManager.getMyCert(), deviceManager.getMyKey(), payload,
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

        // Build payload as a raw zero-filled byte array — no StringBuilder, no JSON embedding.
        // The bulk bytes travel through the binary payloadTransferInfo channel, not the JSON channel.
        final int payloadBytes = ActiveTest.PAYLOAD_MB * 1024 * 1024;
        final byte[] payload = new byte[payloadBytes]; // zero-filled by JVM

        test.uploadStart = System.currentTimeMillis();
        try {
            // Fire off the TLS upload server on a background thread, then tell the peer to connect.
            new Thread(() -> {
                try {
                    LinkPayloadTransfer.UploadHandle upload = LinkPayloadTransfer.startUpload(
                            deviceManager.getMyCert(),
                            deviceManager.getMyKey(),
                            payload,
                            new LinkPayloadTransfer.UploadListener() {
                                @Override public void onComplete() { /* upload finished */ }
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
                int mb = body.optInt("payloadMb", 5);
                test.uploadSpeedMbps = (mb * 8.0) / durationSec;
                startDownload(testId);
            } else if ("download".equals(step)) {
                // Download: we receive binary data via the payload channel.
                // Desktop signals completion via this JSON ack; by the time we get it, the
                // payload connection is already finished — but we started our timer when we
                // sent the request, so we use the wall-clock time for the full round-trip.
                if (packet.payloadTransferInfo != null) {
                    // Receive the binary payload to measure download speed.
                    final ActiveTest finalTest = test;
                    final String finalTestId = testId;
                    new Thread(() -> {
                        try {
                            String host = deviceManager.remoteAddressOf(finalTest.deviceId);
                            int port = packet.payloadTransferInfo.getInt("port");
                            String fingerprint = deviceManager.pinnedFingerprintOf(finalTest.deviceId);
                            byte[] data = LinkPayloadTransfer.downloadPayload(
                                    host, port,
                                    deviceManager.getMyCert(),
                                    deviceManager.getMyKey(),
                                    fingerprint);
                            double durationSec = (System.currentTimeMillis() - finalTest.downloadStart) / 1000.0;
                            double mb = data.length / (1024.0 * 1024.0);
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
                    // Fallback: no binary payload, use JSON-ack timing
                    double durationSec = (System.currentTimeMillis() - test.downloadStart) / 1000.0;
                    int mb = body.optInt("payloadMb", 5);
                    double downloadSpeedMbps = (mb * 8.0) / durationSec;
                    test.listener.onComplete((int) test.startTime, test.uploadSpeedMbps, downloadSpeedMbps);
                    activeTests.remove(testId);
                }
            }
        } catch (Exception e) {
            android.util.Log.e("LinkSpeedTest", "Failed to parse speedtest response", e);
        }
    }
}
