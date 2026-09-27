"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_DND = void 0;
exports.createDNDPacket = createDNDPacket;
exports.createDNDCommandPacket = createDNDCommandPacket;
exports.isDNDPacket = isDNDPacket;
const packet_1 = require("../packet");
exports.PACKET_TYPE_DND = 'link.dnd';
function createDNDPacket(enabled) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_DND, { enabled });
}
function createDNDCommandPacket(enabled) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_DND, { enabled, isCommand: true });
}
function isDNDPacket(packet) {
    return packet.type === exports.PACKET_TYPE_DND;
}
//# sourceMappingURL=dnd.js.map