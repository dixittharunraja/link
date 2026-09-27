"use strict";
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
exports.LinkFsMountService = void 0;
const http = __importStar(require("http"));
const child_process = __importStar(require("child_process"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
// Supply-chain hardening: pinned SHA-256 of the rclone.exe we bundle (vendor/rclone/rclone.exe).
// We spawn this binary with filesystem access, so before running it we verify it byte-for-byte
// against this known-good hash and refuse on mismatch — a swapped/trojaned binary (tampered
// install dir, malware, a bad supply-chain artifact) can't be silently executed. Regenerate this
// constant with `sha256sum desktop/vendor/rclone/rclone.exe` whenever the bundled rclone is
// intentionally upgraded, or the check will (correctly) block the new one.
const RCLONE_PINNED_SHA256 = '3ac0dba3a883555f0c0daabc8a87c8f78e531f339780335e07beadf77734b5bc';
// Same idea, for the vendored Linux binary (vendor/rclone/rclone, no extension). Regenerate with
// `sha256sum desktop/vendor/rclone/rclone` whenever that binary is intentionally upgraded.
const RCLONE_LINUX_PINNED_SHA256 = '9f56ca5edfac24a3ed37226c2ba1de69f1ec9e05fa2526cddee5cd97e202be6b';
class LinkFsMountService {
    client;
    driveLetter;
    volumeLabel;
    deviceType;
    server = null;
    rcloneProcess = null;
    roots = [];
    port = 0;
    constructor(client, driveLetter = 'Z:', volumeLabel = 'My Phone', deviceType = 'phone') {
        this.client = client;
        this.driveLetter = driveLetter;
        this.volumeLabel = volumeLabel;
        this.deviceType = deviceType;
    }
    getDriveLetter() {
        return this.driveLetter;
    }
    getPort() {
        return this.port;
    }
    getRoots() {
        return this.roots;
    }
    async mount() {
        // A listRoots() failure here previously got silently masked by substituting a hardcoded
        // fake root (an Android-shaped path even when the peer was a desktop) and mounting anyway —
        // meaning a peer who denied 'fileaccess' still got a drive letter presented, just one that
        // errored on every subsequent read. Propagate the failure instead: no roots means no mount,
        // full stop, whether the cause is a denied permission, a disconnect, or a genuine error.
        this.roots = await this.client.listRoots();
        this.roots = this.roots.map(r => ({
            name: r.name || 'Internal Storage',
            path: r.path,
            totalSpace: r.totalSpace,
            freeSpace: r.freeSpace
        }));
        console.log('[FsMountService] Retrieved roots from peer:', this.roots);
        return new Promise((resolve, reject) => {
            // 1. Start the HTTP WebDAV Server
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });
            this.server.on('error', (err) => {
                console.error('[FsMountService] HTTP WebDAV server error:', err.message);
                reject(err);
            });
            this.server.listen(0, '127.0.0.1', () => {
                const address = this.server.address();
                this.port = address.port;
                console.log(`[FsMountService] Local WebDAV HTTP Server listening on http://127.0.0.1:${this.port}`);
                // 2. Spawn Rclone Mount
                this.spawnRclone(resolve, reject);
            });
        });
    }
    unmount() {
        console.log('[FsMountService] Unmounting...');
        this.cleanup();
    }
    setDriveRegistry(driveLetter, label) {
        const letter = driveLetter.replace(':', '');
        const regPath = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons\\${letter}`;
        // Set the drive label shown in Explorer (e.g. "Harmony")
        child_process.exec(`reg add "${regPath}\\DefaultLabel" /ve /d "${label}" /f`, (err) => {
            if (err)
                console.error('[FsMountService] Failed to set registry label:', err);
            else
                console.log(`[FsMountService] Drive label set to: ${label}`);
        });
    }
    clearDriveRegistry(driveLetter) {
        const letter = driveLetter.replace(':', '');
        const regPath = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons\\${letter}`;
        child_process.exec(`reg delete "${regPath}" /f`, () => { });
    }
    cleanup() {
        if (process.platform !== 'linux') {
            this.clearDriveRegistry(this.driveLetter);
        }
        if (this.rcloneProcess) {
            try {
                this.rcloneProcess.kill();
            }
            catch { }
            this.rcloneProcess = null;
        }
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        if (process.platform === 'linux') {
            // Best-effort safety net behind rclone's own clean SIGTERM shutdown (see docs/linux.txt) —
            // some distros only ship fusermount3 (fuse3), others only the older fusermount (fuse2), so
            // try the modern name first and fall back rather than hardcoding one.
            child_process.exec(`fusermount3 -u "${this.driveLetter}"`, (err) => {
                if (err)
                    child_process.exec(`fusermount -u "${this.driveLetter}"`, () => { });
            });
        }
        else {
            // Force windows to release the drive mapping just in case
            child_process.exec(`net use ${this.driveLetter} /delete /y`, () => { });
        }
    }
    spawnRclone(resolve, reject) {
        const isDev = process.argv.includes('--dev');
        // Locate packaged or dev-time rclone binary
        const baseDir = isDev ? path.join(__dirname, '..', '..') : path.join(process.resourcesPath || __dirname, '..');
        const isLinux = process.platform === 'linux';
        const rclonePath = path.join(baseDir, 'vendor', 'rclone', isLinux ? 'rclone' : 'rclone.exe');
        const expectedHash = isLinux ? RCLONE_LINUX_PINNED_SHA256 : RCLONE_PINNED_SHA256;
        console.log(`[FsMountService] Using rclone binary path: ${rclonePath}`);
        if (!fs.existsSync(rclonePath)) {
            return reject(new Error(`rclone not found at: ${rclonePath}`));
        }
        // Integrity-pin the binary before spawning it (see RCLONE_PINNED_SHA256/RCLONE_LINUX_PINNED_SHA256).
        // One-time hash at mount start (~100ms for the ~78MB binary), never in the transfer path — no
        // throughput impact.
        const actualHash = crypto.createHash('sha256').update(fs.readFileSync(rclonePath)).digest('hex');
        if (actualHash !== expectedHash) {
            return reject(new Error(`rclone failed its integrity check — refusing to run a possibly-tampered binary. ` +
                `Expected ${expectedHash.slice(0, 12)}…, got ${actualHash.slice(0, 12)}…. ` +
                `If you intentionally updated rclone, regenerate the pinned SHA-256 constant in fs-mount-service.ts.`));
        }
        if (isLinux) {
            fs.mkdirSync(this.driveLetter, { recursive: true });
        }
        else {
            // Set registry label and icon BEFORE spawning so Explorer picks them up
            // as soon as the drive letter becomes visible.
            this.setDriveRegistry(this.driveLetter, this.volumeLabel);
        }
        const webdavUrl = `http://127.0.0.1:${this.port}/`;
        const cleanLabel = this.volumeLabel || 'Phone';
        // Construct rclone mount arguments
        // We mount as ':webdav:' on the fly remote
        const args = [
            'mount',
            ':webdav:',
            this.driveLetter,
            '--webdav-url', webdavUrl,
            '--webdav-vendor', 'other',
            '--volname', cleanLabel,
            // 'full' (was 'writes') is the single most important flag for perceived speed: 'writes'
            // caches ONLY written files, so every READ — including Windows Explorer re-opening each MP3
            // several times to extract album art/duration/bitrate/thumbnails, and replaying/seeking a
            // media file — went back over the network to the phone EVERY time (visible as the same file
            // being GET'd dozens of times). 'full' caches read data on local disk, so a file read once is
            // served instantly from disk on every subsequent read. Streaming still starts immediately
            // (rclone reads sequentially into cache, it does not block on a full download first).
            '--vfs-cache-mode', 'full',
            '--vfs-cache-max-age', '1h', // keep cached file data for the session, not just 15m
            '--vfs-cache-max-size', '8G', // bound disk usage — rclone evicts oldest beyond this
            '--vfs-read-ahead', '128M', // prefetch ahead of sequential reads into the cache
            // Browsing snappiness: keep directory listings and file attributes cached longer so
            // re-visiting a folder (the common case in Explorer) is served from memory instead of a
            // fresh readdir/stat round trip to the phone every time.
            '--dir-cache-time', '30m', // was 5m
            '--attr-timeout', '10m', // was 2m
            '--no-modtime',
            '--no-checksum', // skip checksum computation — pure latency we never use
            '--vfs-fast-fingerprint', // cheap fingerprints, avoids extra stat/hash round trips
            // Read-ahead/buffer: rclone streams a file by requesting ranges from our WebDAV server. A
            // larger buffer means it asks for bigger ranges at once, which our GET handler then fans out
            // into several concurrent chunk reads across the socket pool (see handleRequest) — hiding
            // per-chunk latency far better than the old 1M buffer that starved that pipeline.
            '--buffer-size', '16M', // was 1M
            '--vfs-read-chunk-size', '16M',
            '--vfs-read-chunk-size-limit', '128M'
        ];
        console.log(`[FsMountService] Spawning rclone: ${rclonePath} ${args.join(' ')}`);
        this.rcloneProcess = child_process.spawn(rclonePath, args, {
            windowsHide: true
        });
        let mountResolved = false;
        this.rcloneProcess.stdout?.on('data', (data) => {
            console.log(`[FsMountService:rclone] ${data.toString().trim()}`);
        });
        this.rcloneProcess.stderr?.on('data', (data) => {
            const msg = data.toString().trim();
            console.log(`[FsMountService:rclone stderr] ${msg}`);
            // Rclone mount usually outputs that service has started
            if (msg.includes('The service rclone has been started') || msg.includes('Mounting on')) {
                if (!mountResolved) {
                    mountResolved = true;
                    resolve();
                }
            }
        });
        this.rcloneProcess.on('close', (code) => {
            console.log(`[FsMountService] rclone exited with code ${code}`);
            this.cleanup();
        });
        this.rcloneProcess.on('error', (err) => {
            console.error('[FsMountService] rclone spawn error:', err.message);
            if (!mountResolved) {
                reject(err);
            }
        });
        // Fallback resolver if output is silent but directory exists
        setTimeout(() => {
            if (!mountResolved) {
                mountResolved = true;
                resolve();
            }
        }, 3000);
    }
    translatePath(urlPath) {
        let decoded = decodeURIComponent(urlPath);
        // Strip query parameters
        const qIdx = decoded.indexOf('?');
        if (qIdx >= 0)
            decoded = decoded.substring(0, qIdx);
        let normalized = decoded.replace(/\\/g, '/');
        while (normalized.startsWith('/'))
            normalized = normalized.substring(1);
        while (normalized.endsWith('/'))
            normalized = normalized.substring(0, normalized.length - 1);
        if (normalized === '') {
            return { realPath: '', isVirtualRoot: true, displayPath: '/' };
        }
        const parts = normalized.split('/');
        const matchedRoot = this.roots.find(r => r.name.toLowerCase() === parts[0].toLowerCase());
        if (!matchedRoot) {
            return { realPath: '/invalid_path', isVirtualRoot: false, displayPath: '/' + normalized };
        }
        // Reject any traversal segment in the remainder — previously these were joined directly onto
        // the peer's real root path with no containment check at all, so a malformed or malicious
        // WebDAV request (e.g. from another local app writing through the mounted drive letter) could
        // construct a realPath that escapes the peer's declared root once sent over the wire. Can't
        // use path.resolve() here since matchedRoot.path is a path on the REMOTE peer, not this
        // machine — rejecting '..'/'.' segments outright is the correct check for a remote path.
        const remainingParts = parts.slice(1);
        if (remainingParts.some((p) => p === '..' || p === '.')) {
            return { realPath: '/invalid_path', isVirtualRoot: false, displayPath: '/' + normalized };
        }
        const remaining = remainingParts.join('/');
        const realPath = matchedRoot.path + (remaining ? '/' + remaining : '');
        return { realPath, isVirtualRoot: false, displayPath: '/' + normalized };
    }
    async handleRequest(req, res) {
        const method = req.method?.toUpperCase();
        const url = req.url || '/';
        console.log(`[FsMountService:WebDAV] ${method} ${url}`);
        // Standard CORS and WebDAV headers
        res.setHeader('DAV', '1, 2');
        res.setHeader('Allow', 'GET, POST, OPTIONS, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        const { realPath, isVirtualRoot, displayPath } = this.translatePath(url);
        try {
            if (method === 'PROPFIND') {
                let depth = req.headers['depth'];
                if (depth === undefined)
                    depth = '1';
                let xml = '<?xml version="1.0" encoding="utf-8" ?>\n';
                xml += '<d:multistatus xmlns:d="DAV:">\n';
                if (isVirtualRoot) {
                    // List roots
                    xml += this.renderPropfindEntry('/', true, 0, Date.now());
                    if (depth !== '0') {
                        for (const r of this.roots) {
                            xml += this.renderPropfindEntry('/' + r.name, true, 0, Date.now());
                        }
                    }
                }
                else {
                    // Check actual file/directory
                    const entry = await this.client.stat(realPath);
                    xml += this.renderPropfindEntry(displayPath, entry.isDirectory, entry.size, entry.mtime);
                    if (depth !== '0' && entry.isDirectory) {
                        let files = await this.client.readdir(realPath);
                        // Filter Android system folders if needed
                        if (realPath === '/storage/emulated/0') {
                            files = files.filter(f => f.name.toLowerCase() !== 'android');
                        }
                        for (const f of files) {
                            const fileDisplayPath = displayPath + (displayPath.endsWith('/') ? '' : '/') + f.name;
                            xml += this.renderPropfindEntry(fileDisplayPath, f.isDirectory, f.size, f.mtime);
                        }
                    }
                }
                xml += '</d:multistatus>';
                res.setHeader('Content-Type', 'application/xml; charset="utf-8"');
                res.writeHead(207, 'Multi-Status');
                res.end(xml);
                return;
            }
            if (method === 'GET') {
                if (isVirtualRoot) {
                    res.writeHead(403);
                    res.end('Cannot GET virtual root');
                    return;
                }
                const entry = await this.client.stat(realPath);
                if (entry.isDirectory) {
                    res.writeHead(403);
                    res.end('Cannot GET directory');
                    return;
                }
                // Parse HTTP Range header if present
                const rangeHeader = req.headers['range'];
                let start = 0;
                let end = entry.size - 1;
                let isRange = false;
                if (rangeHeader && rangeHeader.startsWith('bytes=')) {
                    isRange = true;
                    const parts = rangeHeader.substring(6).split('-');
                    start = parseInt(parts[0], 10);
                    if (parts[1]) {
                        end = parseInt(parts[1], 10);
                    }
                    // Validate range bounds
                    if (isNaN(start) || start < 0 || start >= entry.size || end < start) {
                        res.writeHead(416, 'Requested Range Not Satisfiable');
                        res.setHeader('Content-Range', `bytes */${entry.size}`);
                        res.end();
                        return;
                    }
                    if (end >= entry.size) {
                        end = entry.size - 1;
                    }
                }
                const contentLength = end - start + 1;
                res.setHeader('Content-Length', contentLength.toString());
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Accept-Ranges', 'bytes');
                if (isRange) {
                    res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.size}`);
                    res.writeHead(206, 'Partial Content');
                }
                else {
                    res.writeHead(200);
                }
                // Download the requested byte range in 1MB chunks, PIPELINED: keep several reads in
                // flight over the persistent multiplexed socket at once instead of paying a full
                // request→response round trip per chunk sequentially. On weak Wi-Fi/hotspot links where
                // RTT can be 30-80ms, sequential reads stacked one latency per chunk (e.g. a 50MB file =
                // 50 serial round trips before any real transfer) — the single biggest source of the
                // "sluggish, feels like it's stalling" behavior. Chunks are still written to the response
                // strictly in order (Explorer/rclone require it); we just prefetch ahead.
                const chunkSize = 1 * 1024 * 1024;
                // 6 chunks (6MB) in flight — enough to saturate a fast LAN link and fully hide per-chunk
                // RTT on a slow one, without flooding the phone's single-socket executor. Pairs with
                // rclone's 16M buffer above, which now hands us ranges big enough to keep this full.
                const CONCURRENCY = 6;
                const chunkDescs = [];
                for (let o = start; o <= end; o += chunkSize) {
                    chunkDescs.push({ offset: o, length: Math.min(chunkSize, end - o + 1) });
                }
                const inFlight = [];
                let nextToIssue = 0;
                const issueNext = () => {
                    if (nextToIssue < chunkDescs.length) {
                        const c = chunkDescs[nextToIssue++];
                        const p = this.client.read(realPath, c.offset, c.length);
                        // Pre-attach a no-op catch so a later chunk's rejection (e.g. a timeout) doesn't raise
                        // an unhandledRejection for chunks we may never reach if an earlier one already threw.
                        // The in-order await below still sees and propagates the real error.
                        p.catch(() => { });
                        inFlight.push(p);
                    }
                };
                for (let i = 0; i < CONCURRENCY; i++)
                    issueNext();
                for (let i = 0; i < chunkDescs.length; i++) {
                    const chunk = await inFlight[i];
                    issueNext(); // keep the prefetch window full
                    if (!res.write(chunk)) {
                        // Respect backpressure — don't buffer the whole file in memory if the consumer
                        // (rclone) is draining slower than the phone delivers.
                        await new Promise((r) => res.once('drain', r));
                    }
                }
                res.end();
                return;
            }
            if (method === 'PUT') {
                if (isVirtualRoot) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
                // Upload in 1MB chunks, PIPELINED — mirrors the GET handler's read-side concurrency
                // exactly (see that handler's comment for the full reasoning). The old version buffered
                // the entire request body in memory, then issued exactly one write() covering the whole
                // file: a large upload paid zero pipelining benefit and, worse, meant the phone received
                // one giant write request instead of a steady stream of them. Chunks target independent
                // byte offsets — LinkFsServer.java's handleWrite does a real seek()+write() per call using
                // a fresh RandomAccessFile handle each time — so arrival/completion order across the
                // socket pool doesn't matter for correctness, only the byte range each one targets does.
                // handleRequest() is itself async, so thrown errors here propagate straight to this
                // method's own outer catch (see below) — no separate try/catch needed for this block.
                const CHUNK_SIZE = 1 * 1024 * 1024;
                const CONCURRENCY = 6;
                let offset = 0;
                let leftover = Buffer.alloc(0);
                const inFlight = [];
                let firstError = null;
                // FIFO wait (oldest in-flight write, not necessarily first-to-finish) — same tolerance
                // the GET handler's own strictly-ordered `await inFlight[i]` already accepts; simplicity
                // over exactness, and it still keeps at most CONCURRENCY writes outstanding at once.
                const waitForRoom = async () => {
                    while (inFlight.length >= CONCURRENCY) {
                        await inFlight[0];
                        inFlight.shift();
                    }
                };
                const issueWrite = (chunkOffset, data) => {
                    const p = this.client.write(realPath, chunkOffset, data).then((ok) => {
                        if (!ok && !firstError)
                            firstError = new Error('Write rejected by device');
                    }).catch((err) => {
                        if (!firstError)
                            firstError = err;
                    });
                    inFlight.push(p);
                };
                for await (const chunk of req) {
                    leftover = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
                    while (leftover.length >= CHUNK_SIZE) {
                        if (firstError)
                            throw firstError;
                        await waitForRoom();
                        issueWrite(offset, leftover.subarray(0, CHUNK_SIZE));
                        offset += CHUNK_SIZE;
                        leftover = leftover.subarray(CHUNK_SIZE);
                    }
                }
                if (leftover.length > 0) {
                    await waitForRoom();
                    issueWrite(offset, leftover);
                }
                await Promise.all(inFlight);
                if (firstError)
                    throw firstError;
                res.writeHead(201, 'Created');
                res.end();
                return;
            }
            if (method === 'DELETE') {
                if (isVirtualRoot) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
                // 1. Block deletion of system and critical user roots (case-insensitive checks)
                const protectedPaths = [
                    '/storage/emulated/0/android',
                    '/storage/emulated/0/dcim',
                    '/storage/emulated/0/pictures',
                    '/storage/emulated/0/documents',
                    '/storage/emulated/0/download'
                ];
                const lowerPath = realPath.toLowerCase();
                if (protectedPaths.includes(lowerPath)) {
                    console.warn(`[FsMountService] Blocked attempt to delete protected system folder: ${realPath}`);
                    res.writeHead(403, 'Forbidden (Protected System Directory)');
                    res.end('Deletion of core system directories is blocked.');
                    return;
                }
                // Also prevent deleting .LinkTrash itself
                if (lowerPath === '/storage/emulated/0/.linktrash') {
                    res.writeHead(403, 'Forbidden');
                    res.end();
                    return;
                }
                // 2. Safe Delete: Move to .LinkTrash instead of permanent deletion
                const trashRoot = '/storage/emulated/0/.LinkTrash';
                // If the file is ALREADY inside .LinkTrash, delete it permanently
                if (lowerPath.startsWith(trashRoot.toLowerCase() + '/')) {
                    console.log(`[FsMountService] Permanent Delete (already in trash): ${realPath}`);
                    const ok = await this.client.delete(realPath);
                    res.writeHead(ok ? 204 : 500);
                    res.end();
                    return;
                }
                const parsed = path.parse(realPath);
                const trashPath = `${trashRoot}/${parsed.base}_${Date.now()}`;
                // Ensure trash root exists
                try {
                    await this.client.create(trashRoot, true);
                }
                catch (e) { }
                console.log(`[FsMountService] Safe Delete: Moving ${realPath} to ${trashPath}`);
                const ok = await this.client.rename(realPath, trashPath);
                res.writeHead(ok ? 204 : 500);
                res.end();
                return;
            }
            if (method === 'MKCOL') {
                if (isVirtualRoot) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
                const ok = await this.client.create(realPath, true);
                res.writeHead(ok ? 201 : 500);
                res.end();
                return;
            }
            if (method === 'MOVE') {
                const destHeader = req.headers['destination'];
                if (!destHeader) {
                    res.writeHead(400);
                    res.end('Missing Destination header');
                    return;
                }
                // 1. Block moving/renaming of protected roots
                const protectedPaths = [
                    '/storage/emulated/0/android',
                    '/storage/emulated/0/dcim',
                    '/storage/emulated/0/pictures',
                    '/storage/emulated/0/documents',
                    '/storage/emulated/0/download'
                ];
                const lowerPath = realPath.toLowerCase();
                if (protectedPaths.includes(lowerPath)) {
                    console.warn(`[FsMountService] Blocked attempt to move/rename protected system folder: ${realPath}`);
                    res.writeHead(403, 'Forbidden (Protected System Directory)');
                    res.end('Moving core system directories is blocked.');
                    return;
                }
                // Extract destination path from header (absolute URL or relative)
                let destUrl = destHeader;
                if (destUrl.startsWith('http://') || destUrl.startsWith('https://')) {
                    const u = new URL(destUrl);
                    destUrl = u.pathname;
                }
                const destInfo = this.translatePath(destUrl);
                const ok = await this.client.rename(realPath, destInfo.realPath);
                res.writeHead(ok ? 201 : 500);
                res.end();
                return;
            }
            // Default fallback
            res.writeHead(501);
            res.end('Not Implemented');
        }
        catch (err) {
            console.error(`[FsMountService:WebDAV] Error handling ${method} ${url}:`, err.message);
            if (res.headersSent) {
                req.destroy(); // Terminate connection safely if headers already sent
                return;
            }
            if (err.message.includes('not found') || err.message.includes('NoSuchFile')) {
                res.writeHead(404);
            }
            else {
                res.writeHead(500);
            }
            res.end(err.message);
        }
    }
    renderPropfindEntry(href, isDirectory, size, mtime) {
        const escHref = encodeURI(href).replace(/&/g, '&amp;');
        const dateStr = new Date(mtime).toUTCString();
        const displayName = href === '/' ? '/' : href.substring(href.lastIndexOf('/') + 1);
        let totalSpace = 0;
        let freeSpace = 0;
        for (const r of this.roots) {
            totalSpace += r.totalSpace || 0;
            freeSpace += r.freeSpace || 0;
        }
        if (totalSpace === 0) {
            totalSpace = 64 * 1024 * 1024 * 1024;
            freeSpace = 32 * 1024 * 1024 * 1024;
        }
        const usedSpace = totalSpace - freeSpace;
        let entry = `  <d:response>\n`;
        entry += `    <d:href>${escHref}</d:href>\n`;
        entry += `    <d:propstat>\n`;
        entry += `      <d:prop>\n`;
        entry += `        <d:displayname>${displayName}</d:displayname>\n`;
        if (isDirectory) {
            entry += `        <d:resourcetype><d:collection/></d:resourcetype>\n`;
        }
        else {
            entry += `        <d:resourcetype/>\n`;
            entry += `        <d:getcontentlength>${size}</d:getcontentlength>\n`;
        }
        entry += `        <d:getlastmodified>${dateStr}</d:getlastmodified>\n`;
        entry += `        <d:quota-available-bytes>${freeSpace}</d:quota-available-bytes>\n`;
        entry += `        <d:quota-used-bytes>${usedSpace}</d:quota-used-bytes>\n`;
        entry += `      </d:prop>\n`;
        entry += `      <d:status>HTTP/1.1 200 OK</d:status>\n`;
        entry += `    </d:propstat>\n`;
        entry += `  </d:response>\n`;
        return entry;
    }
}
exports.LinkFsMountService = LinkFsMountService;
//# sourceMappingURL=fs-mount-service.js.map