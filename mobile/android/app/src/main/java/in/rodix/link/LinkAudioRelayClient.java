package in.rodix.link;

// Audio Relay — listener side, mirroring desktop's audio-relay-client.ts protocol exactly (see
// that file's header comment for the full wire protocol: JSON control messages for join/admit/
// format/mute/end over WebSocket, PCM audio over a separate UDP channel). Deliberately independent
// of LinkDeviceManager/LinkTrustStore — an admitted listener here never becomes a paired device.
//
// PCM arrives over LinkTransport.AUDIO_RELAY_UDP_PORT, not this WebSocket — see audio-relay-
// server.ts's header comment for the full reasoning (TCP head-of-line blocking vs. real-time
// audio). The "admitted" control message now also carries our connId and a per-session
// AES-256-GCM key; setupUdp() opens the UDP socket, sends one "hello" datagram (our connId) so
// the host learns our (address, port), then a dedicated receive thread decrypts+auth-verifies
// every incoming frame before handing PCM to playChunk() exactly as before.

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.util.Base64;
import android.util.Log;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;

public class LinkAudioRelayClient {
    private static final String TAG = "LinkAudioRelayClient";
    private static final byte CODEC_TAG_PCM = 0x00;
    private static final byte CODEC_TAG_OPUS = 0x01;
    // Must match desktop's OPUS_FRAME_MS in audio-relay-server.ts and this project's own
    // LinkAudioRelayServer.OPUS_FRAME_MS — Opus mandates fixed frame durations, and this is only
    // used to drive LinkOpusDecoder's presentation-timestamp bookkeeping (monotonic, not
    // wall-clock-critical), not to parse anything on the wire. History: 20ms -> 10ms (confirmed
    // good) -> 5ms (reverted — real throughput ceiling on Android's MediaCodec path, see
    // LinkAudioRelayServer's OPUS_FRAME_MS comment for the full reasoning).
    private static final int OPUS_FRAME_MS = 10;
    private static final int UDP_SEQ_BYTES = 4;
    private static final int UDP_NONCE_BYTES = 12;
    private static final int UDP_MAX_PACKET_BYTES = 65507;
    // The host slices each capture chunk into several MTU-safe sub-packets and fires them in a
    // tight back-to-back burst (no inter-packet delay) — exactly the pattern that lets Wi-Fi/NIC-
    // level reordering shuffle packets relative to each other even on a healthy LAN. A strict
    // "drop anything not strictly increasing" rule then discards perfectly good, just slightly-
    // late packets, which sounds identical to real loss (a click at the resulting gap) but happens
    // far more often. This small reorder window holds a few out-of-order arrivals and releases
    // them once the gap fills, so only a genuinely lost packet (buffer fills up without the gap
    // ever showing) gets skipped.
    private static final int REORDER_WINDOW_MAX = 8;

    public interface Listener {
        void onPinComputed(String pin);
        void onAdmitted();
        void onFormat(int sampleRate, int channels, int bitsPerSample, boolean isFloat);
        void onHostMuted(boolean muted);
        void onEnded();
        void onClosed(String reason);
        void onError(String message);
    }

    private final Context context;
    private final Listener listener;
    private WebSocketClient client;
    private AudioTrack audioTrack;
    private int sampleRate;
    private int channels;
    private int bitsPerSample;
    private boolean isFloatFormat;
    private boolean pinComputedLocally = false;

    private String hostAddress;
    private DatagramSocket udpSocket;
    private Thread udpReceiveThread;
    private volatile boolean udpRunning = false;
    private byte[] sessionKey;
    private int nextExpectedSeq = -1; // -1 = not bootstrapped yet; accept whatever arrives first
    private final java.util.TreeMap<Integer, byte[]> reorderBuffer = new java.util.TreeMap<>(); // seq -> decrypted PCM payload

    // Reused across every packet on the single UDP receive thread instead of calling
    // Cipher.getInstance("AES/GCM/NoPadding") fresh each time — that lookup (JCA provider
    // resolution) is real, non-trivial overhead on Android and was enough at this packet rate to
    // make the receive thread fall behind. cipher.init() before each doFinal() is cheap and is the
    // documented-correct way to reuse a Cipher across operations with a fresh IV each time.
    private Cipher decryptCipher;
    // Built fresh in handleControlMessage() whenever a "format" message declares codec="opus" —
    // see that handler for why a construction failure surfaces as onError() rather than a crash.
    // Only ever touched from the single UDP receive thread.
    private LinkOpusDecoder opusDecoder;

