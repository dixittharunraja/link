import { app, BrowserWindow, ipcMain, Notification, nativeImage, powerMonitor, Tray, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as dgram from 'dgram';

app.setName('Link');
import { loadOrCreateIdentity, saveDeviceName } from '../core/identity';
import { loadOrCreateTlsIdentity } from '../core/tls';
import { TrustStore } from '../core/trust';
import { OwnerKeyStore, RevocationStore } from '../core/pool';
import { DeviceManager } from '../core/device-manager';
import { LINK_PORT, AUDIO_RELAY_PORT } from '../core/transport';
import { createPacket } from '../core/packet';
import { AudioRelayServer } from './audio-relay-server';
import { AudioRelayClient, JoinMode } from './audio-relay-client';
import {
  ClipboardWatcher,
  createClipboardPacket,
  createClipboardConnectPacket,
  isClipboardPacket,
  extractIncomingClipboardText,
} from '../core/plugins/clipboard';
import { downloadPayload, startPayloadUpload } from '../core/payload-transfer';
import { isCapabilitiesPacket } from '../core/plugins/capabilities';
import {
  initPermissions,
  checkDevicePermission,
  getAllPermissions,
  writeAllPermissions,
  initializeDeniedPermissionsForNewDevice,
  computeEffectiveCapabilities,
  pushEffectiveCapabilities,
  canSendClipboardTo,
} from './permissions';
import { loadSetting, saveSetting } from './settings-store';
import { DiscoveryService } from '../core/discovery';
import { BatteryWatcher, createBatteryPacket, isBatteryPacket } from '../core/plugins/battery';
import { createFindMyPhonePacket, isFindMyPhonePacket, ringThisDevice, stopRinging } from '../core/plugins/findmyphone';
import { LinkSocketFsClient } from './fs-socket-client';
import { getLocalPhysicalDrives } from './fs-helper';
import { SpeedTestManager } from '../core/plugins/speedtest';
import {
  RunCommandManager,
  isRunCommandRequestPacket,
  isRunCommandListPacket,
  createRequestCommandListPacket,
  createTriggerCommandPacket,
  CommandEntry,
} from '../core/plugins/runcommand';
import { isPresenterPacket, isPresenterStopPacket, PresenterPosition } from '../core/plugins/presenter';
import {
  VolumeWatcher,
  createSystemVolumePacket,
  isSystemVolumeRequestPacket,
  isSystemVolumePacket,
  handleSystemVolumeRequest,
  createSetVolumeRequestPacket,
  createSetMuteRequestPacket,
} from '../core/plugins/systemvolume';
import {
  createLockPacket,
  createLockRequestPacket,
  isLockPacket,
  isLockRequestPacket,
  isLocalDeviceLocked,
  lockThisDevice,
  setLocalLockedState,
} from '../core/plugins/lockdevice';
import { isConnectivityPacket, ConnectivityBody } from '../core/plugins/connectivity';
import { TouchpadHandler, isTouchpadRequestPacket } from '../core/plugins/touchpad';
import { createMprisStatePacket, isMprisRequestPacket, MprisRequest, queryMprisSessions, controlMpris } from '../core/plugins/mpris';
import { isTelephonyPacket, TelephonyBody } from '../core/plugins/telephony';
import { isNotificationPacket, NotificationBody } from '../core/plugins/notification';
import { ScreensaverInhibitor } from '../core/plugins/screensaver-inhibit';
import { PauseMusicController } from '../core/plugins/pausemusic';
import { DigitizerHandler, isDigitizerSessionPacket, isDigitizerPacket } from '../core/plugins/digitizer';
import { isFlashlightPacket, createFlashlightPacket } from '../core/plugins/flashlight';
import { isDNDPacket, createDNDPacket } from '../core/plugins/dnd';
import {
  isRenamePacket,
  isRenameRequestPacket,
  createRenamePacket,
  createRenameRequestPacket,
} from '../core/plugins/rename';
import { screen } from 'electron';

import { LinkFsClient } from './fs-client';
import { LinkFsMountService } from './fs-mount-service';

// Master kill-switch for the systematic re-verification pass: everything in test.txt starts
// disabled so the core connection (discovery/pairing/trust/TLS) can be solidified in isolation
// first, then plugins re-enabled one at a time as confirmed working. Does not touch any plugin's
// own logic — this only gates whether main.ts wires it up/dispatches to it. Speed Test, System
// Volume, and MPRIS have graduated out of this — confirmed working, so their gates were removed
// entirely rather than left toggled on here.
const ENABLED_PLUGINS = new Set<string>([
  'Clipboard',
]);
function isEnabled(name: string): boolean {
  return ENABLED_PLUGINS.has(name);
}

const CAPABILITIES = {
  incoming: [
    'link.clipboard', 'link.clipboard.connect', 'link.clipboard.file', 'link.battery',
    'link.findmyphone.request', 'link.runcommand.request', 'link.presenter',
    'link.systemvolume.request', 'link.lock.request', 'link.lock', 'link.connectivity_report',
    'link.touchpad.request', 'link.mpris.request', 'link.telephony', 'link.notification',
    'link.flashlight', 'link.dnd', 'link.rename', 'link.rename.request',
    // Digitizer was executable (checkDevicePermission-gated handlers already existed) but never
    // actually declared as a capability — peers had no way to discover the PC supports it at all.
    'link.digitizer.session', 'link.digitizer',
  ],
  outgoing: [
    'link.clipboard', 'link.clipboard.connect', 'link.clipboard.file', 'link.battery',
    'link.findmyphone.request', 'link.runcommand',
    // 'link.presenter' was wrongly listed here — desktop has no IPC path that ever sends a
    // presenter/touchpad/digitizer packet (those are mobile-to-desktop only, desktop is purely
    // the executor), so it never belongs in desktop's own outgoing list.
    'link.systemvolume', 'link.lock.request', 'link.lock', 'link.mpris',
    'link.flashlight', 'link.dnd', 'link.rename', 'link.rename.request',
  ],
};

let mainWindow: BrowserWindow | null = null;
// System-tray "close to tray" (Spotify/Discord-style): when enabled, closing the window hides it
// to a tray icon instead of quitting, so the mesh connections keep running in the background.
let tray: Tray | null = null;
let isQuitting = false;          // set true only by the tray "Quit" action / real app quit
let closeToTray = true;          // user preference, loaded from disk in initCore
let hasShownTrayBalloon = false; // one-time "still running" hint on first hide-to-tray
let deviceManager: DeviceManager;
// Last effective-capabilities list each connected peer pushed us (which of THEIR gated plugins
// we're currently allowed to use). Cached in the main process so a renderer reload can re-hydrate
// it locally via get-connected-devices — the peer only pushes this on connect / permission-change,
// so without this cache a reload would blank every gated plugin until the peer happened to reload
// too (the "reload ping-pong" where each side's reload fixed the other's view but broke its own).
const peerCapabilities = new Map<string, string[]>();
let tlsIdentity: { cert: string; key: string };
const fsClients = new Map<string, LinkFsClient>();
const socketFsClients = new Map<string, LinkSocketFsClient>();
const fsMountServices = new Map<string, LinkFsMountService>();
// Audio Relay: at most one role at a time — hosting (audioRelayServer) or listening
// (audioRelayClient), never both. Deliberately isolated from DeviceManager/TrustStore — see
// audio-relay-server.ts's header comment for why.
let audioRelayServer: AudioRelayServer | null = null;
let audioRelayClient: AudioRelayClient | null = null;
let remoteMicClient: AudioRelayClient | null = null;
let configDir: string;
let clipboardWatcher: ClipboardWatcher;
let lastKnownClipboardTimestamp = 0;
let batteryWatcher: BatteryWatcher;
let volumeWatcher: VolumeWatcher;
let touchpadHandler: TouchpadHandler;
let screensaverInhibitor: ScreensaverInhibitor;
let pauseMusicController: PauseMusicController;
let digitizerHandler: DigitizerHandler;
let runCommandManager: RunCommandManager;
let speedTestManager: SpeedTestManager;
// Guards against firing overlapping connectTo() attempts at the same peer while a previous one
// from an earlier discovery broadcast is still in flight — see discoveryService callback below.
const connectingDeviceIds = new Set<string>();
// Backoff for reconnect attempts that can't even establish a connection (e.g. a stale discovery
// entry for a peer that's genuinely offline) — without this, such a peer got retried on every
// single discovery broadcast (~every 5s) with zero cooldown. Deliberately does NOT apply to a
// peer that connects and later disconnects (app restart, brief Wi-Fi drop, etc.) — that case
// should always reconnect immediately on the next broadcast, no penalty, for reconnection to feel
// seamless rather than laggy.
const reconnectBackoff = new Map<string, { nextAttemptAt: number; failCount: number }>();
const MAX_BACKOFF_MS = 15000;
const MIN_BACKOFF_MS = 1000;

function recordConnectFailure(deviceId: string) {
  const prev = reconnectBackoff.get(deviceId);
  const failCount = (prev?.failCount || 0) + 1;
  const delayMs = Math.min(MIN_BACKOFF_MS * Math.pow(2, failCount - 1), MAX_BACKOFF_MS);
  reconnectBackoff.set(deviceId, { nextAttemptAt: Date.now() + delayMs, failCount });
}

function clearConnectBackoff(deviceId: string) {
  reconnectBackoff.delete(deviceId);
}

function canAttemptConnect(deviceId: string): boolean {
  const backoff = reconnectBackoff.get(deviceId);
  return !backoff || Date.now() >= backoff.nextAttemptAt;
}
// Run Command whitelists RECEIVED FROM peers (mesh case: any device, mobile or desktop, viewing a
// paired desktop's panel needs that desktop's real whitelist — distinct from runCommandManager,
// which owns/serves THIS device's own whitelist to others).
const peerCommandLists = new Map<string, Record<string, CommandEntry>>();
const activeNotifications = new Map<string, Notification>();
const activeAppNotifications = new Map<string, Notification>();
let discoveryService: DiscoveryService;
let inputUdpSocket: dgram.Socket | null = null;
let visibilityEnabled = true;
let screensaverInhibitEnabled = true;
let activeRingerDeviceId: string | null = null;
let ringTimeoutMain: NodeJS.Timeout | null = null;

let presenterWindow: BrowserWindow | null = null;
let presenterPosition: PresenterPosition | null = null;
let presenterHideTimeout: NodeJS.Timeout | null = null;
const PRESENTER_HIDE_DELAY_MS = 500; // matches upstream's 500ms auto-hide-when-idle timer

// Multi-monitor target for the absolute-positioned features (presenter dot + digitizer). Touchpad
// doesn't need this — it sends relative moves that cross monitors natively. Tracked by Electron
// display id (survives display list reordering); defaults to the primary display. The phone cycles
// it via the "Switch Screen" overlay button (link.target.display packet).
let targetDisplayId: number | null = null;
function getTargetDisplay() {
  const displays = screen.getAllDisplays();
  return displays.find((d) => d.id === targetDisplayId) || screen.getPrimaryDisplay();
}
function cycleTargetDisplay() {
  const displays = screen.getAllDisplays();
  if (displays.length <= 1) return; // single monitor — nothing to switch to
  const currentId = getTargetDisplay().id;
  const idx = displays.findIndex((d) => d.id === currentId);
  targetDisplayId = displays[(idx + 1) % displays.length].id;
  // Recreate the presenter dot on the newly-targeted display on its next move (it's positioned at
  // creation time), so an already-open dot follows the switch instead of being stranded.
  if (presenterWindow) {
    try { presenterWindow.close(); } catch { /* already gone */ }
    presenterWindow = null;
  }
}

function send(channel: string, ...args: unknown[]) {
  mainWindow?.webContents.send(channel, ...args);
}

// Shared by every plugin that broadcasts state/whitelist updates to all connected peers, gated on
// each peer's own permission for that key — previously this exact loop (trustedConnectedDeviceIds
// + per-peer checkDevicePermission + sendTo) was copy-pasted at 7+ call sites (MPRIS, Clipboard,
// System Volume, Run Command).
function broadcastToPermittedPeers(permKey: string, packet: any) {
  for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
    if (!checkDevicePermission(peerId, permKey)) continue;
    deviceManager.sendTo(peerId, packet);
  }
}

