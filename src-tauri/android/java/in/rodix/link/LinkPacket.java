package in.rodix.link;

// Packet framing, the Java counterpart of core/packet.rs: one JSON object per line over a
// persistent TLS socket.

import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class LinkPacket {
    public final long id;
    public final String type;
    public final JSONObject body;
    /** -1 or absent = no payload. Only set for packets accompanying a payload transfer (see LinkPayloadTransfer). */
    public Long payloadSize;
    public JSONObject payloadTransferInfo;

    public LinkPacket(String type, JSONObject body) {
        this.id = System.currentTimeMillis();
        this.type = type;
        this.body = body;
    }

    public String getType() {
        return type;
    }

    public JSONObject getBody() {
        return body;
    }

    private LinkPacket(long id, String type, JSONObject body, Long payloadSize, JSONObject payloadTransferInfo) {
        this.id = id;
        this.type = type;
        this.body = body;
        this.payloadSize = payloadSize;
        this.payloadTransferInfo = payloadTransferInfo;
    }

    public byte[] serialize() {
        try {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("type", type);
            obj.put("body", body);
            if (payloadSize != null) obj.put("payloadSize", payloadSize);
            if (payloadTransferInfo != null) obj.put("payloadTransferInfo", payloadTransferInfo);
            return (obj.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket parse(String json) {
        try {
            JSONObject obj = new JSONObject(json);
            String type = obj.getString("type");
            JSONObject body = obj.getJSONObject("body");
            long id = obj.optLong("id", System.currentTimeMillis());
            Long payloadSize = obj.has("payloadSize") ? obj.optLong("payloadSize") : null;
            JSONObject payloadTransferInfo = obj.optJSONObject("payloadTransferInfo");
            return new LinkPacket(id, type, body, payloadSize, payloadTransferInfo);
        } catch (Exception e) {
            return null;
        }
    }

    /** Longest line accepted before the peer has identified itself; the identity packet is a few
     *  kilobytes. Matches MAX_LINE_BEFORE_IDENTITY in core/packet.rs. */
    public static final int MAX_LINE_BEFORE_IDENTITY = 64 * 1024;
    /** Longest line accepted from an identified peer. File bytes never travel as packets (they
     *  have their own connections), so the largest lines are share offers listing many files, long
     *  clipboard text and notification icons, all far below this. Matches MAX_LINE in
     *  core/packet.rs. */
    public static final int MAX_LINE = 16 * 1024 * 1024;

    /** Buffers incoming bytes and yields complete newline-delimited packets as they arrive. */
    public static class StreamReader {
        private byte[] data = new byte[8192];
        private int size = 0;
        // Bytes at the start of data already known to hold no newline.
        private int scanned = 0;
        private int limit = MAX_LINE_BEFORE_IDENTITY;

        /** Sets the longest line accepted from here on. */
        public void setLimit(int limit) {
            this.limit = limit;
        }

        /** Throws once a line runs past the limit; the connection should then be dropped. */
        public List<LinkPacket> push(byte[] chunk, int len) throws IOException {
            if (size + len > data.length) {
                data = Arrays.copyOf(data, Math.max(size + len, Math.min(data.length * 2, limit + 8192)));
            }
            System.arraycopy(chunk, 0, data, size, len);
            size += len;
            List<LinkPacket> packets = new ArrayList<>();

            int start = 0;
            for (int i = scanned; i < size; i++) {
                if (data[i] != '\n') continue;
                if (i - start > limit) throw new IOException("packet line longer than " + limit + " bytes");
                String line = new String(data, start, i - start, StandardCharsets.UTF_8);
                start = i + 1;
                if (!line.isEmpty()) {
                    LinkPacket packet = parse(line);
                    if (packet != null) packets.add(packet);
                }
            }
            if (size - start > limit) throw new IOException("packet line longer than " + limit + " bytes");

            System.arraycopy(data, start, data, 0, size - start);
            size -= start;
            scanned = size;
            // Let go of the room a large packet needed once it has been read.
            if (size == 0 && data.length > 64 * 1024) data = new byte[8192];
            return packets;
        }
    }
}
