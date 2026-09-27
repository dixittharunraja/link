"use strict";
// Connectivity Report plugin.
// Receives signal strength and network status updates from the phone.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_CONNECTIVITY = void 0;
exports.isConnectivityPacket = isConnectivityPacket;
exports.PACKET_TYPE_CONNECTIVITY = 'link.connectivity';
function isConnectivityPacket(packet) {
    return packet.type === exports.PACKET_TYPE_CONNECTIVITY;
}
//# sourceMappingURL=connectivity.js.map