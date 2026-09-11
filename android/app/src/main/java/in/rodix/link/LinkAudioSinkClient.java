package in.rodix.link;

// Audio Relay — listener side, mirroring desktop's audio-sink-client.ts protocol exactly (see
// that file's header comment for the full wire protocol: JSON control messages for join/admit/
// format/mute/end over WebSocket, PCM audio over a separate UDP channel). Deliberately independent
// of LinkDeviceManager/LinkTrustStore — an admitted listener here never becomes a paired device.
//
// PCM arrives over LinkTransport.AUDIO_RELAY_UDP_PORT, not this WebSocket — see audio-sink-
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
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLContext;

public class LinkAudioSinkClient {
    private static final String TAG = "LinkAudioSinkClient";
    private static final byte CODEC_TAG_PCM = 0x00;
    private static final byte CODEC_TAG_OPUS = 0x01;
    // Must match desktop's OPUS_FRAME_MS in audio-sink-server.ts and this project's own
    // LinkAudioSinkServer.OPUS_FRAME_MS — Opus mandates fixed frame durations, and this is only
    // used to drive LinkOpusDecoder's presentation-timestamp bookkeeping (monotonic, not
    // wall-clock-critical), not to parse anything on the wire. History: 20ms -> 10ms (confirmed
    // good) -> 5ms (reverted — real throughput ceiling on Android's MediaCodec path, see
    // LinkAudioSinkServer's OPUS_FRAME_MS comment for the full reasoning).
    private static final int OPUS_FRAME_MS = 10;
    private static final int UDP_SEQ_BYTES = 4;
    private static final int UDP_TS_BYTES = 6; // capture-time wall-clock ms, [hi:2][lo:4]
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
        // Never actually called — LinkAudioSinkServer.java's join-guest branch admits
        // immediately, there is no PIN gate to report. Kept only because LinkPlugin.java's
        // sAudioSinkClient still implements this interface; not worth a signature change to
        // drop a single always-empty callback.
        void onPinComputed(String pin);
        void onAdmitted(String hostName);
        void onFormat(int sampleRate, int channels, int bitsPerSample, boolean isFloat);
        void onHostMuted(boolean muted);
        void onEnded();
        void onClosed(String reason);
        void onError(String message);
        /** Periodic playback telemetry, ~1/sec while listening.
         *  latencyMs  = smoothed capture->arrival offset (see updateDriftCorrection). Spans two
         *               devices' wall clocks, so it carries their clock skew as a constant bias:
         *               reliable for comparing runs on the same pair of devices, not as an
         *               absolute figure.
         *  bufferMs   = the AudioTrack buffer's own contribution, which is real added latency.
         *  underruns  = cumulative AudioTrack underruns — the track ran DRY. Means the buffer is
         *               too shallow for how audio is arriving; raise the buffer depth.
         *  dropped    = chunks discarded at the playback handoff because the queue was FULL, i.e.
         *               the writer could not keep up. The opposite problem, and reported
         *               separately because the two call for opposite fixes — summing them told us
         *               audio was being lost without saying which way. */
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
    // Derived UDP target is controlPort + 1 (see setupUdp) — this class is shared by Audio Relay
    // and Walkie Talkie's listening leg, each on its own port pair, so this must never hardcode
    // AUDIO_RELAY_UDP_PORT the way this field replaced.
    private int controlPort;
    private volatile boolean resolved = false;
    private final java.util.List<WebSocketClient> pendingClients = new java.util.concurrent.CopyOnWriteArrayList<>();
    private DatagramSocket udpSocket;
    private Thread udpReceiveThread;
    private volatile boolean udpRunning = false;
    private byte[] sessionKey;
    private int nextExpectedSeq = -1; // -1 = not bootstrapped yet; accept whatever arrives first
    private final java.util.TreeMap<Integer, byte[]> reorderBuffer = new java.util.TreeMap<>(); // seq -> decrypted PCM payload

