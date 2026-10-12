/// <reference types="vite/client" />

declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.jpeg' {
  const src: string;
  export default src;
}

export interface LinkApi {
  isMobile?: boolean;
  getIdentity: () => Promise<any>;
  getVisibility: () => Promise<boolean>;
  setVisibility: (enabled: boolean) => Promise<any>;
  getDiscoveredDevices: () => Promise<any[]>;
  onDeviceDiscovered: (cb: (info: any) => void) => () => void;
  onDeviceExpired: (cb: (deviceId: string) => void) => () => void;
  connectTo: (host: string) => Promise<any>;

  // Pairing
  requestPairing: (deviceId: string) => Promise<string>;
  requestPairingByIp: (ip: string) => Promise<{ pin: string; deviceId: string } | null>;
  acceptPairing: (deviceId: string) => Promise<any>;
  cancelPairing: (deviceId: string) => Promise<any>;
  rejectPairing: (deviceId: string, shouldBlock?: boolean, deviceName?: string, deviceType?: string) => Promise<any>;
  unpair: (deviceId: string) => Promise<any>;
  exitPool: () => Promise<any>;

  // Blocklist
  getBlocklist: () => Promise<any[]>;
  blockDevice: (id: string, label: string, type: 'device' | 'ip') => Promise<any[]>;
  unblockDevice: (id: string) => Promise<any[]>;

  // Device Actions
  sendFindMyDevice: (deviceId: string) => Promise<any>;
  sendStopRinging: (deviceId: string) => Promise<any>;
  stopRingingLocal: () => Promise<any>;
  renameDevice: (newName: string) => Promise<string>;
  sendLockRequest: (deviceId: string, setLocked: boolean) => Promise<any>;
  sendLockStatusRequest: (deviceId: string) => Promise<any>;
  sendFlashlightToggle: (deviceId: string, enabled: boolean) => Promise<any>;
  sendDndSet: (deviceId: string, enabled: boolean) => Promise<any>;
  
  // Volume & MPRIS
  sendSetVolume: (deviceId: string, sinkName: string, volume: number) => Promise<any>;
  sendSetMute: (deviceId: string, sinkName: string, muted: boolean) => Promise<any>;
  sendMprisAction: (deviceId: string, player: string, action: string) => Promise<any>;

  // Speed Test & Commands
  runSpeedTest: (deviceId: string) => Promise<any>;
  pickCommandFile?: () => Promise<string | null>;
  getCommands: () => Promise<any>;
  setCommand: (key: string, cmd: any) => Promise<any>;
  removeCommand: (key: string) => Promise<any>;
  sendRunCommandTrigger: (deviceId: string, key: string) => Promise<any>;
  sendNotificationReply: (deviceId: string, replyId: string, message: string) => Promise<any>;

  // Config
  getPauseMusicEnabled: () => Promise<boolean>;
  setPauseMusicEnabled: (enabled: boolean) => Promise<any>;
  getScreensaverInhibitEnabled: () => Promise<boolean>;
  setScreensaverInhibitEnabled: (enabled: boolean) => Promise<any>;
  getCloseToTray: () => Promise<boolean>;
  setCloseToTray: (enabled: boolean) => Promise<any>;
  getOpenAtLogin: () => Promise<boolean>;
  setOpenAtLogin: (enabled: boolean) => Promise<any>;
  repairFirewall?: () => Promise<void>;

  // Mobile Permissions & Actions
  checkPermissions: () => Promise<any>;
  requestPermissions: (permission: string) => Promise<any>;
  requestMobilePermission: (permission: string) => Promise<any>;
  checkNotificationAccess: () => Promise<any>;
  requestNotificationAccess: () => Promise<any>;
  checkAllFilesAccess: () => Promise<any>;
  requestAllFilesAccess: () => Promise<any>;
  checkDndPermission: () => Promise<any>;
  requestDndPermission: () => Promise<any>;
  isBatteryOptimizationIgnored: () => Promise<any>;
  requestIgnoreBatteryOptimizations: () => Promise<any>;
  checkAccessibility: () => Promise<any>;
  requestAccessibility: () => Promise<any>;
  checkOverlayPermission: () => Promise<any>;
  requestOverlayPermission: () => Promise<any>;
  minimizeApp: () => Promise<any>;

