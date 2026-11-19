import { describe, expect, it } from 'vitest';
import { pairingQrText, parsePairingQr } from './qr';

const fingerprint = 'ab'.repeat(32);
const token = 'cd'.repeat(16);

describe('pairing QR', () => {
  it('round-trips the addresses, fingerprint and token', () => {
    const text = pairingQrText('192.168.1.5,10.0.0.2', 1739, fingerprint, token);
    expect(parsePairingQr(text)).toEqual({ addresses: '192.168.1.5,10.0.0.2', fingerprint, token });
  });

  it('ignores plain address codes, which carry nothing to verify', () => {
    expect(parsePairingQr('link:192.168.1.5:1739')).toBeNull();
    expect(parsePairingQr('192.168.1.5')).toBeNull();
  });

  it('rejects a code with a malformed fingerprint or token', () => {
    expect(parsePairingQr(pairingQrText('10.0.0.2', 1739, 'abc', token))).toBeNull();
    expect(parsePairingQr(pairingQrText('10.0.0.2', 1739, fingerprint, 'xyz'))).toBeNull();
    expect(parsePairingQr('linkpair:10.0.0.2:1739')).toBeNull();
  });
});

describe('tool QR', () => {
  it('round-trips the addresses, port, fingerprint and token', async () => {
    const { toolQrText, parseToolQr } = await import('./qr');
    const text = toolQrText('192.168.1.5,10.0.0.2', 1748, fingerprint, token);
    expect(parseToolQr(text)).toEqual({ addresses: '192.168.1.5,10.0.0.2', port: 1748, fingerprint, token });
  });

  it('leaves a plain address code to the older readers', async () => {
    const { parseToolQr } = await import('./qr');
    expect(parseToolQr('link:192.168.1.5:1748')).toBeNull();
    expect(parseToolQr('link:192.168.1.5')).toBeNull();
  });

  it('is still read by anything that takes the second field as the address', async () => {
    const { toolQrText } = await import('./qr');
    expect(toolQrText('192.168.1.5', 1748, fingerprint, token).split(':')[1]).toBe('192.168.1.5');
  });
});
