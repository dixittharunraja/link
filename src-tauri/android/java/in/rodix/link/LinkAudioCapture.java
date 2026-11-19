package in.rodix.link;

// Audio Relay host capture: records this device's system audio via MediaProjection,
// AudioPlaybackCaptureConfiguration and AudioRecord, and hands PCM chunks to LinkAudioSinkServer
// through the Listener interface.
//
// The format is fixed at 48kHz stereo 16-bit PCM. The OS mixes captured playback into whatever
// format the AudioRecord requests, and this is the standard Android mixer format and the one
// every listener already plays.

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
        // Many apps tag playback as USAGE_UNKNOWN; without it their audio is silently excluded.
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
        // Internal ring buffer with 2x headroom against scheduling hiccups. It is separate from
        // the read size (READ_CHUNK_MS), which is what determines latency.
        int bufferSizeBytes = minBuf * 2;

        try {
            // setAudioSource() must not be combined with setAudioPlaybackCaptureConfig().
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

        // The format is fixed, so it is reported before the first chunk.
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

        // Read size. read() blocks until this much audio is available, so it is the latency this
        // stage adds. If dropouts occur on weak links, raising it toward 20-40ms trades latency
        // for stability.
        final int READ_CHUNK_MS = 10;
        int bytesPerFrame = CHANNELS * (BITS_PER_SAMPLE / 8);
        int readChunkBytes = (SAMPLE_RATE * bytesPerFrame * READ_CHUNK_MS) / 1000;

        running = true;
        readThread = new Thread(() -> {
            // Recommended priority for audio threads; reduces scheduling jitter.
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
        }, "link-audiosink-capture");
        readThread.start();
    }

    /** Stops capture. The MediaProjection is owned and stopped by LinkAudioSinkServer. */
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
