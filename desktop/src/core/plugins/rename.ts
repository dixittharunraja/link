// Device rename sync — a device's name is self-owned (matches the identity/pairing model: only
// the device itself ever writes its own identity.deviceName). Renaming a peer from another
// device sends a REQUEST; the target applies it to itself and then broadcasts the authoritative
// result to every device it's connected to, so the new name actually propagates across the mesh
// instead of being a local-only alias.

import { LinkPacket, createPacket } from '../packet';

export const PACKET_TYPE_RENAME = 'link.rename';
export const PACKET_TYPE_RENAME_REQUEST = 'link.rename.request';

export interface RenameBody {
  deviceName: string;
}

export function createRenamePacket(deviceName: string): LinkPacket<RenameBody> {
  return createPacket(PACKET_TYPE_RENAME, { deviceName });
}

export function createRenameRequestPacket(deviceName: string): LinkPacket<RenameBody> {
  return createPacket(PACKET_TYPE_RENAME_REQUEST, { deviceName });
}

export function isRenamePacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_RENAME;
}

export function isRenameRequestPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_RENAME_REQUEST;
}