/** Forwards every AudioRelayClient event to the renderer over its own IPC channel — one place so
 *  both join paths (guest, paired-token) get identical renderer-side behavior. */
function wireAudioRelayClientEvents(client: AudioRelayClient) {
  client.on('pinComputed', (pin) => send('audio-relay-pin-computed', pin));
  client.on('admitted', () => send('audio-relay-admitted'));
  client.on('format', (format) => send('audio-relay-format', format));
  client.on('audioChunk', (pcm) => send('audio-relay-audio-chunk', pcm));
  client.on('hostMuted', (muted) => send('audio-relay-host-muted', muted));
  client.on('ended', () => send('audio-relay-ended'));
  client.on('closed', (reason) => send('audio-relay-closed', reason));
  client.on('error', (err) => send('audio-relay-error', err.message));
}

function wireRemoteMicClientEvents(client: AudioRelayClient) {
  client.on('pinComputed', (pin) => send('remote-mic-pin-computed', pin));
  client.on('admitted', () => send('remote-mic-admitted'));
  client.on('format', (format) => send('remote-mic-format', format));
  client.on('audioChunk', (pcm) => send('remote-mic-audio-chunk', pcm));
  client.on('hostMuted', (muted) => send('remote-mic-host-muted', muted));
  client.on('ended', () => send('remote-mic-ended'));
  client.on('closed', (reason) => send('remote-mic-closed', reason));
  client.on('error', (err) => send('remote-mic-error', err.message));
}

function showPresenterDot(dx: number, dy: number) {
  const display = getTargetDisplay();
  const { width, height } = display.workAreaSize;

  if (!presenterWindow) {
    presenterPosition = new PresenterPosition(width / height);
    presenterWindow = new BrowserWindow({
      width,
      height,
      x: display.workArea.x,
      y: display.workArea.y,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../main/presenter-preload.js'),
      },
    });
    presenterWindow.setAlwaysOnTop(true, 'screen-saver');
    presenterWindow.setIgnoreMouseEvents(true);
    presenterWindow.loadFile(path.join(__dirname, '../renderer/presenter-overlay.html'));
    presenterWindow.on('closed', () => {
      presenterWindow = null;
    });
  }

  const { x, y } = presenterPosition!.update(dx, dy);
  presenterWindow.webContents.send('presenter-position', x, y);

  if (presenterHideTimeout) clearTimeout(presenterHideTimeout);
  presenterHideTimeout = setTimeout(hidePresenterDot, PRESENTER_HIDE_DELAY_MS);
}

function hidePresenterDot() {
  if (presenterHideTimeout) {
    clearTimeout(presenterHideTimeout);
    presenterHideTimeout = null;
  }
  if (presenterWindow) {
    try {
      presenterWindow.close();
    } catch {
      // already destroyed (e.g. app quitting) — nothing left to clean up
    }
    presenterWindow = null;
  }
  presenterPosition = null;
}

// Matches upstream's plugin lifecycle exactly: inhibit while ANY trusted device is connected,
// stop inhibiting once none are (constructor/destructor upstream -> start()/stop() here).
function updateScreensaverInhibition() {
  if (screensaverInhibitEnabled && deviceManager.trustedConnectedDeviceIds().length > 0) {
    screensaverInhibitor.start();
  } else {
    screensaverInhibitor.stop();
  }
}

function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// Finds the first unused drive letter from Z down to D — shared by both the desktop-peer and
// mobile-peer mount paths below, which previously each had their own copy of this loop.
function findUnusedDriveLetter(): string {
  const letters = 'ZYXWVUTSRQPONMLKJIHGFED'.split('');
  for (const letter of letters) {
    if (!fs.existsSync(`${letter}:`)) return `${letter}:`;
  }
  return 'Z:';
}

// Extracted from the deviceConnected handler, where this was ~60 lines of inline async logic.
// Module-scoped (not nested in initCore) so the set-permissions handler can also call it to
// mount/unmount in real time when fileaccess is toggled mid-session, not just on connect.
//
// Does NOT check checkDevicePermission(peerIdentity.deviceId, 'fileaccess') before attempting
// to mount — that would check THIS device's own permission-for-that-peer, which controls what
// the PEER is allowed to do TO this device, not what this device is allowed to do to the peer
// (mounting/browsing THEM). That's backwards for this direction, and since every newly-paired
// device starts with 'fileaccess' denied by default (see initializeDeniedPermissionsForNewDevice
// in permissions.ts), that check would have silently prevented File System from ever working at
// all regardless of what the peer actually granted. The real, correct enforcement already lives
// on the PEER's own executor side (main.ts's 'link.fs.request' handler checks the requester's
// own permission before answering) — this function just attempts the mount; if the peer hasn't
// granted access, their first response will fail and mount() below rejects cleanly instead of
// silently substituting a fake root and presenting a broken drive.
async function mountFilesystemForDevice(peerIdentity: { deviceId: string; deviceName: string; deviceType?: string }, host: string) {
  if (fsMountServices.has(peerIdentity.deviceId)) {
    console.log(`[Link] Device ${peerIdentity.deviceName} already has an active filesystem mount. Skipping.`);
    return;
  }
  try {
    if (peerIdentity.deviceType === 'desktop' || peerIdentity.deviceType === 'laptop') {
      console.log(`[Link] Instantiating Socket FS Client for desktop ${peerIdentity.deviceName} at ${host}...`);
      const socketFsClient = new LinkSocketFsClient(deviceManager, peerIdentity.deviceId);
      socketFsClients.set(peerIdentity.deviceId, socketFsClient);

      const driveLetter = findUnusedDriveLetter();
      console.log(`[Link] Mounting PC filesystem for ${peerIdentity.deviceName} on ${driveLetter}...`);
      const mountService = new LinkFsMountService(socketFsClient as any, driveLetter, peerIdentity.deviceName, peerIdentity.deviceType);
      await mountService.mount();
      fsMountServices.set(peerIdentity.deviceId, mountService);
      console.log(`[Link] Mounted ${peerIdentity.deviceName} PC filesystem on ${driveLetter} successfully.`);
    } else {
      console.log(`[Link] Starting FS WSS client for ${peerIdentity.deviceName} at ${host}...`);
      const fsClient = new LinkFsClient(host, undefined, tlsIdentity.cert, tlsIdentity.key);
      await fsClient.connect();
      fsClients.set(peerIdentity.deviceId, fsClient);
      console.log(`[Link] Connected FS client for ${peerIdentity.deviceName} successfully.`);

      const driveLetter = findUnusedDriveLetter();
      console.log(`[Link] Mounting filesystem for ${peerIdentity.deviceName} on ${driveLetter}...`);
      const mountService = new LinkFsMountService(fsClient, driveLetter, peerIdentity.deviceName, peerIdentity.deviceType);
      await mountService.mount();
      fsMountServices.set(peerIdentity.deviceId, mountService);
      console.log(`[Link] Mounted ${peerIdentity.deviceName} filesystem on ${driveLetter} successfully.`);
    }
  } catch (err: any) {
    console.error(`[Link] Failed to mount FS Client (likely denied or unreachable):`, err.message);
    socketFsClients.delete(peerIdentity.deviceId);
    const fsClient = fsClients.get(peerIdentity.deviceId);
    if (fsClient) {
      fsClient.disconnect();
      fsClients.delete(peerIdentity.deviceId);
    }
  }
}

