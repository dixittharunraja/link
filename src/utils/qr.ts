import { useState, useEffect } from 'react';
import QRCode from 'qrcode';

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
 * React hook that automatically generates a QR data URL for host sessions.
 */
export function useHostQrCode(
  hosting: boolean,
  localIdentity: { ipAddress?: string; ipAddresses?: string[] } | undefined,
  port: number
): string | null {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (hosting) {
      const ip = (localIdentity?.ipAddresses && localIdentity.ipAddresses.length > 0)
        ? localIdentity.ipAddresses.join(',')
        : (localIdentity?.ipAddress || '127.0.0.1');
      createLinkQrDataUrl(ip, port)
        .then((url) => setQrDataUrl(url))
        .catch((err) => console.error(`Failed to generate QR (port ${port}):`, err));
    } else {
      setQrDataUrl(null);
    }
  }, [hosting, localIdentity, port]);

  return qrDataUrl;
}

