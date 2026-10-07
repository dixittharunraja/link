import * as http from 'http';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { LinkAndroidFsClient, FsRoot } from './android-client';
import { FsApiServer } from './api-server';

// Content-Type lookup for served files (used by startStreamServer / media streaming).
const MIME_TYPES: Record<string, string> = {
  // Video
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  mov: 'video/quicktime', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', ts: 'video/mp2t',
  m2ts: 'video/mp2t', mts: 'video/mp2t', ogv: 'video/ogg', vob: 'video/mpeg',
  asf: 'video/x-ms-asf', f4v: 'video/x-f4v', divx: 'video/x-msvideo',
  // Images
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  tiff: 'image/tiff', tif: 'image/tiff',
  // Camera RAW
  dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', nef: 'image/x-nikon-nef',
  arw: 'image/x-sony-arw', orf: 'image/x-olympus-orf', raf: 'image/x-fuji-raf',
  // Audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
  wma: 'audio/x-ms-wma', aiff: 'audio/aiff', aif: 'audio/aiff',
  mid: 'audio/midi', midi: 'audio/midi', ape: 'audio/x-ape', wv: 'audio/x-wavpack',
  amr: 'audio/amr', '3ga': 'audio/3gpp',
  // Documents
  pdf: 'application/pdf', epub: 'application/epub+zip', rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
};

export function mimeForPath(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot >= 0 && dot < p.length - 1) {
    const ext = p.substring(dot + 1).toLowerCase();
    if (MIME_TYPES[ext]) return MIME_TYPES[ext];
  }
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Inlined Windows Drive Registry & Mount Helpers
// ---------------------------------------------------------------------------
function setDriveRegistry(driveLetter: string, label: string): void {
  const letter = driveLetter.replace(':', '');
  const regPath = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons\\${letter}`;

  child_process.exec(`reg add "${regPath}\\DefaultLabel" /ve /d "${label}" /f`, (err) => {
    if (err) console.error('[FsMountWin32] Failed to set registry label:', err);
    else console.log(`[FsMountWin32] Drive label set to: ${label}`);
  });
}

function clearDriveRegistry(driveLetter: string): void {
  const letter = driveLetter.replace(':', '');
  const regPath = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons\\${letter}`;
  child_process.exec(`reg delete "${regPath}" /f`, () => {});
}

function unmountDriveLetter(driveLetter: string): void {
  child_process.exec(`net use ${driveLetter} /delete /y`, () => {});
}

export function getLocalPhysicalDrives(activeLinkDrives: Set<string>): FsRoot[] {
  const roots: FsRoot[] = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  for (const letter of letters) {
    const drive = `${letter}:\\`;
    const driveLetter = `${letter}:`;

    if (activeLinkDrives.has(driveLetter.toUpperCase())) {
      continue;
    }

    try {
      if (fs.existsSync(drive)) {
        roots.push({
          name: `${letter} Drive`,
          path: drive.replace(/\\/g, '/'),
        });
      }
    } catch {}
  }

  return roots;
}

// ---------------------------------------------------------------------------
// LinkFsMountService
// ---------------------------------------------------------------------------
export class LinkFsMountService {
  private apiServer: FsApiServer | null = null;
  private driverProcess: child_process.ChildProcess | null = null;
  private streamServer: http.Server | null = null;
  private streamPort = 0;
  private isMounted = false;

  private rootsCache: FsRoot[] = [];

  constructor(
    private client: LinkAndroidFsClient,
    private driveLetter: string,
    private deviceName: string,
    private deviceType = 'phone'
  ) {}

  public getDriveLetter(): string {
    return this.driveLetter;
  }

  public getPort(): number {
    return this.streamPort;
  }

  public getRoots(): FsRoot[] {
    return this.rootsCache;
  }

  public getStreamPort(): number {
    return this.streamPort;
  }

  public getIsMounted(): boolean {
    return this.isMounted;
  }

