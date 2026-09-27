"use strict";
// Packet framing. One JSON object per line over a persistent TLS socket. See docs/PROTOCOL.md §2.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PacketStreamReader = void 0;
exports.createPacket = createPacket;
exports.serializePacket = serializePacket;
exports.parsePacket = parsePacket;
function createPacket(type, body) {
    return {
        id: Date.now(),
        type,
        body,
    };
}
function serializePacket(packet) {
    return Buffer.from(JSON.stringify(packet) + '\n', 'utf8');
}
function parsePacket(json) {
    try {
        const obj = JSON.parse(json);
        if (typeof obj.type !== 'string' || typeof obj.body !== 'object' || obj.body === null) {
            return null;
        }
        return obj;
    }
    catch {
        return null;
    }
}
/**
 * Buffers incoming bytes and yields complete, newline-delimited packets as they arrive — a TLS
 * socket can deliver a packet split across multiple `data` events, or multiple packets in one.
 */
class PacketStreamReader {
    buffer = '';
    /** Feed newly-received bytes in; returns any complete packets now available (parse failures skipped). */
    push(chunk) {
        this.buffer += chunk.toString('utf8');
        const packets = [];
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (line.length === 0)
                continue;
            const packet = parsePacket(line);
            if (packet)
                packets.push(packet);
        }
        return packets;
    }
}
exports.PacketStreamReader = PacketStreamReader;
//# sourceMappingURL=packet.js.map