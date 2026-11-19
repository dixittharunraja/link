package in.rodix.link;

// Audio Relay listener. Implements the protocol described in the header of desktop's
// core/audio_sink.rs: JSON control messages (join/admit/format/mute/end) over a TLS WebSocket,
// audio over a separate UDP channel to avoid TCP head-of-line blocking. Independent of
// LinkDeviceManager/LinkTrustStore, so an admitted listener never becomes a paired device.
//
// The "admitted" message carries a connId and a per-session AES-256-GCM key. setupUdp() opens the
// UDP socket and sends one "hello" datagram (the connId) so the host learns this device's address
// and port; a dedicated receive thread then authenticates and decrypts each frame before playback.

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
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLContext;

public class LinkAudioSinkClient {
    private static final String TAG = "LinkAudioSinkClient";
    private static final byte CODEC_TAG_OPUS = 0x01;
    // Matches OPUS_FRAME_MS in desktop's core/audio_sink.rs and LinkAudioSinkServer. Only drives
    // LinkOpusDecoder's presentation-timestamp bookkeeping; nothing on the wire is parsed with it.
    private static final int OPUS_FRAME_MS = 10;
    private static final int UDP_SEQ_BYTES = 4;
    private static final int UDP_TS_BYTES = 6; // capture-time wall-clock ms, [hi:2][lo:4]
    private static final int UDP_NONCE_BYTES = 12;
    private static final int UDP_MAX_PACKET_BYTES = 65507;
    // The host sends each capture chunk as a back-to-back burst of MTU-sized sub-packets, which
    // Wi-Fi can reorder even on a healthy LAN. Dropping anything out of order would sound like
    // loss, so up to this many early packets are held until the gap fills; a sequence number is
    // skipped only when the window overflows.
    private static final int REORDER_WINDOW_MAX = 8;

    public interface Listener {
        // Guest joins only: the verification PIN, computed locally from both TLS certificates or,
        // if that fails, as reported by the host.
        void onPinComputed(String pin);
        void onAdmitted(String hostName);
        void onFormat(int sampleRate, int channels, int bitsPerSample, boolean isFloat);
        void onHostMuted(boolean muted);
        void onEnded();
        void onClosed(String reason);
        void onError(String message);
        /** Playback telemetry, about once a second while listening.
         *  latencyMs  = smoothed capture-to-arrival offset, corrected by the probed clock offset
         *               when clockSynced is true; otherwise it includes the two clocks' skew.
         *  bufferMs   = current usable AudioTrack buffer depth.
         *  underruns  = cumulative AudioTrack underruns (buffer too shallow).
         *  dropped    = chunks discarded because the playback queue was full (writer too slow).
         *               Reported separately from underruns because the fixes are opposite. */
        void onStats(long latencyMs, int bufferMs, int underruns, int dropped, boolean clockSynced);
    }

    private final Context context;
    private final Listener listener;
    private WebSocketClient client;
    private AudioTrack audioTrack;
    private int sampleRate;
    private int channels;
    private int bitsPerSample;
    private boolean isFloatFormat;

    private String hostAddress;
    // The UDP port is controlPort + 1 (see setupUdp). Audio Relay and Walkie Talkie's listening
    // leg share this class on different port pairs, so the UDP port is never hardcoded.
    private int controlPort;
    private volatile boolean resolved = false;
    private final java.util.List<WebSocketClient> pendingClients = new java.util.concurrent.CopyOnWriteArrayList<>();
    private DatagramSocket udpSocket;
    private Thread udpReceiveThread;
    private volatile boolean udpRunning = false;
    private byte[] sessionKey;
    private SecretKeySpec sessionKeySpec; // cached per key, rebuilt when sessionKey changes
    private int nextExpectedSeq = -1; // -1 = not bootstrapped yet; accept whatever arrives first
    private final java.util.TreeMap<Integer, byte[]> reorderBuffer = new java.util.TreeMap<>(); // seq -> decrypted PCM payload

    // --- Clock-drift correction ---
    // The host's and this device's audio clocks run at slightly different rates, so playback
    // slowly drifts away from the live capture. playOffset = arrivalMs (local clock) - captureMs
    // (host clock, from the UDP frame). A constant playOffset is just transport and buffer latency;
    // only its change over time is corrected. A growing offset means local playback is falling
    // behind, so AudioTrack.setPlaybackRate() is nudged up; a shrinking one nudges it down.
    //
    // An EMA of playOffset (EMA_ALPHA) is compared with a baseline averaged over the first
    // BASELINE_SAMPLES packets, and the correction is clamped to MAX_RATE_CORRECTION.
    private long baselineOffsetMs = Long.MIN_VALUE;  // set once, from the first ~1s of measurements
    private double smoothedOffsetMs = 0;             // EMA of playOffset
    private int baselineSampleCount = 0;
    private long baselineAccumMs = 0;
    private static final int BASELINE_SAMPLES = 50; // ~1s of audio at 10ms Opus cadence
    private static final long STATS_INTERVAL_MS = 1000;
    private long lastStatsEmitMs = 0;

