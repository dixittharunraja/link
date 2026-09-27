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
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const net = __importStar(require("net"));
const dgram = __importStar(require("dgram"));
electron_1.app.setName('Link');
electron_1.app.disableHardwareAcceleration();
const identity_1 = require("../core/identity");
const tls_1 = require("../core/tls");
const trust_1 = require("../core/trust");
const device_manager_1 = require("../core/device-manager");
const transport_1 = require("../core/transport");
const packet_1 = require("../core/packet");
const audio_sink_server_1 = require("./audio-sink-server");
const audio_sink_client_1 = require("./audio-sink-client");
const joystick_server_1 = require("./joystick-server");
const transport_2 = require("../core/transport");
const portal_transfer_server_1 = require("./portal-transfer-server");
const portal_transfer_client_1 = require("./portal-transfer-client");
const walkie_talkie_signal_server_1 = require("./walkie-talkie-signal-server");
const walkie_talkie_signal_client_1 = require("./walkie-talkie-signal-client");
const clipboard_1 = require("../core/plugins/clipboard");
const capabilities_1 = require("../core/plugins/capabilities");
const permissions_1 = require("./permissions");
const settings_store_1 = require("./settings-store");
const discovery_1 = require("../core/discovery");
const battery_1 = require("../core/plugins/battery");
const findmydevice_1 = require("../core/plugins/findmydevice");
const fs_socket_client_1 = require("./fs-socket-client");
const fs_helper_1 = require("./fs-helper");
const speedtest_1 = require("../core/plugins/speedtest");
const runcommand_1 = require("../core/plugins/runcommand");
const presenter_1 = require("../core/plugins/presenter");
const systemvolume_1 = require("../core/plugins/systemvolume");
const lock_1 = require("../core/plugins/lock");
const connectivity_1 = require("../core/plugins/connectivity");
const touchpad_1 = require("../core/plugins/touchpad");
const mpris_1 = require("../core/plugins/mpris");
const telephony_1 = require("../core/plugins/telephony");
const notification_1 = require("../core/plugins/notification");
const screensaver_inhibit_1 = require("../core/plugins/screensaver-inhibit");
const pausemusic_1 = require("../core/plugins/pausemusic");
const digitizer_1 = require("../core/plugins/digitizer");
const joystick_1 = require("../core/plugins/joystick");
const flashlight_1 = require("../core/plugins/flashlight");
const dnd_1 = require("../core/plugins/dnd");
const rename_1 = require("../core/plugins/rename");
const electron_2 = require("electron");
const fs_client_1 = require("./fs-client");
const fs_mount_service_1 = require("./fs-mount-service");
// Master kill-switch for the systematic re-verification pass: everything in test.txt starts
// disabled so the core connection (discovery/pairing/trust/TLS) can be solidified in isolation
// first, then plugins re-enabled one at a time as confirmed working. Does not touch any plugin's
// own logic — this only gates whether main.ts wires it up/dispatches to it. Speed Test, System
// Volume, and MPRIS have graduated out of this — confirmed working, so their gates were removed
// entirely rather than left toggled on here.
const ENABLED_PLUGINS = new Set([
    'Clipboard', 'Battery', 'Flashlight', 'DND', 'Connectivity', 'Lock', 'Notification', 'RunCommand',
    'Presenter', 'Digitizer', 'Touchpad', 'Telephony', 'MPRIS', 'Joystick',
]);
function isEnabled(name) {
    return ENABLED_PLUGINS.has(name);
}
const CAPABILITIES = {
    incoming: [
        'link.clipboard', 'link.clipboard.connect', 'link.battery',
        'link.findmydevice.request', 'link.runcommand.request', 'link.presenter',
        'link.systemvolume.request', 'link.lock.request', 'link.lock', 'link.connectivity',
        'link.touchpad.request', 'link.mpris.request', 'link.telephony', 'link.notification',
        'link.flashlight', 'link.dnd', 'link.rename', 'link.rename.request',
        // Digitizer was executable (checkDevicePermission-gated handlers already existed) but never
        // actually declared as a capability — peers had no way to discover the PC supports it at all.
        'link.digitizer.session', 'link.digitizer',
        // Joystick has NO TLS packet type at all, deliberately — see joystick.ts's header comment.
        // Its entire protocol (including the join handshake) rides the raw UDP:1717 line-based
        // channel, identified by source IP only, same as an Audio Sink guest.
    ],
    outgoing: [
        'link.clipboard', 'link.clipboard.connect', 'link.battery',
        'link.findmydevice.request', 'link.runcommand',
        // 'link.presenter' was wrongly listed here — desktop has no IPC path that ever sends a
        // presenter/touchpad/digitizer packet (those are mobile-to-desktop only, desktop is purely
        // the executor), so it never belongs in desktop's own outgoing list.
        'link.systemvolume', 'link.lock.request', 'link.lock', 'link.mpris',
        'link.flashlight', 'link.dnd', 'link.rename', 'link.rename.request',
    ],
};
let mainWindow = null;
// System-tray "close to tray" (Spotify/Discord-style): when enabled, closing the window hides it
// to a tray icon instead of quitting, so the mesh connections keep running in the background.
let tray = null;
let isQuitting = false; // set true only by the tray "Quit" action / real app quit
let closeToTray = true; // user preference, loaded from disk in initCore
let hasShownTrayBalloon = false; // one-time "still running" hint on first hide-to-tray
let deviceDriveLetters = {}; // deviceId -> driveLetter
// deviceId -> whether the user wants this device auto-mounted whenever fileaccess is granted on
// connect. Missing/unset means "yes" (matches the original, always-auto-mount behavior) — only an
// EXPLICIT unmount via the UI writes `false` here. Without this, "unmount"/fs-unmount-device only
// ever touched the in-memory fsMountServices map: peerCapabilities gets wiped on every disconnect
// (see deviceDisconnected's peerCapabilities.delete), so the next reconnect's capabilities packet
// looks like fileaccess was just newly granted and remounts unconditionally — the toggle silently
// didn't survive a reconnect, let alone an app restart.
let deviceMountEnabled = {};
let deviceManager;
// Last effective-capabilities list each connected peer pushed us (which of THEIR gated plugins
// we're currently allowed to use). Cached in the main process so a renderer reload can re-hydrate
// it locally via get-connected-devices — the peer only pushes this on connect / permission-change,
// so without this cache a reload would blank every gated plugin until the peer happened to reload
// too (the "reload ping-pong" where each side's reload fixed the other's view but broke its own).
const peerCapabilities = new Map();
let tlsIdentity;
const fsClients = new Map();
const socketFsClients = new Map();
const fsMountServices = new Map();
// Audio Sink: at most one role at a time — hosting (audioSinkServer) or listening
// (audioSinkClient), never both. Deliberately isolated from DeviceManager/TrustStore — see
// audio-sink-server.ts's header comment for why.
let audioSinkServer = null;
let audioSinkClient = null;
let audioSinkHostLabel = '';
// Remote Mic is mobile-host / PC-listen only (see docs/backlog.txt) — a PC's mic streamed to a
// phone can only ever be played back through the phone's speaker, never picked up by other apps
// as an actual system microphone (unlike the reverse: a PC listener can route it into a virtual
// audio cable), so PC-as-host added real complexity for a direction with no genuine use. Only the
// client half (remoteMicClient) exists on desktop now.
let remoteMicClient = null;
// Assigned once inside app.whenReady() (they close over deviceManager/tlsIdentity, which don't
// exist until initCore() runs) — module-level so rebuildTrayMenu(), defined outside that closure
// alongside createTray(), can still call them as the single shared "end this session" path.
let endAudioSink = async () => { };
// Portal Mode (one-time file transfer to an unpaired/untrusted device) — same isolation model as
// Audio Sink/Remote Mic above. portalTransferServer = actively receiving; portalTransferClient =
// actively sending. A device can be doing both at once (unlike audio, there's no shared hardware
// resource conflict), so these aren't mutually exclusive the way the audio pair above are.
let portalTransferServer = null;
let portalTransferClient = null;
// Walkie Talkie's guest-facing signaling — only relevant for an UNPAIRED participant (manual IP +
// PIN). Already-paired members never touch this: their session-membership/WebRTC-negotiation
// traffic rides the existing trusted connection instead (see the link.walkietalkie.* packet relay
// below). walkieTalkieGuestServer runs whenever this device is hosting a session (guests can join
// any time during it); walkieTalkieGuestClient exists only while THIS device is joined to someone
// else's session as an unpaired guest.
let walkieTalkieGuestServer = null;
let walkieTalkieGuestClient = null;
let configDir;
let clipboardWatcher;
let lastKnownClipboardTimestamp = 0;
let batteryWatcher;
let volumeWatcher;
let touchpadHandler;
let screensaverInhibitor;
let pauseMusicController;
let digitizerHandler;
let joystickHandler;
let joystickServer = null;
let runCommandManager;
let speedTestManager;
let blocklist = [];
// Module-level (not local to initCore()) so the app.whenReady() closure — a separate function,
// where AudioSinkServer/PortalTransferServer are constructed and their block/kick IPC handlers
// live — can reference it too. Same reattach-scope reason as discoveredUnpairedPeers below.
// Checks BOTH entry.id and entry.ip against whatever identifier the caller has on hand — a device
// blocked by deviceId (e.g. reject+block on a pairing request) stores its IP separately in `ip`,
// not `id`, but every untrusted-tool guest connection (Audio Sink/Remote Mic/Walkie Talkie/
// Joystick/File Transfer) can only check by IP at connection time, before any device identity is
// established. Checking `id` alone meant a device blocked via pairing could still reach every
// untrusted tool by IP, and a device blocked as an untrusted-tool guest (id = IP) could still
// re-pair under a fresh deviceId from the same, still-blocked IP. Also strips the IPv4-mapped
// IPv6 prefix (`::ffff:`) and any trailing `:port`, since callers pass the raw socket address in
// varying shapes depending on the underlying transport (ws vs java-websocket vs plain net).
function isBlocked(idOrIp) {
    const clean = idOrIp.replace(/^::ffff:/, '').split(':')[0];
    return blocklist.some((entry) => entry.id === idOrIp || entry.id === clean || entry.ip === idOrIp || entry.ip === clean);
}
/** Adds an entry (device or IP) to the blocklist if not already present, and persists it —
 *  shared by the Settings blocklist manager, "reject + block" on an incoming pair request, and
 *  the "Block" button next to Kick in Audio Sink/Remote Mic/Portal Mode's listener lists. Does
 *  NOT itself disconnect anything — callers that have a live connection to terminate do that
 *  separately right after calling this, since what counts as "the connection" differs per caller
 *  (a full DeviceManager peer vs. a specific ephemeral guest-session listener). */
function addToBlocklist(id, label, type, deviceType, ip) {
    const cleanId = id.replace(/^::ffff:/, '').split(':')[0];
    const cleanIp = ip ? ip.replace(/^::ffff:/, '').split(':')[0] : undefined;
    if (blocklist.some((x) => x.id === cleanId || x.id === id || (cleanIp && x.ip === cleanIp)))
        return;
    blocklist.push({ id: cleanId, label, type, blockedAt: Date.now(), deviceType, ip: cleanIp });
    (0, settings_store_1.saveBlocklist)(configDir, blocklist);
    console.log(`[Link] Blocked: ${label} (${cleanId})`);
}
/** Blocking an untrusted-tool guest (Audio Sink/Remote Mic/Walkie Talkie/Joystick/File Transfer)
 *  by bare IP always produced a generic "Guest (ip)" / "Blocked IP" entry in the Blocklist UI —
 *  visually and functionally different from blocking the same physical device via "reject +
 *  block" on a pairing request, which shows its real name/type. If this IP happens to belong to a
 *  device this app can actually identify — either already paired, or just visible via LAN
 *  discovery even though never paired — block it the SAME way pairing-block does: by deviceId,
 *  with its real name and device type, so the Blocklist entry (and hence its icon/label there)
 *  looks identical regardless of which surface the block came from. Only falls back to a bare
 *  IP/"Guest" entry when the device genuinely can't be identified (e.g. off-LAN, discovery
 *  hasn't seen it, or it deliberately withheld its name). */
function blockUntrustedGuest(remoteAddress, selfReportedName) {
    const cleanIp = remoteAddress.replace(/^::ffff:/, '').split(':')[0];
    const pairedId = deviceManager.deviceIdForAddress(cleanIp);
    if (pairedId) {
        const dev = deviceManager.trustStore.get(pairedId);
        addToBlocklist(pairedId, dev?.deviceName || selfReportedName || `Guest (${cleanIp})`, 'device', undefined, cleanIp);
        return;
    }
    for (const info of discoveredUnpairedPeers.values()) {
        if (info.ipAddress === cleanIp) {
            addToBlocklist(info.deviceId, info.deviceName || selfReportedName || `Guest (${cleanIp})`, 'device', info.deviceType, cleanIp);
            return;
        }
    }
    addToBlocklist(cleanIp, selfReportedName || `Guest (${cleanIp})`, 'ip');
}
// Guards against firing overlapping connectTo() attempts at the same peer while a previous one
// from an earlier discovery broadcast is still in flight — see discoveryService callback below.
const connectingDeviceIds = new Set();
// Backoff for reconnect attempts that can't even establish a connection (e.g. a stale discovery
// entry for a peer that's genuinely offline) — without this, such a peer got retried on every
// single discovery broadcast (~every 5s) with zero cooldown. Deliberately does NOT apply to a
// peer that connects and later disconnects (app restart, brief Wi-Fi drop, etc.) — that case
// should always reconnect immediately on the next broadcast, no penalty, for reconnection to feel
// seamless rather than laggy.
const reconnectBackoff = new Map();
const MAX_BACKOFF_MS = 15000;
const MIN_BACKOFF_MS = 1000;
function recordConnectFailure(deviceId) {
    const prev = reconnectBackoff.get(deviceId);
    const failCount = (prev?.failCount || 0) + 1;
    const delayMs = Math.min(MIN_BACKOFF_MS * Math.pow(2, failCount - 1), MAX_BACKOFF_MS);
    reconnectBackoff.set(deviceId, { nextAttemptAt: Date.now() + delayMs, failCount });
}
function clearConnectBackoff(deviceId) {
    reconnectBackoff.delete(deviceId);
}
function canAttemptConnect(deviceId) {
    const backoff = reconnectBackoff.get(deviceId);
    return !backoff || Date.now() >= backoff.nextAttemptAt;
}
// Run Command whitelists RECEIVED FROM peers (mesh case: any device, mobile or desktop, viewing a
// paired desktop's panel needs that desktop's real whitelist — distinct from runCommandManager,
// which owns/serves THIS device's own whitelist to others).
const peerCommandLists = new Map();
const activeNotifications = new Map();
const activeAppNotifications = new Map();
let discoveryService;
// Purely-discovered (UDP broadcast only, never auto-connected) unpaired peers — module-level so
// the 'request-pairing' IPC handler (registered in app.whenReady(), a separate closure from
// initCore() where this is populated) can look up a discovered peer's IP to connect on demand.
const discoveredUnpairedPeers = new Map();
let inputUdpSocket = null;
let triggerReconnect = null;
let visibilityEnabled = true;
let screensaverInhibitEnabled = true;
let activeRingerDeviceId = null;
let ringTimeoutMain = null;
let pinLockEnabled = false;
let pinCode = '';
let presenterWindow = null;
let presenterPosition = null;
let presenterHideTimeout = null;
const PRESENTER_HIDE_DELAY_MS = 500; // matches upstream's 500ms auto-hide-when-idle timer
// Multi-monitor target for the absolute-positioned features (presenter dot + digitizer). Touchpad
// doesn't need this — it sends relative moves that cross monitors natively. Tracked by Electron
// display id (survives display list reordering); defaults to the primary display. The phone cycles
// it via the "Switch Screen" overlay button (link.target.display packet).
let targetDisplayId = null;
function getTargetDisplay() {
    const displays = electron_2.screen.getAllDisplays();
    return displays.find((d) => d.id === targetDisplayId) || electron_2.screen.getPrimaryDisplay();
}
function cycleTargetDisplay() {
    const displays = electron_2.screen.getAllDisplays();
    if (displays.length <= 1)
        return; // single monitor — nothing to switch to
    const currentId = getTargetDisplay().id;
    const idx = displays.findIndex((d) => d.id === currentId);
    targetDisplayId = displays[(idx + 1) % displays.length].id;
    // Recreate the presenter dot on the newly-targeted display on its next move (it's positioned at
    // creation time), so an already-open dot follows the switch instead of being stranded.
    if (presenterWindow) {
        try {
            presenterWindow.close();
        }
        catch { /* already gone */ }
        presenterWindow = null;
    }
}
// Outbound half of the raw UDP input relay (port 1717) — needed now that desktop can also be
// the CONTROLLER (not just the target) for presenter, e.g. PresenterOverlay.tsx's drag surface.
// Mirrors mobile LinkPlugin.java's sendUdpMessage(); reuses the listening socket bound in
// initCore() since dgram sockets are full-duplex. Module-level (not nested in initCore()) so it
// stays in scope for the ipcMain handlers registered elsewhere in this file.
function sendUdpMessageToPeer(deviceId, message) {
    const ip = deviceManager.remoteAddressOf(deviceId);
    if (!ip)
        return;
    sendUdpMessageToAddress(ip, message);
}
// Joystick's whole protocol is IP-identified rather than deviceId-identified (see joystick.ts's
// header comment), so its replies (hello-ack, rumble) address a raw IP directly instead of going
// through deviceManager.remoteAddressOf() like every other plugin's outbound UDP traffic above.
function sendUdpMessageToAddress(ip, message) {
    if (!inputUdpSocket)
        return;
    const buf = Buffer.from(message, 'utf8');
    inputUdpSocket.send(buf, 1717, ip, (err) => {
        if (err)
            console.error('[Link] Failed to send UDP input message:', message, err);
    });
}
function send(channel, ...args) {
    mainWindow?.webContents.send(channel, ...args);
}
// Shared by every plugin that broadcasts state/whitelist updates to all connected peers, gated on
// each peer's own permission for that key — previously this exact loop (trustedConnectedDeviceIds
// + per-peer checkDevicePermission + sendTo) was copy-pasted at 7+ call sites (MPRIS, Clipboard,
// System Volume, Run Command).
function broadcastToPermittedPeers(permKey, packet) {
    for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
        if (!(0, permissions_1.checkDevicePermission)(peerId, permKey))
            continue;
        deviceManager.sendTo(peerId, packet);
    }
}
/** Forwards every AudioSinkClient event to the renderer over its own IPC channel — one place so
 *  both join paths (guest, paired-token) get identical renderer-side behavior. `hostLabel` is only
 *  the PRE-connection placeholder (the raw IP typed/scanned, or a paired session's remembered
 *  name) — once 'admitted' actually arrives it carries the host's own real device name (see
 *  audio-sink-client.ts/audio-sink-server.ts), which is what should end up on screen. Falling back
 *  to the placeholder only covers an old host build that doesn't send hostName yet. */
