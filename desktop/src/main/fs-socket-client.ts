import { DeviceManager } from '../core/device-manager';
import { createPacket } from '../core/packet';
import { FsEntry, FsRoot } from './fs-client';

export class LinkSocketFsClient {
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
    }
  >();
  private requestCounter = 0;

  constructor(
    private deviceManager: DeviceManager,
    private deviceId: string
  ) {}

  public handleResponsePacket(packet: any) {
    const body = packet.body || {};
    const requestId = body.requestId;
    if (!requestId) return;

    const promise = this.pendingRequests.get(requestId);
    if (promise) {
      this.pendingRequests.delete(requestId);
      if (body.success) {
        if (body.data && body.data.type === 'Buffer') {
          promise.resolve(Buffer.from(body.data.data));
        } else {
          promise.resolve(body.result);
        }
      } else {
        promise.reject(new Error(body.error || 'Request failed'));
      }
    }
  }

  private sendRequest<T>(action: string, payload: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const requestId = `fs-req-${Date.now()}-${this.requestCounter++}`;
      this.pendingRequests.set(requestId, { resolve, reject });

      const packet = createPacket('link.fs.request', {
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

  public async listRoots(): Promise<FsRoot[]> {
    return this.sendRequest<FsRoot[]>('listRoots', {});
  }

  public async readdir(path: string): Promise<FsEntry[]> {
    return this.sendRequest<FsEntry[]>('readdir', { path });
  }

  public async stat(path: string): Promise<FsEntry> {
    return this.sendRequest<FsEntry>('stat', { path });
  }

  public async read(path: string, offset: number, length: number): Promise<Buffer> {
    return this.sendRequest<Buffer>('read', { path, offset, length });
  }

  public async create(path: string, isDirectory: boolean): Promise<boolean> {
    return this.sendRequest<boolean>('create', { path, isDirectory });
  }

  public async delete(path: string): Promise<boolean> {
    return this.sendRequest<boolean>('delete', { path });
  }

  public async rename(path: string, newPath: string): Promise<boolean> {
    return this.sendRequest<boolean>('rename', { path, newPath });
  }

  public async write(path: string, offset: number, buffer: Buffer): Promise<boolean> {
    // Convert Buffer to JSON-serializable structure
    return this.sendRequest<boolean>('write', {
      path,
      offset,
      buffer: {
        type: 'Buffer',
        data: Array.from(buffer),
      },
    });
  }
}