    // --- Adaptive playback buffer ---
    // The right buffer depth depends on the device's scheduling and the link, so it is measured
    // rather than fixed. Playback starts at ADAPT_START_MS and shrinks a step after each clean
    // ADAPT_INTERVAL_MS. An underrun grows the buffer and raises a floor so the controller does
    // not return to a depth that has already failed on this device.
    //
    // AudioTrack cannot be resized after construction, so this caps the usable part of the
    // allocated buffer with setBufferSizeInFrames.
    // Wi-Fi delivers in bursts with gaps of tens of milliseconds, so the ceiling (and the
    // allocation) leaves room to ride out a long gap; a clean link still settles far lower.
    private static final int ADAPT_CEILING_MS = 60;
    private static final int ADAPT_START_MS = 28;
    // Above one OPUS_FRAME_MS frame, below which underruns are guaranteed.
    private static final int ADAPT_ABSOLUTE_MIN_MS = 16;
    private static final int ADAPT_SHRINK_STEP_MS = 2;
    private static final int ADAPT_GROW_STEP_MS = 4;  // recover faster than it probes downward
    // Long enough for a marginal depth to show a glitch before the next shrink step.
    private static final long ADAPT_INTERVAL_MS = 5000;
    private int adaptFloorMs = ADAPT_ABSOLUTE_MIN_MS;
    private int adaptCurrentMs = ADAPT_START_MS;
    private int lastAdaptUnderruns = -1;
    private long lastAdaptMs = 0;

    // Decoded PCM waiting for the writer thread. Bounded so a slow writer cannot build up hidden
    // latency: at a 10 ms Opus cadence this holds about 160 ms, enough for a scheduling hiccup.
    private static final int PLAYBACK_QUEUE_CAPACITY = 16;
    private final java.util.concurrent.BlockingQueue<byte[]> playbackQueue =
        new java.util.concurrent.ArrayBlockingQueue<>(PLAYBACK_QUEUE_CAPACITY);
    private volatile boolean playbackWriterRunning = false;
    private Thread playbackWriterThread;
    private volatile int droppedChunks = 0;

    // --- Backlog control ---
    // Audio arrives exactly as fast as it plays, so anything that queues up behind the track (a
    // Wi-Fi burst after a gap, a slow moment on this phone) would otherwise stay as extra delay for
    // the rest of the session. When the queue has not been empty once in a whole window, one chunk
    // is skipped, blended over CROSSFADE_MS so the cut cannot be heard. Delay therefore returns to
    // the track's own (adaptive) buffer within a few seconds of any hiccup.
    private static final long BACKLOG_WINDOW_MS = 250;
    private static final int CROSSFADE_MS = 3;
    private volatile int skippedForLatency = 0;
    // The last rate given to setPlaybackRate, so it is only called when the correction changes.
    private int appliedPlaybackRate = -1;

    // --- Clock offset (NTP-style) ---
    // Frames carry the host's wall-clock capture time, so arrival - capture includes the
    // difference between the two clocks, which can exceed the latency itself. Probes over the
    // control socket estimate it: this device sends t1, the host replies with t2, the reply
    // arrives at t3, and offset = ((t2 - t1) + (t2 - t3)) / 2 assuming a symmetric path. The probe
    // with the smallest round trip is kept, since queuing delay makes a probe asymmetric.
    // Only the reported latency uses this; drift correction measures change over time, where a
    // constant bias cancels out.
    private static final int CLOCK_PROBES = 5;
    private static final long CLOCK_PROBE_SPACING_MS = 200;
    private volatile long clockOffsetMs = 0;
    private volatile boolean clockOffsetKnown = false;
    private long bestProbeRttMs = Long.MAX_VALUE;
    private static final long CLOCK_RESYNC_INTERVAL_MS = 15000;
    private long lastClockSyncMs = 0;
    private static final double EMA_ALPHA = 0.02;   // slow smoothing — reacts in ~50 frames
    // setPlaybackRate() resamples, so a large correction is an audible pitch change, heard as
    // wow/flutter because the loop adjusts continuously. Crystal drift between devices is around
    // 50-100 ppm, so 0.2% leaves ample headroom while staying inaudible.
    private static final double MAX_RATE_CORRECTION = 0.002;
    // Accumulated drift is nulled over this many seconds. A faster gain overshoots and hunts
    // instead of settling.
    private static final double DRIFT_CORRECTION_SECONDS = 30.0;

    // Reused for every packet: Cipher.getInstance() provider lookup is costly enough on Android to
    // make the receive thread fall behind at this packet rate. init() with a fresh IV per packet
    // is cheap.
    private Cipher decryptCipher;
    // Created in handleControlMessage() (the WebSocket thread) on each "format" message; fed from
    // the UDP receive thread, so volatile.
    private volatile LinkOpusDecoder opusDecoder;

