package in.rodix.link;

// MediaCodec Opus decoder used by LinkAudioSinkClient for Audio Relay. MediaCodec has decoded
// Opus since API 21, so no API-level gate is needed. Unlike libopus, the MediaCodec decoder must
// be configured with Opus header metadata (see buildOpusHead()).
//
// Runs in MediaCodec's asynchronous mode. The synchronous dequeue calls made the UDP receive
// thread wait on the codec for every packet (up to half a frame for an input buffer and again for
// the output), which delayed draining the socket and added that wait to the audio. Now the receive
// thread only copies a packet into a free input buffer, and decoded PCM is handed over from the
// codec's own callback thread as soon as it is ready.

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ConcurrentLinkedQueue;

public class LinkOpusDecoder {
    private static final String TAG = "LinkOpusDecoder";
    // Pre-skip declared in the OpusHead. It only affects how much lead-in is trimmed at the very
    // start of the stream, so an approximate value is fine for a live relay.
    private static final int DEFAULT_PRE_SKIP_SAMPLES = 3840;

    /** Receives each block of decoded 16-bit PCM, in stream order, on the codec's callback thread. */
    public interface Output {
        void onPcm(byte[] pcm);
    }

    private final MediaCodec codec;
    private final HandlerThread callbackThread;
    private final int frameDurationUs;
    // Input buffers the codec has handed back and that are free to fill.
    private final ConcurrentLinkedQueue<Integer> freeInputs = new ConcurrentLinkedQueue<>();
    private long presentationTimeUs = 0;
    private volatile boolean released = false;

    public LinkOpusDecoder(int sampleRate, int channels, int frameDurationUs, Output output) throws Exception {
        this.frameDurationUs = frameDurationUs;
        MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, sampleRate, channels);
        // The decoder expects three CSD buffers, as supplied by WebM demuxers: csd-0 the
        // OpusHead, csd-1 the pre-skip, csd-2 the seek pre-roll.
        format.setByteBuffer("csd-0", buildOpusHead(channels, sampleRate));
        format.setByteBuffer("csd-1", buildLongLE(DEFAULT_PRE_SKIP_SAMPLES));
        format.setByteBuffer("csd-2", buildLongLE(0)); // seek pre-roll; unused for a live stream

        callbackThread = new HandlerThread("LinkOpusDecoder", android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
        callbackThread.start();
        MediaCodec created = null;
        try {
            created = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            // Must be set before configure() to put the codec in asynchronous mode.
            created.setCallback(new MediaCodec.Callback() {
                @Override
                public void onInputBufferAvailable(MediaCodec mc, int index) {
                    freeInputs.offer(index);
                }

                @Override
                public void onOutputBufferAvailable(MediaCodec mc, int index, MediaCodec.BufferInfo info) {
                    if (released) return;
                    try {
                        if (info.size > 0 && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                            ByteBuffer outBuf = mc.getOutputBuffer(index);
                            byte[] pcm = new byte[info.size];
                            outBuf.position(info.offset);
                            outBuf.get(pcm);
                            output.onPcm(pcm);
                        }
                        mc.releaseOutputBuffer(index, false);
                    } catch (Exception e) {
                        // Released under us while the session ends; nothing left to play.
                    }
                }

                @Override
                public void onError(MediaCodec mc, MediaCodec.CodecException e) {
                    Log.w(TAG, "Opus decoder error", e);
                }

                @Override
                public void onOutputFormatChanged(MediaCodec mc, MediaFormat newFormat) {}
            }, new Handler(callbackThread.getLooper()));
            created.configure(format, null, null, 0);
            created.start();
        } catch (Exception e) {
            if (created != null) {
                try { created.release(); } catch (Exception ignored) {}
            }
            callbackThread.quitSafely();
            throw e;
        }
        codec = created;
    }

    /** Builds the 19-byte OpusHead identification header (RFC 7845 section 5.1) for csd-0, with
     *  zero output gain and mapping family 0 (mono/stereo). */
    private static ByteBuffer buildOpusHead(int channels, int sampleRate) {
        ByteBuffer buf = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
        buf.put(new byte[]{'O', 'p', 'u', 's', 'H', 'e', 'a', 'd'}); // magic signature
        buf.put((byte) 1); // version
        buf.put((byte) channels);
        buf.putShort((short) DEFAULT_PRE_SKIP_SAMPLES);
        buf.putInt(sampleRate); // original input sample rate (informational only)
        buf.putShort((short) 0); // output gain
        buf.put((byte) 0); // channel mapping family 0 = mono/stereo, no extra mapping table
        buf.flip();
        return buf;
    }

    private static ByteBuffer buildLongLE(long value) {
        ByteBuffer buf = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN);
        buf.putLong(value);
        buf.flip();
        return buf;
    }

    /** Queues one Opus packet for decoding without waiting; its PCM arrives through Output. Returns
     *  false when the codec has no free input buffer, meaning it is behind, and the packet is
     *  dropped like a lost one rather than adding delay. Called from one thread at a time. */
    public boolean decode(byte[] opusFrame) {
        if (released) return false;
        Integer index = freeInputs.poll();
        if (index == null) return false;
        ByteBuffer inBuf = codec.getInputBuffer(index);
        inBuf.clear();
        inBuf.put(opusFrame);
        codec.queueInputBuffer(index, 0, opusFrame.length, presentationTimeUs, 0);
        presentationTimeUs += frameDurationUs;
        return true;
    }

    public void release() {
        released = true;
        try { codec.stop(); } catch (Exception ignored) {}
        try { codec.release(); } catch (Exception ignored) {}
        callbackThread.quitSafely();
    }
}
