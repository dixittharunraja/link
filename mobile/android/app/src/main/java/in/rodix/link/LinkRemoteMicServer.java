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

public class LinkRemoteMicServer extends WebSocketServer {
    private static final String TAG = "LinkRemoteMicServer";
    private static final byte CODEC_TAG_PCM = 0x00;
    private static final int UDP_SEQ_BYTES = 4;
    private static final int UDP_NONCE_BYTES = 12;
    private static final int UDP_MAX_PACKET_BYTES = 65507;
    private static final int MAX_UDP_PCM_BYTES = 1280;

    public interface Listener {
        void onGuestPinPending(String connId, String pin, String remoteAddress);
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
        PendingGuest(WebSocket conn, String pin, ScheduledFuture<?> timeoutFuture) {
            this.conn = conn;
            this.pin = pin;
            this.timeoutFuture = timeoutFuture;
        }
    }

    private static class AdmittedListener {
        final WebSocket conn;
        final String deviceId;
        final String label;
        final byte[] sessionKey;
        final AtomicInteger seq = new AtomicInteger(0);
        volatile InetAddress udpAddress;
        volatile int udpPort = -1;
        AdmittedListener(WebSocket conn, String deviceId, String label, byte[] sessionKey) {
            this.conn = conn;
            this.deviceId = deviceId;
            this.label = label;
            this.sessionKey = sessionKey;
        }
    }

    private final Context context;
    private final Listener listener;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final byte[] myPublicKeyDer;

    private final Map<String, PendingGuest> pendingGuests = new ConcurrentHashMap<>();
    private final Map<String, AdmittedListener> admittedListeners = new ConcurrentHashMap<>();
    // token -> issued-for info. Used to hold the real device name so admit() can label a listener
    // by its actual name instead of the generic "Paired Device" placeholder — see issueToken()'s
    // comment for why the caller (LinkPlugin.java, which has trust-store access) must supply it.
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
    private final Cipher encryptCipher;
    private long nextSendAtMs = -1;

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

    public LinkRemoteMicServer(Context context, X509Certificate cert, PrivateKey key, int port, Listener listener) throws Exception {
        super(new InetSocketAddress(port));
        this.context = context;
        this.listener = listener;
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

    /** deviceName is only ever used for display (the "Connected Receivers" label at admission) —
     *  the caller must supply the real name since this class has no trust-store access of its
     *  own. */
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
        admit(connId, pending.conn, "Guest", null);
    }

    public void rejectGuest(String connId) {
        PendingGuest pending = pendingGuests.remove(connId);
        if (pending == null) return;
        pending.timeoutFuture.cancel(false);
        try { pending.conn.close(4007, "rejected by host"); } catch (Exception ignored) {}
    }

    public void setMuted(boolean muted) {
        this.muted = muted;
        try {
            broadcastJson(new JSONObject().put("type", "hostMuted").put("muted", muted));
        } catch (Exception ignored) {}
    }

    public List<ListenerInfo> listenersSnapshot() {
        List<ListenerInfo> out = new ArrayList<>();
        for (Map.Entry<String, AdmittedListener> e : admittedListeners.entrySet()) {
            out.add(new ListenerInfo(e.getKey(), e.getValue().label));
        }
        return out;
    }

    /** Disconnects a single listener without ending the session for anyone else — the removal
     *  from admittedListeners happens when the resulting onClose() fires, not here; this just
     *  requests the disconnect. Mirrors LinkAudioRelayServer's kickListener(). */
    public void kickListener(String connId) {
        AdmittedListener l = admittedListeners.get(connId);
        if (l == null) return;
        try { l.conn.close(1000, "removed by host"); } catch (Exception ignored) {}
    }

    private void onFormatKnown(RelayAudioFormat fmt) {
        this.format = fmt;
        try {
            JSONObject msg = formatMessageJson();
            msg.put("type", "format");
            broadcastJson(msg);
        } catch (Exception e) {
            listener.onError("Failed to broadcast remote mic format: " + e.getMessage());
        }
    }