    // High-performance Wi-Fi lock and partial wake lock, held for the whole listen session (same
    // pattern as LinkFsServer). Without them, aggressive OEM power management can suspend the
    // Wi-Fi radio or reclaim the process while background audio is the only activity.
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private android.os.PowerManager.WakeLock wakeLock;

    public LinkAudioSinkClient(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    private void acquireLocks() {
        try {
            android.net.wifi.WifiManager wifiManager =
                (android.net.wifi.WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                wifiLock = wifiManager.createWifiLock(
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Link:audiosink-wifi");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
            android.os.PowerManager pm = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "Link:audiosink-cpu");
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

    private String localDeviceName = "Guest";
    private boolean pinComputedLocally = false;

    // A scanned QR already verified the host, so there is no code to compare: the screen shows none.
    private void reportPin(LinkGuestAccess.Scan scan, X509Certificate myCert) {
        if (scan != null) {
            pinComputedLocally = true;
            listener.onPinComputed("");
            return;
        }
        computeAndReportPin(myCert);
    }

    private void computeAndReportPin(X509Certificate myCert) {
        try {
            java.net.Socket socket = client.getSocket();
            if (socket instanceof javax.net.ssl.SSLSocket) {
                java.security.cert.Certificate[] chain = ((javax.net.ssl.SSLSocket) socket).getSession().getPeerCertificates();
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

    public void connect(final String host, final int port, final X509Certificate myCert, final PrivateKey myKey, final String token, String localDeviceName) {
        this.localDeviceName = localDeviceName != null ? localDeviceName : "Guest";
        Log.i(TAG, "connect() to " + host + ":" + port + " mode=" + (token != null ? "paired-token" : "guest-pin"));
        
        String[] hosts = host.split(",");
        for (int i = 0; i < hosts.length; i++) {
            hosts[i] = hosts[i].trim();
        }

        if (hosts.length <= 1) {
            connectSingle(host, port, myCert, myKey, token);
            return;
        }

        resolved = false;
        pendingClients.clear();
        acquireLocks();

        try {
            final SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);
            
            for (final String singleHost : hosts) {
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            final LinkGuestAccess.Scan scan = LinkGuestAccess.takeScan(singleHost);
                            URI uri = new URI(LinkGuestAccess.address(singleHost, port, scan));
                            final WebSocketClient ws = new WebSocketClient(uri) {
                                @Override
                                public void onOpen(ServerHandshake handshakedata) {
                                    if (!LinkGuestAccess.verifyHost(scan, this)) {
                                        listener.onError(LinkGuestAccess.MISMATCH);
                                        try { close(); } catch (Exception ignored) {}
                                        return;
                                    }
                                    synchronized (LinkAudioSinkClient.this) {
                                        if (resolved) {
                                            try { close(); } catch (Exception ignored) {}
                                            return;
                                        }
                                        resolved = true;
                                        client = this;
                                        hostAddress = singleHost;
                                        controlPort = port;

                                        // First host to connect wins; close the other attempts.
                                        for (WebSocketClient c : pendingClients) {
                                            if (c != this) {
                                                try { c.close(); } catch (Exception ignored) {}
                                            }
                                        }
                                        pendingClients.clear();
                                    }

                                    Log.i(TAG, "onOpen (" + singleHost + ") — TLS handshake complete, sending join message");
                                    if (token != null) {
                                        sendJoin("join-token", "token", token);
                                    } else {
                                        pinComputedLocally = false;
                                        reportPin(scan, myCert);
                                        sendJoin("join-guest", null, null);
                                    }
                                }

                                @Override
                                public void onMessage(String message) {
                                    if (client == this) {
                                        handleControlMessage(message);
                                    }
                                }

                                @Override
                                public void onMessage(ByteBuffer bytes) {
                                    Log.w(TAG, "Unexpected binary WebSocket message (" + bytes.remaining() + " bytes) — ignoring");
                                }

                                @Override
                                public void onClose(int code, String reason, boolean remote) {
                                    if (client == this) {
                                        Log.i(TAG, "onClose code=" + code + " reason=" + reason + " remote=" + remote);
                                        stopPlayback();
                                        stopUdp();
                                        releaseLocks();
                                        listener.onClosed(reason != null && !reason.isEmpty() ? reason : ("code " + code));
                                    }
                                }

                                @Override
                                public void onError(Exception ex) {
                                    if (client == this) {
                                        Log.e(TAG, "onError", ex);
                                        stopUdp();
                                        releaseLocks();
                                        listener.onError(ex.getMessage());
                                    } else if (!resolved) {
                                        Log.w(TAG, "Failed connection attempt to " + singleHost + ": " + ex.getMessage());
                                        pendingClients.remove(this);
                                        if (pendingClients.isEmpty()) {
                                            releaseLocks();
                                            listener.onError("All connection attempts failed. Last error: " + ex.getMessage());
                                        }
                                    }
                                }
                            };
                            ws.setSocketFactory(sslContext.getSocketFactory());
                            pendingClients.add(ws);
                            ws.connect();
                        } catch (Exception e) {
                            Log.w(TAG, "Failed to connect to " + singleHost, e);
                        }
                    }
                }).start();
            }
        } catch (Exception e) {
            releaseLocks();
            listener.onError("Failed to initialize parallel connect: " + e.getMessage());
        }
    }

    private void connectSingle(String host, int port, X509Certificate myCert, PrivateKey myKey, final String token) {
        this.hostAddress = host;
        this.controlPort = port;
        try {
            final LinkGuestAccess.Scan scan = LinkGuestAccess.takeScan(host);
            URI uri = new URI(LinkGuestAccess.address(host, port, scan));
            SSLContext sslContext = LinkTransport.buildSslContext(myCert, myKey);
            acquireLocks();

            client = new WebSocketClient(uri) {
                @Override
                public void onOpen(ServerHandshake handshakedata) {
                    if (!LinkGuestAccess.verifyHost(scan, this)) {
                        listener.onError(LinkGuestAccess.MISMATCH);
                        try { close(); } catch (Exception ignored) {}
                        return;
                    }
                    Log.i(TAG, "onOpen — TLS handshake complete, sending join message");
                    if (token != null) {
                        sendJoin("join-token", "token", token);
                    } else {
                        pinComputedLocally = false;
                        reportPin(scan, myCert);
                        sendJoin("join-guest", null, null);
                    }
                }

                @Override
                public void onMessage(String message) {
                    handleControlMessage(message);
                }

                @Override
                public void onMessage(ByteBuffer bytes) {
                    // Audio arrives over UDP, so nothing legitimate is binary here. Kept because
                    // some versions of the WebSocket library declare this method abstract.
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
                    // Some failure paths fire onError without onClose; both cleanup calls are
                    // no-ops if already torn down.
                    stopUdp();
                    releaseLocks();
                    listener.onError(ex.getMessage());
                }
            };
            // With this library, setSocketFactory is what makes the connection wss://. Same
            // self-signed trust model as the rest of the app (LinkTransport.buildSslContext).
            client.setSocketFactory(sslContext.getSocketFactory());
            client.connect();
        } catch (Exception e) {
            releaseLocks();
            listener.onError("Failed to connect: " + e.getMessage());
        }
    }

    // Local mute for this listener only (the host's mute silences every listener). Used by the
    // session notification's Mute button; lastVolume lets unmute restore the previous volume.
    private volatile boolean locallyMuted = false;
    private volatile float lastVolume = 1f;

    /** Playback is native (AudioTrack) rather than in the WebView, to avoid base64-encoding every
     *  chunk across the plugin bridge, so the UI volume slider calls this through LinkAudioSessions. */
    public void setVolume(float volume) {
        lastVolume = volume;
        locallyMuted = false;
        applyVolume(volume);
    }

    public void toggleLocalMute() {
        locallyMuted = !locallyMuted;
        applyVolume(locallyMuted ? 0f : lastVolume);
    }

    public boolean isLocallyMuted() {
        return locallyMuted;
    }

    private void applyVolume(float volume) {
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
            if ("join-guest".equals(type)) {
                obj.put("deviceName", localDeviceName);
            }
            Log.i(TAG, "sending join message: " + type);
            client.send(obj.toString());
        } catch (Exception e) {
            Log.e(TAG, "Failed to send join message", e);
        }
    }

    private void handleControlMessage(String message) {
        try {
            JSONObject obj = new JSONObject(message);
            String type = obj.optString("type");
            Log.i(TAG, "control message: " + type);
            if ("clock-pong".equals(type)) {
                handleClockPong(obj.optLong("t1", 0), obj.optLong("t2", 0));
            } else if ("admitted".equals(type)) {
                String hostName = obj.optString("hostName", "");
                setupUdp(obj.optString("connId", null), obj.optString("udpKey", null));
                listener.onAdmitted(hostName);
                startClockSync();
            } else if ("format".equals(type)) {
                sampleRate = obj.getInt("sampleRate");
                channels = obj.getInt("channels");
                bitsPerSample = obj.getInt("bitsPerSample");
                isFloatFormat = obj.getBoolean("isFloat");
                Log.i(TAG, "format: " + sampleRate + "Hz " + channels + "ch");
                // A new format replaces the old decoder; it is released rather than leaked with its
                // codec and callback thread. Every host sends Opus.
                LinkOpusDecoder previous = opusDecoder;
                opusDecoder = null;
                if (previous != null) previous.release();
                try {
                    opusDecoder = new LinkOpusDecoder(sampleRate, channels, OPUS_FRAME_MS * 1000, this::onDecodedPcm);
                } catch (Exception e) {
                    Log.e(TAG, "Failed to initialize Opus decoder", e);
                    listener.onError("This device could not start an Opus decoder, so the audio cannot play.");
                }
                startPlayback();
                listener.onFormat(sampleRate, channels, bitsPerSample, isFloatFormat);
            } else if ("hostMuted".equals(type)) {
                listener.onHostMuted(obj.optBoolean("muted", false));
            } else if ("ended".equals(type)) {
                listener.onEnded();
            } else if ("pin".equals(type) && !pinComputedLocally) {
                listener.onPinComputed(obj.optString("code"));
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse control message", e);
        }
    }

    private int chunksReceived = 0;

    /** Opens the session's UDP socket and sends the "hello" datagram that tells the host where to
     *  send audio. */
    private void setupUdp(String connId, String udpKeyBase64) {
        if (connId == null || udpKeyBase64 == null) {
            Log.w(TAG, "admitted message missing connId/udpKey — cannot set up UDP audio");
            return;
        }
        try {
            sessionKey = Base64.decode(udpKeyBase64, Base64.NO_WRAP);
            sessionKeySpec = null;
            nextExpectedSeq = -1;
            reorderBuffer.clear();
            baselineOffsetMs = Long.MIN_VALUE;
            smoothedOffsetMs = 0;
            baselineSampleCount = 0;
            baselineAccumMs = 0;
            decryptCipher = Cipher.getInstance("AES/GCM/NoPadding");
            udpSocket = new DatagramSocket();
            // The host sends bursts of sub-packets (MAX_UDP_PCM_BYTES each), and the OS default
            // receive buffer can drop the tail of a burst if this thread is briefly descheduled.
            // 128 KB is about 10x a worst-case burst; much larger would only hide a backlog as
            // added latency.
            udpSocket.setReceiveBufferSize(1 << 17); // 128KB
            udpSocket.send(new DatagramPacket(
                connId.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                connId.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,
                InetAddress.getByName(hostAddress), controlPort + 1));

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
            }, "LinkAudioSinkClient-udp");
            udpReceiveThread.start();
        } catch (Exception e) {
            listener.onError("Failed to set up UDP audio socket: " + e.getMessage());
        }
    }

