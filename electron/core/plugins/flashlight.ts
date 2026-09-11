import { createPacket, LinkPacket } from '../packet';

const PACKET_TYPE_FLASHLIGHT = 'link.flashlight';

export function createFlashlightCommandPacket(enabled: boolean): LinkPacket {
  return createPacket(PACKET_TYPE_FLASHLIGHT, { enabled, isCommand: true });
}

export function isFlashlightPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_FLASHLIGHT;
}
