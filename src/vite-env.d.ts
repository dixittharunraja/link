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

// A paired device offering files to this PC; the user answers it before anything transfers.
export interface ShareOffer {
  transferId: string;
  deviceId: string;
  deviceName: string;
  count: number;
  totalSize: number;
  names: string[];
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
  requestPairingByIp: (ip: string, proof?: { fingerprint: string; token: string }) => Promise<{ pin: string; deviceId: string; verified?: boolean } | null>;
  // Pairing is open only while the Add Device screen is; the QR carries the fingerprint and token these return.
  openPairingWindow?: () => Promise<{ fingerprint: string; token: string }>;
  refreshPairingToken?: () => Promise<string | null>;
  closePairingWindow?: () => Promise<void>;
  // A tool shows a QR carrying its fingerprint and a one-time token; a guest that scans it hands it back here.
  openGuestQr?: (port: number) => Promise<{ fingerprint: string; token: string }>;
  refreshGuestQr?: (port: number) => Promise<string | null>;
  closeGuestQr?: (port: number) => Promise<void>;
  rememberGuestScan?: (addresses: string, fingerprint: string, token: string) => Promise<void>;
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
  // Locate (utils/deviceLocation.ts): asks a paired phone where it is; answers come as onLocationReceived.
  requestDeviceLocation?: (deviceId: string) => Promise<any>;
  onLocationReceived?: (cb: (deviceId: string, body: any) => void) => () => void;
  // Android only: whether this phone may report its position, and re-declaring the background service after a grant.
  getLocationAccess?: () => Promise<{ granted: boolean; precise: boolean }>;
  refreshLocationAccess?: () => Promise<any>;
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
  getOpenAtLogin: () => Promise<boolean>;
  setOpenAtLogin: (enabled: boolean) => Promise<any>;

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
  requestCameraHost?: (deviceId?: string, facing?: string) => Promise<boolean>;
  stopRemoteControlHost?: () => Promise<any>;
  sendPresenterMove: (deviceId: string, dx: number, dy: number) => Promise<any>;
  cycleTargetDisplay: (deviceId: string) => Promise<any>;
  sendPresenterStop: (deviceId: string) => Promise<any>;
  sendSpecialKey: (deviceId: string, key: number) => Promise<any>;
  // Android only: the apps on another Android device, and launching one there.
  requestDeviceApps?: (deviceId: string) => Promise<any>;
  launchDeviceApp?: (deviceId: string, packageName: string) => Promise<any>;
  onDeviceAppsReceived?: (cb: (deviceId: string, apps: { package: string; label: string; icon?: string }[]) => void) => () => void;
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
  joinInputGuest?: (host: string, name?: string, mode?: 'presenter' | 'touchpad' | 'remotecontrol' | 'extendscreen') => Promise<any>;
  leaveInputGuest?: () => Promise<any>;
  getInputGuestStatus?: () => Promise<any>;
  acceptInputGuest?: (connId: string) => Promise<any>;
  rejectInputGuest?: (connId: string) => Promise<any>;
  blockInputGuest?: (connId: string) => Promise<any>;
  kickInputGuest?: (ip: string) => Promise<any>;
  onInputGuestPinPending?: (cb: (connId: string, pin: string, remoteAddress: string, name: string, mode: 'presenter' | 'touchpad' | 'remotecontrol' | 'extendscreen') => void) => () => void;
  onInputGuestPinRequired?: (cb: (pin: string) => void) => () => void;
  onInputGuestAdmitted?: (cb: (mode: 'presenter' | 'touchpad' | 'remotecontrol' | 'extendscreen', resolvedHost?: string, hostDeviceType?: string) => void) => () => void;
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
  // Desktop only: playback endpoints (Windows ids) and where and how loud the received mic plays.
  getAudioOutputDevices?: () => Promise<{ id: string; name: string; isDefault: boolean }[]>;
  setRemoteMicOutputDevice?: (deviceId: string) => Promise<any>;
  setRemoteMicVolume?: (volume: number) => Promise<any>;
  onRemoteMicGuestPinPending?: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => () => void;
  onRemoteMicListenerJoined?: (cb: (id: string, label: string) => void) => () => void;
  onRemoteMicListenerLeft?: (cb: (id: string) => void) => () => void;
  onRemoteMicError?: (cb: (message: string) => void) => () => void;
  onRemoteMicPairedSessionStarted?: (cb: (deviceId: string, token: string, host: string) => void) => () => void;
  onRemoteMicPairedSessionEnded?: (cb: (deviceId: string) => void) => () => void;
  onRemoteMicPinComputed?: (cb: (computedPin: string) => void) => () => void;
  onRemoteMicAdmitted?: (cb: () => void) => () => void;
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
  onWalkieTalkieGuestJoined?: (cb: (connId: string, remoteAddress: string, deviceName: string) => void) => () => void;
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
  takePendingSharedFiles?: () => Promise<string[]>;
  onSharedFiles?: (cb: () => void) => () => void;
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
  vcamStatus?: () => Promise<{ supported: boolean; available: boolean; registered: boolean; active: boolean; connected: boolean; width?: number; height?: number; cameraName?: string }>;
  vcamStart?: () => Promise<any>;
  vcamStop?: () => Promise<void>;
  vcamOpen?: () => Promise<any>;
  vcamConnected?: () => Promise<boolean>;
  vcamLog?: (message: string) => Promise<void>;
  getRemoteTailscaleEnabled?: () => Promise<boolean>;
  setRemoteTailscaleEnabled?: (enabled: boolean) => Promise<void>;
  getTailscaleStatus?: () => Promise<{ running: boolean; ip: string | null }>;
  getRecentPhotos?: (deviceId: string, limit?: number, before?: number) => Promise<{ path: string; name: string; size: number; modified: number }[]>;
  /** `size` and `mtime` (from the listing) key the disk cache; without them the photo is stat'ed first. */
  getPhotoThumbnail?: (deviceId: string, path: string, size?: number, mtime?: number) => Promise<string>;
  copyPhotoToClipboard?: (deviceId: string, path: string) => Promise<void>;
  h264Status?: () => Promise<{ supported: boolean; installed: boolean; version?: string; source?: string }>;
  h264Install?: () => Promise<any>;
  onH264ComponentNeeded?: (cb: (feature: 'screen' | 'camera') => void) => () => void;
  /** Shows the same one-time download prompt screen sharing uses, worded for `feature`. */
  requestH264Component?: (feature: 'screen' | 'camera') => Promise<void>;
  acceptShare?: (transferId: string, saveDir: string) => Promise<void>;
  rejectShare?: (transferId: string) => Promise<void>;
  sendFiles?: (deviceId: string, paths: string[]) => Promise<string>;
  onShareOffer?: (cb: (offer: ShareOffer) => void) => () => void;
  onShareOfferClosed?: (cb: (transferId: string) => void) => () => void;
  onShareStatus?: (cb: (status: { transferId: string; deviceId: string; state: string; message: string }) => void) => () => void;
  /** Receives the phone's camera in Rust (no WebView, no JPEG). Rejects when the H.264 component is missing. */
  vcamNativeStart?: (deviceId: string) => Promise<void>;
  vcamNativeStop?: (deviceId: string) => Promise<void>;
  vcamNativeStatus?: (deviceId: string) => Promise<{ available: boolean; offered: boolean; live: boolean; error: string | null }>;
  vcamNativeConfig?: (mirror: boolean, fill: boolean, zoom: number) => Promise<void>;
  /** The Camera panel's preview from Rust: 8-byte little-endian picture number then a JPEG, empty if nothing newer than `since`. */
  cameraPreviewFrame?: (since: number) => Promise<ArrayBuffer>;
  setDeviceMountLetter?: (deviceId: string, driveLetter: string) => Promise<any>;
  onDeviceMountChanged?: (cb: (deviceId: string, driveLetter?: string) => void) => () => void;