    private void handleUdpFrame(byte[] data, int length) {
        // Frame layout: [seq:4][ts:6][nonce:12][encrypted payload + 16-byte GCM tag]
        int minLen = UDP_SEQ_BYTES + UDP_TS_BYTES + UDP_NONCE_BYTES + 16;
        if (sessionKey == null || length < minLen) return;

        ByteBuffer bb = ByteBuffer.wrap(data, 0, length);
        int seq = bb.getInt();

        // 6-byte capture timestamp: [hi:2 unsigned][lo:4 unsigned]
        long tsHi = (bb.getShort() & 0xFFFFL);
        long tsLo = (bb.getInt() & 0xFFFFFFFFL);
        long captureMs = (tsHi << 32) | tsLo;
        long arrivalMs = System.currentTimeMillis();
        updateDriftCorrection(captureMs, arrivalMs);

        byte[] nonce = new byte[UDP_NONCE_BYTES];
        bb.get(nonce);
        byte[] ciphertext = new byte[length - UDP_SEQ_BYTES - UDP_TS_BYTES - UDP_NONCE_BYTES];
        bb.get(ciphertext);

        byte[] payload;
        try {
            SecretKeySpec keySpec = sessionKeySpec;
            if (keySpec == null) sessionKeySpec = keySpec = new SecretKeySpec(sessionKey, "AES");
            decryptCipher.init(Cipher.DECRYPT_MODE, keySpec, new GCMParameterSpec(128, nonce));
            payload = decryptCipher.doFinal(ciphertext); // throws on auth-tag mismatch (wrong key, corrupted or spoofed)
        } catch (Exception e) {
            return; // drop silently, as desktop's core/audio_sink.rs does
        }

        acceptDecrypted(seq, payload);
    }

