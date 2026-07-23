// Telephony plugin — faithful port of kdeconnect-kde's plugins/telephony/telephonyplugin.cpp.
// Receives call events (ringing, talking, cancelled, missedCall) and notifies the user.

import { LinkPacket } from '../packet';

export const PACKET_TYPE_TELEPHONY = 'link.telephony';

export interface TelephonyBody {
  event: 'ringing' | 'talking' | 'missedCall' | 'cancelled';
  phoneNumber?: string;
  contactName?: string;
  isCancel?: boolean | string;
  /** Base64-encoded PNG of the caller's saved contact photo, if resolved on the sending device. */
  iconBase64?: string;
}

export function isTelephonyPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_TELEPHONY;
}