    // High-performance Wi-Fi lock + partial wake lock, held for the duration of an active listen
    // session — same reasoning and pattern as LinkFsServer's (see that file's comment). Without
    // this, Android's/MIUI's aggressive background power management can suspend the Wi-Fi radio
    // or reclaim the process while this is the one thing actually keeping a live socket + audio
    // playback going with no other foreground signal (unlike LinkFsServer, which at least serves
    // a foreground-triggered file browse) — this was the missing piece behind the app's WebView
    // renderer getting killed specifically while an Audio Relay session was active.
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private android.os.PowerManager.WakeLock wakeLock;

    public LinkAudioRelayClient(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    private void acquireLocks() {
        try {
            android.net.wifi.WifiManager wifiManager =
                (android.net.wifi.WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                wifiLock = wifiManager.createWifiLock(
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Link:audiorelay-wifi");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
            android.os.PowerManager pm = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "Link:audiorelay-cpu");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to acquire Wi-Fi/wake locks — playback will still work, just without power-save suppression", e);
        }
    }

    private void releaseLocks() {
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        wifiLock = null;
        wakeLock = null;
    }

    /** token null = guest path (PIN confirmation); token non-null = already-paired fast path. */
    public void connect(String host, int port, X509Certificate myCert, PrivateKey myKey, String token) {
        Log.i(TAG, "connect() to " + host + ":" + port + " mode=" + (token != null ? "paired-token" : "guest-pin"));
        this.hostAddress = host;
        try {
            URI uri = new URI("wss://" + host + ":" + port);
            SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);
            acquireLocks();

            client = new WebSocketClient(uri) {
                @Override
                public void onOpen(ServerHandshake handshakedata) {
                    Log.i(TAG, "onOpen — TLS handshake complete, sending join message");
                    if (token != null) {
                        sendJoin("join-token", "token", token);
                    } else {
                        computeAndReportPin(myCert);
                        sendJoin("join-guest", null, null);
                    }
                }

                @Override
                public void onMessage(String message) {
                    handleControlMessage(message);
                }

                @Override
                public void onMessage(ByteBuffer bytes) {
                    // Audio no longer arrives over this WebSocket — see this file's header
                    // comment. Nothing legitimate should hit this anymore; log and ignore rather
                    // than remove, since some versions of this library declare it abstract.
                    Log.w(TAG, "Unexpected binary WebSocket message (" + bytes.remaining() + " bytes) — ignoring");
                }

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    Log.i(TAG, "onClose code=" + code + " reason=" + reason + " remote=" + remote);
                    stopPlayback();
                    stopUdp();
                    releaseLocks();
                    listener.onClosed(reason != null && !reason.isEmpty() ? reason : ("code " + code));
                }

                @Override
                public void onError(Exception ex) {
                    Log.e(TAG, "onError", ex);
                    // Idempotent with onClose's own releaseLocks()/stopUdp() calls — some failure
                    // paths fire onError without a following onClose, and both are no-ops if
                    // already torn down.
                    stopUdp();
                    releaseLocks();
                    listener.onError(ex.getMessage());
                }
            };
            // setSocketFactory (not setSSLSocketFactory) is what actually makes this a wss://
            // connection for this library — matches the pattern already used for the Android FS
            // server's TLS setup (LinkTransport.buildSslContext), same self-signed/no-CA trust
            // model as the rest of the app.
            client.setSocketFactory(sslContext.getSocketFactory());
            client.connect();
        } catch (Exception e) {
            releaseLocks();
            listener.onError("Failed to connect: " + e.getMessage());
        }
    }

    /** Playback happens fully natively here (AudioTrack) — unlike desktop, chunks are never
     *  forwarded up to the WebView/JS layer (would mean base64-encoding every chunk across the
     *  Capacitor bridge many times a second, real overhead on a battery/CPU-constrained device
     *  for no benefit). That means the shared React volume slider can't reach a Web Audio
     *  GainNode on mobile the way it does on desktop — this method is what it calls instead,
     *  wired through a dedicated PluginMethod (see LinkPlugin.java). */
    public void setVolume(float volume) {
        if (audioTrack != null) {
            try { audioTrack.setVolume(volume); } catch (Exception ignored) {}
        }
    }

    public void disconnect() {
        stopPlayback();
        stopUdp();
        releaseLocks();
        if (client != null) {
            try { client.close(); } catch (Exception ignored) {}
            client = null;
        }
    }

