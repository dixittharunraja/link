package in.rodix.link;

// Audio Relay — Android-as-host side. Ports desktop's audio-sink-server.ts admission/relay logic
// onto the same TLS/WebSocketServer skeleton LinkFsServer.java already established for this
// codebase, so this is a new peer implementation of an already-symmetric wire protocol, NOT a new
// protocol — see audio-sink-server.ts's own header comment for the full design. Guest (manual IP)
// and already-paired-token joins both converge on admit() and are admitted immediately — there is
// no human accept/reject step for either, unlike Remote Mic's guest flow (LinkRemoteMicServer.java
// genuinely still gates on a PIN). Completely isolated from LinkDeviceManager/LinkTrustStore/the
// permission system — an admitted listener here is never added to the paired-device mesh.
//
// PCM audio goes out over a separate UDP socket (LinkTransport.AUDIO_RELAY_UDP_PORT), not this
// WebSocket connection — see audio-sink-server.ts's header comment for the full reasoning (TCP
// head-of-line blocking vs. real-time audio) and wire format (per-listener AES-256-GCM session
// key handed over inside "admitted", UDP hello for NAT/address discovery, [seq][nonce][ciphertext
// +tag] framing). This WebSocket keeps carrying every control message unchanged.
//
// Deliberately owns the LinkAudioCapture instance and the MediaProjection it was constructed
// with (see startCapture()) rather than LinkPlugin holding them separately — keeps LinkPlugin's
// reattach-cleanup block to a single new static field, matching the existing sFsServer/
// sAudioSinkClient pattern.

import android.content.Context;
import android.media.projection.MediaProjection;
import android.util.Base64;
import android.util.Log;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.DefaultSSLWebSocketServerFactory;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ByteChannel;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLPeerUnverifiedException;

public class LinkAudioSinkServer extends WebSocketServer {
    private static final String TAG = "LinkAudioSinkServer";
    private static final byte CODEC_TAG_PCM = 0x00;
    private static final byte CODEC_TAG_OPUS = 0x01;
    // Opus mandates fixed frame durations. History: 20ms -> 10ms (confirmed clean, real hardware)
    // -> 5ms (reverted). At 5ms the packet rate hit ~200/sec — 4 JNI-crossing MediaCodec calls per
    // frame plus AES-GCM plus UDP send/receive plus pacing overhead, ~200 times a second — and
    // produced pops PLUS rising latency together, not a single stall (already fixed via the
    // dequeue-timeout scaling in LinkOpusEncoder/LinkOpusDecoder). That combination is the same
    // signature as hitting the real AudioTrack buffer floor earlier this session: a genuine
    // cumulative-throughput ceiling on the phone's more CPU-constrained hardware, not a discrete
    // bug to chase further. 10ms is the confirmed-good floor for this pipeline.
    private static final int OPUS_FRAME_MS = 10;
    // See onAudioChunkPcm/onAudioChunkOpus's shared comment for why this needs both a "behind"
    // and "too far ahead" resync — hoisted to a class constant since both paths share one cursor.
    private static final long MAX_AHEAD_MS = 100;
    private static final int UDP_SEQ_BYTES = 4;
    private static final int UDP_NONCE_BYTES = 12;
    private static final int UDP_MAX_PACKET_BYTES = 65507; // UDP payload ceiling — hello datagrams are tiny
    // A single AudioRecord.read() is ~20ms of audio — ~3840 bytes at 48kHz/stereo/16-bit — well
    // over the ~1472-byte Ethernet/Wi-Fi MTU payload budget. Sending that as one UDP datagram
    // means the OS silently IP-fragments it; if even ONE fragment is lost, the kernel discards the
    // ENTIRE reassembled datagram, not just the missing piece — a whole ~20ms chunk vanishing at
    // once instead of a few ms, which is exactly what produces an audible pop/click at the
    // resulting waveform discontinuity. Slicing into pieces this small before ever attaching a
    // codec tag or encrypting keeps every wire datagram safely under the MTU. 1280 divides evenly
    // by every bytes-per-frame value this protocol produces (currently always 4, kept general).
    private static final int MAX_UDP_PCM_BYTES = 1280;