  public async mount(): Promise<void> {
    try {
      console.log(`[LinkFsMountService] Mounting ${this.deviceName} on ${this.driveLetter}...`);
      await this.startStreamServer();

      this.rootsCache = await this.client.listRoots();
      this.apiServer = new FsApiServer(this.client, this.rootsCache);
      await this.apiServer.start();

      // Launch C# WinFSP native driver helper if available
      const candidatePaths = [
        path.join(process.cwd(), 'vendor', 'link-fs-driver', 'link-fs-driver.exe'),
        path.join(__dirname, '..', '..', '..', 'vendor', 'link-fs-driver', 'link-fs-driver.exe'),
        path.join(__dirname, '..', '..', 'vendor', 'link-fs-driver', 'link-fs-driver.exe'),
        path.join(process.resourcesPath || '', 'vendor', 'link-fs-driver', 'link-fs-driver.exe'),
        path.join(process.resourcesPath || '', 'link-fs-driver.exe'),
        path.join(__dirname, '..', 'link-fs-driver', 'bin', 'Release', 'net8.0', 'win-x64', 'link-fs-driver.exe'),
        path.join(__dirname, '..', 'link-fs-driver', 'bin', 'Debug', 'net8.0', 'win-x64', 'link-fs-driver.exe'),
        path.join(process.cwd(), 'electron', 'main', 'link-fs-driver', 'bin', 'Release', 'net8.0', 'win-x64', 'link-fs-driver.exe'),
        path.join(process.cwd(), 'electron', 'main', 'link-fs-driver', 'bin', 'Debug', 'net8.0', 'win-x64', 'link-fs-driver.exe'),
      ];
      const exeToUse = candidatePaths.find((p) => p && fs.existsSync(p)) || null;

      if (!exeToUse) {
        throw new Error('link-fs-driver.exe not found at any candidate path. WinFSP native mounting is unavailable.');
      }

      const dLetter = this.driveLetter.endsWith(':') ? this.driveLetter : `${this.driveLetter}:`;
      console.log(`[LinkFsMountService] Spawning native WinFSP driver: ${exeToUse} on ${dLetter} (port=${this.apiServer.port})`);

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const proc = child_process.spawn(exeToUse, [
          '--drive-letter', dLetter,
          '--volume-label', `${this.deviceName} (Link)`,
          '--api-port', String(this.apiServer!.port),
          '--api-token', this.apiServer!.token,
        ], { stdio: 'pipe' });

        this.driverProcess = proc;

        const checkOutput = (data: Buffer) => {
          const text = data.toString();
          if (text.includes('LINK_FS_DRIVER_READY')) {
            if (!settled) {
              settled = true;
              resolve();
            }
          }
        };

        proc.stdout?.on('data', (d) => {
          console.log(`[WinFSP Driver] ${d.toString().trim()}`);
          checkOutput(d);
        });

        proc.stderr?.on('data', (d) => {
          console.error(`[WinFSP Driver ERR] ${d.toString().trim()}`);
          checkOutput(d);
        });

        proc.on('error', (err) => {
          console.error(`[WinFSP Driver] Process error:`, err);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });

        proc.on('exit', (code) => {
          console.log(`[WinFSP Driver] Exited with code ${code}`);
          this.isMounted = false;
          if (!settled) {
            settled = true;
            reject(new Error(`WinFSP driver exited with code ${code}`));
          }
        });

        // 10s fallback timeout
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, 10000);
      });

      setDriveRegistry(this.driveLetter, `${this.deviceName} (Link)`);
      this.isMounted = true;
    } catch (err: any) {
      console.error(`[LinkFsMountService] Failed to mount ${this.deviceName}:`, err);
      this.unmount();
      throw err;
    }
  }

  public unmount(): void {
    if (this.driverProcess) {
      try { this.driverProcess.kill(); } catch {}
      this.driverProcess = null;
    }

    if (this.apiServer) {
      try { this.apiServer.stop(); } catch {}
      this.apiServer = null;
    }

    if (this.streamServer) {
      try { this.streamServer.close(); } catch {}
      this.streamServer = null;
    }

    unmountDriveLetter(this.driveLetter);
    clearDriveRegistry(this.driveLetter);
    this.isMounted = false;
  }

  public async startStreamServer(token?: string): Promise<void> {
    if (this.rootsCache.length === 0) {
      try {
        this.rootsCache = await this.client.listRoots();
      } catch {}
    }
    return new Promise((resolve) => {
      this.streamServer = http.createServer(async (req, res) => {
        if (token && req.headers['x-link-token'] !== token && !req.url?.includes(`token=${token}`)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        try {
          const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${this.streamPort}`);
          let filePath = parsed.searchParams.get('path');
          if (!filePath) {
            // Path was passed in the URL pathname (e.g. /Internal Storage/DCIM/Screenshots/pic.png)
            const decodedPath = decodeURIComponent(parsed.pathname);
            // Match against rootsCache
            for (const root of this.rootsCache) {
              const prefix = `/${root.name}`;
              if (decodedPath === prefix || decodedPath.startsWith(prefix + '/')) {
                const subPath = decodedPath.substring(prefix.length);
                const rootBase = root.path.endsWith('/') ? root.path.slice(0, -1) : root.path;
                filePath = `${rootBase}${subPath.startsWith('/') ? subPath : '/' + subPath}`;
                break;
              }
            }
          }

          if (!filePath) {
            res.writeHead(400);
            res.end('Missing path');
            return;
          }

          const stat = await this.client.stat(filePath);
          const rangeHeader = req.headers.range;

          if (rangeHeader) {
            const parts = rangeHeader.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = end - start + 1;

            const buffer = await this.client.read(filePath, start, chunksize);
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunksize,
              'Content-Type': mimeForPath(filePath),
            });
            res.end(buffer);
          } else {
            const buffer = await this.client.read(filePath, 0, stat.size);
            res.writeHead(200, {
              'Content-Length': stat.size,
              'Content-Type': mimeForPath(filePath),
            });
            res.end(buffer);
          }
        } catch (e: any) {
          res.writeHead(500);
          res.end(e.message);
        }
      });

      this.streamServer.listen(0, '127.0.0.1', () => {
        this.streamPort = (this.streamServer!.address() as { port: number }).port;
        resolve();
      });
    });
  }
}
