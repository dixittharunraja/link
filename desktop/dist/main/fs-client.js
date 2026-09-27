"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinkFsClient = void 0;
const ws_1 = __importDefault(require("ws"));
// Any single request that gets no response within this window is force-rejected. Without this,
// a dropped packet, a doze-throttled radio, or a hotspot NAT silently dropping the connection
// left the underlying Promise pending FOREVER — Explorer/rclone then block their own I/O thread
// waiting on the mounted drive, which is what made the whole app appear frozen (and get
// force-closed) on weak Wi-Fi/hotspot links. 10s: long enough for a legitimately slow read on a
// congested link, short enough that a genuinely dead request recovers before it feels stuck.
const REQUEST_TIMEOUT_MS = 10000;
// Ping/pong cadence — the phone-facing WSS socket previously had NO liveness detection at all
// (unlike the main device connection's heartbeats), so a silently-dead connection just sat there
// looking "connected" indefinitely. We ping every PING_INTERVAL_MS and terminate if the previous
// ping went unanswered, so a dead link fails fast (rejecting all in-flight requests via 'close').
const PING_INTERVAL_MS = 10000;
// Number of parallel TLS/WebSocket connections in the pool. A single TCP stream on a high-latency
// link is capped by its bandwidth-delay product no matter how much we pipeline requests inside it;
// spreading concurrent chunk reads across several independent sockets (the classic download-manager
// trick) multiplies effective throughput on exactly the weak Wi-Fi/hotspot links that felt slow.
const POOL_SIZE = 4;
/**
 * One TLS WebSocket connection to the peer's FS server, with its own request/response
 * demultiplexing (by id), per-request timeout, and ping/pong liveness. LinkFsClient owns a pool
 * of these and load-balances requests across them.
 */