    // --- Clock-drift correction ---
    // At session start the phone measures the round-trip delta between the PC's capture timestamp
    // and the phone's own wall clock; drift correction then tracks how that offset changes over
    // time and micro-adjusts AudioTrack.setPlaybackRate() by a fraction of a percent to converge phones on
    // the same play-offset from the live capture, eliminating the audible misalignment caused by
    // each device's independent crystal-clock running at a slightly different frequency.
    //
    // Terminology:
    //   captureMs  = PC wall-clock time (ms) when the audio was captured, from the UDP frame
    //   arrivalMs  = phone wall-clock time (ms) when the packet arrived at the UDP socket
    //   playOffset = arrivalMs - captureMs  (positive = phone is "behind" the capture by this much)
    //
    // A steady, hardware-bounded playOffset is fine — it's just the transport+buffer latency.
    // What we're correcting is the DRIFT: if playOffset GROWS from 80ms to 120ms over 30 seconds,
    // the phone's clock is running slower than the PC's and we need to play back slightly faster.
    // Similarly, a shrinking playOffset means the phone clock is faster and we slow down a tiny bit.
    //
    // Implementation: exponential-moving-average (alpha=0.02, reacts slowly to avoid over-correction)
    // of the measured playOffset, compared against the baseline measured in the first few seconds.
    // The correction is clamped to MAX_RATE_CORRECTION — deliberately tiny, since it resamples.
    private long baselineOffsetMs = Long.MIN_VALUE;  // set once, from the first ~1s of measurements
    private double smoothedOffsetMs = 0;             // EMA of playOffset
    private int baselineSampleCount = 0;
    private long baselineAccumMs = 0;
    private static final int BASELINE_SAMPLES = 50; // ~1s of audio at 10ms Opus cadence
    private static final long STATS_INTERVAL_MS = 1000;
    private long lastStatsEmitMs = 0;

    // Decoded PCM waiting to be written to AudioTrack. Bounded on purpose: this is a live stream,
    // so an unbounded queue would just relocate the bufferbloat it exists to prevent — trading
    // kernel-buffer backlog for heap backlog while latency grows all the same. At a 10ms Opus
    // cadence this caps the handoff at ~160ms of audio, which is slack for a scheduling hiccup
    // without being enough to hide a real throughput problem.
    // --- Adaptive playback buffer ---
    // A fixed buffer depth is always wrong in one direction: sized for the worst case it wastes
    // latency permanently, sized for the best case it crackles the moment the device is busy. The
    // right depth also isn't knowable ahead of time — it depends on the phone's scheduling, the
    // link, and what else is running right now.
    //
    // So it's measured instead. Playback starts at a deliberately safe depth and, for as long as
    // the track reports no new underruns, shrinks a step at a time. The first underrun at a given
    // depth grows the buffer back and raises a floor, so the controller never returns to a depth
    // that has already proven too shallow on this device. It settles at the lowest depth that
    // actually holds, and re-adapts upward if conditions later get worse.
    //
    // Works by capping the USABLE portion of an already-allocated buffer (setBufferSizeInFrames),
    // since AudioTrack cannot be resized after construction. API 24+; below that the allocated
    // depth is simply used as-is.
    // Audio arrives one Opus frame at a time, so OPUS_FRAME_MS is a HARD lower bound on any useful
    // buffer depth: below it the track drains a whole frame's worth before the next frame can
    // physically arrive, and underruns are guaranteed rather than merely likely.
    private static final int ADAPT_CEILING_MS = 28;
    private static final int ADAPT_START_MS = 20;
    // Lowered to 16ms (1.6x 10ms frame) with faster 2ms adaptation steps so robust local Wi-Fi links
    // can settle at ~16-20ms buffer depth matching the PC-to-mobile baseline.
    private static final int ADAPT_ABSOLUTE_MIN_MS = 16;
    private static final int ADAPT_SHRINK_STEP_MS = 2;
    private static final int ADAPT_GROW_STEP_MS = 4;  // recover faster than we probe downward
    // Longer than the first attempt: three seconds was short enough that the controller walked
    // all the way to the floor before the first glitch had a chance to appear, so it was probing
    // downward faster than it could learn. Five seconds of genuinely clean playback per step.
    private static final long ADAPT_INTERVAL_MS = 5000;
    private int adaptFloorMs = ADAPT_ABSOLUTE_MIN_MS;
    private int adaptCurrentMs = ADAPT_START_MS;
    private int lastAdaptUnderruns = -1;
    private long lastAdaptMs = 0;

