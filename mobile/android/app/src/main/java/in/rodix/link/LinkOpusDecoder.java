package in.rodix.link;

// Wraps a MediaCodec configured for Opus decoding — used by LinkAudioRelayClient to decompress
// incoming audio, mirroring desktop's @evan/opus Decoder usage. Opus DECODING via MediaCodec has
// been available since Android 5.0 (API 21), well below this project's minSdkVersion (23), so
// unlike the encoder there's no additional API-level gate needed here.
//
// NOT independently tested on real hardware during development — see LinkOpusEncoder's header
// comment for the full reasoning (same caveat applies here, and this class is the riskier of the
// two: Android's MediaCodec Opus decoder, unlike @evan/opus's simple decode(buf) API, requires
// being initialized with proper Opus container metadata — see buildOpusHead() below). The
// fallback-to-PCM contract on the sending side plus the try/catch around this class's
// construction (see LinkAudioRelayClient's handleFormatMessage) means a failure here surfaces as
// a clear error rather than silently breaking playback.
//
// Uses MediaCodec's synchronous (dequeue/queue) API — this class is only ever driven from
// LinkAudioRelayClient's single dedicated UDP receive thread, matching LinkOpusEncoder's same
// reasoning on the capture thread.

import android.media.MediaCodec;
import android.media.MediaFormat;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public class LinkOpusDecoder {
    // libopus's own commonly-used default encoder lookahead at 48kHz — used here only as the
    // declared pre-skip value in the synthesized OpusHead. Pre-skip accuracy affects how much
    // lead-in silence gets trimmed at the very start of a stream; for this continuous real-time
    // relay (not file playback needing exact-start trimming), an approximate value is safe and
    // cannot corrupt ongoing decode correctness — only the first fraction of a second, at worst.
    private static final int DEFAULT_PRE_SKIP_SAMPLES = 3840;

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

    public LinkOpusDecoder(int sampleRate, int channels, int frameDurationUs) throws Exception {
        this.frameDurationUs = frameDurationUs;
        this.dequeueTimeoutUs = Math.max(1000, frameDurationUs / 2);
        MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, sampleRate, channels);
        // Android's MediaCodec Opus decoder expects standard WebM/Matroska-style Opus codec-
        // private-data, supplied as three CSD buffers — csd-0 the identification header
        // ("OpusHead"), csd-1 the pre-skip value, csd-2 the seek pre-roll value — the same
        // convention ExoPlayer/WebM demuxers use when feeding this same decoder.
        format.setByteBuffer("csd-0", buildOpusHead(channels, sampleRate));
        format.setByteBuffer("csd-1", buildLongLE(DEFAULT_PRE_SKIP_SAMPLES));
        format.setByteBuffer("csd-2", buildLongLE(0)); // seek pre-roll — not meaningful for a live stream
        codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
        codec.configure(format, null, null, 0);
        codec.start();
    }

    /** Builds the 19-byte Opus identification header ("OpusHead") Android's MediaCodec Opus
     *  decoder expects as csd-0 — see RFC 7845 §5.1. Only the fields that matter for decoding a
     *  live plain stereo/mono stream are populated meaningfully; output gain and channel mapping
     *  are left at their default values since this protocol never uses anything beyond that. */
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

    /** Decodes exactly one Opus packet and returns the resulting 16-bit int PCM bytes — drains
     *  every buffer MediaCodec makes available, matching LinkOpusEncoder's same reasoning. Returns
     *  an empty array if the codec produced no output within the timeout (callers should treat
     *  that as "skip this frame", not an error). */
    public byte[] decode(byte[] opusFrame) {
        int inIndex = codec.dequeueInputBuffer(dequeueTimeoutUs);
        if (inIndex >= 0) {
            ByteBuffer inBuf = codec.getInputBuffer(inIndex);
            inBuf.clear();
            inBuf.put(opusFrame);
            codec.queueInputBuffer(inIndex, 0, opusFrame.length, presentationTimeUs, 0);
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
