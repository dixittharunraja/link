"use strict";
// Clipboard plugin.
// Supports text, image, and file sync using the link.clipboard.file packet type.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClipboardWatcher = exports.PACKET_TYPE_CLIPBOARD_FILE = exports.PACKET_TYPE_CLIPBOARD_CONNECT = exports.PACKET_TYPE_CLIPBOARD = void 0;
exports.createClipboardPacket = createClipboardPacket;
exports.createClipboardConnectPacket = createClipboardConnectPacket;
exports.isClipboardPacket = isClipboardPacket;
exports.extractIncomingClipboardText = extractIncomingClipboardText;
const electron_1 = require("electron");
const packet_1 = require("../packet");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
exports.PACKET_TYPE_CLIPBOARD = 'link.clipboard';
exports.PACKET_TYPE_CLIPBOARD_CONNECT = 'link.clipboard.connect';
exports.PACKET_TYPE_CLIPBOARD_FILE = 'link.clipboard.file';
function createClipboardPacket(content) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_CLIPBOARD, { content });
}
function createClipboardConnectPacket(content, timestamp) {
    return (0, packet_1.createPacket)(exports.PACKET_TYPE_CLIPBOARD_CONNECT, { content, timestamp });
}
function isClipboardPacket(packet) {
    return (packet.type === exports.PACKET_TYPE_CLIPBOARD ||
        packet.type === exports.PACKET_TYPE_CLIPBOARD_CONNECT ||
        packet.type === exports.PACKET_TYPE_CLIPBOARD_FILE);
}
/**
 * Extracts the text to apply locally from an incoming clipboard packet, or null if it should be
 * ignored.
 */
function extractIncomingClipboardText(packet, lastKnownTimestamp) {
    const body = packet.body;
    if (packet.type === exports.PACKET_TYPE_CLIPBOARD) {
        return typeof body.content === 'string' ? body.content : null;
    }
    if (packet.type === exports.PACKET_TYPE_CLIPBOARD_CONNECT) {
        if (!body.timestamp || body.timestamp < lastKnownTimestamp)
            return null;
        return typeof body.content === 'string' ? body.content : null;
    }
    return null;
}
/**
 * Electron's clipboard module has no native change event — polling is the only option.
 */
class ClipboardWatcher {
    onLocalChange;
    lastSeenText;
    lastSeenImageHash = '';
    lastSeenFilePath = '';
    lastSeenFileMtime = 0;
    lastUpdateTimestamp = Date.now();
    suppressNextChange = false;
    interval = null;
    constructor(onLocalChange, pollIntervalMs = 1000) {
        this.onLocalChange = onLocalChange;
        this.lastSeenText = electron_1.clipboard.readText();
        this.interval = setInterval(() => this.poll(), pollIntervalMs);
    }
    poll() {
        if (this.suppressNextChange) {
            this.suppressNextChange = false;
            return;
        }
        const formats = electron_1.clipboard.availableFormats();
        // 1. Check Image
        if (formats.includes('image/png') || formats.includes('image/jpeg')) {
            const img = electron_1.clipboard.readImage();
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
        // 2. Check File path (cross-platform)
        let filePath = '';
        if (process.platform === 'linux') {
            if (formats.includes('text/uri-list')) {
                const uriList = electron_1.clipboard.readBuffer('text/uri-list').toString('utf8');
                const lines = uriList.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));
                if (lines.length > 0 && lines[0].startsWith('file://')) {
                    try {
                        filePath = decodeURI(lines[0].substring(7));
                    }
                    catch { }
                }
            }
        }
        else if (formats.includes('FileNameW')) {
            const buf = electron_1.clipboard.readBuffer('FileNameW');
            if (buf && buf.length > 0) {
                filePath = buf.toString('ucs2').replace(/\0/g, '');
            }
        }
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
            }
            catch { }
        }
        // 3. Check Text fallback
        const current = electron_1.clipboard.readText();
        if (current !== this.lastSeenText) {
            this.lastSeenText = current;
            if (!current)
                return;
            this.lastSeenImageHash = '';
            this.lastSeenFilePath = '';
            this.lastUpdateTimestamp = Date.now();
            this.onLocalChange('text', current);
        }
    }
    /** Called when we write a peer's clipboard text locally. */
    applyRemote(content) {
        this.suppressNextChange = true;
        electron_1.clipboard.writeText(content);
        if (process.platform === 'linux') {
            electron_1.clipboard.writeText(content, 'selection'); // X11 primary selection (middle-click paste)
        }
        this.lastSeenText = content;
        this.lastSeenImageHash = '';
        this.lastSeenFilePath = '';
    }
    /** Called when we write a peer's clipboard file locally. */
    applyRemoteFile(filename, data) {
        this.suppressNextChange = true;
        const isImage = filename.toLowerCase().endsWith('.png') ||
            filename.toLowerCase().endsWith('.jpg') ||
            filename.toLowerCase().endsWith('.jpeg');
        if (isImage) {
            const { nativeImage } = require('electron');
            const img = nativeImage.createFromBuffer(data);
            electron_1.clipboard.writeImage(img);
            this.lastSeenImageHash = crypto.createHash('sha256').update(data).digest('hex');
            this.lastSeenText = '';
            this.lastSeenFilePath = '';
        }
        else {
            const tmpDir = path.join(electron_1.app.getPath('temp'), 'link-clipboard');
            fs.mkdirSync(tmpDir, { recursive: true });
            const filePath = path.join(tmpDir, filename);
            fs.writeFileSync(filePath, data);
            if (process.platform === 'linux') {
                electron_1.clipboard.writeBuffer('text/uri-list', Buffer.from(`file://${encodeURI(filePath)}\r\n`, 'utf8'));
                electron_1.clipboard.writeText(filePath);
            }
            else {
                const ucs2Buffer = Buffer.from(filePath + '\0', 'ucs2');
                electron_1.clipboard.write({
                    text: filePath,
                });
                electron_1.clipboard.writeBuffer('FileNameW', ucs2Buffer);
            }
            this.lastSeenText = filePath;
            this.lastSeenFilePath = filePath;
            try {
                this.lastSeenFileMtime = fs.statSync(filePath).mtimeMs;
            }
            catch { }
            this.lastSeenImageHash = '';
        }
    }
    currentContent() {
        return this.lastSeenText;
    }
    currentTimestamp() {
        return this.lastUpdateTimestamp;
    }
    stop() {
        if (this.interval)
            clearInterval(this.interval);
    }
}
exports.ClipboardWatcher = ClipboardWatcher;
//# sourceMappingURL=clipboard.js.map