    private static final int PLAYBACK_QUEUE_CAPACITY = 16;
    private final java.util.concurrent.BlockingQueue<byte[]> playbackQueue =
        new java.util.concurrent.ArrayBlockingQueue<>(PLAYBACK_QUEUE_CAPACITY);
    private volatile boolean playbackWriterRunning = false;
    private Thread playbackWriterThread;
    private volatile int droppedChunks = 0;

    // --- Clock offset (NTP-style) ---
    // The host stamps every audio frame with ITS wall clock, so "arrival - capture" measured here
    // is (true one-way latency + however far apart the two device clocks are). In practice that
    // offset runs into hundreds of milliseconds and frequently exceeds the latency itself, which
    // is what makes the raw figure come out negative and unusable.
    //
    // Standard fix: probe over the control socket. Phone sends t1, host replies with its own t2,
    // reply lands at t3. Assuming a symmetric path, offset = ((t2 - t1) + (t2 - t3)) / 2.
    // The sample with the SMALLEST round trip is kept rather than an average — a probe delayed by
    // queuing is asymmetric and biases the estimate, while the fastest one is the least polluted.
    // This affects the REPORTED number only; drift correction keeps using the raw offset, since it
    // measures change over time and a constant bias cancels out of that anyway.
    private static final int CLOCK_PROBES = 5;
    private static final long CLOCK_PROBE_SPACING_MS = 200;
    private volatile long clockOffsetMs = 0;
    private volatile boolean clockOffsetKnown = false;
    private long bestProbeRttMs = Long.MAX_VALUE;
    private static final long CLOCK_RESYNC_INTERVAL_MS = 15000;
    private long lastClockSyncMs = 0;
    private static final double EMA_ALPHA = 0.02;   // slow smoothing — reacts in ~50 frames
    // setPlaybackRate() resamples, so every correction is a real pitch and tempo change — this is
    // not a free knob. ±1% is roughly a 17-cent shift: plainly audible on any sustained note, and
    // because the loop adjusts continuously it presents as wow/flutter rather than a steady
    // detune. What it is correcting is crystal drift between two devices, which is on the order of
    // 50-100 ppm (0.005-0.01%), so ±1% allowed a correction a hundred times larger than the error
    // it exists to cancel. 0.2% is still ~20x headroom over real drift while staying inaudible.
    private static final double MAX_RATE_CORRECTION = 0.002;
    // Time constant for nulling accumulated drift. The old gain (driftMs / 1000) tried to erase
    // 10ms of drift within a single second — far faster than the drift accumulates, so the loop
    // overshot and hunted continuously instead of settling. Spreading the same correction over
    // ~30s tracks genuine drift comfortably while keeping each adjustment imperceptible.
    private static final double DRIFT_CORRECTION_SECONDS = 30.0;

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
                            URI uri = new URI("wss://" + singleHost + ":" + port);
                            final WebSocketClient ws = new WebSocketClient(uri) {
                                @Override
                                public void onOpen(ServerHandshake handshakedata) {
                                    synchronized (LinkAudioSinkClient.this) {
                                        if (resolved) {
                                            try { close(); } catch (Exception ignored) {}
                                            return;
                                        }
                                        resolved = true;
                                        client = this;
                                        hostAddress = singleHost;
                                        controlPort = port;
                                        
                                        // Clean up all other pending clients
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
                                        computeAndReportPin(myCert);
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
                        pinComputedLocally = false;
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
    // Local-only mute for the LISTENER side (distinct from the host's own setMuted() broadcast,
    // which silences the stream for every listener at once) — used by the active-session
    // notification's Mute/Unmute button. lastVolume tracks whatever the real (non-toggle) volume
    // was last set to, so unmuting restores it instead of always snapping back to 1.0.
    private volatile boolean locallyMuted = false;
    private volatile float lastVolume = 1f;

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
                listener.onPinComputed(obj.optString("code"));
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse control message", e);
        }
    }

    private int chunksReceived = 0;

    /** Opens the UDP socket for this session and sends the one "hello" datagram that lets the
     *  host learn our (address, port) — see audio-sink-server.ts's header comment for the full
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
            baselineOffsetMs = Long.MIN_VALUE;
            smoothedOffsetMs = 0;
            baselineSampleCount = 0;
            baselineAccumMs = 0;
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
        // Frame layout (server-side): [seq:4][ts:6][nonce:12][encrypted payload+16-byte GCM tag]
        int minLen = UDP_SEQ_BYTES + UDP_TS_BYTES + UDP_NONCE_BYTES + 16;
        if (sessionKey == null || length < minLen) return;

        ByteBuffer bb = ByteBuffer.wrap(data, 0, length);
        int seq = bb.getInt();

        // Read the 6-byte capture timestamp: [hi:2 unsigned][lo:4 unsigned]
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
            decryptCipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(sessionKey, "AES"), new GCMParameterSpec(128, nonce));
            payload = decryptCipher.doFinal(ciphertext); // throws on auth-tag mismatch — wrong key, corrupted, or spoofed
        } catch (Exception e) {
            return; // failed auth — silently drop, matches desktop's audio-sink-client.ts
        }

        acceptDecrypted(seq, payload);
    }

    /** Measures the current play-offset (arrivalMs - captureMs) and applies a slow
     *  exponential-smoothing correction to AudioTrack.setPlaybackRate() to cancel any drift.
     *  Called from the UDP receive thread; audioTrack access is guarded by a null-check (the
     *  race window between startPlayback and the first packet is safe — we just skip one sample). */
    private void updateDriftCorrection(long captureMs, long arrivalMs) {
        long offsetMs = arrivalMs - captureMs;

        // Phase 1: collect baseline from the first BASELINE_SAMPLES packets
        if (baselineOffsetMs == Long.MIN_VALUE) {
            baselineAccumMs += offsetMs;
            baselineSampleCount++;
            if (baselineSampleCount >= BASELINE_SAMPLES) {
                baselineOffsetMs = baselineAccumMs / baselineSampleCount;
                smoothedOffsetMs = baselineOffsetMs;
                Log.i(TAG, "Drift correction baseline established: " + baselineOffsetMs + " ms");
            }
            return; // don't apply any correction yet
        }

        // Phase 2: EMA of ongoing offset, compare against baseline
        smoothedOffsetMs = EMA_ALPHA * offsetMs + (1.0 - EMA_ALPHA) * smoothedOffsetMs;
        double driftMs = smoothedOffsetMs - baselineOffsetMs;

        // driftMs > 0 means phone is falling behind (clock too slow) -> play faster
        // driftMs < 0 means phone is running ahead (clock too fast) -> play slower
        // Clamp correction to ±MAX_RATE_CORRECTION of the nominal sample rate.
        // Fractional rate offset that would null the accumulated drift over
        // DRIFT_CORRECTION_SECONDS, rather than as fast as possible — see that constant.
        double correction = driftMs / (DRIFT_CORRECTION_SECONDS * 1000.0);
        correction = Math.max(-MAX_RATE_CORRECTION, Math.min(MAX_RATE_CORRECTION, correction));
        int correctedRate = (int) Math.round(sampleRate * (1.0 + correction));

        AudioTrack track = audioTrack;
        if (track != null && track.getPlayState() == AudioTrack.PLAYSTATE_PLAYING) {
            try {
                track.setPlaybackRate(correctedRate);
            } catch (Exception e) {
                Log.w(TAG, "setPlaybackRate failed: " + e.getMessage());
            }
        }

        emitStatsThrottled(track);
    }

    /** Surfaces the offset this class already computes for drift correction. It was previously
     *  only ever used internally, which left latency work with nothing to measure against —
     *  "it feels slower" is not something you can tune. Throttled to ~1/sec because this runs per
     *  frame (100/sec at a 10ms Opus cadence) on the UDP receive thread, which must not block. */
    /** Fires a short burst of probes right after admission. Spaced out so they don't all queue
     *  behind each other on the same socket write, which would defeat the point of keeping the
     *  fastest one. */
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

        // If nothing came back well after the last probe, the other end almost certainly predates
        // clock-ping — i.e. the host app wasn't rebuilt. Say so once, loudly, instead of leaving
        // the reading stuck on "measuring…" with no explanation.
        handler.postDelayed(() -> {
            if (!clockOffsetKnown) {
                Log.w(TAG, "No clock-pong after " + CLOCK_PROBES + " probes — host likely predates clock sync "
                    + "(rebuild/reinstall the desktop app). Reporting UNCORRECTED latency.");
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

    /** Converges the usable buffer depth on the shallowest value this device sustains. Called from
     *  the stats tick, so it runs on the UDP receive thread — setBufferSizeInFrames is a cheap,
     *  thread-safe control call and never blocks on the audio path. */
    private void adaptBuffer(AudioTrack track, int underruns) {
        if (track == null || sampleRate <= 0) return;
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.N) return;

        long now = System.currentTimeMillis();
        if (lastAdaptUnderruns < 0) { // first tick — record the starting point, change nothing yet
            lastAdaptUnderruns = underruns;
            lastAdaptMs = now;
            applyBufferMs(track, adaptCurrentMs);
            return;
        }
        if (now - lastAdaptMs < ADAPT_INTERVAL_MS) return;

        boolean glitched = underruns > lastAdaptUnderruns;
        lastAdaptUnderruns = underruns;
        lastAdaptMs = now;

        if (glitched) {
            // This depth has now demonstrably failed here, so bar it from being tried again — the
            // floor is what stops the controller oscillating back down into a depth it already
            // knows crackles.
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
                // The HAL may round to its own period; track what it actually gave us so the next
                // step is relative to reality rather than to a value that was never in effect.
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
        if (track != null && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            try {
                underruns = track.getUnderrunCount();
            } catch (Exception ignored) {}
        }

        adaptBuffer(track, underruns);

        // Re-probe the clock periodically. The offset was measured once at admission and the two
        // devices' clocks drift apart from that moment on — and now that the true latency is only
        // a few milliseconds, even a small stale offset is enough to push the reported figure
        // below zero (which is what a negative reading means: measurement error larger than the
        // thing being measured, not negative latency). Resetting the best-RTT lets the new round
        // actually replace the old estimate rather than being rejected as worse.
        if (now - lastClockSyncMs > CLOCK_RESYNC_INTERVAL_MS) {
            lastClockSyncMs = now;
            bestProbeRttMs = Long.MAX_VALUE;
            startClockSync();
        }

        // The AudioTrack buffer's depth in milliseconds — the one stage whose latency cost is
        // fully under our control and directly comparable across builds.
        int bufferMs = 0;
        if (track != null && sampleRate > 0) {
            int bytesPerFrame = channels * (bitsPerSample / 8);
            if (bytesPerFrame > 0) {
                bufferMs = (int) (track.getBufferSizeInFrames() * 1000L / sampleRate);
            }
        }

        // Corrected once the offset is known. If the probes never came back (a host predating
        // clock-ping, or one that isn't answering) the raw figure is reported instead, flagged as
        // unsynced — it still carries the two clocks' difference and may well be negative, but
        // showing it beside an explicit "unsynced" marker is far more diagnosable than sitting on
        // "measuring…" indefinitely with no indication of why.
        // ADDED, not subtracted. clockOffsetMs is (host clock - this device's clock), while
        // smoothedOffsetMs is (arrival on OUR clock - capture on the HOST's clock). Putting both
        // into the host's timebase:
        //     latency = arrival_host - capture_host
        //             = (arrival_ours + offset) - capture_host
        //             = smoothedOffsetMs + clockOffsetMs
        // Getting this backwards doubles the clock error instead of cancelling it, which shows up
        // as a large negative "latency" — the reading is only meaningful if it comes out positive.
        long reportedLatencyMs = clockOffsetKnown
            ? Math.round(smoothedOffsetMs + clockOffsetMs)
            : Math.round(smoothedOffsetMs);

        // A synced reading below zero is impossible physically, so it can only mean the clock
        // correction is being applied wrongly. Worth saying out loud rather than quietly showing a
        // nonsense figure — that is exactly how the earlier sign error survived a test round.
        if (clockOffsetKnown && reportedLatencyMs < 0) {
            Log.w(TAG, "Negative synced latency (" + reportedLatencyMs + " ms) — clock correction is wrong: "
                + "raw=" + Math.round(smoothedOffsetMs) + " offset=" + clockOffsetMs);
        }

        // Chunks discarded at the playback handoff count as lost audio just like an underrun does,
        // so they're reported together rather than hidden — otherwise decoupling the threads could
        // look like a win while quietly trading stalls for drops.
        try {
            listener.onStats(reportedLatencyMs, bufferMs, underruns, droppedChunks, clockOffsetKnown);
        } catch (Exception ignored) {}
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

        // Fresh session: re-learn the floor from scratch. Conditions that forced a deeper buffer
        // last time (another app hammering the CPU, a worse link) may not apply now.
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
            // 20ms was the floor for the OLD design, where AudioTrack.write(WRITE_BLOCKING) ran on
            // the UDP receive thread: a shallow buffer filled, the write parked that thread, socket
            // draining stopped, and the resulting backlog produced both underruns and ~100ms of
            // hidden queueing latency. Writes now happen on a dedicated thread fed by a bounded
            // queue, so a full buffer no longer stalls the network path and that floor no longer
            // applies. 12ms is still comfortably above the ~3ms native HAL period and above one
            // Opus frame interval, leaving real jitter margin. If underruns come back, this is the
            // first number to raise — it is the one being traded against latency here.
            // Allocated with headroom rather than at the target depth. AudioTrack's buffer cannot
            // be resized after build(), but setBufferSizeInFrames() can limit how much of it is
            // actually used — so the allocation is the CEILING the adaptive controller works
            // within (see adaptBuffer), not the latency we run at. Kept modest all the same: an
            // over-large allocation can disqualify the low-latency fast path entirely, which would
            // cost more than the adaptation wins back.
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

    /** Hands a decoded chunk to the playback thread. Deliberately never blocks.
     *
     *  This used to call AudioTrack.write(WRITE_BLOCKING) directly, which ran on the UDP receive
     *  thread — the same thread that drains the socket. Whenever the track's buffer filled, that
     *  write parked the thread, the socket stopped being read, and packets banked up in the
     *  KERNEL receive buffer. Measured capture->arrival latency then reported that queueing as if
     *  it were network time (120ms on a USB-tethered link that should show 1-3ms), and the track
     *  frequently ran dry during the same stall — so the one blocking call produced both the
     *  latency and the underruns. Draining the socket promptly is what keeps both honest. */
    private void playChunk(byte[] pcm) {
        if (audioTrack == null) return;
        // Full queue means playback genuinely cannot keep up. Drop the OLDEST chunk rather than
        // block or drop the newest: falling behind is already audible, and discarding stale audio
        // keeps the backlog — and therefore the latency — bounded instead of letting it grow.
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
            while (playbackWriterRunning) {
                byte[] pcm;
                try {
                    pcm = playbackQueue.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
                if (pcm == null) continue;

                AudioTrack track = audioTrack;
                if (track == null) continue;
                try {
                    if (isFloatFormat && bitsPerSample == 32) {
                        ByteBuffer bb = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
                        FloatBuffer fb = bb.asFloatBuffer();
                        float[] floats = new float[fb.remaining()];
                        fb.get(floats);
                        track.write(floats, 0, floats.length, AudioTrack.WRITE_BLOCKING);
                    } else {
                        track.write(pcm, 0, pcm.length);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error writing audio chunk", e);
                }
            }
        }, "link-audio-playback");
        playbackWriterThread.setPriority(Thread.MAX_PRIORITY);
        playbackWriterThread.start();
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
        // Writer first: it holds a reference to the track and would otherwise be mid-write while
        // the track is released underneath it.
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
