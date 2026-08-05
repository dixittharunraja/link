import { contextBridge, ipcRenderer, webUtils } from 'electron';

// React.StrictMode (main.tsx) intentionally double-invokes effects in dev mode without ever
// calling a cleanup function here (App.tsx's big setup effect returns none) — every one of these
// on* registrations used to accumulate a second, permanent duplicate listener, so every real
// event (an incoming pair request, in particular) fired its renderer callback twice. Since each
// channel below is dedicated to exactly one App.tsx callback, clearing any previous listener
// before adding the new one makes registration idempotent regardless of how many times it's called.
function subscribe(channel: string, listener: (...args: any[]) => void) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, listener);
}

contextBridge.exposeInMainWorld('link', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getIdentity: () => ipcRenderer.invoke('get-identity'),
  getVisibility: () => ipcRenderer.invoke('get-visibility'),
  setVisibility: (enabled: boolean) => ipcRenderer.invoke('set-visibility', enabled),
  getCloseToTray: () => ipcRenderer.invoke('get-close-to-tray'),
  setCloseToTray: (enabled: boolean) => ipcRenderer.invoke('set-close-to-tray', enabled),
  connectTo: (host: string, port?: number) => {
    const [ip, portStr] = host.split(':');
    const parsedPort = portStr ? parseInt(portStr, 10) : port;
    return ipcRenderer.invoke('connect-to', ip, parsedPort);
  },

  requestPairing: (deviceId: string) => ipcRenderer.invoke('request-pairing', deviceId),
  requestPairingByIp: (ip: string) => ipcRenderer.invoke('request-pairing-by-ip', ip),
  acceptPairing: (deviceId: string) => ipcRenderer.invoke('accept-pairing', deviceId),
  cancelPairing: (deviceId: string) => ipcRenderer.invoke('cancel-pairing', deviceId),
  rejectPairing: (deviceId: string, shouldBlock?: boolean, deviceName?: string, deviceType?: string) =>
    ipcRenderer.invoke('reject-pairing', deviceId, shouldBlock, deviceName, deviceType),
  unpair: (deviceId: string) => ipcRenderer.invoke('unpair', deviceId),
  getBlocklist: () => ipcRenderer.invoke('get-blocklist'),
  blockDevice: (id: string, label: string, type: 'device' | 'ip') => ipcRenderer.invoke('block-device', id, label, type),
  unblockDevice: (id: string) => ipcRenderer.invoke('unblock-device', id),
  sendFindMyPhone: (deviceId: string) => ipcRenderer.invoke('send-find-my-phone', deviceId),
  sendStopRinging: (deviceId: string) => ipcRenderer.invoke('send-stop-ringing', deviceId),
  stopRingingLocal: () => ipcRenderer.invoke('stop-ringing-local'),
  renameDevice: (newName: string) => ipcRenderer.invoke('rename-device', newName),
  sendLockRequest: (deviceId: string, setLocked: boolean) => ipcRenderer.invoke('send-lock-request', deviceId, setLocked),
  sendLockStatusRequest: (deviceId: string) => ipcRenderer.invoke('send-lock-status-request', deviceId),

  getDiscoveredDevices: () => ipcRenderer.invoke('get-discovered-devices'),
  onDeviceDiscovered: (cb: (info: any) => void) =>
    subscribe('device-discovered', (_e, info) => cb(info)),
  onDeviceExpired: (cb: (deviceId: string) => void) =>
    subscribe('device-expired', (_e, deviceId) => cb(deviceId)),

  onDeviceConnected: (cb: (identity: unknown, trusted: boolean) => void) =>
    subscribe('device-connected', (_e, identity, trusted) => cb(identity, trusted)),
  onDeviceDisconnected: (cb: (deviceId: string) => void) =>
    subscribe('device-disconnected', (_e, deviceId) => cb(deviceId)),
  onIncomingPairRequest: (cb: (deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null) => void) =>
    subscribe('incoming-pair-request', (_e, deviceId, deviceName, deviceType, key) => cb(deviceId, deviceName, deviceType, key)),
  onPairingSuccessful: (cb: (deviceId: string) => void) =>
    subscribe('pairing-successful', (_e, deviceId) => cb(deviceId)),
  onPairingFailed: (cb: (deviceId: string, reason: string) => void) =>
    subscribe('pairing-failed', (_e, deviceId, reason) => cb(deviceId, reason)),
  onUnpaired: (cb: (deviceId: string) => void) => subscribe('unpaired', (_e, deviceId) => cb(deviceId)),
  onTrustMismatch: (cb: (deviceId: string) => void) =>
    subscribe('trust-mismatch', (_e, deviceId) => cb(deviceId)),
  onClipboardReceived: (cb: (deviceId: string) => void) =>
    subscribe('clipboard-received', (_e, deviceId) => cb(deviceId)),
  onBatteryReceived: (cb: (deviceId: string, isCharging: boolean, currentCharge: number) => void) =>
    subscribe('battery-received', (_e, deviceId, isCharging, currentCharge) => cb(deviceId, isCharging, currentCharge)),
  sendFindMyDevice: (deviceId: string) => ipcRenderer.invoke('send-find-my-device', deviceId),
  onFindMyDeviceTriggered: (cb: (deviceId: string) => void) =>
    subscribe('find-my-phone-triggered', (_e, deviceId) => cb(deviceId)),
  onFindMyDeviceStopped: (cb: (deviceId: string) => void) =>
    subscribe('find-my-phone-stopped', (_e, deviceId) => cb(deviceId)),
  onLockStateReceived: (cb: (deviceId: string, isLocked: boolean) => void) =>
    subscribe('lock-state-received', (_e, deviceId, isLocked) => cb(deviceId, isLocked)),
  onLockResultReceived: (cb: (deviceId: string, success: boolean) => void) =>
    subscribe('lock-result-received', (_e, deviceId, success) => cb(deviceId, success)),
  onShareReceived: (cb: (deviceId: string, filename: string, size: number) => void) =>
    subscribe('share-received', (_e, deviceId, filename, size) => cb(deviceId, filename, size)),
  onConnectivityReceived: (cb: (deviceId: string, signalStrengths: Record<string, { networkType: string; signalStrength: number }>) => void) =>
    subscribe('connectivity-received', (_e, deviceId, signalStrengths) => cb(deviceId, signalStrengths)),
  onDeviceRenamed: (cb: (deviceId: string, newName: string) => void) =>
    subscribe('device-renamed', (_e, deviceId, newName) => cb(deviceId, newName)),
  onOwnDeviceRenamed: (cb: (newName: string) => void) =>
    subscribe('own-device-renamed', (_e, newName) => cb(newName)),

  sendNotificationReply: (deviceId: string, replyId: string, message: string) =>
    ipcRenderer.invoke('send-notification-reply', deviceId, replyId, message),
  onNotificationReceived: (cb: (deviceId: string, body: any) => void) =>
    subscribe('notification-received', (_e, deviceId, body) => cb(deviceId, body)),
  onNotificationCancelled: (cb: (deviceId: string, id: string) => void) =>
    subscribe('notification-cancelled', (_e, deviceId, id) => cb(deviceId, id)),
  onNotificationBroadcastReceived: (cb: (sourceDeviceId: string, body: any) => void) =>
    subscribe('notification-broadcast-received', (_e, sourceDeviceId, body) => cb(sourceDeviceId, body)),

  getCommands: () => ipcRenderer.invoke('get-commands'),
  setCommand: (key: string, entry: { name: string; command: string }) => ipcRenderer.invoke('set-command', key, entry),
  removeCommand: (key: string) => ipcRenderer.invoke('remove-command', key),
  sendRunCommandTrigger: (deviceId: string, key: string) => ipcRenderer.invoke('send-run-command-trigger', deviceId, key),
  onCommandListReceived: (cb: (deviceId: string, commands: Record<string, { name: string; command: string }>) => void) =>
    subscribe('command-list-received', (_e, deviceId, commands) => cb(deviceId, commands)),

  // Presenter (desktop-as-controller) — mirrors the Capacitor bridge's mobile-controller API.
  sendPresenterMove: (deviceId: string, dx: number, dy: number) => ipcRenderer.invoke('send-presenter-move', deviceId, dx, dy),
  sendPresenterStop: (deviceId: string) => ipcRenderer.invoke('send-presenter-stop', deviceId),
  sendSpecialKey: (deviceId: string, key: number) => ipcRenderer.invoke('send-special-key', deviceId, key),
  cycleTargetDisplay: (deviceId: string) => ipcRenderer.invoke('send-cycle-target-display', deviceId),

  sendDigitizerSession: (deviceId: string, action: string, w: number, h: number) => ipcRenderer.invoke('send-digitizer-session', deviceId, action, w, h),
  sendDigitizerEvent: (deviceId: string, payload: any) => ipcRenderer.invoke('send-digitizer-event', deviceId, payload),
  sendDigitizerAction: (deviceId: string, action: string) => ipcRenderer.invoke('send-digitizer-action', deviceId, action),

  // ===== Joystick (host/desktop side — status + moderation only; the phone drives everything
  // itself via bridge.ts's Capacitor-side sendJoystickHello/sendJoystickState/sendJoystickBye,
  // entirely over raw UDP with no TLS packet type or pairing involved — see joystick.ts) =====
  getJoystickStatus: () => ipcRenderer.invoke('get-joystick-status'),
  checkJoystickDriver: () => ipcRenderer.invoke('check-joystick-driver'),
  kickJoystickController: (ip: string) => ipcRenderer.invoke('kick-joystick-controller', ip),
  blockJoystickController: (ip: string, name?: string) => ipcRenderer.invoke('block-joystick-controller', ip, name),
  acceptJoystickGuest: (connId: string) => ipcRenderer.invoke('accept-joystick-guest', connId),
  rejectJoystickGuest: (connId: string) => ipcRenderer.invoke('reject-joystick-guest', connId),
  blockJoystickGuest: (connId: string) => ipcRenderer.invoke('block-joystick-guest', connId),
  onJoystickRosterChanged: (cb: () => void) => subscribe('joystick-roster-changed', () => cb()),
  onJoystickDriverStatus: (cb: (status: string, error: string | null) => void) =>
    subscribe('joystick-driver-status', (_e, status, error) => cb(status, error)),
  onJoystickGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, name: string) => void) =>
    subscribe('joystick-guest-pin-pending', (_e, connId, pin, remoteAddress, name) => cb(connId, pin, remoteAddress, name)),

  sendSetVolume: (deviceId: string, sinkName: string, volume: number) => ipcRenderer.invoke('send-set-volume', deviceId, sinkName, volume),
  sendSetMute: (deviceId: string, sinkName: string, muted: boolean) => ipcRenderer.invoke('send-set-mute', deviceId, sinkName, muted),
  onSystemVolumeReceived: (cb: (deviceId: string, body: any) => void) =>
    subscribe('system-volume-received', (_e, deviceId, body) => cb(deviceId, body)),

  sendFlashlightToggle: (deviceId: string, enabled: boolean) => ipcRenderer.invoke('send-flashlight-toggle', deviceId, enabled),
  sendDndSet: (deviceId: string, enabled: boolean) => ipcRenderer.invoke('send-dnd-set', deviceId, enabled),
  onFlashlightStateReceived: (cb: (deviceId: string, enabled: boolean, revoked?: boolean) => void) =>
    subscribe('flashlight-state-received', (_e, deviceId, enabled, revoked) => cb(deviceId, enabled, revoked)),
  onDndStateReceived: (cb: (deviceId: string, enabled: boolean, granted: boolean, revoked?: boolean) => void) =>
    subscribe('dnd-state-received', (_e, deviceId, enabled, granted, revoked) => cb(deviceId, enabled, granted, revoked)),

  sendMprisAction: (deviceId: string, player: string, action: string) => ipcRenderer.invoke('send-mpris-action', deviceId, player, action),
  onMprisStateReceived: (cb: (deviceId: string, body: any) => void) =>
    subscribe('mpris-state-received', (_e, deviceId, body) => cb(deviceId, body)),

  onPeerCapabilitiesReceived: (cb: (deviceId: string, capabilities: string[]) => void) =>
    subscribe('peer-capabilities-received', (_e, deviceId, capabilities) => cb(deviceId, capabilities)),

  fsGetConnectedDevices: () => ipcRenderer.invoke('fs-get-connected-devices'),
  fsListRoots: (deviceId: string) => ipcRenderer.invoke('fs-list-roots', deviceId),
  fsReaddir: (deviceId: string, path: string) => ipcRenderer.invoke('fs-readdir', deviceId, path),
  fsStat: (deviceId: string, path: string) => ipcRenderer.invoke('fs-stat', deviceId, path),
  fsRead: (deviceId: string, path: string, offset: number, length: number) => ipcRenderer.invoke('fs-read', deviceId, path, offset, length),
  fsUploadItem: (deviceId: string, localPath: string, remoteParentPath: string) => ipcRenderer.invoke('fs-upload-item', deviceId, localPath, remoteParentPath),
  fsPickUploadItems: (mode: 'file' | 'directory') => ipcRenderer.invoke('fs-pick-upload-items', mode),
  expandDroppedPaths: (filePaths: string[]) => ipcRenderer.invoke('expand-dropped-paths', filePaths),
  getPauseMusicEnabled: () => ipcRenderer.invoke('get-pause-music-enabled'),
  setPauseMusicEnabled: (enabled: boolean) => ipcRenderer.invoke('set-pause-music-enabled', enabled),
  getScreensaverInhibitEnabled: () => ipcRenderer.invoke('get-screensaver-inhibit-enabled'),
  setScreensaverInhibitEnabled: (enabled: boolean) => ipcRenderer.invoke('set-screensaver-inhibit-enabled', enabled),
  getOpenAtLogin: () => ipcRenderer.invoke('get-open-at-login'),
  setOpenAtLogin: (enabled: boolean) => ipcRenderer.invoke('set-open-at-login', enabled),

  runSpeedTest: (deviceId: string) => ipcRenderer.invoke('run-speed-test', deviceId),
  onSpeedTestProgress: (cb: (deviceId: string, message: string) => void) =>
    subscribe('speed-test-progress', (_e, deviceId, message) => cb(deviceId, message)),

  getPermissions: () => ipcRenderer.invoke('get-permissions'),
  setPermissions: (permissions: any) => ipcRenderer.invoke('set-permissions', permissions),
  getTrustedDevices: () => ipcRenderer.invoke('get-trusted-devices'),
  getConnectedDevices: () => ipcRenderer.invoke('get-connected-devices'),
  resyncDevices: () => ipcRenderer.invoke('resync-devices'),
  exitPool: () => ipcRenderer.invoke('exit-pool'),
  sendRemoteInput: (deviceId: string, text?: string, specialKey?: string) => ipcRenderer.invoke('send-remote-input', deviceId, text, specialKey),
  openAppSettings: () => ipcRenderer.invoke('open-app-settings'),
  renameTrustedDevice: (deviceId: string, newName: string) => ipcRenderer.invoke('rename-trusted-device', deviceId, newName),

  // ===== Audio Sink =====
  startAudioSink: () => ipcRenderer.invoke('start-audio-sink'),
  setAudioSinkMuted: (muted: boolean) => ipcRenderer.invoke('set-audio-sink-muted', muted),
  kickAudioSinkListener: (connId: string) => ipcRenderer.invoke('kick-audio-sink-listener', connId),
  blockAudioSinkListener: (connId: string) => ipcRenderer.invoke('block-audio-sink-listener', connId),
  getAudioSinkListeners: () => ipcRenderer.invoke('get-audio-sink-listeners'),
  endAudioSink: () => ipcRenderer.invoke('end-audio-sink'),
  joinAudioSinkGuest: (host: string) => ipcRenderer.invoke('join-audio-sink-guest', host),
  joinAudioSinkPaired: (host: string, token: string) => ipcRenderer.invoke('join-audio-sink-paired', host, token),
  acceptAudioSinkGuest: (connId: string) => ipcRenderer.invoke('accept-audio-sink-guest', connId),
  rejectAudioSinkGuest: (connId: string) => ipcRenderer.invoke('reject-audio-sink-guest', connId),
  blockAudioSinkGuest: (connId: string) => ipcRenderer.invoke('block-audio-sink-guest', connId),
  leaveAudioSink: () => ipcRenderer.invoke('leave-audio-sink'),
  queryAudioSinkSessions: () => ipcRenderer.invoke('query-audio-sink-sessions'),

  onAudioSinkListenerJoined: (cb: (connId: string, label: string) => void) =>
    subscribe('audio-sink-listener-joined', (_e, connId, label) => cb(connId, label)),
  onAudioSinkListenerLeft: (cb: (connId: string) => void) =>
    subscribe('audio-sink-listener-left', (_e, connId) => cb(connId)),
  onAudioSinkGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) =>
    subscribe('audio-sink-guest-pin-pending', (_e, connId, pin, remoteAddress, deviceName) => cb(connId, pin, remoteAddress, deviceName)),
  onAudioSinkPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) =>
    subscribe('audio-sink-paired-session-started', (_e, deviceId, token, host) => cb(deviceId, token, host)),
  onAudioSinkPairedSessionEnded: (cb: (deviceId: string) => void) =>
    subscribe('audio-sink-paired-session-ended', (_e, deviceId) => cb(deviceId)),
  onAudioSinkAdmitted: (cb: (hostLabel: string) => void) => subscribe('audio-sink-admitted', (_e, hostLabel) => cb(hostLabel)),
  onAudioSinkFormat: (cb: (format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean }) => void) =>
    subscribe('audio-sink-format', (_e, format) => cb(format)),
  onAudioSinkAudioChunk: (cb: (pcm: Uint8Array) => void) =>
    subscribe('audio-sink-audio-chunk', (_e, pcm) => cb(pcm)),
  onAudioSinkHostMuted: (cb: (muted: boolean) => void) =>
    subscribe('audio-sink-host-muted', (_e, muted) => cb(muted)),
  onAudioSinkEnded: (cb: (reason?: string) => void) => subscribe('audio-sink-ended', (_e, reason) => cb(reason)),
  onAudioSinkClosed: (cb: (reason: string) => void) =>
    subscribe('audio-sink-closed', (_e, reason) => cb(reason)),
  onAudioSinkError: (cb: (message: string) => void) =>
    subscribe('audio-sink-error', (_e, message) => cb(message)),
  onAudioSinkPinComputed: (cb: (pin: string) => void) =>
    subscribe('audio-sink-pin-computed', (_e, pin) => cb(pin)),

  getAudioSinkStatus: () => ipcRenderer.invoke('get-audio-sink-status'),

  // ===== Remote Mic =====
  joinRemoteMicGuest: (host: string) => ipcRenderer.invoke('join-remote-mic-guest', host),
  joinRemoteMicPaired: (host: string, token: string) => ipcRenderer.invoke('join-remote-mic-paired', host, token),
  leaveRemoteMic: () => ipcRenderer.invoke('leave-remote-mic'),
  queryRemoteMicSessions: () => ipcRenderer.invoke('query-remote-mic-sessions'),
  getRemoteMicStatus: () => ipcRenderer.invoke('get-remote-mic-status'),


  onRemoteMicPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) =>
    subscribe('remote-mic-paired-session-started', (_e, deviceId, token, host) => cb(deviceId, token, host)),
  onRemoteMicPairedSessionEnded: (cb: (deviceId: string) => void) =>
    subscribe('remote-mic-paired-session-ended', (_e, deviceId) => cb(deviceId)),
  onRemoteMicAdmitted: (cb: () => void) => subscribe('remote-mic-admitted', () => cb()),
  onRemoteMicFormat: (cb: (format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean }) => void) =>
    subscribe('remote-mic-format', (_e, format) => cb(format)),
  onRemoteMicAudioChunk: (cb: (pcm: Uint8Array) => void) =>
    subscribe('remote-mic-audio-chunk', (_e, pcm) => cb(pcm)),
  onRemoteMicEnded: (cb: (reason?: string) => void) => subscribe('remote-mic-ended', (_e, reason) => cb(reason)),
  onRemoteMicClosed: (cb: (reason: string) => void) =>
    subscribe('remote-mic-closed', (_e, reason) => cb(reason)),
  onRemoteMicError: (cb: (message: string) => void) =>
    subscribe('remote-mic-error', (_e, message) => cb(message)),
  onRemoteMicPinComputed: (cb: (pin: string) => void) =>
    subscribe('remote-mic-pin-computed', (_e, pin) => cb(pin)),

  // ===== Walkie Talkie (real-time group voice, WebRTC hub-and-spoke) =====
  // Pure signaling relay — session membership, mixing, and SDP/ICE negotiation logic all lives in
  // WalkieTalkieTab.tsx (shared with mobile), which treats `type`/`body` as opaque. The actual
  // audio is peer-to-peer WebRTC and never touches this IPC layer at all.
  sendWalkieTalkieSignal: (deviceId: string, type: string, body: any) =>
    ipcRenderer.invoke('send-walkie-talkie-signal', deviceId, type, body),
  broadcastWalkieTalkieSignal: (type: string, body: any) =>
    ipcRenderer.invoke('broadcast-walkie-talkie-signal', type, body),
  onWalkieTalkieSignal: (cb: (deviceId: string, type: string, body: any) => void) =>
    subscribe('walkie-talkie-signal', (_e, deviceId, type, body) => cb(deviceId, type, body)),

  // --- Guest-facing (an unpaired participant reaches us via manual IP + PIN instead) ---
  startWalkieTalkieGuestListener: () => ipcRenderer.invoke('start-walkie-talkie-guest-listener'),
  stopWalkieTalkieGuestListener: () => ipcRenderer.invoke('stop-walkie-talkie-guest-listener'),
  acceptWalkieTalkieGuest: (connId: string) => ipcRenderer.invoke('accept-walkie-talkie-guest', connId),
  rejectWalkieTalkieGuest: (connId: string) => ipcRenderer.invoke('reject-walkie-talkie-guest', connId),
  kickWalkieTalkieGuest: (connId: string) => ipcRenderer.invoke('kick-walkie-talkie-guest', connId),
  blockWalkieTalkieGuest: (connId: string) => ipcRenderer.invoke('block-walkie-talkie-guest', connId),
  blockWalkieTalkieMember: (deviceId: string, label: string) => ipcRenderer.invoke('block-walkie-talkie-member', deviceId, label),
  sendWalkieTalkieGuestSignal: (connId: string, type: string, body: any) =>
    ipcRenderer.invoke('send-walkie-talkie-guest-signal', connId, type, body),
  onWalkieTalkieGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) =>
    subscribe('walkie-talkie-guest-pin-pending', (_e, connId, pin, remoteAddress, deviceName) => cb(connId, pin, remoteAddress, deviceName)),
  onWalkieTalkieGuestSignal: (cb: (connId: string, type: string, body: any) => void) =>
    subscribe('walkie-talkie-guest-signal', (_e, connId, type, body) => cb(connId, type, body)),
  onWalkieTalkieGuestLeft: (cb: (connId: string) => void) =>
    subscribe('walkie-talkie-guest-left', (_e, connId) => cb(connId)),

  // --- Guest-side (us joining someone else's session via manual IP, unpaired) ---
  joinWalkieTalkieGuest: (host: string) => ipcRenderer.invoke('join-walkie-talkie-guest', host),
  leaveWalkieTalkieGuest: () => ipcRenderer.invoke('leave-walkie-talkie-guest'),
  sendWalkieTalkieGuestMessage: (type: string, body: any) =>
    ipcRenderer.invoke('send-walkie-talkie-guest-message', type, body),

  onWalkieTalkieHostSignal: (cb: (type: string, body: any) => void) =>
    subscribe('walkie-talkie-host-signal', (_e, type, body) => cb(type, body)),
  onWalkieTalkieHostEnded: (cb: (reason?: string) => void) => subscribe('walkie-talkie-host-ended', (_e, reason) => cb(reason)),
  onWalkieTalkieHostClosed: (cb: (reason: string) => void) =>
    subscribe('walkie-talkie-host-closed', (_e, reason) => cb(reason)),
  onWalkieTalkieHostError: (cb: (message: string) => void) =>
    subscribe('walkie-talkie-host-error', (_e, message) => cb(message)),
  onWalkieTalkieGuestPinComputed: (cb: (pin: string) => void) =>
    subscribe('walkie-talkie-guest-pin-computed', (_e, pin) => cb(pin)),

  // ===== Portal Mode (one-time file transfer to an untrusted/unpaired device) =====
  pickPortalFiles: (mode: 'file' | 'directory') => ipcRenderer.invoke('pick-portal-files', mode),
  pickPortalSaveDir: () => ipcRenderer.invoke('pick-portal-save-dir'),
  startPortalReceive: (webMode?: boolean) => ipcRenderer.invoke('start-portal-receive', webMode),
  holdPortalGuest: (connId: string) => ipcRenderer.invoke('hold-portal-guest', connId),
  acceptPortalGuest: (connId: string, saveDir?: string) => ipcRenderer.invoke('accept-portal-guest', connId, saveDir),
  rejectPortalGuest: (connId: string) => ipcRenderer.invoke('reject-portal-guest', connId),
  blockPortalGuest: (connId: string) => ipcRenderer.invoke('block-portal-guest', connId),
  endPortalReceive: () => ipcRenderer.invoke('end-portal-receive'),
  joinPortalGuest: (host: string, files: { localPath: string; relPath: string }[]) => ipcRenderer.invoke('join-portal-guest', host, files),
  leavePortalSend: () => ipcRenderer.invoke('leave-portal-send'),
  disconnectPortalConnection: (connId: string) => ipcRenderer.invoke('disconnect-portal-connection', connId),
  setPortalDownloads: (files: { name: string; localPath: string }[]) => ipcRenderer.invoke('set-portal-downloads', files),

  onPortalGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) =>
    subscribe('portal-guest-pin-pending', (_e, connId, pin, remoteAddress, deviceName) => cb(connId, pin, remoteAddress, deviceName)),
  onPortalConnectionAdmitted: (cb: (connId: string, deviceName: string) => void) =>
    subscribe('portal-connection-admitted', (_e, connId, deviceName) => cb(connId, deviceName)),
  onPortalConnectionClosed: (cb: (connId: string) => void) =>
    subscribe('portal-connection-closed', (_e, connId) => cb(connId)),
  onPortalFileStarted: (cb: (fileIndex: number, fileCount: number, name: string) => void) =>
    subscribe('portal-file-started', (_e, fileIndex, fileCount, name) => cb(fileIndex, fileCount, name)),
  onPortalTransferStarted: (cb: (connId: string, name: string, size: number) => void) =>
    subscribe('portal-transfer-started', (_e, connId, name, size) => cb(connId, name, size)),
  onPortalTransferProgress: (cb: (connId: string, received: number, size: number) => void) =>
    subscribe('portal-transfer-progress', (_e, connId, received, size) => cb(connId, received, size)),
  onPortalTransferComplete: (cb: (connId: string, destPath: string) => void) =>
    subscribe('portal-transfer-complete', (_e, connId, destPath) => cb(connId, destPath)),
  onPortalPinComputed: (cb: (pin: string) => void) =>
    subscribe('portal-pin-computed', (_e, pin) => cb(pin)),
  onPortalAdmitted: (cb: (receiverDeviceName?: string) => void) => subscribe('portal-admitted', (_e, receiverDeviceName) => cb(receiverDeviceName)),
  onPortalSendProgress: (cb: (sent: number, total: number) => void) =>
    subscribe('portal-send-progress', (_e, sent, total) => cb(sent, total)),
  onPortalSendComplete: (cb: () => void) => subscribe('portal-send-complete', () => cb()),
  onPortalEnded: (cb: () => void) => subscribe('portal-ended', () => cb()),
  onPortalClosed: (cb: (reason: string) => void) =>
    subscribe('portal-closed', (_e, reason) => cb(reason)),
  onPortalError: (cb: (message: string) => void) =>
    subscribe('portal-error', (_e, message) => cb(message)),
  getPortalStatus: () => ipcRenderer.invoke('get-portal-status'),

  // ===== File System Mount Configuration =====
  getDeviceMountConfig: (deviceId: string) => ipcRenderer.invoke('get-device-mount-config', deviceId),
  setDeviceMountLetter: (deviceId: string, driveLetter: string) => ipcRenderer.invoke('set-device-mount-letter', deviceId, driveLetter),
  onDeviceMountChanged: (cb: (deviceId: string, driveLetter?: string) => void) => subscribe('device-mount-changed', (_e, deviceId, driveLetter) => cb(deviceId, driveLetter)),

  // ===== Built-in File Explorer Client APIs =====
  fsCreateDirectory: (deviceId: string, path: string) => ipcRenderer.invoke('fs-create-directory', deviceId, path),
  fsDelete: (deviceId: string, path: string) => ipcRenderer.invoke('fs-delete', deviceId, path),
  fsRename: (deviceId: string, path: string, newPath: string) => ipcRenderer.invoke('fs-rename', deviceId, path, newPath),
  fsDownloadFile: (deviceId: string, remotePath: string, localPath: string) => ipcRenderer.invoke('fs-download-file', deviceId, remotePath, localPath),
  fsPickSavePath: (defaultName: string) => ipcRenderer.invoke('fs-pick-save-path', defaultName),
  fsMountDevice: (deviceId: string) => ipcRenderer.invoke('fs-mount-device', deviceId),
  fsUnmountDevice: (deviceId: string) => ipcRenderer.invoke('fs-unmount-device', deviceId),
  fsGetStreamUrl: (deviceId: string, remotePath: string) => ipcRenderer.invoke('fs-get-stream-url', deviceId, remotePath),

  getPinLockEnabled: () => ipcRenderer.invoke('get-pin-lock-enabled'),
  setPinLockEnabled: (enabled: boolean) => ipcRenderer.invoke('set-pin-lock-enabled', enabled),
  getPinCode: () => ipcRenderer.invoke('get-pin-code'),
  setPinCode: (pin: string) => ipcRenderer.invoke('set-pin-code', pin),
  onAppResumed: (cb: () => void) => { /* no-op on desktop */ },
  onLocalIdentityUpdated: (cb: (identity: any) => void) => subscribe('local-identity-updated', (_e, identity) => cb(identity))
});
