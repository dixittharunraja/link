import { contextBridge, ipcRenderer } from 'electron';

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
  getIdentity: () => ipcRenderer.invoke('get-identity'),
  getVisibility: () => ipcRenderer.invoke('get-visibility'),
  setVisibility: (enabled: boolean) => ipcRenderer.invoke('set-visibility', enabled),
  getCloseToTray: () => ipcRenderer.invoke('get-close-to-tray'),
  setCloseToTray: (enabled: boolean) => ipcRenderer.invoke('set-close-to-tray', enabled),
  connectTo: (host: string, port?: number) => ipcRenderer.invoke('connect-to', host, port),
  requestPairing: (deviceId: string) => ipcRenderer.invoke('request-pairing', deviceId),
  acceptPairing: (deviceId: string) => ipcRenderer.invoke('accept-pairing', deviceId),
  rejectPairing: (deviceId: string) => ipcRenderer.invoke('reject-pairing', deviceId),
  unpair: (deviceId: string) => ipcRenderer.invoke('unpair', deviceId),
  removeFromPool: (deviceId: string) => ipcRenderer.invoke('remove-from-pool', deviceId),
  exitPool: () => ipcRenderer.invoke('exit-pool'),
  sendFindMyPhone: (deviceId: string) => ipcRenderer.invoke('send-find-my-phone', deviceId),
  sendStopRinging: (deviceId: string) => ipcRenderer.invoke('send-stop-ringing', deviceId),
  stopRingingLocal: () => ipcRenderer.invoke('stop-ringing-local'),
  renameDevice: (newName: string) => ipcRenderer.invoke('rename-device', newName),
  sendLockRequest: (deviceId: string, setLocked: boolean) => ipcRenderer.invoke('send-lock-request', deviceId, setLocked),
  sendLockStatusRequest: (deviceId: string) => ipcRenderer.invoke('send-lock-status-request', deviceId),

  onDeviceConnected: (cb: (identity: unknown, trusted: boolean) => void) =>
    subscribe('device-connected', (_e, identity, trusted) => cb(identity, trusted)),
  onDeviceDisconnected: (cb: (deviceId: string) => void) =>
    subscribe('device-disconnected', (_e, deviceId) => cb(deviceId)),
  onIncomingPairRequest: (cb: (deviceId: string, verificationKey: string | null) => void) =>
    subscribe('incoming-pair-request', (_e, deviceId, key) => cb(deviceId, key)),
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
  onFindMyPhoneTriggered: (cb: (deviceId: string) => void) =>
    subscribe('find-my-phone-triggered', (_e, deviceId) => cb(deviceId)),
  onFindMyPhoneStopped: (cb: (deviceId: string) => void) =>
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

  getCommands: () => ipcRenderer.invoke('get-commands'),
  setCommand: (key: string, entry: { name: string; command: string }) => ipcRenderer.invoke('set-command', key, entry),
  removeCommand: (key: string) => ipcRenderer.invoke('remove-command', key),
  sendRunCommandTrigger: (deviceId: string, key: string) => ipcRenderer.invoke('send-run-command-trigger', deviceId, key),
  onCommandListReceived: (cb: (deviceId: string, commands: Record<string, { name: string; command: string }>) => void) =>
    subscribe('command-list-received', (_e, deviceId, commands) => cb(deviceId, commands)),

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
  openAppSettings: () => ipcRenderer.invoke('open-app-settings'),
  renameTrustedDevice: (deviceId: string, newName: string) => ipcRenderer.invoke('rename-trusted-device', deviceId, newName),

  // ===== Audio Relay =====
  startAudioRelay: () => ipcRenderer.invoke('start-audio-relay'),
  acceptAudioRelayGuest: (connId: string) => ipcRenderer.invoke('accept-audio-relay-guest', connId),
  rejectAudioRelayGuest: (connId: string) => ipcRenderer.invoke('reject-audio-relay-guest', connId),
  setAudioRelayMuted: (muted: boolean) => ipcRenderer.invoke('set-audio-relay-muted', muted),
  getAudioRelayListeners: () => ipcRenderer.invoke('get-audio-relay-listeners'),
  endAudioRelay: () => ipcRenderer.invoke('end-audio-relay'),
  joinAudioRelayGuest: (host: string) => ipcRenderer.invoke('join-audio-relay-guest', host),
  joinAudioRelayPaired: (host: string, token: string) => ipcRenderer.invoke('join-audio-relay-paired', host, token),
  leaveAudioRelay: () => ipcRenderer.invoke('leave-audio-relay'),
  queryAudioRelaySessions: () => ipcRenderer.invoke('query-audio-relay-sessions'),

  onAudioRelayGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string) => void) =>
    subscribe('audio-relay-guest-pin-pending', (_e, connId, pin, remoteAddress) => cb(connId, pin, remoteAddress)),
  onAudioRelayListenerJoined: (cb: (connId: string, label: string) => void) =>
    subscribe('audio-relay-listener-joined', (_e, connId, label) => cb(connId, label)),
  onAudioRelayListenerLeft: (cb: (connId: string) => void) =>
    subscribe('audio-relay-listener-left', (_e, connId) => cb(connId)),
  onAudioRelayPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) =>
    subscribe('audio-relay-paired-session-started', (_e, deviceId, token, host) => cb(deviceId, token, host)),
  onAudioRelayPairedSessionEnded: (cb: (deviceId: string) => void) =>
    subscribe('audio-relay-paired-session-ended', (_e, deviceId) => cb(deviceId)),
  onAudioRelayPinComputed: (cb: (pin: string) => void) =>
    subscribe('audio-relay-pin-computed', (_e, pin) => cb(pin)),
  onAudioRelayAdmitted: (cb: () => void) => subscribe('audio-relay-admitted', () => cb()),
  onAudioRelayFormat: (cb: (format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean }) => void) =>
    subscribe('audio-relay-format', (_e, format) => cb(format)),
  onAudioRelayAudioChunk: (cb: (pcm: Uint8Array) => void) =>
    subscribe('audio-relay-audio-chunk', (_e, pcm) => cb(pcm)),
  onAudioRelayHostMuted: (cb: (muted: boolean) => void) =>
    subscribe('audio-relay-host-muted', (_e, muted) => cb(muted)),
  onAudioRelayEnded: (cb: () => void) => subscribe('audio-relay-ended', () => cb()),
  onAudioRelayClosed: (cb: (reason: string) => void) =>
    subscribe('audio-relay-closed', (_e, reason) => cb(reason)),
  onAudioRelayError: (cb: (message: string) => void) =>
    subscribe('audio-relay-error', (_e, message) => cb(message)),

  // ===== Remote Mic =====
  joinRemoteMicPaired: (host: string, token: string) => ipcRenderer.invoke('join-remote-mic-paired', host, token),
  leaveRemoteMic: () => ipcRenderer.invoke('leave-remote-mic'),
  queryRemoteMicSessions: () => ipcRenderer.invoke('query-remote-mic-sessions'),

  onRemoteMicPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) =>
    subscribe('remote-mic-paired-session-started', (_e, deviceId, token, host) => cb(deviceId, token, host)),
  onRemoteMicPairedSessionEnded: (cb: (deviceId: string) => void) =>
    subscribe('remote-mic-paired-session-ended', (_e, deviceId) => cb(deviceId)),
  onRemoteMicAdmitted: (cb: () => void) => subscribe('remote-mic-admitted', () => cb()),
  onRemoteMicFormat: (cb: (format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean }) => void) =>
    subscribe('remote-mic-format', (_e, format) => cb(format)),
  onRemoteMicAudioChunk: (cb: (pcm: Uint8Array) => void) =>
    subscribe('remote-mic-audio-chunk', (_e, pcm) => cb(pcm)),
  onRemoteMicEnded: (cb: () => void) => subscribe('remote-mic-ended', () => cb()),
  onRemoteMicClosed: (cb: (reason: string) => void) =>
    subscribe('remote-mic-closed', (_e, reason) => cb(reason)),
  onRemoteMicError: (cb: (message: string) => void) =>
    subscribe('remote-mic-error', (_e, message) => cb(message)),
});
