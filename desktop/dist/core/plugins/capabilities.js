"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_CAPABILITIES = void 0;
exports.createCapabilitiesPacket = createCapabilitiesPacket;
exports.isCapabilitiesPacket = isCapabilitiesPacket;
// Effective-capabilities packet — a single, unified per-peer signal replacing ad-hoc per-plugin
// "revoked" flags (previously Flashlight/DND each carried their own bespoke revoked:true field).
//
// Sent to a specific peer whenever what they're currently allowed to do here changes (permission
// toggle, or connect-time initial sync). Lists exactly which of this device's own per-device-gated
// capability keys (e.g. 'presenter', 'touchpad', 'digitizer', 'systemvolume', 'mpris', 'flashlight',
// 'dnd') are CURRENTLY allowed for that peer. The receiving UI gates every button/section on
// membership in this list — no separate revoke marker needed, since a key's absence alone hides
// it regardless of whatever stale value the renderer still has cached from before.
const packet_1 = require("../packet");
exports.PACKET_TYPE_CAPABILITIES = 'link.capabilities';
function createCapabilitiesPacket(capabilities) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_CAPABILITIES, { capabilities });
}
function isCapabilitiesPacket(packet) {
    return packet.type === exports.PACKET_TYPE_CAPABILITIES;
}
//# sourceMappingURL=capabilities.js.map