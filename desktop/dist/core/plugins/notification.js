"use strict";
// Notification plugin.
// Receives app notifications and displays them on the desktop.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_NOTIFICATION = void 0;
exports.isNotificationPacket = isNotificationPacket;
exports.PACKET_TYPE_NOTIFICATION = 'link.notification';
function isNotificationPacket(packet) {
    return packet.type === exports.PACKET_TYPE_NOTIFICATION;
}
//# sourceMappingURL=notification.js.map