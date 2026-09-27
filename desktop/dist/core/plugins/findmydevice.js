"use strict";
// Find My Device plugin. Same packet type is used in either direction. See docs/PROTOCOL.md §8.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_FINDMYDEVICE_REQUEST = void 0;
exports.createFindMyDevicePacket = createFindMyDevicePacket;
exports.isFindMyDevicePacket = isFindMyDevicePacket;
exports.stopRinging = stopRinging;
exports.ringThisDevice = ringThisDevice;
const child_process_1 = require("child_process");
const packet_1 = require("../packet");
exports.PACKET_TYPE_FINDMYDEVICE_REQUEST = 'link.findmydevice.request';
function createFindMyDevicePacket(cancel = false) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_FINDMYDEVICE_REQUEST, cancel ? { cancel: true } : {});
}
function isFindMyDevicePacket(packet) {
    return packet.type === exports.PACKET_TYPE_FINDMYDEVICE_REQUEST;
}
let ringProcess = null;
let ringTimeout = null;
function stopRinging() {
    if (ringTimeout) {
        clearTimeout(ringTimeout);
        ringTimeout = null;
    }
    if (ringProcess) {
        if (ringProcess.pid) {
            try {
                const { execSync } = require('child_process');
                if (process.platform === 'linux') {
                    execSync(`pkill -P ${ringProcess.pid}`, { stdio: 'ignore' });
                }
                else {
                    execSync(`taskkill /pid ${ringProcess.pid} /t /f`, { stdio: 'ignore' });
                }
            }
            catch (e) { }
        }
        try {
            ringProcess.kill('SIGKILL');
        }
        catch (e) { }
        ringProcess = null;
    }
}
/** Loops an alarm sound at system volume until stopped (or 60s safety timeout). */
function ringThisDevice() {
    stopRinging();
    let proc;
    if (process.platform === 'linux') {
        // Loop a system alarm sound infinitely, falling back between paplay/pw-play depending on
        // which audio server is running.
        proc = (0, child_process_1.exec)('bash -c "while true; do paplay /usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga || pw-play /usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga || sleep 1; done"');
    }
    else {
        // Loop Alarm01.wav infinitely in the child process
        proc = (0, child_process_1.exec)(`powershell -NoProfile -Command "$sound = New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav'; while ($true) { $sound.PlaySync() }"`);
    }
    ringProcess = proc;
    proc.on('exit', () => {
        if (ringProcess === proc) {
            ringProcess = null;
        }
    });
    // 60-second safety-net timeout to auto-stop ringing
    ringTimeout = setTimeout(() => {
        stopRinging();
    }, 60000);
}
//# sourceMappingURL=findmydevice.js.map