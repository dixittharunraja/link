package in.rodix.link;

import android.content.Context;
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

public class LinkRemoteMicServer extends WebSocketServer {
    private static final String TAG = "LinkRemoteMicServer";
    private static final byte CODEC_TAG_OPUS = 0x01;
    private static final int UDP_SEQ_BYTES = 4;
    private static final int UDP_NONCE_BYTES = 12;
    private static final int UDP_MAX_PACKET_BYTES = 65507;
    // Opus needs a fixed frame length. 10 ms keeps the added delay small and matches what the
    // capture thread reads per call, so each read becomes exactly one packet.
    private static final int OPUS_FRAME_MS = 10;
    // A mono voice at 48 kbps is near transparent, and still about 6% of the 768 kbps raw 16-bit
    // stream, which is what keeps the mic clean on a busy Wi-Fi link.
    private static final int OPUS_BITRATE = 48000;
    // Upper bound on how far the pacing cursor may run ahead of real time; see advancePacingCursor.
    private static final long MAX_AHEAD_MS = 100;

    public interface Listener {
        void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName);
        void onListenerJoined(String connId, String label);
        void onListenerLeft(String connId);
        void onError(String message);
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

    private static class AdmittedListener {
        final WebSocket conn;
        final String deviceId;
        final String label;
        final String remoteAddress; // needed so a guest (no deviceId) can still be blocked, by IP
        final byte[] sessionKey;
        // Built once: a key spec per packet is a needless allocation at 100 packets a second.
        final SecretKeySpec keySpec;
        final AtomicInteger seq = new AtomicInteger(0);
        volatile InetAddress udpAddress;
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

    private final Map<String, PendingGuest> pendingGuests = new ConcurrentHashMap<>();
    private final Map<String, AdmittedListener> admittedListeners = new ConcurrentHashMap<>();
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
    private final Map<String, SSLEngine> pendingEngines = new ConcurrentHashMap<>();

    private volatile RelayAudioFormat format = null;
    private volatile boolean muted = false;

    private LinkRemoteMicCapture capture;
    private DatagramSocket udpSocket;
    private Thread udpReceiveThread;
    private volatile boolean udpRunning = false;
    private final SecureRandom udpNonceRandom = new SecureRandom();
    // Reused because Cipher.getInstance() is costly at this packet rate. sendFrame() runs on both
    // the capture thread and the scheduler thread, so it is used only while holding its monitor.
    private final Cipher encryptCipher;
    // The pacing cursor, the Opus state and the 16-bit staging buffers are only touched from the
    // capture read thread (onFormatKnown and onAudioChunk), so they are not synchronized.
    private long nextSendAtMs = -1;
    private LinkOpusEncoder opusEncoder;
    private byte[] opusFrame = new byte[0]; // one OPUS_FRAME_MS frame of 16-bit PCM being filled
    private int opusFill = 0;

    private class ClientAuthSSLFactory extends DefaultSSLWebSocketServerFactory {
        ClientAuthSSLFactory(SSLContext sslContext) {
            super(sslContext);
        }

        @Override
        public ByteChannel wrapChannel(SocketChannel channel, SelectionKey key) throws java.io.IOException {
            SSLEngine engine = sslcontext.createSSLEngine();
            engine.setUseClientMode(false);
            engine.setWantClientAuth(true);
            String key2 = channel.socket().getRemoteSocketAddress().toString();
            pendingEngines.put(key2, engine);
            return new org.java_websocket.SSLSocketChannel2(channel, engine, exec, key);
        }
    }

    // Applies the app-wide blocklist to the connecting IP and, for token joins, the device ID.
    public interface BlockChecker {
        boolean isBlocked(String idOrIp);
    }
    private final BlockChecker blockChecker;

    public LinkRemoteMicServer(Context context, X509Certificate cert, PrivateKey key, int port, Listener listener) throws Exception {
        this(context, cert, key, port, listener, idOrIp -> false);
    }

    public LinkRemoteMicServer(Context context, X509Certificate cert, PrivateKey key, int port, Listener listener, BlockChecker blockChecker) throws Exception {
        super(new InetSocketAddress(port));
        this.context = context;
        this.listener = listener;
        this.blockChecker = blockChecker;
        this.myPublicKeyDer = cert.getPublicKey().getEncoded();

        SSLContext sslContext = LinkTransport.buildSslContext(cert, key);
        setWebSocketFactory(new ClientAuthSSLFactory(sslContext));
        setConnectionLostTimeout(20);
        encryptCipher = Cipher.getInstance("AES/GCM/NoPadding");
    }

