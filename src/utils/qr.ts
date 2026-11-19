import { useState, useEffect } from 'react';

// The encoder is only needed when a code is actually drawn, so it is loaded then, outside the startup bundle.
type QRCodeLib = typeof import('qrcode');
let qrcodeModule: Promise<QRCodeLib> | null = null;
function loadQRCode(): Promise<QRCodeLib> {
  // qrcode is CommonJS: its functions sit on the interop default export (or the namespace itself in tests).
  qrcodeModule ??= import('qrcode').then((m) => (m as { default?: QRCodeLib }).default ?? m).catch((err) => {
    qrcodeModule = null; // let a later call retry
    throw err;
  });
  return qrcodeModule;
}

/**
 * Generates a Data URL for a `link:` QR code.
 *
 * @param target IP address or raw `link:...` URI
 * @param port Optional port number (appended as :port if not already present)
 */
export async function createLinkQrDataUrl(target: string, port?: number): Promise<string> {
  let qrText = target;
  if (!qrText.startsWith('link:')) {
    qrText = port !== undefined ? `link:${target}:${port}` : `link:${target}`;
  } else if (port !== undefined && !qrText.includes(`:${port}`)) {
    qrText = `${qrText}:${port}`;
  }

  const QRCode = await loadQRCode();
  return QRCode.toDataURL(qrText, {
    margin: 1,
    width: 160,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });
}

/**
 * The QR shown while pairing: the device's addresses and port, its key fingerprint (so the scanner can
 * tell it reached the right device with no code to compare) and a one-time token. It is a different
 * scheme from the `link:` codes of the guest tools, which carry only an address.
 */
export function pairingQrText(addresses: string, port: number, fingerprint: string, token: string): string {
  return `linkpair:${addresses}:${port}:${fingerprint}:${token}`;
}

interface PairingQr {
  addresses: string;
  fingerprint: string;
  token: string;
}

/** Reads a pairing QR; null for anything else (including a plain `link:` address). */
export function parsePairingQr(text: string): PairingQr | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('linkpair:')) return null;
  const parts = trimmed.slice('linkpair:'.length).split(':');
  if (parts.length !== 4) return null;
  const [addresses, , fingerprint, token] = parts;
  if (!addresses || !/^[0-9a-f]{64}$/i.test(fingerprint) || !/^[0-9a-f]{32}$/i.test(token)) return null;
  return { addresses, fingerprint: fingerprint.toLowerCase(), token: token.toLowerCase() };
}

export async function createPairingQrDataUrl(addresses: string, port: number, fingerprint: string, token: string): Promise<string> {
  const QRCode = await loadQRCode();
  return QRCode.toDataURL(pairingQrText(addresses, port, fingerprint, token), {
    // A scanner needs a clear border (the spec says 4 modules) and a long code needs room per module.
    margin: 4,
    errorCorrectionLevel: 'L',
    width: 320,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/**
 * The QR a tool shows to guests: `link:<addresses>:<port>:<fingerprint>:<token>`. The fields after the port
 * are the host's key fingerprint (so a scanning device can tell it reached the right host, with no PIN to
 * compare) and a one-time token. Anything that reads only the first two or three fields, as every older
 * reader of `link:` codes does, still works.
 */
export function toolQrText(addresses: string, port: number, fingerprint: string, token: string): string {
  return `link:${addresses}:${port}:${fingerprint}:${token}`;
}

interface ToolQr {
  addresses: string;
  port: number;
  fingerprint: string;
  token: string;
}

/** Reads a tool QR that carries a fingerprint and token; null for a plain address code. */
export function parseToolQr(text: string): ToolQr | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('link:')) return null;
  const parts = trimmed.slice('link:'.length).split(':');
  if (parts.length !== 4) return null;
  const [addresses, portText, fingerprint, token] = parts;
  const port = Number(portText);
  if (!addresses || !Number.isInteger(port) || !/^[0-9a-f]{64}$/i.test(fingerprint) || !/^[0-9a-f]{32}$/i.test(token)) return null;
  return { addresses, port, fingerprint: fingerprint.toLowerCase(), token: token.toLowerCase() };
}

async function toolQrDataUrl(addresses: string, port: number, fingerprint: string, token: string): Promise<string> {
  const QRCode = await loadQRCode();
  return QRCode.toDataURL(toolQrText(addresses, port, fingerprint, token), {
    margin: 4,
    errorCorrectionLevel: 'L',
    width: 320,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/**
 * React hook that generates the QR data URL for a hosted session. While it is shown, the tool's one-time
 * token is live and renewed before it expires; the token stops working when the code is no longer shown.
 */
export function useHostQrCode(
  hosting: boolean,
  localIdentity: { ipAddress?: string; ipAddresses?: string[] } | undefined,
  port: number
): string | null {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hosting) {
      setQrDataUrl(null);
      return;
    }
    const ip = (localIdentity?.ipAddresses && localIdentity.ipAddresses.length > 0)
      ? localIdentity.ipAddresses.join(',')
      : (localIdentity?.ipAddress || '127.0.0.1');
    const api = window.link;
    let cancelled = false;
    let fingerprint = '';
    const draw = async (token: string) => {
      const url = await toolQrDataUrl(ip, port, fingerprint, token);
      if (!cancelled) setQrDataUrl(url);
    };
    (async () => {
      try {
        if (!api?.openGuestQr) {
          // A build without verified codes: a plain address code, verified by comparing PINs.
          const url = await createLinkQrDataUrl(ip, port);
          if (!cancelled) setQrDataUrl(url);
          return;
        }
        const opened = await api.openGuestQr(port);
        fingerprint = opened.fingerprint;
        await draw(opened.token);
      } catch (err) {
        console.error(`Failed to generate QR (port ${port}):`, err);
      }
    })();
    const renew = setInterval(() => {
      api?.refreshGuestQr?.(port).then((token) => { if (token && fingerprint) void draw(token); }).catch(() => {});
    }, 30000);
    return () => {
      cancelled = true;
      clearInterval(renew);
      void api?.closeGuestQr?.(port);
    };
  }, [hosting, localIdentity, port]);

  return qrDataUrl;
}
