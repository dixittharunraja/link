// Telephony plugin.
// Receives call events (ringing, talking, cancelled, missedCall) and notifies the user.

import { LinkPacket } from '../packet';

const PACKET_TYPE_TELEPHONY = 'link.telephony';

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

const PACKET_TYPE_TELEPHONY_REQUEST = 'link.telephony.request';

export type TelephonyAction = 'accept' | 'reject' | 'mute';

interface TelephonyRequestBody {
  action: TelephonyAction;
}

export function createTelephonyRequestPacket(action: TelephonyAction): LinkPacket {
  return {
    id: Date.now(),
    type: PACKET_TYPE_TELEPHONY_REQUEST,
    body: { action } as TelephonyRequestBody,
  };
}