    public void startCapture() {
        capture = new LinkRemoteMicCapture(context, new LinkRemoteMicCapture.Listener() {
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

    public String getPendingGuestDeviceName(String connId) {
        PendingGuest pending = pendingGuests.get(connId);
        return pending != null ? pending.deviceName : null;
    }

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
            listener.onError("Failed to broadcast remote mic format: " + e.getMessage());
        }
    }

    /** Starts this session's Opus encoder. Android 10+ always has the MediaCodec Opus encoder (a
     *  CDD requirement), so a failure is reported as an error and nothing is sent. */
    private boolean setupOpus() {
        if (opusEncoder != null) {
            opusEncoder.release();
            opusEncoder = null;
        }
        try {
            opusEncoder = new LinkOpusEncoder(format.sampleRate, format.channels, OPUS_BITRATE, OPUS_FRAME_MS * 1000);
            opusFrame = new byte[format.channels * 2 * (format.sampleRate * OPUS_FRAME_MS / 1000)];
            opusFill = 0;
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Opus encoder could not start", e);
            listener.onError("The microphone could not be encoded: " + e.getMessage());
            return false;
        }
    }

    /** The "format" message body. Float capture is narrowed to 16-bit before it is sent (Opus only
     *  takes 16-bit, and raw float would double the bandwidth for nothing audible), so 16-bit
     *  integer is declared whatever the microphone delivers. */
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
        RelayAudioFormat fmt = format;
        if (fmt == null || opusEncoder == null || muted || admittedListeners.isEmpty() || udpSocket == null) {
            // A half-filled frame would otherwise be glued onto audio from much later.
            opusFill = 0;
            return;
        }
        onAudioChunkOpus(pcm, fmt.isFloat && fmt.bitsPerSample == 32);
    }

    private static short floatSampleAt(byte[] b, int i) {
        int bits = (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8) | ((b[i + 2] & 0xff) << 16) | (b[i + 3] << 24);
        float sample = Math.max(-1f, Math.min(1f, Float.intBitsToFloat(bits)));
        return (short) Math.round(sample * 32767f);
    }

    // nextSendAtMs is one monotonically advancing cursor. The cursor resyncs to now when it falls
    // behind real time, and also when it drifts more than MAX_AHEAD_MS ahead; otherwise small
    // overestimates after a capture catch-up accumulate into growing latency.
    private void advancePacingCursor(long now) {
        if (nextSendAtMs < now || nextSendAtMs - now > MAX_AHEAD_MS) {
            nextSendAtMs = now;
        }
    }

    // Sends still waiting on the scheduler. A frame goes out inline only when none are, because
    // sequence numbers are given out at send time and an inline send must not overtake them.
    private final AtomicInteger scheduledSends = new AtomicInteger(0);