function initCore() {
  configDir = path.join(app.getPath('userData'), 'link-config');

  const identity = loadOrCreateIdentity(configDir, 'desktop', CAPABILITIES);
  tlsIdentity = loadOrCreateTlsIdentity(configDir, identity.deviceId);
  const trustStore = new TrustStore(configDir);
  const ownerStore = new OwnerKeyStore(configDir);
  const revStore = new RevocationStore(configDir);

  deviceManager = new DeviceManager(
    { cert: tlsIdentity.cert, key: tlsIdentity.key, myIdentity: identity },
    trustStore,
    LINK_PORT,
    ownerStore,
    revStore
  );
  initPermissions(configDir, deviceManager);

  touchpadHandler = new TouchpadHandler(configDir);
  digitizerHandler = new DigitizerHandler(touchpadHandler);
  screensaverInhibitor = new ScreensaverInhibitor();
  pauseMusicController = new PauseMusicController();
  runCommandManager = new RunCommandManager(configDir);
  speedTestManager = new SpeedTestManager(deviceManager);

  closeToTray = loadSetting(configDir, 'tray-settings.json', 'closeToTray', true);
  visibilityEnabled = loadSetting(configDir, 'discovery-settings.json', 'visibilityEnabled', true);
  pauseMusicController.setEnabled(loadSetting(configDir, 'pause-music-settings.json', 'pauseMusicEnabled', true));
  screensaverInhibitEnabled = loadSetting(configDir, 'screensaver-inhibit-settings.json', 'screensaverInhibitEnabled', true);

  discoveryService = new DiscoveryService(identity, (ip, peerIdentity) => {
    // Broadcasts repeat every ~5s while a peer stays undiscovered — without this guard, a single
    // slow/hung connect attempt used to get re-fired on every subsequent broadcast, stacking up
    // overlapping attempts to the same peer instead of letting the one in flight finish or time
    // out. Combined with connectToPeer() now having an explicit timeout, a failed attempt clears
    // itself and the very next broadcast can retry cleanly.
    if (
      !deviceManager.hasPeer(peerIdentity.deviceId) &&
      !connectingDeviceIds.has(peerIdentity.deviceId) &&
      canAttemptConnect(peerIdentity.deviceId)
    ) {
      connectingDeviceIds.add(peerIdentity.deviceId);
      console.log(`[Link] Discovered peer ${peerIdentity.deviceName} at ${ip}. Connecting...`);
      deviceManager.connectTo(ip).then(() => {
        clearConnectBackoff(peerIdentity.deviceId);
      }).catch((err) => {
        // Ignore connection failures (common if peer went offline or is not listening yet)
        recordConnectFailure(peerIdentity.deviceId);
      }).finally(() => {
        connectingDeviceIds.delete(peerIdentity.deviceId);
      });
    }
  });
  discoveryService.start(visibilityEnabled);

  // Start high-speed UDP input relay server
  try {
    inputUdpSocket = dgram.createSocket('udp4');
    inputUdpSocket.on('message', (msg: Buffer, rinfo) => {
      // This fast-path relay has no packet envelope/deviceId of its own — unlike every other
      // plugin, a raw UDP packet here previously trusted ANY sender on the LAN, regardless of
      // pairing or per-device permission. Identify the sender by source IP against the currently
      // trusted+connected peer list, and gate exactly like the TLS-side session packets do.
      const senderId = deviceManager.deviceIdForAddress(rinfo.address);
      if (!senderId) return;

      const line = msg.toString('utf8').trim();
      if (line.startsWith('pmove ')) {
        if (!checkDevicePermission(senderId, 'presenter')) return;
        const parts = line.split(' ');
        const dx = parseFloat(parts[1]);
        const dy = parseFloat(parts[2]);
        showPresenterDot(dx, dy);
      } else if (line.startsWith('dig ')) {
        if (!checkDevicePermission(senderId, 'digitizer')) return;
        const parts = line.split(' ');
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        const touching = parts[3] === 'true';
        const w = (digitizerHandler as any).width || 1;
        const h = (digitizerHandler as any).height || 1;
        const rx = Math.max(0, Math.min(1.0, x / w));
        const ry = Math.max(0, Math.min(1.0, y / h));
        // Map the normalized touch point onto the TARGET display's pixel bounds and position via
        // SetCursorPos (setpos), so the digitizer draws on the chosen monitor rather than being
        // locked to the primary one (which mouse_event's ABSOLUTE flag would force).
        const d = getTargetDisplay();
        const px = Math.round(d.bounds.x + rx * d.bounds.width);
        const py = Math.round(d.bounds.y + ry * d.bounds.height);
        touchpadHandler.writeCommand(`setpos ${px} ${py}`);
        touchpadHandler.writeCommand(`touch ${touching}`);
      } else if (line === 'undo' || line === 'redo') {
        // Digitizer toolbar's undo/redo — gated by the SAME digitizer permission as the pen
        // input above (not touchpad), since it's a digitizer-session action, not a mouse one.
        if (!checkDevicePermission(senderId, 'digitizer')) return;
        touchpadHandler.writeCommand(line);
      } else {
        if (!checkDevicePermission(senderId, 'touchpad')) return;
        touchpadHandler.writeCommand(line);
      }
    });
    inputUdpSocket.bind(1717, '0.0.0.0', () => {
      console.log('[Link] High-speed UDP Input Relay listening on port 1717');
    });
  } catch (err) {
    console.error('[Link] Failed to start UDP Input Relay:', err);
  }

  deviceManager.on('deviceConnected', (peerIdentity, trusted) => {
    let displayName = peerIdentity.deviceName;
    if (trusted) {
      const trustedDev = deviceManager.trustStore.get(peerIdentity.deviceId);
      if (trustedDev) {
        displayName = trustedDev.deviceName;
      }
    }
    const modifiedIdentity = { ...peerIdentity, deviceName: displayName };
    send('device-connected', modifiedIdentity, trusted);
    if (trusted) {
      sendInitialSync(peerIdentity.deviceId);

      const host = deviceManager.remoteAddressOf(peerIdentity.deviceId);
      if (host) {
        mountFilesystemForDevice(peerIdentity, host);
      }
    }
    updateScreensaverInhibition();
  });
  deviceManager.on('deviceDisconnected', (deviceId) => {
    send('device-disconnected', deviceId);
    peerCapabilities.delete(deviceId); // drop cached caps — a fresh connect re-pushes them



    // Always clear backoff on disconnect — a peer that was actually connected and then dropped
    // (app restart, brief Wi-Fi blip) should be eligible to reconnect the instant the next
    // broadcast arrives, not wait out a penalty. Backoff only ever applies to connect attempts
    // that fail outright (see discoveryService callback above).
    clearConnectBackoff(deviceId);

    const mountService = fsMountServices.get(deviceId);
    if (mountService) {
      mountService.unmount();
      fsMountServices.delete(deviceId);
      console.log(`[Link] Unmounted filesystem for ${deviceId}`);
    }

    const fsClient = fsClients.get(deviceId);
    if (fsClient) {
      fsClient.disconnect();
      fsClients.delete(deviceId);
      console.log(`[Link] Stopped FS WSS client for ${deviceId}`);
    }

    if (socketFsClients.has(deviceId)) {
      socketFsClients.delete(deviceId);
      console.log(`[Link] Stopped FS Socket client for ${deviceId}`);
    }

    const ringing = activeNotifications.get(deviceId);
    if (ringing) {
      ringing.close();
      activeNotifications.delete(deviceId);
    }

    for (const [key, notification] of activeAppNotifications.entries()) {
      if (key.startsWith(`${deviceId}|`)) {
        notification.close();
        activeAppNotifications.delete(key);
      }
    }
    updateScreensaverInhibition();
  });
  deviceManager.on('incomingPairRequest', (deviceId, verificationKey) => {
    send('incoming-pair-request', deviceId, verificationKey);
  });
  deviceManager.on('pairingSuccessful', (deviceId) => {
    initializeDeniedPermissionsForNewDevice(deviceId);
    send('pairing-successful', deviceId);
    sendInitialSync(deviceId);
    updateScreensaverInhibition();
  });
  deviceManager.on('pairingFailed', (deviceId, reason) => {
    send('pairing-failed', deviceId, reason);
  });
  deviceManager.on('unpaired', (deviceId) => {
    send('unpaired', deviceId);
    updateScreensaverInhibition();
  });
  deviceManager.on('trustMismatch', (deviceId) => {
    send('trust-mismatch', deviceId);
  });
  // Each packet type gets its own named handler below (previously one 350-line if-else chain) —
  // purely organizational, same closure scope (still nested in initCore) and identical dispatch
  // order/logic, so behavior is unchanged. Lets the dispatcher itself read as a scannable list of
  // "packet type -> handler" instead of one monolithic block.

  function handleClipboardTextPacket(deviceId: string, packet: any) {
    if (!isEnabled('Clipboard')) return;
    // No receive-side gate — Clipboard is sending-only now (see canSendClipboardTo): the peer
    // already decided whether to share via their own outbound permission-for-us.
    const text = extractIncomingClipboardText(packet, lastKnownClipboardTimestamp);
    if (text !== null) {
      clipboardWatcher.applyRemote(text);
      lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
      send('clipboard-received', deviceId);
    }
  }

  function handleClipboardFilePacket(deviceId: string, packet: any) {
    if (!isEnabled('Clipboard')) return;
    (async () => {
      const senderHost = deviceManager.remoteAddressOf(deviceId);
      const expectedFingerprint = deviceManager.pinnedFingerprintOf(deviceId);
      if (!senderHost || !expectedFingerprint) return;
      try {
        const transferInfo = packet.payloadTransferInfo as { port: number } | undefined;
        if (!transferInfo || typeof transferInfo.port !== 'number') {
          throw new Error('clipboard.file packet missing port');
        }
        const filename = (packet.body as { filename: string }).filename;
        const data = await downloadPayload(senderHost, transferInfo.port, deviceManager.myCert, deviceManager.myKey, expectedFingerprint);
        clipboardWatcher.applyRemoteFile(filename, data);
        console.log(`[Link] CLIPBOARD FILE RECEIVED: ${filename} (${data.length} bytes)`);
        send('clipboard-received', deviceId);
      } catch (err) {
        console.error('[Link] Failed to receive clipboard file:', err);
      }
    })();
  }

  function handleBatteryPacket(deviceId: string, packet: any) {
    const body = packet.body as { isCharging: boolean; currentCharge: number };
    send('battery-received', deviceId, body.isCharging, body.currentCharge);
  }

  function handleFindMyPhonePacket(deviceId: string, packet: any) {
    // No kill-switch or per-device permission gate — ring is inherently available to any
    // connected, trusted device, same as rename.
    const body = packet.body as { cancel?: boolean };
    if (body && body.cancel) {
      stopRinging();
      if (ringTimeoutMain) {
        clearTimeout(ringTimeoutMain);
        ringTimeoutMain = null;
      }
      activeRingerDeviceId = null;
      send('find-my-phone-stopped', deviceId);
    } else {
      activeRingerDeviceId = deviceId;
      ringThisDevice();
      send('find-my-phone-triggered', deviceId);

      if (ringTimeoutMain) clearTimeout(ringTimeoutMain);
      ringTimeoutMain = setTimeout(() => {
        if (activeRingerDeviceId) {
          deviceManager.sendTo(activeRingerDeviceId, createFindMyPhonePacket(true));
          send('find-my-phone-stopped', activeRingerDeviceId);
          activeRingerDeviceId = null;
        }
      }, 60000);
    }
  }

  function handleRunCommandRequestPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'runcommand')) {
      console.log(`[Link] Blocked Run Command request from ${deviceId} (Permission disabled)`);
      return;
    }
    const response = runCommandManager.handleRunCommandRequest(packet);
    if (response) deviceManager.sendTo(deviceId, response);
    const body = packet.body as { key?: string };
    if (body.key) send('run-command-triggered', deviceId, body.key);
  }

  function handleRunCommandListPacket(deviceId: string, packet: any) {
    // Incoming FROM a peer — we're the requester here (mesh case: viewing a paired desktop's
    // panel from either a desktop or mobile app). Distinct from the handler above, where we're
    // the executor serving our OWN list to a peer.
    const body = packet.body as { commandList: string };
    try {
      const list = JSON.parse(body.commandList);
      peerCommandLists.set(deviceId, list);
      send('command-list-received', deviceId, list);
    } catch (err) {
      console.error('[Link] Failed to parse peer command list:', err);
    }
  }

  function handlePresenterPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'presenter')) {
      console.log(`[Link] Blocked Presenter packet from ${deviceId} (Permission disabled)`);
      return;
    }
    if (isPresenterStopPacket(packet)) {
      hidePresenterDot();
    } else {
      const body = packet.body as { dx: number; dy: number };
      showPresenterDot(body.dx, body.dy);
    }
  }

  function handleSystemVolumeRequestPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'systemvolume')) {
      console.log(`[Link] Blocked System Volume request from ${deviceId} (Permission disabled)`);
      return;
    }
    (async () => {
      const result = await handleSystemVolumeRequest(packet);
      if (result) deviceManager.sendTo(deviceId, createSystemVolumePacket(result));
    })();
  }

  function handleSystemVolumePacket(deviceId: string, packet: any) {
    mainWindow?.webContents.send('system-volume-received', deviceId, packet.body);
  }

  function handleLockRequestPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'lock')) {
      console.log(`[Link] Blocked Lock request from ${deviceId} (Permission disabled)`);
      return;
    }
    const body = packet.body as { setLocked?: boolean; requestLocked?: boolean };
    if (body.setLocked) {
      lockThisDevice().then((success) => {
        deviceManager.sendTo(deviceId, createLockPacket(isLocalDeviceLocked(), success));
      });
    } else {
      // Either an explicit status query, or (defensively) a setLocked:false "unlock" request —
      // no mainstream OS exposes a way to unlock a screen without the user's real credentials,
      // so there is nothing to do for that case. Always reply with the REAL current state
      // instead of silently ignoring it, which previously left the requester's optimistic
      // "unlocked" UI permanently stuck out of sync since no reply ever arrived to correct it.
      deviceManager.sendTo(deviceId, createLockPacket(isLocalDeviceLocked()));
    }
  }

  function handleLockPacket(deviceId: string, packet: any) {
    const body = packet.body as { isLocked?: boolean; lockResult?: boolean };
    if (body.isLocked !== undefined) {
      send('lock-state-received', deviceId, body.isLocked);
    }
    if (body.lockResult !== undefined) {
      send('lock-result-received', deviceId, body.lockResult);
    }
  }

  function handleFlashlightPacket(deviceId: string, packet: any) {
    // Pure incoming state display, not an executable command (desktop has no flashlight to
    // control) — the sender already gates whether they broadcast this to us at all, matching
    // how system volume/MPRIS state receipt isn't re-checked here either. `revoked` is a
    // silent marker the sender sets when our permission just got turned off on their end — it
    // tells the renderer to clear its cached state instead of displaying stale data forever.
    const flashlightBody = packet.body as { enabled: boolean; revoked?: boolean };
    send('flashlight-state-received', deviceId, flashlightBody.enabled, !!flashlightBody.revoked);
  }

  function handleDNDPacket(deviceId: string, packet: any) {
    const dndBody = packet.body as { enabled: boolean; granted?: boolean; revoked?: boolean };
    send('dnd-state-received', deviceId, dndBody.enabled, dndBody.granted, !!dndBody.revoked);
  }

  function handleCapabilitiesPacket(deviceId: string, packet: any) {
    // Unified per-peer signal: exactly which of the peer's gated capabilities we're currently
    // allowed to use. The renderer gates every button/section on membership in this list —
    // no per-plugin revoke marker needed, since a key's absence hides it regardless of whatever
    // stale value is still cached from before.
    const body = packet.body as { capabilities: string[] };
    const caps = body.capabilities || [];
    peerCapabilities.set(deviceId, caps); // cache for renderer-reload re-hydration (see map decl)
    send('peer-capabilities-received', deviceId, caps);
  }

  function handleRenameRequestPacket(deviceId: string, packet: any) {
    // Rename isn't gated by the test.txt kill-switch — it's inherently available on any valid
    // connection, not an optional plugin. A peer asked US to rename ourselves. Device names are self-owned (matches the identity
    // model), so apply it locally and then broadcast the authoritative result to every
    // connected peer — including back to the requester — instead of letting a remote device
    // silently overwrite our identity without us re-announcing it.
    const requestedName = saveDeviceName(configDir, packet.body.deviceName);
    identity.deviceName = requestedName;
    send('own-device-renamed', requestedName);
    const renamePacket = createRenamePacket(requestedName);
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      deviceManager.sendTo(peerId, renamePacket);
    }
  }

  function handleRenamePacket(deviceId: string, packet: any) {
    // Authoritative name change from a peer (either it renamed itself locally, or it just
    // accepted a rename request from us or someone else) — sync our local trust-store alias
    // and reflect it live without needing a reconnect.
    deviceManager.trustStore.rename(deviceId, packet.body.deviceName);
    send('device-renamed', deviceId, packet.body.deviceName);
  }

  function handleConnectivityPacket(deviceId: string, packet: any) {
    const body = packet.body as ConnectivityBody;
    send('connectivity-received', deviceId, body.signalStrengths);
  }

  function handleTouchpadRequestPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'touchpad')) return;
    touchpadHandler.handleRequest(packet);
  }

  function handleDigitizerSessionPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'digitizer')) return;
    digitizerHandler.handleSession(packet);
  }

  function handleDigitizerPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'digitizer')) return;
    digitizerHandler.handleEvent(packet);
  }

  function handleMprisStatePacket(deviceId: string, packet: any) {
    send('mpris-state-received', deviceId, packet.body);
  }

  function handleMprisRequestPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'mpris')) {
      console.log(`[Link] Blocked MPRIS request from ${deviceId} (Permission disabled)`);
      return;
    }
    const body = packet.body as MprisRequest;
    (async () => {
      if (body.action) {
        await controlMpris(body.player || '', body.action);
      }
      const sessions = await queryMprisSessions();
      const statePacket = createMprisStatePacket(sessions);
      // Outbound gate — a peer denied 'mpris' shouldn't passively learn what's currently playing
      // just because someone else (permitted) triggered this broadcast.
      broadcastToPermittedPeers('mpris', statePacket);
    })();
  }

  function handleTelephonyPacket(deviceId: string, packet: any) {
    // No receive-side gate — Telephony is owned by the sending phone, which already decided
    // (via its own outbound permission-for-us) whether to share this. Desktop never gets its
    // own say; it's a pure display, same as Flashlight/DND's receive side.
    const body = packet.body as TelephonyBody;
    const isCancel = body.isCancel === 'true' || body.isCancel === true;

    (async () => {
      const sessions = await queryMprisSessions();
      const isAnyPlaying = sessions.some(s => s.isPlaying);
      const pauseMusicAction = pauseMusicController.onCallStateChanged(body.event, isCancel, isAnyPlaying);
      if (pauseMusicAction) {
        const action = pauseMusicAction === 'pause' ? 'Pause' : 'Play';
        await controlMpris('', action);
        const updatedSessions = await queryMprisSessions();
        const statePacket = createMprisStatePacket(updatedSessions);
        broadcastToPermittedPeers('mpris', statePacket);
      }
    })();

    if (isCancel || body.event === 'cancelled') {
      const active = activeNotifications.get(deviceId);
      if (active) {
        active.close();
        activeNotifications.delete(deviceId);
      }
    }

    if (!isCancel) {
      // Never the Link app icon here — it would misleadingly imply the notification is about
      // the app itself rather than a phone call. Prefer the caller's real contact photo (sent
      // by the phone when it resolved one), falling back to a generic call glyph.
      let callIcon = callIconImg;
      if (body.iconBase64) {
        try {
          const decoded = nativeImage.createFromBuffer(Buffer.from(body.iconBase64, 'base64'));
          if (!decoded.isEmpty()) callIcon = decoded;
        } catch {
          // Malformed icon data from the peer — fall back to the generic call icon.
        }
      }

      if (body.event === 'ringing') {
        const active = activeNotifications.get(deviceId);
        if (active) active.close();

        const name = body.contactName || body.phoneNumber || 'Unknown Caller';
        const details = body.phoneNumber ? `Ringing: ${body.phoneNumber}` : 'Incoming Call';
        const notification = new Notification({
          title: name,
          body: details,
          silent: false,
          timeoutType: 'never',
          icon: callIcon,
        });
        notification.show();
        activeNotifications.set(deviceId, notification);
      } else if (body.event === 'talking') {
        // Answered — was previously just closing the ringing notification here with no
        // replacement, so picking up the call gave no feedback at all. Swap it for an ongoing
        // "on call" notification instead; only 'cancelled'/isCancel above removes it now.
        const active = activeNotifications.get(deviceId);
        if (active) active.close();

        const name = body.contactName || body.phoneNumber || 'Unknown Caller';
        const details = body.phoneNumber ? `On call — ${body.phoneNumber}` : 'On call';
        const notification = new Notification({
          title: name,
          body: details,
          silent: true,
          timeoutType: 'never',
          icon: callIcon,
        });
        notification.show();
        activeNotifications.set(deviceId, notification);
      } else if (body.event === 'missedCall') {
        const name = body.contactName || body.phoneNumber || 'Unknown Caller';
        const details = body.phoneNumber ? `Missed call from: ${body.phoneNumber}` : 'Missed Call';
        new Notification({
          title: name,
          body: details,
          silent: false,
          icon: callIcon,
        }).show();
      }
    }
  }

  function handleNotificationPacket(deviceId: string, packet: any) {
    // No receive-side gate — same reasoning as Telephony above: the sending phone already
    // decided whether to share this via its own outbound permission-for-us.
    const body = packet.body as NotificationBody;
    console.log('[Link] Received notification packet:', body);
    const isCancel = body.isCancel === 'true' || body.isCancel === true;
    const key = `${deviceId}|${body.id}`;

    if (isCancel) {
      send('notification-cancelled', deviceId, body.id);
      const active = activeAppNotifications.get(key);
      if (active) {
        active.close();
        activeAppNotifications.delete(key);
      }
    } else {
      send('notification-received', deviceId, body);
      const active = activeAppNotifications.get(key);
      if (active) active.close();

      const title = body.title || body.appName || 'Notification';
      const text = body.text || body.ticker || '';
      const subtitle = body.title ? body.appName : undefined;

      // Prefer the originating app's own icon (e.g. WhatsApp's icon) when the phone sent one,
      // falling back to the Link app icon if it didn't resolve one.
      let notificationIcon = appIconImg;
      if (body.iconBase64) {
        try {
          const decoded = nativeImage.createFromBuffer(Buffer.from(body.iconBase64, 'base64'));
          if (!decoded.isEmpty()) notificationIcon = decoded;
        } catch {
          // Malformed icon data from the peer — fall back to the app icon rather than failing
          // to show the notification at all.
        }
      }

      const notification = new Notification({
        title,
        subtitle,
        body: text,
        silent: body.silent || false,
        icon: notificationIcon,
      });
      notification.show();
      activeAppNotifications.set(key, notification);
    }
  }

  function handleFsRequestPacket(deviceId: string, packet: any) {
    if (!checkDevicePermission(deviceId, 'fileaccess')) {
      deviceManager.sendTo(deviceId, createPacket('link.fs.response', {
        requestId: (packet.body as any).requestId,
        success: false,
        error: 'Permission denied: File access is disabled.',
      }));
      return;
    }
    const body = packet.body as any;
    (async () => {
      try {
        const result = await handleFsRequest(body);
        deviceManager.sendTo(deviceId, createPacket('link.fs.response', {
          requestId: body.requestId,
          success: true,
          result,
        }));
      } catch (err: any) {
        deviceManager.sendTo(deviceId, createPacket('link.fs.response', {
          requestId: body.requestId,
          success: false,
          error: err.message,
        }));
      }
    })();
  }

  function handleFsResponsePacket(deviceId: string, packet: any) {
    const client = socketFsClients.get(deviceId);
    if (client) {
      client.handleResponsePacket(packet);
    }
  }

  deviceManager.on('packet', (deviceId, packet) => {
    if (packet.type === 'link.resync.request') {
      // The peer's UI just (re)loaded and is asking us to re-push our full current state so its
      // sections repopulate immediately, instead of waiting ~10s for our next periodic broadcast.
      // The reciprocal of resync-devices below — see its comment for the whole picture.
      sendInitialSync(deviceId);
      return;
    }
    if (packet.type === 'link.target.display') {
      // Phone's presenter/digitizer "Switch Screen" button — cycle which monitor the absolute-
      // positioned features target. Gated by the same permissions as those features' input.
      if (checkDevicePermission(deviceId, 'presenter') || checkDevicePermission(deviceId, 'digitizer')) {
        cycleTargetDisplay();
      }
      return;
    }
    if (isClipboardPacket(packet)) {
      handleClipboardTextPacket(deviceId, packet);
    } else if (packet.type === 'link.clipboard.file') {
      handleClipboardFilePacket(deviceId, packet);
    } else if (isBatteryPacket(packet)) {
      handleBatteryPacket(deviceId, packet);
    } else if (isFindMyPhonePacket(packet)) {
      handleFindMyPhonePacket(deviceId, packet);
    } else if (isRunCommandRequestPacket(packet)) {
      handleRunCommandRequestPacket(deviceId, packet);
    } else if (isRunCommandListPacket(packet)) {
      handleRunCommandListPacket(deviceId, packet);
    } else if (isPresenterPacket(packet)) {
      handlePresenterPacket(deviceId, packet);
    } else if (isSystemVolumeRequestPacket(packet)) {
      handleSystemVolumeRequestPacket(deviceId, packet);
    } else if (isSystemVolumePacket(packet)) {
      handleSystemVolumePacket(deviceId, packet);
    } else if (isLockRequestPacket(packet)) {
      handleLockRequestPacket(deviceId, packet);
    } else if (isLockPacket(packet)) {
      handleLockPacket(deviceId, packet);
    } else if (isFlashlightPacket(packet)) {
      handleFlashlightPacket(deviceId, packet);
    } else if (isDNDPacket(packet)) {
      handleDNDPacket(deviceId, packet);
    } else if (isCapabilitiesPacket(packet)) {
      handleCapabilitiesPacket(deviceId, packet);
    } else if (isRenameRequestPacket(packet)) {
      handleRenameRequestPacket(deviceId, packet);
    } else if (isRenamePacket(packet)) {
      handleRenamePacket(deviceId, packet);
    } else if (isConnectivityPacket(packet)) {
      handleConnectivityPacket(deviceId, packet);
    } else if (isTouchpadRequestPacket(packet)) {
      handleTouchpadRequestPacket(deviceId, packet);
    } else if (isDigitizerSessionPacket(packet)) {
      handleDigitizerSessionPacket(deviceId, packet);
    } else if (isDigitizerPacket(packet)) {
      handleDigitizerPacket(deviceId, packet);
    } else if (packet.type === 'link.mpris') {
      handleMprisStatePacket(deviceId, packet);
    } else if (isMprisRequestPacket(packet)) {
      handleMprisRequestPacket(deviceId, packet);
    } else if (isTelephonyPacket(packet)) {
      handleTelephonyPacket(deviceId, packet);
    } else if (isNotificationPacket(packet)) {
      handleNotificationPacket(deviceId, packet);
    } else if (packet.type === 'link.fs.request') {
      handleFsRequestPacket(deviceId, packet);
    } else if (packet.type === 'link.fs.response') {
      handleFsResponsePacket(deviceId, packet);
    } else if (packet.type === 'link.speedtest.request') {
      speedTestManager.handleIncomingRequest(packet, deviceId);
    } else if (packet.type === 'link.speedtest.response') {
      speedTestManager.handleResponse(packet);
    } else if (packet.type === 'link.audiorelay.started') {
      // Resolve the host's IP here, main-process-side — this is the one place it's actually
      // known (deviceManager.remoteAddressOf); the renderer only ever gets a deviceId otherwise.
      const host = deviceManager.remoteAddressOf(deviceId);
      if (host) send('audio-relay-paired-session-started', deviceId, packet.body.token, host);
    } else if (packet.type === 'link.audiorelay.ended') {
      send('audio-relay-paired-session-ended', deviceId);
    } else if (packet.type === 'link.audiorelay.query') {
      // A peer asking "are you currently hosting?" — sent when their Audio Relay tab opens, so a
      // session that started before they were connected/looking doesn't just get silently missed
      // (the original 'started' broadcast only ever reaches whoever was connected AND had the
      // tab open at that exact moment — no way to catch up otherwise). Answer with the exact same
      // 'started' packet + a freshly minted token, reusing the normal path one level up.
      if (audioRelayServer && checkDevicePermission(deviceId, 'audiorelay')) {
        const token = audioRelayServer.issueToken(deviceId);
        deviceManager.sendTo(deviceId, createPacket('link.audiorelay.started', { token, port: AUDIO_RELAY_PORT }));
      }
    } else if (packet.type === 'link.remotemic.started') {
      const host = deviceManager.remoteAddressOf(deviceId);
      if (host) send('remote-mic-paired-session-started', deviceId, packet.body.token, host);
    } else if (packet.type === 'link.remotemic.ended') {
      send('remote-mic-paired-session-ended', deviceId);
    } else if (packet.type === 'link.remotemic.query') {
      // Since desktop is purely the listener in this remote mic feature (no desktop mic hosting built yet),
      // we don't have to reply to link.remotemic.query packets from peers.
    }
  });

  clipboardWatcher = new ClipboardWatcher(async (type, data) => {
    lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
    if (!isEnabled('Clipboard')) return;
    if (type === 'text') {
      const content = data as string;
      broadcastToPermittedPeers('clipboard', createClipboardPacket(content));
    } else {
      const fileData = data as { filename: string; buffer: Buffer };
      try {
        const upload = await startPayloadUpload(deviceManager.myCert, deviceManager.myKey, fileData.buffer);
        const packet = createPacket('link.clipboard.file', { filename: fileData.filename });
        packet.payloadTransferInfo = upload.info as any;
        broadcastToPermittedPeers('clipboard', packet);
      } catch (err) {
        console.error('[Link] Failed to upload clipboard file:', err);
      }
    }
  });

  batteryWatcher = new BatteryWatcher(({ isCharging, currentCharge }) => {
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      deviceManager.sendTo(peerId, createBatteryPacket(isCharging, currentCharge));
    }
  });

  volumeWatcher = new VolumeWatcher((sinks) => {
    // Outbound gate — a peer denied 'systemvolume' shouldn't passively see live sink/volume
    // levels just because they're connected.
    broadcastToPermittedPeers('systemvolume', createSystemVolumePacket(sinks));
  });

  // Reflect real OS lock/unlock state in real time (not just Link-triggered locks), matching
  // the volume watcher's model: detect actual state changes and push to every connected peer.
  powerMonitor.on('lock-screen', () => {
    setLocalLockedState(true);
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      deviceManager.sendTo(peerId, createLockPacket(true));
    }
  });
  powerMonitor.on('unlock-screen', () => {
    setLocalLockedState(false);
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      deviceManager.sendTo(peerId, createLockPacket(false));
    }
  });

  return identity;
}

