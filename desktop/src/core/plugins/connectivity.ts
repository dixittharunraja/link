// Connectivity Report plugin — faithful port of kdeconnect-kde's plugins/connectivityreport/connectivityreportplugin.cpp.
// Receives signal strength and network status updates from the phone.

import { LinkPacket } from '../packet';

export const PACKET_TYPE_CONNECTIVITY = 'link.connectivity_report';

export interface SubscriptionState {
  networkType: string;
  signalStrength: number; // 0-4
}

export interface ConnectivityBody {
  signalStrengths: Record<string, SubscriptionState>;
}

export function isConnectivityPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_CONNECTIVITY;
}
