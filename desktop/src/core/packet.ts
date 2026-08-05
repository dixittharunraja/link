// Packet framing. One JSON object per line over a persistent TLS socket. See docs/PROTOCOL.md §2.

export interface LinkPacket<TBody = any> {
  id: number;
  type: string;
  body: TBody;
  payloadSize?: number; // -1 = unknown/stream length
  payloadTransferInfo?: Record<string, unknown>;
}

export function createPacket<TBody = Record<string, unknown>>(
  type: string,
  body: TBody
): LinkPacket<TBody> {
  return {
    id: Date.now(),
    type,
    body,
  };
}

export function serializePacket(packet: LinkPacket): Buffer {
  return Buffer.from(JSON.stringify(packet) + '\n', 'utf8');
}

export function parsePacket(json: string): LinkPacket | null {
  try {
    const obj = JSON.parse(json);
    if (typeof obj.type !== 'string' || typeof obj.body !== 'object' || obj.body === null) {
      return null;
    }
    return obj as LinkPacket;
  } catch {
    return null;
  }
}

/**
 * Buffers incoming bytes and yields complete, newline-delimited packets as they arrive — a TLS
 * socket can deliver a packet split across multiple `data` events, or multiple packets in one.
 */
export class PacketStreamReader {
  private buffer = '';

  /** Feed newly-received bytes in; returns any complete packets now available (parse failures skipped). */
  push(chunk: Buffer | string): LinkPacket[] {
    this.buffer += chunk.toString('utf8');
    const packets: LinkPacket[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      const packet = parsePacket(line);
      if (packet) packets.push(packet);
    }

    return packets;
  }
}