// Use the .ico (not icon.png) so Windows picks pre-rendered, legible frames for the title
// bar/taskbar sizes instead of live-downscaling the detailed 512px glow artwork, which turns to
// mush at 16-32px. Loaded once at module scope so it can also be attached to Notification()
// calls below — Windows toast notifications need an explicit `icon` on each notification; they
// do NOT reliably inherit the app/window icon or AppUserModelID in dev mode (that lookup only
// works for apps with a registered Start Menu shortcut), so without this they fall back to a
// generic/Electron icon regardless of what the window/taskbar icon is set to.
const appIconPath = process.platform === 'win32'
  ? path.join(__dirname, '../../icon.ico')
  : path.join(__dirname, '../../icon.png');
const appIconImg = nativeImage.createFromPath(appIconPath);

// Generic call-icon for incoming/missed-call notifications — showing the Link app logo there
// would misleadingly imply the notification is about the app itself rather than a phone call.
// Used as the fallback when the peer didn't resolve a contact photo for this caller.
const callIconImg = nativeImage.createFromPath(path.join(__dirname, '../../call-icon.png'));

function createWindow() {
  const iconImg = appIconImg;
  console.log('[Link] appPath:', app.getAppPath());
  console.log('[Link] iconPath:', appIconPath);
  console.log('[Link] icon file exists:', fs.existsSync(appIconPath));
  console.log('[Link] iconImg empty:', iconImg.isEmpty());

  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    icon: iconImg,
    webPreferences: {
      preload: path.join(__dirname, '../main/preload.js'),
    },
  });
  mainWindow.setMenu(null);
  mainWindow.setIcon(iconImg);

  // Close-to-tray: intercept the window's close and hide it instead of quitting, unless the user
  // is doing a real quit (tray "Quit" / app.quit) or the preference is off. Keeps the background
  // mesh connections alive, matching how Spotify/Discord behave.
  mainWindow.on('close', (e) => {
    if (closeToTray && !isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
      if (tray && !hasShownTrayBalloon && process.platform === 'win32') {
        hasShownTrayBalloon = true;
        try {
          tray.displayBalloon({ title: 'Link is still running', content: 'Link keeps your devices connected from the tray. Right-click the tray icon to quit.' });
        } catch { /* balloons unsupported on this platform/build */ }
      }
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
        mainWindow?.reload();
        event.preventDefault();
      }
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        mainWindow?.webContents.toggleDevTools();
        event.preventDefault();
      }
    }
  });

  if (process.argv.includes('--dev')) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
    mainWindow.webContents.on('did-fail-load', () => {
      setTimeout(() => {
        mainWindow?.loadURL('http://localhost:5173');
      }, 500);
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/** Bring the main window back from the tray (or rebuild it if it was fully closed). */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Create the system-tray icon + menu once. Clicking it reopens the window; Quit does a real quit. */
function createTray() {
  if (tray) return;
  try {
    const trayIcon = appIconImg.isEmpty() ? appIconImg : appIconImg.resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    tray.setToolTip('Link');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Link', click: () => showMainWindow() },
      { type: 'separator' },
      { label: 'Quit Link', click: () => { isQuitting = true; app.quit(); } },
    ]));
    // Left-click (Windows) / click the icon to reopen — the expected tray affordance.
    tray.on('click', () => showMainWindow());
  } catch (err) {
    console.error('[Link] Failed to create tray:', err);
  }
}

