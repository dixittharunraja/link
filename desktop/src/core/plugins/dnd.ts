import { createPacket, LinkPacket } from '../packet';

export const PACKET_TYPE_DND = 'link.dnd';

export function createDNDPacket(enabled: boolean): LinkPacket {
  return createPacket(PACKET_TYPE_DND, { enabled });
}

export function isDNDPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_DND;
}
