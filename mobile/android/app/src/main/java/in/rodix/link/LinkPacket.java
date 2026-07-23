package in.rodix.link;

// Packet framing — Java port of desktop/src/core/packet.ts. One JSON object per line over a
// persistent TLS socket. See docs/PROTOCOL.md §2.

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
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

    /** Buffers incoming bytes and yields complete newline-delimited packets as they arrive. */
    public static class StreamReader {
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

        public List<LinkPacket> push(byte[] chunk, int len) {
            buffer.write(chunk, 0, len);
            List<LinkPacket> packets = new ArrayList<>();

            byte[] data = buffer.toByteArray();
            int start = 0;
            int newlineIdx;
            while ((newlineIdx = indexOfNewline(data, start)) != -1) {
                String line = new String(data, start, newlineIdx - start, StandardCharsets.UTF_8);
                start = newlineIdx + 1;
                if (!line.isEmpty()) {
                    LinkPacket packet = parse(line);
                    if (packet != null) packets.add(packet);
                }
            }

            buffer.reset();
            buffer.write(data, start, data.length - start);

            return packets;
        }

        private int indexOfNewline(byte[] data, int from) {
            for (int i = from; i < data.length; i++) {
                if (data[i] == '\n') return i;
            }
            return -1;
        }
    }
}
