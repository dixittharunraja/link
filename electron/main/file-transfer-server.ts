// Portal Mode — receiver side. A dedicated WebSocket+TLS server on PORTAL_TRANSFER_PORT for
// one-time file transfer, completely separate from DeviceManager/TrustStore/the permission system.
//
// Supports symmetrical on-demand pull:
//   - Each party announces staged files via {"type":"downloads-available","files":[{id,name,size}]}.
//   - Downloading party requests a specific file via {"type":"request-download","fileId":...}.
//   - Source streams the file with file-info + binary WS chunks.

import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { computeVerificationCode } from '../core/pairing';
import { GUEST_SESSION_CONFIRM_TIMEOUT_MS } from './constants';
import { PendingGuest } from './guest-session-types';
import { streamFileOverWebSocket } from './file-transfer-client';

const GUEST_CONFIRM_TIMEOUT_MS = GUEST_SESSION_CONFIRM_TIMEOUT_MS;
const MAX_FILE_BYTES = 100 * 1024 * 1024 * 1024 * 1024; // 100TB

function getWebClientHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Web Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #030303;
      --card-bg: rgba(13, 13, 17, 0.75);
      --text: #f8fafc;
      --text-muted: #64748b;
      --accent: #009bd5;
      --accent-hover: #3b82f6;
      --accent-gradient: linear-gradient(135deg, #009bd5 0%, #3b82f6 100%);
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(0, 155, 213, 0.25);
      --input-bg: rgba(255, 255, 255, 0.03);
      --font-display: 'Outfit', sans-serif;
      --font-sans: 'Inter', sans-serif;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 0% 0%, rgba(0, 155, 213, 0.03) 0%, transparent 40%),
        radial-gradient(circle at 100% 100%, rgba(59, 130, 246, 0.04) 0%, transparent 40%);
      color: var(--text);
      font-family: var(--font-sans);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      width: 100%;
      max-width: 440px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(20px);
      display: flex;
      flex-direction: column;
      gap: 24px;
      transition: border-color 0.3s ease, box-shadow 0.3s ease;
    }
    .container:hover {
      border-color: var(--border-hover);
      box-shadow: 0 25px 60px rgba(0, 155, 213, 0.1), inset 0 1px 1px rgba(255, 255, 255, 0.05);
    }
    .header {
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .header svg {
      color: var(--accent);
      margin-bottom: 8px;
      filter: drop-shadow(0 0 8px rgba(0, 155, 213, 0.4));
    }
    h1 {
      font-family: var(--font-display);
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .section {
      display: none;
      flex-direction: column;
      gap: 16px;
    }
    .section.active {
      display: flex;
    }
    input[type="text"] {
      width: 100%;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--input-bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s, background 0.2s;
    }
    input[type="text"]:focus {
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.06);
    }
    button {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: none;
      background: var(--accent-gradient);
      color: #fff;
      font-family: var(--font-sans);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 155, 213, 0.3);
      transition: opacity 0.2s, transform 0.1s;
    }
    button:hover {
      opacity: 0.95;
    }
    button:active {
      transform: scale(0.98);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .pin-box {
      background: rgba(0, 155, 213, 0.05);
      border: 1px dashed var(--accent);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .pin-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      font-weight: 600;
    }
    .pin-code {
      font-family: var(--font-display);
      font-size: 36px;
      font-weight: 800;
      letter-spacing: 6px;
      color: #fff;
      text-shadow: 0 0 16px rgba(0, 155, 213, 0.6);
    }
    .dropzone {
      border: 2px dashed var(--border);
      border-radius: 12px;
      padding: 32px 16px;
      text-align: center;
      background: rgba(255, 255, 255, 0.01);
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .dropzone:hover, .dropzone.dragover {
      border-color: var(--accent);
      background: rgba(0, 155, 213, 0.03);
    }
    .dropzone svg {
      color: var(--text-muted);
    }
    .dropzone:hover svg {
      color: var(--accent);
    }
    .file-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 180px;
      overflow-y: auto;
    }
    .file-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
    }
    .file-name {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-info {
      display: flex;
      justify-content: space-between;
      color: var(--text-muted);
      font-size: 11px;
    }
    .progress-bar {
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent-gradient);
      width: 0%;
      transition: width 0.1s linear;
    }
    .status-msg {
      font-size: 12px;
      text-align: center;
      color: var(--text-muted);
    }
    .status-success {
      color: #10b981;
      font-weight: 500;
    }
    .downloads-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }
    .downloads-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .download-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 140px;
      overflow-y: auto;
    }
    .download-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
    }
    .download-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-right: 8px;
    }
    .download-size {
      color: var(--text-muted);
      font-size: 11px;
    }
    .download-btn {
      width: auto;
      padding: 4px 10px;
      font-size: 11px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      box-shadow: none;
    }
    .download-btn:hover {
      background: var(--accent);
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path>
        <path d="M12 12v9"></path>
        <path d="m16 16-4-4-4 4"></path>
      </svg>
      <h1>Link Web Portal</h1>
      <div class="subtitle" id="subtitle">Connect to peer to send files directly over the local network.</div>
    </div>

    <!-- Step 1: Connect -->
    <div class="section active" id="sec-connect">
      <input type="text" id="input-device" placeholder="Your device name (e.g. Browser)">
      <button id="btn-connect">Connect</button>
    </div>

    <!-- Step 2: PIN Confirm -->
    <div class="section" id="sec-pin">
      <div class="pin-box">
        <div class="pin-title">Confirm PIN on Target Device</div>
        <div class="pin-code" id="pin-display">--- ---</div>
      </div>
      <div class="status-msg">Waiting for host to accept connection...</div>
    </div>

    <!-- Step 3: Upload -->
    <div class="section" id="sec-upload">
      <div class="dropzone" id="dropzone">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <div>
          <div style="font-weight: 500; margin-bottom: 2px;">Choose files or drag & drop</div>
          <div style="font-size: 11px; color: var(--text-muted);">Transfer directly over your Wi-Fi</div>
        </div>
      </div>
      <input type="file" id="file-input" multiple style="display: none;">

      <div class="file-list" id="file-list"></div>
      <div class="status-msg" id="upload-status"></div>

      <!-- Downloads Available List -->
      <div class="downloads-section" id="downloads-container" style="display: none;">
        <div class="downloads-title">Files available from host</div>
        <div class="download-list" id="download-list"></div>
      </div>
    </div>
  </div>

  <script>
    const secConnect = document.getElementById('sec-connect');
    const secPin = document.getElementById('sec-pin');
    const secUpload = document.getElementById('sec-upload');
    const inputDevice = document.getElementById('input-device');
    const btnConnect = document.getElementById('btn-connect');
    const pinDisplay = document.getElementById('pin-display');
    const subtitle = document.getElementById('subtitle');
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const fileListContainer = document.getElementById('file-list');
    const uploadStatus = document.getElementById('upload-status');
    const downloadsContainer = document.getElementById('downloads-container');
    const downloadList = document.getElementById('download-list');

    let defaultName = 'Web Browser';
    if (/android/i.test(navigator.userAgent)) defaultName = 'Android Browser';
    else if (/ipad|iphone|ipod/i.test(navigator.userAgent)) defaultName = 'iOS Browser';
    else if (/mac/i.test(navigator.userAgent)) defaultName = 'Mac Browser';
    else if (/windows/i.test(navigator.userAgent)) defaultName = 'Windows Browser';
    inputDevice.placeholder = 'Your device name (e.g. ' + defaultName + ')';

    let ws = null;
    let selectedFiles = [];

    btnConnect.addEventListener('click', () => {
      const devName = inputDevice.value.trim() || defaultName;
      btnConnect.disabled = true;
      btnConnect.textContent = 'Connecting...';

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = wsProtocol + '//' + location.host + '/ws';
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'join-guest',
          deviceName: devName
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pin') {
          secConnect.classList.remove('active');
          secPin.classList.add('active');
          const pinStr = msg.code.toString();
          pinDisplay.textContent = pinStr.substring(0, 3) + ' ' + pinStr.substring(3);
          subtitle.textContent = 'Authenticating connection...';
        } else if (msg.type === 'admitted') {
          secPin.classList.remove('active');
          secUpload.classList.add('active');
          subtitle.textContent = 'Two-way files sharing active.';
          broadcastAvailableFiles();
        } else if (msg.type === 'received') {
          uploadStatus.innerHTML = '<span class="status-success">✓ File transferred successfully!</span>';
        } else if (msg.type === 'downloads-available') {
          updateDownloadsList(msg.files);
        } else if (msg.type === 'request-download' && typeof msg.fileId === 'string') {
          const matchIndex = selectedFiles.findIndex((f, i) => ('web-' + i + '-' + f.name) === msg.fileId || f.name === msg.fileId);
          if (matchIndex !== -1) {
            streamFileToHost(selectedFiles[matchIndex], matchIndex);
          }
        }
      };

      ws.onerror = (err) => {
        alert('Connection error. Please try again.');
        resetUI();
      };

      ws.onclose = () => {
        alert('Connection closed.');
        resetUI();
      };
    });

    function resetUI() {
      if (ws) {
        try { ws.close(); } catch(e) {}
        ws = null;
      }
      btnConnect.disabled = false;
      btnConnect.textContent = 'Connect';
      secPin.classList.remove('active');
      secUpload.classList.remove('active');
      secConnect.classList.add('active');
      subtitle.textContent = 'Connect to peer to send files directly over the local network.';
      uploadStatus.textContent = '';
      fileListContainer.innerHTML = '';
      selectedFiles = [];
      dropzone.style.pointerEvents = 'auto';
      dropzone.style.opacity = '1';
      downloadsContainer.style.display = 'none';
      downloadList.innerHTML = '';
    }

    function updateDownloadsList(files) {
      if (!files || files.length === 0) {
        downloadsContainer.style.display = 'none';
        downloadList.innerHTML = '';
        return;
      }
      downloadsContainer.style.display = 'flex';
      downloadList.innerHTML = '';
      files.forEach((file) => {
        const item = document.createElement('div');
        item.className = 'download-item';
        item.innerHTML = 
          '<div class="download-name" title="' + file.name + '">' + file.name + 
            ' <span class="download-size">(' + formatBytes(file.size) + ')</span>' +
          '</div>' +
          '<a href="/download/' + file.id + '" download="' + file.name + '" style="text-decoration: none;">' +
            '<button class="download-btn">Download</button>' +
          '</a>';
        downloadList.appendChild(item);
      });
    }

    dropzone.addEventListener('click', () => fileInput.click());
    
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = Array.from(dt.files);
      if (files.length > 0) {
        handleFilesSelected(files);
      }
    });

    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      if (files.length > 0) {
        handleFilesSelected(files);
      }
    });

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function handleFilesSelected(files) {
      const existingNames = new Set(selectedFiles.map(f => f.name + '-' + f.size));
      for (const f of files) {
        if (!existingNames.has(f.name + '-' + f.size)) {
          selectedFiles.push(f);
        }
      }
      renderSelectedFiles();
      broadcastAvailableFiles();
    }

    function renderSelectedFiles() {
      fileListContainer.innerHTML = '';
      if (selectedFiles.length === 0) {
        uploadStatus.textContent = '';
        return;
      }
      uploadStatus.innerHTML = '<span style="color: #10b981; font-weight: 500;">✓ ' + selectedFiles.length + ' file(s) available for host to download</span>';
      selectedFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.id = 'file-item-' + index;
        item.innerHTML = 
          '<div style="display: flex; justify-content: space-between; align-items: center;">' +
            '<div class="file-name" title="' + file.name + '">' + file.name + '</div>' +
            '<button onclick="removeSelectedFile(' + index + ')" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 12px; padding: 0 4px;">✕</button>' +
          '</div>' +
          '<div class="progress-bar" style="display: none;" id="progress-bar-' + index + '">' +
            '<div class="progress-fill" id="progress-fill-' + index + '"></div>' +
          '</div>' +
          '<div class="file-info">' +
            '<span id="progress-text-' + index + '">Ready for download</span>' +
            '<span>' + formatBytes(file.size) + '</span>' +
          '</div>';
        fileListContainer.appendChild(item);
      });
    }

    window.removeSelectedFile = function(index) {
      selectedFiles.splice(index, 1);
      renderSelectedFiles();
      broadcastAvailableFiles();
    };

    function broadcastAvailableFiles() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'downloads-available',
        files: selectedFiles.map((f, i) => ({
          id: 'web-' + i + '-' + f.name,
          name: f.name,
          size: f.size
        }))
      }));
    }

    function streamFileToHost(file, index) {
      const progressBar = document.getElementById('progress-bar-' + index);
      const progressFill = document.getElementById('progress-fill-' + index);
      const progressText = document.getElementById('progress-text-' + index);
      if (progressBar) progressBar.style.display = 'block';

      uploadStatus.innerHTML = 'Sending ' + file.name + ' to host...';

      ws.send(JSON.stringify({
        type: 'file-info',
        name: file.name,
        size: file.size
      }));

      const chunkSize = 65536;
      let offset = 0;

      function sendChunk() {
        if (offset >= file.size) {
          if (progressText) progressText.textContent = 'Transferred ✓';
          if (progressFill) progressFill.style.width = '100%';
          uploadStatus.innerHTML = '<span class="status-success">✓ Sent ' + file.name + ' successfully!</span>';
          return;
        }

        if (ws.bufferedAmount > 1024 * 1024) {
          setTimeout(sendChunk, 50);
          return;
        }

        const slice = file.slice(offset, offset + chunkSize);
        ws.send(slice);
        offset += chunkSize;

        const pct = Math.min(100, Math.round((offset / file.size) * 100));
        if (progressFill) progressFill.style.width = pct + '%';
        if (progressText) progressText.textContent = pct + '% (' + formatBytes(offset) + ')';

        setTimeout(sendChunk, 0);
      }

      sendChunk();
    }
  </script>