    /** Updates the smoothed play-offset and adjusts the playback rate to cancel drift. Runs on the
     *  UDP receive thread; if the track is not playing yet the rate update is simply skipped. */
    private void updateDriftCorrection(long captureMs, long arrivalMs) {
        long offsetMs = arrivalMs - captureMs;

        // Phase 1: average a baseline over the first BASELINE_SAMPLES packets.
        if (baselineOffsetMs == Long.MIN_VALUE) {
            baselineAccumMs += offsetMs;
            baselineSampleCount++;
            if (baselineSampleCount >= BASELINE_SAMPLES) {
                baselineOffsetMs = baselineAccumMs / baselineSampleCount;
                smoothedOffsetMs = baselineOffsetMs;
                Log.i(TAG, "Drift correction baseline established: " + baselineOffsetMs + " ms");
            }
            return;
        }

        // Phase 2: compare the EMA of the offset against the baseline.
        smoothedOffsetMs = EMA_ALPHA * offsetMs + (1.0 - EMA_ALPHA) * smoothedOffsetMs;
        double driftMs = smoothedOffsetMs - baselineOffsetMs;

        // Positive drift means playback is falling behind, so play faster; negative, slower.
        double correction = driftMs / (DRIFT_CORRECTION_SECONDS * 1000.0);
        correction = Math.max(-MAX_RATE_CORRECTION, Math.min(MAX_RATE_CORRECTION, correction));
        int correctedRate = (int) Math.round(sampleRate * (1.0 + correction));

        AudioTrack track = audioTrack;
        if (track != null && track.getPlayState() == AudioTrack.PLAYSTATE_PLAYING && correctedRate != appliedPlaybackRate) {
            try {
                track.setPlaybackRate(correctedRate);
                appliedPlaybackRate = correctedRate;
            } catch (Exception e) {
                Log.w(TAG, "setPlaybackRate failed: " + e.getMessage());
            }
        }

        emitStatsThrottled(track);
    }