    private JSONObject formatMessageJson() throws Exception {
        JSONObject o = new JSONObject();
        o.put("sampleRate", format.sampleRate);
        o.put("channels", format.channels);
        o.put("bitsPerSample", format.bitsPerSample);
        o.put("isFloat", format.isFloat);
        o.put("codec", "pcm");
        return o;
    }

    private void onAudioChunk(byte[] pcm) {
        if (muted || admittedListeners.isEmpty() || udpSocket == null) return;
        onAudioChunkPcm(pcm);
    }

    private void advancePacingCursor(long now) {
        long MAX_AHEAD_MS = 100;
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

    // Frame layout and encryption here must match audio-relay-client.ts exactly — main.ts connects
    // to this server using the shared AudioRelayClient class (see wireRemoteMicClientEvents/
    // join-remote-mic-paired in main.ts), not a Remote-Mic-specific client, so any divergence from
    // that class's expected wire format silently breaks playback (GCM auth failures or misaligned
    // byte offsets) rather than throwing anywhere visible. This previously used AAD (the client
    // never sets one, so every packet would fail tag verification) and carried the codec tag as a
    // separate plaintext byte between the nonce and ciphertext (the client expects it to be the
    // FIRST DECRYPTED byte instead, prepended to the payload before encryption) — see
    // LinkAudioRelayServer.java's own sendFrame() for the reference implementation this now
    // mirrors exactly: [seq(4)][nonce(12)][AES-256-GCM(codecTag + payload), tag included].
    private void sendFrame(byte codecTag, byte[] rawPayload) {
        byte[] framedPayload = new byte[1 + rawPayload.length];
        framedPayload[0] = codecTag;
        System.arraycopy(rawPayload, 0, framedPayload, 1, rawPayload.length);

        for (AdmittedListener dest : admittedListeners.values()) {
            if (dest.udpAddress == null || dest.udpPort == -1) continue;

            byte[] nonce = new byte[UDP_NONCE_BYTES];
            udpNonceRandom.nextBytes(nonce);

            byte[] encrypted; // ciphertext + 16-byte auth tag, combined (Cipher.doFinal's default GCM output)
            try {
                encryptCipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(dest.sessionKey, "AES"), new GCMParameterSpec(128, nonce));
                encrypted = encryptCipher.doFinal(framedPayload);
            } catch (Exception e) {
                continue;
            }

            int seq = dest.seq.getAndIncrement();
            ByteBuffer wire = ByteBuffer.allocate(UDP_SEQ_BYTES + UDP_NONCE_BYTES + encrypted.length);
            wire.putInt(seq);
            wire.put(nonce);
            wire.put(encrypted);

            try {
                byte[] data = wire.array();
                DatagramPacket packet = new DatagramPacket(data, data.length, dest.udpAddress, dest.udpPort);
                udpSocket.send(packet);
            } catch (Exception ignored) {}
        }
    }

    private void startUdp() throws Exception {
        udpSocket = new DatagramSocket(new InetSocketAddress(LinkTransport.AUDIO_RELAY_UDP_PORT + 2)); // Port offset by +2 to avoid collision
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

    private void admit(String connId, WebSocket conn, String label, String deviceId) {
        byte[] sessionKey = new byte[32];
        new SecureRandom().nextBytes(sessionKey);

        AdmittedListener listenerObj = new AdmittedListener(conn, deviceId, label, sessionKey);
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

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        String connId = UUID.randomUUID().toString();
        connIds.put(conn, connId);
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
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

            if ("join-guest".equals(type)) {
                String pin = "123456"; // Reuse basic pinning for mic guest path
                ScheduledFuture<?> future = scheduler.schedule(() -> rejectGuest(connId), 30000, TimeUnit.MILLISECONDS);
                pendingGuests.put(connId, new PendingGuest(conn, pin, future));
                listener.onGuestPinPending(connId, pin, conn.getRemoteSocketAddress().getAddress().getHostAddress());
            } else if ("join-token".equals(type)) {
                String token = obj.optString("token");
                TokenEntry entry = validTokens.remove(token);
                if (entry != null) {
                    admit(connId, conn, entry.deviceName, entry.deviceId);
                } else {
                    conn.close(4003, "invalid or expired token");
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
        scheduler.shutdown();
        executor.shutdown();
    }
}
