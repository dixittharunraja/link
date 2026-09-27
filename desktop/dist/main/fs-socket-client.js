"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinkSocketFsClient = void 0;
const packet_1 = require("../core/packet");
class LinkSocketFsClient {
    deviceManager;
    deviceId;
    pendingRequests = new Map();
    requestCounter = 0;
    constructor(deviceManager, deviceId) {
        this.deviceManager = deviceManager;
        this.deviceId = deviceId;
    }
    handleResponsePacket(packet) {
        const body = packet.body || {};
        const requestId = body.requestId;
        if (!requestId)
            return;
        const promise = this.pendingRequests.get(requestId);
        if (promise) {
            this.pendingRequests.delete(requestId);
            if (body.success) {
                if (body.data && body.data.type === 'Buffer') {
                    promise.resolve(Buffer.from(body.data.data));
                }
                else {
                    promise.resolve(body.result);
                }
            }
            else {
                promise.reject(new Error(body.error || 'Request failed'));
            }
        }
    }
    sendRequest(action, payload) {
        return new Promise((resolve, reject) => {
            const requestId = `fs-req-${Date.now()}-${this.requestCounter++}`;
            this.pendingRequests.set(requestId, { resolve, reject });
            const packet = (0, packet_1.createPacket)('link.fs.request', {
                requestId,
                action,
                ...payload,
            });
            this.deviceManager.sendTo(this.deviceId, packet);
            // 30-second timeout safety
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('FileSystem request timed out'));
                }
            }, 30000);
        });
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
        // Convert Buffer to JSON-serializable structure
        return this.sendRequest('write', {
            path,
            offset,
            buffer: {
                type: 'Buffer',
                data: Array.from(buffer),
            },
        });
    }
}
exports.LinkSocketFsClient = LinkSocketFsClient;
//# sourceMappingURL=fs-socket-client.js.map