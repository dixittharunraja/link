package in.rodix.link;

// Audio Relay host (Android side). Implements the same wire protocol as the desktop host in
// core/audio_sink.rs (see its header for the full design) on a TLS WebSocketServer.
// A one-time token join, or a guest join from an already-paired device, is admitted immediately;
// an unknown guest must be confirmed by the host via a PIN (acceptGuest/rejectGuest). Admitted
// listeners are never added to the paired-device mesh.
//
// The WebSocket carries control messages only. Audio goes over a separate UDP socket
// (LinkTransport.AUDIO_RELAY_UDP_PORT) to avoid TCP head-of-line blocking: each listener gets an
// AES-256-GCM session key inside "admitted", announces its UDP address with a hello datagram, and
// receives [seq][timestamp][nonce][ciphertext+tag] frames.
//
// This class owns the LinkAudioCapture and its MediaProjection so LinkPlugin only has to track
// one static reference for cleanup.

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
    private static final byte CODEC_TAG_OPUS = 0x01;
    // Opus requires a fixed frame duration. 10ms is the lowest that phones sustain: at 5ms the
    // ~200 packets/s (MediaCodec JNI calls, AES-GCM, UDP and pacing per frame) exceed the CPU
    // budget and cause pops and growing latency.
    private static final int OPUS_FRAME_MS = 10;
    // Upper bound on how far the pacing cursor may run ahead of real time; see advancePacingCursor.
    private static final long MAX_AHEAD_MS = 100;
    private static final int UDP_SEQ_BYTES = 4;
    private static final int UDP_TS_BYTES = 6;
    private static final int UDP_NONCE_BYTES = 12;
    private static final int UDP_MAX_PACKET_BYTES = 65507; // UDP payload ceiling — hello datagrams are tiny

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
        // Built once: a key spec per packet is a needless allocation at 100 packets a second.
        final SecretKeySpec keySpec;
        final AtomicInteger seq = new AtomicInteger(0);
        volatile InetAddress udpAddress; // set once this listener's UDP hello arrives
        volatile int udpPort = -1;
        AdmittedListener(WebSocket conn, String deviceId, String label, String remoteAddress, byte[] sessionKey) {
            this.conn = conn;
            this.deviceId = deviceId;
            this.label = label;
            this.remoteAddress = remoteAddress;
            this.sessionKey = sessionKey;
            this.keySpec = new SecretKeySpec(sessionKey, "AES");
        }
    }

    private final Context context;
    private final Listener listener;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final byte[] myPublicKeyDer;

    private final Map<String, AdmittedListener> admittedListeners = new ConcurrentHashMap<>();
    private final Map<String, PendingGuest> pendingGuests = new ConcurrentHashMap<>();

    // Token -> the device it was issued for, so admit() can label the listener by its name.
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
    // SSLEngine per remote socket address, stashed in wrapChannel() so onOpen() can read the peer
    // certificate; Java-WebSocket offers no other way to reach the engine from a connection.
    private final Map<String, SSLEngine> pendingEngines = new ConcurrentHashMap<>();

    private volatile RelayAudioFormat format = null;
    private volatile boolean muted = false;

    private LinkAudioCapture capture;
    private MediaProjection projection;

    private DatagramSocket udpSocket;
    private Thread udpReceiveThread;
    private volatile boolean udpRunning = false;
    // Shared instance; one nonce is drawn per frame per listener.
    private final SecureRandom udpNonceRandom = new SecureRandom();
    // Reused because Cipher.getInstance() is costly on Android at this packet rate. sendFrame()
    // runs on both the capture thread and the scheduler thread, so use it only while holding its
    // monitor; one encryption takes microseconds, so the lock adds no audible latency.
    private final Cipher encryptCipher;
    // Send-pacing cursor (see advancePacingCursor).
    private long nextSendAtMs = -1;
    private volatile long lastCaptureReadMs = 0;
    // Opus state, set up once per session in setupOpus(). The pacing cursor and Opus fields are
    // only touched from LinkAudioCapture's read thread, so they are not synchronized.
    private LinkOpusEncoder opusEncoder;
    private byte[] opusAccumulator = new byte[0]; // captured PCM not yet forming a full frame
    private int opusFrameBytes = 0; // byte size of one OPUS_FRAME_MS frame of captured PCM

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
            // "Want" rather than "need": the handshake must complete without a client certificate
            // so onOpen() can close with the protocol's 4001 code instead of a raw TLS failure.
            engine.setWantClientAuth(true);
            String key2 = channel.socket().getRemoteSocketAddress().toString();
            pendingEngines.put(key2, engine);
            return new org.java_websocket.SSLSocketChannel2(channel, engine, exec, key);
        }
    }

    // Checked against the connecting IP and, once known, the peer's deviceId, so the app-wide
    // blocklist also applies to this server.
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

    /** Starts capture. The Wi-Fi and wake locks follow the capture session rather than the
     *  listener count, since capture runs whether or not anyone has joined. */
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

    /** Issues a one-time join token. deviceName is only used as the listener's display label. */
    public String issueToken(String deviceId, String deviceName) {
        byte[] randomBytes = new byte[16];
        new SecureRandom().nextBytes(randomBytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : randomBytes) sb.append(String.format("%02x", b));
        String token = sb.toString();
        validTokens.put(token, new TokenEntry(deviceId, deviceName));
        return token;
    }

    /** What the UI's Block button (AudioListenerRow.tsx) needs; deviceId is null for guests. */
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

    /** Disconnects one listener; it is removed from admittedListeners in onClose(). */
    public void kickListener(String connId) {
        AdmittedListener l = admittedListeners.get(connId);
        if (l == null) return;
        try { l.conn.close(1000, "removed by host"); } catch (Exception ignored) {}
    }

    private void onFormatKnown(RelayAudioFormat fmt) {
        this.format = fmt;
        if (!setupOpus()) return;
        try {
            JSONObject msg = formatMessageJson();
            msg.put("type", "format");
            broadcastJson(msg);
        } catch (Exception e) {
            listener.onError("Failed to broadcast format: " + e.getMessage());
        }
    }

    /** Starts this session's Opus encoder. LinkAudioCapture always produces 48kHz 16-bit stereo
     *  PCM, which Opus accepts, and Android 10+ always has the MediaCodec Opus encoder (a CDD
     *  requirement), so a failure is reported as an error and nothing is sent. */
    private boolean setupOpus() {
        if (opusEncoder != null) {
            opusEncoder.release();
            opusEncoder = null;
        }
        try {
            int frameDurationUs = OPUS_FRAME_MS * 1000;
            opusEncoder = new LinkOpusEncoder(format.sampleRate, format.channels, 192000, frameDurationUs);
            int bytesPerFrame = format.channels * (format.bitsPerSample / 8);
            opusFrameBytes = bytesPerFrame * Math.round((format.sampleRate * OPUS_FRAME_MS) / 1000f);
            opusAccumulator = new byte[0];
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Opus encoder could not start", e);
            listener.onError("The audio could not be encoded: " + e.getMessage());
            return false;
        }
    }

    /** The "format" message body. Listeners decode Opus to 16-bit int PCM, so that is declared
     *  regardless of the capture format. */
    private JSONObject formatMessageJson() throws Exception {
        JSONObject o = new JSONObject();
        o.put("sampleRate", format.sampleRate);
        o.put("channels", format.channels);
        o.put("bitsPerSample", 16);
        o.put("isFloat", false);
        o.put("codec", "opus");
        return o;
    }

    private void onAudioChunk(byte[] pcm) {
        lastCaptureReadMs = System.currentTimeMillis();
        if (opusEncoder == null || muted || admittedListeners.isEmpty() || udpSocket == null) return;
        onAudioChunkOpus(pcm);
    }

    // nextSendAtMs is one monotonically advancing cursor. Capture
    // chunks arrive irregularly, so a per-chunk countdown could send a new chunk's first packet
    // before an earlier chunk's delayed ones, reordering the audio. The cursor resyncs to now
    // when it falls behind real time, and also when it drifts more than MAX_AHEAD_MS ahead;
    // otherwise small overestimates after capture catch-up accumulate into growing latency.
    private void advancePacingCursor(long now) {
        if (nextSendAtMs < now || nextSendAtMs - now > MAX_AHEAD_MS) {
            nextSendAtMs = now;
        }
    }

    private void scheduleSend(long now, byte codecTag, byte[] payload) {
        long delayMs = nextSendAtMs - now;
        if (delayMs <= 0) {
            sendFrame(codecTag, payload);
        } else {
            scheduler.schedule(() -> sendFrame(codecTag, payload), delayMs, TimeUnit.MILLISECONDS);
        }
    }

    /** Accumulates captured PCM into fixed OPUS_FRAME_MS frames, encodes and sends them. Encoded
     *  frames are well under the MTU, but they are still paced because one capture callback can
     *  yield several frames, which would otherwise go out as a burst. */
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

        long nowMs = lastCaptureReadMs > 0 ? lastCaptureReadMs : System.currentTimeMillis();
        short tsHi = (short) ((nowMs >> 32) & 0xFFFF);
        int tsLo = (int) (nowMs & 0xFFFFFFFFL);

        for (AdmittedListener l : admittedListeners.values()) {
            // Skipped until this listener's UDP hello arrives (see startUdp).
            if (l.udpAddress == null || l.udpPort < 0) continue;
            try {
                byte[] nonce = new byte[UDP_NONCE_BYTES];
                udpNonceRandom.nextBytes(nonce);
                // The ciphertext and its 16-byte auth tag are written straight after the header,
                // so there is no intermediate array to copy.
                int header = UDP_SEQ_BYTES + UDP_TS_BYTES + UDP_NONCE_BYTES;
                byte[] frame = new byte[header + framedPayload.length + 16];
                synchronized (encryptCipher) {
                    encryptCipher.init(Cipher.ENCRYPT_MODE, l.keySpec, new GCMParameterSpec(128, nonce));
                    encryptCipher.doFinal(framedPayload, 0, framedPayload.length, frame, header);
                }

                int seq = l.seq.getAndIncrement();
                ByteBuffer bb = ByteBuffer.wrap(frame);
                bb.putInt(seq);
                bb.putShort(tsHi);
                bb.putInt(tsLo);
                bb.put(nonce);

                udpSocket.send(new DatagramPacket(frame, frame.length, l.udpAddress, l.udpPort));
            } catch (Exception e) {
                Log.w(TAG, "Failed to send UDP audio frame to listener", e);
            }
        }
    }

    /** Opens the UDP audio socket and listens for each listener's hello datagram, which carries
     *  its connId in plaintext (an unguessable server-issued UUID) and tells the host where to
     *  send. Datagrams that match no admitted connId are ignored. */
    private void startUdp() {
        try {
            udpSocket = new DatagramSocket(LinkTransport.AUDIO_RELAY_UDP_PORT);
            // Sub-packets can leave in bursts, which the default send buffer may truncate. 128KB
            // gives ample headroom; a much larger buffer lets latency build up instead.
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
        String presentedToken = LinkGuestAccess.tokenFromDescriptor(handshake.getResourceDescriptor());
        if (presentedToken != null) guestTokens.put(conn, presentedToken);
    }

    private final java.util.Map<WebSocket, String> guestTokens = new java.util.concurrent.ConcurrentHashMap<>();
    // Per-connection context needed to resolve the join message, before admission.
    private final Map<WebSocket, byte[]> peerKeysByConn = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> remoteAddrByConn = new ConcurrentHashMap<>();
    // Ensures only one join message per connection is handled. Checked on the WebSocket I/O
    // thread, before handing off to the executor, so back-to-back messages cannot both get in.
    private final java.util.Set<WebSocket> firstMessageHandled = java.util.concurrent.ConcurrentHashMap.newKeySet();

    @Override
    public void onMessage(WebSocket conn, String message) {
        try {
            JSONObject obj = new JSONObject(message);
            if ("clock-ping".equals(obj.optString("type"))) {
                long t1 = obj.optLong("t1", 0);
                JSONObject pong = new JSONObject();
                pong.put("type", "clock-pong");
                pong.put("t1", t1);
                pong.put("t2", System.currentTimeMillis());
                conn.send(pong.toString());
                return;
            }
        } catch (Exception ignored) {}

        if (!firstMessageHandled.add(conn)) return; // already handled join message — ignore subsequent non-ping messages
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
            // A paired device has already been vouched for; only strangers get the PIN prompt.
            LinkTrustStore.TrustedDevice trusted = LinkTrustStore.getInstance(context).findByPublicKey(peerPublicKeyDer);
            if (trusted != null) {
                admit(connId, conn, deviceName, trusted.deviceId, remoteAddress);
                return;
            }
            LinkPairingWindow.Admission admission = LinkGuestAccess.admit(getPort(), guestTokens.remove(conn));
            if (LinkGuestAccess.refuses(admission)) {
                if (admission == LinkPairingWindow.Admission.CONFLICT) LinkGuestAccess.reportConflict(deviceName);
                try { conn.close(4007, "refused"); } catch (Exception ignored) {}
                return;
            }
            String pin = LinkVerification.computeCode(myPublicKeyDer, peerPublicKeyDer, "");
            String uiPin = admission == LinkPairingWindow.Admission.QR ? "" : pin;
            ScheduledFuture<?> timeoutFuture = scheduler.schedule(() -> {
                pendingGuests.remove(connId);
                try { conn.close(4006, "confirmation timed out"); } catch (Exception ignored) {}
            }, 30000, TimeUnit.MILLISECONDS);
            pendingGuests.put(connId, new PendingGuest(conn, uiPin, timeoutFuture, remoteAddress != null ? remoteAddress : "unknown", deviceName));
            try {
                conn.send(new JSONObject().put("type", "pin").put("code", pin).toString());
            } catch (Exception ignored) {}
            listener.onGuestPinPending(connId, uiPin, remoteAddress != null ? remoteAddress : "unknown", deviceName);
        } else {
            conn.close(4004, "unknown join type");
        }
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        String connId = connIds.remove(conn);
        peerKeysByConn.remove(conn);
        remoteAddrByConn.remove(conn);
        guestTokens.remove(conn);
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
            // The UDP session key is delivered over this TLS connection.
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