function wireAudioSinkClientEvents(client, hostLabel) {
    client.on('pinComputed', (pin) => send('audio-sink-pin-computed', pin));
    client.on('admitted', (hostName) => {
        const label = hostName || hostLabel;
        audioSinkHostLabel = label;
        send('audio-sink-admitted', label);
    });
    client.on('format', (format) => send('audio-sink-format', format));
    client.on('audioChunk', (pcm) => send('audio-sink-audio-chunk', pcm));
    client.on('hostMuted', (muted) => send('audio-sink-host-muted', muted));
    // Clearing audioSinkClient here (not just forwarding the event) is what makes reopening the
    // tab show "not connected" instead of a stale "still connected" — without this, the socket is
    // already dead but the module-level variable still points at it, so get-audio-sink-status
    // keeps reporting listening:true forever after a kick/host-end.
    client.on('ended', (reason) => { audioSinkClient = null; audioSinkHostLabel = ''; send('audio-sink-ended', reason); rebuildTrayMenu(); });
    client.on('closed', (reason) => { audioSinkClient = null; audioSinkHostLabel = ''; send('audio-sink-closed', reason); rebuildTrayMenu(); });
    client.on('error', (err) => send('audio-sink-error', err.message));
}
function wireRemoteMicClientEvents(client) {
    client.on('pinComputed', (pin) => send('remote-mic-pin-computed', pin));
    client.on('admitted', () => send('remote-mic-admitted'));
    client.on('format', (format) => send('remote-mic-format', format));
    client.on('audioChunk', (pcm) => send('remote-mic-audio-chunk', pcm));
    client.on('hostMuted', (muted) => send('remote-mic-host-muted', muted));
    client.on('ended', (reason) => { remoteMicClient = null; send('remote-mic-ended', reason); rebuildTrayMenu(); });
    client.on('closed', (reason) => { remoteMicClient = null; send('remote-mic-closed', reason); rebuildTrayMenu(); });
    client.on('error', (err) => send('remote-mic-error', err.message));
}
function showPresenterDot(dx, dy) {
    const display = getTargetDisplay();
    const { width, height } = display.workAreaSize;
    if (!presenterWindow) {
        presenterPosition = new presenter_1.PresenterPosition(width / height);
        presenterWindow = new electron_1.BrowserWindow({
            width,
            height,
            x: display.workArea.x,
            y: display.workArea.y,
            transparent: true,
            frame: false,
            alwaysOnTop: true,
            focusable: false,
            skipTaskbar: true,
            // X11 window-type hint — many Linux window managers (including GNOME/mutter) give
            // 'notification'-typed windows elevated stacking treatment, improving the odds this draws
            // above an exclusive-fullscreen slideshow. No effect on Windows (option is Linux-only).
            type: process.platform === 'linux' ? 'notification' : undefined,
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
    const { x, y } = presenterPosition.update(dx, dy);
    presenterWindow.webContents.send('presenter-position', x, y);
    if (presenterHideTimeout)
        clearTimeout(presenterHideTimeout);
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
        }
        catch {
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
    }
    else {
        screensaverInhibitor.stop();
    }
}
// Windows' built-in Mobile Hotspot (Settings > Network & internet > Mobile hotspot) always brings
// up its ICS adapter on this exact subnet — a stable Microsoft default unchanged since Windows
// XP's Internet Connection Sharing. When it's present, it means "this PC is actively hosting a
// hotspot another device is connected to right now" — precisely the scenario the QR code / "Your
// IP" display exists for, so it outranks everything else, INCLUDING a real Wi-Fi/Ethernet adapter
// with a normal-looking LAN address. Without this, a PC that's simultaneously on its home Wi-Fi
// AND hosting a hotspot for a phone would advertise the home-Wi-Fi address — reachable from other
// devices on that home network, but never from the phone, which only has a route to the hotspot
// subnet. That mismatch is exactly what broke Joystick/Audio Sink/etc. "scan to connect" when
// hotspot mode was in use: the QR code encoded an address the scanning phone could never reach.
const WINDOWS_HOTSPOT_SUBNET_PREFIX = '192.168.137.';
/** Lower = tried first. See WINDOWS_HOTSPOT_SUBNET_PREFIX for why the hotspot subnet wins even
 *  over a named Wi-Fi/Ethernet adapter — address content beats adapter-name guessing here. */
function localIpPriority(address, adapterNameLower) {
    if (address.startsWith(WINDOWS_HOTSPOT_SUBNET_PREFIX))
        return 0;
    if (adapterNameLower.includes('wi-fi') || adapterNameLower.includes('wlan') || adapterNameLower.includes('ethernet'))
        return 1;
    return 2;
}
/** Every non-internal IPv4 address across all adapters, ranked from most to least likely to be
 *  reachable by another device on the LAN (see localIpPriority). Adapters that are virtual
 *  bridges (WSL, Docker, VPN, Hyper-V, ...) are demoted below everything real, regardless of
 *  address, since a peer device is essentially never reachable through them. Ties (same tier)
 *  keep interface-enumeration order — Array.prototype.sort is stable. */
function rankedLocalIpAddresses() {
    const interfaces = os.networkInterfaces();
    const ranked = [];
    const fallback = [];
    for (const name of Object.keys(interfaces)) {
        const lowerName = name.toLowerCase();
        const isVirtual = lowerName.includes('wsl') ||
            lowerName.includes('virtual') ||
            lowerName.includes('vbox') ||
            lowerName.includes('docker') ||
            lowerName.includes('vpn') ||
            lowerName.includes('vmnet') ||
            lowerName.includes('vethernet') ||
            lowerName.includes('hyper-v');
        for (const net of interfaces[name] || []) {
            if (net.family !== 'IPv4' || net.internal)
                continue;
            if (isVirtual) {
                fallback.push(net.address);
            }
            else {
                ranked.push({ address: net.address, tier: localIpPriority(net.address, lowerName) });
            }
        }
    }
    ranked.sort((a, b) => a.tier - b.tier);
    return Array.from(new Set([...ranked.map((r) => r.address), ...fallback]));
}
function getLocalIpAddress() {
    return rankedLocalIpAddresses()[0] || '127.0.0.1';
}
function getAllLocalIpAddresses() {
    const all = rankedLocalIpAddresses();
    return all.length > 0 ? all : ['127.0.0.1'];
}
// Finds the first unused drive letter from Z down to D — shared by both the desktop-peer and
// mobile-peer mount paths below, which previously each had their own copy of this loop.
function findUnusedDriveLetter() {
    const letters = 'ZYXWVUTSRQPONMLKJIHGFED'.split('');
    for (const letter of letters) {
        const checkLetter = `${letter}:`;
        const isOccupied = fs.existsSync(checkLetter) || Array.from(fsMountServices.values()).some((s) => s.getDriveLetter() === checkLetter);
        if (!isOccupied)
            return checkLetter;
    }
    return 'Z:';
}
// Linux equivalent of findUnusedDriveLetter()/isLetterOccupied above — Linux has no drive-letter
// concept, so each device gets its own named subdirectory under ~/Link instead.
function sanitizeDeviceNameForPath(name) {
    let s = (name || 'device').replace(/[/\\\0]/g, '_'); // path separators + null byte
    s = s.replace(/[\x00-\x1f]/g, ''); // control chars
    s = s.trim();
    while (s.startsWith('.'))
        s = s.slice(1); // no leading dot (hidden dir)
    s = s.slice(0, 40).trim();
    return s || 'device';
}
// Cheap, synchronous, no subprocess — catches a stale FUSE mount left by a crashed previous run
// so a fresh mount doesn't collide with it. Preferred over proactively firing `fusermount -u`
// blind, which is async, noisy on stderr for the common case, and tells us nothing this doesn't.
function isLinuxPathActivelyMounted(mountPath) {
    try {
        const mounts = fs.readFileSync('/proc/mounts', 'utf8');
        return mounts.split('\n').some((line) => line.split(' ')[1] === mountPath);
    }
    catch {
        return false; // fail open — the in-memory fsMountServices check below still covers same-session collisions
    }
}
function isLinuxMountPathOccupied(mountPath) {
    return Array.from(fsMountServices.values()).some((s) => s.getDriveLetter() === mountPath) || isLinuxPathActivelyMounted(mountPath);
}
function findUnusedLinuxMountPath(deviceName) {
    const base = path.join(os.homedir(), 'Link');
    const safeName = sanitizeDeviceNameForPath(deviceName);
    let candidate = path.join(base, safeName);
    for (let n = 2; isLinuxMountPathOccupied(candidate); n++) {
        candidate = path.join(base, `${safeName}-${n}`);
    }
    return candidate;
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
async function mountFilesystemForDevice(peerIdentity, host) {
    if (fsMountServices.has(peerIdentity.deviceId)) {
        console.log(`[Link] Device ${peerIdentity.deviceName} already has an active filesystem mount. Skipping.`);
        return;
    }
    try {
        let driveLetter = deviceDriveLetters[peerIdentity.deviceId];
        if (process.platform === 'linux') {
            if (!driveLetter || isLinuxMountPathOccupied(driveLetter)) {
                driveLetter = findUnusedLinuxMountPath(peerIdentity.deviceName);
            }
        }
        else {
            const isLetterOccupied = (letter) => {
                if (fs.existsSync(letter))
                    return true;
                return Array.from(fsMountServices.values()).some((s) => s.getDriveLetter() === letter);
            };
            if (!driveLetter || isLetterOccupied(driveLetter)) {
                driveLetter = findUnusedDriveLetter();
            }
        }
        if (peerIdentity.deviceType === 'desktop') {
            console.log(`[Link] Instantiating Socket FS Client for desktop ${peerIdentity.deviceName} at ${host}...`);
            const socketFsClient = new fs_socket_client_1.LinkSocketFsClient(deviceManager, peerIdentity.deviceId);
            socketFsClients.set(peerIdentity.deviceId, socketFsClient);
            console.log(`[Link] Mounting PC filesystem for ${peerIdentity.deviceName} on ${driveLetter}...`);
            const mountService = new fs_mount_service_1.LinkFsMountService(socketFsClient, driveLetter, peerIdentity.deviceName, peerIdentity.deviceType);
            await mountService.mount();
            fsMountServices.set(peerIdentity.deviceId, mountService);
            send('device-mount-changed', peerIdentity.deviceId, driveLetter);
            console.log(`[Link] Mounted ${peerIdentity.deviceName} PC filesystem on ${driveLetter} successfully.`);
        }
        else {
            console.log(`[Link] Starting FS WSS client for ${peerIdentity.deviceName} at ${host}...`);
            const fsClient = new fs_client_1.LinkFsClient(host, undefined, tlsIdentity.cert, tlsIdentity.key);
            await fsClient.connect();
            fsClients.set(peerIdentity.deviceId, fsClient);
            console.log(`[Link] Connected FS client for ${peerIdentity.deviceName} successfully.`);
            console.log(`[Link] Mounting filesystem for ${peerIdentity.deviceName} on ${driveLetter}...`);
            const mountService = new fs_mount_service_1.LinkFsMountService(fsClient, driveLetter, peerIdentity.deviceName, peerIdentity.deviceType);
            await mountService.mount();
            fsMountServices.set(peerIdentity.deviceId, mountService);
            send('device-mount-changed', peerIdentity.deviceId, driveLetter);
            console.log(`[Link] Mounted ${peerIdentity.deviceName} filesystem on ${driveLetter} successfully.`);
        }
    }
    catch (err) {
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
    configDir = path.join(electron_1.app.getPath('userData'), 'link-config');
    const identity = (0, identity_1.loadOrCreateIdentity)(configDir, 'desktop', CAPABILITIES);
    tlsIdentity = (0, tls_1.loadOrCreateTlsIdentity)(configDir, identity.deviceId);
    const trustStore = new trust_1.TrustStore(configDir);
    deviceManager = new device_manager_1.DeviceManager({ cert: tlsIdentity.cert, key: tlsIdentity.key, myIdentity: identity }, trustStore, transport_1.LINK_PORT);
    (0, permissions_1.initPermissions)(configDir, deviceManager);
    touchpadHandler = new touchpad_1.TouchpadHandler(configDir);
    digitizerHandler = new digitizer_1.DigitizerHandler(touchpadHandler);
    // Vendored binaries live under <baseDir>/vendor — same dev-vs-packaged path resolution as
    // fs-mount-service.ts's rclone.exe lookup, duplicated here rather than shared since each mount
    // service already computes this independently.
    {
        const isDevBuild = process.argv.includes('--dev');
        const vendorBaseDir = isDevBuild ? path.join(__dirname, '..', '..') : path.join(process.resourcesPath || __dirname, '..');
        joystickHandler = new joystick_1.JoystickHandler(path.join(vendorBaseDir, 'vendor'));
        joystickHandler.setIsBlocked(isBlocked);
        joystickServer = new joystick_server_1.JoystickServer(tlsIdentity.cert, tlsIdentity.key, transport_2.JOYSTICK_PORT, isBlocked);
        joystickServer.on('error', (err) => console.error('[Link] Joystick WSS server error:', err.message));
        joystickServer.on('guestPinPending', (connId, pin, remoteAddress, deviceName) => {
            send('joystick-guest-pin-pending', connId, pin, remoteAddress, deviceName);
        });
        joystickServer.on('guestJoined', (ip, name) => {
            // Handled via accept-joystick-guest IPC
        });
        joystickServer.on('guestLeft', (ip) => {
            joystickHandler.handleBye(ip);
        });
        joystickServer.start().catch((err) => console.error('[Link] Failed to start Joystick WSS server:', err.message));
    }
    joystickHandler.onRumble((ip, large, small) => {
        joystickServer?.sendRumble(ip, large, small);
    });
    joystickHandler.onDriverStatusChange((status, error) => {
        send('joystick-driver-status', status, error);
    });
    joystickHandler.onRosterChange(() => {
        send('joystick-roster-changed');
    });
    joystickHandler.onControllerRemoved((ip, reason) => {
        joystickServer?.kickGuest(ip, reason);
    });
    screensaverInhibitor = new screensaver_inhibit_1.ScreensaverInhibitor();
    pauseMusicController = new pausemusic_1.PauseMusicController();
    runCommandManager = new runcommand_1.RunCommandManager(configDir);
    speedTestManager = new speedtest_1.SpeedTestManager(deviceManager);
    closeToTray = (0, settings_store_1.loadSetting)(configDir, 'tray-settings.json', 'closeToTray', true);
    // Set open on startup (open at login) to true by default on a fresh installation
    const openAtLoginInitialized = (0, settings_store_1.loadSetting)(configDir, 'startup-settings.json', 'openAtLoginInitialized', false);
    if (!openAtLoginInitialized) {
        try {
            electron_1.app.setLoginItemSettings({ openAtLogin: true });
            (0, settings_store_1.saveSetting)(configDir, 'startup-settings.json', 'openAtLoginInitialized', true);
            console.log('[Link] Initialized openOnStartup/openAtLogin to true by default for fresh installation.');
        }
        catch (err) {
            console.error('[Link] Failed to set default login item settings:', err.message);
        }
    }
    visibilityEnabled = (0, settings_store_1.loadSetting)(configDir, 'discovery-settings.json', 'visibilityEnabled', false);
    pauseMusicController.setEnabled((0, settings_store_1.loadSetting)(configDir, 'pause-music-settings.json', 'pauseMusicEnabled', true));
    screensaverInhibitEnabled = (0, settings_store_1.loadSetting)(configDir, 'screensaver-inhibit-settings.json', 'screensaverInhibitEnabled', true);
    pinLockEnabled = (0, settings_store_1.loadSetting)(configDir, 'pin-lock-settings.json', 'pinLockEnabled', false);
    pinCode = (0, settings_store_1.loadSetting)(configDir, 'pin-lock-settings.json', 'pinCode', '1234');
    deviceDriveLetters = (0, settings_store_1.loadSetting)(configDir, 'mount-settings.json', 'deviceDriveLetters', {});
    deviceMountEnabled = (0, settings_store_1.loadSetting)(configDir, 'mount-settings.json', 'deviceMountEnabled', {});
    blocklist = (0, settings_store_1.loadBlocklist)(configDir);
    discoveryService = new discovery_1.DiscoveryService(identity, (ip, peerIdentity) => {
        if (isBlocked(peerIdentity.deviceId) || isBlocked(ip)) {
            return;
        }
        const isPaired = deviceManager.trustStore.isPaired(peerIdentity.deviceId);
        let displayName = peerIdentity.deviceName;
        if (isPaired) {
            const trustedDev = deviceManager.trustStore.get(peerIdentity.deviceId);
            if (trustedDev && trustedDev.deviceName) {
                displayName = trustedDev.deviceName;
            }
        }
        const info = {
            deviceId: peerIdentity.deviceId,
            deviceName: displayName,
            deviceType: peerIdentity.deviceType || 'phone',
            ipAddress: ip,
            trusted: isPaired,
            connected: deviceManager.hasPeer(peerIdentity.deviceId),
        };
        // Invisible to strangers: if an unpaired device has visibility OFF, hide it completely.
        if (!isPaired && peerIdentity.visibility === false) {
            return;
        }
        if (!isPaired) {
            discoveredUnpairedPeers.set(peerIdentity.deviceId, info);
            mainWindow?.webContents.send('device-discovered', info);
            return; // Do NOT auto-connect untrusted devices over TCP
        }
        // Verify if the discovered IP address of the paired device has changed.
        const existing = deviceManager.trustStore.get(peerIdentity.deviceId);
        const currentIp = deviceManager.remoteAddressOf(peerIdentity.deviceId);
        const ipChanged = (existing && existing.lastKnownIp !== ip) || (currentIp && currentIp !== ip);
        if (ipChanged) {
            console.log(`[Link] Paired peer ${displayName} (${peerIdentity.deviceId.slice(0, 8)}) changed IP to ${ip}`);
            deviceManager.trustStore.updateLastKnownIp(peerIdentity.deviceId, ip);
            deviceManager.broadcastPoolSync();
            // Notify the frontend of the updated IP address
            mainWindow?.webContents.send('device-discovered', info);
            if (currentIp && currentIp !== ip) {
                console.log(`[Link] Closing stale connection to peer ${peerIdentity.deviceId.slice(0, 8)} at old IP ${currentIp}`);
                deviceManager.closeConnection(peerIdentity.deviceId);
            }
        }
        // Auto-connect to trusted peers whenever we hear them
        if (!deviceManager.hasPeer(peerIdentity.deviceId) &&
            !connectingDeviceIds.has(peerIdentity.deviceId) &&
            canAttemptConnect(peerIdentity.deviceId)) {
            connectingDeviceIds.add(peerIdentity.deviceId);
            console.log(`[Link] Discovered trusted peer ${peerIdentity.deviceName} at ${ip}. Connecting...`);
            deviceManager.connectTo(ip).then(() => {
                clearConnectBackoff(peerIdentity.deviceId);
            }).catch((err) => {
                // Ignore connection failures (common if peer went offline or is not listening yet)
                recordConnectFailure(peerIdentity.deviceId);
            }).finally(() => {
                connectingDeviceIds.delete(peerIdentity.deviceId);
            });
        }
    }, (expiredDeviceId) => {
        discoveredUnpairedPeers.delete(expiredDeviceId);
        mainWindow?.webContents.send('device-expired', expiredDeviceId);
        // A peer has not sent a UDP broadcast for PEER_EXPIRY_MS — it either turned off visibility
        // or went offline. Close the TCP connection only if they are NOT a trusted/paired device
        const peer = deviceManager.connectedPeers().find(p => p.identity.deviceId === expiredDeviceId);
        if (peer && !peer.trusted) {
            console.log(`[Link] Closing stale connection to undiscoverable peer ${expiredDeviceId.slice(0, 8)}`);
            deviceManager.closeConnection(expiredDeviceId);
        }
    });
    discoveryService.start(visibilityEnabled);
    let lastLocalIps = [];
    function getMyLocalIps() {
        const ips = [];
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const net of interfaces[name] || []) {
                if (net.family === 'IPv4' && !net.internal) {
                    ips.push(net.address);
                }
            }
        }
        return ips.sort();
    }
    function getSubnetIPs() {
        const ips = [];
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const net of interfaces[name] || []) {
                if (net.family === 'IPv4' && !net.internal) {
                    if (net.netmask === '255.255.255.0') {
                        const parts = net.address.split('.');
                        const prefix = parts.slice(0, 3).join('.');
                        const myLastOctet = parseInt(parts[3], 10);
                        for (let i = 1; i <= 254; i++) {
                            if (i !== myLastOctet) {
                                ips.push(`${prefix}.${i}`);
                            }
                        }
                    }
                }
            }
        }
        return ips;
    }
    function scanSubnet() {
        const targets = getSubnetIPs();
        if (targets.length === 0)
            return;
        console.log(`[Link] LAN change detected or startup: scanning subnet of ${targets.length} IPs...`);
        targets.forEach((ip) => {
            const socket = net.connect({ host: ip, port: 1714, timeout: 1000 }, () => {
                socket.destroy();
                console.log(`[Link] Subnet scan found active listener at ${ip}. Connecting...`);
                deviceManager.connectTo(ip).catch(() => { });
            });
            socket.on('error', () => { });
        });
    }
    function attemptTrustedReconnects() {
        const currentIps = getMyLocalIps();
        const ipChange = JSON.stringify(currentIps) !== JSON.stringify(lastLocalIps);
        if (ipChange) {
            lastLocalIps = currentIps;
            scanSubnet();
        }
        const targets = [
            ...trustStore.list().filter((d) => d.lastKnownIp).map((d) => ({ deviceId: d.deviceId, ip: d.lastKnownIp })),
        ];
        targets.forEach((target, idx) => {
            if (deviceManager.hasPeer(target.deviceId) || connectingDeviceIds.has(target.deviceId) || !canAttemptConnect(target.deviceId))
                return;
            setTimeout(() => {
                if (deviceManager.hasPeer(target.deviceId) || connectingDeviceIds.has(target.deviceId))
                    return;
                connectingDeviceIds.add(target.deviceId);
                deviceManager.connectTo(target.ip).then(() => {
                    clearConnectBackoff(target.deviceId);
                }).catch(() => {
                    recordConnectFailure(target.deviceId);
                }).finally(() => {
                    connectingDeviceIds.delete(target.deviceId);
                });
            }, idx * 250);
        });
    }
    triggerReconnect = attemptTrustedReconnects;
    attemptTrustedReconnects();
    setInterval(attemptTrustedReconnects, 10000);
    electron_1.ipcMain.handle('get-discovered-devices', () => {
        return Array.from(discoveredUnpairedPeers.values());
    });
    // Start high-speed UDP input relay server
    try {
        inputUdpSocket = dgram.createSocket('udp4');
        inputUdpSocket.on('message', (msg, rinfo) => {
            if (isBlocked(rinfo.address))
                return;
            const line = msg.toString('utf8').trim();
            if (line.startsWith('js ')) {
                const ip = rinfo.address;
                if (joystickHandler.isControllerConnected(ip)) {
                    joystickHandler.handleStickState(ip, line.slice(3));
                }
                return;
            }
            // This fast-path relay has no packet envelope/deviceId of its own — unlike every other
            // plugin, a raw UDP packet here previously trusted ANY sender on the LAN, regardless of
            // pairing or per-device permission. Identify the sender by source IP against the currently
            // trusted+connected peer list, and gate exactly like the TLS-side session packets do.
            const senderId = deviceManager.deviceIdForAddress(rinfo.address);
            if (!senderId || isBlocked(senderId))
                return;
            if (line.startsWith('pmove ')) {
                if (!(0, permissions_1.checkDevicePermission)(senderId, 'presenter'))
                    return;
                const parts = line.split(' ');
                const dx = parseFloat(parts[1]);
                const dy = parseFloat(parts[2]);
                showPresenterDot(dx, dy);
            }
            else if (line.startsWith('dig ')) {
                if (!(0, permissions_1.checkDevicePermission)(senderId, 'digitizer'))
                    return;
                const parts = line.split(' ');
                const x = parseFloat(parts[1]);
                const y = parseFloat(parts[2]);
                const touching = parts[3] === 'true';
                const w = digitizerHandler.width || 1;
                const h = digitizerHandler.height || 1;
                const rx = Math.max(0, Math.min(1.0, x / w));
                const ry = Math.max(0, Math.min(1.0, y / h));
                // Map the normalized touch point onto the TARGET display's pixel bounds and position via
                // SetCursorPos (setpos), so the digitizer draws on the chosen monitor rather than being
                // locked to the primary one (which mouse_event's ABSOLUTE flag would force).
                const d = getTargetDisplay();
                const px = Math.round((d.bounds.x + rx * d.bounds.width) * d.scaleFactor);
                const py = Math.round((d.bounds.y + ry * d.bounds.height) * d.scaleFactor);
                touchpadHandler.writeCommand(`setpos ${px} ${py}`);
                touchpadHandler.writeCommand(`touch ${touching}`);
            }
            else if (line === 'undo' || line === 'redo') {
                // Digitizer toolbar's undo/redo — gated by the SAME digitizer permission as the pen
                // input above (not touchpad), since it's a digitizer-session action, not a mouse one.
                if (!(0, permissions_1.checkDevicePermission)(senderId, 'digitizer'))
                    return;
                touchpadHandler.writeCommand(line);
            }
            else if (line.startsWith('special ')) {
                // Shared by Presenter's nav keys (Next/Prev/Fullscreen/Exit) and Remote Input's
                // specialKey letters (DELETE/arrows/Enter/Escape/Ctrl-combos) — accept either permission
                // so granting Presenter alone is enough to use its own nav buttons, matching pmove above.
                if (!(0, permissions_1.checkDevicePermission)(senderId, 'remoteinput') && !(0, permissions_1.checkDevicePermission)(senderId, 'presenter'))
                    return;
                touchpadHandler.writeCommand(line);
            }
            else {
                if (!(0, permissions_1.checkDevicePermission)(senderId, 'remoteinput'))
                    return;
                touchpadHandler.writeCommand(line);
            }
        });
        inputUdpSocket.bind(1717, '0.0.0.0', () => {
            console.log('[Link] High-speed UDP Input Relay listening on port 1717');
        });
    }
    catch (err) {
        console.error('[Link] Failed to start UDP Input Relay:', err);
    }
    deviceManager.on('deviceConnected', (peerIdentity, trusted) => {
        if (isBlocked(peerIdentity.deviceId)) {
            deviceManager.closeConnection(peerIdentity.deviceId);
            return;
        }
        let displayName = peerIdentity.deviceName;
        if (trusted) {
            const trustedDev = deviceManager.trustStore.get(peerIdentity.deviceId);
            if (trustedDev) {
                displayName = trustedDev.deviceName;
            }
        }
        const remoteIp = deviceManager.remoteAddressOf(peerIdentity.deviceId);
        if (trusted && remoteIp) {
            const existing = deviceManager.trustStore.get(peerIdentity.deviceId);
            const ipChanged = existing && existing.lastKnownIp !== remoteIp;
            deviceManager.trustStore.updateLastKnownIp(peerIdentity.deviceId, remoteIp);
            if (ipChanged) {
                deviceManager.broadcastPoolSync();
            }
        }
        if (trusted) {
            const allPerms = (0, permissions_1.getAllPermissions)();
            if (!allPerms[peerIdentity.deviceId]) {
                console.log(`[Link] Auto-initializing denied permissions for newly connected pool device ${peerIdentity.deviceId.slice(0, 8)}`);
                (0, permissions_1.initializeDeniedPermissionsForNewDevice)(peerIdentity.deviceId);
            }
        }
        const modifiedIdentity = {
            ...peerIdentity,
            deviceName: displayName,
            ipAddress: remoteIp || undefined
        };
        send('device-connected', modifiedIdentity, trusted);
        if (trusted) {
            sendInitialSync(peerIdentity.deviceId);
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
            send('device-mount-changed', deviceId, undefined);
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
        // Joystick is IP-identified, not deviceId-identified (see joystick.ts) — a paired device's
        // pairing state has no bearing on any joystick controller slot, so there's nothing to clean
        // up here; a stale controller is instead caught by JoystickHandler's own liveness sweep.
        updateScreensaverInhibition();
    });
    deviceManager.on('unpaired', (deviceId) => {
        (0, permissions_1.deletePermissionsForDevice)(deviceId);
        peerCapabilities.delete(deviceId);
        peerCommandLists.delete(deviceId);
        send('unpaired', { deviceId });
    });
    deviceManager.on('incomingPairRequest', (deviceId, deviceName, deviceType, verificationKey) => {
        if (isBlocked(deviceId)) {
            deviceManager.rejectPairing(deviceId);
            return;
        }
        send('incoming-pair-request', deviceId, deviceName, deviceType, verificationKey);
    });
    deviceManager.on('pairingSuccessful', (deviceId) => {
        (0, permissions_1.initializeDeniedPermissionsForNewDevice)(deviceId);
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
    deviceManager.on('trustListUpdated', () => {
        attemptTrustedReconnects();
    });
    // Each packet type gets its own named handler below (previously one 350-line if-else chain) —
    // purely organizational, same closure scope (still nested in initCore) and identical dispatch
    // order/logic, so behavior is unchanged. Lets the dispatcher itself read as a scannable list of
    // "packet type -> handler" instead of one monolithic block.
    function handleClipboardTextPacket(deviceId, packet) {
        if (!isEnabled('Clipboard'))
            return;
        // No receive-side gate — Clipboard is sending-only now (see canSendClipboardTo): the peer
        // already decided whether to share via their own outbound permission-for-us.
        const text = (0, clipboard_1.extractIncomingClipboardText)(packet, lastKnownClipboardTimestamp);
        if (text !== null) {
            clipboardWatcher.applyRemote(text);
            lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
            send('clipboard-received', deviceId);
        }
    }
    function handleBatteryPacket(deviceId, packet) {
        const body = packet.body;
        send('battery-received', deviceId, body.isCharging, body.currentCharge);
    }
    function handleFindMyPhonePacket(deviceId, packet) {
        // No kill-switch or per-device permission gate — ring is inherently available to any
        // connected, trusted device, same as rename.
        const body = packet.body;
        if (body && body.cancel) {
            (0, findmydevice_1.stopRinging)();
            if (ringTimeoutMain) {
                clearTimeout(ringTimeoutMain);
                ringTimeoutMain = null;
            }
            activeRingerDeviceId = null;
            send('find-my-phone-stopped', deviceId);
        }
        else {
            activeRingerDeviceId = deviceId;
            (0, findmydevice_1.ringThisDevice)();
            send('find-my-phone-triggered', deviceId);
            if (ringTimeoutMain)
                clearTimeout(ringTimeoutMain);
            ringTimeoutMain = setTimeout(() => {
                if (activeRingerDeviceId) {
                    deviceManager.sendTo(activeRingerDeviceId, (0, findmydevice_1.createFindMyDevicePacket)(true));
                    send('find-my-phone-stopped', activeRingerDeviceId);
                    activeRingerDeviceId = null;
                }
            }, 60000);
        }
    }
    function handleRunCommandRequestPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'runcommand')) {
            console.log(`[Link] Blocked Run Command request from ${deviceId} (Permission disabled)`);
            return;
        }
        const response = runCommandManager.handleRunCommandRequest(packet);
        if (response)
            deviceManager.sendTo(deviceId, response);
        const body = packet.body;
        if (body.key)
            send('run-command-triggered', deviceId, body.key);
    }
    function handleRunCommandListPacket(deviceId, packet) {
        // Incoming FROM a peer — we're the requester here (mesh case: viewing a paired desktop's
        // panel from either a desktop or mobile app). Distinct from the handler above, where we're
        // the executor serving our OWN list to a peer.
        const body = packet.body;
        try {
            const list = JSON.parse(body.commandList);
            peerCommandLists.set(deviceId, list);
            send('command-list-received', deviceId, list);
        }
        catch (err) {
            console.error('[Link] Failed to parse peer command list:', err);
        }
    }
    function handlePresenterPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'presenter')) {
            console.log(`[Link] Blocked Presenter packet from ${deviceId} (Permission disabled)`);
            return;
        }
        if ((0, presenter_1.isPresenterStopPacket)(packet)) {
            hidePresenterDot();
        }
        else {
            const body = packet.body;
            showPresenterDot(body.dx, body.dy);
        }
    }
    function handleSystemVolumeRequestPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'systemvolume')) {
            console.log(`[Link] Blocked System Volume request from ${deviceId} (Permission disabled)`);
            return;
        }
        (async () => {
            const result = await (0, systemvolume_1.handleSystemVolumeRequest)(packet);
            if (result)
                deviceManager.sendTo(deviceId, (0, systemvolume_1.createSystemVolumePacket)(result));
        })();
    }
    function handleSystemVolumePacket(deviceId, packet) {
        mainWindow?.webContents.send('system-volume-received', deviceId, packet.body);
    }
    function handleLockRequestPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'lock')) {
            console.log(`[Link] Blocked Lock request from ${deviceId} (Permission disabled)`);
            return;
        }
        const body = packet.body;
        if (body.setLocked) {
            (0, lock_1.lockThisDevice)().then((success) => {
                deviceManager.sendTo(deviceId, (0, lock_1.createLockPacket)((0, lock_1.isLocalDeviceLocked)(), success));
            });
        }
        else {
            // Either an explicit status query, or (defensively) a setLocked:false "unlock" request —
            // no mainstream OS exposes a way to unlock a screen without the user's real credentials,
            // so there is nothing to do for that case. Always reply with the REAL current state
            // instead of silently ignoring it, which previously left the requester's optimistic
            // "unlocked" UI permanently stuck out of sync since no reply ever arrived to correct it.
            deviceManager.sendTo(deviceId, (0, lock_1.createLockPacket)((0, lock_1.isLocalDeviceLocked)()));
        }
    }
    function handleLockPacket(deviceId, packet) {
        const body = packet.body;
        if (body.isLocked !== undefined) {
            send('lock-state-received', deviceId, body.isLocked);
        }
        if (body.lockResult !== undefined) {
            send('lock-result-received', deviceId, body.lockResult);
        }
    }
    function handleFlashlightPacket(deviceId, packet) {
        // Pure incoming state display, not an executable command (desktop has no flashlight to
        // control) — the sender already gates whether they broadcast this to us at all, matching
        // how system volume/MPRIS state receipt isn't re-checked here either. `revoked` is a
        // silent marker the sender sets when our permission just got turned off on their end — it
        // tells the renderer to clear its cached state instead of displaying stale data forever.
        const flashlightBody = packet.body;
        send('flashlight-state-received', deviceId, flashlightBody.enabled, !!flashlightBody.revoked);
    }
    function handleDNDPacket(deviceId, packet) {
        const dndBody = packet.body;
        send('dnd-state-received', deviceId, dndBody.enabled, dndBody.granted, !!dndBody.revoked);
    }
    function handleCapabilitiesPacket(deviceId, packet) {
        // Unified per-peer signal: exactly which of the peer's gated capabilities we're currently
        // allowed to use. The renderer gates every button/section on membership in this list —
        // no per-plugin revoke marker needed, since a key's absence hides it regardless of whatever
        // stale value is still cached from before.
        const body = packet.body;
        const caps = body.capabilities || [];
        const oldCaps = peerCapabilities.get(deviceId) || [];
        peerCapabilities.set(deviceId, caps); // cache for renderer-reload re-hydration (see map decl)
        send('peer-capabilities-received', deviceId, caps);
        const fileaccessWasAllowed = oldCaps.includes('fileaccess');
        const fileaccessNowAllowed = caps.includes('fileaccess');
        if (!fileaccessNowAllowed && fileaccessWasAllowed) {
            const mountService = fsMountServices.get(deviceId);
            if (mountService) {
                mountService.unmount();
                fsMountServices.delete(deviceId);
                send('device-mount-changed', deviceId, undefined);
                console.log(`[Link] Unmounted filesystem for ${deviceId} — peer fileaccess capability revoked.`);
            }
            const fsClient = fsClients.get(deviceId);
            if (fsClient) {
                fsClient.disconnect();
                fsClients.delete(deviceId);
            }
            socketFsClients.delete(deviceId);
        }
        else if (fileaccessNowAllowed && !fileaccessWasAllowed && deviceMountEnabled[deviceId] !== false) {
            const peer = deviceManager.connectedPeers().find((p) => p.identity.deviceId === deviceId);
            const host = deviceManager.remoteAddressOf(deviceId);
            if (peer && host) {
                mountFilesystemForDevice(peer.identity, host);
            }
        }
    }
    function handleRenameRequestPacket(deviceId, packet) {
        // Rename isn't gated by the test.txt kill-switch — it's inherently available on any valid
        // connection, not an optional plugin. A peer asked US to rename ourselves. Device names are self-owned (matches the identity
        // model), so apply it locally and then broadcast the authoritative result to every
        // connected peer — including back to the requester — instead of letting a remote device
        // silently overwrite our identity without us re-announcing it.
        const requestedName = (0, identity_1.saveDeviceName)(configDir, packet.body.deviceName);
        identity.deviceName = requestedName;
        send('own-device-renamed', requestedName);
        const renamePacket = (0, rename_1.createRenamePacket)(requestedName);
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, renamePacket);
        }
    }
    function handleRenamePacket(deviceId, packet) {
        // Authoritative name change from a peer (either it renamed itself locally, or it just
        // accepted a rename request from us or someone else) — sync our local trust-store alias
        // and reflect it live without needing a reconnect.
        deviceManager.trustStore.rename(deviceId, packet.body.deviceName);
        deviceManager.updatePeerName(deviceId, packet.body.deviceName);
        send('device-renamed', deviceId, packet.body.deviceName);
    }
    function handleConnectivityPacket(deviceId, packet) {
        const body = packet.body;
        send('connectivity-received', deviceId, body.signalStrengths);
    }
    function handleTouchpadRequestPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'remoteinput'))
            return;
        touchpadHandler.handleRequest(packet);
    }
    function handleDigitizerSessionPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'digitizer'))
            return;
        digitizerHandler.handleSession(packet);
    }
    function handleDigitizerPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'digitizer'))
            return;
        digitizerHandler.handleEvent(packet);
    }
    function handleMprisStatePacket(deviceId, packet) {
        send('mpris-state-received', deviceId, packet.body);
    }
    function handleMprisRequestPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'mpris')) {
            console.log(`[Link] Blocked MPRIS request from ${deviceId} (Permission disabled)`);
            return;
        }
        const body = packet.body;
        (async () => {
            if (body.action) {
                await (0, mpris_1.controlMpris)(body.player || '', body.action);
            }
            const sessions = await (0, mpris_1.queryMprisSessions)();
            const statePacket = (0, mpris_1.createMprisStatePacket)(sessions);
            // Outbound gate — a peer denied 'mpris' shouldn't passively learn what's currently playing
            // just because someone else (permitted) triggered this broadcast.
            broadcastToPermittedPeers('mpris', statePacket);
        })();
    }
    let telephonyRingProcess = null;
    let telephonyRingTimeout = null;
    function stopTelephonyRinging() {
        if (telephonyRingTimeout) {
            clearTimeout(telephonyRingTimeout);
            telephonyRingTimeout = null;
        }
        if (telephonyRingProcess) {
            if (telephonyRingProcess.pid) {
                try {
                    const { execSync } = require('child_process');
                    execSync(`taskkill /pid ${telephonyRingProcess.pid} /t /f`, { stdio: 'ignore' });
                }
                catch (e) { }
            }
            try {
                telephonyRingProcess.kill('SIGKILL');
            }
            catch (e) { }
            telephonyRingProcess = null;
        }
    }
    function startTelephonyRinging() {
        stopTelephonyRinging();
        const { exec } = require('child_process');
        const ringtonePath = 'C:\\Windows\\Media\\Alarm01.wav';
        telephonyRingProcess = exec(`powershell -NoProfile -Command "$sound = New-Object Media.SoundPlayer '${ringtonePath}'; while ($true) { $sound.PlaySync() }"`);
        telephonyRingTimeout = setTimeout(() => {
            stopTelephonyRinging();
        }, 60000);
    }
    function handleTelephonyPacket(deviceId, packet) {
        // No receive-side gate — Telephony is owned by the sending phone, which already decided
        // (via its own outbound permission-for-us) whether to share this. Desktop never gets its
        // own say; it's a pure display, same as Flashlight/DND's receive side.
        const body = packet.body;
        const isCancel = body.isCancel === 'true' || body.isCancel === true;
        (async () => {
            const sessions = await (0, mpris_1.queryMprisSessions)();
            const isAnyPlaying = sessions.some(s => s.isPlaying);
            const pauseMusicAction = pauseMusicController.onCallStateChanged(body.event, isCancel, isAnyPlaying);
            if (pauseMusicAction) {
                const action = pauseMusicAction === 'pause' ? 'Pause' : 'Play';
                await (0, mpris_1.controlMpris)('', action);
                const updatedSessions = await (0, mpris_1.queryMprisSessions)();
                const statePacket = (0, mpris_1.createMprisStatePacket)(updatedSessions);
                broadcastToPermittedPeers('mpris', statePacket);
            }
        })();
        if (isCancel || body.event === 'cancelled' || body.event === 'talking') {
            stopTelephonyRinging();
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
                    const decoded = electron_1.nativeImage.createFromBuffer(Buffer.from(body.iconBase64, 'base64'));
                    if (!decoded.isEmpty())
                        callIcon = decoded;
                }
                catch {
                    // Malformed icon data from the peer — fall back to the generic call icon.
                }
            }
            if (body.event === 'ringing') {
                const active = activeNotifications.get(deviceId);
                if (active)
                    active.close();
                startTelephonyRinging();
                const name = body.contactName || body.phoneNumber || 'Unknown Caller';
                const details = body.phoneNumber ? `Ringing: ${body.phoneNumber}` : 'Incoming Call';
                const notification = new electron_1.Notification({
                    title: name,
                    body: details,
                    silent: false,
                    timeoutType: 'never',
                    icon: callIcon,
                });
                notification.show();
                activeNotifications.set(deviceId, notification);
            }
            else if (body.event === 'talking') {
                // Answered — was previously just closing the ringing notification here with no
                // replacement, so picking up the call gave no feedback at all. Swap it for an ongoing
                // "on call" notification instead; only 'cancelled'/isCancel above removes it now.
                const active = activeNotifications.get(deviceId);
                if (active)
                    active.close();
                const name = body.contactName || body.phoneNumber || 'Unknown Caller';
                const details = body.phoneNumber ? `On call — ${body.phoneNumber}` : 'On call';
                const notification = new electron_1.Notification({
                    title: name,
                    body: details,
                    silent: true,
                    timeoutType: 'never',
                    icon: callIcon,
                });
                notification.show();
                activeNotifications.set(deviceId, notification);
            }
            else if (body.event === 'missedCall') {
                const name = body.contactName || body.phoneNumber || 'Unknown Caller';
                const details = body.phoneNumber ? `Missed call from: ${body.phoneNumber}` : 'Missed Call';
                new electron_1.Notification({
                    title: name,
                    body: details,
                    silent: false,
                    icon: callIcon,
                }).show();
            }
        }
    }
    function handleNotificationPacket(deviceId, packet) {
        // No receive-side gate — same reasoning as Telephony above: the sending phone already
        // decided whether to share this via its own outbound permission-for-us.
        const body = packet.body;
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
        }
        else {
            send('notification-received', deviceId, body);
            const active = activeAppNotifications.get(key);
            if (active)
                active.close();
            const title = body.title || body.appName || 'Notification';
            const text = body.text || body.ticker || '';
            // Show device name + app name in subtitle for multi-phone users
            const peerName = body.sourceDeviceName || deviceId.slice(0, 8);
            const subtitle = body.title ? `${peerName} • ${body.appName}` : peerName;
            // Prefer the originating app's own icon (e.g. WhatsApp's icon) when the phone sent one,
            // falling back to the Link app icon if it didn't resolve one.
            let notificationIcon = appIconImg;
            if (body.iconBase64) {
                try {
                    const decoded = electron_1.nativeImage.createFromBuffer(Buffer.from(body.iconBase64, 'base64'));
                    if (!decoded.isEmpty())
                        notificationIcon = decoded;
                }
                catch {
                    // Malformed icon data from the peer — fall back to the app icon rather than failing
                    // to show the notification at all.
                }
            }
            const notification = new electron_1.Notification({
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
    function handleFsRequestPacket(deviceId, packet) {
        if (!(0, permissions_1.checkDevicePermission)(deviceId, 'fileaccess')) {
            deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.fs.response', {
                requestId: packet.body.requestId,
                success: false,
                error: 'Permission denied: File access is disabled.',
            }));
            return;
        }
        const body = packet.body;
        (async () => {
            try {
                const result = await handleFsRequest(body);
                deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.fs.response', {
                    requestId: body.requestId,
                    success: true,
                    result,
                }));
            }
            catch (err) {
                deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.fs.response', {
                    requestId: body.requestId,
                    success: false,
                    error: err.message,
                }));
            }
        })();
    }
    function handleFsResponsePacket(deviceId, packet) {
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
            if ((0, permissions_1.checkDevicePermission)(deviceId, 'presenter') || (0, permissions_1.checkDevicePermission)(deviceId, 'digitizer')) {
                cycleTargetDisplay();
            }
            return;
        }
        if ((0, clipboard_1.isClipboardPacket)(packet)) {
            handleClipboardTextPacket(deviceId, packet);
        }
        else if ((0, battery_1.isBatteryPacket)(packet)) {
            handleBatteryPacket(deviceId, packet);
        }
        else if ((0, findmydevice_1.isFindMyDevicePacket)(packet)) {
            handleFindMyPhonePacket(deviceId, packet);
        }
        else if ((0, runcommand_1.isRunCommandRequestPacket)(packet)) {
            handleRunCommandRequestPacket(deviceId, packet);
        }
        else if ((0, runcommand_1.isRunCommandListPacket)(packet)) {
            handleRunCommandListPacket(deviceId, packet);
        }
        else if ((0, presenter_1.isPresenterPacket)(packet)) {
            handlePresenterPacket(deviceId, packet);
        }
        else if ((0, systemvolume_1.isSystemVolumeRequestPacket)(packet)) {
            handleSystemVolumeRequestPacket(deviceId, packet);
        }
        else if ((0, systemvolume_1.isSystemVolumePacket)(packet)) {
            handleSystemVolumePacket(deviceId, packet);
        }
        else if ((0, lock_1.isLockRequestPacket)(packet)) {
            handleLockRequestPacket(deviceId, packet);
        }
        else if ((0, lock_1.isLockPacket)(packet)) {
            handleLockPacket(deviceId, packet);
        }
        else if ((0, flashlight_1.isFlashlightPacket)(packet)) {
            handleFlashlightPacket(deviceId, packet);
        }
        else if ((0, dnd_1.isDNDPacket)(packet)) {
            handleDNDPacket(deviceId, packet);
        }
        else if ((0, capabilities_1.isCapabilitiesPacket)(packet)) {
            handleCapabilitiesPacket(deviceId, packet);
        }
        else if ((0, rename_1.isRenameRequestPacket)(packet)) {
            handleRenameRequestPacket(deviceId, packet);
        }
        else if ((0, rename_1.isRenamePacket)(packet)) {
            handleRenamePacket(deviceId, packet);
        }
        else if ((0, connectivity_1.isConnectivityPacket)(packet)) {
            handleConnectivityPacket(deviceId, packet);
        }
        else if ((0, touchpad_1.isTouchpadRequestPacket)(packet)) {
            handleTouchpadRequestPacket(deviceId, packet);
        }
        else if ((0, digitizer_1.isDigitizerSessionPacket)(packet)) {
            handleDigitizerSessionPacket(deviceId, packet);
        }
        else if ((0, digitizer_1.isDigitizerPacket)(packet)) {
            handleDigitizerPacket(deviceId, packet);
        }
        else if (packet.type === 'link.mpris') {
            handleMprisStatePacket(deviceId, packet);
        }
        else if ((0, mpris_1.isMprisRequestPacket)(packet)) {
            handleMprisRequestPacket(deviceId, packet);
        }
        else if ((0, telephony_1.isTelephonyPacket)(packet)) {
            handleTelephonyPacket(deviceId, packet);
        }
        else if ((0, notification_1.isNotificationPacket)(packet)) {
            handleNotificationPacket(deviceId, packet);
        }
        else if (packet.type === 'link.notification.broadcast') {
            // Mesh-wide notification sync from pool members
            console.log('[Link] Received mesh notification broadcast from', deviceId, ':', packet.body.title);
            send('notification-broadcast-received', deviceId, packet.body);
        }
        else if (packet.type === 'link.fs.request') {
            handleFsRequestPacket(deviceId, packet);
        }
        else if (packet.type === 'link.fs.response') {
            handleFsResponsePacket(deviceId, packet);
        }
        else if (packet.type === 'link.speedtest.request') {
            speedTestManager.handleIncomingRequest(packet, deviceId);
        }
        else if (packet.type === 'link.speedtest.response') {
            speedTestManager.handleResponse(packet);
        }
        else if (packet.type === 'link.audiosink.started') {
            // Resolve the host's IP here, main-process-side — this is the one place it's actually
            // known (deviceManager.remoteAddressOf); the renderer only ever gets a deviceId otherwise.
            const host = deviceManager.remoteAddressOf(deviceId);
            if (host)
                send('audio-sink-paired-session-started', deviceId, packet.body.token, host);
        }
        else if (packet.type === 'link.audiosink.ended') {
            send('audio-sink-paired-session-ended', deviceId);
        }
        else if (packet.type === 'link.audiosink.query') {
            // A peer asking "are you currently hosting?" — sent when their Audio Sink tab opens, so a
            // session that started before they were connected/looking doesn't just get silently missed
            // (the original 'started' broadcast only ever reaches whoever was connected AND had the
            // tab open at that exact moment — no way to catch up otherwise). Answer with the exact same
            // 'started' packet + a freshly minted token, reusing the normal path one level up.
            if (audioSinkServer) {
                const token = audioSinkServer.issueToken(deviceId, deviceManager.trustStore.get(deviceId)?.deviceName || deviceId);
                deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.audiosink.started', { token, port: transport_1.AUDIO_SINK_PORT }));
            }
        }
        else if (packet.type === 'link.remotemic.started') {
            const host = deviceManager.remoteAddressOf(deviceId);
            if (host)
                send('remote-mic-paired-session-started', deviceId, packet.body.token, host);
        }
        else if (packet.type === 'link.remotemic.ended') {
            send('remote-mic-paired-session-ended', deviceId);
        }
        else if (typeof packet.type === 'string' && packet.type.startsWith('link.walkietalkie.')) {
            // Generic signaling relay — session membership (start/query/join/leave/member-*) and WebRTC
            // negotiation (SDP offer/answer, ICE candidates) are all plain JSON bodies whose actual
            // meaning is only interpreted in WalkieTalkieTab.tsx (shared between desktop and mobile).
            // main.ts's only job is forwarding: it never parses these bodies or holds any session state
            // itself, since the real media is WebRTC (peer-to-peer, not routed through this app at all)
            // — only the signaling needs to ride over the existing trusted connection. No per-device
            // permission gate — same as Joystick: pairing itself is the trust decision for this
            // ephemeral session tool, not a standing capability to grant/deny separately.
            if (isBlocked(deviceId))
                return;
            send('walkie-talkie-signal', deviceId, packet.type, packet.body);
        }
        // No 'link.remotemic.query' reply here — desktop never hosts Remote Mic (see remoteMicClient's
        // declaration comment), so there's nothing to answer a peer's "are you hosting?" query with.
    });
    clipboardWatcher = new clipboard_1.ClipboardWatcher(async (type, data) => {
        lastKnownClipboardTimestamp = clipboardWatcher.currentTimestamp();
        if (!isEnabled('Clipboard'))
            return;
        if (type === 'text') {
            const content = data;
            broadcastToPermittedPeers('clipboard', (0, clipboard_1.createClipboardPacket)(content));
        }
    });
    batteryWatcher = new battery_1.BatteryWatcher(({ isCharging, currentCharge }) => {
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, (0, battery_1.createBatteryPacket)(isCharging, currentCharge));
        }
    });
    volumeWatcher = new systemvolume_1.VolumeWatcher((sinks) => {
        // Outbound gate — a peer denied 'systemvolume' shouldn't passively see live sink/volume
        // levels just because they're connected.
        broadcastToPermittedPeers('systemvolume', (0, systemvolume_1.createSystemVolumePacket)(sinks));
    });
    // Reflect real OS lock/unlock state in real time (not just Link-triggered locks), matching
    // the volume watcher's model: detect actual state changes and push to every connected peer.
    electron_1.powerMonitor.on('lock-screen', () => {
        (0, lock_1.setLocalLockedState)(true);
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, (0, lock_1.createLockPacket)(true));
        }
    });
    electron_1.powerMonitor.on('unlock-screen', () => {
        (0, lock_1.setLocalLockedState)(false);
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, (0, lock_1.createLockPacket)(false));
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
const appIconImg = electron_1.nativeImage.createFromPath(appIconPath);
// Generic call-icon for incoming/missed-call notifications — showing the Link app logo there
// would misleadingly imply the notification is about the app itself rather than a phone call.
// Used as the fallback when the peer didn't resolve a contact photo for this caller.
const callIconImg = electron_1.nativeImage.createFromPath(path.join(__dirname, '../../call-icon.png'));
function createWindow() {
    const iconImg = appIconImg;
    mainWindow = new electron_1.BrowserWindow({
        width: 480,
        height: 640,
        // No floor previously existed, so the window could be dragged down to whatever the OS
        // allows — well past the point text and controls stop being usable. Kept at/below the
        // default launch size (480x640) so this never forces a resize on a normal start; it only
        // stops the user from going smaller than that. The sidebar already collapses to a bottom
        // nav bar under 768px via index.css's existing @media rule, so this floor doesn't need to
        // clear that breakpoint — dialogs inside it (e.g. File Transfer's QR/Connect split) handle
        // their own narrow-width stacking via CSS container queries (see .fx-split in index.css).
        minWidth: 420,
        minHeight: 480,
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
                }
                catch { /* balloons unsupported on this platform/build */ }
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
    mainWindow.webContents.on('did-finish-load', () => {
        console.log('[Link] mainWindow webContents successfully finished loading');
    });
    if (process.argv.includes('--dev')) {
        console.log('[Link] Dev mode: Loading http://localhost:5173');
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
            console.warn(`[Link] Dev server load failed (${code}: ${desc}), retrying in 500ms...`);
            setTimeout(() => {
                mainWindow?.loadURL('http://localhost:5173');
            }, 500);
        });
    }
    else {
        console.log('[Link] Prod mode: Loading index.html');
        mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
    mainWindow.once('ready-to-show', () => {
        console.log('[Link] mainWindow ready-to-show fired');
        mainWindow?.show();
        mainWindow?.focus();
    });
    mainWindow.show();
    mainWindow.focus();
}
/** Bring the main window back from the tray (or rebuild it if it was fully closed). */
function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }
    if (mainWindow.isMinimized())
        mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}