    /** Sends a short burst of clock probes. They are spaced out so they do not queue behind each
     *  other, which would defeat keeping the fastest one. */
    private void startClockSync() {
        android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
        for (int i = 0; i < CLOCK_PROBES; i++) {
            final int index = i;
            handler.postDelayed(() -> {
                try {
                    org.java_websocket.client.WebSocketClient c = client;
                    if (c == null || !c.isOpen()) {
                        Log.w(TAG, "clock probe " + index + " skipped — control socket not open");
                        return;
                    }
                    JSONObject ping = new JSONObject();
                    ping.put("type", "clock-ping");
                    ping.put("t1", System.currentTimeMillis());
                    c.send(ping.toString());
                    Log.i(TAG, "clock probe " + index + " sent");
                } catch (Exception e) {
                    Log.w(TAG, "clock probe " + index + " failed: " + e.getMessage());
                }
            }, index * CLOCK_PROBE_SPACING_MS);
        }

        // Every probe lost (the host always answers clock-ping): latency stays uncorrected.
        handler.postDelayed(() -> {
            if (!clockOffsetKnown) {
                Log.w(TAG, "No clock-pong after " + CLOCK_PROBES + " probes. Reporting UNCORRECTED latency.");
            }
        }, CLOCK_PROBES * CLOCK_PROBE_SPACING_MS + 2000);
    }

    private void handleClockPong(long t1, long t2) {
        if (t1 <= 0 || t2 <= 0) return;
        long t3 = System.currentTimeMillis();
        long rtt = t3 - t1;
        if (rtt < 0 || rtt > 5000) return; // nonsense sample, ignore
        if (rtt >= bestProbeRttMs) return; // keep only the least-delayed probe

        bestProbeRttMs = rtt;
        clockOffsetMs = ((t2 - t1) + (t2 - t3)) / 2;
        clockOffsetKnown = true;
        Log.i(TAG, "Clock offset " + clockOffsetMs + " ms (rtt " + rtt + " ms)");
    }

    /** Converges the usable buffer depth on the shallowest value this device sustains. Runs on the
     *  UDP receive thread from the stats tick; setBufferSizeInFrames is cheap and does not block. */
    private void adaptBuffer(AudioTrack track, int underruns) {
        if (track == null || sampleRate <= 0) return;

        long now = System.currentTimeMillis();
        if (lastAdaptUnderruns < 0) { // first tick — record the starting point, change nothing yet
            lastAdaptUnderruns = underruns;
            lastAdaptMs = now;
            applyBufferMs(track, adaptCurrentMs);
            return;
        }
        // Grow on the next stats tick after an underrun to limit audible glitches; shrink only
        // after a clean ADAPT_INTERVAL_MS.
        boolean glitched = underruns > lastAdaptUnderruns;
        if (!glitched && now - lastAdaptMs < ADAPT_INTERVAL_MS) return;
        lastAdaptUnderruns = underruns;
        lastAdaptMs = now;

        if (glitched) {
            // Raise the floor above the failed depth so the controller does not oscillate back
            // into it.
            adaptFloorMs = Math.min(ADAPT_CEILING_MS, adaptCurrentMs + ADAPT_SHRINK_STEP_MS);
            adaptCurrentMs = Math.min(ADAPT_CEILING_MS, adaptCurrentMs + ADAPT_GROW_STEP_MS);
            Log.i(TAG, "Buffer: underrun at depth, growing to " + adaptCurrentMs + "ms (floor now " + adaptFloorMs + "ms)");
            applyBufferMs(track, adaptCurrentMs);
        } else if (adaptCurrentMs - ADAPT_SHRINK_STEP_MS >= adaptFloorMs) {
            adaptCurrentMs -= ADAPT_SHRINK_STEP_MS;
            Log.i(TAG, "Buffer: clean, shrinking to " + adaptCurrentMs + "ms");
            applyBufferMs(track, adaptCurrentMs);
        }
    }