  // File Explorer Client
  fsListRoots: (deviceId: string) => Promise<any[]>;
  /** One page of a folder, sorted by name; `limit` 0 (the default) returns the whole folder. */
  fsReaddir: (deviceId: string, path: string, offset?: number, limit?: number) => Promise<{ entries: any[]; hasMore: boolean }>;
  /** A ~256 px JPEG of an image file on the device as a data URL, made by the device's `thumbnail`
   *  action and cached on disk by path, size and mtime. A `max` above 256 asks for a larger preview
   *  instead (desktop only), which is not cached on disk. */
  fsThumbnail: (deviceId: string, path: string, size: number, mtime: number, max?: number) => Promise<string>;
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
  onFsTransferProgress?: (cb: (info: { transferId: string; direction: 'download' | 'upload'; deviceId: string; path: string; transferred: number; total: number }) => void) => () => void;

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
  onIncomingPairRequest: (cb: (deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null, viaQr?: boolean) => void) => () => void;
  onPairingBlocked: (cb: (deviceName: string) => void) => () => void;
  onPairingSuccessful: (cb: (deviceId: string) => void) => () => void;
  onPairingFailed: (cb: (deviceId: string, reason: string) => void) => () => void;
  onUnpaired: (cb: (deviceId: string) => void) => () => void;
  onTrustMismatch: (cb: (deviceId: string) => void) => () => void;
  onTrustListUpdated?: (cb: () => void) => () => void;
  onClipboardReceived: (cb: (deviceId: string) => void) => () => void;
  onBatteryReceived: (cb: (deviceId: string, isCharging: boolean, currentCharge: number) => void) => () => void;
  onFindMyDeviceTriggered: (cb: (deviceId: string) => void) => () => void;
  onFindMyDeviceStopped: (cb: (deviceId: string) => void) => () => void;
  onInputKicked?: (cb: (deviceId: string) => void) => () => void;
  onLockStateReceived: (cb: (deviceId: string, isLocked: boolean) => void) => () => void;
  onLockResultReceived: (cb: (deviceId: string, success: boolean) => void) => () => void;
  onShareReceived: (cb: (deviceId: string, filename: string, size: number) => void) => () => void;
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
}

declare global {
  /** The app version from package.json, injected at build time (vite.config.mts). */
  const __APP_VERSION__: string;

  interface Window {
    link?: LinkApi;
    webkitAudioContext?: typeof AudioContext;
  }
}


