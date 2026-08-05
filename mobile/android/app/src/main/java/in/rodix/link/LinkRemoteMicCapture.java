package in.rodix.link;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

public class LinkRemoteMicCapture {
    private static final String TAG = "LinkRemoteMicCapture";
    private static final int SAMPLE_RATE = 48000;
    private static final int CHANNELS = 1; // Mono is perfect for microphones and saves bandwidth

    public interface Listener {
        void onFormatReady(int sampleRate, int channels, int bitsPerSample, boolean isFloat);
        void onChunk(byte[] pcm);
        void onError(String message);
    }

    /** One candidate capture configuration, tried in priority order by start() — highest quality
     *  first, falling back only if a given combination isn't actually available on this device. */
    private static class Candidate {
        final int source;
        final int encoding;
        final int bitsPerSample;
        final boolean isFloat;
        Candidate(int source, int encoding, int bitsPerSample, boolean isFloat) {
            this.source = source;
            this.encoding = encoding;
            this.bitsPerSample = bitsPerSample;
            this.isFloat = isFloat;
        }
    }

    private final Context context;
    private final Listener listener;
    private AudioRecord audioRecord;
    private Thread readThread;
    private volatile boolean running = false;
    private int activeBitsPerSample;
    private boolean activeIsFloat;

    public LinkRemoteMicCapture(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    /** AudioSource.UNPROCESSED (API 24+) requests the raw ADC signal with no platform-level
     *  effects applied at all — unlike AudioSource.MIC, which is close but doesn't guarantee some
     *  OEMs haven't layered their own AGC/noise-suppression on top regardless. UNPROCESSED isn't
     *  guaranteed present on every device (query via AudioManager's capability property), so this
     *  is a real capability check, not just an API-level gate. */
    private boolean isUnprocessedSupported() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.N) return false;
        try {
            AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            return am != null && "true".equals(am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED));
        } catch (Exception e) {
            return false;
        }
    }

    private AudioRecord tryBuild(Candidate c) {
        try {
            AudioFormat format = new AudioFormat.Builder()
                    .setEncoding(c.encoding)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build();
            int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, c.encoding);
            if (minBuf <= 0) return null;

            AudioRecord record = new AudioRecord.Builder()
                    .setAudioSource(c.source)
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(minBuf * 2)
                    .build();
            if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                try { record.release(); } catch (Exception ignored) {}
                return null;
            }
            return record;
        } catch (Exception e) {
            return null;
        }
    }

    public void start() {
        boolean unprocessedOk = isUnprocessedSupported();
        // Highest quality first: raw/unprocessed source + 32-bit float samples (maximum headroom,
        // no clipping-by-quantization on loud transients) — falling back a step at a time only for
        // whichever piece this specific device doesn't actually support. 16-bit int is the final
        // fallback since every AudioRecord-capable device supports it.
        Candidate[] candidates = unprocessedOk
            ? new Candidate[] {
                new Candidate(MediaRecorder.AudioSource.UNPROCESSED, AudioFormat.ENCODING_PCM_FLOAT, 32, true),
                new Candidate(MediaRecorder.AudioSource.UNPROCESSED, AudioFormat.ENCODING_PCM_16BIT, 16, false),
                new Candidate(MediaRecorder.AudioSource.MIC, AudioFormat.ENCODING_PCM_FLOAT, 32, true),
                new Candidate(MediaRecorder.AudioSource.MIC, AudioFormat.ENCODING_PCM_16BIT, 16, false),
              }
            : new Candidate[] {
                new Candidate(MediaRecorder.AudioSource.MIC, AudioFormat.ENCODING_PCM_FLOAT, 32, true),
                new Candidate(MediaRecorder.AudioSource.MIC, AudioFormat.ENCODING_PCM_16BIT, 16, false),
              };
        startWithCandidates(candidates, 0);
    }

    /** Tries candidates[index] onward, recursing to the next one on ANY failure — including a
     *  failure that only shows up on the first real read(), not just at construction. Confirmed on
     *  real hardware: AudioSource.UNPROCESSED + ENCODING_PCM_FLOAT can pass getState() ==
     *  STATE_INITIALIZED and even successfully enter RECORDING state, then fail every read() with
     *  ERROR_INVALID_OPERATION (-3) — a device-specific HAL incompatibility with that exact
     *  source+encoding combination that neither of those earlier checks catches. Probing with one
     *  real read before committing to a candidate is the only way to catch that class of failure,
     *  so it's treated exactly like a construction failure (fall back), not a fatal error. */
    private void startWithCandidates(Candidate[] candidates, int index) {
        if (index >= candidates.length) {
            listener.onError("Unsupported mic capture format on this device");
            return;
        }
        Candidate c = candidates[index];
        AudioRecord record = tryBuild(c);
        if (record == null) {
            startWithCandidates(candidates, index + 1);
            return;
        }

        try {
            record.startRecording();
        } catch (Exception e) {
            try { record.release(); } catch (Exception ignored) {}
            startWithCandidates(candidates, index + 1);
            return;
        }
        if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
            try { record.release(); } catch (Exception ignored) {}
            startWithCandidates(candidates, index + 1);
            return;
        }

        int bytesPerFrame = CHANNELS * (c.bitsPerSample / 8);
        final int READ_CHUNK_MS = 10;
        int readChunkBytes = (SAMPLE_RATE * bytesPerFrame * READ_CHUNK_MS) / 1000;
        byte[] probeBuf = new byte[readChunkBytes];
        int n = record.read(probeBuf, 0, probeBuf.length);
        if (n < 0) {
            Log.w(TAG, "Capture candidate failed on first read (source=" + c.source + " float=" + c.isFloat
                + " bits=" + c.bitsPerSample + "), error=" + n + " — falling back");
            try { record.stop(); } catch (Exception ignored) {}
            try { record.release(); } catch (Exception ignored) {}
            startWithCandidates(candidates, index + 1);
            return;
        }

        // Confirmed working — commit to this candidate.
        audioRecord = record;
        activeBitsPerSample = c.bitsPerSample;
        activeIsFloat = c.isFloat;
        Log.i(TAG, "Capturing with source=" + c.source + " bitsPerSample=" + c.bitsPerSample + " float=" + c.isFloat);
        listener.onFormatReady(SAMPLE_RATE, CHANNELS, activeBitsPerSample, activeIsFloat);

        if (n > 0) {
            byte[] chunk = new byte[n];
            System.arraycopy(probeBuf, 0, chunk, 0, n);
            listener.onChunk(chunk); // don't discard the audio the probe read already consumed
        }

        running = true;
        readThread = new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
            byte[] buf = new byte[readChunkBytes];
            while (running) {
                int r = audioRecord.read(buf, 0, buf.length);
                if (r > 0) {
                    byte[] chunk = new byte[r];
                    System.arraycopy(buf, 0, chunk, 0, r);
                    listener.onChunk(chunk);
                } else if (r < 0) {
                    listener.onError("Mic AudioRecord read error: " + r);
                    break;
                }
            }
        }, "remote-mic-read");
        readThread.start();
    }

    public void stop() {
        running = false;
        if (readThread != null) {
            try { readThread.join(1000); } catch (InterruptedException ignored) {}
            readThread = null;
        }
        if (audioRecord != null) {
            try {
                if (audioRecord.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    audioRecord.stop();
                }
                audioRecord.release();
            } catch (Exception ignored) {}
            audioRecord = null;
        }
    }
}