    private void applyBufferMs(AudioTrack track, int ms) {
        try {
            int frames = (int) ((long) ms * sampleRate / 1000);
            int applied = track.setBufferSizeInFrames(frames);
            if (applied > 0) {
                // The HAL may round to its own period; track the applied size so the next step
                // starts from the real depth.
                adaptCurrentMs = (int) (applied * 1000L / sampleRate);
            }
        } catch (Exception e) {
            Log.w(TAG, "setBufferSizeInFrames failed: " + e.getMessage());
        }
    }

    private void emitStatsThrottled(AudioTrack track) {
        long now = System.currentTimeMillis();
        if (now - lastStatsEmitMs < STATS_INTERVAL_MS) return;
        lastStatsEmitMs = now;

        int underruns = 0;
        if (track != null) {
            try {
                underruns = track.getUnderrunCount();
            } catch (Exception ignored) {}
        }

        adaptBuffer(track, underruns);

        // Re-probe periodically: the clocks keep drifting after admission, and with latency of a
        // few milliseconds a stale offset can push the reading below zero. Resetting the best RTT
        // lets the new round replace the old estimate.
        if (now - lastClockSyncMs > CLOCK_RESYNC_INTERVAL_MS) {
            lastClockSyncMs = now;
            bestProbeRttMs = Long.MAX_VALUE;
            startClockSync();
        }

        int bufferMs = 0;
        if (track != null && sampleRate > 0) {
            int bytesPerFrame = channels * (bitsPerSample / 8);
            if (bytesPerFrame > 0) {
                bufferMs = (int) (track.getBufferSizeInFrames() * 1000L / sampleRate);
            }
        }

        // Without a clock offset the raw figure is reported, flagged as unsynced. With one, the
        // offset is added: clockOffsetMs is (host clock - local clock) and smoothedOffsetMs is
        // (local arrival - host capture), so in the host's timebase
        //     latency = (arrival_local + offset) - capture_host = smoothedOffsetMs + clockOffsetMs
        long reportedLatencyMs = clockOffsetKnown
            ? Math.round(smoothedOffsetMs + clockOffsetMs)
            : Math.round(smoothedOffsetMs);

        // A negative synced reading is physically impossible and indicates a bad clock estimate.
        if (clockOffsetKnown && reportedLatencyMs < 0) {
            Log.w(TAG, "Negative synced latency (" + reportedLatencyMs + " ms) — clock correction is wrong: "
                + "raw=" + Math.round(smoothedOffsetMs) + " offset=" + clockOffsetMs);
        }

        try {
            listener.onStats(reportedLatencyMs, bufferMs, underruns, droppedChunks, clockOffsetKnown);
        } catch (Exception ignored) {}
    }

    /** Delivers packets in sequence order, holding early arrivals (see REORDER_WINDOW_MAX). Called
     *  only from the UDP receive thread, so nextExpectedSeq and reorderBuffer need no locking. */
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

        // Early packet: hold it in case the gap is reordering. If the window overflows, treat the
        // gap as lost and skip ahead.
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

