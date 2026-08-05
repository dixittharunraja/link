// Notification plugin.
// Receives app notifications and displays them on the desktop.

import { LinkPacket } from '../packet';

export const PACKET_TYPE_NOTIFICATION = 'link.notification';

export interface NotificationBody {
  id: string;
  appName: string;
  title?: string;
  text?: string;
  ticker?: string;
  isCancel?: boolean | string;
  silent?: boolean;
  requestReplyId?: string;
  /** Base64-encoded PNG of the originating app's own icon (e.g. WhatsApp's icon), if resolved
   * on the sending device. Falls back to the Link app icon when absent. */
  iconBase64?: string;
  /** Source device name (for mesh-wide notifications) */
  sourceDeviceName?: string;
}

export function isNotificationPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_NOTIFICATION;
}