// Windows caches the taskbar icon by executable path. In dev mode every Electron project on
// this machine launches the exact same node_modules/electron/dist/electron.exe, so without a
// distinct identity Windows can show a stale/generic icon cached from another app's run. Setting
// our own AppUserModelID (matching package.json's build.appId) gives this app's taskbar entry
// its own identity instead of bucketing it under bare "electron.exe".
if (process.platform === 'win32') {
  app.setAppUserModelId('in.rodix.link');
}

app.whenReady().then(() => {
  console.log('[Link] app ready, initializing core...');
  const identity = initCore();
  console.log('[Link] identity:', identity);

  // ===== Identity & Device Discovery =====
  ipcMain.handle('get-identity', () => {
    return {
      ...identity,
      ipAddress: getLocalIpAddress(),
    };
  });

  ipcMain.handle('get-trusted-devices', () => {
    try {
      return deviceManager.trustStore.list().map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        deviceType: 'phone', // default fallback, updated dynamically on connection
        trusted: true,
        connected: false,
      }));
    } catch (err) {
      console.error('[Link] Failed to list trusted devices:', err);
      return [];
    }
  });

  // Real current connection state — see DeviceManager.connectedPeers()'s comment for why the
  // renderer needs this in addition to get-trusted-devices (which always reports connected:false).
  // Flattened to match get-trusted-devices' shape (the renderer expects deviceId etc. at the top
  // level, not nested under an `identity` wrapper).
  ipcMain.handle('get-connected-devices', () => {
    return deviceManager.connectedPeers().map(({ identity, trusted }) => ({
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      deviceType: identity.deviceType,
      incomingCapabilities: identity.incomingCapabilities,
      outgoingCapabilities: identity.outgoingCapabilities,
      // Re-hydrate the peer's effective capabilities from the main-process cache so a renderer
      // reload restores gated-plugin visibility without waiting for the peer to re-push.
      allowedCapabilities: peerCapabilities.get(identity.deviceId) || [],
      trusted,
    }));
  });

  // Re-runs the full initial-sync push (clipboard, battery, connectivity, volume, lock, MPRIS,
  // run command list) for every currently-connected trusted peer. sendInitialSync()
  // only ever fires once, at the moment a TCP connection is established — a renderer reload
  // (F5/Ctrl+R) wipes all that data from the UI's in-memory state without the connection itself
  // dropping, so nothing re-populates it until some unrelated future change happens to broadcast
  // again. Calling this on renderer mount closes that gap.
  ipcMain.handle('resync-devices', () => {
    for (const deviceId of deviceManager.trustedConnectedDeviceIds()) {
      // Push OUR state to the peer (refreshes their view of us)...
      sendInitialSync(deviceId);
      // ...and PULL theirs: ask the peer to re-push its full state to us, so a reload repopulates
      // the peer's battery/volume/MPRIS/connectivity sections in one round-trip instead of
      // trickling in over ~10s as their periodic broadcasts happen to fire. The peer answers this
      // by running its own sendInitialSync toward us (see the 'link.resync.request' packet case).
      deviceManager.sendTo(deviceId, createPacket('link.resync.request', {}));
    }
  });

  ipcMain.handle('open-app-settings', () => {
    return Promise.resolve(); // Stub resolved immediately on desktop
  });

  // ===== Permissions =====
  ipcMain.handle('get-permissions', () => {
    return getAllPermissions();
  });

  ipcMain.handle('set-permissions', (_e, permissions: any) => {
    try {
      const oldPermissions = getAllPermissions();
      writeAllPermissions(permissions);

      // Push the peer's updated effective-capabilities list first — this alone is what drives
      // visibility (see computeEffectiveCapabilities/pushEffectiveCapabilities): the renderer
      // hides a section the instant a key is absent from this list, regardless of any stale
      // value it still has cached from before. No per-plugin "revoked" marker needed anymore.
      // Separately, still push a fresh REAL state snapshot when systemvolume/mpris just flipped
      // ON — sendInitialSync only ever runs once at connection time, so without this a peer
      // granted access mid-session would see the section appear but empty until some unrelated
      // future state change happened to broadcast again.
      // checkDevicePermission() defaults to allowed when unset, so "was/now allowed" must use the
      // same !== false test, not === true, or a permission that was never explicitly set would
      // incorrectly register as an on/off transition.
      for (const deviceId of Object.keys(permissions)) {
        if (!deviceManager.trustedConnectedDeviceIds().includes(deviceId)) continue;
        pushEffectiveCapabilities(deviceId);

        const oldPerm = oldPermissions[deviceId] || {};
        const newPerm = permissions[deviceId] || {};

        const volumeWasAllowed = oldPerm.systemvolume !== false;
        const volumeNowAllowed = newPerm.systemvolume !== false;
        if (volumeNowAllowed && !volumeWasAllowed) {
          const volumeSnapshot = volumeWatcher.current();
          if (volumeSnapshot && volumeSnapshot.length > 0) {
            deviceManager.sendTo(deviceId, createSystemVolumePacket(volumeSnapshot));
          }
        }

        const mprisWasAllowed = oldPerm.mpris !== false;
        const mprisNowAllowed = newPerm.mpris !== false;
        if (mprisNowAllowed && !mprisWasAllowed) {
          queryMprisSessions().then((sessions) => {
            deviceManager.sendTo(deviceId, createMprisStatePacket(sessions));
          }).catch(() => {});
        }

        // fileaccess controls what THAT peer can do to THIS device (see doctrine note on
        // mountFilesystemForDevice) — but the mount itself is symmetric: this device is also
        // acting as a client of the peer's fs server, and the peer's own executor-side check
        // (handleFsRequestPacket / LinkFsServer.checkPermission) already enforces the real
        // security boundary per-request. This is purely about UX: don't leave a mounted drive
        // sitting there silently failing every operation once access is revoked, and don't make
        // the user reconnect just to pick up a freshly granted permission.
        const fileaccessWasAllowed = oldPerm.fileaccess !== false;
        const fileaccessNowAllowed = newPerm.fileaccess !== false;
        if (!fileaccessNowAllowed && fileaccessWasAllowed) {
          const mountService = fsMountServices.get(deviceId);
          if (mountService) {
            mountService.unmount();
            fsMountServices.delete(deviceId);
            console.log(`[Link] Unmounted filesystem for ${deviceId} — fileaccess revoked.`);
          }
          const fsClient = fsClients.get(deviceId);
          if (fsClient) {
            fsClient.disconnect();
            fsClients.delete(deviceId);
          }
          socketFsClients.delete(deviceId);
        } else if (fileaccessNowAllowed && !fileaccessWasAllowed) {
          const peer = deviceManager.connectedPeers().find((p) => p.identity.deviceId === deviceId);
          const host = deviceManager.remoteAddressOf(deviceId);
          if (peer && host) {
            mountFilesystemForDevice(peer.identity, host);
          }
        }
      }

      return true;
    } catch (err) {
      console.error('[Link] Failed to write permissions:', err);
      return false;
    }
  });

  // ===== App Settings (visibility, pause-music, screensaver-inhibit, open-at-login) =====
  ipcMain.handle('get-visibility', () => visibilityEnabled);
  ipcMain.handle('set-visibility', (_e, enabled: boolean) => {
    visibilityEnabled = enabled;
    discoveryService?.setVisibility(enabled);
    saveSetting(configDir, 'discovery-settings.json', 'visibilityEnabled', enabled);
  });

  ipcMain.handle('get-close-to-tray', () => closeToTray);
  ipcMain.handle('set-close-to-tray', (_e, enabled: boolean) => {
    closeToTray = enabled;
    saveSetting(configDir, 'tray-settings.json', 'closeToTray', enabled);
  });

  ipcMain.handle('get-pause-music-enabled', () => {
    return pauseMusicController.isEnabled();
  });
  ipcMain.handle('set-pause-music-enabled', (_e, enabled: boolean) => {
    pauseMusicController.setEnabled(enabled);
    saveSetting(configDir, 'pause-music-settings.json', 'pauseMusicEnabled', enabled);
  });

  ipcMain.handle('get-screensaver-inhibit-enabled', () => screensaverInhibitEnabled);
  ipcMain.handle('set-screensaver-inhibit-enabled', (_e, enabled: boolean) => {
    screensaverInhibitEnabled = enabled;
    updateScreensaverInhibition();
    saveSetting(configDir, 'screensaver-inhibit-settings.json', 'screensaverInhibitEnabled', enabled);
  });

  // Electron's own login-item registration handles OS-level persistence (registry on Windows) —
  // no need for our own config file, unlike the settings above.
  ipcMain.handle('get-open-at-login', () => {
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('set-open-at-login', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
  });

  // ===== Pairing & Connection =====
  ipcMain.handle('connect-to', async (_e, host: string, port?: number) => {
    await deviceManager.connectTo(host, port ?? LINK_PORT);
  });

  ipcMain.handle('request-pairing', (_e, deviceId: string) => {
    return deviceManager.requestPairing(deviceId);
  });
  ipcMain.handle('accept-pairing', (_e, deviceId: string) => {
    deviceManager.acceptPairing(deviceId);
  });
  ipcMain.handle('reject-pairing', (_e, deviceId: string) => {
    deviceManager.rejectPairing(deviceId);
  });
  ipcMain.handle('unpair', (_e, deviceId: string) => {
    deviceManager.unpair(deviceId);
  });
  // Trusted Pool (Wave 2): removing a device owner-signs + gossips a revocation so it's dropped
  // pool-wide (falls back to a plain unpair if this device isn't in a pool). Exit leaves the pool.
  ipcMain.handle('remove-from-pool', (_e, deviceId: string) => {
    deviceManager.removeFromPool(deviceId);
  });
  ipcMain.handle('exit-pool', () => {
    deviceManager.exitPool();
  });

  ipcMain.handle('run-speed-test', async (_e, deviceId: string) => {
    return speedTestManager.runSpeedTest(deviceId, (progressMsg) => {
      mainWindow?.webContents.send('speed-test-progress', deviceId, progressMsg);
    });
  });

  // ===== Ring / Find My Phone =====
  ipcMain.handle('send-find-my-phone', (_e, deviceId: string) => {
    deviceManager.sendTo(deviceId, createFindMyPhonePacket(false));
  });

  ipcMain.handle('send-stop-ringing', (_e, deviceId: string) => {
    deviceManager.sendTo(deviceId, createFindMyPhonePacket(true));
  });

  ipcMain.handle('stop-ringing-local', () => {
    stopRinging();
    if (ringTimeoutMain) {
      clearTimeout(ringTimeoutMain);
      ringTimeoutMain = null;
    }
    if (activeRingerDeviceId) {
      deviceManager.sendTo(activeRingerDeviceId, createFindMyPhonePacket(true));
      send('find-my-phone-stopped', activeRingerDeviceId);
      activeRingerDeviceId = null;
    }
  });


  // ===== Rename =====
  ipcMain.handle('rename-device', (_e, newName: string) => {
    const filtered = saveDeviceName(configDir, newName);
    identity.deviceName = filtered;
    // Broadcast our new authoritative name to every currently-connected peer so their view of
    // us updates live instead of waiting for their next reconnect/handshake. Not gated by the
    // test.txt kill-switch — rename is inherently available on any valid connection.
    const renamePacket = createRenamePacket(filtered);
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      deviceManager.sendTo(peerId, renamePacket);
    }
    return filtered;
  });

  ipcMain.handle('rename-trusted-device', (_e, deviceId: string, newName: string) => {
    // Device names are self-owned — renaming a peer sends it a REQUEST rather than editing our
    // local alias directly. The peer applies it to itself and broadcasts the authoritative
    // result back (handled by isRenamePacket above), which is what actually updates our trust
    // store. This only works while the peer is reachable; there is no queued/offline rename.
    if (!deviceManager.trustedConnectedDeviceIds().includes(deviceId)) {
      throw new Error('Device must be connected to be renamed');
    }
    deviceManager.sendTo(deviceId, createRenameRequestPacket(newName));
    return true;
  });

  // ===== Lock =====
  ipcMain.handle('send-lock-request', (_e, deviceId: string, setLocked: boolean) => {
    deviceManager.sendTo(deviceId, createLockRequestPacket(setLocked));
  });

  // Separate from send-lock-request: no OS exposes a way to remotely unlock a screen without
  // real credentials, so there is no "unlock" action to send — only a status query, used to
  // refresh/reconcile the UI's lock indicator against the peer's real current state.
  ipcMain.handle('send-lock-status-request', (_e, deviceId: string) => {
    deviceManager.sendTo(deviceId, createLockRequestPacket(undefined, true));
  });

  // ===== Volume =====
  ipcMain.handle('send-set-volume', (_e, deviceId: string, sinkName: string, volume: number) => {
    deviceManager.sendTo(deviceId, createSetVolumeRequestPacket(sinkName, volume));
  });

  ipcMain.handle('send-set-mute', (_e, deviceId: string, sinkName: string, muted: boolean) => {
    deviceManager.sendTo(deviceId, createSetMuteRequestPacket(sinkName, muted));
  });

  // ===== Flashlight / DND =====
  ipcMain.handle('send-flashlight-toggle', (_e, deviceId: string, enabled: boolean) => {
    deviceManager.sendTo(deviceId, createFlashlightPacket(enabled));
  });

  ipcMain.handle('send-dnd-set', (_e, deviceId: string, enabled: boolean) => {
    deviceManager.sendTo(deviceId, createDNDPacket(enabled));
  });

  // ===== Media (MPRIS) =====
  ipcMain.handle('send-mpris-action', (_e, deviceId: string, player: string, action: string) => {
    deviceManager.sendTo(deviceId, createPacket('link.mpris.request', { player, action }));
  });

  // ===== Notifications =====
  ipcMain.handle('send-notification-reply', (_e, deviceId: string, replyId: string, message: string) => {
    deviceManager.sendTo(deviceId, createPacket('link.notification.reply', {
      requestReplyId: replyId,
      message
    }));
  });

  // ===== Run Command =====
  ipcMain.handle('get-commands', () => {
    return runCommandManager.getCommands();
  });

  ipcMain.handle('set-command', (_e, key: string, entry: CommandEntry) => {
    runCommandManager.setCommand(key, entry);
    broadcastToPermittedPeers('runcommand', runCommandManager.createCommandListPacket());
    return runCommandManager.getCommands();
  });

  ipcMain.handle('remove-command', (_e, key: string) => {
    runCommandManager.removeCommand(key);
    broadcastToPermittedPeers('runcommand', runCommandManager.createCommandListPacket());
    return runCommandManager.getCommands();
  });

  // Trigger a command on a peer's whitelist (we're the requester here — mesh case: viewing a
  // paired desktop's control panel from either a desktop or mobile app).
  ipcMain.handle('send-run-command-trigger', (_e, deviceId: string, key: string) => {
    deviceManager.sendTo(deviceId, createTriggerCommandPacket(key));
  });

  // ===== File System =====
  ipcMain.handle('fs-get-connected-devices', () => {
    return Array.from(fsClients.keys());
  });

  ipcMain.handle('fs-list-roots', async (_e, deviceId: string) => {
    const client = fsClients.get(deviceId);
    if (!client) throw new Error('Device FS client not connected');
    return client.listRoots();
  });

  ipcMain.handle('fs-readdir', async (_e, deviceId: string, path: string) => {
    const client = fsClients.get(deviceId);
    if (!client) throw new Error('Device FS client not connected');
    return client.readdir(path);
  });

  ipcMain.handle('fs-stat', async (_e, deviceId: string, path: string) => {
    const client = fsClients.get(deviceId);
    if (!client) throw new Error('Device FS client not connected');
    return client.stat(path);
  });

  ipcMain.handle('fs-read', async (_e, deviceId: string, path: string, offset: number, length: number) => {
    const client = fsClients.get(deviceId);
    if (!client) throw new Error('Device FS client not connected');
    const buffer = await client.read(path, offset, length);
    return buffer.toString('base64');
  });

  // ===== Audio Relay =====
  ipcMain.handle('start-audio-relay', async () => {
    if (audioRelayServer) return { started: true, port: AUDIO_RELAY_PORT };

    const server = new AudioRelayServer(tlsIdentity.cert, tlsIdentity.key, AUDIO_RELAY_PORT);
    server.on('guestPinPending', (connId, pin, remoteAddress) => {
      send('audio-relay-guest-pin-pending', connId, pin, remoteAddress);
    });
    server.on('listenerJoined', (connId, label) => {
      send('audio-relay-listener-joined', connId, label);
    });
    server.on('listenerLeft', (connId) => {
      send('audio-relay-listener-left', connId);
    });
    server.on('error', (err) => {
      console.error('[Link] Audio Relay server error:', err.message);
      send('audio-relay-error', err.message);
    });

    try {
      await server.start();
    } catch (err: any) {
      console.error('[Link] Failed to start Audio Relay:', err.message);
      return { started: false, error: err.message };
    }
    audioRelayServer = server;

    // Notify already-connected, permitted paired devices with their own one-time join token.
    // Known v1 limitation: a peer that connects to the main mesh AFTER this point won't
    // retroactively get one — they'd need the session restarted to see the "Join" banner.
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      if (!checkDevicePermission(peerId, 'audiorelay')) continue;
      const token = server.issueToken(peerId);
      deviceManager.sendTo(peerId, createPacket('link.audiorelay.started', { token, port: AUDIO_RELAY_PORT }));
    }

    return { started: true, port: AUDIO_RELAY_PORT };
  });

  ipcMain.handle('accept-audio-relay-guest', (_e, connId: string) => {
    audioRelayServer?.acceptGuest(connId);
  });

  ipcMain.handle('reject-audio-relay-guest', (_e, connId: string) => {
    audioRelayServer?.rejectGuest(connId);
  });

  ipcMain.handle('set-audio-relay-muted', (_e, muted: boolean) => {
    audioRelayServer?.setMuted(muted);
  });

  ipcMain.handle('get-audio-relay-listeners', () => {
    return audioRelayServer?.listenersSnapshot() ?? [];
  });

  ipcMain.handle('end-audio-relay', async () => {
    if (!audioRelayServer) return;
    // Also tell every paired peer, not just admitted listeners — someone might have the tab
    // open with the "Join" banner showing but never actually joined, and needs it cleared too.
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      deviceManager.sendTo(peerId, createPacket('link.audiorelay.ended', {}));
    }
    await audioRelayServer.stop();
    audioRelayServer = null;
  });

  ipcMain.handle('join-audio-relay-guest', (_e, host: string) => {
    audioRelayClient?.disconnect();
    const client = new AudioRelayClient(host, AUDIO_RELAY_PORT, tlsIdentity.cert, tlsIdentity.key);
    wireAudioRelayClientEvents(client);
    audioRelayClient = client;
    client.connect({ kind: 'guest' });
  });

  ipcMain.handle('join-audio-relay-paired', (_e, host: string, token: string) => {
    audioRelayClient?.disconnect();
    const client = new AudioRelayClient(host, AUDIO_RELAY_PORT, tlsIdentity.cert, tlsIdentity.key);
    wireAudioRelayClientEvents(client);
    audioRelayClient = client;
    const mode: JoinMode = { kind: 'token', token };
    client.connect(mode);
  });

  ipcMain.handle('leave-audio-relay', () => {
    audioRelayClient?.disconnect();
    audioRelayClient = null;
  });

  // Called once when the Audio Relay tab mounts, so a session that started before this device
  // was connected/looking gets surfaced immediately instead of only ever catching the original
  // one-shot broadcast — see the 'link.audiorelay.query' packet handler above.
  ipcMain.handle('query-audio-relay-sessions', () => {
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      deviceManager.sendTo(peerId, createPacket('link.audiorelay.query', {}));
    }
  });

  // ===== Remote Mic =====
  ipcMain.handle('query-remote-mic-sessions', () => {
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
      deviceManager.sendTo(peerId, createPacket('link.remotemic.query', {}));
    }
  });

  ipcMain.handle('join-remote-mic-paired', (_e, host: string, token: string) => {
    remoteMicClient?.disconnect();
    // AUDIO_RELAY_PORT + 2 is our Remote Mic port mapping
    const client = new AudioRelayClient(host, AUDIO_RELAY_PORT + 2, tlsIdentity.cert, tlsIdentity.key);
    wireRemoteMicClientEvents(client);
    remoteMicClient = client;
    const mode: JoinMode = { kind: 'token', token };
    client.connect(mode);
  });

  ipcMain.handle('leave-remote-mic', () => {
    remoteMicClient?.disconnect();
    remoteMicClient = null;
  });

  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  console.log('[Link] window-all-closed event fired');
  discoveryService?.stop();
  clipboardWatcher?.stop();
  batteryWatcher?.stop();
  volumeWatcher?.stop();
  touchpadHandler?.stop();
  screensaverInhibitor?.stop();
  hidePresenterDot();
  if (inputUdpSocket) {
    try { inputUdpSocket.close(); } catch {}
    inputUdpSocket = null;
  }
  // Not awaited — app-quit cleanup, not a request that needs to complete before proceeding.
  // Without this, a held-open capture process (audio-capture.ps1) would be orphaned.
  audioRelayServer?.stop().catch(() => {});
  audioRelayClient?.disconnect();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  console.log('[Link] before-quit event fired');
  discoveryService?.stop();
  clipboardWatcher?.stop();
  batteryWatcher?.stop();
  volumeWatcher?.stop();
  touchpadHandler?.stop();
  screensaverInhibitor?.stop();
  hidePresenterDot();
  if (inputUdpSocket) {
    try { inputUdpSocket.close(); } catch {}
    inputUdpSocket = null;
  }
  audioRelayServer?.stop().catch(() => {});
  audioRelayClient?.disconnect();
});

