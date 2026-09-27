"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_FLASHLIGHT = void 0;
exports.createFlashlightPacket = createFlashlightPacket;
exports.createFlashlightCommandPacket = createFlashlightCommandPacket;
exports.isFlashlightPacket = isFlashlightPacket;
const packet_1 = require("../packet");
exports.PACKET_TYPE_FLASHLIGHT = 'link.flashlight';
function createFlashlightPacket(enabled) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_FLASHLIGHT, { enabled });
}
function createFlashlightCommandPacket(enabled) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_FLASHLIGHT, { enabled, isCommand: true });
}
function isFlashlightPacket(packet) {
    return packet.type === exports.PACKET_TYPE_FLASHLIGHT;
}
//# sourceMappingURL=flashlight.js.map