    private void sendJoin(String type, String extraKey, String extraValue) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("type", type);
            if (extraKey != null) obj.put(extraKey, extraValue);
            Log.i(TAG, "sending join message: " + type);
            client.send(obj.toString());
        } catch (Exception e) {
            Log.e(TAG, "Failed to send join message", e);
        }
    }

    /** Best-effort independent PIN computation from the peer's TLS certificate — mirrors
     *  desktop's approach (see audio-relay-client.ts). WebSocketClient.getSocket() is a
     *  documented public method of org.java-websocket that returns the underlying Socket (an
     *  SSLSocket once a secure socket factory is set), giving straightforward access to
     *  getSession().getPeerCertificates() — no NIO SSLEngine reflection needed here, unlike
     *  LinkFsServer's server-side code, because java-websocket's CLIENT uses a plain blocking
     *  SSLSocket under the hood. Falls back to the host's own 'pin' control message (see
     *  handleControlMessage) if this doesn't pan out for any reason — see
     *  audio-relay-server.ts's join-guest branch for why that fallback is an acceptable
     *  degradation rather than a hard failure. */
    private void computeAndReportPin(X509Certificate myCert) {
        try {
            Socket socket = client.getSocket();
            if (socket instanceof SSLSocket) {
                Certificate[] chain = ((SSLSocket) socket).getSession().getPeerCertificates();
                if (chain.length > 0) {
                    String pin = LinkVerification.computeCode(myCert.getPublicKey().getEncoded(), chain[0].getPublicKey().getEncoded(), "");
                    pinComputedLocally = true;
                    listener.onPinComputed(pin);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not independently verify PIN from peer certificate — will trust the host-reported PIN instead", e);
        }
    }

    private void handleControlMessage(String message) {
        try {
            JSONObject obj = new JSONObject(message);
            String type = obj.optString("type");
            Log.i(TAG, "control message: " + type);
            if ("admitted".equals(type)) {
                setupUdp(obj.optString("connId", null), obj.optString("udpKey", null));
                listener.onAdmitted();
            } else if ("format".equals(type)) {
                sampleRate = obj.getInt("sampleRate");
                channels = obj.getInt("channels");
                bitsPerSample = obj.getInt("bitsPerSample");
                isFloatFormat = obj.getBoolean("isFloat");
                String codec = obj.optString("codec", "pcm");
                Log.i(TAG, "format: " + sampleRate + "Hz " + channels + "ch " + bitsPerSample + "bit isFloat=" + isFloatFormat + " codec=" + codec);
                opusDecoder = null;
                if ("opus".equals(codec)) {
                    try {
                        opusDecoder = new LinkOpusDecoder(sampleRate, channels, OPUS_FRAME_MS * 1000);
                    } catch (Exception e) {
                        Log.e(TAG, "Failed to initialize Opus decoder", e);
                        listener.onError("Host is streaming Opus-encoded audio but this device could not initialize an Opus decoder — audio will not play.");
                    }
                }
                startPlayback();
                listener.onFormat(sampleRate, channels, bitsPerSample, isFloatFormat);
            } else if ("hostMuted".equals(type)) {
                listener.onHostMuted(obj.optBoolean("muted", false));
            } else if ("ended".equals(type)) {
                listener.onEnded();
            } else if ("pin".equals(type) && !pinComputedLocally) {
                // Fallback path only — see computeAndReportPin().
                listener.onPinComputed(obj.optString("code"));
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse control message", e);
        }
    }

    private int chunksReceived = 0;

    /** Opens the UDP socket for this session and sends the one "hello" datagram that lets the
     *  host learn our (address, port) — see audio-relay-server.ts's header comment for the full
     *  protocol. */
    private void setupUdp(String connId, String udpKeyBase64) {
        if (connId == null || udpKeyBase64 == null) {
            Log.w(TAG, "admitted message missing connId/udpKey — cannot set up UDP audio");
            return;
        }
        try {
            sessionKey = Base64.decode(udpKeyBase64, Base64.NO_WRAP);
            nextExpectedSeq = -1;
            reorderBuffer.clear();
            decryptCipher = Cipher.getInstance("AES/GCM/NoPadding"); // instantiated once, reused per packet
            udpSocket = new DatagramSocket();
            // The host fires several sub-packets per capture chunk back-to-back with zero delay
            // (see MAX_UDP_PCM_BYTES on the host side) — a real burst, not a steady trickle. The
            // OS default receive buffer is sized for typical request/response traffic, not that;
            // if this thread is even briefly descheduled while a burst arrives, the kernel can
            // silently drop the tail of it before we ever see it. 128KB is ~10x a single burst's
            // worst-case size — enough headroom without inviting the bufferbloat-style latency
            // growth a much larger buffer (this was 1MB) causes once anything downstream runs even
            // slightly behind on average: a queue that can grow huge just delays the reckoning
            // instead of preventing it, at the cost of added end-to-end latency for every packet
            // queued behind it.
            udpSocket.setReceiveBufferSize(1 << 17); // 128KB
            udpSocket.send(new DatagramPacket(
                connId.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                connId.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,
                InetAddress.getByName(hostAddress), LinkTransport.AUDIO_RELAY_UDP_PORT));

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
                    handleUdpFrame(packet.getData(), packet.getLength());
                }
            }, "LinkAudioRelayClient-udp");
            udpReceiveThread.start();
        } catch (Exception e) {
            listener.onError("Failed to set up UDP audio socket: " + e.getMessage());
        }
    }

    private void handleUdpFrame(byte[] data, int length) {
        int minLen = UDP_SEQ_BYTES + UDP_NONCE_BYTES + 16; // 16 = GCM auth tag
        if (sessionKey == null || length < minLen) return;

        ByteBuffer bb = ByteBuffer.wrap(data, 0, length);
        int seq = bb.getInt();
        byte[] nonce = new byte[UDP_NONCE_BYTES];
        bb.get(nonce);
        byte[] ciphertext = new byte[length - UDP_SEQ_BYTES - UDP_NONCE_BYTES];
        bb.get(ciphertext);

        byte[] payload;
        try {
            decryptCipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(sessionKey, "AES"), new GCMParameterSpec(128, nonce));
            payload = decryptCipher.doFinal(ciphertext); // throws on auth-tag mismatch — wrong key, corrupted, or spoofed
        } catch (Exception e) {
            return; // failed auth — silently drop, matches desktop's audio-relay-client.ts
        }

        acceptDecrypted(seq, payload);
    }

    /** Reorder-tolerant delivery: plays packets in seq order, briefly holding out-of-order
     *  arrivals instead of dropping them outright — see REORDER_WINDOW_MAX's comment for why a
     *  strict monotonic check isn't safe for a burst of back-to-back sub-packets. Called only from
     *  the single UDP receive thread, so no synchronization is needed on nextExpectedSeq/
     *  reorderBuffer. */
    private void acceptDecrypted(int seq, byte[] payload) {
        if (nextExpectedSeq == -1) {
            nextExpectedSeq = seq;
        } else if (seq < nextExpectedSeq) {
            return; // stale — already played, a duplicate, or a replayed/spoofed packet
        }

        if (seq == nextExpectedSeq) {
            deliver(payload);
            nextExpectedSeq++;
            drainReorderBuffer();
            return;
        }

        // Ahead of what we're waiting for — hold it briefly in case the gap is just reordering,
        // not real loss. If too many later packets pile up without the gap ever showing, give up.
        reorderBuffer.put(seq, payload);
        if (reorderBuffer.size() > REORDER_WINDOW_MAX) {
            nextExpectedSeq = reorderBuffer.firstKey();
            drainReorderBuffer();
        }
    }

    private void drainReorderBuffer() {
        byte[] next = reorderBuffer.remove(nextExpectedSeq);
        while (next != null) {
            deliver(next);
            nextExpectedSeq++;
            next = reorderBuffer.remove(nextExpectedSeq);
        }
    }

    private void deliver(byte[] payload) {
        if (payload.length < 1) return;
        byte codecTag = payload[0];
        byte[] body = new byte[payload.length - 1];
        System.arraycopy(payload, 1, body, 0, body.length);

        byte[] pcm;
        if (codecTag == CODEC_TAG_PCM) {
            pcm = body;
        } else if (codecTag == CODEC_TAG_OPUS) {
            if (opusDecoder == null) return; // unavailable — already surfaced via onError() in handleControlMessage
            try {
                pcm = opusDecoder.decode(body);
            } catch (Exception e) {
                Log.w(TAG, "Opus decode failed for a frame, dropping it", e);
                return;
            }
            if (pcm.length == 0) return; // codec produced nothing this round
        } else {
            Log.w(TAG, "Unknown codec tag " + codecTag + " — dropping frame");
            return;
        }

        chunksReceived++;
        if (chunksReceived == 1) {
            Log.i(TAG, "First audio chunk received: " + pcm.length + " bytes. audioTrack=" + (audioTrack != null ? "ready" : "NULL (format never arrived?)"));
        } else if (chunksReceived % 200 == 0) {
            Log.i(TAG, "Chunks received so far: " + chunksReceived);
        }
        playChunk(pcm);
    }

    private void stopUdp() {
        udpRunning = false;
        if (udpSocket != null) {
            udpSocket.close(); // unblocks the receive thread's blocking receive() call
            udpSocket = null;
        }
        if (udpReceiveThread != null) {
            try { udpReceiveThread.join(2000); } catch (InterruptedException ignored) {}
            udpReceiveThread = null;
        }
        sessionKey = null;
        decryptCipher = null;
        reorderBuffer.clear();
        if (opusDecoder != null) {
            opusDecoder.release();
            opusDecoder = null;
        }
    }

    private void startPlayback() {
        stopPlayback();
        int channelConfig = channels == 1 ? AudioFormat.CHANNEL_OUT_MONO : AudioFormat.CHANNEL_OUT_STEREO;
        int encoding = (isFloatFormat && bitsPerSample == 32)
            ? AudioFormat.ENCODING_PCM_FLOAT
            : (bitsPerSample == 8 ? AudioFormat.ENCODING_PCM_8BIT : AudioFormat.ENCODING_PCM_16BIT);

        int minBufferSize = AudioTrack.getMinBufferSize(sampleRate, channelConfig, encoding);
        if (minBufferSize <= 0) {
            listener.onError("Unsupported audio format for this device: " + sampleRate + "Hz/" + channels + "ch/" + bitsPerSample + "bit");
            return;
        }

        // Confirmed on real hardware: low-latency mode's Builder.build() doesn't just fail to
        // initialize on a buffer size it doesn't like — it THROWS (UnsupportedOperationException:
        // "Invalid audio buffer size"). Each attempt below is wrapped individually so a throw
        // falls through to the next fallback instead of aborting startPlayback() entirely.
        //
        // Attempt 1: the device's own native fast-mixer buffer size, in frames, converted to
        // bytes for OUR format — this is the size the low-latency HAL path actually wants (a
        // guessed size like getMinBufferSize() is exactly what threw above). Only tried when the
        // native output rate matches our stream's rate; low-latency mode needs both to line up.
        // Attempt 2: low-latency again but with getMinBufferSize() (cheap, harmless to try, some
        // devices accept it). Attempt 3: normal (non-low-latency) path with headroom for jitter —
        // this is the universal fallback and was the only thing that worked before this change.
        Integer nativeBufferSize = nativeLowLatencyBufferSizeBytes(encoding, channelConfig);
        if (nativeBufferSize != null) {
            audioTrack = tryBuildAudioTrack(channelConfig, encoding, nativeBufferSize, true);
        }
        if (audioTrack == null) {
            audioTrack = tryBuildAudioTrack(channelConfig, encoding, minBufferSize, true);
        }
        if (audioTrack == null) {
            int normalBufferSize = (int) (minBufferSize * 1.2);
            audioTrack = tryBuildAudioTrack(channelConfig, encoding, normalBufferSize, false);
        }

        if (audioTrack == null) {
            listener.onError("AudioTrack failed to initialize for " + sampleRate + "Hz/" + channels + "ch/" + bitsPerSample + "bit");
            return;
        }

        try {
            audioTrack.play();
            Log.i(TAG, "Playback started: " + sampleRate + "Hz " + channels + "ch, playState=" + audioTrack.getPlayState());
        } catch (Exception e) {
            Log.e(TAG, "audioTrack.play() failed", e);
            listener.onError("Failed to start audio playback: " + e.getMessage());
        }
    }

    /** The device's own native output rate/buffer period, in bytes for our format — the size the
     *  low-latency fast-mixer path actually expects, per Android's documented approach for
     *  reliably getting low-latency output (AudioManager.PROPERTY_OUTPUT_*). Returns null if the
     *  native rate doesn't match our stream (low-latency mode needs them to line up, and forcing
     *  it through a rate mismatch is more likely to throw than help) or the properties aren't
     *  available at all. */
    private Integer nativeLowLatencyBufferSizeBytes(int encoding, int channelConfig) {
        try {
            android.media.AudioManager am = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return null;
            String nativeRateStr = am.getProperty(android.media.AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);
            String nativeFramesStr = am.getProperty(android.media.AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER);
            if (nativeRateStr == null || nativeFramesStr == null) return null;

            int nativeRate = Integer.parseInt(nativeRateStr);
            int nativeFrames = Integer.parseInt(nativeFramesStr);
            if (nativeRate != sampleRate) {
                Log.i(TAG, "Native output rate (" + nativeRate + "Hz) doesn't match stream rate (" + sampleRate + "Hz) — skipping native-buffer low-latency attempt");
                return null;
            }

            int bytesPerFrame = channels * (bitsPerSample / 8);
            int singlePeriodBytes = nativeFrames * bytesPerFrame;
            // A single native HAL period (confirmed on real hardware: 144 frames = ~3ms at
            // 48kHz) is far too shallow a buffer for how audio actually arrives over the relay —
            // several UDP sub-packets fired back-to-back, then a ~20ms gap until the next capture
            // chunk (see MAX_UDP_PCM_BYTES on the host side), not a steady trickle. A buffer that
            // small underran constantly waiting out each gap — confirmed via getUnderrunCount()
            // climbing continuously in real testing even with ~100% of packets delivered intact,
            // making this a playback-buffering bug, not a network one. Multiples of the native
            // period are used (not an arbitrary byte count) since some low-latency HAL
            // implementations reject sizes that aren't a clean multiple of it. History: 40ms ->
            // 30ms -> 20ms -> 15ms (reverted, PCM era) -> ... -> 10ms (reverted, Opus era). At
            // 10ms the buffer exactly equals the Opus frame interval (OPUS_FRAME_MS) — zero
            // margin for any timing jitter at all, so even small variance in decode/delivery
            // timing immediately either underruns (pop) or forces AudioTrack.write()'s BLOCKING
            // call to stall the UDP receive thread (added latency) — confirmed via real testing,
            // both symptoms together. 20ms holds up under both the old PCM bursty-delivery pattern
            // and Opus's steadier one; it's the confirmed floor for this buffering approach either
            // way, not just a leftover PCM-era assumption.
            int targetBufferMs = 20;
            int targetBytes = (int) (sampleRate * bytesPerFrame * (targetBufferMs / 1000.0));
            int periods = Math.max(1, (int) Math.ceil((double) targetBytes / singlePeriodBytes));
            int size = singlePeriodBytes * periods;
            Log.i(TAG, "Native low-latency buffer: " + periods + "x " + nativeFrames + "-frame periods = " + size + " bytes (~" + (size * 1000L / (sampleRate * bytesPerFrame)) + "ms)");
            return size;
        } catch (Exception e) {
            Log.w(TAG, "Could not read native audio properties: " + e.getMessage());
            return null;
        }
    }

    /** Returns a ready-to-play AudioTrack, or null if this configuration didn't work — either it
     *  threw (e.g. low-latency mode rejecting a buffer size some HALs are picky about) or it
     *  silently returned an uninitialized track. Both are treated as "try the next fallback",
     *  never a hard failure by themselves. */
    private AudioTrack tryBuildAudioTrack(int channelConfig, int encoding, int bufferSize, boolean lowLatency) {
        String label = lowLatency ? "low-latency" : "normal";
        try {
            AudioTrack.Builder builder = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build())
                .setAudioFormat(new AudioFormat.Builder()
                    .setEncoding(encoding)
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelConfig)
                    .build())
                .setBufferSizeInBytes(bufferSize)
                .setTransferMode(AudioTrack.MODE_STREAM);

            if (lowLatency && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY);
            }

            AudioTrack track = builder.build();
            if (track.getState() != AudioTrack.STATE_INITIALIZED) {
                Log.w(TAG, label + " AudioTrack built but state=" + track.getState() + " — treating as failure");
                try { track.release(); } catch (Exception ignored) {}
                return null;
            }
            Log.i(TAG, label + " AudioTrack initialized OK, bufferSize=" + bufferSize);
            return track;
        } catch (Exception e) {
            Log.w(TAG, label + " AudioTrack build threw: " + e.getMessage());
            return null;
        }
    }

    private void playChunk(byte[] pcm) {
        if (audioTrack == null) return;
        try {
            if (isFloatFormat && bitsPerSample == 32) {
                ByteBuffer bb = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
                FloatBuffer fb = bb.asFloatBuffer();
                float[] floats = new float[fb.remaining()];
                fb.get(floats);
                audioTrack.write(floats, 0, floats.length, AudioTrack.WRITE_BLOCKING);
            } else {
                audioTrack.write(pcm, 0, pcm.length);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error writing audio chunk", e);
        }
    }

    private void stopPlayback() {
        if (audioTrack != null) {
            try {
                audioTrack.stop();
                audioTrack.release();
            } catch (Exception ignored) {}
            audioTrack = null;
        }
    }
}