    /** Sends now when the frame is due and nothing is queued ahead of it, which is the usual case:
     *  the capture thread delivers 10 ms at a time in real time. Hopping to the scheduler thread
     *  would only add a context switch and its timer slack to every packet. */
    private void scheduleSend(long now, byte codecTag, byte[] payload) {
        long delayMs = nextSendAtMs - now;
        if (delayMs <= 0 && scheduledSends.get() == 0) {
            sendFrame(codecTag, payload);
            return;
        }
        scheduledSends.incrementAndGet();
        try {
            scheduler.schedule(() -> {
                try {
                    sendFrame(codecTag, payload);
                } finally {
                    scheduledSends.decrementAndGet();
                }
            }, Math.max(0, delayMs), TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            scheduledSends.decrementAndGet(); // the scheduler is shut down: the session is ending
        }
    }

    /** Fills fixed OPUS_FRAME_MS frames (narrowing float to 16-bit on the way), encodes and sends
     *  each. The capture thread reads 10 ms at a time, so normally one read is one packet. */
    private void onAudioChunkOpus(byte[] pcm, boolean isFloat) {
        long now = System.currentTimeMillis();
        boolean cursorSynced = false;
        int step = isFloat ? 4 : 2;
        for (int i = 0; i + step <= pcm.length; i += step) {
            short s = isFloat ? floatSampleAt(pcm, i) : (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
            opusFrame[opusFill++] = (byte) s;
            opusFrame[opusFill++] = (byte) (s >> 8);
            if (opusFill < opusFrame.length) continue;
            opusFill = 0;

            byte[] encoded;
            try {
                // The encoder copies the frame into its own buffer, so opusFrame can be refilled.
                encoded = opusEncoder.encode(opusFrame);
            } catch (Exception e) {
                Log.w(TAG, "Opus encode failed for a frame, dropping it", e);
                continue;
            }
            if (encoded.length == 0) continue; // nothing ready this round: drop it, don't desync pacing

            if (!cursorSynced) {
                advancePacingCursor(now);
                cursorSynced = true;
            }
            scheduleSend(now, CODEC_TAG_OPUS, encoded);
            nextSendAtMs += OPUS_FRAME_MS;
        }
    }

    // Wire format expected by the shared listener in core/audio_sink.rs for the mic service:
    // [seq(4)][nonce(12)][AES-256-GCM(codecTag + payload) + tag], no AAD and, unlike Audio Relay,
    // no timestamp field. A mismatch fails silently as GCM authentication errors.
    private void sendFrame(byte codecTag, byte[] rawPayload) {
        DatagramSocket socket = udpSocket;
        if (socket == null) return;
        byte[] framedPayload = new byte[1 + rawPayload.length];
        framedPayload[0] = codecTag;
        System.arraycopy(rawPayload, 0, framedPayload, 1, rawPayload.length);

        for (AdmittedListener dest : admittedListeners.values()) {
            if (dest.udpAddress == null || dest.udpPort == -1) continue;

            byte[] nonce = new byte[UDP_NONCE_BYTES];
            udpNonceRandom.nextBytes(nonce);

            // The ciphertext and its 16-byte tag are written straight after the header.
            int header = UDP_SEQ_BYTES + UDP_NONCE_BYTES;
            byte[] data = new byte[header + framedPayload.length + 16];
            try {
                synchronized (encryptCipher) {
                    encryptCipher.init(Cipher.ENCRYPT_MODE, dest.keySpec, new GCMParameterSpec(128, nonce));
                    encryptCipher.doFinal(framedPayload, 0, framedPayload.length, data, header);
                }
            } catch (Exception e) {
                continue;
            }

            ByteBuffer wire = ByteBuffer.wrap(data);
            wire.putInt(dest.seq.getAndIncrement());
            wire.put(nonce);

            try {
                socket.send(new DatagramPacket(data, data.length, dest.udpAddress, dest.udpPort));
            } catch (Exception ignored) {}
        }
    }

    private void startUdp() throws Exception {
        udpSocket = new DatagramSocket(new InetSocketAddress(LinkTransport.AUDIO_RELAY_UDP_PORT + 2)); // separate from Audio Relay's UDP port
        try { udpSocket.setSendBufferSize(1 << 17); } catch (Exception ignored) {}
        udpRunning = true;
        udpReceiveThread = new Thread(() -> {
            byte[] buf = new byte[UDP_MAX_PACKET_BYTES];
            while (udpRunning) {
                try {
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    udpSocket.receive(packet);
                    handleUdpMessage(packet.getAddress(), packet.getPort(), packet.getData(), packet.getLength());
                } catch (Exception ignored) {}
            }
        }, "remote-mic-udp");
        udpReceiveThread.start();
    }

    private void handleUdpMessage(InetAddress remoteAddr, int remotePort, byte[] data, int length) {
        try {
            String hello = new String(data, 0, length, "UTF-8");
            for (Map.Entry<String, AdmittedListener> entry : admittedListeners.entrySet()) {
                if (entry.getKey().equals(hello)) {
                    AdmittedListener l = entry.getValue();
                    l.udpAddress = remoteAddr;
                    l.udpPort = remotePort;
                    break;
                }
            }
        } catch (Exception ignored) {}
    }

    private void admit(String connId, WebSocket conn, String label, String deviceId, String remoteAddress) {
        byte[] sessionKey = new byte[32];
        new SecureRandom().nextBytes(sessionKey);

        AdmittedListener listenerObj = new AdmittedListener(conn, deviceId, label, remoteAddress != null ? remoteAddress : "unknown", sessionKey);
        admittedListeners.put(connId, listenerObj);

        try {
            JSONObject response = new JSONObject();
            response.put("type", "admitted");
            response.put("connId", connId);
            response.put("udpKey", Base64.encodeToString(sessionKey, Base64.NO_WRAP));
            conn.send(response.toString());

            if (format != null) {
                JSONObject fmtMsg = formatMessageJson();
                fmtMsg.put("type", "format");
                conn.send(fmtMsg.toString());
            }

            listener.onListenerJoined(connId, label);
        } catch (Exception e) {
            admittedListeners.remove(connId);
            try { conn.close(4008, "internal error admitting listener"); } catch (Exception ignored) {}
        }
    }

    // Per-connection context needed to resolve the join message, before admission.
    private final Map<WebSocket, byte[]> peerKeysByConn = new ConcurrentHashMap<>();
    private final Map<WebSocket, String> remoteAddrByConn = new ConcurrentHashMap<>();

    private final java.util.Map<WebSocket, String> guestTokens = new java.util.concurrent.ConcurrentHashMap<>();

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        String presentedToken = LinkGuestAccess.tokenFromDescriptor(handshake.getResourceDescriptor());
        if (presentedToken != null) guestTokens.put(conn, presentedToken);
        String remoteAddress = null;
        try {
            remoteAddress = conn.getRemoteSocketAddress().getAddress().getHostAddress();
        } catch (Exception ignored) {}
        if (remoteAddress != null && blockChecker.isBlocked(remoteAddress)) {
            conn.close(4010, "blocked");
            return;
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

        String connId = UUID.randomUUID().toString();
        connIds.put(conn, connId);
        peerKeysByConn.put(conn, peerPublicKeyDer);
        remoteAddrByConn.put(conn, remoteAddress);
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        peerKeysByConn.remove(conn);
        remoteAddrByConn.remove(conn);
        guestTokens.remove(conn);
        String connId = connIds.remove(conn);
        if (connId != null) {
            pendingGuests.remove(connId);
            AdmittedListener l = admittedListeners.remove(connId);
            if (l != null) {
                listener.onListenerLeft(connId);
            }
        }
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        String connId = connIds.get(conn);
        if (connId == null) return;

        try {
            JSONObject obj = new JSONObject(message);
            String type = obj.optString("type");

            String remoteAddress = conn.getRemoteSocketAddress().getAddress().getHostAddress();
            if ("join-guest".equals(type)) {
                if (!admittedListeners.isEmpty()) {
                    conn.close(4009, "Server busy");
                    return;
                }
                byte[] peerPublicKeyDer = peerKeysByConn.get(conn);
                if (peerPublicKeyDer == null) {
                    conn.close(4002, "invalid certificate");
                    return;
                }
                String deviceName = obj.optString("deviceName", "Guest");
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
                ScheduledFuture<?> future = scheduler.schedule(() -> rejectGuest(connId), 30000, TimeUnit.MILLISECONDS);
                pendingGuests.put(connId, new PendingGuest(conn, uiPin, future, remoteAddress, deviceName));
                try {
                    conn.send(new JSONObject().put("type", "pin").put("code", pin).toString());
                } catch (Exception ignored) {}
                listener.onGuestPinPending(connId, uiPin, remoteAddress, deviceName);
            } else if ("join-token".equals(type)) {
                if (!admittedListeners.isEmpty()) {
                    conn.close(4009, "Server busy");
                    return;
                }
                String token = obj.optString("token");
                TokenEntry entry = validTokens.remove(token);
                if (entry == null) {
                    conn.close(4003, "invalid or expired token");
                } else if (blockChecker.isBlocked(entry.deviceId)) {
                    conn.close(4010, "blocked");
                } else {
                    admit(connId, conn, entry.deviceName, entry.deviceId, remoteAddress);
                }
            }
        } catch (Exception e) {
            try { conn.close(4002, "malformed protocol message"); } catch (Exception ignored) {}
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        listener.onError("Remote mic server socket error: " + ex.getMessage());
    }

    @Override
    public void onStart() {
        try {
            startUdp();
        } catch (Exception e) {
            listener.onError("Failed to start UDP socket: " + e.getMessage());
        }
    }

    private void broadcastJson(JSONObject obj) throws Exception {
        String payload = obj.toString();
        for (AdmittedListener l : admittedListeners.values()) {
            try { l.conn.send(payload); } catch (Exception ignored) {}
        }
    }

    @Override
    public void stop() throws InterruptedException {
        super.stop();
        udpRunning = false;
        if (udpSocket != null) {
            try { udpSocket.close(); } catch (Exception ignored) {}
        }
        if (capture != null) {
            capture.stop();
        }
        // After capture.stop(), which joins the read thread, so no encode() can still be running.
        if (opusEncoder != null) {
            opusEncoder.release();
            opusEncoder = null;
        }
        scheduler.shutdown();
        executor.shutdown();
    }
}
