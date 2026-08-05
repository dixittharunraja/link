// Clipboard plugin.
// Supports text, image, and file sync using the link.clipboard.file packet type.

import { clipboard, app } from 'electron';
import { LinkPacket, createPacket } from '../packet';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const PACKET_TYPE_CLIPBOARD = 'link.clipboard';
export const PACKET_TYPE_CLIPBOARD_CONNECT = 'link.clipboard.connect';
export const PACKET_TYPE_CLIPBOARD_FILE = 'link.clipboard.file';

interface ClipboardBody {
  content: string;
}

interface ClipboardConnectBody {
  content: string;
  timestamp: number;
}

export function createClipboardPacket(content: string): LinkPacket<ClipboardBody> {
  return createPacket(PACKET_TYPE_CLIPBOARD, { content });
}

export function createClipboardConnectPacket(content: string, timestamp: number): LinkPacket<ClipboardConnectBody> {
  return createPacket(PACKET_TYPE_CLIPBOARD_CONNECT, { content, timestamp });
}

export function isClipboardPacket(packet: LinkPacket): boolean {
  return (
    packet.type === PACKET_TYPE_CLIPBOARD ||
    packet.type === PACKET_TYPE_CLIPBOARD_CONNECT ||
    packet.type === PACKET_TYPE_CLIPBOARD_FILE
  );
}

/**
 * Extracts the text to apply locally from an incoming clipboard packet, or null if it should be
 * ignored.
 */
export function extractIncomingClipboardText(packet: LinkPacket, lastKnownTimestamp: number): string | null {
  const body = packet.body as Partial<ClipboardBody & ClipboardConnectBody>;
  if (packet.type === PACKET_TYPE_CLIPBOARD) {
    return typeof body.content === 'string' ? body.content : null;
  }
  if (packet.type === PACKET_TYPE_CLIPBOARD_CONNECT) {
    if (!body.timestamp || body.timestamp < lastKnownTimestamp) return null;
    return typeof body.content === 'string' ? body.content : null;
  }
  return null;
}

/**
 * Electron's clipboard module has no native change event — polling is the only option.
 */
export class ClipboardWatcher {
  private lastSeenText: string;
  private lastSeenImageHash = '';
  private lastSeenFilePath = '';
  private lastSeenFileMtime = 0;
  private lastUpdateTimestamp = Date.now();
  private suppressNextChange = false;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private onLocalChange: (type: 'text' | 'file', data: string | { filename: string; buffer: Buffer }) => void,
    pollIntervalMs = 1000
  ) {
    this.lastSeenText = clipboard.readText();
    this.interval = setInterval(() => this.poll(), pollIntervalMs);
  }

  private poll() {
    if (this.suppressNextChange) {
      this.suppressNextChange = false;
      return;
    }

    const formats = clipboard.availableFormats();

    // 1. Check Image
    if (formats.includes('image/png') || formats.includes('image/jpeg')) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        // Fingerprint the RAW bitmap, and only PNG-encode once something actually changed.
        //
        // This used to call toPNG() every single tick just to produce bytes to hash. toPNG() is a
        // full zlib compression pass over the whole image, so copying one 4K screenshot left the
        // main process re-compressing several megabytes once a second for as long as that image
        // stayed on the clipboard — burning CPU forever after a single Ctrl+C and starving
        // everything else the main process serves, including the UI's IPC.
        // toBitmap() hands back the already-decoded buffer with no compression work at all.
        const bitmap = img.toBitmap();
        const size = img.getSize();
        const hash = crypto
          .createHash('sha1')
          .update(`${size.width}x${size.height}:`)
          .update(bitmap)
          .digest('hex');

        if (hash !== this.lastSeenImageHash) {
          this.lastSeenImageHash = hash;
          this.lastSeenText = '';
          this.lastSeenFilePath = '';
          this.onLocalChange('file', {
            filename: `ClipboardImage_${Date.now()}.png`,
            buffer: img.toPNG(),
          });
        }
        return;
      }
    }

    // 2. Check File path (Windows)
    if (formats.includes('FileNameW')) {
      const buf = clipboard.readBuffer('FileNameW');
      if (buf && buf.length > 0) {
        const filePath = buf.toString('ucs2').replace(/\0/g, '');
        if (filePath && fs.existsSync(filePath)) {
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              if (filePath !== this.lastSeenFilePath || stat.mtimeMs !== this.lastSeenFileMtime) {
                this.lastSeenFilePath = filePath;
                this.lastSeenFileMtime = stat.mtimeMs;
                this.lastSeenText = '';
                this.lastSeenImageHash = '';
                
                const fileBuf = fs.readFileSync(filePath);
                const filename = path.basename(filePath);
                this.onLocalChange('file', { filename, buffer: fileBuf });
              }
              return;
            }
          } catch {}
        }
      }
    }

    // 3. Check Text fallback
    const current = clipboard.readText();
    if (current !== this.lastSeenText) {
      this.lastSeenText = current;
      if (!current) return;
      this.lastSeenImageHash = '';
      this.lastSeenFilePath = '';
      this.lastUpdateTimestamp = Date.now();
      this.onLocalChange('text', current);
    }
  }

  /** Called when we write a peer's clipboard text locally. */
  applyRemote(content: string) {
    this.suppressNextChange = true;
    clipboard.writeText(content);
    this.lastSeenText = content;
    this.lastSeenImageHash = '';
    this.lastSeenFilePath = '';
  }

  /** Called when we write a peer's clipboard file locally. */
  applyRemoteFile(filename: string, data: Buffer) {
    this.suppressNextChange = true;
    const isImage =
      filename.toLowerCase().endsWith('.png') ||
      filename.toLowerCase().endsWith('.jpg') ||
      filename.toLowerCase().endsWith('.jpeg');
    if (isImage) {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromBuffer(data);
      clipboard.writeImage(img);
      this.lastSeenImageHash = crypto.createHash('sha256').update(data).digest('hex');
      this.lastSeenText = '';
      this.lastSeenFilePath = '';
    } else {
      const tmpDir = path.join(app.getPath('temp'), 'link-clipboard');
      fs.mkdirSync(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, filename);
      fs.writeFileSync(filePath, data);

      const ucs2Buffer = Buffer.from(filePath + '\0', 'ucs2');
      clipboard.write({
        text: filePath,
      });
      clipboard.writeBuffer('FileNameW', ucs2Buffer);

      this.lastSeenText = filePath;
      this.lastSeenFilePath = filePath;
      try {
        this.lastSeenFileMtime = fs.statSync(filePath).mtimeMs;
      } catch {}
      this.lastSeenImageHash = '';
    }
  }

  currentContent(): string {
    return this.lastSeenText;
  }

  currentTimestamp(): number {
    return this.lastUpdateTimestamp;
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }
}