        if (codecTag == CODEC_TAG_OPUS) {
            LinkOpusDecoder decoder = opusDecoder;
            if (decoder == null) return; // unavailable — already surfaced via onError() in handleControlMessage
            try {
                // Its PCM comes back through onDecodedPcm, on the decoder's own thread.
                decoder.decode(body);
            } catch (Exception e) {
                Log.w(TAG, "Opus decode failed for a frame, dropping it", e);
            }
        } else {
            Log.w(TAG, "Unknown codec tag " + codecTag + " — dropping frame");
        }
    }

    /** Takes decoded PCM from the Opus decoder's callback thread. */
    private void onDecodedPcm(byte[] pcm) {
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
        sessionKeySpec = null;
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
        // Opus always decodes to 16-bit integers.
        int encoding = AudioFormat.ENCODING_PCM_16BIT;

        int minBufferSize = AudioTrack.getMinBufferSize(sampleRate, channelConfig, encoding);
        if (minBufferSize <= 0) {
            listener.onError("Unsupported audio format for this device: " + sampleRate + "Hz/" + channels + "ch/" + bitsPerSample + "bit");
            return;
        }

        // In low-latency mode Builder.build() can throw ("Invalid audio buffer size") on a size the
        // HAL dislikes, so each attempt is isolated and falls through to the next:
        //   1. Low-latency, sized in multiples of the native fast-mixer period (only when the
        //      native output rate matches the stream rate).
        //   2. Low-latency with getMinBufferSize(), which some devices accept.
        //   3. Normal mode with some jitter headroom: the universal fallback.
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

        // Re-learn the floor each session; conditions that forced a deeper buffer may have changed.
        adaptFloorMs = ADAPT_ABSOLUTE_MIN_MS;
        adaptCurrentMs = ADAPT_START_MS;
        lastAdaptUnderruns = -1;
        lastAdaptMs = 0;
        droppedChunks = 0;

        try {
            audioTrack.play();
            startPlaybackWriter();
            Log.i(TAG, "Playback started: " + sampleRate + "Hz " + channels + "ch, playState=" + audioTrack.getPlayState());
        } catch (Exception e) {
            Log.e(TAG, "audioTrack.play() failed", e);
            listener.onError("Failed to start audio playback: " + e.getMessage());
        }
    }

    /** Buffer size in bytes for the low-latency path, as a whole number of native output periods
     *  (AudioManager.PROPERTY_OUTPUT_*). Returns null if the native rate differs from the stream
     *  rate, since low-latency mode needs them to match, or if the properties are unavailable. */
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
            // A single native period (often ~3 ms) underruns between Wi-Fi bursts, so the track
            // is allocated at ADAPT_CEILING_MS, rounded up to whole periods because some
            // low-latency HALs reject other sizes. This is the ceiling adaptBuffer() works within,
            // not the running depth. It stays modest because an oversized allocation can lose the
            // low-latency fast path.
            int targetBufferMs = ADAPT_CEILING_MS;
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

    /** Returns an initialized AudioTrack, or null if the build threw or produced an uninitialized
     *  track, so the caller can try the next fallback. */
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

            if (lowLatency) {
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

    /** Hands a decoded chunk to the playback writer thread without blocking. This runs on the UDP
     *  receive thread, and a blocking AudioTrack.write here would stop the socket being drained,
     *  causing both queueing latency in the kernel buffer and underruns. */
    private void playChunk(byte[] pcm) {
        if (audioTrack == null) return;
        // Queue full: drop the oldest chunk so the backlog, and therefore latency, stays bounded.
        while (!playbackQueue.offer(pcm)) {
            if (playbackQueue.poll() == null) break;
            droppedChunks++;
        }
    }

    /** Owns every AudioTrack.write. Blocking here is harmless — nothing else waits on this thread. */
    private void startPlaybackWriter() {
        stopPlaybackWriter();
        playbackWriterRunning = true;
        playbackWriterThread = new Thread(() -> {
            long windowStart = System.currentTimeMillis();
            int fewestQueued = Integer.MAX_VALUE;
            while (playbackWriterRunning) {
                byte[] pcm;
                try {
                    pcm = playbackQueue.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
                if (pcm == null) {
                    // Starved: there is no backlog to speak of.
                    fewestQueued = 0;
                    continue;
                }

                fewestQueued = Math.min(fewestQueued, playbackQueue.size());
                long now = System.currentTimeMillis();
                if (now - windowStart >= BACKLOG_WINDOW_MS) {
                    if (fewestQueued >= 1) {
                        byte[] skipped = playbackQueue.poll();
                        if (skipped != null) {
                            pcm = skipWithCrossfade(pcm, skipped);
                            skippedForLatency++;
                        }
                    }
                    windowStart = now;
                    fewestQueued = Integer.MAX_VALUE;
                }

                AudioTrack track = audioTrack;
                if (track == null) continue;
                try {
                    track.write(pcm, 0, pcm.length);
                } catch (Exception e) {
                    Log.e(TAG, "Error writing audio chunk", e);
                }
            }
        }, "link-audio-playback");
        playbackWriterThread.setPriority(Thread.MAX_PRIORITY);
        playbackWriterThread.start();
    }

    /** Plays `current` in place of `current` followed by `skipped`: its ending is blended into the
     *  end of `skipped`, so what comes next carries on from there without a click. */
    byte[] skipWithCrossfade(byte[] current, byte[] skipped) {
        int frameBytes = Math.max(1, channels) * 2;
        int fadeFrames = Math.max(1, sampleRate * CROSSFADE_MS / 1000);
        int fadeBytes = fadeFrames * frameBytes;
        if (current.length < fadeBytes || skipped.length < fadeBytes) return current;

        byte[] out = current.clone();
        ByteBuffer a = ByteBuffer.wrap(current).order(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer b = ByteBuffer.wrap(skipped).order(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer o = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN);
        int aStart = current.length - fadeBytes;
        int bStart = skipped.length - fadeBytes;
        int samples = fadeBytes / 2;
        int perFrame = fadeBytes / fadeFrames / 2;
        for (int i = 0; i < samples; i++) {
            double w = (double) (i / perFrame + 1) / (fadeFrames + 1);
            double mixed = a.getShort(aStart + i * 2) * (1.0 - w) + b.getShort(bStart + i * 2) * w;
            o.putShort(aStart + i * 2, (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(mixed))));
        }
        return out;
    }

    private void stopPlaybackWriter() {
        playbackWriterRunning = false;
        Thread t = playbackWriterThread;
        if (t != null) {
            t.interrupt();
            playbackWriterThread = null;
        }
        playbackQueue.clear();
    }

    private void stopPlayback() {
        // Stop the writer first so it is not mid-write when the track is released.
        stopPlaybackWriter();
        if (audioTrack != null) {
            try {
                audioTrack.stop();
                audioTrack.release();
            } catch (Exception ignored) {}
            audioTrack = null;
        }
    }
}
