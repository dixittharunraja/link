"use strict";
// Presenter plugin.
// Handles mapping relative movement increments (dx/dy) to screen coordinate changes 
// for displaying the pointer overlay.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenterPosition = exports.PACKET_TYPE_PRESENTER = void 0;
exports.createPresenterMovePacket = createPresenterMovePacket;
exports.createPresenterStopPacket = createPresenterStopPacket;
exports.isPresenterPacket = isPresenterPacket;
exports.isPresenterStopPacket = isPresenterStopPacket;
exports.clamp01 = clamp01;
const packet_1 = require("../packet");
exports.PACKET_TYPE_PRESENTER = 'link.presenter';
function createPresenterMovePacket(dx, dy) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_PRESENTER, { dx, dy });
}
function createPresenterStopPacket() {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_PRESENTER, { stop: true });
}
function isPresenterPacket(packet) {
    return packet.type === exports.PACKET_TYPE_PRESENTER;
}
function isPresenterStopPacket(packet) {
    return packet.type === exports.PACKET_TYPE_PRESENTER && packet.body.stop === true;
}
/**
 * Tracks the normalized (0-1) dot position, matching upstream's exact math: dx added directly to
 * x, dy scaled by the screen aspect ratio before being added to y, both clamped to [0,1].
 */
class PresenterPosition {
    aspectRatio;
    x = 0.5;
    y = 0.5;
    constructor(aspectRatio) {
        this.aspectRatio = aspectRatio;
    }
    update(dx, dy) {
        this.x = clamp01(this.x + dx);
        this.y = clamp01(this.y + dy * this.aspectRatio);
        return { x: this.x, y: this.y };
    }
    reset() {
        this.x = 0.5;
        this.y = 0.5;
    }
}
exports.PresenterPosition = PresenterPosition;
function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}
//# sourceMappingURL=presenter.js.map