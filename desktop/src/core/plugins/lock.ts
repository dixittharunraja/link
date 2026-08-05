// Lock plugin.
// Enables locking the desktop device remotely and querying/reporting lock state. See docs/PROTOCOL.md.

import { exec } from 'child_process';
import { LinkPacket, createPacket } from '../packet';

export const PACKET_TYPE_LOCK = 'link.lock';
export const PACKET_TYPE_LOCK_REQUEST = 'link.lock.request';

export interface LockBody {
  isLocked?: boolean;
  lockResult?: boolean;
}

export interface LockRequestBody {
  setLocked?: boolean;
  requestLocked?: boolean;
}

export function isLockPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_LOCK;
}

export function isLockRequestPacket(packet: LinkPacket): boolean {
  return packet.type === PACKET_TYPE_LOCK_REQUEST;
}

export function createLockPacket(isLocked: boolean, lockResult?: boolean): LinkPacket<LockBody> {
  const body: LockBody = { isLocked };
  if (lockResult !== undefined) {
    body.lockResult = lockResult;
  }
  return createPacket(PACKET_TYPE_LOCK, body);
}

export function createLockRequestPacket(setLocked?: boolean, requestLocked?: boolean): LinkPacket<LockRequestBody> {
  const body: LockRequestBody = {};
  if (setLocked !== undefined) body.setLocked = setLocked;
  if (requestLocked !== undefined) body.requestLocked = requestLocked;
  return createPacket(PACKET_TYPE_LOCK_REQUEST, body);
}

// Track local lock state statically since Windows doesn't make session lock events easy to query natively.
let localLockedState = false;

export function lockThisDevice(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      console.warn('[Link] Lock is only implemented for Windows (win32) platform.');
      resolve(false);
      return;
    }

    exec('rundll32.exe user32.dll,LockWorkStation', (error) => {
      if (error) {
        console.error('[Link] Failed to lock workstation:', error);
        resolve(false);
      } else {
        localLockedState = true;
        resolve(true);
      }
    });
  });
}

export function isLocalDeviceLocked(): boolean {
  return localLockedState;
}

export function setLocalLockedState(locked: boolean) {
  localLockedState = locked;
}
