package in.rodix.link;

// MediaCodec Opus encoder used by LinkAudioSinkServer for Audio Relay and by LinkRemoteMicServer
// for the microphone. MediaCodec Opus encoding exists from API 29, the app's minimum.
//
// Uses the synchronous dequeue/queue API because it is driven from LinkAudioCapture's single
// read thread.

import android.media.MediaCodec;
import android.media.MediaFormat;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

public class LinkOpusEncoder {
    private final MediaCodec codec;
    private final int frameDurationUs;
    // Half a frame, so a worst-case codec wait never exceeds one frame of real time.
    private final long dequeueTimeoutUs;
    private long presentationTimeUs = 0;

    public LinkOpusEncoder(int sampleRate, int channels, int bitRate, int frameDurationUs) throws Exception {
        this.frameDurationUs = frameDurationUs;
        this.dequeueTimeoutUs = Math.max(1000, frameDurationUs / 2);
        MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, sampleRate, channels);
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        codec.start();
    }

    /** Encodes one fixed-duration frame of interleaved 16-bit PCM, draining all available output
     *  buffers. Returns an empty array if no output was ready within the timeout; callers drop
     *  the frame. */
    public byte[] encode(byte[] pcm16) {
        int inIndex = codec.dequeueInputBuffer(dequeueTimeoutUs);
        if (inIndex >= 0) {
            ByteBuffer inBuf = codec.getInputBuffer(inIndex);
            inBuf.clear();
            inBuf.put(pcm16);
            codec.queueInputBuffer(inIndex, 0, pcm16.length, presentationTimeUs, 0);
            presentationTimeUs += frameDurationUs;
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        int outIndex = codec.dequeueOutputBuffer(info, dequeueTimeoutUs);
        while (outIndex >= 0) {
            // The first outputs are the codec's setup blocks (OpusHead and the pre-skip), not audio.
            // Glued onto the first frame they make it undecodable, so they are left out.
            boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
            if (info.size > 0 && !config) {
                ByteBuffer outBuf = codec.getOutputBuffer(outIndex);
                byte[] chunk = new byte[info.size];
                outBuf.get(chunk);
                out.write(chunk, 0, chunk.length);
            }
            codec.releaseOutputBuffer(outIndex, false);
            outIndex = codec.dequeueOutputBuffer(info, 0);
        }
        return out.toByteArray();
    }

    public void release() {
        try { codec.stop(); } catch (Exception ignored) {}
        try { codec.release(); } catch (Exception ignored) {}
    }
}
