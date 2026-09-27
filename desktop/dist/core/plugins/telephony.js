"use strict";
// Telephony plugin.
// Receives call events (ringing, talking, cancelled, missedCall) and notifies the user.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_TELEPHONY = void 0;
exports.isTelephonyPacket = isTelephonyPacket;
exports.PACKET_TYPE_TELEPHONY = 'link.telephony';
function isTelephonyPacket(packet) {
    return packet.type === exports.PACKET_TYPE_TELEPHONY;
}
//# sourceMappingURL=telephony.js.map