    public interface Listener {
        void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName);
        void onListenerJoined(String connId, String label);
        void onListenerLeft(String connId);
        void onError(String message);
    }

    private static class PendingGuest {
        final WebSocket conn;
        final String pin;
        final ScheduledFuture<?> timeoutFuture;
        final String remoteAddress;
        final String deviceName;
        PendingGuest(WebSocket conn, String pin, ScheduledFuture<?> timeoutFuture, String remoteAddress, String deviceName) {
            this.conn = conn;
            this.pin = pin;
            this.timeoutFuture = timeoutFuture;
            this.remoteAddress = remoteAddress;
            this.deviceName = deviceName;
        }
    }

    public static class ListenerInfo {
        public final String id;
        public final String label;
        ListenerInfo(String id, String label) {
            this.id = id;
            this.label = label;
        }
    }

    private static class RelayAudioFormat {
        final int sampleRate;
        final int channels;
        final int bitsPerSample;
        final boolean isFloat;
        RelayAudioFormat(int sampleRate, int channels, int bitsPerSample, boolean isFloat) {
            this.sampleRate = sampleRate;
            this.channels = channels;
            this.bitsPerSample = bitsPerSample;
            this.isFloat = isFloat;
        }
    }

    private static class AdmittedListener {
        final WebSocket conn;
        final String deviceId; // nullable — unset for guests
        final String label;
        final String remoteAddress; // needed so a guest (no deviceId) can still be blocked, by IP
        final byte[] sessionKey; // AES-256-GCM key for this listener's UDP audio frames
        final AtomicInteger seq = new AtomicInteger(0);
        volatile InetAddress udpAddress; // set once this listener's UDP hello arrives
        volatile int udpPort = -1;
        AdmittedListener(WebSocket conn, String deviceId, String label, String remoteAddress, byte[] sessionKey) {
            this.conn = conn;
            this.deviceId = deviceId;
            this.label = label;
            this.remoteAddress = remoteAddress;
            this.sessionKey = sessionKey;
        }
    }

    private final Context context;
    private final Listener listener;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final byte[] myPublicKeyDer;

    private final Map<String, AdmittedListener> admittedListeners = new ConcurrentHashMap<>();
    private final Map<String, PendingGuest> pendingGuests = new ConcurrentHashMap<>();

    // token -> issued-for info. Used to hold the real device name so admit() can label a listener
    // by its actual name instead of a truncated device ID — see issueToken()'s comment for why the
    // caller (LinkPlugin.java, which has trust-store access) must supply it, not this class.
    private static class TokenEntry {
        final String deviceId;
        final String deviceName;
        TokenEntry(String deviceId, String deviceName) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
        }
    }
    private final Map<String, TokenEntry> validTokens = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> connIds = new ConcurrentHashMap<>();
    // Peer public key extracted at onOpen(), consumed once the first message tells us which join
    // path this connection wants — pendingEngines mirrors LinkFsServer's own SSLEngine-stash trick
    // (the only way to get from a WebSocket conn back to the SSLEngine that authenticated it in
    // this library), keyed the same way (by remote socket address).
    private final Map<String, SSLEngine> pendingEngines = new ConcurrentHashMap<>();

    private volatile RelayAudioFormat format = null;
    private volatile boolean muted = false;

    private LinkAudioCapture capture;
    private MediaProjection projection;

    private DatagramSocket udpSocket;
    private Thread udpReceiveThread;
    private volatile boolean udpRunning = false;
    // Reused across every audio chunk/listener — re-instantiating SecureRandom that often (every
    // ~20-50ms per listener) is wasteful reseeding overhead for no benefit over one shared instance.
    private final SecureRandom udpNonceRandom = new SecureRandom();
    // Reused across every sub-packet/listener in onAudioChunk() instead of calling
    // Cipher.getInstance("AES/GCM/NoPadding") fresh each time — see LinkAudioSinkClient.java's
    // decryptCipher comment for why that lookup is expensive enough on Android to matter at this
    // packet rate. Only ever touched from LinkAudioCapture's single dedicated read thread.
    private final Cipher encryptCipher;
    // Shared send-pacing cursor for onAudioChunk() — see that method's comment for why this must
    // be a single cursor across all calls rather than a per-chunk countdown. Only ever touched
    // from LinkAudioCapture's single dedicated read thread, so no synchronization needed.
    private long nextSendAtMs = -1;
    // Opus encoding state — decided once per session in setupOpusIfPossible(), right after the
    // capture format becomes known. Only ever touched from LinkAudioCapture's single dedicated
    // read thread. NOT independently tested on real hardware during development — see
    // LinkOpusEncoder/LinkOpusDecoder's own header comments for why this is the one part of the
    // whole Opus feature that needs real device verification before being trusted.
    private boolean useOpus = false;
    private LinkOpusEncoder opusEncoder;
    private byte[] opusAccumulator = new byte[0]; // raw captured PCM not yet forming a full 20ms frame
    private int opusFrameBytes = 0; // byte size of exactly one 20ms frame, in the captured PCM format

    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private android.os.PowerManager.WakeLock wakeLock;

    private class ClientAuthSSLFactory extends DefaultSSLWebSocketServerFactory {
        ClientAuthSSLFactory(SSLContext sslContext) {
            super(sslContext);
        }

        @Override
        public ByteChannel wrapChannel(SocketChannel channel, SelectionKey key) throws java.io.IOException {
            SSLEngine engine = sslcontext.createSSLEngine();
            engine.setUseClientMode(false);
            // Want, not need: unlike LinkFsServer (which requires a client cert to even complete
            // the handshake), Audio Relay's wire protocol has documented close codes for "no
            // client certificate presented" (4001) that only exist if the handshake is allowed to
            // *complete* first so the WS layer can close gracefully with that code — matching
            // desktop's `requestCert: true, rejectUnauthorized: false`. setNeedClientAuth(true)
            // would instead abort the raw handshake before any of that code ever runs.
            engine.setWantClientAuth(true);
            String key2 = channel.socket().getRemoteSocketAddress().toString();
            pendingEngines.put(key2, engine);
            return new org.java_websocket.SSLSocketChannel2(channel, engine, exec, key);
        }
    }

    // Checked against both the connecting IP and (once known) the peer's deviceId — lets a
    // single app-wide LinkBlocklist entry cut off a device/IP from this ephemeral guest-session
    // server too, not just the main paired-device connection. Mirrors desktop's
    // AudioSinkServer's isBlocked constructor param.
    public interface BlockChecker {
        boolean isBlocked(String idOrIp);
    }
    private final BlockChecker blockChecker;

    public LinkAudioSinkServer(Context context, X509Certificate cert, PrivateKey key, int port, Listener listener) throws Exception {
        this(context, cert, key, port, listener, idOrIp -> false);
    }

    public LinkAudioSinkServer(Context context, X509Certificate cert, PrivateKey key, int port, Listener listener, BlockChecker blockChecker) throws Exception {
        super(new InetSocketAddress(port));
        this.context = context;
        this.listener = listener;
        this.blockChecker = blockChecker;
        this.myPublicKeyDer = cert.getPublicKey().getEncoded();

        SSLContext sslContext = LinkTransport.buildSslContext(cert, key);
        setWebSocketFactory(new ClientAuthSSLFactory(sslContext));
        setConnectionLostTimeout(20);
        encryptCipher = Cipher.getInstance("AES/GCM/NoPadding");

        try {
            android.net.wifi.WifiManager wifiManager =
                (android.net.wifi.WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                wifiLock = wifiManager.createWifiLock(
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Link:audiosink-host-wifi");
                wifiLock.setReferenceCounted(false);
            }
            android.os.PowerManager pm = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "Link:audiosink-host-cpu");
                wakeLock.setReferenceCounted(false);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to create Wi-Fi/wake locks — hosting will still work, just without power-save suppression", e);
        }
    }

    /** Unlike LinkFsServer's per-connection reference counting, these locks are tied to the
     *  capture session's lifetime, not listener count — continuous capture+broadcast work is
     *  happening the moment startCapture() runs, regardless of whether anyone has joined yet. */
    public void startCapture(MediaProjection projection) {
        this.projection = projection;
        capture = new LinkAudioCapture(context, projection, new LinkAudioCapture.Listener() {
            @Override
            public void onFormatReady(int sampleRate, int channels, int bitsPerSample, boolean isFloat) {
                onFormatKnown(new RelayAudioFormat(sampleRate, channels, bitsPerSample, isFloat));
            }
            @Override
            public void onChunk(byte[] pcm) {
                onAudioChunk(pcm);
            }
            @Override
            public void onError(String message) {
                listener.onError(message);
            }
        });
        try { if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire(); } catch (Exception ignored) {}
        try { if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(); } catch (Exception ignored) {}
        capture.start();
    }

    /** deviceName is only ever used for display (the "Connected Receivers"/"Listeners" label at
     *  admission) — the caller must supply the real name since this class has no trust-store
     *  access of its own. */
    public String issueToken(String deviceId, String deviceName) {
        byte[] randomBytes = new byte[16];
        new SecureRandom().nextBytes(randomBytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : randomBytes) sb.append(String.format("%02x", b));
        String token = sb.toString();
        validTokens.put(token, new TokenEntry(deviceId, deviceName));
        return token;
    }

    /** deviceId (nullable, set only for a paired-token join) + remoteAddress (always present) for
     *  an admitted listener — everything main.ts's Block button needs. */
    public static class ListenerBlockInfo {
        public final String deviceId;
        public final String remoteAddress;
        ListenerBlockInfo(String deviceId, String remoteAddress) {
            this.deviceId = deviceId;
            this.remoteAddress = remoteAddress;
        }
    }

    public ListenerBlockInfo getListenerBlockInfo(String connId) {
        AdmittedListener l = admittedListeners.get(connId);
        return l != null ? new ListenerBlockInfo(l.deviceId, l.remoteAddress) : null;
    }

    public void setMuted(boolean muted) {
        this.muted = muted;
        try {
            broadcastJson(new JSONObject().put("type", "hostMuted").put("muted", muted));
        } catch (Exception ignored) {}
    }

    public boolean isMuted() {
        return muted;
    }

    public void acceptGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return;
        pending.timeoutFuture.cancel(false);
        admit(connId, pending.conn, pending.deviceName, null, pending.remoteAddress);
    }

    public void rejectGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return;
        pending.timeoutFuture.cancel(false);
        try { pending.conn.close(4007, "rejected by host"); } catch (Exception ignored) {}
    }

    public String getPendingGuestRemoteAddress(String connId) {
        PendingGuest pending = pendingGuests.get(connId);
        return pending != null ? pending.remoteAddress : null;
    }

    public List<ListenerInfo> listenersSnapshot() {
        List<ListenerInfo> out = new ArrayList<>();
        for (Map.Entry<String, AdmittedListener> e : admittedListeners.entrySet()) {
            out.add(new ListenerInfo(e.getKey(), e.getValue().label));
        }
        return out;
    }

    /** Disconnects a single listener without ending the session for anyone else — the removal
     *  from admittedListeners happens when the resulting onClose() fires (see that method), not
     *  here; this just requests the disconnect. Mirrors desktop's kickListener(). */
    public void kickListener(String connId) {
        AdmittedListener l = admittedListeners.get(connId);
        if (l == null) return;
        try { l.conn.close(1000, "removed by host"); } catch (Exception ignored) {}
    }

    private void onFormatKnown(RelayAudioFormat fmt) {
        this.format = fmt;
        setupOpusIfPossible();
        try {
            JSONObject msg = formatMessageJson();
            msg.put("type", "format");
            broadcastJson(msg);
        } catch (Exception e) {
            listener.onError("Failed to broadcast format: " + e.getMessage());
        }
    }

    /** Decides once per session whether to Opus-encode instead of sending raw PCM. Android's own
     *  capture (LinkAudioCapture) always outputs 16-bit int PCM at a fixed 48000Hz — unlike the
     *  desktop host, there's no float-vs-int or sample-rate compatibility check needed here, since
     *  capture's format is hardcoded to something Opus already supports. Any failure (including
     *  API level below the Q+ MediaCodec-Opus-encoder requirement, or MediaCodec simply being
     *  unavailable for this MIME type on this specific device) just leaves useOpus false, and
     *  every other method in this class already treats that as "use the raw PCM path" — same
     *  fallback contract as the desktop host. */
    private void setupOpusIfPossible() {
        if (format == null) return;
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) return; // MediaCodec Opus ENCODING needs API 29+
        if (format.channels != 1 && format.channels != 2) return;

        try {
            int frameDurationUs = OPUS_FRAME_MS * 1000;
            opusEncoder = new LinkOpusEncoder(format.sampleRate, format.channels, 128000, frameDurationUs);
            int bytesPerFrame = format.channels * (format.bitsPerSample / 8);
            opusFrameBytes = bytesPerFrame * Math.round((format.sampleRate * OPUS_FRAME_MS) / 1000f);
            opusAccumulator = new byte[0];
            useOpus = true;
        } catch (Exception e) {
            Log.w(TAG, "Opus encoder init failed, falling back to raw PCM", e);
            opusEncoder = null;
            useOpus = false;
        }
    }

    /** What to actually tell listeners in the "format" message — Opus always decodes to 16-bit
     *  int PCM regardless of what it was encoded from, so that's what's declared here whenever
     *  useOpus is true, not this.format's own values (which happen to already be 16-bit for
     *  Android's capture, but the declared codec still needs to say so explicitly). */
    private JSONObject formatMessageJson() throws Exception {
        JSONObject o = new JSONObject();
        o.put("sampleRate", format.sampleRate);
        o.put("channels", format.channels);
        if (useOpus) {
            o.put("bitsPerSample", 16);
            o.put("isFloat", false);
            o.put("codec", "opus");
        } else {
            o.put("bitsPerSample", format.bitsPerSample);
            o.put("isFloat", format.isFloat);
            o.put("codec", "pcm");
        }
        return o;
    }

    private void onAudioChunk(byte[] pcm) {
        if (muted || admittedListeners.isEmpty() || udpSocket == null) return;
        if (useOpus && opusEncoder != null) {
            onAudioChunkOpus(pcm);
        } else {
            onAudioChunkPcm(pcm);
        }
    }

    // nextSendAtMs is a SINGLE cursor shared across every call to either onAudioChunkPcm or
    // onAudioChunkOpus, not a fresh per-chunk countdown — capture chunks don't arrive perfectly
    // metronomically, so a per-chunk countdown starting fresh each time let a new chunk's
    // immediate first unit fire before an earlier chunk's still-pending delayed units, sending
    // audio out of its true chronological order (not just out of network order) — that produced
    // garbled/distorted audio, not just a tuning problem. A shared, monotonically-advancing cursor
    // (same pattern the desktop host and the listener's own jitter buffer both use) guarantees
    // every unit is scheduled strictly after the one before it, in true source order.
    //
    // MAX_AHEAD_MS is the other half of that same pattern — the listener's own jitter buffer
    // resyncs both when it's fallen BEHIND real time and when it's drifted too far AHEAD (a burst
    // inflated the schedule). This cursor originally only handled the "behind" case: small,
    // persistent overestimates of audio-duration-per-wall-clock-time (capture catching up after a
    // brief hiccup delivers slightly more audio-time than real time actually elapsed) had nothing
    // capping how far ahead nextSendAtMs could drift, so over a real session it grew unbounded —
    // exactly what "latency keeps climbing" looks like. Confirmed via real testing.
    private void advancePacingCursor(long now) {
        if (nextSendAtMs < now || nextSendAtMs - now > MAX_AHEAD_MS) {
            nextSendAtMs = now;
        }
    }

    private void scheduleSend(long now, byte codecTag, byte[] payload) {
        long delayMs = Math.max(0, nextSendAtMs - now);
        scheduler.schedule(() -> sendFrame(codecTag, payload), delayMs, TimeUnit.MILLISECONDS);
    }

    private void onAudioChunkPcm(byte[] pcm) {
        double bytesPerFrame = format != null ? format.channels * (format.bitsPerSample / 8.0) : 0;
        double sampleRateHz = format != null ? format.sampleRate : 0;
        boolean canPace = bytesPerFrame > 0 && sampleRateHz > 0;

        long now = System.currentTimeMillis();
        advancePacingCursor(now);

        for (int offset = 0; offset < pcm.length; offset += MAX_UDP_PCM_BYTES) {
            int sliceLen = Math.min(MAX_UDP_PCM_BYTES, pcm.length - offset);
            byte[] slice = new byte[sliceLen];
            System.arraycopy(pcm, offset, slice, 0, sliceLen);

            scheduleSend(now, CODEC_TAG_PCM, slice);
            if (canPace) {
                nextSendAtMs += Math.round((sliceLen / bytesPerFrame / sampleRateHz) * 1000);
            }
        }
    }

    /** Accumulates raw captured PCM until there's a full OPUS_FRAME_MS worth, encodes exactly
     *  that much (Opus requires fixed frame sizes), and sends. Unlike the PCM path, this doesn't
     *  need to slice into MTU-safe pieces (an encoded frame is already far under the MTU) — but it
     *  still shares the same pacing cursor, since capture can occasionally hand over more than
     *  one frame's worth of audio in a single callback, and firing all of those back-to-back
     *  would reintroduce the exact burst pattern pacing was built to avoid. */
    private void onAudioChunkOpus(byte[] pcm) {
        byte[] combined = new byte[opusAccumulator.length + pcm.length];
        System.arraycopy(opusAccumulator, 0, combined, 0, opusAccumulator.length);
        System.arraycopy(pcm, 0, combined, opusAccumulator.length, pcm.length);

        if (combined.length < opusFrameBytes) {
            opusAccumulator = combined;
            return;
        }

        long now = System.currentTimeMillis();
        advancePacingCursor(now);

        int offset = 0;
        while (combined.length - offset >= opusFrameBytes) {
            byte[] rawFrame = new byte[opusFrameBytes];
            System.arraycopy(combined, offset, rawFrame, 0, opusFrameBytes);
            offset += opusFrameBytes;

            byte[] encoded;
            try {
                encoded = opusEncoder.encode(rawFrame);
            } catch (Exception e) {
                Log.w(TAG, "Opus encode failed for a frame, dropping it", e);
                continue;
            }
            if (encoded.length == 0) continue; // codec produced nothing this round — drop, don't desync pacing

            scheduleSend(now, CODEC_TAG_OPUS, encoded);
            nextSendAtMs += OPUS_FRAME_MS;
        }
        opusAccumulator = new byte[combined.length - offset];
        System.arraycopy(combined, offset, opusAccumulator, 0, opusAccumulator.length);
    }

    private void sendFrame(byte codecTag, byte[] payload) {
        if (udpSocket == null) return;
        byte[] framedPayload = new byte[1 + payload.length];
        framedPayload[0] = codecTag;
        System.arraycopy(payload, 0, framedPayload, 1, payload.length);

        for (AdmittedListener l : admittedListeners.values()) {
            // Nothing to send to until this listener's UDP hello arrives (see
            // handleUdpHello) — a brief startup gap of a few chunks at most.
            if (l.udpAddress == null || l.udpPort < 0) continue;
            try {
                byte[] nonce = new byte[UDP_NONCE_BYTES];
                udpNonceRandom.nextBytes(nonce);
                encryptCipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(l.sessionKey, "AES"), new GCMParameterSpec(128, nonce));
                byte[] encrypted = encryptCipher.doFinal(framedPayload); // includes the 16-byte auth tag appended

                int seq = l.seq.getAndIncrement();
                byte[] frame = new byte[UDP_SEQ_BYTES + UDP_NONCE_BYTES + encrypted.length];
                ByteBuffer bb = ByteBuffer.wrap(frame);
                bb.putInt(seq);
                bb.put(nonce);
                bb.put(encrypted);

                udpSocket.send(new DatagramPacket(frame, frame.length, l.udpAddress, l.udpPort));
            } catch (Exception e) {
                Log.w(TAG, "Failed to send UDP audio frame to listener", e);
            }
        }
    }

    /** Starts the UDP audio socket + its receive loop, listening for each listener's one "hello"
     *  datagram (their connId, sent in plaintext — an unguessable server-minted UUID, not a
     *  secret needing its own encryption) so we learn their (address, port) — see this file's
     *  header comment. Anything that doesn't match a currently-admitted connId is ignored. */
    private void startUdp() {
        try {
            udpSocket = new DatagramSocket(LinkTransport.AUDIO_RELAY_UDP_PORT);
            // Every capture chunk fans out as several sub-packets fired back-to-back with zero
            // delay (see MAX_UDP_PCM_BYTES) — a real burst, not a steady trickle. The OS default
            // send buffer is sized for typical request/response traffic, not that; a brief
            // scheduling hiccup on this thread while a burst is still draining can silently drop
            // the tail of it. 128KB is ~10x a single burst's worst-case size — enough headroom
            // without inviting the bufferbloat-style latency growth a much larger buffer (this was
            // 1MB) causes once anything downstream runs even slightly behind on average: a queue
            // that can grow huge just delays the reckoning instead of preventing it.
            udpSocket.setSendBufferSize(1 << 17); // 128KB
        } catch (Exception e) {
            listener.onError("Failed to open UDP audio socket: " + e.getMessage());
            return;
        }
        udpRunning = true;
        udpReceiveThread = new Thread(() -> {
            byte[] buf = new byte[UDP_MAX_PACKET_BYTES];
            while (udpRunning) {
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                try {
                    udpSocket.receive(packet);
                } catch (Exception e) {
                    if (udpRunning) Log.w(TAG, "UDP receive error", e);
                    continue;
                }
                String connId = new String(packet.getData(), 0, packet.getLength(), java.nio.charset.StandardCharsets.UTF_8);
                AdmittedListener l = admittedListeners.get(connId);
                if (l != null) {
                    l.udpAddress = packet.getAddress();
                    l.udpPort = packet.getPort();
                }
            }
        }, "LinkAudioSinkServer-udp");
        udpReceiveThread.start();
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        try {
            java.lang.reflect.Method getSocketMethod = conn.getClass().getMethod("getSocket");
            java.net.Socket socket = (java.net.Socket) getSocketMethod.invoke(conn);
            if (socket != null) socket.setTcpNoDelay(true);
        } catch (Exception e) {
            Log.w(TAG, "Failed to optimize socket parameters", e);
        }

        SocketAddress addr = conn.getRemoteSocketAddress();
        SSLEngine engine = addr != null ? pendingEngines.remove(addr.toString()) : null;
        byte[] peerPublicKeyDer;
        try {
            if (engine == null) throw new SSLPeerUnverifiedException("no engine for connection");
            Certificate[] chain = engine.getSession().getPeerCertificates();
            if (chain.length == 0) throw new SSLPeerUnverifiedException("empty chain");
            peerPublicKeyDer = chain[0].getPublicKey().getEncoded();
        } catch (SSLPeerUnverifiedException e) {
            conn.close(4001, "no client certificate presented");
            return;
        } catch (Exception e) {
            conn.close(4002, "invalid certificate");
            return;
        }

        String remoteAddress = addr != null ? addr.toString() : "unknown";
        if (blockChecker.isBlocked(remoteAddress)) {
            conn.close(4010, "blocked");
            return;
        }

        String connId = UUID.randomUUID().toString();
        connIds.put(conn, connId);
        peerKeysByConn.put(conn, peerPublicKeyDer);
        remoteAddrByConn.put(conn, remoteAddress);
    }

    // Stashes just enough per-connection context to resolve the first message; a small local map
    // keeps this out of the AdmittedListener type, which only exists once admission is decided.
    private final Map<WebSocket, byte[]> peerKeysByConn = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> remoteAddrByConn = new ConcurrentHashMap<>();
    // Guards against processing more than one "first" message per connection — checked
    // synchronously on the WS I/O thread (not deferred to the executor) so two messages arriving
    // back-to-back can't both race into handleFirstMessage(). Mirrors the single-shot semantics
    // of the .ts reference implementation's ws.off('message', onFirstMessage).
    private final java.util.Set<WebSocket> firstMessageHandled = java.util.concurrent.ConcurrentHashMap.newKeySet();

    @Override
    public void onMessage(WebSocket conn, String message) {
        if (!firstMessageHandled.add(conn)) return; // already handled — ignore anything further
        executor.execute(() -> handleFirstMessage(conn, message));
    }

    private void handleFirstMessage(WebSocket conn, String message) {
        String connId = connIds.get(conn);
        if (connId == null) return;

        JSONObject msg;
        try {
            msg = new JSONObject(message);
        } catch (Exception e) {
            conn.close(4003, "malformed join message");
            return;
        }

        String type = msg.optString("type", "");
        if ("join-token".equals(type)) {
            String token = msg.optString("token", null);
            TokenEntry entry = token != null ? validTokens.get(token) : null;
            if (entry == null) {
                conn.close(4005, "invalid or expired token");
                return;
            }
            validTokens.remove(token); // one-time use
            if (blockChecker.isBlocked(entry.deviceId)) {
                conn.close(4010, "blocked");
                return;
            }
            admit(connId, conn, entry.deviceName, entry.deviceId, remoteAddrByConn.get(conn));
        } else if ("join-guest".equals(type)) {
            byte[] peerPublicKeyDer = peerKeysByConn.get(conn);
            String remoteAddress = remoteAddrByConn.get(conn);
            if (peerPublicKeyDer == null) {
                conn.close(4002, "invalid certificate");
                return;
            }
            String deviceName = msg.optString("deviceName", "Guest Listener");
            String pin = LinkVerification.computeCode(myPublicKeyDer, peerPublicKeyDer, "");
            ScheduledFuture<?> timeoutFuture = scheduler.schedule(() -> {
                pendingGuests.remove(connId);
                try { conn.close(4006, "confirmation timed out"); } catch (Exception ignored) {}
            }, 30000, TimeUnit.MILLISECONDS);
            pendingGuests.put(connId, new PendingGuest(conn, pin, timeoutFuture, remoteAddress != null ? remoteAddress : "unknown", deviceName));
            try {
                conn.send(new JSONObject().put("type", "pin").put("code", pin).toString());
            } catch (Exception ignored) {}
            listener.onGuestPinPending(connId, pin, remoteAddress != null ? remoteAddress : "unknown", deviceName);
        } else {
            conn.close(4004, "unknown join type");
        }
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        String connId = connIds.remove(conn);
        peerKeysByConn.remove(conn);
        remoteAddrByConn.remove(conn);
        firstMessageHandled.remove(conn);
        if (connId == null) return;

        PendingGuest pending = pendingGuests.remove(connId);
        if (pending != null) {
            pending.timeoutFuture.cancel(false);
        }

        if (admittedListeners.remove(connId) != null) {
            listener.onListenerLeft(connId);
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        Log.e(TAG, "Audio Relay host server error", ex);
        listener.onError(ex != null ? ex.getMessage() : "Unknown server error");
    }

    @Override
    public void onStart() {
        Log.i(TAG, "Audio Relay host server started on port " + getPort());
        startUdp();
    }

    private void admit(String connId, WebSocket conn, String label, String deviceId, String remoteAddress) {
        byte[] sessionKey = new byte[32];
        udpNonceRandom.nextBytes(sessionKey);
        admittedListeners.put(connId, new AdmittedListener(conn, deviceId, label, remoteAddress != null ? remoteAddress : "unknown", sessionKey));
        try {
            // connId + udpKey ride this already-TLS-encrypted message, so the key exchange itself
            // stays fully protected even though the UDP audio frames it protects don't have their
            // own transport encryption — see this file's header comment.
            conn.send(new JSONObject().put("type", "admitted")
                .put("connId", connId)
                .put("udpKey", Base64.encodeToString(sessionKey, Base64.NO_WRAP))
                .toString());
            if (format != null) {
                JSONObject fmtMsg = formatMessageJson();
                fmtMsg.put("type", "format");
                conn.send(fmtMsg.toString());
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to send admission messages", e);
        }
        listener.onListenerJoined(connId, label);
    }

    private void broadcastJson(JSONObject obj) {
        String msg = obj.toString();
        for (AdmittedListener l : admittedListeners.values()) {
            try {
                if (l.conn.isOpen()) l.conn.send(msg);
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void stop() throws InterruptedException {
        try {
            broadcastJson(new JSONObject().put("type", "ended"));
        } catch (Exception ignored) {}

        for (AdmittedListener l : admittedListeners.values()) {
            try { l.conn.close(1000, "session ended"); } catch (Exception ignored) {}
        }
        for (PendingGuest p : pendingGuests.values()) {
            p.timeoutFuture.cancel(false);
            try { p.conn.close(1000, "receiver stopped"); } catch (Exception ignored) {}
        }
        pendingGuests.clear();
        admittedListeners.clear();
        validTokens.clear();

        if (capture != null) {
            capture.stop();
            capture = null;
        }
        if (projection != null) {
            try { projection.stop(); } catch (Exception ignored) {}
            projection = null;
        }
        nextSendAtMs = -1;
        if (opusEncoder != null) {
            opusEncoder.release();
            opusEncoder = null;
        }
        useOpus = false;
        opusAccumulator = new byte[0];

        udpRunning = false;
        if (udpSocket != null) {
            udpSocket.close(); // unblocks the receive thread's blocking receive() call
            udpSocket = null;
        }
        if (udpReceiveThread != null) {
            try { udpReceiveThread.join(2000); } catch (InterruptedException ignored) {}
            udpReceiveThread = null;
        }

        super.stop();
        executor.shutdown();
        scheduler.shutdownNow();

        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
    }
}
