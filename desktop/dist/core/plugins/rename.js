"use strict";
// Device rename sync — a device's name is self-owned (matches the identity/pairing model: only
// the device itself ever writes its own identity.deviceName). Renaming a peer from another
// device sends a REQUEST; the target applies it to itself and then broadcasts the authoritative
// result to every device it's connected to, so the new name actually propagates across the mesh
// instead of being a local-only alias.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_RENAME_REQUEST = exports.PACKET_TYPE_RENAME = void 0;
exports.createRenamePacket = createRenamePacket;
exports.createRenameRequestPacket = createRenameRequestPacket;
exports.isRenamePacket = isRenamePacket;
exports.isRenameRequestPacket = isRenameRequestPacket;
const packet_1 = require("../packet");
exports.PACKET_TYPE_RENAME = 'link.rename';
exports.PACKET_TYPE_RENAME_REQUEST = 'link.rename.request';
function createRenamePacket(deviceName) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_RENAME, { deviceName });
}
function createRenameRequestPacket(deviceName) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_RENAME_REQUEST, { deviceName });
}
function isRenamePacket(packet) {
    return packet.type === exports.PACKET_TYPE_RENAME;
}
function isRenameRequestPacket(packet) {
    return packet.type === exports.PACKET_TYPE_RENAME_REQUEST;
}
//# sourceMappingURL=rename.js.map