  // Input Relays
  sendRemoteInput: (deviceId: string, text?: string, specialKey?: string) => Promise<any>;
  sendRemoteControlSignal?: (deviceId: string, signalBody: any) => Promise<any>;
  sendRemoteControlInput?: (deviceId: string, inputBody: any) => Promise<any>;
  requestRemoteControlHost?: (deviceId?: string) => Promise<boolean>;
  stopRemoteControlHost?: () => Promise<any>;
  sendPresenterMove: (deviceId: string, dx: number, dy: number) => Promise<any>;
  cycleTargetDisplay: (deviceId: string) => Promise<any>;
  sendPresenterStop: (deviceId: string) => Promise<any>;
  sendSpecialKey: (deviceId: string, key: number) => Promise<any>;
  sendMouseMove: (deviceId: string, dx: number, dy: number) => Promise<any>;
  sendMouseScroll: (deviceId: string, dx: number, dy: number) => Promise<any>;
  sendMouseClick: (deviceId: string, clickType: string) => Promise<any>;
  sendMouseDrag: (deviceId: string, hold: boolean) => Promise<any>;
  sendDigitizerSession: (deviceId: string, action: string, w: number, h: number) => Promise<any>;
  sendDigitizerEvent: (deviceId: string, payload: any) => Promise<any>;
  sendDigitizerAction: (deviceId: string, action: string) => Promise<any>;
  sendJoystickHello: (host: string, name: string) => Promise<any>;
  sendJoystickBye: (host: string) => Promise<any>;
  sendJoystickState: (host: string, lx: number, ly: number, rx: number, ry: number, lt: number, rt: number, buttons: number) => Promise<any>;
  vibrate?: (amplitude: number, durationMs: number) => Promise<any>;
  onJoystickHelloAck: (cb: (ok: boolean, padIndex: number | null, error: string | null) => void) => () => void;
  onJoystickPinRequired: (cb: (pin: string) => void) => () => void;
  onJoystickPing: (cb: () => void) => () => void;
  onJoystickForcedDisconnect: (cb: (reason: string) => void) => () => void;
  startJoystickHost?: () => Promise<any>;
  stopJoystickHost?: () => Promise<any>;
  requestShizukuPermission?: () => Promise<any>;
  getJoystickStatus?: () => Promise<any>;
  checkJoystickDriver?: () => Promise<any>;
  acceptJoystickGuest?: (connId: string) => Promise<any>;
  rejectJoystickGuest?: (connId: string) => Promise<any>;
  blockJoystickGuest?: (connId: string) => Promise<any>;
  kickJoystickGuest?: (connId: string) => Promise<any>;
  kickJoystickController?: (ip: string) => Promise<any>;
  blockJoystickController?: (ip: string, label?: string) => Promise<any>;
  onJoystickDriverStatus?: (cb: (status: any, error: string | null) => void) => () => void;
  onJoystickRosterChanged?: (cb: () => void) => () => void;
  onJoystickGuestPinPending?: (cb: (connId: string, pin: string, remoteAddress: string, name: string) => void) => () => void;
  // Input Guest Session (Presenter & Remote Control)
  startInputGuestHost?: () => Promise<any>;
  stopInputGuestHost?: () => Promise<any>;
  joinInputGuest?: (host: string, name?: string, mode?: 'presenter' | 'touchpad' | 'remotecontrol') => Promise<any>;
  leaveInputGuest?: () => Promise<any>;
  getInputGuestStatus?: () => Promise<any>;
  acceptInputGuest?: (connId: string) => Promise<any>;
  rejectInputGuest?: (connId: string) => Promise<any>;
  blockInputGuest?: (connId: string) => Promise<any>;
  kickInputGuest?: (ip: string) => Promise<any>;
  onInputGuestPinPending?: (cb: (connId: string, pin: string, remoteAddress: string, name: string, mode: 'presenter' | 'touchpad' | 'remotecontrol') => void) => () => void;
  onInputGuestPinRequired?: (cb: (pin: string) => void) => () => void;
  onInputGuestAdmitted?: (cb: (mode: 'presenter' | 'touchpad' | 'remotecontrol', resolvedHost?: string, hostDeviceType?: string) => void) => () => void;
  onInputGuestClosed?: (cb: (reason: string) => void) => () => void;
  onInputGuestError?: (cb: (error: string) => void) => () => void;
  onInputGuestRosterChanged?: (cb: () => void) => () => void;