class PooledSocket {
    url;
    opts;
    label;
    ws = null;
    pending = new Map();
    heartbeatInterval = null;
    isAlive = true;
    constructor(url, opts, label) {
        this.url = url;
        this.opts = opts;
        this.label = label;
    }
    get isLive() {
        return this.ws !== null && this.ws.readyState === ws_1.default.OPEN;
    }
    /** Requests currently awaiting a response on this socket — used for least-loaded balancing. */
    get inFlight() {
        return this.pending.size;
    }
    registerPending(id, resolve, reject) {
        const timer = setTimeout(() => {
            if (this.pending.has(id)) {
                this.pending.delete(id);
                reject(new Error(`FS request timed out after ${REQUEST_TIMEOUT_MS}ms`));
            }
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
    }
    settlePending(id, ok, value) {
        const p = this.pending.get(id);
        if (!p)
            return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (ok)
            p.resolve(value);
        else
            p.reject(value instanceof Error ? value : new Error(String(value)));
    }
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new ws_1.default(this.url, this.opts);
            this.ws.on('open', () => {
                const socket = this.ws._socket;
                if (socket && typeof socket.setNoDelay === 'function')
                    socket.setNoDelay(true);
                this.isAlive = true;
                this.heartbeatInterval = setInterval(() => {
                    if (!this.isAlive) {
                        console.warn(`[LinkFsClient:${this.label}] Ping unanswered — terminating dead connection.`);
                        try {
                            this.ws?.terminate();
                        }
                        catch { }
                        return;
                    }
                    this.isAlive = false;
                    try {
                        this.ws?.ping();
                    }
                    catch { }
                }, PING_INTERVAL_MS);
                resolve();
            });
            this.ws.on('pong', () => { this.isAlive = true; });
            this.ws.on('error', (err) => { reject(err); });
            this.ws.on('close', () => {
                this.stopHeartbeat();
                this.cleanup(new Error('Connection closed'));
            });
            this.ws.on('message', (data) => this.handleMessage(data));
        });
    }
    close() {
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    cleanup(err) {
        for (const [, p] of this.pending.entries()) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }
    /** Sends a JSON request (id already embedded in obj) and resolves with the peer's response. */
    sendJson(id, obj) {
        return new Promise((resolve, reject) => {
            if (!this.isLive)
                return reject(new Error('socket not connected'));
            this.registerPending(id, resolve, reject);
            this.ws.send(JSON.stringify(obj), (err) => {
                if (err)
                    this.settlePending(id, false, err);
            });
        });
    }
    /** Sends a pre-built binary frame (write path) and resolves with the peer's response. */
    sendFrame(id, frame) {
        return new Promise((resolve, reject) => {
            if (!this.isLive)
                return reject(new Error('socket not connected'));
            this.registerPending(id, resolve, reject);
            this.ws.send(frame, (err) => {
                if (err)
                    this.settlePending(id, false, err);
            });
        });
    }
    handleMessage(data) {
        try {
            if (typeof data === 'string') {
                const resp = JSON.parse(data);
                this.settlePending(resp.id, !!resp.success, resp.success ? extractValue(resp) : new Error(resp.error || 'Unknown error'));
            }
            else if (Buffer.isBuffer(data)) {
                // ws may deliver a text frame as a Buffer; a leading '{' (0x7b) means it's really JSON.
                if (data.length > 0 && data[0] === 0x7b) {
                    const resp = JSON.parse(data.toString('utf8'));
                    this.settlePending(resp.id, !!resp.success, resp.success ? extractValue(resp) : new Error(resp.error || 'Unknown error'));
                    return;
                }
                // Combined binary frame: [4-byte header length][JSON header][file data payload]
                if (data.length < 4) {
                    console.error('[LinkFsClient] Malformed binary frame: too small');
                    return;
                }
                const headerLen = data.readInt32BE(0);
                if (headerLen < 0 || headerLen > data.length - 4) {
                    console.error('[LinkFsClient] Malformed binary frame: invalid header length');
                    return;
                }
                const headerStr = data.toString('utf8', 4, 4 + headerLen);
                const resp = JSON.parse(headerStr);
                const fileData = data.subarray(4 + headerLen);
                this.settlePending(resp.id, !!resp.success, resp.success ? fileData : new Error(resp.error || 'Unknown error'));
            }
        }
        catch (e) {
            console.error('[LinkFsClient] Error handling message:', e.message);
        }
    }
}
class LinkFsClient {
    host;
    port;
    clientCert;
    clientKey;
    sockets = [];
    requestCounter = 0;
    constructor(host, port = 1741, clientCert, clientKey) {
        this.host = host;
        this.port = port;
        this.clientCert = clientCert;
        this.clientKey = clientKey;
    }
    async connect() {
        const url = `wss://${this.host}:${this.port}`;
        console.log(`[LinkFsClient] Connecting pool of ${POOL_SIZE} to ${url}...`);
        const opts = {
            rejectUnauthorized: false, // Self-signed peer certificates
            handshakeTimeout: 15000,
            // The Android-side FS server requires (setNeedClientAuth) a client certificate during the
            // TLS handshake so it can match the connecting peer against its trust store — without
            // presenting our own paired identity here it would reject the connection outright.
            cert: this.clientCert,
            key: this.clientKey,
        };
        const candidates = Array.from({ length: POOL_SIZE }, (_, i) => new PooledSocket(url, opts, `s${i}`));
        const results = await Promise.allSettled(candidates.map((s) => s.connect()));
        this.sockets = candidates.filter((_, i) => results[i].status === 'fulfilled');
        if (this.sockets.length === 0) {
            // Surface the first real failure reason rather than a generic message.
            const firstErr = results.find((r) => r.status === 'rejected');
            throw firstErr ? firstErr.reason : new Error('FsClient failed to connect');
        }
        console.log(`[LinkFsClient] Pool connected: ${this.sockets.length}/${POOL_SIZE} sockets live.`);
    }
    disconnect() {
        for (const s of this.sockets)
            s.close();
        this.sockets = [];
    }
    /** Picks the live socket with the fewest in-flight requests, so concurrent chunk reads spread
     *  evenly across the pool instead of piling onto one connection. */
    pick() {
        const live = this.sockets.filter((s) => s.isLive);
        if (live.length === 0)
            throw new Error('FsClient is not connected');
        let best = live[0];
        for (const s of live)
            if (s.inFlight < best.inFlight)
                best = s;
        return best;
    }
    nextId() {
        return `req-${Date.now()}-${this.requestCounter++}`;
    }
    sendRequest(action, payload) {
        const id = this.nextId();
        return this.pick().sendJson(id, { id, action, ...payload });
    }
    async listRoots() {
        return this.sendRequest('listRoots', {});
    }
    async readdir(path) {
        return this.sendRequest('readdir', { path });
    }
    async stat(path) {
        return this.sendRequest('stat', { path });
    }
    async read(path, offset, length) {
        return this.sendRequest('read', { path, offset, length });
    }
    async create(path, isDirectory) {
        return this.sendRequest('create', { path, isDirectory });
    }
    async delete(path) {
        return this.sendRequest('delete', { path });
    }
    async rename(path, newPath) {
        return this.sendRequest('rename', { path, newPath });
    }
    async write(path, offset, buffer) {
        const id = this.nextId();
        const header = JSON.stringify({ id, action: 'write', path, offset });
        const headerBytes = Buffer.from(header, 'utf8');
        const frame = Buffer.alloc(4 + headerBytes.length + buffer.length);
        frame.writeInt32BE(headerBytes.length, 0);
        headerBytes.copy(frame, 4);
        buffer.copy(frame, 4 + headerBytes.length);
        return this.pick().sendFrame(id, frame);
    }
    /**
     * Directly test roundtrip read/write speed and list times.
     */
    async runBenchmark(testFilePath) {
        const report = [];
        report.push(`--- WebSocket FileSystem Benchmark Report ---`);
        try {
            // 1. Roots List
            const t0 = Date.now();
            const roots = await this.listRoots();
            report.push(`List Roots: ${Date.now() - t0}ms (Found ${roots.length} roots)`);
            if (roots.length === 0) {
                return `Benchmark failed: no roots found to run tests.`;
            }
            const testDir = roots[0].path;
            report.push(`Using directory: ${testDir} for read tests.`);
            // 2. Readdir List
            const t1 = Date.now();
            const files = await this.readdir(testDir);
            report.push(`Readdir time: ${Date.now() - t1}ms (Found ${files.length} items)`);
            // 3. Sequential Write Benchmark (1MB chunks)
            const benchmarkFile = `${testDir}/link_benchmark_test.bin`;
            const fileSize = 10 * 1024 * 1024; // 10MB test file
            const seqChunkSize = 1 * 1024 * 1024; // 1MB block size
            const writeDataSeq = Buffer.alloc(seqChunkSize, 'B');
            report.push(`Writing 10MB file in 1MB sequential chunks...`);
            const tSeqWriteStart = Date.now();
            for (let offset = 0; offset < fileSize; offset += seqChunkSize) {
                await this.write(benchmarkFile, offset, writeDataSeq);
            }
            const tSeqWriteEnd = Date.now();
            const seqWriteDur = (tSeqWriteEnd - tSeqWriteStart) / 1000;
            const seqWriteSpeed = (10 / seqWriteDur).toFixed(2);
            report.push(`1MB Sequential Write completed: ${seqWriteDur.toFixed(2)}s (${seqWriteSpeed} MB/s)`);
            // 4. Sequential Read Benchmark (1MB chunks)
            report.push(`Reading 10MB file in 1MB sequential chunks...`);
            const tSeqReadStart = Date.now();
            for (let offset = 0; offset < fileSize; offset += seqChunkSize) {
                await this.read(benchmarkFile, offset, seqChunkSize);
            }
            const tSeqReadEnd = Date.now();
            const seqReadDur = (tSeqReadEnd - tSeqReadStart) / 1000;
            const seqReadSpeed = (10 / seqReadDur).toFixed(2);
            report.push(`1MB Sequential Read completed: ${seqReadDur.toFixed(2)}s (${seqReadSpeed} MB/s)`);
            // 5. Pipelined/Parallel Write Benchmark (1MB chunks, Concurrency = 4)
            const pipeChunkSize = 1 * 1024 * 1024;
            const writeDataPipe = Buffer.alloc(pipeChunkSize, 'P');
            const pipelinedFile = `${testDir}/link_benchmark_pipe.bin`;
            report.push(`Writing 10MB file in 1MB pipelined chunks (concurrency=4)...`);
            const tPipeWriteStart = Date.now();
            const writePromises = [];
            for (let offset = 0; offset < fileSize; offset += pipeChunkSize) {
                writePromises.push(this.write(pipelinedFile, offset, writeDataPipe));
            }
            await Promise.all(writePromises);
            const tPipeWriteEnd = Date.now();
            const pipeWriteDur = (tPipeWriteEnd - tPipeWriteStart) / 1000;
            const pipeWriteSpeed = (10 / pipeWriteDur).toFixed(2);
            report.push(`1MB Pipelined Write completed: ${pipeWriteDur.toFixed(2)}s (${pipeWriteSpeed} MB/s)`);
            // 6. Pipelined/Parallel Read Benchmark (1MB chunks, Concurrency = 4)
            report.push(`Reading 10MB file in 1MB pipelined chunks (concurrency=4)...`);
            const tPipeReadStart = Date.now();
            const readPromises = [];
            for (let offset = 0; offset < fileSize; offset += pipeChunkSize) {
                readPromises.push(this.read(pipelinedFile, offset, pipeChunkSize));
            }
            await Promise.all(readPromises);
            const tPipeReadEnd = Date.now();
            const pipeReadDur = (tPipeReadEnd - tPipeReadStart) / 1000;
            const pipeReadSpeed = (10 / pipeReadDur).toFixed(2);
            report.push(`1MB Pipelined Read completed: ${pipeReadDur.toFixed(2)}s (${pipeReadSpeed} MB/s)`);
            // 7. Cleanup
            await this.delete(benchmarkFile);
            await this.delete(pipelinedFile);
            report.push(`Cleaned up benchmark files.`);
        }
        catch (e) {
            report.push(`Benchmark error: ${e.message}`);
        }
        return report.join('\n');
    }
}
exports.LinkFsClient = LinkFsClient;
function extractValue(resp) {
    if (resp.roots)
        return resp.roots;
    if (resp.files)
        return resp.files;
    // Stat or simple operations
    return resp;
}
//# sourceMappingURL=fs-client.js.map