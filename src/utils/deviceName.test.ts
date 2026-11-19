import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVICE_NAME_MAX } from './deviceName';

// The rename boxes stop at DEVICE_NAME_MAX; the desktop and Android filters cut names at their own
// constant. Any drift between the three fails here.
const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
const value = (source: string, pattern: RegExp) => Number(source.match(pattern)?.[1]);

describe('device name limit', () => {
  it('matches the desktop and Android filters', () => {
    expect(value(read('src-tauri/src/core/identity.rs'), /const MAX_NAME_LENGTH: usize = (\d+);/)).toBe(DEVICE_NAME_MAX);
    expect(value(read('src-tauri/android/java/in/rodix/link/LinkIdentity.java'), /MAX_NAME_LENGTH = (\d+);/)).toBe(DEVICE_NAME_MAX);
  });
});
