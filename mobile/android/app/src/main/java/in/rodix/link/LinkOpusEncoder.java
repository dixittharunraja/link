package in.rodix.link;

// Wraps a MediaCodec configured for Opus encoding — used by LinkAudioRelayServer to compress
// captured PCM before sending, mirroring desktop's @evan/opus Encoder usage (see
// audio-relay-server.ts's setupOpusIfPossible/relayAudioOpus). Requires API 29+ (Android added
// MediaCodec Opus ENCODING support in Android 10) — already satisfied whenever this class is
// even reachable, since phone-hosting already gates on SDK_INT >= Q for MediaProjection.
//
// NOT independently tested on real hardware during development — unlike the desktop Opus path,
// which was validated end-to-end via a standalone Node script (including a measured ~42dB SNR
// round-trip), this class was written from documented Android MediaCodec conventions with no way
// to run it in this environment. Treat with real suspicion until confirmed working on a device;
// the fallback-to-PCM path in LinkAudioRelayServer (setupOpusIfPossible) stays fully intact
// specifically so a failure here degrades gracefully instead of breaking Audio Relay outright.
//
// Uses MediaCodec's synchronous (dequeue/queue) API rather than the async callback API — this
// class is only ever driven from LinkAudioCapture's single dedicated read thread, so a simple
// blocking-with-timeout call shape fits the rest of this codebase's threading model better than
// introducing a second, callback-driven thread hop.

import android.media.MediaCodec;
import android.media.MediaFormat;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

public class LinkOpusEncoder {
    private final MediaCodec codec;
    private final int frameDurationUs;
    // Was a fixed 10ms — harmless when this was called once per 10-20ms frame, but once
    // OPUS_FRAME_MS dropped to 5ms a single worst-case stall (MediaCodec actually needing the
    // full timeout to produce a buffer) would cost MORE than a whole frame interval, making this
    // thread fall behind real-time — the same category of backpressure bug as the AudioTrack-
    // blocking issue found earlier this session, just in a different component. Scaled to a
    // fraction of the actual frame duration instead, so a worst-case wait can never itself exceed
    // one frame's worth of real time, regardless of how small OPUS_FRAME_MS ends up being.
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

    /** Encodes exactly one fixed-duration PCM frame (16-bit signed, interleaved) and returns the
     *  resulting Opus packet bytes — normally one input frame maps to one output packet, but this
     *  drains every buffer MediaCodec makes available in case it ever splits output across more
     *  than one. Returns an empty array if the codec produced no output within the timeout
     *  (callers should treat that as "drop this frame", not an error). */
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
            if (info.size > 0) {
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
