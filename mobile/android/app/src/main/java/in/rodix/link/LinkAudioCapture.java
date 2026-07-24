package in.rodix.link;

// Audio Relay — Android-as-host capture side. Wraps MediaProjection + AudioPlaybackCaptureConfiguration
// + AudioRecord to capture this device's own system audio, isolated behind its own Listener
// interface so LinkAudioRelayServer (the relay/wire-protocol half) never touches AudioRecord
// directly — keeps capture independently replaceable (e.g. if Opus encoding is added later, only
// this seam changes).
//
// Format is fixed at 48000Hz/stereo/16-bit PCM: AudioPlaybackCaptureConfiguration doesn't let the
// capturing app choose what rate source apps are mixed at — the OS mixes everything down to
// whatever format the AudioRecord here requests, and 48000Hz/stereo/16-bit is the de facto
// standard Android mixer output on essentially all modern devices, and already the exact format
// every existing listener (LinkAudioRelayClient.java, desktop's audio-relay-client.ts) already
// knows how to play with zero new code.

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.util.Log;

public class LinkAudioCapture {
    private static final String TAG = "LinkAudioCapture";
    private static final int SAMPLE_RATE = 48000;
    private static final int CHANNELS = 2;
    private static final int BITS_PER_SAMPLE = 16;

    public interface Listener {
        void onFormatReady(int sampleRate, int channels, int bitsPerSample, boolean isFloat);
        void onChunk(byte[] pcm);
        void onError(String message);
    }

    private final Context context;
    private final MediaProjection projection;
    private final Listener listener;
    private AudioRecord audioRecord;
    private Thread readThread;
    private volatile boolean running = false;

    public LinkAudioCapture(Context context, MediaProjection projection, Listener listener) {
        this.context = context;
        this.projection = projection;
        this.listener = listener;
    }

    public void start() {
        // USAGE_UNKNOWN is easy to omit and a real gotcha: a meaningful number of apps tag their
        // playback with UNKNOWN rather than MEDIA/GAME, and omitting it silently drops their
        // audio from capture with no error signal at all.
        AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build();

        int channelMask = AudioFormat.CHANNEL_IN_STEREO;
        int encoding = AudioFormat.ENCODING_PCM_16BIT;
        AudioFormat format = new AudioFormat.Builder()
                .setEncoding(encoding)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(channelMask)
                .build();

        int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, channelMask, encoding);
        if (minBuf <= 0) {
            listener.onError("Unsupported capture format on this device");
            return;
        }
        // *2 headroom on the INTERNAL ring buffer only — enough that a brief scheduling hiccup
        // doesn't overflow it and drop audio, without being the read granularity (see READ_CHUNK_MS
        // below for that). This was previously *4 AND used as the per-read() size in one number,
        // which meant every onChunk() only fired once that much audio had accumulated — a large,
        // self-inflicted latency floor with no relation to any of the network/playback tuning done
        // elsewhere in this feature. Decoupling the two fixes that: the ring buffer stays generous
        // for stability, but reads happen in small slices so audio leaves this device promptly.
        int bufferSizeBytes = minBuf * 2;

        try {
            // setAudioSource() and setAudioPlaybackCaptureConfig() are mutually exclusive on this
            // Builder — only the latter is called.
            audioRecord = new AudioRecord.Builder()
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(bufferSizeBytes)
                    .setAudioPlaybackCaptureConfig(config)
                    .build();
        } catch (Exception e) {
            listener.onError("Failed to initialize audio capture: " + e.getMessage());
            return;
        }

        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.w(TAG, "AudioRecord built but state=" + audioRecord.getState());
            listener.onError("Audio capture failed to initialize");
            try { audioRecord.release(); } catch (Exception ignored) {}
            audioRecord = null;
            return;
        }

        // Format is known upfront on this platform (unlike desktop's PowerShell stdout-header-line
        // discovery) — report it before the first chunk arrives.
        listener.onFormatReady(SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE, false);

        try {
            audioRecord.startRecording();
        } catch (Exception e) {
            listener.onError("Failed to start audio capture: " + e.getMessage());
            return;
        }
        if (audioRecord.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
            listener.onError("Audio capture did not start recording");
            return;
        }

        // Read granularity, NOT the internal buffer size above — read() blocks until this many
        // bytes are available, so this number directly IS the latency this stage adds. Kept small
        // for low latency.
        //
        // History worth not re-litigating: an earlier test found 20ms felt WORSE than 40ms, which
        // led to bumping this up — but that was BEFORE the desktop-listener PcmPlayer scheduler
        // drift bug was fixed (it had no resync, so any jitter built a permanent, ever-growing
        // backlog, and a higher message rate fed that backlog faster). With that bug fixed, the
        // message rate is no longer a latency source, so this went back down to 20ms to trim the
        // capture floor. Trimmed further to 10ms after the Audio Relay UDP investigation confirmed
        // the desktop listener's own jitter buffer (PcmPlayer's 45ms TARGET_BUFFER_S) has ample
        // margin over an even smaller capture chunk than 20ms — that buffer only needs to absorb
        // gaps up to its own size, and 10ms leaves it 4.5x headroom over this stage's own cadence.
        // If real-device dropouts reappear on a weak link, raise this back toward 20-40ms.
        final int READ_CHUNK_MS = 10;
        int bytesPerFrame = CHANNELS * (BITS_PER_SAMPLE / 8);
        int readChunkBytes = (SAMPLE_RATE * bytesPerFrame * READ_CHUNK_MS) / 1000;

        running = true;
        readThread = new Thread(() -> {
            // Android's documented guidance for audio capture/playback threads — reduces the
            // chance of scheduling jitter causing underruns in the read loop below.
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
            byte[] buf = new byte[readChunkBytes];
            while (running) {
                int n = audioRecord.read(buf, 0, buf.length);
                if (n > 0) {
                    byte[] chunk = new byte[n];
                    System.arraycopy(buf, 0, chunk, 0, n);
                    listener.onChunk(chunk);
                } else if (n < 0) {
                    listener.onError("AudioRecord read error: " + n);
                    break;
                }
            }
        }, "link-audiorelay-capture");
        readThread.start();
    }

    /** Does not stop/release the MediaProjection — ownership of that stays with whoever created
     *  it (LinkAudioRelayServer), since a fresh grant/consent is required per session anyway and
     *  the two lifecycles happen to coincide 1:1 in this design, not because this class owns it. */
    public void stop() {
        running = false;
        if (readThread != null) {
            try { readThread.join(500); } catch (InterruptedException ignored) {}
            readThread = null;
        }
        if (audioRecord != null) {
            try {
                audioRecord.stop();
            } catch (Exception ignored) {}
            try {
                audioRecord.release();
            } catch (Exception ignored) {}
            audioRecord = null;
        }
    }
}
