"use strict";
// Lock plugin.
// Enables locking the desktop device remotely and querying/reporting lock state. See docs/PROTOCOL.md.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKET_TYPE_LOCK_REQUEST = exports.PACKET_TYPE_LOCK = void 0;
exports.isLockPacket = isLockPacket;
exports.isLockRequestPacket = isLockRequestPacket;
exports.createLockPacket = createLockPacket;
exports.createLockRequestPacket = createLockRequestPacket;
exports.lockThisDevice = lockThisDevice;
exports.isLocalDeviceLocked = isLocalDeviceLocked;
exports.setLocalLockedState = setLocalLockedState;
const child_process_1 = require("child_process");
const packet_1 = require("../packet");
exports.PACKET_TYPE_LOCK = 'link.lock';
exports.PACKET_TYPE_LOCK_REQUEST = 'link.lock.request';
function isLockPacket(packet) {
    return packet.type === exports.PACKET_TYPE_LOCK;
}
function isLockRequestPacket(packet) {
    return packet.type === exports.PACKET_TYPE_LOCK_REQUEST;
}
function createLockPacket(isLocked, lockResult) {
    const body = { isLocked };
    if (lockResult !== undefined) {
        body.lockResult = lockResult;
    }
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_LOCK, body);
}
function createLockRequestPacket(setLocked, requestLocked) {
    const body = {};
    if (setLocked !== undefined)
        body.setLocked = setLocked;
    if (requestLocked !== undefined)
        body.requestLocked = requestLocked;
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_LOCK_REQUEST, body);
}
// Track local lock state statically since Windows doesn't make session lock events easy to query natively.
let localLockedState = false;
function lockThisDevice() {
    return new Promise((resolve) => {
        if (process.platform === 'linux') {
            (0, child_process_1.exec)('loginctl lock-session || xdg-screensaver lock', (error) => {
                if (error) {
                    console.error('[Link] Failed to lock workstation on Linux:', error);
                    resolve(false);
                }
                else {
                    localLockedState = true;
                    resolve(true);
                }
            });
            return;
        }
        if (process.platform !== 'win32') {
            console.warn('[Link] Lock is only implemented for Windows (win32) and Linux platforms.');
            resolve(false);
            return;
        }
        (0, child_process_1.exec)('rundll32.exe user32.dll,LockWorkStation', (error) => {
            if (error) {
                console.error('[Link] Failed to lock workstation:', error);
                resolve(false);
            }
            else {
                localLockedState = true;
                resolve(true);
            }
        });
    });
}
function isLocalDeviceLocked() {
    return localLockedState;
}
function setLocalLockedState(locked) {
    localLockedState = locked;
}
//# sourceMappingURL=lock.js.map