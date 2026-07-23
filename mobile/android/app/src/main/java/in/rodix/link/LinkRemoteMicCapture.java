package in.rodix.link;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

public class LinkRemoteMicCapture {
    private static final String TAG = "LinkRemoteMicCapture";
    private static final int SAMPLE_RATE = 48000;
    private static final int CHANNELS = 1; // Mono is perfect for microphones and saves bandwidth
    private static final int BITS_PER_SAMPLE = 16;

    public interface Listener {
        void onFormatReady(int sampleRate, int channels, int bitsPerSample, boolean isFloat);
        void onChunk(byte[] pcm);
        void onError(String message);
    }

    private final Context context;
    private final Listener listener;
    private AudioRecord audioRecord;
    private Thread readThread;
    private volatile boolean running = false;

    public LinkRemoteMicCapture(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    public void start() {
        int channelMask = AudioFormat.CHANNEL_IN_MONO;
        int encoding = AudioFormat.ENCODING_PCM_16BIT;
        AudioFormat format = new AudioFormat.Builder()
                .setEncoding(encoding)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(channelMask)
                .build();

        int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, channelMask, encoding);
        if (minBuf <= 0) {
            listener.onError("Unsupported mic capture format on this device");
            return;
        }
        int bufferSizeBytes = minBuf * 2;

        try {
            audioRecord = new AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.MIC)
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(bufferSizeBytes)
                    .build();
        } catch (Exception e) {
            listener.onError("Failed to initialize mic capture: " + e.getMessage());
            return;
        }

        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            listener.onError("Mic capture failed to initialize");
            try { audioRecord.release(); } catch (Exception ignored) {}
            audioRecord = null;
            return;
        }

        listener.onFormatReady(SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE, false);

        try {
            audioRecord.startRecording();
        } catch (Exception e) {
            listener.onError("Failed to start mic recording: " + e.getMessage());
            return;
        }

        final int READ_CHUNK_MS = 10;
        int bytesPerFrame = CHANNELS * (BITS_PER_SAMPLE / 8);
        int readChunkBytes = (SAMPLE_RATE * bytesPerFrame * READ_CHUNK_MS) / 1000;

        running = true;
        readThread = new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
            byte[] buf = new byte[readChunkBytes];
            while (running) {
                int n = audioRecord.read(buf, 0, buf.length);
                if (n > 0) {
                    byte[] chunk = new byte[n];
                    System.arraycopy(buf, 0, chunk, 0, n);
                    listener.onChunk(chunk);
                } else if (n < 0) {
                    listener.onError("Mic AudioRecord read error: " + n);
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