app.on('will-quit', () => {
  console.log('[Link] will-quit event fired');
});

function sendInitialSync(deviceId: string) {
  // 0. Effective capabilities — lets the peer's UI know upfront exactly which of our gated
  // features it's currently allowed to use, before any state packets below even arrive.
  pushEffectiveCapabilities(deviceId);
  // 1. Clipboard
  if (isEnabled('Clipboard') && canSendClipboardTo(deviceId)) {
    deviceManager.sendTo(
      deviceId,
      createClipboardConnectPacket(clipboardWatcher.currentContent(), clipboardWatcher.currentTimestamp())
    );
  }
  // 2. Battery
  const batterySnapshot = batteryWatcher.current();
  if (batterySnapshot) {
    deviceManager.sendTo(deviceId, createBatteryPacket(batterySnapshot.isCharging, batterySnapshot.currentCharge));
  }
  // 3. Command list — both directions: serve our own whitelist to the peer (if we've allowed it
  // for them), and ask for theirs too (mesh case: they might be a Link desktop instance too).
  if (checkDevicePermission(deviceId, 'runcommand')) {
    deviceManager.sendTo(deviceId, runCommandManager.createCommandListPacket());
  }
  deviceManager.sendTo(deviceId, createRequestCommandListPacket());
  // 4. Volume
  if (checkDevicePermission(deviceId, 'systemvolume')) {
    const volumeSnapshot = volumeWatcher.current();
    if (volumeSnapshot && volumeSnapshot.length > 0) {
      deviceManager.sendTo(deviceId, createSystemVolumePacket(volumeSnapshot));
    }
  }
  // 5/6. Lock state
  deviceManager.sendTo(deviceId, createLockPacket(isLocalDeviceLocked()));
  deviceManager.sendTo(deviceId, createLockRequestPacket(undefined, true));
  // 7. MPRIS Media state
  if (checkDevicePermission(deviceId, 'mpris')) {
    queryMprisSessions().then((sessions) => {
      deviceManager.sendTo(deviceId, createMprisStatePacket(sessions));
    }).catch(() => {});
  }

}

