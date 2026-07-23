// Effective-capabilities packet — a single, unified per-peer signal replacing ad-hoc per-plugin
// "revoked" flags (previously Flashlight/DND each carried their own bespoke revoked:true field).
//
// Sent to a specific peer whenever what they're currently allowed to do here changes (permission
// toggle, or connect-time initial sync). Lists exactly which of this device's own per-device-gated
// capability keys (e.g. 'presenter', 'touchpad', 'digitizer', 'systemvolume', 'mpris', 'flashlight',
// 'dnd') are CURRENTLY allowed for that peer. The receiving UI gates every button/section on
// membership in this list — no separate revoke marker needed, since a key's absence alone hides
// it regardless of whatever stale value the renderer still has cached from before.
import { createPacket, LinkPacket } from '../packet';

export const PACKET_TYPE_CAPABILITIES = 'link.capabilities';

export interface CapabilitiesBody {
  capabilities: string[];
}

export function createCapabilitiesPacket(capabilities: string[]): LinkPacket<CapabilitiesBody> {
  return createPacket(PACKET_TYPE_CAPABILITIES, { capabilities });
}

export function isCapabilitiesPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_CAPABILITIES;
}
