import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ports from './ports';

// The QR codes are only right while these match the servers, so the native sources are read here
// and any drift fails the test.
const repo = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(repo, path), 'utf8');

function constant(source: string, name: string): string {
  const match = source.match(new RegExp(`\\b${name}\\s*(?::\\s*u16)?\\s*=\\s*([^;]+);`));
  if (!match) throw new Error(`${name} not found`);
  return match[1].replace(/\/\/.*$/, '').trim();
}

// Evaluates "LINK_PORT + 3"-style expressions against the values resolved so far.
function evaluate(expr: string, known: Record<string, number>): number {
  return expr
    .replace(/crate::core::transport::/g, '')
    .split('+')
    .map((term) => term.trim())
    .reduce((sum, term) => sum + (/^\d+$/.test(term) ? Number(term) : known[term]), 0);
}

describe('port constants', () => {
  it('match the desktop servers', () => {
    const known: Record<string, number> = {};
    known.LINK_PORT = evaluate(constant(read('src-tauri/src/core/transport.rs'), 'LINK_PORT'), known);
    const audio = read('src-tauri/src/core/audio_sink.rs');
    known.AUDIO_SINK_PORT = evaluate(constant(audio, 'AUDIO_SINK_PORT'), known);
    known.REMOTE_MIC_PORT = evaluate(constant(audio, 'REMOTE_MIC_PORT'), known);
    known.PORTAL_PORT = evaluate(constant(read('src-tauri/src/core/portal.rs'), 'PORTAL_PORT'), known);
    known.WALKIE_TALKIE_PORT = evaluate(constant(read('src-tauri/src/core/walkie_talkie.rs'), 'WALKIE_TALKIE_PORT'), known);
    known.JOYSTICK_PORT = evaluate(constant(read('src-tauri/src/core/joystick.rs'), 'JOYSTICK_PORT'), known);
    known.INPUT_GUEST_PORT = evaluate(constant(read('src-tauri/src/core/input_guest.rs'), 'INPUT_GUEST_PORT'), known);

    expect(known).toEqual({ ...ports });
  });

  it('match the Android servers', () => {
    const java = read('src-tauri/android/java/in/rodix/link/LinkTransport.java');
    const known: Record<string, number> = {};
    for (const name of ['LINK_PORT', 'AUDIO_RELAY_PORT', 'PORTAL_TRANSFER_PORT', 'WALKIE_TALKIE_PORT', 'JOYSTICK_PORT', 'INPUT_GUEST_PORT']) {
      known[name] = evaluate(constant(java, name), known);
    }

    expect(known.LINK_PORT).toBe(ports.LINK_PORT);
    expect(known.AUDIO_RELAY_PORT).toBe(ports.AUDIO_SINK_PORT);
    // LinkPlugin.java starts the Remote Mic server on AUDIO_RELAY_PORT + 2.
    expect(known.AUDIO_RELAY_PORT + 2).toBe(ports.REMOTE_MIC_PORT);
    expect(known.PORTAL_TRANSFER_PORT).toBe(ports.PORTAL_PORT);
    expect(known.WALKIE_TALKIE_PORT).toBe(ports.WALKIE_TALKIE_PORT);
    expect(known.JOYSTICK_PORT).toBe(ports.JOYSTICK_PORT);
    expect(known.INPUT_GUEST_PORT).toBe(ports.INPUT_GUEST_PORT);
  });
});