async function handleFsRequest(body: any): Promise<any> {
  const { action, path: targetPath, offset, length, isDirectory, newPath, buffer } = body;

  // Loop prevention: Determine active drive letters used by Link mounts
  const activeLinkDrives = new Set<string>();
  for (const mountService of fsMountServices.values()) {
    activeLinkDrives.add(mountService.getDriveLetter().toUpperCase());
  }

  // Double check if the requested path falls inside an active Link drive letter
  if (targetPath) {
    const driveLetter = targetPath.split(':')[0] + ':';
    if (activeLinkDrives.has(driveLetter.toUpperCase())) {
      throw new Error('Access to Link virtual drive letter is blocked to prevent loops.');
    }
  }

  switch (action) {
    case 'listRoots': {
      // Return physical drives excluding active Link mounts
      return getLocalPhysicalDrives(activeLinkDrives);
    }
    case 'readdir': {
      const items = fs.readdirSync(targetPath, { withFileTypes: true });
      const list = [];
      for (const item of items) {
        const fullPath = path.join(targetPath, item.name);
        let size = 0;
        let mtime = Date.now();
        try {
          const s = fs.statSync(fullPath);
          size = s.size;
          mtime = s.mtimeMs;
        } catch {}
        list.push({
          name: item.name,
          isDirectory: item.isDirectory(),
          size,
          mtime,
        });
      }
      return list;
    }
    case 'stat': {
      const s = fs.statSync(targetPath);
      return {
        name: path.basename(targetPath),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtime: s.mtimeMs,
      };
    }
    case 'read': {
      const fd = fs.openSync(targetPath, 'r');
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      fs.closeSync(fd);
      return buf;
    }
    case 'create': {
      if (isDirectory) {
        fs.mkdirSync(targetPath, { recursive: true });
      } else {
        fs.writeFileSync(targetPath, '');
      }
      return true;
    }
    case 'delete': {
      if (isPathProtected(targetPath)) {
        throw new Error('Access Denied: Deletion of protected Windows system directory is blocked.');
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
      return true;
    }
    case 'rename': {
      if (isPathProtected(targetPath) || (newPath && isPathProtected(newPath))) {
        throw new Error('Access Denied: Moving or renaming Windows system directory is blocked.');
      }
      fs.renameSync(targetPath, newPath);
      return true;
    }
    case 'write': {
      if (isPathProtected(targetPath)) {
        throw new Error('Access Denied: Writing to protected Windows system directory is blocked.');
      }
      const data = Buffer.from(buffer.data);
      const fd = fs.openSync(targetPath, 'r+');
      fs.writeSync(fd, data, 0, data.length, offset);
      fs.closeSync(fd);
      return true;
    }
    default:
      throw new Error(`Unsupported FS action: ${action}`);
  }
}

function isPathProtected(targetPath: string): boolean {
  // Resolve first — a raw string check alone is trivially bypassed by a '..' segment (e.g.
  // "C:/Users/x/../../Windows/System32" matches none of the blocklist entries as a raw string,
  // but fs.rmSync/renameSync/writeFileSync resolve it at the OS level to the real protected
  // folder, completely bypassing this check). path.resolve() collapses '..'/'.' before compare.
  const resolved = path.resolve(targetPath);
  const norm = resolved.toLowerCase().replace(/\\/g, '/');

  // Protect drive roots themselves (e.g. "c:/" or "d:")
  const clean = norm.endsWith('/') ? norm.substring(0, norm.length - 1) : norm;
  if (clean.length <= 2 || (clean.length === 3 && clean.endsWith(':/'))) {
    return true;
  }

  const protectedRoots = [
    'c:/windows',
    'c:/program files',
    'c:/program files (x86)',
    'c:/users'
  ];

  for (const root of protectedRoots) {
    if (clean === root || clean.startsWith(root + '/')) {
      // Allow modifying directories inside specific user folders (e.g., C:/Users/dixit/...)
      // but block deleting the C:/Users folder itself, or the root user directory paths.
      const parts = clean.split('/');
      if (root === 'c:/users') {
        if (parts.length <= 3) { // blocks "C:/Users" or "C:/Users/username" itself
          return true;
        }
        continue;
      }
      return true;
    }
  }

  return false;
}


// Swallowing these keeps the app alive instead of hard-crashing on a bug, but a live process
// isn't the same as a WORKING one — if something throws inside, say, the TLS server's connection
// callback or the discovery socket's message handler, that specific subsystem can be left
// degraded (still "running" but no longer doing its job) for the rest of the session, which
// matches "only a full restart fixes it" symptoms. Persisting these to disk (not just console,
// which is invisible in a packaged build) means the next occurrence leaves real evidence instead
// of requiring a fresh repro under devtools.
function logCrashToDisk(label: string, detail: unknown) {
  try {
    const logPath = path.join(app.getPath('userData'), 'link-config', 'crash.log');
    const line = `[${new Date().toISOString()}] ${label}: ${detail instanceof Error ? (detail.stack || detail.message) : String(detail)}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // Best-effort only — never let logging itself crash the process.
  }
}

process.on('uncaughtException', (err) => {
  console.error('[Link] uncaughtException:', err);
  logCrashToDisk('uncaughtException', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Link] unhandledRejection at:', promise, 'reason:', reason);
  logCrashToDisk('unhandledRejection', reason);
});

// App-level heartbeat/liveness cycle (every 3s) — detects a genuinely dead peer within ~9s
// (HEARTBEAT_TIMEOUT_MS) instead of depending on OS TCP keepalive timing, which only lets Node
// configure the initial idle delay (not the retry interval/count), so real-world detection could
// silently take 20-30+ seconds. Force-closing a stale connection here fires the normal
// deviceDisconnected cleanup, which is what lets discovery reconnect promptly — this is what
// keeps both sides' idea of "connected" from drifting out of sync with reality, and what makes
// reconnection after a real drop (app reload, brief Wi-Fi loss) fast instead of stuck showing a
// stale "connected" state.
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 9000;
setInterval(() => {
  deviceManager?.runHeartbeatCycle(HEARTBEAT_TIMEOUT_MS);
}, HEARTBEAT_INTERVAL_MS);

// Periodic SMTC media sessions poll (every 3 seconds) to broadcast track/state updates to connected peers
let lastMprisJson = '';
setInterval(async () => {
  if (deviceManager.trustedConnectedDeviceIds().length === 0) return;
  try {
    const sessions = await queryMprisSessions();
    const currentJson = JSON.stringify(sessions);
    if (currentJson !== lastMprisJson) {
      lastMprisJson = currentJson;
      broadcastToPermittedPeers('mpris', createMprisStatePacket(sessions));
    }
  } catch (e) {}
}, 3000);