/** Create the system-tray icon + menu once. Clicking it reopens the window; Quit does a real quit. */
function createTray() {
    if (tray)
        return;
    try {
        const trayIcon = appIconImg.isEmpty() ? appIconImg : appIconImg.resize({ width: 16, height: 16 });
        tray = new electron_1.Tray(trayIcon);
        tray.setToolTip('Link');
        rebuildTrayMenu();
        // Left-click (Windows) / click the icon to reopen — the expected tray affordance.
        tray.on('click', () => showMainWindow());
    }
    catch (err) {
        console.error('[Link] Failed to create tray:', err);
    }
}
// Persistent controls for an active Audio Sink/Remote Mic session — the requested "persistent
// notification with mute/end/disconnect" feature, built on the tray menu rather than a native
// Windows toast: Electron's own Notification actions are macOS-only, and a real interactive
// Windows toast (button clicks routed back to the app) needs a registered AUMID + COM activator
// that only exists once this app has a proper installed shortcut — see docs/backlog.txt's
// "Inline reply from the DESKTOP native toast notification" entry, blocked on the same
// installer work. The tray icon is already always-present and persistent, so surfacing session
// controls there needs no new native plumbing and works today, unlike a real toast.
//
// Only host sessions (Audio Sink, Remote Mic) get a Mute/Unmute entry here — mute/unmute for a
// LISTENING session is a renderer-side Web Audio gain node (see AudioSinkTab/RemoteMicTab's
// PcmPlayer), not something the main process has a handle on, so listening sessions only get
// Disconnect from the tray (the in-app UI already has its own mute slider for that case).
function rebuildTrayMenu() {
    if (!tray)
        return;
    const sessionItems = [];
    if (audioSinkServer) {
        sessionItems.push({ label: `Audio Sink: Hosting${audioSinkServer.isMuted() ? ' (Muted)' : ''}`, enabled: false });
        sessionItems.push({
            label: audioSinkServer.isMuted() ? 'Unmute Audio Sink' : 'Mute Audio Sink',
            click: () => { audioSinkServer?.setMuted(!audioSinkServer.isMuted()); rebuildTrayMenu(); },
        });
        sessionItems.push({ label: 'End Audio Sink Session', click: () => { endAudioSink(); } });
        sessionItems.push({ type: 'separator' });
    }
    if (audioSinkClient) {
        sessionItems.push({ label: 'Audio Sink: Listening', enabled: false });
        sessionItems.push({
            label: 'Disconnect Audio Sink',
            click: () => { audioSinkClient?.disconnect(); audioSinkClient = null; send('audio-sink-ended'); rebuildTrayMenu(); },
        });
        sessionItems.push({ type: 'separator' });
    }
    if (remoteMicClient) {
        sessionItems.push({ label: 'Remote Mic: Listening', enabled: false });
        sessionItems.push({
            label: 'Disconnect Remote Mic',
            click: () => { remoteMicClient?.disconnect(); remoteMicClient = null; send('remote-mic-ended'); rebuildTrayMenu(); },
        });
        sessionItems.push({ type: 'separator' });
    }
    tray.setContextMenu(electron_1.Menu.buildFromTemplate([
        ...sessionItems,
        { label: 'Open Link', click: () => showMainWindow() },
        { type: 'separator' },
        { label: 'Quit Link', click: () => { isQuitting = true; electron_1.app.quit(); } },
    ]));
}
// Windows caches the taskbar icon by executable path. In dev mode every Electron project on
// this machine launches the exact same node_modules/electron/dist/electron.exe, so without a
// distinct identity Windows can show a stale/generic icon cached from another app's run. Setting
// our own AppUserModelID (matching package.json's build.appId) gives this app's taskbar entry
// its own identity instead of bucketing it under bare "electron.exe".
if (process.platform === 'win32') {
    electron_1.app.setAppUserModelId('in.rodix.link');
}
electron_1.app.whenReady().then(() => {
    console.log('[Link] app ready, initializing core...');
    const identity = initCore();
    console.log('[Link] identity:', identity);
    // ===== Identity & Device Discovery =====
    electron_1.ipcMain.handle('get-identity', () => {
        return {
            ...identity,
            ipAddress: getLocalIpAddress(),
            ipAddresses: getAllLocalIpAddresses(),
        };
    });
    electron_1.ipcMain.handle('get-trusted-devices', () => {
        try {
            return deviceManager.trustStore.list().map((d) => ({
                deviceId: d.deviceId,
                deviceName: d.deviceName,
                ipAddress: d.lastKnownIp || undefined,
                deviceType: 'phone', // default fallback, updated dynamically on connection
                trusted: true,
                connected: false,
            }));
        }
        catch (err) {
            console.error('[Link] Failed to list trusted devices:', err);
            return [];
        }
    });
    // Real current connection state — see DeviceManager.connectedPeers()'s comment for why the
    // renderer needs this in addition to get-trusted-devices (which always reports connected:false).
    // Flattened to match get-trusted-devices' shape (the renderer expects deviceId etc. at the top
    // level, not nested under an `identity` wrapper).
    electron_1.ipcMain.handle('get-connected-devices', () => {
        return deviceManager.connectedPeers().map(({ identity, trusted }) => {
            const trustedDev = deviceManager.trustStore.get(identity.deviceId);
            return {
                deviceId: identity.deviceId,
                deviceName: (trustedDev && trustedDev.deviceName) ? trustedDev.deviceName : identity.deviceName,
                deviceType: identity.deviceType,
                ipAddress: deviceManager.remoteAddressOf(identity.deviceId) || undefined,
                incomingCapabilities: identity.incomingCapabilities,
                outgoingCapabilities: identity.outgoingCapabilities,
                // Re-hydrate the peer's effective capabilities from the main-process cache so a renderer
                // reload restores gated-plugin visibility without waiting for the peer to re-push.
                allowedCapabilities: peerCapabilities.get(identity.deviceId) || [],
                driveLetter: fsMountServices.get(identity.deviceId)?.getDriveLetter() || undefined,
                trusted,
                connected: true,
            };
        });
    });
    // Re-runs the full initial-sync push (clipboard, battery, connectivity, volume, lock, MPRIS,
    // run command list) for every currently-connected trusted peer. sendInitialSync()
    // only ever fires once, at the moment a TCP connection is established — a renderer reload
    // (F5/Ctrl+R) wipes all that data from the UI's in-memory state without the connection itself
    // dropping, so nothing re-populates it until some unrelated future change happens to broadcast
    // again. Calling this on renderer mount closes that gap.
    electron_1.ipcMain.handle('resync-devices', () => {
        triggerReconnect?.();
        for (const deviceId of deviceManager.trustedConnectedDeviceIds()) {
            // Push OUR state to the peer (refreshes their view of us)...
            sendInitialSync(deviceId);
            // ...and PULL theirs: ask the peer to re-push its full state to us, so a reload repopulates
            // the peer's battery/volume/MPRIS/connectivity sections in one round-trip instead of
            // trickling in over ~10s as their periodic broadcasts happen to fire. The peer answers this
            // by running its own sendInitialSync toward us (see the 'link.resync.request' packet case).
            deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.resync.request', {}));
        }
    });
    electron_1.ipcMain.handle('open-app-settings', () => {
        return Promise.resolve(); // Stub resolved immediately on desktop
    });
    // ===== Permissions =====
    electron_1.ipcMain.handle('get-permissions', () => {
        return (0, permissions_1.getAllPermissions)();
    });
    electron_1.ipcMain.handle('set-permissions', (_e, permissions) => {
        try {
            const oldPermissions = (0, permissions_1.getAllPermissions)();
            (0, permissions_1.writeAllPermissions)(permissions);
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
                if (!deviceManager.trustedConnectedDeviceIds().includes(deviceId))
                    continue;
                (0, permissions_1.pushEffectiveCapabilities)(deviceId);
                const oldPerm = oldPermissions[deviceId] || {};
                const newPerm = permissions[deviceId] || {};
                const volumeWasAllowed = oldPerm.systemvolume !== false;
                const volumeNowAllowed = newPerm.systemvolume !== false;
                if (volumeNowAllowed && !volumeWasAllowed) {
                    const volumeSnapshot = volumeWatcher.current();
                    if (volumeSnapshot && volumeSnapshot.length > 0) {
                        deviceManager.sendTo(deviceId, (0, systemvolume_1.createSystemVolumePacket)(volumeSnapshot));
                    }
                }
                const mprisWasAllowed = oldPerm.mpris !== false;
                const mprisNowAllowed = newPerm.mpris !== false;
                if (mprisNowAllowed && !mprisWasAllowed) {
                    (0, mpris_1.queryMprisSessions)().then((sessions) => {
                        deviceManager.sendTo(deviceId, (0, mpris_1.createMprisStatePacket)(sessions));
                    }).catch(() => { });
                }
                const runcommandWasAllowed = oldPerm.runcommand !== false;
                const runcommandNowAllowed = newPerm.runcommand !== false;
                if (runcommandNowAllowed && !runcommandWasAllowed) {
                    deviceManager.sendTo(deviceId, runCommandManager.createCommandListPacket());
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
                        send('device-mount-changed', deviceId, undefined);
                        console.log(`[Link] Unmounted filesystem for ${deviceId} — fileaccess revoked.`);
                    }
                    const fsClient = fsClients.get(deviceId);
                    if (fsClient) {
                        fsClient.disconnect();
                        fsClients.delete(deviceId);
                    }
                    socketFsClients.delete(deviceId);
                }
                else if (fileaccessNowAllowed && !fileaccessWasAllowed && deviceMountEnabled[deviceId] !== false) {
                    const peer = deviceManager.connectedPeers().find((p) => p.identity.deviceId === deviceId);
                    const host = deviceManager.remoteAddressOf(deviceId);
                    if (peer && host) {
                        mountFilesystemForDevice(peer.identity, host);
                    }
                }
            }
            return true;
        }
        catch (err) {
            console.error('[Link] Failed to write permissions:', err);
            return false;
        }
    });
    // ===== App Settings (visibility, pause-music, screensaver-inhibit, open-at-login) =====
    electron_1.ipcMain.handle('get-visibility', () => visibilityEnabled);
    electron_1.ipcMain.handle('set-visibility', (_e, enabled) => {
        visibilityEnabled = enabled;
        // visibilityEnabled only controls whether this device BROADCASTS its identity over UDP.
        // It does NOT affect receiving — we still listen for and connect to peers that broadcast
        // to us. This makes the toggle mean "am I visible to others" not "can I see others".
        discoveryService?.setVisibility(enabled);
        (0, settings_store_1.saveSetting)(configDir, 'discovery-settings.json', 'visibilityEnabled', enabled);
        // Going invisible used to be purely passive: this device just stopped broadcasting and
        // waited for each peer's OWN discovery-expiry timeout (up to ~9-12s of silence) to notice
        // and disconnect. That made the toggle feel broken/laggy rather than "realtime" — turn it
        // off and an already-connected, untrusted (unpaired) peer would keep showing as connected
        // for up to 12 more seconds. Proactively closing those connections the instant visibility
        // goes off makes it actually instant on both sides (this device's own 'deviceDisconnected'
        // fires immediately, and the peer sees the same TCP close immediately too — no need to wait
        // for their expiry timer). Trusted/paired devices are deliberately left connected — pool
        // membership is unaffected by LAN visibility, only casual/discovery-based connections are.
        if (!enabled) {
            for (const peer of deviceManager.connectedPeers()) {
                if (!peer.trusted) {
                    deviceManager.closeConnection(peer.identity.deviceId);
                }
            }
        }
    });
    electron_1.ipcMain.handle('get-close-to-tray', () => closeToTray);
    electron_1.ipcMain.handle('set-close-to-tray', (_e, enabled) => {
        closeToTray = enabled;
        (0, settings_store_1.saveSetting)(configDir, 'tray-settings.json', 'closeToTray', enabled);
    });
    electron_1.ipcMain.handle('get-pause-music-enabled', () => {
        return pauseMusicController.isEnabled();
    });
    electron_1.ipcMain.handle('set-pause-music-enabled', (_e, enabled) => {
        pauseMusicController.setEnabled(enabled);
        (0, settings_store_1.saveSetting)(configDir, 'pause-music-settings.json', 'pauseMusicEnabled', enabled);
    });
    electron_1.ipcMain.handle('get-screensaver-inhibit-enabled', () => screensaverInhibitEnabled);
    electron_1.ipcMain.handle('set-screensaver-inhibit-enabled', (_e, enabled) => {
        screensaverInhibitEnabled = enabled;
        updateScreensaverInhibition();
        (0, settings_store_1.saveSetting)(configDir, 'screensaver-inhibit-settings.json', 'screensaverInhibitEnabled', enabled);
    });
    // Electron's own login-item registration handles OS-level persistence (registry on Windows) —
    // no need for our own config file, unlike the settings above.
    electron_1.ipcMain.handle('get-open-at-login', () => {
        return electron_1.app.getLoginItemSettings().openAtLogin;
    });
    electron_1.ipcMain.handle('set-open-at-login', (_e, enabled) => {
        electron_1.app.setLoginItemSettings({ openAtLogin: enabled });
    });
    // ===== Pairing & Connection =====
    electron_1.ipcMain.handle('connect-to', async (_e, host, port) => {
        const target = host.trim().toLowerCase();
        if (target === '127.0.0.1' || target === 'localhost' || target === '::1') {
            throw new Error('A device cannot connect to itself.');
        }
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const net of interfaces[name] || []) {
                if (net.address === host) {
                    throw new Error('A device cannot connect to itself.');
                }
            }
        }
        await deviceManager.connectTo(host, port ?? transport_1.LINK_PORT);
    });
    electron_1.ipcMain.handle('request-pairing', async (_e, deviceId) => {
        const immediatePin = deviceManager.requestPairing(deviceId);
        if (immediatePin !== null)
            return immediatePin;
        // Came back null — this is expected for a device that only exists in the "Nearby Discovered
        // Devices" list: those are announced purely from UDP discovery broadcasts and deliberately
        // NEVER auto-connected over TCP (see the discoveryService callback above — auto-connect only
        // fires for already-PAIRED devices), so there's no live connection yet for requestPairing()
        // to compute a verification PIN against. Connect now using the IP we already know from
        // discovery, then wait for the identity handshake to actually finish — connectTo()'s own
        // promise resolves right after the raw TLS handshake, BEFORE identity packets are exchanged
        // (see connectToPeer()'s comment in transport.ts), so awaiting it alone isn't enough; we need
        // the 'deviceConnected' event for this specific deviceId, or requestPairing() would still
        // race and come back null a second time.
        const discovered = discoveredUnpairedPeers.get(deviceId);
        if (!discovered?.ipAddress)
            return null;
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    deviceManager.off('deviceConnected', onConnected);
                    reject(new Error('Timed out waiting for connection'));
                }, 10000);
                const onConnected = (identity) => {
                    if (identity.deviceId === deviceId) {
                        clearTimeout(timeout);
                        deviceManager.off('deviceConnected', onConnected);
                        resolve();
                    }
                };
                deviceManager.on('deviceConnected', onConnected);
                deviceManager.connectTo(discovered.ipAddress).catch((err) => {
                    clearTimeout(timeout);
                    deviceManager.off('deviceConnected', onConnected);
                    reject(err);
                });
            });
        }
        catch (err) {
            console.error('[Link] Failed to connect before pairing:', err.message);
            return null;
        }
        return deviceManager.requestPairing(deviceId);
    });
    electron_1.ipcMain.handle('request-pairing-by-ip', async (_e, ipListStr) => {
        try {
            console.log(`[Link] Manual connection request to IP list: ${ipListStr}`);
            const normalizeIp = (i) => i.replace(/^::ffff:/, '');
            const ips = ipListStr.split(',').map((s) => s.trim()).filter(Boolean);
            if (ips.length === 0)
                return null;
            for (const ip of ips) {
                const targetNormalized = normalizeIp(ip);
                const existingPeer = [...deviceManager.peers.values()].find((p) => {
                    const remoteIp = p.conn.remoteAddress;
                    return remoteIp && normalizeIp(remoteIp) === targetNormalized;
                });
                if (existingPeer && existingPeer.conn.peerIdentity) {
                    const pin = deviceManager.requestPairing(existingPeer.conn.peerIdentity.deviceId);
                    return pin ? { pin, deviceId: existingPeer.conn.peerIdentity.deviceId } : null;
                }
            }
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    deviceManager.off('deviceConnected', onConnected);
                    reject(new Error('Timed out waiting for connection'));
                }, 10000);
                const onConnected = (identity) => {
                    const remoteIp = deviceManager.remoteAddressOf(identity.deviceId);
                    if (remoteIp && ips.some((ip) => normalizeIp(remoteIp) === normalizeIp(ip))) {
                        clearTimeout(timeout);
                        deviceManager.off('deviceConnected', onConnected);
                        const pin = deviceManager.requestPairing(identity.deviceId);
                        resolve(pin ? { pin, deviceId: identity.deviceId } : null);
                    }
                };
                deviceManager.on('deviceConnected', onConnected);
                for (const ip of ips) {
                    deviceManager.connectTo(ip).catch((err) => {
                        console.warn(`[Link] Parallel connect attempt failed to ${ip}:`, err.message);
                    });
                }
            });
        }
        catch (err) {
            console.error('[Link] Manual connection failed:', err.message);
            return null;
        }
    });
    electron_1.ipcMain.handle('accept-pairing', (_e, deviceId) => {
        deviceManager.acceptPairing(deviceId);
    });
    electron_1.ipcMain.handle('cancel-pairing', (_e, deviceId) => {
        deviceManager.cancelPairing(deviceId);
    });
    electron_1.ipcMain.handle('get-blocklist', () => {
        return blocklist;
    });
    electron_1.ipcMain.handle('block-device', (_e, id, label, type) => {
        const ip = type === 'device' ? deviceManager.remoteAddressOf(id) : undefined;
        addToBlocklist(id, label, type, undefined, ip);
        // If it is a device currently connected, terminate immediately
        if (type === 'device') {
            deviceManager.closeConnection(id);
        }
        return blocklist;
    });
    electron_1.ipcMain.handle('unblock-device', (_e, id) => {
        blocklist = blocklist.filter((x) => x.id !== id);
        (0, settings_store_1.saveBlocklist)(configDir, blocklist);
        console.log(`[Link] Unblocked: ${id}`);
        return blocklist;
    });
    electron_1.ipcMain.handle('reject-pairing', (_e, deviceId, shouldBlock, deviceName, deviceType) => {
        const ip = deviceManager.remoteAddressOf(deviceId);
        deviceManager.rejectPairing(deviceId);
        if (shouldBlock) {
            addToBlocklist(deviceId, deviceName || deviceId.slice(0, 8), 'device', deviceType, ip);
        }
    });
    electron_1.ipcMain.handle('unpair', (_e, deviceId) => {
        for (const otherId of deviceManager.trustedConnectedDeviceIds()) {
            if (otherId !== deviceId) {
                deviceManager.sendTo(otherId, (0, packet_1.createPacket)('link.pool.remove', { deviceId }));
            }
        }
        deviceManager.unpair(deviceId);
    });
    electron_1.ipcMain.handle('exit-pool', () => {
        for (const d of deviceManager.trustStore.list()) {
            deviceManager.unpair(d.deviceId);
        }
    });
    electron_1.ipcMain.handle('run-speed-test', async (_e, deviceId) => {
        return speedTestManager.runSpeedTest(deviceId, (progressMsg) => {
            mainWindow?.webContents.send('speed-test-progress', deviceId, progressMsg);
        });
    });
    // ===== Ring / Find My Device =====
    electron_1.ipcMain.handle('send-find-my-device', (_e, deviceId) => {
        deviceManager.sendTo(deviceId, (0, findmydevice_1.createFindMyDevicePacket)(false));
    });
    electron_1.ipcMain.handle('send-find-my-phone', (_e, deviceId) => {
        deviceManager.sendTo(deviceId, (0, findmydevice_1.createFindMyDevicePacket)(false));
    });
    electron_1.ipcMain.handle('send-stop-ringing', (_e, deviceId) => {
        deviceManager.sendTo(deviceId, (0, findmydevice_1.createFindMyDevicePacket)(true));
    });
    electron_1.ipcMain.handle('stop-ringing-local', () => {
        (0, findmydevice_1.stopRinging)();
        if (ringTimeoutMain) {
            clearTimeout(ringTimeoutMain);
            ringTimeoutMain = null;
        }
        if (activeRingerDeviceId) {
            deviceManager.sendTo(activeRingerDeviceId, (0, findmydevice_1.createFindMyDevicePacket)(true));
            send('find-my-phone-stopped', activeRingerDeviceId);
            send('find-my-device-stopped', activeRingerDeviceId);
            activeRingerDeviceId = null;
        }
    });
    // ===== Remote Input (PC -> Android Keyboard & D-Pad) =====
    electron_1.ipcMain.handle('send-remote-input', (_e, deviceId, text, specialKey) => {
        const body = {};
        if (text)
            body.text = text;
        if (specialKey)
            body.specialKey = specialKey;
        deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.remoteinput.send', body));
    });
    // ===== Rename =====
    electron_1.ipcMain.handle('rename-device', (_e, newName) => {
        const filtered = (0, identity_1.saveDeviceName)(configDir, newName);
        identity.deviceName = filtered;
        // Broadcast our new authoritative name to every currently-connected peer so their view of
        // us updates live instead of waiting for their next reconnect/handshake. Not gated by the
        // test.txt kill-switch — rename is inherently available on any valid connection.
        const renamePacket = (0, rename_1.createRenamePacket)(filtered);
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, renamePacket);
        }
        return filtered;
    });
    electron_1.ipcMain.handle('rename-trusted-device', (_e, deviceId, newName) => {
        // Device names are self-owned — renaming a peer sends it a REQUEST rather than editing our
        // local alias directly. The peer applies it to itself and broadcasts the authoritative
        // result back (handled by isRenamePacket above), which is what actually updates our trust
        // store. This only works while the peer is reachable; there is no queued/offline rename.
        if (!deviceManager.trustedConnectedDeviceIds().includes(deviceId)) {
            throw new Error('Device must be connected to be renamed');
        }
        deviceManager.sendTo(deviceId, (0, rename_1.createRenameRequestPacket)(newName));
        return true;
    });
    // ===== Lock =====
    electron_1.ipcMain.handle('send-lock-request', (_e, deviceId, setLocked) => {
        deviceManager.sendTo(deviceId, (0, lock_1.createLockRequestPacket)(setLocked));
    });
    // Separate from send-lock-request: no OS exposes a way to remotely unlock a screen without
    // real credentials, so there is no "unlock" action to send — only a status query, used to
    // refresh/reconcile the UI's lock indicator against the peer's real current state.
    electron_1.ipcMain.handle('send-lock-status-request', (_e, deviceId) => {
        deviceManager.sendTo(deviceId, (0, lock_1.createLockRequestPacket)(undefined, true));
    });
    // ===== Presenter (desktop-as-controller — mirrors mobile LinkPlugin.java's sendPresenterMove/
    // sendPresenterStop/sendSpecialKey/cycleTargetDisplay PluginMethods) =====
    // Moves ride the low-latency raw UDP relay, same as mobile-to-mobile; stop uses the reliable
    // TCP packet channel (see LinkPlugin.java's handlePresenterPacket / isPresenterStopPacket
    // above). "special key" and "cycle target display" sent to a MOBILE target are currently
    // no-ops there (mobile never implemented receiving either — it only ever sent them, back when
    // desktop was the only possible target) — harmless, not wired up to crash or block.
    electron_1.ipcMain.handle('send-presenter-move', (_e, deviceId, dx, dy) => {
        sendUdpMessageToPeer(deviceId, `pmove ${dx} ${dy}`);
    });
    electron_1.ipcMain.handle('send-presenter-stop', (_e, deviceId) => {
        deviceManager.sendTo(deviceId, (0, presenter_1.createPresenterStopPacket)());
    });
    electron_1.ipcMain.handle('send-special-key', (_e, deviceId, key) => {
        sendUdpMessageToPeer(deviceId, `special ${key}`);
    });
    electron_1.ipcMain.handle('send-cycle-target-display', (_e, deviceId) => {
        deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.target.display', {}));
    });
    electron_1.ipcMain.handle('send-digitizer-session', (_e, deviceId, action, w, h) => {
        deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.digitizer.session', {
            action,
            width: w,
            height: h,
            resolutionX: 100,
            resolutionY: 100
        }));
    });
    electron_1.ipcMain.handle('send-digitizer-event', (_e, deviceId, payload) => {
        sendUdpMessageToPeer(deviceId, `dig ${payload.x || 0} ${payload.y || 0} ${payload.touching || false}`);
    });
    electron_1.ipcMain.handle('send-digitizer-action', (_e, deviceId, action) => {
        sendUdpMessageToPeer(deviceId, action); // "undo" or "redo"
    });
    // ===== Joystick =====
    // Host-side (desktop) status query — JoystickTab.tsx polls this to render the driver banner
    // and the live list of connected phone-controllers, mirroring get-audio-sink-status's shape.
    // Controllers are IP-identified, not deviceId-identified (see joystick.ts), so there's no
    // deviceId here to resolve a friendly name from — the name is whatever the phone sent in its
    // "hello <name>" handshake.
    electron_1.ipcMain.handle('get-joystick-status', () => {
        const { status, error } = joystickHandler.getDriverStatus();
        return { driverStatus: status, driverError: error, connectedControllers: joystickHandler.getConnectedControllers() };
    });
    // "Verify Installation" — actively probes (spawns the helper if needed) rather than reading the
    // passive cache above, which otherwise never updates until a phone actually connects.
    electron_1.ipcMain.handle('check-joystick-driver', () => {
        const { status, error } = joystickHandler.checkDriverNow();
        return { driverStatus: status, driverError: error };
    });
    electron_1.ipcMain.handle('kick-joystick-controller', (_e, ip) => {
        joystickHandler.handleBye(ip, 'kicked');
    });
    electron_1.ipcMain.handle('block-joystick-controller', (_e, ip, name) => {
        blockUntrustedGuest(ip, name);
        joystickHandler.handleBye(ip, 'blocked');
    });
    electron_1.ipcMain.handle('accept-joystick-guest', (_e, connId) => {
        const remoteAddress = joystickServer?.getPendingGuestRemoteAddress(connId);
        const deviceName = joystickServer?.getPendingGuestDeviceName(connId);
        if (!remoteAddress || !deviceName)
            return;
        const result = joystickHandler.handleHello(remoteAddress, deviceName);
        if (result.error) {
            joystickServer?.rejectGuest(connId);
        }
        else {
            joystickServer?.acceptGuest(connId, result.padIndex);
        }
    });
    electron_1.ipcMain.handle('reject-joystick-guest', (_e, connId) => {
        joystickServer?.rejectGuest(connId);
    });
    electron_1.ipcMain.handle('block-joystick-guest', (_e, connId) => {
        const remoteAddress = joystickServer?.getPendingGuestRemoteAddress(connId);
        if (remoteAddress) {
            blockUntrustedGuest(remoteAddress, joystickServer?.getPendingGuestDeviceName(connId) ?? undefined);
        }
        joystickServer?.blockGuest(connId);
    });
    // ===== Volume =====
    electron_1.ipcMain.handle('send-set-volume', (_e, deviceId, sinkName, volume) => {
        deviceManager.sendTo(deviceId, (0, systemvolume_1.createSetVolumeRequestPacket)(sinkName, volume));
    });
    electron_1.ipcMain.handle('send-set-mute', (_e, deviceId, sinkName, muted) => {
        deviceManager.sendTo(deviceId, (0, systemvolume_1.createSetMuteRequestPacket)(sinkName, muted));
    });
    // ===== Flashlight / DND =====
    electron_1.ipcMain.handle('send-flashlight-toggle', (_e, deviceId, enabled) => {
        deviceManager.sendTo(deviceId, (0, flashlight_1.createFlashlightCommandPacket)(enabled));
    });
    electron_1.ipcMain.handle('send-dnd-set', (_e, deviceId, enabled) => {
        deviceManager.sendTo(deviceId, (0, dnd_1.createDNDCommandPacket)(enabled));
    });
    electron_1.ipcMain.handle('get-device-mount-config', (_e, deviceId) => {
        if (process.platform === 'linux') {
            // No drive-letter concept on Linux — each device gets its own auto-named path under
            // ~/Link (see findUnusedLinuxMountPath). Empty letters/occupiedLetters collapses the
            // renderer's letter-picker dropdown to nothing (see DeviceControlPanel.tsx).
            return { preferredDriveLetter: deviceDriveLetters[deviceId] || '', occupiedLetters: [], letters: [] };
        }
        const letters = 'ZYXWVUTSRQPONMLKJIHGFED'.split('').map(l => `${l}:`);
        const preferredDriveLetter = deviceDriveLetters[deviceId] || '';
        const occupiedLetters = [];
        for (const letter of letters) {
            if (fs.existsSync(letter)) {
                occupiedLetters.push(letter);
                continue;
            }
            const otherDeviceUsingLetter = Object.entries(deviceDriveLetters).some(([id, preferred]) => id !== deviceId && preferred === letter);
            if (otherDeviceUsingLetter) {
                occupiedLetters.push(letter);
            }
        }
        return {
            preferredDriveLetter,
            occupiedLetters,
            letters
        };
    });
    electron_1.ipcMain.handle('set-device-mount-letter', async (_e, deviceId, driveLetter) => {
        if (driveLetter) {
            deviceDriveLetters[deviceId] = driveLetter;
        }
        else {
            delete deviceDriveLetters[deviceId];
        }
        (0, settings_store_1.saveSetting)(configDir, 'mount-settings.json', 'deviceDriveLetters', deviceDriveLetters);
        const activeMount = fsMountServices.get(deviceId);
        if (activeMount) {
            console.log(`[Link] Drive letter changed to ${driveLetter} for active device ${deviceId}. Remounting...`);
            try {
                await activeMount.unmount();
                fsMountServices.delete(deviceId);
                send('device-mount-changed', deviceId, undefined);
                const peer = deviceManager.connectedPeers().find((p) => p.identity.deviceId === deviceId);
                const host = deviceManager.remoteAddressOf(deviceId);
                if (peer && host) {
                    await mountFilesystemForDevice(peer.identity, host);
                }
            }
            catch (err) {
                console.error(`[Link] Failed to dynamically remount device ${deviceId}:`, err.message);
            }
        }
        return { success: true };
    });
    // ===== Media (MPRIS) =====
    electron_1.ipcMain.handle('send-mpris-action', (_e, deviceId, player, action) => {
        deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.mpris.request', { player, action }));
    });
    // ===== Notifications =====
    electron_1.ipcMain.handle('send-notification-reply', (_e, deviceId, replyId, message) => {
        deviceManager.sendTo(deviceId, (0, packet_1.createPacket)('link.notification.reply', {
            requestReplyId: replyId,
            message
        }));
    });
    // ===== Run Command =====
    electron_1.ipcMain.handle('get-commands', () => {
        return runCommandManager.getCommands();
    });
    electron_1.ipcMain.handle('set-command', (_e, key, entry) => {
        runCommandManager.setCommand(key, entry);
        broadcastToPermittedPeers('runcommand', runCommandManager.createCommandListPacket());
        return runCommandManager.getCommands();
    });
    electron_1.ipcMain.handle('remove-command', (_e, key) => {
        runCommandManager.removeCommand(key);
        broadcastToPermittedPeers('runcommand', runCommandManager.createCommandListPacket());
        return runCommandManager.getCommands();
    });
    // Trigger a command on a peer's whitelist (we're the requester here — mesh case: viewing a
    // paired desktop's control panel from either a desktop or mobile app).
    electron_1.ipcMain.handle('send-run-command-trigger', (_e, deviceId, key) => {
        deviceManager.sendTo(deviceId, (0, runcommand_1.createTriggerCommandPacket)(key));
    });
    // ===== File System =====
    const getFsClient = async (deviceId) => {
        const client = fsClients.get(deviceId);
        if (client)
            return client;
        const socketClient = socketFsClients.get(deviceId);
        if (socketClient)
            return socketClient;
        // Lazily connect client for File Explorer if not mounted
        const peer = deviceManager.connectedPeers().find((p) => p.identity.deviceId === deviceId);
        const host = deviceManager.remoteAddressOf(deviceId);
        if (peer && host && peer.identity.deviceType === 'phone') {
            console.log(`[Link] Lazily starting FS WSS client for File Explorer: ${peer.identity.deviceName} at ${host}...`);
            const fsClient = new fs_client_1.LinkFsClient(host, undefined, tlsIdentity.cert, tlsIdentity.key);
            await fsClient.connect();
            fsClients.set(deviceId, fsClient);
            return fsClient;
        }
        return null;
    };
    electron_1.ipcMain.handle('fs-get-connected-devices', () => {
        return [...Array.from(fsClients.keys()), ...Array.from(socketFsClients.keys())];
    });
    electron_1.ipcMain.handle('fs-list-roots', async (_e, deviceId) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        return client.listRoots();
    });
    electron_1.ipcMain.handle('fs-readdir', async (_e, deviceId, path) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        return client.readdir(path);
    });
    electron_1.ipcMain.handle('fs-stat', async (_e, deviceId, path) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        return client.stat(path);
    });
    // Returns raw bytes, not base64. Electron structured-clones a Buffer straight through as a
    // Uint8Array, so base64 only ever added a full encode here, ~33% more bytes over IPC, and a
    // matching decode in the renderer — per thumbnail, several at a time while scrolling.
    // The renderer accepts either shape, because the Capacitor build's native bridge still hands
    // back a base64 string and this handler's only consumer is shared between both builds.
    electron_1.ipcMain.handle('fs-read', async (_e, deviceId, path, offset, length) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        return client.read(path, offset, length);
    });
    electron_1.ipcMain.handle('fs-create-directory', async (_e, deviceId, path) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        return client.create(path, true);
    });
    electron_1.ipcMain.handle('fs-delete', async (_e, deviceId, path) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        return client.delete(path);
    });
    electron_1.ipcMain.handle('fs-rename', async (_e, deviceId, path, newPath) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        return client.rename(path, newPath);
    });
    electron_1.ipcMain.handle('fs-download-file', async (_e, deviceId, remotePath, localPath) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        const entry = await client.stat(remotePath);
        if (entry.isDirectory)
            throw new Error('Cannot download a directory');
        const fd = fs.openSync(localPath, 'w');
        const start = 0;
        const end = entry.size - 1;
        const chunkSize = 1 * 1024 * 1024; // 1MB chunks
        const CONCURRENCY = 6; // 6 chunks in flight
        const chunkDescs = [];
        for (let o = start; o <= end; o += chunkSize) {
            chunkDescs.push({ offset: o, length: Math.min(chunkSize, end - o + 1) });
        }
        const inFlight = [];
        let nextToIssue = 0;
        const issueNext = () => {
            if (nextToIssue < chunkDescs.length) {
                const c = chunkDescs[nextToIssue++];
                const p = client.read(remotePath, c.offset, c.length);
                p.catch(() => { });
                inFlight.push(p);
            }
        };
        // Fill initial pipeline window
        for (let i = 0; i < CONCURRENCY; i++)
            issueNext();
        try {
            for (let i = 0; i < chunkDescs.length; i++) {
                const chunk = await inFlight[i];
                issueNext(); // maintain window
                fs.writeSync(fd, chunk, 0, chunk.length, chunkDescs[i].offset);
            }
        }
        finally {
            fs.closeSync(fd);
        }
        return true;
    });
    electron_1.ipcMain.handle('fs-pick-save-path', async (_e, defaultName) => {
        const { filePath } = await electron_1.dialog.showSaveDialog(mainWindow, {
            defaultPath: defaultName,
        });
        return filePath || null;
    });
    electron_1.ipcMain.handle('fs-mount-device', async (_e, deviceId) => {
        const peer = deviceManager.connectedPeers().find((p) => p.identity.deviceId === deviceId);
        const host = deviceManager.remoteAddressOf(deviceId);
        if (!peer || !host)
            throw new Error('Device is offline or unreachable');
        // Record the user's intent so it survives a reconnect — see deviceMountEnabled's doc comment.
        deviceMountEnabled[deviceId] = true;
        (0, settings_store_1.saveSetting)(configDir, 'mount-settings.json', 'deviceMountEnabled', deviceMountEnabled);
        await mountFilesystemForDevice(peer.identity, host);
        return true;
    });
    electron_1.ipcMain.handle('fs-unmount-device', async (_e, deviceId) => {
        // Record the user's intent so this doesn't silently remount on the next reconnect — see
        // deviceMountEnabled's doc comment. This is the actual fix for that bug: previously this
        // handler only ever touched the in-memory fsMountServices map below.
        deviceMountEnabled[deviceId] = false;
        (0, settings_store_1.saveSetting)(configDir, 'mount-settings.json', 'deviceMountEnabled', deviceMountEnabled);
        const mountService = fsMountServices.get(deviceId);
        if (mountService) {
            mountService.unmount();
            fsMountServices.delete(deviceId);
            send('device-mount-changed', deviceId, undefined);
        }
        const fsClient = fsClients.get(deviceId);
        if (fsClient) {
            fsClient.disconnect();
            fsClients.delete(deviceId);
        }
        socketFsClients.delete(deviceId);
        return true;
    });
    async function uploadItemRecursively(client, localPath, remoteParentPath) {
        const stat = fs.statSync(localPath);
        const name = path.basename(localPath);
        const remotePath = remoteParentPath.endsWith('/') || remoteParentPath.endsWith('\\')
            ? `${remoteParentPath}${name}`
            : `${remoteParentPath}/${name}`;
        if (stat.isDirectory()) {
            await client.create(remotePath, true);
            const files = fs.readdirSync(localPath);
            for (const file of files) {
                await uploadItemRecursively(client, path.join(localPath, file), remotePath);
            }
        }
        else {
            const fd = fs.openSync(localPath, 'r');
            const fileSize = stat.size;
            const chunkSize = 256 * 1024;
            try {
                let offset = 0;
                const buf = Buffer.alloc(chunkSize);
                while (offset < fileSize) {
                    const bytesRead = fs.readSync(fd, buf, 0, Math.min(chunkSize, fileSize - offset), offset);
                    const chunk = buf.subarray(0, bytesRead);
                    await client.write(remotePath, offset, chunk);
                    offset += bytesRead;
                }
            }
            finally {
                fs.closeSync(fd);
            }
        }
    }
    electron_1.ipcMain.handle('fs-upload-item', async (_e, deviceId, localPath, remoteParentPath) => {
        const client = await getFsClient(deviceId);
        if (!client)
            throw new Error('Device FS client not connected');
        await uploadItemRecursively(client, localPath, remoteParentPath);
        return true;
    });
    electron_1.ipcMain.handle('fs-pick-upload-items', async (_e, mode) => {
        const properties = mode === 'file' ? ['openFile', 'multiSelections'] : ['openDirectory', 'multiSelections'];
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
            properties,
            title: mode === 'file' ? 'Select files to upload' : 'Select folders to upload',
        });
        if (result.canceled)
            return [];
        return result.filePaths;
    });
    electron_1.ipcMain.handle('expand-dropped-paths', async (_e, filePaths) => {
        let allFiles = [];
        for (const filePath of filePaths) {
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    allFiles = allFiles.concat(walkDir(filePath, path.dirname(filePath)));
                }
                else {
                    allFiles.push({
                        localPath: filePath,
                        relPath: path.basename(filePath)
                    });
                }
            }
        }
        return allFiles;
    });
    electron_1.ipcMain.handle('fs-get-stream-url', async (_e, deviceId, remotePath) => {
        let mountService = fsMountServices.get(deviceId);
        if (!mountService) {
            const peer = deviceManager.connectedPeers().find((p) => p.identity.deviceId === deviceId);
            const host = deviceManager.remoteAddressOf(deviceId);
            if (!peer || !host) {
                throw new Error('Device is offline or unreachable');
            }
            console.log(`[Link] Dynamically mounting filesystem for streaming on device: ${peer.identity.deviceName}`);
            await mountFilesystemForDevice(peer.identity, host);
            mountService = fsMountServices.get(deviceId);
        }
        if (!mountService) {
            throw new Error('Could not start mount service for streaming');
        }
        const port = mountService.getPort();
        const roots = mountService.getRoots();
        const matchedRoot = roots.find(r => remotePath.startsWith(r.path));
        if (!matchedRoot) {
            throw new Error('Path does not match any storage roots');
        }
        const relativePath = remotePath.substring(matchedRoot.path.length);
        const urlPath = `/${matchedRoot.name}${relativePath.startsWith('/') ? relativePath : '/' + relativePath}`;
        return `http://127.0.0.1:${port}${encodeURI(urlPath)}`;
    });
    // ===== Audio Sink =====
    electron_1.ipcMain.handle('start-audio-sink', async () => {
        if (audioSinkServer)
            return { started: true, port: transport_1.AUDIO_SINK_PORT };
        const server = new audio_sink_server_1.AudioSinkServer(tlsIdentity.cert, tlsIdentity.key, transport_1.AUDIO_SINK_PORT, isBlocked, 'loopback', identity.deviceName);
        server.on('listenerJoined', (connId, label) => {
            send('audio-sink-listener-joined', connId, label);
        });
        server.on('listenerLeft', (connId) => {
            send('audio-sink-listener-left', connId);
        });
        server.on('guestPinPending', (connId, pin, remoteAddress, deviceName) => {
            send('audio-sink-guest-pin-pending', connId, pin, remoteAddress, deviceName);
        });
        server.on('error', (err) => {
            console.error('[Link] Audio Sink server error:', err.message);
            send('audio-sink-error', err.message);
        });
        try {
            await server.start();
        }
        catch (err) {
            console.error('[Link] Failed to start Audio Sink:', err.message);
            return { started: false, error: err.message };
        }
        audioSinkServer = server;
        // Notify every already-connected paired device with their own one-time join token — no extra
        // per-device permission gate, same as Joystick: pairing itself is the trust decision, and this
        // is an ephemeral session anyone paired can join, not a standing capability grant.
        // Known v1 limitation: a peer that connects to the main mesh AFTER this point won't
        // retroactively get one — they'd need the session restarted to see the "Join" banner.
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            const token = server.issueToken(peerId, deviceManager.trustStore.get(peerId)?.deviceName || peerId);
            deviceManager.sendTo(peerId, (0, packet_1.createPacket)('link.audiosink.started', { token, port: transport_1.AUDIO_SINK_PORT }));
        }
        rebuildTrayMenu();
        return { started: true, port: transport_1.AUDIO_SINK_PORT };
    });
    // Shared by the 'end-audio-sink' IPC handler (renderer's End Session button) and the tray
    // menu's own End Session item (see rebuildTrayMenu) — one implementation, two entry points.
    endAudioSink = async () => {
        if (!audioSinkServer)
            return;
        // Also tell every paired peer, not just admitted listeners — someone might have the tab
        // open with the "Join" banner showing but never actually joined, and needs it cleared too.
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, (0, packet_1.createPacket)('link.audiosink.ended', {}));
        }
        await audioSinkServer.stop();
        audioSinkServer = null;
        send('audio-sink-ended');
        rebuildTrayMenu();
    };
    electron_1.ipcMain.handle('set-audio-sink-muted', (_e, muted) => {
        audioSinkServer?.setMuted(muted);
        rebuildTrayMenu();
    });
    electron_1.ipcMain.handle('kick-audio-sink-listener', (_e, connId) => {
        audioSinkServer?.kickListener(connId);
    });
    // "Block" next to "Kick" — unlike a plain kick (which just disconnects), this also adds a real
    // Blocklist entry so the same device/IP can't rejoin (or reach discovery/pairing/any other
    // guest-session tool) until explicitly unblocked from Settings.
    electron_1.ipcMain.handle('block-audio-sink-listener', (_e, connId) => {
        const info = audioSinkServer?.getListenerBlockInfo(connId);
        if (!info)
            return;
        if (info.deviceId) {
            // Captures their current IP too (see isBlocked's comment) — without this, blocking a paired
            // listener by deviceId wouldn't stop that same device from reconnecting as an untrusted-tool
            // guest, which only ever checks by IP.
            addToBlocklist(info.deviceId, deviceManager.trustStore.get(info.deviceId)?.deviceName || info.deviceId.slice(0, 8), 'device', undefined, info.remoteAddress);
        }
        else {
            blockUntrustedGuest(info.remoteAddress);
        }
        audioSinkServer?.kickListener(connId);
    });
    electron_1.ipcMain.handle('accept-audio-sink-guest', (_e, connId) => {
        audioSinkServer?.acceptGuest(connId);
    });
    electron_1.ipcMain.handle('reject-audio-sink-guest', (_e, connId) => {
        audioSinkServer?.rejectGuest(connId);
    });
    // Block a pending (not yet admitted) guest — adds a Blocklist entry before rejecting
    electron_1.ipcMain.handle('block-audio-sink-guest', (_e, connId) => {
        const info = audioSinkServer?.getPendingGuestBlockInfo(connId);
        if (info)
            blockUntrustedGuest(info.remoteAddress);
        audioSinkServer?.rejectGuest(connId);
    });
    electron_1.ipcMain.handle('get-audio-sink-listeners', () => {
        return audioSinkServer?.listenersSnapshot() ?? [];
    });
    electron_1.ipcMain.handle('end-audio-sink', () => endAudioSink());
    electron_1.ipcMain.handle('join-audio-sink-guest', (_e, host) => {
        audioSinkClient?.disconnect();
        const client = new audio_sink_client_1.AudioSinkClient(host, transport_1.AUDIO_SINK_PORT, tlsIdentity.cert, tlsIdentity.key, identity.deviceName);
        wireAudioSinkClientEvents(client, host);
        audioSinkHostLabel = host;
        audioSinkClient = client;
        client.connect({ kind: 'guest' });
        rebuildTrayMenu();
    });
    electron_1.ipcMain.handle('join-audio-sink-paired', (_e, host, token, hostName) => {
        audioSinkClient?.disconnect();
        const client = new audio_sink_client_1.AudioSinkClient(host, transport_1.AUDIO_SINK_PORT, tlsIdentity.cert, tlsIdentity.key, identity.deviceName);
        wireAudioSinkClientEvents(client, hostName || host);
        audioSinkHostLabel = hostName || host;
        audioSinkClient = client;
        const mode = { kind: 'token', token };
        client.connect(mode);
        rebuildTrayMenu();
    });
    electron_1.ipcMain.handle('leave-audio-sink', () => {
        audioSinkClient?.disconnect();
        audioSinkClient = null;
        audioSinkHostLabel = '';
        rebuildTrayMenu();
    });
    // Called once when the Audio Sink tab mounts, so a session that started before this device
    // was connected/looking gets surfaced immediately instead of only ever catching the original
    // one-shot broadcast — see the 'link.audiosink.query' packet handler above.
    electron_1.ipcMain.handle('query-audio-sink-sessions', () => {
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, (0, packet_1.createPacket)('link.audiosink.query', {}));
        }
    });
    // ===== Remote Mic =====
    // Mobile-host / PC-listen only — see remoteMicClient's declaration comment for why PC hosting
    // was removed. Desktop keeps just the listener-side handlers below.
    electron_1.ipcMain.handle('query-remote-mic-sessions', () => {
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, (0, packet_1.createPacket)('link.remotemic.query', {}));
        }
    });
    electron_1.ipcMain.handle('join-remote-mic-paired', (_e, host, token) => {
        remoteMicClient?.disconnect();
        // AUDIO_SINK_PORT + 2 is our Remote Mic port mapping
        const client = new audio_sink_client_1.AudioSinkClient(host, transport_1.AUDIO_SINK_PORT + 2, tlsIdentity.cert, tlsIdentity.key, identity.deviceName);
        wireRemoteMicClientEvents(client);
        remoteMicClient = client;
        const mode = { kind: 'token', token };
        client.connect(mode);
        rebuildTrayMenu();
    });
    electron_1.ipcMain.handle('join-remote-mic-guest', (_e, host) => {
        remoteMicClient?.disconnect();
        const client = new audio_sink_client_1.AudioSinkClient(host, transport_1.AUDIO_SINK_PORT + 2, tlsIdentity.cert, tlsIdentity.key, identity.deviceName);
        wireRemoteMicClientEvents(client);
        remoteMicClient = client;
        client.connect({ kind: 'guest' });
        rebuildTrayMenu();
    });
    // Was missing entirely — RemoteMicTab.tsx's handleDisconnectPhoneMic() calls
    // linkApi.leaveRemoteMic(), which invokes this channel; with no handler registered, Electron
    // throws "No handler registered for 'leave-remote-mic'" the moment the Disconnect button (or
    // any of the other paths that call it, e.g. onRemoteMicEnded/onRemoteMicClosed) fires. Mirrors
    // 'leave-audio-sink' exactly.
    electron_1.ipcMain.handle('leave-remote-mic', () => {
        remoteMicClient?.disconnect();
        remoteMicClient = null;
        rebuildTrayMenu();
    });
    // ===== Walkie Talkie (real-time group voice, WebRTC hub-and-spoke) =====
    // main.ts's only role is a generic signaling relay — session membership, mixing, and all WebRTC
    // negotiation happens in WalkieTalkieTab.tsx, shared between desktop and mobile. No audio ever
    // passes through this process. Two transports for the exact same link.walkietalkie.* messages:
    // already-paired devices ride the existing trusted connection (this block); an unpaired guest
    // has no such connection, so it reaches the coordinator via WalkieTalkieSignalServer instead
    // (manual IP + PIN, same guest-admission model as every other ephemeral Tools plugin) — see the
    // walkie-talkie-guest-* handlers below.
    electron_1.ipcMain.handle('send-walkie-talkie-signal', (_e, deviceId, type, body) => {
        deviceManager.sendTo(deviceId, (0, packet_1.createPacket)(type, body || {}));
    });
    electron_1.ipcMain.handle('broadcast-walkie-talkie-signal', (_e, type, body) => {
        for (const peerId of deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, (0, packet_1.createPacket)(type, body || {}));
        }
    });
    // --- Guest-facing (unpaired, manual IP + PIN) ---
    electron_1.ipcMain.handle('start-walkie-talkie-guest-listener', async () => {
        if (walkieTalkieGuestServer)
            return { started: true, port: transport_1.WALKIE_TALKIE_PORT };
        const server = new walkie_talkie_signal_server_1.WalkieTalkieSignalServer(tlsIdentity.cert, tlsIdentity.key, transport_1.WALKIE_TALKIE_PORT, isBlocked);
        server.on('error', (err) => console.error('[Link] Walkie Talkie guest listener error:', err.message));
        server.on('guestPinPending', (connId, pin, remoteAddress, deviceName) => {
            send('walkie-talkie-guest-pin-pending', connId, pin, remoteAddress, deviceName);
        });
        server.on('signal', (connId, type, body) => {
            send('walkie-talkie-guest-signal', connId, type, body);
        });
        server.on('guestLeft', (connId) => {
            send('walkie-talkie-guest-left', connId);
        });
        try {
            await server.start();
        }
        catch (err) {
            console.error('[Link] Failed to start Walkie Talkie guest listener:', err.message);
            return { started: false, error: err.message };
        }
        walkieTalkieGuestServer = server;
        return { started: true, port: transport_1.WALKIE_TALKIE_PORT };
    });
    electron_1.ipcMain.handle('stop-walkie-talkie-guest-listener', async () => {
        if (!walkieTalkieGuestServer)
            return;
        await walkieTalkieGuestServer.stop().catch(() => { });
        walkieTalkieGuestServer = null;
    });
    electron_1.ipcMain.handle('accept-walkie-talkie-guest', (_e, connId) => {
        walkieTalkieGuestServer?.acceptGuest(connId);
    });
    electron_1.ipcMain.handle('reject-walkie-talkie-guest', (_e, connId) => {
        walkieTalkieGuestServer?.rejectGuest(connId);
    });
    // Plain kick — disconnects an already-admitted guest without touching the Blocklist, so they
    // can rejoin later. Mirrors kick-audio-sink-listener's "Kick" vs "Block" split.
    electron_1.ipcMain.handle('kick-walkie-talkie-guest', (_e, connId) => {
        walkieTalkieGuestServer?.kickGuest(connId);
    });
    electron_1.ipcMain.handle('block-walkie-talkie-guest', (_e, connId) => {
        const remoteAddress = walkieTalkieGuestServer?.getPendingGuestRemoteAddress(connId)
            ?? walkieTalkieGuestServer?.getGuestRemoteAddress(connId);
        if (remoteAddress)
            blockUntrustedGuest(remoteAddress);
        walkieTalkieGuestServer?.rejectGuest(connId);
        walkieTalkieGuestServer?.kickGuest(connId);
    });
    // A PAIRED member being blocked isn't a "guest" the signal server knows about at all — it's an
    // existing trusted device, so this is a plain device-id Blocklist entry (mirrors
    // block-audio-sink-listener's paired-listener branch), not a walkieTalkieGuestServer call.
    // Captures their current IP too (see isBlocked's comment) — without this, blocking them by
    // deviceId wouldn't stop the same device from reconnecting as an untrusted-tool guest, which
    // only ever checks by IP.
    electron_1.ipcMain.handle('block-walkie-talkie-member', (_e, deviceId, label) => {
        addToBlocklist(deviceId, label, 'device', undefined, deviceManager.remoteAddressOf(deviceId));
    });
    electron_1.ipcMain.handle('send-walkie-talkie-guest-signal', (_e, connId, type, body) => {
        walkieTalkieGuestServer?.sendTo(connId, type, body || {});
    });
    // --- Guest-side (us joining someone else's session, unpaired, manual IP) ---
    electron_1.ipcMain.handle('join-walkie-talkie-guest', (_e, host) => {
        walkieTalkieGuestClient?.disconnect();
        const client = new walkie_talkie_signal_client_1.WalkieTalkieSignalClient(host, transport_1.WALKIE_TALKIE_PORT, tlsIdentity.cert, tlsIdentity.key, identity.deviceName);
        client.on('pinComputed', (pin) => send('walkie-talkie-guest-pin-computed', pin));
        client.on('signal', (type, body) => send('walkie-talkie-host-signal', type, body));
        client.on('ended', (reason) => { walkieTalkieGuestClient = null; send('walkie-talkie-host-ended', reason); });
        client.on('closed', (reason) => { walkieTalkieGuestClient = null; send('walkie-talkie-host-closed', reason); });
        client.on('error', (err) => send('walkie-talkie-host-error', err.message));
        walkieTalkieGuestClient = client;
        client.connect();
    });
    electron_1.ipcMain.handle('leave-walkie-talkie-guest', () => {
        walkieTalkieGuestClient?.disconnect();
        walkieTalkieGuestClient = null;
    });
    electron_1.ipcMain.handle('send-walkie-talkie-guest-message', (_e, type, body) => {
        walkieTalkieGuestClient?.send(type, body || {});
    });
    // ===== Portal Mode (one-time file transfer to an untrusted/unpaired device) =====
    // Guest-only (manual IP + PIN) for v1, matching the actual ask — PortalTransferServer/Client
    // both already support a paired-token fast path too (mirroring Audio Sink's class shape
    // exactly), left unwired here rather than removed, so adding "one-tap send to an already-paired
    // device" later is a small addition, not a rewrite.
    function walkDir(dir, baseDir) {
        let results = [];
        try {
            const list = fs.readdirSync(dir);
            for (const file of list) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat && stat.isDirectory()) {
                    results = results.concat(walkDir(fullPath, baseDir));
                }
                else {
                    results.push({
                        localPath: fullPath,
                        relPath: path.relative(baseDir, fullPath).replace(/\\/g, '/')
                    });
                }
            }
        }
        catch (e) {
            console.error('[Link] Failed to walk directory:', e);
        }
        return results;
    }
    electron_1.ipcMain.handle('pick-portal-files', async (_e, mode) => {
        const properties = mode === 'file' ? ['openFile', 'multiSelections'] : ['openDirectory', 'multiSelections'];
        const result = await electron_1.dialog.showOpenDialog(mainWindow, { properties });
        if (result.canceled || result.filePaths.length === 0)
            return [];
        let allFiles = [];
        for (const filePath of result.filePaths) {
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    allFiles = allFiles.concat(walkDir(filePath, path.dirname(filePath)));
                }
                else {
                    allFiles.push({
                        localPath: filePath,
                        relPath: path.basename(filePath)
                    });
                }
            }
        }
        return allFiles;
    });
    // Destination folder for an incoming batch — asked fresh per transfer (not a fixed directory)
    // so the receiving human decides where each batch actually lands. Defaults to the plain
    // Downloads folder (not a Downloads/Link subfolder — that suggested a folder we don't actually
    // create), and the dialog lets them redirect it anywhere.
    electron_1.ipcMain.handle('pick-portal-save-dir', async () => {
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: electron_1.app.getPath('downloads'),
            title: 'Choose where to save the incoming files',
        });
        if (result.canceled || result.filePaths.length === 0)
            return null;
        return result.filePaths[0];
    });
    electron_1.ipcMain.handle('start-portal-receive', async (_e, webMode) => {
        if (portalTransferServer)
            return { started: true, port: transport_1.PORTAL_TRANSFER_PORT };
        const saveDir = path.join(electron_1.app.getPath('downloads'), 'Link');
        const server = new portal_transfer_server_1.PortalTransferServer(tlsIdentity.cert, tlsIdentity.key, transport_1.PORTAL_TRANSFER_PORT, saveDir, identity.deviceName, isBlocked);
        server.on('guestPinPending', (connId, pin, remoteAddress, deviceName) => {
            send('portal-guest-pin-pending', connId, pin, remoteAddress, deviceName);
        });
        server.on('connectionAdmitted', (connId, deviceName) => {
            send('portal-connection-admitted', connId, deviceName);
        });
        server.on('connectionClosed', (connId) => {
            send('portal-connection-closed', connId);
        });
        server.on('transferStarted', (connId, name, size) => {
            send('portal-transfer-started', connId, name, size);
        });
        server.on('transferProgress', (connId, received, size) => {
            send('portal-transfer-progress', connId, received, size);
        });
        server.on('transferComplete', (connId, destPath) => {
            send('portal-transfer-complete', connId, destPath);
        });
        server.on('error', (err) => {
            console.error('[Link] Portal Transfer server error:', err.message);
            send('portal-error', err.message);
        });
        try {
            await server.start(webMode);
        }
        catch (err) {
            console.error('[Link] Failed to start Portal receive:', err.message);
            return { started: false, error: err.message };
        }
        portalTransferServer = server;
        return { started: true, port: transport_1.PORTAL_TRANSFER_PORT, saveDir };
    });
    // Called first (before the save-dir dialog even opens) so the 30s PIN-confirm timeout doesn't
    // race the human still picking a folder — see PortalTransferServer.holdGuest()'s comment.
    electron_1.ipcMain.handle('hold-portal-guest', (_e, connId) => {
        portalTransferServer?.holdGuest(connId);
    });
    electron_1.ipcMain.handle('accept-portal-guest', (_e, connId, saveDir) => {
        portalTransferServer?.acceptGuest(connId, saveDir);
    });
    electron_1.ipcMain.handle('reject-portal-guest', (_e, connId) => {
        portalTransferServer?.rejectGuest(connId);
    });
    electron_1.ipcMain.handle('block-portal-guest', (_e, connId) => {
        const info = portalTransferServer?.getPendingGuestBlockInfo(connId);
        if (info && info.remoteAddress) {
            blockUntrustedGuest(info.remoteAddress, info.deviceName);
        }
        portalTransferServer?.rejectGuest(connId);
    });
    electron_1.ipcMain.handle('disconnect-portal-connection', (_e, connId) => {
        portalTransferServer?.disconnectConnection(connId);
    });
    electron_1.ipcMain.handle('end-portal-receive', async () => {
        if (!portalTransferServer)
            return;
        await portalTransferServer.stop();
        portalTransferServer = null;
    });
    electron_1.ipcMain.handle('set-portal-downloads', (_e, files) => {
        portalTransferServer?.setAvailableDownloads(files);
    });
    electron_1.ipcMain.handle('join-portal-guest', (_e, host, files) => {
        if (portalTransferClient) {
            portalTransferClient.sendFiles(files).catch((err) => {
                console.error('[Link] Portal send failed:', err.message);
                send('portal-error', err.message);
            });
            return;
        }
        const client = new portal_transfer_client_1.PortalTransferClient(host, transport_1.PORTAL_TRANSFER_PORT, tlsIdentity.cert, tlsIdentity.key, identity.deviceName);
        client.on('pinComputed', (pin) => send('portal-pin-computed', pin));
        client.on('admitted', (receiverDeviceName) => {
            send('portal-admitted', receiverDeviceName);
            client.sendFiles(files).catch((err) => {
                console.error('[Link] Portal send failed:', err.message);
                send('portal-error', err.message);
            });
        });
        client.on('fileStarted', (fileIndex, fileCount, name) => send('portal-file-started', fileIndex, fileCount, name));
        client.on('progress', (sent, total) => send('portal-send-progress', sent, total));
        client.on('complete', () => {
            send('portal-send-complete');
        });
        client.on('ended', () => { portalTransferClient = null; send('portal-ended'); });
        client.on('closed', (reason) => { portalTransferClient = null; send('portal-closed', reason); });
        client.on('error', (err) => send('portal-error', err.message));
        portalTransferClient = client;
        client.connect({ kind: 'guest' });
    });
    electron_1.ipcMain.handle('leave-portal-send', () => {
        portalTransferClient?.disconnect();
        portalTransferClient = null;
    });
    electron_1.ipcMain.handle('get-audio-sink-status', () => {
        return {
            hosting: !!audioSinkServer,
            listening: !!audioSinkClient,
            hostLabel: audioSinkHostLabel,
            listeners: audioSinkServer?.listenersSnapshot() ?? [],
        };
    });
    electron_1.ipcMain.handle('get-remote-mic-status', () => {
        return {
            hosting: false,
            streaming: !!remoteMicClient,
            listeners: [],
        };
    });
    electron_1.ipcMain.handle('get-portal-status', () => {
        return {
            receiving: !!portalTransferServer,
            sending: !!portalTransferClient,
            // See PortalTransferServer.hasActiveTransfer()'s comment — distinct from `receiving`, which
            // reflects "Receive Files" mode being armed at all, not whether anything is actually
            // transferring right now.
            transferring: portalTransferServer?.hasActiveTransfer() ?? false,
        };
    });
    electron_1.ipcMain.handle('get-pin-lock-enabled', () => {
        return pinLockEnabled;
    });
    electron_1.ipcMain.handle('set-pin-lock-enabled', (_e, enabled) => {
        pinLockEnabled = enabled;
        (0, settings_store_1.saveSetting)(configDir, 'pin-lock-settings.json', 'pinLockEnabled', enabled);
        return pinLockEnabled;
    });
    electron_1.ipcMain.handle('get-pin-code', () => {
        return pinCode;
    });
    electron_1.ipcMain.handle('set-pin-code', (_e, pin) => {
        pinCode = pin;
        (0, settings_store_1.saveSetting)(configDir, 'pin-lock-settings.json', 'pinCode', pin);
        return pinCode;
    });
    createWindow();
    createTray();
    let lastLocalIp = getLocalIpAddress();
    setInterval(() => {
        const currentLocalIp = getLocalIpAddress();
        if (currentLocalIp !== lastLocalIp) {
            console.log(`[Link] Local IP address changed from ${lastLocalIp} to ${currentLocalIp}`);
            lastLocalIp = currentLocalIp;
            mainWindow?.webContents.send('local-identity-updated', {
                ...identity,
                ipAddress: currentLocalIp,
            });
        }
    }, 5000);
});
electron_1.app.on('window-all-closed', () => {
    console.log('[Link] window-all-closed event fired');
    discoveryService?.stop();
    clipboardWatcher?.stop();
    batteryWatcher?.stop();
    volumeWatcher?.stop();
    touchpadHandler?.stop();
    screensaverInhibitor?.stop();
    hidePresenterDot();
    if (inputUdpSocket) {
        try {
            inputUdpSocket.close();
        }
        catch { }
        inputUdpSocket = null;
    }
    // Not awaited — app-quit cleanup, not a request that needs to complete before proceeding.
    // Without this, a held-open capture process (audio-capture.ps1) would be orphaned.
    audioSinkServer?.stop().catch(() => { });
    audioSinkClient?.disconnect();
    remoteMicClient?.disconnect();
    portalTransferServer?.stop().catch(() => { });
    portalTransferClient?.disconnect();
    walkieTalkieGuestServer?.stop().catch(() => { });
    walkieTalkieGuestClient?.disconnect();
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
electron_1.app.on('before-quit', () => {
    console.log('[Link] before-quit event fired');
    discoveryService?.stop();
    clipboardWatcher?.stop();
    batteryWatcher?.stop();
    volumeWatcher?.stop();
    touchpadHandler?.stop();
    screensaverInhibitor?.stop();
    hidePresenterDot();
    if (inputUdpSocket) {
        try {
            inputUdpSocket.close();
        }
        catch { }
        inputUdpSocket = null;
    }
    audioSinkServer?.stop().catch(() => { });
    audioSinkClient?.disconnect();
    remoteMicClient?.disconnect();
    portalTransferServer?.stop().catch(() => { });
    portalTransferClient?.disconnect();
    walkieTalkieGuestServer?.stop().catch(() => { });
    walkieTalkieGuestClient?.disconnect();
});
electron_1.app.on('will-quit', () => {
    console.log('[Link] will-quit event fired');
});
function sendInitialSync(deviceId) {
    // 0. Effective capabilities — lets the peer's UI know upfront exactly which of our gated
    // features it's currently allowed to use, before any state packets below even arrive.
    (0, permissions_1.pushEffectiveCapabilities)(deviceId);
    // 1. Clipboard
    if (isEnabled('Clipboard') && (0, permissions_1.canSendClipboardTo)(deviceId)) {
        deviceManager.sendTo(deviceId, (0, clipboard_1.createClipboardConnectPacket)(clipboardWatcher.currentContent(), clipboardWatcher.currentTimestamp()));
    }
    // 2. Battery
    const batterySnapshot = batteryWatcher.current();
    if (batterySnapshot) {
        deviceManager.sendTo(deviceId, (0, battery_1.createBatteryPacket)(batterySnapshot.isCharging, batterySnapshot.currentCharge));
    }
    // 3. Command list — both directions: serve our own whitelist to the peer (if we've allowed it
    // for them), and ask for theirs too (mesh case: they might be a Link desktop instance too).
    if ((0, permissions_1.checkDevicePermission)(deviceId, 'runcommand')) {
        deviceManager.sendTo(deviceId, runCommandManager.createCommandListPacket());
    }
    deviceManager.sendTo(deviceId, (0, runcommand_1.createRequestCommandListPacket)());
    // 4. Volume
    if ((0, permissions_1.checkDevicePermission)(deviceId, 'systemvolume')) {
        const volumeSnapshot = volumeWatcher.current();
        if (volumeSnapshot && volumeSnapshot.length > 0) {
            deviceManager.sendTo(deviceId, (0, systemvolume_1.createSystemVolumePacket)(volumeSnapshot));
        }
    }
    // 5/6. Lock state
    deviceManager.sendTo(deviceId, (0, lock_1.createLockPacket)((0, lock_1.isLocalDeviceLocked)()));
    deviceManager.sendTo(deviceId, (0, lock_1.createLockRequestPacket)(undefined, true));
    // 7. MPRIS Media state
    if ((0, permissions_1.checkDevicePermission)(deviceId, 'mpris')) {
        (0, mpris_1.queryMprisSessions)().then((sessions) => {
            deviceManager.sendTo(deviceId, (0, mpris_1.createMprisStatePacket)(sessions));
        }).catch(() => { });
    }
}
function isSystemSensitivePath(targetPath) {
    if (!targetPath)
        return false;
    try {
        const resolved = path.resolve(targetPath).toLowerCase();
        // Windows System directories
        const winDir = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();
        if (resolved.startsWith(winDir))
            return true;
        const programFiles = (process.env['ProgramFiles'] || 'C:\\Program Files').toLowerCase();
        if (resolved.startsWith(programFiles))
            return true;
        const programFilesX86 = (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase();
        if (resolved.startsWith(programFilesX86))
            return true;
        const commonProgramFiles = (process.env['CommonProgramFiles'] || 'C:\\Program Files\\Common Files').toLowerCase();
        if (resolved.startsWith(commonProgramFiles))
            return true;
        // Boot, System Volume, Recovery, Recycle Bin
        if (resolved.includes(':\\$recycle.bin') || resolved.includes(':\\system volume information') || resolved.includes(':\\recovery')) {
            return true;
        }
        // Crucial user credential / config stores
        if (resolved.includes('\\.ssh') || resolved.includes('\\.aws') || resolved.includes('\\.kube') || resolved.includes('\\.gnupg')) {
            return true;
        }
        // Web Browser User Data (Chrome, Edge, Firefox, Brave) - blocking credentials/session hijacking
        if (resolved.includes('\\appdata\\local\\google\\chrome\\user data') ||
            resolved.includes('\\appdata\\local\\microsoft\\edge\\user data') ||
            resolved.includes('\\appdata\\roaming\\mozilla\\firefox\\profiles')) {
            return true;
        }
        // Unix sensitive directories
        if (resolved.startsWith('/etc') ||
            resolved.startsWith('/boot') ||
            resolved.startsWith('/var') ||
            resolved.startsWith('/sys') ||
            resolved.startsWith('/proc') ||
            resolved.startsWith('/dev') ||
            resolved.startsWith('/root') ||
            resolved.includes('/.ssh')) {
            return true;
        }
    }
    catch {
        return true; // block on resolution error as a safe default
    }
    return false;
}
async function handleFsRequest(body) {
    const { action, path: targetPath, offset, length, isDirectory, newPath, buffer } = body;
    // Intercept and block access to system-sensitive or user-credential directories
    if (targetPath && isSystemSensitivePath(targetPath)) {
        throw new Error('Access Denied: Path contains system-sensitive or credential data.');
    }
    if (newPath && isSystemSensitivePath(newPath)) {
        throw new Error('Access Denied: Path contains system-sensitive or credential data.');
    }
    // Loop prevention: Determine active drive letters/mount paths used by Link mounts. Linux paths
    // are case-sensitive (unlike Windows drive letters), so don't uppercase them.
    const activeLinkDrives = new Set();
    for (const mountService of fsMountServices.values()) {
        const dl = mountService.getDriveLetter();
        activeLinkDrives.add(process.platform === 'linux' ? dl : dl.toUpperCase());
    }
    // Double check if the requested path falls inside an active Link mount
    if (targetPath) {
        if (process.platform === 'linux') {
            const blocked = Array.from(activeLinkDrives).some((mp) => targetPath === mp || targetPath.startsWith(mp + '/'));
            if (blocked) {
                throw new Error('Access to Link virtual mount is blocked to prevent loops.');
            }
        }
        else {
            const driveLetter = targetPath.split(':')[0] + ':';
            if (activeLinkDrives.has(driveLetter.toUpperCase())) {
                throw new Error('Access to Link virtual drive letter is blocked to prevent loops.');
            }
        }
    }
    switch (action) {
        case 'listRoots': {
            // Return physical drives excluding active Link mounts
            return (0, fs_helper_1.getLocalPhysicalDrives)(activeLinkDrives);
        }
        case 'readdir': {
            let items = fs.readdirSync(targetPath, { withFileTypes: true });
            // The Home root (see getLocalPhysicalDrives' Linux branch) would otherwise let a browsing
            // peer walk straight into ~/Link/<other-device-name> — a live view of a DIFFERENT device's
            // phone mount reached through this desktop's own Home root. Filter it out, same pattern as
            // fs-mount-service.ts's translatePath filtering 'android' out of the phone's own listing.
            if (process.platform === 'linux' && targetPath === os.homedir()) {
                items = items.filter((item) => item.name !== 'Link');
            }
            const list = [];
            for (const item of items) {
                const fullPath = path.join(targetPath, item.name);
                let size = 0;
                let mtime = Date.now();
                try {
                    const s = fs.statSync(fullPath);
                    size = s.size;
                    mtime = s.mtimeMs;
                }
                catch { }
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
            }
            else {
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
function isPathProtected(targetPath) {
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
function logCrashToDisk(label, detail) {
    try {
        const logPath = path.join(electron_1.app.getPath('userData'), 'link-config', 'crash.log');
        const line = `[${new Date().toISOString()}] ${label}: ${detail instanceof Error ? (detail.stack || detail.message) : String(detail)}\n`;
        fs.appendFileSync(logPath, line, 'utf8');
    }
    catch {
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
// Periodic SMTC media sessions poll, broadcasting track/state updates to connected peers.
//
// Self-scheduling instead of setInterval, deliberately. Every tick shells out to a brand new
// PowerShell process, and setInterval does not wait for an async callback to settle — so once a
// spawn took longer than the interval, the next poll started while the previous one was still
// running. The exec timeout was itself equal to the interval (3s), so that overlap began as soon
// as the machine was under any load at all, and each surviving process made the next spawn
// slower: 20 PowerShell startups a minute turning into a pile-up that never drained. This is the
// main reason the app felt fine on launch and progressively worse the longer it stayed open.
//
// Waiting for each tick to finish before scheduling the next guarantees at most one of these in
// flight, and a full quiet interval between them.
const MPRIS_POLL_MS = 3000;
let lastMprisJson = '';
async function mprisPollTick() {
    try {
        if (deviceManager?.trustedConnectedDeviceIds().length) {
            const sessions = await (0, mpris_1.queryMprisSessions)();
            const currentJson = JSON.stringify(sessions);
            if (currentJson !== lastMprisJson) {
                lastMprisJson = currentJson;
                broadcastToPermittedPeers('mpris', (0, mpris_1.createMprisStatePacket)(sessions));
            }
        }
    }
    catch {
        // A failed/timed-out probe just means no update this cycle.
    }
    finally {
        setTimeout(mprisPollTick, MPRIS_POLL_MS);
    }
}
setTimeout(mprisPollTick, MPRIS_POLL_MS);
//# sourceMappingURL=main.js.map