</body>
</html>`;
}


interface BatchState {
  expected: number;
  received: number;
}

interface ActiveTransfer {
  name: string;
  size: number;
  received: number;
  fd: number;
  destPath: string;
}

interface SharedFileEntry {
  id: string;
  name: string;
  size: number;
  localPath: string;
}

interface RemoteFileEntry {
  id: string;
  name: string;
  size: number;
}

interface FileTransferServerEvents {
  guestPinPending: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void;
  connectionAdmitted: (connId: string, deviceName: string) => void;
  connectionClosed: (connId: string) => void;
  peerFilesChanged: (connId: string, files: RemoteFileEntry[]) => void;
  transferStarted: (connId: string, name: string, size: number) => void;
  transferProgress: (connId: string, received: number, size: number) => void;
  transferComplete: (connId: string, destPath: string) => void;
  fileStarted: (fileIndex: number, fileCount: number, name: string) => void;
  sendProgress: (sent: number, total: number) => void;
  sendComplete: () => void;
  error: (err: Error) => void;
}

export declare interface FileTransferServer {
  on<E extends keyof FileTransferServerEvents>(event: E, listener: FileTransferServerEvents[E]): this;
  emit<E extends keyof FileTransferServerEvents>(event: E, ...args: Parameters<FileTransferServerEvents[E]>): boolean;
}

export class FileTransferServer extends EventEmitter {
  private httpsServer: https.Server | null = null;
  private httpServer: http.Server | null = null;
  private wss: WebSocket.Server | null = null;
  private myPublicKeyDer: Buffer;
  private pendingGuests = new Map<string, PendingGuest>();
  private validTokens = new Map<string, { deviceId: string; deviceName: string }>();
  private admittedConnections = new Map<string, WebSocket>();
  private admittedDeviceNames = new Map<string, string>();
  private activeTransfers = new Map<string, ActiveTransfer>();
  private batchState = new Map<string, BatchState>();
  private isWebMode = false;
  private connSaveDirs = new Map<string, string>();
  private availableDownloads: SharedFileEntry[] = [];
  private peerFiles = new Map<string, RemoteFileEntry[]>();

  constructor(
    private cert: string,
    private key: string,
    private port: number,
    private saveDir: string,
    private deviceName: string,
    private isBlocked: (idOrIp: string) => boolean = () => false
  ) {
    super();
    this.myPublicKeyDer = new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  }

  setAvailableDownloads(files: { name: string; localPath: string }[]) {
    this.availableDownloads = [];
    for (const f of files) {
      if (fs.existsSync(f.localPath)) {
        try {
          const stat = fs.statSync(f.localPath);
          if (stat.isFile()) {
            this.availableDownloads.push({
              id: `file-${crypto.randomBytes(4).toString('hex')}`,
              name: f.name,
              size: stat.size,
              localPath: f.localPath
            });
          }
        } catch (e) {
          console.error('[Link] Failed to stat file for download:', e);
        }
      }
    }
    const packet = JSON.stringify({
      type: 'downloads-available',
      files: this.availableDownloads.map(d => ({ id: d.id, name: d.name, size: d.size }))
    });
    for (const ws of this.admittedConnections.values()) {
      try { ws.send(packet); } catch {}
    }
  }

  start(webMode: boolean = false): Promise<void> {
    this.isWebMode = webMode;
    return new Promise((resolve, reject) => {
      if (webMode) {
        this.httpServer = http.createServer((req: any, res: any) => {
          const urlPath = req.url || '';
          if (urlPath === '/' || urlPath === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getWebClientHtml());
          } else if (urlPath.startsWith('/download/')) {
            const fileId = urlPath.substring('/download/'.length).split('?')[0];
            const file = this.availableDownloads.find(d => d.id === fileId);
            if (!file) {
              res.writeHead(404);
              res.end('File Not Found');
              return;
            }
            if (!fs.existsSync(file.localPath)) {
              res.writeHead(410);
              res.end('File no longer exists on host');
              return;
            }
            const stat = fs.statSync(file.localPath);
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': stat.size,
              'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`
            });
            const readStream = fs.createReadStream(file.localPath);
            readStream.pipe(res);
          } else {
            res.writeHead(404);
            res.end('Not Found');
          }
        });

        this.wss = new WebSocket.Server({ server: this.httpServer });
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

        this.httpServer.on('error', (err) => {
          this.emit('error', err);
          reject(err);
        });

        this.httpServer.listen(this.port, () => resolve());
      } else {
        this.httpsServer = https.createServer({
          cert: this.cert,
          key: this.key,
          requestCert: true,
          rejectUnauthorized: false,
        });

        this.wss = new WebSocket.Server({ server: this.httpsServer });
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

        this.httpsServer.on('error', (err) => {
          this.emit('error', err);
          reject(err);
        });

        this.httpsServer.listen(this.port, () => resolve());
      }
    });
  }

  issueToken(deviceId: string, deviceName: string): string {
    const token = crypto.randomBytes(16).toString('hex');
    this.validTokens.set(token, { deviceId, deviceName });
    return token;
  }

  holdGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending || !pending.timeout) return;
    clearTimeout(pending.timeout);
    pending.timeout = null;
  }

  acceptGuest(connId: string, saveDir?: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    if (saveDir) this.connSaveDirs.set(connId, saveDir);
    this.admit(connId, pending.ws, pending.deviceName || 'Guest');
  }

  rejectGuest(connId: string) {
    const pending = this.pendingGuests.get(connId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingGuests.delete(connId);
    try { pending.ws.close(4007, 'rejected by host'); } catch {}
  }

  disconnectConnection(connId: string) {
    const ws = this.admittedConnections.get(connId);
    if (ws) {
      try { ws.close(1000, 'disconnect'); } catch {}
      this.admittedConnections.delete(connId);
      this.admittedDeviceNames.delete(connId);
      this.peerFiles.delete(connId);
    }
  }

  getConnectedPeer(): { connId: string; deviceName: string } | null {
    const entry = this.admittedConnections.entries().next().value;
    if (!entry) return null;
    const [connId] = entry;
    return { connId, deviceName: this.admittedDeviceNames.get(connId) || 'Peer' };
  }

  hasConnectedPeers(): boolean {
    return this.admittedConnections.size > 0;
  }

  isWeb(): boolean {
    return this.isWebMode;
  }

  getPendingGuestBlockInfo(connId: string): { remoteAddress: string; deviceName?: string } | null {
    const pending = this.pendingGuests.get(connId);
    return pending ? { remoteAddress: pending.remoteAddress, deviceName: pending.deviceName } : null;
  }

  hasActiveTransfer(): boolean {
    return this.activeTransfers.size > 0;
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingGuests.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      try { pending.ws.close(1000, 'server closing'); } catch {}
    }
    this.pendingGuests.clear();
    this.validTokens.clear();
    for (const ws of this.admittedConnections.values()) {
      try { ws.close(1000, 'server closing'); } catch {}
    }
    this.admittedConnections.clear();
    this.admittedDeviceNames.clear();
    for (const transfer of this.activeTransfers.values()) {
      try { fs.closeSync(transfer.fd); } catch {}
    }
    this.activeTransfers.clear();
    this.batchState.clear();
    this.connSaveDirs.clear();
    this.peerFiles.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpsServer) {
      const server = this.httpsServer;
      this.httpsServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.availableDownloads = [];
  }

  private admit(connId: string, ws: WebSocket, senderDeviceName: string) {
    this.admittedConnections.set(connId, ws);
    this.admittedDeviceNames.set(connId, senderDeviceName);
    ws.send(JSON.stringify({ type: 'admitted', deviceName: this.deviceName }));
    if (this.availableDownloads.length > 0) {
      ws.send(JSON.stringify({
        type: 'downloads-available',
        files: this.availableDownloads.map(d => ({ id: d.id, name: d.name, size: d.size }))
      }));
    }
    this.emit('connectionAdmitted', connId, senderDeviceName);
  }

  private handleConnection(ws: WebSocket, req: any) {
    let peerPublicKeyDer: Buffer | null = null;

    if (!this.isWebMode) {
      const socket = req.socket as tls.TLSSocket;
      const peerCert = socket.getPeerCertificate();
      if (!peerCert || !peerCert.raw) {
        ws.close(4001, 'no client certificate presented');
        return;
      }

      try {
        peerPublicKeyDer = new crypto.X509Certificate(peerCert.raw).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      } catch {
        ws.close(4002, 'invalid certificate');
        return;
      }
    }

    const remoteAddress = (req.socket.remoteAddress as string) || 'unknown';
    const connId = crypto.randomUUID();

    if (this.isBlocked(remoteAddress)) {
      ws.close(4010, 'blocked');
      return;
    }

    const onFirstMessage = (data: WebSocket.RawData) => {
      ws.off('message', onFirstMessage);
      let msg: any;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        ws.close(4003, 'malformed join message');
        return;
      }

      if (msg.type === 'join-token' && typeof msg.token === 'string') {
        const entry = this.validTokens.get(msg.token);
        if (!entry) {
          ws.close(4005, 'invalid or expired token');
          return;
        }
        this.validTokens.delete(msg.token);
        if (this.isBlocked(entry.deviceId)) {
          ws.close(4010, 'blocked');
          return;
        }
        this.admit(connId, ws, entry.deviceName);
      } else if (msg.type === 'join-guest') {
        let pin: string;
        if (this.isWebMode) {
          pin = Math.floor(100000 + crypto.randomInt(900000)).toString();
        } else {
          pin = computeVerificationCode(this.myPublicKeyDer, peerPublicKeyDer!);
        }
        const timeout = setTimeout(() => {
          this.pendingGuests.delete(connId);
          try { ws.close(4006, 'confirmation timed out'); } catch {}
        }, GUEST_CONFIRM_TIMEOUT_MS);
        const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName : undefined;
        this.pendingGuests.set(connId, { ws, pin, timeout, remoteAddress, deviceName });
        try { ws.send(JSON.stringify({ type: 'pin', code: pin })); } catch {}
        this.emit('guestPinPending', connId, pin, remoteAddress, deviceName);
      } else {
        ws.close(4004, 'unknown join type');
      }
    };
    ws.on('message', onFirstMessage);

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        let msg: any;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (msg.type === 'downloads-available' && Array.isArray(msg.files)) {
          this.peerFiles.set(connId, msg.files);
          this.emit('peerFilesChanged', connId, msg.files);
        } else if (msg.type === 'request-download' && typeof msg.fileId === 'string') {
          const file = this.availableDownloads.find(d => d.id === msg.fileId);
          if (file && fs.existsSync(file.localPath)) {
            streamFileOverWebSocket(ws, file.localPath, file.name, (sent, total) => {
              this.emit('sendProgress', sent, total);
            }).then(() => {
              this.emit('sendComplete');
            }).catch((err) => {
              console.error('[Link] Download stream failed:', err);
            });
          }
        } else if (msg.type === 'batch-info' && typeof msg.count === 'number' && msg.count > 0) {
          this.batchState.set(connId, { expected: msg.count, received: 0 });
        } else if (msg.type === 'file-info' && typeof msg.name === 'string' && typeof msg.size === 'number') {
          this.startTransfer(connId, ws, msg.name, msg.size);
        } else if (msg.type === 'received') {
          this.emit('sendComplete');
        }
        return;
      }
      this.handleBinaryChunk(connId, ws, data as Buffer);
    });

    ws.on('close', () => {
      this.pendingGuests.delete(connId);
      this.batchState.delete(connId);
      this.connSaveDirs.delete(connId);
      this.admittedConnections.delete(connId);
      this.peerFiles.delete(connId);
      this.emit('connectionClosed', connId);
      const transfer = this.activeTransfers.get(connId);
      if (transfer) {
        try { fs.closeSync(transfer.fd); } catch {}
        this.activeTransfers.delete(connId);
      }
    });
  }

  requestDownload(connId: string, fileId: string, saveDir?: string) {
    if (saveDir) {
      this.connSaveDirs.set(connId, saveDir);
    }
    const ws = this.admittedConnections.get(connId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'request-download', fileId }));
    }
  }

  getPeerFiles(connId?: string): RemoteFileEntry[] {
    if (connId) return this.peerFiles.get(connId) || [];
    const first = this.peerFiles.values().next().value;
    return first || [];
  }

  private startTransfer(connId: string, ws: WebSocket, name: string, size: number) {
    if (size < 0 || size > MAX_FILE_BYTES) {
      ws.close(4008, 'file too large');
      return;
    }
    const saveDir = this.connSaveDirs.get(connId) || this.saveDir;
    fs.mkdirSync(saveDir, { recursive: true });

    const parts = name.split(/[/\\]/).filter(p => p && p !== '.' && p !== '..');
    const relativePath = path.join(...parts);
    if (!relativePath) {
      ws.close(4009, 'invalid filename');
      return;
    }

    let destPath = path.join(saveDir, relativePath);
    const dirName = path.dirname(destPath);
    fs.mkdirSync(dirName, { recursive: true });

    const ext = path.extname(relativePath);
    const base = path.basename(relativePath, ext);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      destPath = path.join(dirName, `${base} (${counter})${ext}`);
      counter++;
    }

    const fd = fs.openSync(destPath, 'w');
    this.activeTransfers.set(connId, { name: relativePath, size, received: 0, fd, destPath });
    this.emit('transferStarted', connId, relativePath, size);
  }

  getAdmittedConnectionIds(): string[] {
    return Array.from(this.admittedConnections.keys());
  }

  async sendFiles(connId: string, files: { localPath: string; relPath: string }[]): Promise<void> {
    const ws = this.admittedConnections.get(connId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    ws.send(JSON.stringify({ type: 'batch-info', count: files.length }));
    for (let i = 0; i < files.length; i++) {
      this.emit('fileStarted', i, files.length, files[i].relPath);
      await streamFileOverWebSocket(ws, files[i].localPath, files[i].relPath, (sent, total) => {
        this.emit('sendProgress', sent, total);
      });
    }
  }

  private handleBinaryChunk(connId: string, ws: WebSocket, chunk: Buffer) {
    const transfer = this.activeTransfers.get(connId);
    if (!transfer) return;
    fs.writeSync(transfer.fd, chunk, 0, chunk.length, transfer.received);
    transfer.received += chunk.length;
    this.emit('transferProgress', connId, transfer.received, transfer.size);

    if (transfer.received >= transfer.size) {
      fs.closeSync(transfer.fd);
      this.activeTransfers.delete(connId);
      this.emit('transferComplete', connId, transfer.destPath);

      const batch = this.batchState.get(connId);
      if (batch) {
        batch.received += 1;
        if (batch.received < batch.expected) return;
        this.batchState.delete(connId);
      }

      try { ws.send(JSON.stringify({ type: 'received' })); } catch {}
    }
  }
}

