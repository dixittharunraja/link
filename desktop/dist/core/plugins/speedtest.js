"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpeedTestManager = void 0;
const packet_1 = require("../packet");
const payload_transfer_1 = require("../payload-transfer");
// How many MB to use for each bulk transfer leg.
// Larger = more accurate (amortises TLS handshake), but takes longer.
const PAYLOAD_MB = 20;
const PAYLOAD_BYTES = PAYLOAD_MB * 1024 * 1024;
class SpeedTestManager {
    deviceManager;
    activeTests = new Map();
    constructor(deviceManager) {
        this.deviceManager = deviceManager;
    }
    async runSpeedTest(deviceId, onProgress) {
        return new Promise((resolve, reject) => {
            const testId = `st-${Date.now()}`;
            this.activeTests.set(testId, {
                deviceId,
                step: 'ping',
                startTime: Date.now(),
                pingTimes: [],
                pingCount: 0,
                uploadStart: 0,
                downloadStart: 0,
                avgPing: 0,
                uploadSpeedMbps: 0,
                onProgress,
                resolve,
                reject,
            });
            onProgress('Starting latency test...');
            this.sendPing(testId);
        });
    }
    sendPing(testId) {
        const test = this.activeTests.get(testId);
        if (!test)
            return;
        test.startTime = Date.now();
        const packet = (0, packet_1.createPacket)('link.speedtest.request', {
            testId,
            step: 'ping',
        });
        this.deviceManager.sendTo(test.deviceId, packet);
    }
    async startUpload(testId) {
        const test = this.activeTests.get(testId);
        if (!test)
            return;
        test.step = 'upload';
        test.onProgress(`Measuring upload speed (sending ${PAYLOAD_MB}MB data)...`);
        // Build a raw zero-filled buffer — no JSON embedding, no base64.
        // Bytes travel through the ephemeral TLS payload channel.
        const payload = Buffer.alloc(PAYLOAD_BYTES);
        try {
            const handle = await (0, payload_transfer_1.startPayloadUpload)(this.deviceManager.myCert, this.deviceManager.myKey, payload, 60000 // 60s timeout for large payload
            );
            test.uploadStart = Date.now();
            const packet = (0, packet_1.createPacket)('link.speedtest.request', {
                testId,
                step: 'upload',
                payloadMb: PAYLOAD_MB,
            });
            packet.payloadSize = PAYLOAD_BYTES;
            packet.payloadTransferInfo = { port: handle.info.port };
            this.deviceManager.sendTo(test.deviceId, packet);
            // Wait for upload to complete so we can close the server
            handle.done.catch(() => { });
        }
        catch (err) {
            const t = this.activeTests.get(testId);
            if (t) {
                this.activeTests.delete(testId);
                t.reject(new Error(`Upload failed: ${err.message}`));
            }
        }
    }
    async startDownload(testId) {
        const test = this.activeTests.get(testId);
        if (!test)
            return;
        test.step = 'download';
        test.onProgress(`Measuring download speed (receiving ${PAYLOAD_MB}MB data)...`);
        test.downloadStart = Date.now();
        const packet = (0, packet_1.createPacket)('link.speedtest.request', {
            testId,
            step: 'download',
            payloadMb: PAYLOAD_MB,
        });
        this.deviceManager.sendTo(test.deviceId, packet);
    }
    handleResponse(packet) {
        const body = packet.body;
        if (!body || !body.testId)
            return;
        const test = this.activeTests.get(body.testId);
        if (!test)
            return;
        if (body.step === 'ping') {
            const rtt = Date.now() - test.startTime;
            test.pingTimes.push(rtt);
            test.pingCount++;
            if (test.pingCount < 5) {
                this.sendPing(body.testId);
            }
            else {
                test.avgPing =
                    test.pingTimes.reduce((a, b) => a + b, 0) / test.pingTimes.length;
                this.startUpload(body.testId);
            }
        }
        else if (body.step === 'upload') {
            // Peer has received our upload — compute speed from elapsed time.
            const durationSec = (Date.now() - test.uploadStart) / 1000;
            const mb = body.payloadMb ?? PAYLOAD_MB;
            test.uploadSpeedMbps = (mb * 8) / durationSec;
            this.startDownload(body.testId);
        }
        else if (body.step === 'download') {
            // Peer is about to stream bytes to us. Download via payload channel.
            const pti = packet.payloadTransferInfo;
            const testId = body.testId;
            // No legacy no-payload fallback here anymore — both responders (this file's
            // handleIncomingRequest, and Android's LinkSpeedTest.handleIncomingRequest) always use the
            // real binary channel now. A fallback that assumed the nominal requested size against
            // wall-clock time was the same bug class that produced impossibly large computed speeds
            // when a legacy/instant-ACK path was hit — better to fail loudly than silently report a
            // fabricated number.
            if (!pti) {
                this.activeTests.delete(testId);
                test.reject(new Error('Download response missing payloadTransferInfo — cannot measure a real transfer'));
                return;
            }
            const host = this.deviceManager.remoteAddressOf(test.deviceId);
            const fingerprint = this.deviceManager.pinnedFingerprintOf(test.deviceId);
            if (!host || !fingerprint) {
                this.activeTests.delete(testId);
                test.reject(new Error('Cannot download: missing host or fingerprint'));
                return;
            }
            (0, payload_transfer_1.downloadPayload)(host, pti.port, this.deviceManager.myCert, this.deviceManager.myKey, fingerprint)
                .then((data) => {
                const durationSec = (Date.now() - test.downloadStart) / 1000;
                const mb = data.length / (1024 * 1024);
                const downloadSpeedMbps = (mb * 8) / durationSec;
                const result = {
                    latencyMs: Math.round(test.avgPing),
                    uploadSpeedMbps: Math.round(test.uploadSpeedMbps * 10) / 10,
                    downloadSpeedMbps: Math.round(downloadSpeedMbps * 10) / 10,
                };
                this.activeTests.delete(testId);
                test.resolve(result);
            })
                .catch((err) => {
                this.activeTests.delete(testId);
                test.reject(new Error(`Download failed: ${err.message}`));
            });
        }
    }
    /**
     * Handle incoming request if we are the responder.
     * For upload: pull the binary payload via the payload channel, then ACK.
     * For download: stream 20MB binary payload back via its own payload channel.
     */
    handleIncomingRequest(packet, fromDeviceId) {
        const body = packet.body;
        if (!body || !body.testId)
            return;
        if (body.step === 'ping') {
            // Echo back immediately
            const resp = (0, packet_1.createPacket)('link.speedtest.response', {
                testId: body.testId,
                step: 'ping',
            });
            this.deviceManager.sendTo(fromDeviceId, resp);
        }
        else if (body.step === 'upload') {
            // Peer is uploading to us via payload channel — pull it, then ACK.
            const pti = packet.payloadTransferInfo;
            // No legacy no-payload fallback here anymore — it used to ACK instantly without ever
            // reading the payload channel, which the initiator's timer sees as a near-zero-duration
            // "transfer", producing impossibly large computed speeds (e.g. tens of Gbps over WiFi:
            // the reported duration was just a JSON round-trip, not a real 20MB transfer).
            if (!pti) {
                console.error('[SpeedTest] Upload request missing payloadTransferInfo — cannot measure a real transfer');
                return;
            }
            const host = this.deviceManager.remoteAddressOf(fromDeviceId);
            const fingerprint = this.deviceManager.pinnedFingerprintOf(fromDeviceId);
            if (!host || !fingerprint)
                return;
            (0, payload_transfer_1.downloadPayload)(host, pti.port, this.deviceManager.myCert, this.deviceManager.myKey, fingerprint)
                .then((data) => {
                // ACK with the REAL number of bytes received, not the nominally requested size — so
                // the initiator's computed speed reflects what was actually transferred.
                const resp = (0, packet_1.createPacket)('link.speedtest.response', {
                    testId: body.testId,
                    step: 'upload',
                    payloadMb: data.length / (1024 * 1024),
                });
                this.deviceManager.sendTo(fromDeviceId, resp);
            })
                .catch((err) => {
                console.error('[SpeedTest] Failed to receive upload payload:', err);
            });
        }
        else if (body.step === 'download') {
            // Peer wants us to stream download payload to them.
            const mb = body.payloadMb ?? PAYLOAD_MB;
            const bytes = mb * 1024 * 1024;
            const payload = Buffer.alloc(bytes);
            (0, payload_transfer_1.startPayloadUpload)(this.deviceManager.myCert, this.deviceManager.myKey, payload, 60000)
                .then((handle) => {
                const resp = (0, packet_1.createPacket)('link.speedtest.response', {
                    testId: body.testId,
                    step: 'download',
                    payloadMb: mb,
                });
                resp.payloadSize = bytes;
                resp.payloadTransferInfo = { port: handle.info.port };
                this.deviceManager.sendTo(fromDeviceId, resp);
                handle.done.catch(() => { });
            })
                .catch((err) => {
                console.error('[SpeedTest] Failed to start download payload server:', err);
            });
        }
    }
}
exports.SpeedTestManager = SpeedTestManager;
//# sourceMappingURL=speedtest.js.map