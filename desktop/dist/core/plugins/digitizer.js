"use strict";
// Digitizer plugin — absolute positioning / graphics drawing tablet support.
// Tracks session dimensions and maps absolute coordinates to screen ratios,
// controlling the global mouse helper process.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DigitizerHandler = exports.PACKET_TYPE_DIGITIZER = exports.PACKET_TYPE_DIGITIZER_SESSION = void 0;
exports.isDigitizerSessionPacket = isDigitizerSessionPacket;
exports.isDigitizerPacket = isDigitizerPacket;
exports.PACKET_TYPE_DIGITIZER_SESSION = 'link.digitizer.session';
exports.PACKET_TYPE_DIGITIZER = 'link.digitizer';
function isDigitizerSessionPacket(packet) {
    return packet.type === exports.PACKET_TYPE_DIGITIZER_SESSION;
}
function isDigitizerPacket(packet) {
    return packet.type === exports.PACKET_TYPE_DIGITIZER;
}
class DigitizerHandler {
    touchpadHandler;
    width = 0;
    height = 0;
    constructor(touchpadHandler) {
        this.touchpadHandler = touchpadHandler;
    }
    handleSession(packet) {
        const body = packet.body;
        if (body.action === 'start') {
            this.width = body.width || 0;
            this.height = body.height || 0;
            console.log(`[Digitizer] Session started: ${this.width}x${this.height}`);
        }
        else {
            this.width = 0;
            this.height = 0;
            console.log('[Digitizer] Session ended');
            this.touchpadHandler.writeCommand('touch false');
        }
    }
    handleEvent(packet) {
        const body = packet.body;
        if (body.active === false) {
            this.touchpadHandler.writeCommand('touch false');
            return;
        }
        if (body.touching !== undefined) {
            this.touchpadHandler.writeCommand(`touch ${body.touching}`);
        }
        if (body.x !== undefined && body.y !== undefined && this.width > 0 && this.height > 0) {
            const rx = Math.max(0, Math.min(1.0, body.x / this.width));
            const ry = Math.max(0, Math.min(1.0, body.y / this.height));
            this.touchpadHandler.writeCommand(`abs ${rx} ${ry}`);
        }
    }
}
exports.DigitizerHandler = DigitizerHandler;
//# sourceMappingURL=digitizer.js.map