  // Audio Sink
  getAudioSinkDevices?: () => Promise<{ id: string; name: string; isDefault: boolean }[]>;
  startAudioSink: (audioDeviceId?: string) => Promise<any>;
  switchAudioSinkDevice?: (audioDeviceId?: string) => Promise<any>;
  setAudioSinkMuted: (muted: boolean) => Promise<any>;
  kickAudioSinkListener: (connId: string) => Promise<any>;
  blockAudioSinkListener: (connId: string) => Promise<any>;
  getAudioSinkListeners: () => Promise<any[]>;
  getAudioSinkStatus: () => Promise<any>;
  endAudioSink: () => Promise<any>;
  joinAudioSinkGuest: (host: string) => Promise<any>;
  joinAudioSinkPaired: (host: string, token: string, deviceName?: string) => Promise<any>;
  acceptAudioSinkGuest: (connId: string) => Promise<any>;
  rejectAudioSinkGuest: (connId: string) => Promise<any>;
  blockAudioSinkGuest: (connId: string) => Promise<any>;
  leaveAudioSink: () => Promise<any>;
  queryAudioSinkSessions: () => Promise<any>;
  setAudioSinkListenerVolume: (volume: number) => Promise<any>;
  onAudioSinkListenerJoined: (cb: (id: string, label: string) => void) => () => void;
  onAudioSinkListenerLeft: (cb: (id: string) => void) => () => void;
  onAudioSinkGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => () => void;
  onAudioSinkPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) => () => void;
  onAudioSinkPairedSessionEnded: (cb: (deviceId: string) => void) => () => void;
  onAudioSinkAdmitted: (cb: (hostName: string) => void) => () => void;
  onAudioSinkStats?: (cb: (stats: { latencyMs: number; bufferMs: number; underruns: number; dropped: number; clockSynced: boolean }) => void) => () => void;
  onAudioSinkFormat: (cb: (format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean }) => void) => () => void;
  onAudioSinkAudioChunk: (cb: (pcm: Uint8Array) => void) => () => void;
  onAudioSinkHostMuted: (cb: (muted: boolean) => void) => () => void;
  onAudioSinkEnded: (cb: () => void) => () => void;
  onAudioSinkClosed: (cb: (reason: string) => void) => () => void;
  onAudioSinkError: (cb: (message: string) => void) => () => void;
  onAudioSinkPinComputed: (cb: (pin: string) => void) => () => void;

  // Remote Mic
  startRemoteMic?: () => Promise<any>;
  setRemoteMicMuted?: (muted: boolean) => Promise<any>;
  kickRemoteMicListener?: (connId: string) => Promise<any>;
  blockRemoteMicListener?: (connId: string) => Promise<any>;
  acceptRemoteMicGuest?: (connId: string) => Promise<any>;
  rejectRemoteMicGuest?: (connId: string) => Promise<any>;
  blockRemoteMicGuest?: (connId: string) => Promise<any>;
  getRemoteMicListeners?: () => Promise<any[]>;
  getRemoteMicStatus?: () => Promise<any>;
  endRemoteMic?: () => Promise<any>;
  queryRemoteMicSessions?: () => Promise<any>;
  joinRemoteMicPaired?: (host: string, token: string) => Promise<any>;
  joinRemoteMicGuest?: (host: string) => Promise<any>;
  leaveRemoteMic?: () => Promise<any>;
  onRemoteMicGuestPinPending?: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => () => void;
  onRemoteMicListenerJoined?: (cb: (id: string, label: string) => void) => () => void;
  onRemoteMicListenerLeft?: (cb: (id: string) => void) => () => void;
  onRemoteMicError?: (cb: (message: string) => void) => () => void;
  onRemoteMicPairedSessionStarted?: (cb: (deviceId: string, token: string, host: string) => void) => () => void;
  onRemoteMicPairedSessionEnded?: (cb: (deviceId: string) => void) => () => void;
  onRemoteMicPinComputed?: (cb: (computedPin: string) => void) => () => void;
  onRemoteMicAdmitted?: (cb: () => void) => () => void;
  onRemoteMicFormat?: (cb: (format: any) => void) => () => void;
  onRemoteMicAudioChunk?: (cb: (pcm: Uint8Array) => void) => () => void;
  onRemoteMicEnded?: (cb: (reason?: string) => void) => () => void;
  onRemoteMicClosed?: (cb: (reason: string) => void) => () => void;

  // Walkie Talkie
  sendWalkieTalkieSignal?: (deviceId: string, type: string, body: any) => Promise<any>;
  broadcastWalkieTalkieSignal?: (type: string, body: any) => Promise<any>;
  onWalkieTalkieSignal?: (cb: (deviceId: string, type: string, body: any) => void) => () => void;
  startWalkieTalkieGuestListener?: () => Promise<any>;
  stopWalkieTalkieGuestListener?: () => Promise<any>;
  acceptWalkieTalkieGuest?: (connId: string) => Promise<any>;
  rejectWalkieTalkieGuest?: (connId: string) => Promise<any>;
  kickWalkieTalkieGuest?: (connId: string) => Promise<any>;
  blockWalkieTalkieGuest?: (connId: string) => Promise<any>;
  blockWalkieTalkieMember?: (deviceId: string, label: string) => Promise<any>;
  sendWalkieTalkieGuestSignal?: (connId: string, type: string, body: any) => Promise<any>;
  onWalkieTalkieGuestPinPending?: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => () => void;
  onWalkieTalkieGuestSignal?: (cb: (connId: string, type: string, body: any) => void) => () => void;
  onWalkieTalkieGuestLeft?: (cb: (connId: string) => void) => () => void;
  joinWalkieTalkieGuest?: (host: string) => Promise<any>;
  leaveWalkieTalkieGuest?: () => Promise<any>;
  sendWalkieTalkieGuestMessage?: (type: string, body: any) => Promise<any>;
  onWalkieTalkieGuestPinComputed?: (cb: (pin: string) => void) => () => void;
  onWalkieTalkieHostSignal?: (cb: (type: string, body: any) => void) => () => void;
  onWalkieTalkieHostEnded?: (cb: (reason?: string) => void) => () => void;
  onWalkieTalkieHostClosed?: (cb: (reason: string) => void) => () => void;
  onWalkieTalkieHostError?: (cb: (message: string) => void) => () => void;

  // Portal Mode
  pickPortalFiles?: (mode?: 'file' | 'directory') => Promise<any>;
  pickPortalSaveDir?: () => Promise<string | null>;
  startPortalReceive?: (mode?: any) => Promise<any>;
  acceptPortalGuest?: (connId: string, saveDir?: string) => Promise<any>;
  rejectPortalGuest?: (connId: string) => Promise<any>;
  blockPortalGuest?: (connId: string) => Promise<any>;
  holdPortalGuest?: (connId?: string, hold?: boolean) => Promise<any>;
  disconnectPortalConnection?: (connId: string) => Promise<any>;
  endPortalReceive?: () => Promise<any>;
  joinPortalGuest?: (host: string, filePaths: any[]) => Promise<any>;
  setPortalDownloads?: (files: any[]) => Promise<any>;
  requestPortalDownload?: (fileId: string, saveDir?: string) => Promise<any>;
  leavePortalSend?: () => Promise<any>;
  getPortalStatus?: () => Promise<any>;
  onPortalGuestPinPending?: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => () => void;
  onPortalConnectionAdmitted?: (cb: (connId: string, deviceName: string) => void) => () => void;
  onPortalConnectionClosed?: (cb: (connId: string) => void) => () => void;
  onPortalPeerFilesChanged?: (cb: (files: { id: string; name: string; size: number }[]) => void) => () => void;
  onPortalFileStarted?: (cb: (fileIndex: number, fileCount: number, name: string) => void) => () => void;
  onPortalTransferStarted?: (cb: (connId: string, name: string, size: number) => void) => () => void;
  onPortalTransferProgress?: (cb: (connId: string, received: number, size: number) => void) => () => void;
  onPortalTransferComplete?: (cb: (connId: string, destPath: string) => void) => () => void;
  onPortalPinComputed?: (cb: (pin: string) => void) => () => void;
  onPortalAdmitted?: (cb: (receiverDeviceName?: string) => void) => () => void;
  onPortalSendProgress?: (cb: (sent: number, total: number) => void) => () => void;
  onPortalSendComplete?: (cb: () => void) => () => void;
  onPortalEnded?: (cb: () => void) => () => void;
  onPortalClosed?: (cb: (reason: string) => void) => () => void;
  onPortalError?: (cb: (message: string) => void) => () => void;
  onAppResumed?: (cb: () => void) => () => void;
  getDeviceMountConfig?: (deviceId: string) => Promise<any>;
  setDeviceMountLetter?: (deviceId: string, driveLetter: string) => Promise<any>;
  onDeviceMountChanged?: (cb: (deviceId: string, driveLetter?: string) => void) => () => void;

  // File Explorer Client
  fsListRoots: (deviceId: string) => Promise<any[]>;
  fsReaddir: (deviceId: string, path: string) => Promise<any[]>;
  fsStat: (deviceId: string, path: string) => Promise<any>;
  fsRead: (deviceId: string, path: string, offset: number, length: number) => Promise<string>;
  fsCreateDirectory: (deviceId: string, path: string) => Promise<boolean>;
  fsDelete: (deviceId: string, path: string) => Promise<boolean>;
  fsRename: (deviceId: string, path: string, newPath: string) => Promise<boolean>;
  fsDownloadFile: (deviceId: string, remotePath: string, localPath: string) => Promise<boolean>;
  fsPickSavePath: (defaultName: string) => Promise<string | null>;
  fsPickSaveDirectory: () => Promise<string | null>;
  fsMountDevice: (deviceId: string) => Promise<boolean>;
  fsUnmountDevice: (deviceId: string) => Promise<boolean>;
  fsUploadItem: (deviceId: string, localPath: string, remoteParentPath: string) => Promise<boolean>;
  fsPickUploadItems: (mode: 'file' | 'directory') => Promise<string[]>;
  expandDroppedPaths: (filePaths: string[]) => Promise<any[]>;
  getPathForFile: (file: File) => string;
  fsGetStreamUrl: (deviceId: string, remotePath: string) => Promise<string>;
  fsCancelTransfer: (transferId: string) => Promise<boolean>;
  openExternal: (target: string) => Promise<{ method: 'player' | 'playlist' | 'browser'; player?: string }>;
  fsOpenDocument: (deviceId: string, remotePath: string) => Promise<boolean>;
  onFsTransferProgress?: (cb: (info: { transferId: string; direction: 'download' | 'upload'; deviceId: string; path: string; transferred: number; total: number }) => void) => void;

  // Permissions & Devices
  getPermissions: () => Promise<any>;
  setPermissions: (permissions: any) => Promise<boolean>;
  getTrustedDevices: () => Promise<any[]>;
  getConnectedDevices: () => Promise<any[]>;
  resyncDevices: () => Promise<any>;
  openAppSettings: () => Promise<any>;
  openExternal?: (url: string) => Promise<any>;
  renameTrustedDevice: (deviceId: string, newName: string) => Promise<any>;
  setImmersiveMode?: (enabled: boolean) => Promise<any>;
  setSystemGestureExclusion?: (enabled: boolean) => Promise<any>;

  // Event Listeners
  onDeviceConnected: (cb: (identity: any, trusted: boolean) => void) => () => void;
  onDeviceDisconnected: (cb: (deviceId: string) => void) => () => void;
  onIncomingPairRequest: (cb: (deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null) => void) => () => void;
  onPairingSuccessful: (cb: (deviceId: string) => void) => () => void;
  onPairingFailed: (cb: (deviceId: string, reason: string) => void) => () => void;
  onUnpaired: (cb: (deviceId: string) => void) => () => void;
  onTrustMismatch: (cb: (deviceId: string) => void) => () => void;
  onTrustListUpdated?: (cb: () => void) => () => void;
  onClipboardReceived: (cb: (deviceId: string) => void) => () => void;
  onBatteryReceived: (cb: (deviceId: string, isCharging: boolean, currentCharge: number) => void) => () => void;
  onFindMyDeviceTriggered: (cb: (deviceId: string) => void) => () => void;
  onFindMyDeviceStopped: (cb: (deviceId: string) => void) => () => void;
  onLockStateReceived: (cb: (deviceId: string, isLocked: boolean) => void) => () => void;
  onLockResultReceived: (cb: (deviceId: string, success: boolean) => void) => () => void;
  onShareReceived: (cb: (deviceId: string, filename: string, size: number) => void) => () => void;
  onConnectivityReceived: (cb: (deviceId: string, signalStrengths: any) => void) => () => void;
  onNotificationReceived: (cb: (deviceId: string, notif: any) => void) => () => void;
  onNotificationCancelled: (cb: (deviceId: string, id: string) => void) => () => void;
  onNotificationBroadcastReceived?: (cb: (sourceDeviceId: string, body: any) => void) => () => void;
  onSystemVolumeReceived: (cb: (deviceId: string, body: any) => void) => () => void;
  onFlashlightStateReceived: (cb: (deviceId: string, enabled: boolean) => void) => () => void;
  onDndStateReceived: (cb: (deviceId: string, enabled: boolean, granted: boolean) => void) => () => void;
  onMprisStateReceived: (cb: (deviceId: string, body: any) => void) => () => void;
  onPeerCapabilitiesReceived: (cb: (deviceId: string, capabilities: string[]) => void) => () => void;
  onSpeedTestProgress: (cb: (deviceId: string, message: string) => void) => () => void;
  onPresenterPositionReceived?: (cb: (deviceId: string, dx: number, dy: number, stop: boolean) => void) => () => void;
  onLocalIdentityUpdated?: (cb: (identity: any) => void) => () => void;
  onCommandListReceived: (cb: (deviceId: string, commands: any) => void) => () => void;
  onDeviceRenamed: (cb: (deviceId: string, newName: string) => void) => () => void;
  onOwnDeviceRenamed?: (cb: (newName: string) => void) => () => void;
  onRemoteControlSignal?: (cb: (deviceId: string, signalBody: any) => void) => () => void;
  onRemoteControlStream?: (cb: (deviceId: string, frame: any) => void) => () => void;
}

declare global {
  interface Window {
    link?: LinkApi;
    webkitAudioContext?: typeof AudioContext;
  }
}


