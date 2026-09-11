import { createPacket, LinkPacket } from '../packet';

const PACKET_TYPE_DND = 'link.dnd';

export function createDNDCommandPacket(enabled: boolean): LinkPacket {
  return createPacket(PACKET_TYPE_DND, { enabled, isCommand: true });
}

export function isDNDPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_DND;
}
