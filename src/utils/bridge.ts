import { Channel, invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { GUEST_REMOTE_CONTROL_ID, IS_ANDROID } from './platform';
import { createEventHub } from './subscriptions';
import type { ShareOffer } from '../vite-env';

if (IS_ANDROID) {
  // Every native handler lives in LinkPlugin.java and is reached by name through the single
  // `link_call` Rust command (src-tauri/src/mobile.rs), so this Proxy lets the table below read as
  // plain method calls. Rejections arrive as bare strings; callers expect Error objects.
  // How many open views currently want the system bars hidden (see setImmersiveMode below).
  let immersiveHolders = 0;
  const native = new Proxy({} as Record<string, (args?: Record<string, unknown>) => Promise<any>>, {
    get: (_target, method: string) => (args: Record<string, unknown> = {}) =>
      invoke('link_call', { method, args }).catch((err) => {
        throw err instanceof Error ? err : new Error(String(err));
      }),
  });

  // One native channel per event name, fanned out to every subscriber; each on* below returns its
  // own unsubscribe, as the desktop bridge does, and the channel is removed with the last one.
  const subscribe = createEventHub((eventName, dispatch) => {
    const channel = new Channel<any>(dispatch);
    invoke('link_register_listener', { event: eventName, handler: channel }).catch(() => {});
    return () => {
      invoke('link_remove_listener', { event: eventName, channelId: channel.id }).catch(() => {});
    };
  });

  (window as any).link = {
    // Identity & Discovery
    getIdentity: () => native.getIdentity(),
    getVisibility: () => native.getVisibility().then((data: any) => data.enabled),
    setVisibility: (enabled: boolean) => native.setVisibility({ enabled }),
    getDiscoveredDevices: () => native.getDiscoveredDevices().then((res: any) => res.devices || []),
    onDeviceDiscovered: (cb: (info: any) => void) => {
      return subscribe('deviceDiscovered', cb);
    },
    onDeviceExpired: (cb: (deviceId: string) => void) => {
      return subscribe('deviceExpired', (data: any) => cb(data.deviceId));
    },
    connectTo: (host: string) => {
      const [ip, portStr] = host.split(':');
      const port = portStr ? parseInt(portStr, 10) : undefined;
      return native.connectTo({ host: ip, port });
    },

    // Pairing
    requestPairing: (deviceId: string) => 
      native.requestPairing({ deviceId }).then((res: any) => res.verificationKey),
    requestPairingByIp: (ip: string, proof?: { fingerprint: string; token: string }) =>
      native.requestPairingByIp({ ip, fingerprint: proof?.fingerprint, token: proof?.token })
        .then((res: any) => res.pin ? { pin: res.pin, deviceId: res.deviceId, verified: !!res.verified } : null),
    openPairingWindow: () => native.openPairingWindow({}),
    openGuestQr: (port: number) => native.openGuestQr({ port }),
    refreshGuestQr: (port: number) => native.refreshGuestQr({ port }).then((res: any) => res?.token ?? null),
    closeGuestQr: (port: number) => native.closeGuestQr({ port }),
    rememberGuestScan: (addresses: string, fingerprint: string, token: string) =>
      native.rememberGuestScan({ addresses, fingerprint, token }),
    refreshPairingToken: () => native.refreshPairingToken({}).then((res: any) => res?.token ?? null),
    closePairingWindow: () => native.closePairingWindow({}),
    acceptPairing: (deviceId: string) => native.acceptPairing({ deviceId }),
    cancelPairing: (deviceId: string) => native.cancelPairing({ deviceId }),
    rejectPairing: (deviceId: string, shouldBlock?: boolean, deviceName?: string, deviceType?: string) =>
      native.rejectPairing({ deviceId, shouldBlock, deviceName, deviceType }),
    unpair: (deviceId: string) => native.unpair({ deviceId }),
    exitPool: () => native.exitPool(),

    // Blocklist (LinkBlocklist.java)
    getBlocklist: () => native.getBlocklist().then((res: any) => res.entries || []),
    blockDevice: (id: string, label: string, type: 'device' | 'ip') =>
      native.blockDevice({ id, label, type }).then((res: any) => res.entries || []),
    unblockDevice: (id: string) => native.unblockDevice({ id }).then((res: any) => res.entries || []),

    // Device Actions
    sendFindMyDevice: (deviceId: string) => native.sendFindMyDevice({ deviceId }),
    sendStopRinging: (deviceId: string) => native.stopFindMyDevice({ deviceId }),
    stopRingingLocal: () => native.stopFindMyDevice(),
    requestDeviceLocation: (deviceId: string) => native.requestDeviceLocation({ deviceId }),
    getLocationAccess: () => native.getLocationAccess(),
    refreshLocationAccess: () => native.refreshLocationAccess(),
    renameDevice: (newName: string) => 
      native.renameDevice({ name: newName }).then((res: any) => res.name),
    sendLockRequest: (deviceId: string, setLocked: boolean) =>
      native.sendLockRequest({ deviceId, setLocked }),
    sendLockStatusRequest: (deviceId: string) => native.sendLockQuery({ deviceId }),
    sendFlashlightToggle: (deviceId: string, enabled: boolean) => 
      native.sendFlashlightToggle({ deviceId, enabled }),
    sendDndSet: (deviceId: string, enabled: boolean) => 
      native.sendDndSet({ deviceId, enabled }),
    
    // Volume & MPRIS
    sendSetVolume: (deviceId: string, sinkName: string, volume: number) => 
      native.sendSetVolume({ deviceId, name: sinkName, volume }),
    sendSetMute: (deviceId: string, sinkName: string, muted: boolean) => 
      native.sendSetMute({ deviceId, name: sinkName, muted }),
    sendMprisAction: (deviceId: string, player: string, action: string) =>
      native.sendMprisAction({ deviceId, player, action }),

    // Speed test and commands. The phone has no whitelist of its own (these stay no-ops), but it
    // can view and trigger a paired desktop's.
    runSpeedTest: (deviceId: string) => native.runSpeedTest({ deviceId }),
    pickCommandFile: () => Promise.resolve(null),
    getCommands: () => Promise.resolve({}),
    setCommand: () => Promise.resolve({}),
    removeCommand: () => Promise.resolve({}),
    sendRunCommandTrigger: (deviceId: string, key: string) => native.triggerCommand({ deviceId, key }),

    sendNotificationReply: (_deviceId: string, _replyId: string, _message: string) =>
      Promise.resolve(), 

    // Pause music config
    getPauseMusicEnabled: () => Promise.resolve(false),
    setPauseMusicEnabled: () => Promise.resolve(),

    // Desktop-only settings; stubs on Android (the foreground service covers running in the
    // background).
    getScreensaverInhibitEnabled: () => Promise.resolve(false),
    setScreensaverInhibitEnabled: () => Promise.resolve(),
    getRemoteTailscaleEnabled: () => native.getRemoteTailscale().then((data: any) => data.enabled),
    setRemoteTailscaleEnabled: (enabled: boolean) => native.setRemoteTailscale({ enabled }),
    getTailscaleStatus: () => native.getTailscaleStatus(),
    getOpenAtLogin: () => Promise.resolve(false),
    setOpenAtLogin: () => Promise.resolve(),

    // Android permissions and system settings
    isMobile: true,
    checkPermissions: () => native.checkPermissions(),
    requestMobilePermission: (permission: string) => 
      native.requestPermissions({ permissions: [permission] }),
    checkNotificationAccess: () => native.checkNotificationAccess(),
    requestNotificationAccess: () => native.requestNotificationAccess(),
    checkAllFilesAccess: () => native.checkAllFilesAccess(),
    requestAllFilesAccess: () => native.requestAllFilesAccess(),
    checkDndPermission: () => native.checkDndPermission(),
    requestDndPermission: () => native.requestDndPermission(),
    isBatteryOptimizationIgnored: () => native.isBatteryOptimizationIgnored(),
    requestIgnoreBatteryOptimizations: () => native.requestIgnoreBatteryOptimizations(),
    checkAccessibility: () => native.checkAccessibility(),
    requestAccessibility: () => native.requestAccessibility(),
    checkOverlayPermission: () => native.checkOverlayPermission(),
    requestOverlayPermission: () => native.requestOverlayPermission(),

    // Back at the root moves the task to the background rather than finishing it, as Android
    // apps normally do (see the 'linkHardwareBack' listener in App.tsx).
    minimizeApp: () => native.minimizeApp(),

    // Input Relays
    sendRemoteInput: (deviceId: string, text?: string, specialKey?: string) =>
      native.sendRemoteInput({ deviceId, text, specialKey }),
    sendPresenterMove: (deviceId: string, dx: number, dy: number) => 
      native.sendPresenterMove({ deviceId, dx, dy }),
    cycleTargetDisplay: (deviceId: string) => native.cycleTargetDisplay({ deviceId }),
    sendPresenterStop: (deviceId: string) => native.sendPresenterStop({ deviceId }),
    sendSpecialKey: (deviceId: string, key: number) => 
      native.sendSpecialKey({ deviceId, specialKey: key }),
    // The apps on another Android device (a TV), for the remote's app buttons.
    requestDeviceApps: (deviceId: string) => native.requestDeviceApps({ deviceId }),
    launchDeviceApp: (deviceId: string, packageName: string) => native.launchDeviceApp({ deviceId, packageName }),
    onDeviceAppsReceived: (cb: (deviceId: string, apps: { package: string; label: string; icon?: string }[]) => void) => {
      return subscribe('deviceAppsReceived', (data: any) => {
        let apps: { package: string; label: string; icon?: string }[] = [];
        try {
          apps = JSON.parse(data.appsJson || '[]');
        } catch {
          // a malformed list is treated as empty
        }
        cb(data.deviceId, apps);
      });
    },
    sendMouseMove: (deviceId: string, dx: number, dy: number) =>
      native.sendMouseMove({ deviceId, dx, dy }),
    sendMouseScroll: (deviceId: string, dx: number, dy: number) => 
      native.sendMouseScroll({ deviceId, dx, dy }),
    sendMouseClick: (deviceId: string, clickType: string) => 
      native.sendMouseClick({ deviceId, clickType }),
    sendMouseDrag: (deviceId: string, hold: boolean) => 
      native.sendMouseDrag({ deviceId, hold }),
    sendDigitizerSession: (deviceId: string, action: string, w: number, h: number) => 
      native.sendDigitizerSession({ deviceId, action, width: w, height: h, resolutionX: 100, resolutionY: 100 }),
    sendDigitizerEvent: (deviceId: string, payload: any) =>
      native.sendDigitizerEvent({ deviceId, ...payload }),
    sendDigitizerAction: (deviceId: string, action: string) =>
      native.sendDigitizerAction({ deviceId, action }),
    // Joystick sessions are addressed by the typed or scanned host IP, not a device id
    // (see src-tauri/src/core/joystick.rs).
    sendJoystickHello: (host: string, name: string) => native.sendJoystickHello({ host, name }),
    sendJoystickBye: (host: string) => native.sendJoystickBye({ host }),
    // About 60Hz over UDP to the input relay (port 1717).
    sendJoystickState: (host: string, lx: number, ly: number, rx: number, ry: number, lt: number, rt: number, buttons: number) =>
      native.sendJoystickState({ host, lx, ly, rx, ry, lt, rt, buttons }),
    
    // Joystick host
    startJoystickHost: () => native.startJoystickHost(),
    stopJoystickHost: () => native.stopJoystickHost(),
    getJoystickStatus: () => native.getJoystickStatus(),
    checkJoystickDriver: () => native.checkJoystickDriver(),
    requestShizukuPermission: () => native.requestShizukuPermission(),
    acceptJoystickGuest: (connId: string) => native.acceptJoystickGuest({ connId }),
    rejectJoystickGuest: (connId: string) => native.rejectJoystickGuest({ connId }),
    blockJoystickGuest: (connId: string) => native.blockJoystickGuest({ connId }),
    kickJoystickController: (ip: string) => native.kickJoystickController({ ip }),

    onJoystickHelloAck: (cb: (ok: boolean, padIndex: number | null, error: string | null) => void) => {
      return subscribe('joystickHelloAck', (data: any) => cb(!!data.ok, data.padIndex ?? null, data.error || null));
    },
    onJoystickPinRequired: (cb: (pin: string) => void) => {
      return subscribe('joystickPinRequired', (data: any) => cb(data.pin));
    },
    // Heartbeat and forced disconnect, used by JoystickOverlay.tsx to close a dead session.
    onJoystickPing: (cb: () => void) => {
      return subscribe('joystickPing', () => cb());
    },
    onJoystickForcedDisconnect: (cb: (reason: string) => void) => {
      return subscribe('joystickForcedDisconnect', (data: any) => cb(data.reason || 'disconnected'));
    },
    onJoystickDriverStatus: (cb: (status: string, error: string | null) => void) => {
      return subscribe('joystickDriverStatus', (data: any) => cb(data.status, data.error || null));
    },
    onJoystickRosterChanged: (cb: () => void) => {
      return subscribe('joystickRosterChanged', () => cb());
    },
    onJoystickGuestPinPending: (cb: (connId: string, pinCode: string, remoteAddress: string, name: string) => void) => {
      return subscribe('joystickGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.name));
    },
    // Input guest sessions (presenter, touchpad, remote control)
    startInputGuestHost: () => native.startInputGuestHost(),
    stopInputGuestHost: () => native.stopInputGuestHost(),
    getInputGuestStatus: () => native.getInputGuestStatus(),
    acceptInputGuest: (connId: string) => native.acceptInputGuest({ connId }),
    rejectInputGuest: (connId: string) => native.rejectInputGuest({ connId }),
    blockInputGuest: (connId: string) => native.blockInputGuest({ connId }),
    kickInputGuest: (ip: string) => native.kickInputGuest({ ip }),
    joinInputGuest: (host: string, name?: string, mode?: 'presenter' | 'touchpad' | 'remotecontrol' | 'extendscreen') =>
      native.joinInputGuest({ host, name, mode }),
    leaveInputGuest: () => native.leaveInputGuest(),
    onInputGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, name: string, mode: 'presenter' | 'touchpad' | 'remotecontrol' | 'extendscreen') => void) => {
      return subscribe('inputGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.name, data.mode));
    },
    onInputGuestPinRequired: (cb: (pin: string) => void) => {
      return subscribe('inputGuestPinRequired', (data: any) => cb(data.pin));
    },
    onInputGuestAdmitted: (cb: (mode: 'presenter' | 'touchpad' | 'remotecontrol' | 'extendscreen', resolvedHost?: string, hostDeviceType?: string) => void) => {
      return subscribe('inputGuestAdmitted', (data: any) => cb(data.mode || 'touchpad', data.host, data.hostDeviceType));
    },
    onInputGuestClosed: (cb: (reason: string) => void) => {
      return subscribe('inputGuestClosed', (data: any) => cb(data.error || 'disconnected'));
    },
    onInputGuestError: (cb: (error: string) => void) => {
      return subscribe('inputGuestError', (data: any) => cb(data.error || 'Failed to connect'));
    },
    onInputGuestRosterChanged: (cb: () => void) => {
      return subscribe('inputGuestRosterChanged', () => cb());
    },
    vibrate: (amplitude: number, durationMs: number) => native.vibrate({ amplitude, durationMs }),

    // Stored natively (LinkDevicePermissions.java) so native code can enforce them.
    getPermissions: () => native.getPermissions(),
    setPermissions: (permissions: any) => native.setPermissions(permissions).then(() => true),
    getTrustedDevices: () =>
      native.getTrustedDevices().then((res: any) => res.devices || []),
    getConnectedDevices: () =>
      native.getConnectedDevices().then((res: any) => res.devices || []),
    resyncDevices: () => native.resyncDevices(),
    openAppSettings: () => native.openAppSettings(),
    renameTrustedDevice: (deviceId: string, newName: string) => 
      native.renameTrustedDevice({ deviceId, name: newName }),
    // Several full-screen views can be open at once (the viewer and its keyboard, for example), and
    // each asks on open and lets go on close. The bars return only when the last one lets go.
    setImmersiveMode: (enabled: boolean) => {
      immersiveHolders = Math.max(0, immersiveHolders + (enabled ? 1 : -1));
      return native.setImmersiveMode({ enabled: immersiveHolders > 0 });
    },
    setSystemGestureExclusion: (enabled: boolean) => native.setSystemGestureExclusion({ enabled }),

    // Event listeners
    onDeviceConnected: (cb: (identity: any, trusted: boolean) => void) => {
      return subscribe('deviceConnected', (data: any) => cb(data, data.trusted));
    },
    onDeviceDisconnected: (cb: (deviceId: string) => void) => {
      return subscribe('deviceDisconnected', (data: any) => cb(data.deviceId));
    },
    onIncomingPairRequest: (cb: (deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null, viaQr?: boolean) => void) => {
      return subscribe('incomingPairRequest', (data: any) => cb(data.deviceId, data.deviceName, data.deviceType, data.verificationKey, !!data.viaQr));
    },
    onPairingBlocked: (cb: (deviceName: string) => void) => {
      return subscribe('pairingBlocked', (data: any) => cb(data.deviceName));
    },
    onPairingSuccessful: (cb: (deviceId: string) => void) => {
      return subscribe('pairingSuccessful', (data: any) => cb(data.deviceId));
    },
    onPairingFailed: (cb: (deviceId: string, reason: string) => void) => {
      return subscribe('pairingFailed', (data: any) => cb(data.deviceId, data.reason));
    },
    onUnpaired: (cb: (deviceId: string) => void) => {
      return subscribe('unpaired', (data: any) => cb(data.deviceId));
    },
    onTrustMismatch: (cb: (deviceId: string) => void) => {
      return subscribe('trustMismatch', (data: any) => cb(data.deviceId));
    },
    onTrustListUpdated: (cb: () => void) => {
      return subscribe('trustListUpdated', () => cb());
    },
    // Android has no incoming clipboard event.
    onClipboardReceived: (_cb: (deviceId: string) => void) => () => {},
    onBatteryReceived: (cb: (deviceId: string, isCharging: boolean, currentCharge: number) => void) => {
      return subscribe('batteryReceived', (data: any) => cb(data.deviceId, data.isCharging, data.currentCharge));
    },
    onFindMyDeviceTriggered: (cb: (deviceId: string) => void) => {
      return subscribe('findMyDeviceTriggered', (data: any) => cb(data.deviceId));
    },
    onFindMyDeviceStopped: (cb: (deviceId: string) => void) => {
      return subscribe('findMyDeviceStopped', (data: any) => cb(data.deviceId));
    },
    onLocationReceived: (cb: (deviceId: string, body: any) => void) => {
      return subscribe('locationReceived', (data: any) => {
        try {
          cb(data.deviceId, typeof data.body === 'string' ? JSON.parse(data.body) : data.body);
        } catch {
          // A malformed body is dropped.
        }
      });
    },
    onInputKicked: (cb: (deviceId: string) => void) => {
      return subscribe('inputKicked', (data: any) => cb(data.deviceId));
    },
    onLockStateReceived: (cb: (deviceId: string, isLocked: boolean) => void) => {
      return subscribe('lockStateReceived', (data: any) => cb(data.deviceId, data.isLocked));
    },
    onLockResultReceived: (cb: (deviceId: string, success: boolean) => void) => {
      return subscribe('lockResultReceived', (data: any) => cb(data.deviceId, data.success));
    },
    onShareReceived: (cb: (deviceId: string, filename: string, size: number) => void) => {
      return subscribe('shareReceived', (data: any) => cb(data.deviceId, data.filename, data.size));
    },
    onNotificationReceived: () => () => {},
    onNotificationCancelled: () => () => {},
    onNotificationBroadcastReceived: (cb: (sourceDeviceId: string, body: any) => void) => {
      return subscribe('notificationBroadcastReceived', (data: any) => cb(data.sourceDeviceId, data));
    },
    onSystemVolumeReceived: (cb: (deviceId: string, body: any) => void) => {
      return subscribe('systemVolumeReceived', (data: any) => cb(data.deviceId, { sinkList: data.sinks }));
    },
    onFlashlightStateReceived: (cb: (deviceId: string, enabled: boolean, revoked?: boolean) => void) => {
      return subscribe('flashlightStateReceived', (data: any) => cb(data.deviceId, data.enabled, data.revoked));
    },
    onDndStateReceived: (cb: (deviceId: string, enabled: boolean, granted: boolean, revoked?: boolean) => void) => {
      return subscribe('dndStateReceived', (data: any) => cb(data.deviceId, data.enabled, data.granted, data.revoked));
    },
    // Mobile-to-mobile presenter: a peer drives this device's pointer-dot overlay
    // (see PresenterDotOverlay.tsx).
    onPresenterPositionReceived: (cb: (deviceId: string, dx: number, dy: number, stop: boolean) => void) => {
      return subscribe('presenterPositionReceived', (data: any) => cb(data.deviceId, data.dx || 0, data.dy || 0, !!data.stop));
    },
    onMprisStateReceived: (cb: (deviceId: string, body: any) => void) => {
      return subscribe('mprisStateReceived', (data: any) => cb(data.deviceId, data.state));
    },
    onPeerCapabilitiesReceived: (cb: (deviceId: string, capabilities: string[]) => void) => {
      return subscribe('peerCapabilitiesReceived', (data: any) => cb(data.deviceId, data.capabilities || []));
    },
    onSpeedTestProgress: (cb: (deviceId: string, message: string) => void) => {
      return subscribe('speedTestProgress', (data: any) => cb(data.deviceId, data.message));
    },
    onCommandListReceived: (cb: (deviceId: string, commands: Record<string, { name: string; command: string }>) => void) => {
      return subscribe('commandListReceived', (data: any) => {
        try {
          cb(data.deviceId, JSON.parse(data.commands));
        } catch {
          cb(data.deviceId, {});
        }
      });
    },
    onDeviceRenamed: (cb: (deviceId: string, newName: string) => void) => {
      return subscribe('deviceRenamed', (data: any) => cb(data.deviceId, data.newName));
    },
    onOwnDeviceRenamed: (cb: (newName: string) => void) => {
      return subscribe('ownDeviceRenamed', (data: any) => cb(data.newName));
    },

    // Audio Sink. Android hosts through AudioPlaybackCaptureConfiguration and MediaProjection
    // (API 29+, see LinkAudioCapture.java and LinkAudioSinkServer.java); startAudioSink() handles
    // the RECORD_AUDIO and MediaProjection prompts natively and resolves once the user responds.
    startAudioSink: () => native.startAudioSink(),
    setAudioSinkMuted: (muted: boolean) => native.setAudioSinkMuted({ muted }),
    kickAudioSinkListener: (connId: string) => native.kickAudioSinkListener({ connId }),
    blockAudioSinkListener: (connId: string) => native.blockAudioSinkListener({ connId }),
    getAudioSinkListeners: () =>
      native.getAudioSinkListeners().then((res: any) => res.listeners || []),
    // AudioSinkTab.tsx reads this on mount to restore an active hosting or listening session.
    getAudioSinkStatus: () => native.getAudioSinkStatus(),
    endAudioSink: () => native.endAudioSink(),

    joinAudioSinkGuest: (host: string) => native.joinAudioSinkGuest({ host }),
    joinAudioSinkPaired: (host: string, token: string) => native.joinAudioSinkPaired({ host, token }),
    acceptAudioSinkGuest: (connId: string) => native.acceptAudioSinkGuest({ connId }),
    rejectAudioSinkGuest: (connId: string) => native.rejectAudioSinkGuest({ connId }),
    blockAudioSinkGuest: (connId: string) => native.blockAudioSinkGuest({ connId }),
    leaveAudioSink: () => native.leaveAudioSink(),
    queryAudioSinkSessions: () => native.queryAudioSinkSessions(),
    // Android plays through a native AudioTrack, so volume is set natively
    // (LinkAudioSinkClient.setVolume()).
    setAudioSinkListenerVolume: (volume: number) => native.setAudioSinkListenerVolume({ volume }),

    onAudioSinkListenerJoined: (cb: (id: string, label: string) => void) => {
      return subscribe('audioSinkListenerJoined', (data: any) => cb(data.connId, data.label));
    },
    onAudioSinkListenerLeft: (cb: (id: string) => void) => {
      return subscribe('audioSinkListenerLeft', (data: any) => cb(data.connId));
    },
    onAudioSinkGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => {
      return subscribe('audioSinkGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.deviceName));
    },
    onAudioSinkPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) => {
      return subscribe('audioSinkPairedSessionStarted', (data: any) => cb(data.deviceId, data.token, data.host));
    },
    onAudioSinkPairedSessionEnded: (cb: (deviceId: string) => void) => {
      return subscribe('audioSinkPairedSessionEnded', (data: any) => cb(data.deviceId));
    },
    onAudioSinkStats: (cb: (stats: { latencyMs: number; bufferMs: number; underruns: number; dropped: number; clockSynced: boolean }) => void) => {
      return subscribe('audioSinkStats', (data: any) => cb(data));
    },
    onAudioSinkAdmitted: (cb: (hostName: string) => void) => {
      return subscribe('audioSinkAdmitted', (data: any) => cb(data?.hostName || ''));
    },
    onAudioSinkHostMuted: (cb: (muted: boolean) => void) => {
      return subscribe('audioSinkHostMuted', (data: any) => cb(data.muted));
    },
    onAudioSinkEnded: (cb: () => void) => {
      return subscribe('audioSinkEnded', () => cb());
    },
    onAudioSinkClosed: (cb: (reason: string) => void) => {
      return subscribe('audioSinkClosed', (data: any) => cb(data.reason));
    },
    onAudioSinkError: (cb: (message: string) => void) => {
      return subscribe('audioSinkError', (data: any) => cb(data.message));
    },
    onAudioSinkPinComputed: (cb: (pin: string) => void) => {
      return subscribe('audioSinkPinComputed', (data: any) => cb(data.pin));
    },

    // Remote Mic
    startRemoteMic: () => native.startRemoteMic(),
    setRemoteMicMuted: (muted: boolean) => native.setRemoteMicMuted({ muted }),
    kickRemoteMicListener: (connId: string) => native.kickRemoteMicListener({ connId }),
    blockRemoteMicListener: (connId: string) => native.blockRemoteMicListener({ connId }),
    acceptRemoteMicGuest: (connId: string) => native.acceptRemoteMicGuest({ connId }),
    rejectRemoteMicGuest: (connId: string) => native.rejectRemoteMicGuest({ connId }),
    blockRemoteMicGuest: (connId: string) => native.blockRemoteMicGuest({ connId }),
    getRemoteMicListeners: () =>
      native.getRemoteMicListeners().then((res: any) => res.listeners || []),
    // RemoteMicTab.tsx reads this on mount to restore an active hosting session.
    getRemoteMicStatus: () => native.getRemoteMicStatus(),
    endRemoteMic: () => native.endRemoteMic(),

    // Android only hosts Remote Mic (a PC listens), so there are no listener-side methods here.
    onRemoteMicGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => {
      return subscribe('remoteMicGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.deviceName));
    },
    onRemoteMicListenerJoined: (cb: (id: string, label: string) => void) => {
      return subscribe('remoteMicListenerJoined', (data: any) => cb(data.connId, data.label));
    },
    onRemoteMicListenerLeft: (cb: (id: string) => void) => {
      return subscribe('remoteMicListenerLeft', (data: any) => cb(data.connId));
    },
    onRemoteMicError: (cb: (message: string) => void) => {
      return subscribe('remoteMicError', (data: any) => cb(data.message));
    },

    // Walkie Talkie: a signaling relay only; the session logic and WebRTC audio live in
    // WalkieTalkieTab.tsx. wry's RustWebChromeClient grants RECORD_AUDIO for getUserMedia, so no
    // native audio code is involved.
    sendWalkieTalkieSignal: (deviceId: string, type: string, body: any) =>
      native.sendWalkieTalkieSignal({ deviceId, type, body: JSON.stringify(body || {}) }),
    broadcastWalkieTalkieSignal: (type: string, body: any) =>
      native.broadcastWalkieTalkieSignal({ type, body: JSON.stringify(body || {}) }),
    onWalkieTalkieSignal: (cb: (deviceId: string, type: string, body: any) => void) => {
      return subscribe('walkieTalkieSignal', (data: any) => {
        let body = {};
        try { body = JSON.parse(data.body || '{}'); } catch {}
        cb(data.deviceId, data.type, body);
      });
    },

    // Host side: unpaired guests joining by IP and PIN
    startWalkieTalkieGuestListener: () => native.startWalkieTalkieGuestListener(),
    stopWalkieTalkieGuestListener: () => native.stopWalkieTalkieGuestListener(),
    acceptWalkieTalkieGuest: (connId: string) => native.acceptWalkieTalkieGuest({ connId }),
    rejectWalkieTalkieGuest: (connId: string) => native.rejectWalkieTalkieGuest({ connId }),
    kickWalkieTalkieGuest: (connId: string) => native.kickWalkieTalkieGuest({ connId }),
    blockWalkieTalkieGuest: (connId: string) => native.blockWalkieTalkieGuest({ connId }),
    blockWalkieTalkieMember: (deviceId: string, label: string) => native.blockWalkieTalkieMember({ deviceId, label }),
    sendWalkieTalkieGuestSignal: (connId: string, type: string, body: any) =>
      native.sendWalkieTalkieGuestSignal({ connId, type, body: JSON.stringify(body || {}) }),
    onWalkieTalkieGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => {
      return subscribe('walkieTalkieGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.deviceName));
    },
    onWalkieTalkieGuestJoined: (cb: (connId: string, remoteAddress: string, deviceName: string) => void) => {
      return subscribe('walkieTalkieGuestJoined', (data: any) => cb(data.connId, data.remoteAddress, data.deviceName));
    },
    onWalkieTalkieGuestSignal: (cb: (connId: string, type: string, body: any) => void) => {
      return subscribe('walkieTalkieGuestSignal', (data: any) => {
        let body = {};
        try { body = JSON.parse(data.body || '{}'); } catch {}
        cb(data.connId, data.type, body);
      });
    },
    onWalkieTalkieGuestLeft: (cb: (connId: string) => void) => {
      return subscribe('walkieTalkieGuestLeft', (data: any) => cb(data.connId));
    },

    // Guest side: joining another device's session by IP
    joinWalkieTalkieGuest: (host: string) => native.joinWalkieTalkieGuest({ host }),
    leaveWalkieTalkieGuest: () => native.leaveWalkieTalkieGuest(),
    sendWalkieTalkieGuestMessage: (type: string, body: any) =>
      native.sendWalkieTalkieGuestMessage({ type, body: JSON.stringify(body || {}) }),
    onWalkieTalkieGuestPinComputed: (cb: (pin: string) => void) => {
      return subscribe('walkieTalkieGuestPinComputed', (data: any) => cb(data.pin));
    },
    onWalkieTalkieHostSignal: (cb: (type: string, body: any) => void) => {
      return subscribe('walkieTalkieHostSignal', (data: any) => {
        let body = {};
        try { body = JSON.parse(data.body || '{}'); } catch {}
        cb(data.type, body);
      });
    },
    onWalkieTalkieHostEnded: (cb: (reason?: string) => void) => {
      return subscribe('walkieTalkieHostEnded', (data: any) => cb(data?.reason));
    },
    onWalkieTalkieHostClosed: (cb: (reason: string) => void) => {
      return subscribe('walkieTalkieHostClosed', (data: any) => cb(data.reason));
    },
    onWalkieTalkieHostError: (cb: (message: string) => void) => {
      return subscribe('walkieTalkieHostError', (data: any) => cb(data.message));
    },

    // File Transfer (one-off transfers with unpaired devices). pickPortalFiles() uses
    // ACTION_OPEN_DOCUMENT and returns content:// URIs instead of paths; FileTransferTab.tsx treats
    // them as opaque strings. Android has no save-directory picker (see LinkFileTransferServer.java).
    pickPortalFiles: () => native.pickPortalFiles().then((res: any) => res?.uris || []),
    startPortalReceive: (webMode?: boolean) => native.startPortalReceive({ webMode: !!webMode }),
    acceptPortalGuest: (connId: string) => native.acceptPortalGuest({ connId }),
    rejectPortalGuest: (connId: string) => native.rejectPortalGuest({ connId }),
    blockPortalGuest: (connId: string) => native.blockPortalGuest({ connId }),
    endPortalReceive: () => native.endPortalReceive(),
    disconnectPortalConnection: (connId: string) => native.disconnectPortalConnection({ connId }),
    joinPortalGuest: (host: string, filePaths: string[]) => native.joinPortalGuest({ host, uris: filePaths }),
    setPortalDownloads: (files: { name: string; localPath: string }[]) => native.setPortalDownloads({ files }),
    requestPortalDownload: (fileId: string, saveDir?: string) => native.requestPortalDownload({ fileId, saveDir }),
    leavePortalSend: () => native.leavePortalSend(),
    getPortalStatus: () => native.getPortalStatus(),
    // Files shared to "File Transfer (Link)" from another app's share sheet. They arrive as content:// URIs, the same
    // opaque strings pickPortalFiles() returns, and are staged in the File Transfer tool like picked files.
    takePendingSharedFiles: () => native.takePendingSharedFiles().then((res: any) => res?.uris || []),
    onSharedFiles: (cb: () => void) => subscribe('sharedFiles', () => cb()),

    onPortalGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => {
      return subscribe('portalGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.deviceName));
    },
    onPortalConnectionAdmitted: (cb: (connId: string, deviceName: string) => void) => {
      return subscribe('portalConnectionAdmitted', (data: any) => cb(data.connId, data.deviceName));
    },
    onPortalConnectionClosed: (cb: (connId: string) => void) => {
      return subscribe('portalConnectionClosed', (data: any) => cb(data.connId));
    },
    onPortalPeerFilesChanged: (cb: (files: { id: string; name: string; size: number }[]) => void) => {
      return subscribe('portalPeerFilesChanged', (data: any) => cb(data.files || []));
    },
    onPortalFileStarted: (cb: (fileIndex: number, fileCount: number, name: string) => void) => {
      return subscribe('portalFileStarted', (data: any) => cb(data.fileIndex, data.fileCount, data.name));
    },
    onPortalTransferStarted: (cb: (connId: string, name: string, size: number) => void) => {
      return subscribe('portalTransferStarted', (data: any) => cb(data.connId, data.name, data.size));
    },
    onPortalTransferProgress: (cb: (connId: string, received: number, size: number) => void) => {
      return subscribe('portalTransferProgress', (data: any) => cb(data.connId, data.received, data.size));
    },
    onPortalTransferComplete: (cb: (connId: string, destPath: string) => void) => {
      return subscribe('portalTransferComplete', (data: any) => cb(data.connId, data.destPath));
    },
    onPortalPinComputed: (cb: (pin: string) => void) => {
      return subscribe('portalPinComputed', (data: any) => cb(data.pin));
    },
    onPortalAdmitted: (cb: (receiverDeviceName?: string) => void) => {
      return subscribe('portalAdmitted', (data: any) => cb(data?.deviceName));
    },
    onPortalSendProgress: (cb: (sent: number, total: number) => void) => {
      return subscribe('portalSendProgress', (data: any) => cb(data.sent, data.total));
    },
    onPortalSendComplete: (cb: () => void) => {
      return subscribe('portalSendComplete', () => cb());
    },
    onPortalEnded: (cb: () => void) => {
      return subscribe('portalEnded', () => cb());
    },
    onPortalClosed: (cb: (reason: string) => void) => {
      return subscribe('portalClosed', (data: any) => cb(data.reason));
    },
    onPortalError: (cb: (message: string) => void) => {
      return subscribe('portalError', (data: any) => cb(data.message));
    },
    onAppResumed: (cb: () => void) => {
      return subscribe('appResumed', () => cb());
    },
    getDeviceMountConfig: (_deviceId: string) => Promise.resolve({ preferredDriveLetter: '', occupiedLetters: [] as string[], letters: [] as string[] }),
    vcamStatus: () => Promise.resolve({ supported: false, available: false, registered: false, active: false, connected: false }),
    vcamStart: () => Promise.reject(new Error('The virtual webcam is only available on Windows.')),
    vcamStop: () => Promise.resolve(),
    vcamOpen: () => Promise.reject(new Error('The virtual webcam is only available on Windows.')),
    vcamConnected: () => Promise.resolve(false),
    vcamLog: (_message: string) => Promise.resolve(),
    h264Status: () => Promise.resolve({ supported: false, installed: false }),
    h264Install: () => Promise.reject(new Error('The H.264 video component is only available on Windows.')),
    onH264ComponentNeeded: (_cb: (feature: 'screen' | 'camera') => void) => () => {},
    requestH264Component: (_feature: 'screen' | 'camera') => Promise.resolve(),
    vcamNativeStart: (_deviceId: string) => Promise.reject(new Error('Native camera receiving is only available on Windows.')),
    vcamNativeStop: (_deviceId: string) => Promise.resolve(),
    vcamNativeStatus: (_deviceId: string) => Promise.resolve({ available: false, offered: false, live: false, error: null as string | null }),
    vcamNativeConfig: (_mirror: boolean, _fill: boolean, _zoom: number) => Promise.resolve(),
    cameraPreviewFrame: (_since: number) => Promise.resolve(new ArrayBuffer(0)),
    setDeviceMountLetter: (_deviceId: string, _driveLetter: string) => Promise.resolve({ success: false }),
    onDeviceMountChanged: (_cb: (deviceId: string, driveLetter?: string) => void) => () => {},

    // File explorer
    fsListRoots: (deviceId: string) =>
      native.fsListRoots({ deviceId }).then((res: any) => res.result || []),
    fsReaddir: (deviceId: string, path: string, offset = 0, limit = 0) =>
      native.fsReaddir({ deviceId, path, offset, limit }).then((res: any) => ({ entries: res.result || [], hasMore: !!res.hasMore })),
    fsThumbnail: (deviceId: string, path: string, size: number, mtime: number) =>
      native.fsThumbnail({ deviceId, path, size, mtime }).then((res: any) => res.dataUrl as string),
    fsStat: (deviceId: string, path: string) =>
      native.fsStat({ deviceId, path }).then((res: any) => res.result || {}),
    fsRead: (_deviceId: string, _path: string, _offset: number, _length: number) =>
      Promise.resolve(''),
    fsCreateDirectory: (deviceId: string, path: string) =>
      native.fsCreateDirectory({ deviceId, path }).then((res: any) => !!res.result),
    fsDelete: (deviceId: string, path: string) =>
      native.fsDelete({ deviceId, path }).then((res: any) => !!res.result),
    fsRename: (deviceId: string, path: string, newPath: string) =>
      native.fsRename({ deviceId, path, newPath }).then((res: any) => !!res.result),
    // Android's scoped storage has no equivalent of the desktop save path, so localPath is unused
    // and LinkPlugin.downloadFsFile picks the destination.
    fsDownloadFile: (deviceId: string, remotePath: string, _localPath: string) =>
      native.fsDownloadFile({ deviceId, remotePath }).then(() => true),
    // No save dialogs on Android. These resolve non-null so the explorer's cancel check does not
    // fire; the values are ignored by fsDownloadFile.
    fsPickSavePath: (defaultName: string) => Promise.resolve(defaultName),
    fsPickSaveDirectory: () => Promise.resolve('Link/Downloads'),
    fsMountDevice: (_deviceId: string) => Promise.resolve(true),
    fsUnmountDevice: (_deviceId: string) => Promise.resolve(true),
    fsUploadItem: (deviceId: string, localPath: string, remoteParentPath: string) =>
      native.fsUploadItem({ deviceId, localPath, remoteParentPath }).then(() => true),
    fsPickUploadItems: (mode: 'file' | 'directory') =>
      native.fsPickUploadItems({ mode }).then((res: any) => res.paths || []),
    fsCancelTransfer: (transferId: string) =>
      native.fsCancelTransfer({ transferId }).then(() => true),
    expandDroppedPaths: (_filePaths: string[]) => Promise.resolve([] as any[]),
    getPathForFile: (_file: File) => '',
    fsGetStreamUrl: (deviceId: string, remotePath: string) =>
      native.fsGetStreamUrl({ deviceId, remotePath }).then((res: any) => res.url || ''),
    // ACTION_VIEW with an explicit MIME type always opens a player app, so there is no browser
    // fallback to report.
    openExternal: (target: string) =>
      native.openExternal({ url: target }).then(() => ({ method: 'player' as const })),
    fsOpenDocument: (deviceId: string, remotePath: string) =>
      native.fsOpenDocument({ deviceId, remotePath }).then(() => true),
    onFsTransferProgress: (cb: (info: { transferId: string; direction: 'download' | 'upload'; deviceId: string; path: string; transferred: number; total: number }) => void) => {
      return subscribe('fsTransferProgress', (data: any) => cb(data));
    },

    // Remote control
    sendRemoteControlSignal: (deviceId: string, signalBody: any) => {
      if (deviceId !== GUEST_REMOTE_CONTROL_ID) return native.sendRemoteControlSignal({ deviceId, signal: signalBody });
      if (signalBody?.type === 'stop') return native.leaveInputGuest();
      // An unpaired host (PC or phone) takes the same WebRTC signalling over the guest socket.
      return native.sendInputGuestMessage({ message: JSON.stringify({ type: 'packet', packetType: 'link.remotecontrol.signal', body: signalBody }) });
    },
    sendRemoteControlInput: (deviceId: string, inputBody: any) =>
      deviceId === GUEST_REMOTE_CONTROL_ID
        ? native.sendInputGuestMessage({ message: JSON.stringify({ type: 'packet', packetType: 'link.remotecontrol.input', body: inputBody }) })
        : native.sendRemoteControlInput({ deviceId, input: inputBody }),
    requestRemoteControlHost: (deviceId?: string) =>
      native.requestRemoteControlHost({ deviceId }).then((res: any) => !!res?.granted),
    requestCameraHost: (deviceId?: string, facing?: string) =>
      native.requestCameraHost({ deviceId, facing }).then((res: any) => !!res?.granted),
    stopRemoteControlHost: () =>
      native.stopRemoteControlHost(),
    onRemoteControlSignal: (cb: (deviceId: string, signalBody: any) => void) => {
      const unsubPaired = subscribe('remoteControlSignalReceived', (data: any) => {
        cb(data.deviceId, data.signal);
      });
      // A host reached as an unpaired guest sends its answers (offer, denied) over the guest socket.
      const unsubGuest = subscribe('inputGuestMessage', (data: any) => {
        try {
          const message = JSON.parse(data.message);
          if (message.type === 'packet' && message.packetType === 'link.remotecontrol.signal') cb(GUEST_REMOTE_CONTROL_ID, message.body);
        } catch { /* not JSON */ }
      });
      return () => { unsubPaired(); unsubGuest(); };
    },
  };
}

if (!IS_ANDROID && !(window as any).link) {
  // Desktop: Tauri commands and events.
  const noop = () => {};
  const noopUnsub = () => noop;

  function tauriSubscribe(eventName: string, cb: (data: any) => void) {
    const unlistenPromise = listen(eventName, (event: any) => {
      cb(event.payload);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }

  // The Rust core forwards plugin packets from a paired peer as one 'peer-packet' event;
  // each on*Received callback below picks out its own packet type.
  type PacketHandler = (deviceId: string, body: any, type: string) => void;
  const packetHandlers = new Map<string, Set<PacketHandler>>();
  let packetListenerStarted = false;

  // The core is told which types (and "prefix*" keys) have handlers, and emits only those. A new
  // key is reported at once, before a packet for it can be missed; a removal waits a moment, so a
  // component that unmounts and mounts again costs no extra calls.
  let reportedPacketKeys = '';
  let reportQueued = false;
  let reportTimer: ReturnType<typeof setTimeout> | undefined;
  function reportPacketKeys() {
    reportQueued = false;
    reportTimer = undefined;
    const types = [...packetHandlers.keys()].sort();
    const joined = types.join('\n');
    if (joined === reportedPacketKeys) return;
    reportedPacketKeys = joined;
    invoke('set_packet_subscriptions', { types }).catch(() => { reportedPacketKeys = ''; });
  }
  function packetKeysChanged(added: boolean) {
    if (added) {
      if (reportTimer !== undefined) clearTimeout(reportTimer);
      reportTimer = undefined;
      if (!reportQueued) {
        reportQueued = true;
        queueMicrotask(reportPacketKeys);
      }
    } else if (!reportQueued && reportTimer === undefined) {
      reportTimer = setTimeout(reportPacketKeys, 1000);
    }
  }

  function onPeerPacket(packetType: string, handler: PacketHandler) {
    if (!packetListenerStarted) {
      packetListenerStarted = true;
      listen('peer-packet', (event: any) => {
        const { deviceId, type, body } = event.payload;
        packetHandlers.get(type)?.forEach((h) => h(deviceId, body ?? {}, type));
        // A trailing "*" subscribes to every packet type with that prefix.
        packetHandlers.forEach((handlers, key) => {
          if (key.endsWith('*') && type.startsWith(key.slice(0, -1))) handlers.forEach((h) => h(deviceId, body ?? {}, type));
        });
      }).catch(() => { packetListenerStarted = false; });
    }
    const existing = packetHandlers.get(packetType);
    const handlers = existing ?? new Set<PacketHandler>();
    if (!existing) {
      packetHandlers.set(packetType, handlers);
      packetKeysChanged(true);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0 && packetHandlers.get(packetType) === handlers) {
        packetHandlers.delete(packetType);
        packetKeysChanged(false);
      }
    };
  }

  const fsRequest = (deviceId: string, action: string, args: Record<string, unknown> = {}) =>
    invoke('fs_request', { deviceId, action, args });

  const sendInputLine = (deviceId: string, line: string) => invoke('send_input_line', { deviceId, line });

  const sendPacket = (deviceId: string, packetType: string, body: Record<string, unknown> = {}) =>
    invoke('send_packet', { deviceId, packetType, body });

  // A paired host announces a session with a token; the address to join is the one it connects from.
  const onPairedSession = (packetType: string, cb: (deviceId: string, token: string, host: string) => void) =>
    onPeerPacket(packetType, async (deviceId, body) => {
      const peers = (await invoke('get_connected_devices')) as { deviceId: string; ipAddress: string }[];
      const host = peers.find((peer) => peer.deviceId === deviceId)?.ipAddress;
      if (host) cb(deviceId, body.token, host);
    });

  (window as any).link = {
    // Identity & Discovery
    getIdentity: () => invoke('get_identity'),
    getVisibility: () => invoke('get_visibility'),
    setVisibility: (enabled: boolean) => invoke('set_visibility', { enabled }),
    getDiscoveredDevices: () => invoke('get_discovered_devices').then((res: any) => res || []),
    onDeviceDiscovered: (cb: (info: any) => void) => tauriSubscribe('device-discovered', cb),
    onDeviceExpired: (cb: (deviceId: string) => void) => tauriSubscribe('device-expired', (data) => cb(data.deviceId)),
    connectTo: (host: string) => invoke('connect_to', { host }),

    // Pairing
    requestPairing: (deviceId: string) => invoke('request_pairing', { deviceId }),
    requestPairingByIp: (ip: string, proof?: { fingerprint: string; token: string }) =>
      invoke('request_pairing_by_ip', { ip, fingerprint: proof?.fingerprint ?? null, token: proof?.token ?? null }),
    openPairingWindow: () => invoke('open_pairing_window'),
    openGuestQr: (port: number) => invoke('open_guest_qr', { port }),
    refreshGuestQr: (port: number) => invoke('refresh_guest_qr', { port }),
    closeGuestQr: (port: number) => invoke('close_guest_qr', { port }),
    rememberGuestScan: (addresses: string, fingerprint: string, token: string) =>
      invoke('remember_guest_scan', { addresses, fingerprint, token }),
    refreshPairingToken: () => invoke('refresh_pairing_token'),
    closePairingWindow: () => invoke('close_pairing_window'),
    acceptPairing: (deviceId: string) => invoke('accept_pairing', { deviceId }),
    cancelPairing: (deviceId: string) => invoke('cancel_pairing', { deviceId }),
    rejectPairing: (deviceId: string) => invoke('reject_pairing', { deviceId }),
    unpair: (deviceId: string) => invoke('unpair', { deviceId }),
    exitPool: () => invoke('exit_pool'),

    // Blocklist
    getBlocklist: () => invoke('get_blocklist'),
    blockDevice: (id: string, label: string, type: 'device' | 'ip') => invoke('block_device', { id, label, kind: type }),
    unblockDevice: (id: string) => invoke('unblock_device', { id }),

    // Device Actions
    sendFindMyDevice: (deviceId: string) => sendPacket(deviceId, 'link.findmydevice.request'),
    sendStopRinging: (deviceId: string) => sendPacket(deviceId, 'link.findmydevice.request', { cancel: true }),
    stopRingingLocal: () => invoke('stop_ringing_local'),
    requestDeviceLocation: (deviceId: string) => sendPacket(deviceId, 'link.location.request'),
    renameDevice: (newName: string) => invoke('rename_device', { newName }),
    sendLockRequest: (deviceId: string, setLocked: boolean) => sendPacket(deviceId, 'link.lock.request', { setLocked }),
    sendLockStatusRequest: (deviceId: string) => sendPacket(deviceId, 'link.lock.request'),
    sendFlashlightToggle: (deviceId: string, enabled: boolean) => sendPacket(deviceId, 'link.flashlight', { enabled, isCommand: true }),
    sendDndSet: (deviceId: string, enabled: boolean) => sendPacket(deviceId, 'link.dnd', { enabled, isCommand: true }),

    // Volume & MPRIS
    sendSetVolume: (deviceId: string, sinkName: string, volume: number) =>
      sendPacket(deviceId, 'link.systemvolume.request', { name: sinkName, volume }),
    sendSetMute: (deviceId: string, sinkName: string, muted: boolean) =>
      sendPacket(deviceId, 'link.systemvolume.request', { name: sinkName, muted }),
    sendMprisAction: (deviceId: string, player: string, action: string) =>
      sendPacket(deviceId, 'link.mpris.request', { player, action }),

    // Speed Test & Commands
    runSpeedTest: (deviceId: string) => invoke('run_speed_test', { deviceId }),
    pickCommandFile: () => invoke('pick_command_file'),
    getCommands: () => invoke('get_commands'),
    setCommand: (key: string, entry: { name: string; command: string }) =>
      invoke('set_command', { key, name: entry.name, command: entry.command }),
    removeCommand: (key: string) => invoke('remove_command', { key }),
    sendRunCommandTrigger: (deviceId: string, key: string) => sendPacket(deviceId, 'link.runcommand.request', { key }),
    sendNotificationReply: (deviceId: string, replyId: string, message: string) =>
      sendPacket(deviceId, 'link.notification.reply', { requestReplyId: replyId, message }),

    // Config
    getPauseMusicEnabled: () => invoke('get_setting', { key: 'pause_music', default: true }),
    setPauseMusicEnabled: (enabled: boolean) => invoke('set_setting', { key: 'pause_music', value: enabled }),
    getScreensaverInhibitEnabled: () => invoke('get_setting', { key: 'screensaver_inhibit', default: true }),
    setScreensaverInhibitEnabled: (enabled: boolean) => invoke('set_setting', { key: 'screensaver_inhibit', value: enabled }),
    getRemoteTailscaleEnabled: () => invoke('get_setting', { key: 'remote_tailscale', default: false }),
    setRemoteTailscaleEnabled: (enabled: boolean) => invoke('set_setting', { key: 'remote_tailscale', value: enabled }),
    getTailscaleStatus: () => invoke('get_tailscale_status'),
    getOpenAtLogin: () => invoke('get_open_at_login'),
    setOpenAtLogin: (enabled: boolean) => invoke('set_open_at_login', { enabled }),

    // Android-only permissions and actions; stubs on desktop.
    checkPermissions: () => Promise.resolve({}),
    requestPermissions: () => Promise.resolve({}),
    requestMobilePermission: () => Promise.resolve({}),
    checkNotificationAccess: () => Promise.resolve({ enabled: true }),
    requestNotificationAccess: () => Promise.resolve(),
    checkAllFilesAccess: () => Promise.resolve({ enabled: true }),
    requestAllFilesAccess: () => Promise.resolve(),
    checkDndPermission: () => Promise.resolve({ granted: true }),
    requestDndPermission: () => Promise.resolve(),
    isBatteryOptimizationIgnored: () => Promise.resolve({ isIgnoring: true }),
    requestIgnoreBatteryOptimizations: () => Promise.resolve(),
    checkAccessibility: () => Promise.resolve({ enabled: true }),
    requestAccessibility: () => Promise.resolve(),
    checkOverlayPermission: () => Promise.resolve({ enabled: true }),
    requestOverlayPermission: () => Promise.resolve(),
    minimizeApp: () => Promise.resolve(),

    // Input Relays
    sendRemoteInput: (deviceId: string, text?: string, specialKey?: string) => {
      const body: Record<string, string> = {};
      if (text) body.text = text;
      if (specialKey) body.specialKey = specialKey;
      return sendPacket(deviceId, 'link.remoteinput.send', body);
    },
    // An unpaired host viewed by address has no device id; the viewer uses a stand-in and these
    // route it through the guest socket instead of a paired connection.
    sendRemoteControlSignal: (deviceId: string, signal: Record<string, unknown>) => {
      if (deviceId !== GUEST_REMOTE_CONTROL_ID) return sendPacket(deviceId, 'link.remotecontrol.signal', signal);
      return signal.type === 'stop'
        ? invoke('leave_input_guest')
        : invoke('send_input_guest_packet', { packetType: 'link.remotecontrol.signal', body: signal });
    },
    sendRemoteControlInput: (deviceId: string, input: Record<string, unknown>) =>
      deviceId === GUEST_REMOTE_CONTROL_ID
        ? invoke('send_input_guest_packet', { packetType: 'link.remotecontrol.input', body: input })
        : sendPacket(deviceId, 'link.remotecontrol.input', input),
    onRemoteControlSignal: (cb: (deviceId: string, signal: any) => void) => {
      const unsubGuest = tauriSubscribe('input-guest-packet', (data) => {
        if (data.packetType === 'link.remotecontrol.signal') cb(GUEST_REMOTE_CONTROL_ID, data.body);
      });
      const unsubPaired = onPeerPacket('link.remotecontrol.signal', (id, body) => cb(id, body));
      return () => { unsubGuest(); unsubPaired(); };
    },
    requestRemoteControlHost: () => Promise.resolve(false),
    requestCameraHost: () => Promise.resolve(false),
    stopRemoteControlHost: () => Promise.resolve(),
    sendPresenterMove: (deviceId: string, dx: number, dy: number) => sendInputLine(deviceId, `pmove ${dx} ${dy}`),
    cycleTargetDisplay: (deviceId: string) => sendPacket(deviceId, 'link.target.display'),
    sendPresenterStop: (deviceId: string) =>
      sendPacket(deviceId, 'link.presenter', { stop: true }).then(() => sendInputLine(deviceId, 'pstop')),
    sendSpecialKey: (deviceId: string, key: number) => sendInputLine(deviceId, `special ${key}`),
    sendMouseMove: () => Promise.resolve(),
    sendMouseScroll: () => Promise.resolve(),
    sendMouseClick: () => Promise.resolve(),
    sendMouseDrag: () => Promise.resolve(),
    sendDigitizerSession: (deviceId: string, action: string, w: number, h: number) =>
      sendPacket(deviceId, 'link.digitizer.session', { action, width: w, height: h, resolutionX: 100, resolutionY: 100 }),
    sendDigitizerEvent: (deviceId: string, payload: any) =>
      sendInputLine(deviceId, `dig ${payload.x || 0} ${payload.y || 0} ${payload.touching || false}`),
    sendDigitizerAction: (deviceId: string, action: string) => sendInputLine(deviceId, action),
    sendJoystickHello: () => Promise.resolve(),
    sendJoystickBye: () => Promise.resolve(),
    sendJoystickState: () => Promise.resolve(),
    vibrate: () => Promise.resolve(),
    onJoystickHelloAck: noopUnsub,
    onJoystickPinRequired: noopUnsub,
    onJoystickPing: noopUnsub,
    onJoystickForcedDisconnect: noopUnsub,
    startJoystickHost: () => Promise.resolve(),
    stopJoystickHost: () => Promise.resolve(),
    requestShizukuPermission: () => Promise.resolve(),
    getJoystickStatus: () => invoke('get_joystick_status'),
    checkJoystickDriver: () => invoke('check_joystick_driver'),
    acceptJoystickGuest: (connId: string) => invoke('accept_joystick_guest', { connId }),
    rejectJoystickGuest: (connId: string) => invoke('reject_joystick_guest', { connId }),
    blockJoystickGuest: (connId: string) => invoke('block_joystick_guest', { connId }),
    kickJoystickGuest: () => Promise.resolve(),
    kickJoystickController: (ip: string) => invoke('kick_joystick_controller', { ip }),
    blockJoystickController: (ip: string, name?: string) => invoke('block_joystick_controller', { ip, name }),
    onJoystickDriverStatus: (cb: (status: string, error: string | null) => void) =>
      tauriSubscribe('joystick-driver-status', (data) => cb(data.status, data.error ?? null)),
    onJoystickRosterChanged: (cb: () => void) => tauriSubscribe('joystick-roster-changed', () => cb()),
    onJoystickGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, name: string) => void) =>
      tauriSubscribe('joystick-guest-pin-pending', (data) => cb(data[0], data[1], data[2], data[3])),
    startInputGuestHost: () => Promise.resolve(),
    stopInputGuestHost: () => Promise.resolve(),
    joinInputGuest: (host: string, name?: string, mode?: string) => invoke('join_input_guest', { host, name, mode }),
    leaveInputGuest: () => invoke('leave_input_guest'),
    getInputGuestStatus: () => invoke('get_input_guest_status'),
    acceptInputGuest: (connId: string) => invoke('accept_input_guest', { connId }),
    rejectInputGuest: (connId: string) => invoke('reject_input_guest', { connId }),
    blockInputGuest: (connId: string) => invoke('block_input_guest', { connId }),
    kickInputGuest: (ip: string) => invoke('kick_input_guest', { ip }),
    onInputGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, name: string, mode: string) => void) =>
      tauriSubscribe('input-guest-pin-pending', (data) => cb(data[0], data[1], data[2], data[3], data[4])),
    onInputGuestPinRequired: (cb: (pin: string) => void) => tauriSubscribe('input-guest-pin-required', (data) => cb(data.pin)),
    onInputGuestAdmitted: (cb: (mode: 'presenter' | 'touchpad' | 'remotecontrol' | 'extendscreen', resolvedHost?: string, hostDeviceType?: string) => void) =>
      tauriSubscribe('input-guest-admitted', (data) => cb(data.mode || 'touchpad', data.host, data.hostDeviceType)),
    onInputGuestClosed: (cb: (reason: string) => void) => tauriSubscribe('input-guest-closed', (data) => cb(data.reason || 'disconnected')),
    onInputGuestError: (cb: (error: string) => void) => tauriSubscribe('input-guest-error', (data) => cb(data.error || 'Failed to connect')),
    onInputGuestRosterChanged: (cb: () => void) => tauriSubscribe('input-guest-roster-changed', () => cb()),

    // Audio Sink
    getAudioSinkDevices: () => invoke('get_audio_sink_devices'),
    startAudioSink: (audioDeviceId?: string) => invoke('start_audio_sink', { audioDeviceId }),
    switchAudioSinkDevice: (audioDeviceId?: string) => invoke('switch_audio_sink_device', { audioDeviceId }),
    setAudioSinkMuted: (muted: boolean) => invoke('set_audio_sink_muted', { muted }),
    kickAudioSinkListener: (connId: string) => invoke('kick_audio_sink_listener', { connId }),
    blockAudioSinkListener: (connId: string) => invoke('block_audio_sink_listener', { connId }),
    getAudioSinkListeners: () => invoke('get_audio_sink_listeners'),
    getAudioSinkStatus: () => invoke('get_audio_sink_status'),
    endAudioSink: () => invoke('end_audio_sink'),
    joinAudioSinkGuest: (host: string) => invoke('join_audio_sink_guest', { host }),
    joinAudioSinkPaired: (host: string, token: string, hostName?: string) => invoke('join_audio_sink_paired', { host, token, hostName }),
    acceptAudioSinkGuest: (connId: string) => invoke('accept_audio_sink_guest', { connId }),
    rejectAudioSinkGuest: (connId: string) => invoke('reject_audio_sink_guest', { connId }),
    blockAudioSinkGuest: (connId: string) => invoke('block_audio_sink_guest', { connId }),
    leaveAudioSink: () => invoke('leave_audio_sink'),
    queryAudioSinkSessions: () => invoke('query_audio_sink_sessions'),
    setAudioSinkListenerVolume: (volume: number) => invoke('set_listen_volume', { service: 'sink', volume }),
    onAudioSinkListenerJoined: (cb: (id: string, label: string) => void) =>
      tauriSubscribe('audio-sink-listener-joined', (data) => cb(data.connId, data.label)),
    onAudioSinkListenerLeft: (cb: (id: string) => void) =>
      tauriSubscribe('audio-sink-listener-left', (data) => cb(data.connId)),
    onAudioSinkGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) =>
      tauriSubscribe('audio-sink-guest-pin-pending', (data) => cb(data[0], data[1], data[2], data[3])),
    onAudioSinkPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) =>
      onPairedSession('link.audiosink.started', cb),
    onAudioSinkPairedSessionEnded: (cb: (deviceId: string) => void) =>
      onPeerPacket('link.audiosink.ended', (deviceId) => cb(deviceId)),
    onAudioSinkStats: noopUnsub,
    onAudioSinkAdmitted: (cb: (hostName: string) => void) =>
      tauriSubscribe('audio-sink-admitted', (data) => cb(data?.hostName || '')),
    onAudioSinkHostMuted: (cb: (muted: boolean) => void) =>
      tauriSubscribe('audio-sink-host-muted', (data) => cb(data.muted)),
    onAudioSinkEnded: (cb: (reason?: string) => void) =>
      tauriSubscribe('audio-sink-ended', (data) => cb(data?.reason)),
    onAudioSinkClosed: (cb: (reason: string) => void) =>
      tauriSubscribe('audio-sink-closed', (data) => cb(data.reason)),
    onAudioSinkError: (cb: (message: string) => void) =>
      tauriSubscribe('audio-sink-error', (data) => cb(data.message)),
    onAudioSinkPinComputed: (cb: (pin: string) => void) =>
      tauriSubscribe('audio-sink-pin-computed', (data) => cb(data.pin)),

    // Remote Mic
    startRemoteMic: () => Promise.resolve({ started: true }),
    setRemoteMicMuted: () => Promise.resolve({ success: true }),
    kickRemoteMicListener: () => Promise.resolve({ success: true }),
    blockRemoteMicListener: () => Promise.resolve({ success: true }),
    acceptRemoteMicGuest: () => Promise.resolve({ success: true }),
    rejectRemoteMicGuest: () => Promise.resolve({ success: true }),
    blockRemoteMicGuest: () => Promise.resolve({ success: true }),
    getRemoteMicListeners: () => Promise.resolve([]),
    getRemoteMicStatus: () => invoke('get_remote_mic_status'),
    endRemoteMic: () => Promise.resolve({ success: true }),
    queryRemoteMicSessions: () => invoke('query_remote_mic_sessions'),
    joinRemoteMicPaired: (host: string, token: string) => invoke('join_remote_mic_paired', { host, token }),
    joinRemoteMicGuest: (host: string) => invoke('join_remote_mic_guest', { host }),
    leaveRemoteMic: () => invoke('leave_remote_mic'),
    getAudioOutputDevices: () => invoke('get_audio_output_devices'),
    setRemoteMicOutputDevice: (deviceId: string) => invoke('set_listen_output_device', { service: 'mic', deviceId: deviceId || null }),
    setRemoteMicVolume: (volume: number) => invoke('set_listen_volume', { service: 'mic', volume }),
    onRemoteMicGuestPinPending: noopUnsub,
    onRemoteMicListenerJoined: noopUnsub,
    onRemoteMicListenerLeft: noopUnsub,
    onRemoteMicError: (cb: (message: string) => void) =>
      tauriSubscribe('remote-mic-error', (data) => cb(data.message)),
    onRemoteMicPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) =>
      onPairedSession('link.remotemic.started', cb),
    onRemoteMicPairedSessionEnded: (cb: (deviceId: string) => void) =>
      onPeerPacket('link.remotemic.ended', (deviceId) => cb(deviceId)),
    onRemoteMicPinComputed: (cb: (pin: string) => void) =>
      tauriSubscribe('remote-mic-pin-computed', (data) => cb(data.pin)),
    onRemoteMicAdmitted: (cb: (hostName: string) => void) =>
      tauriSubscribe('remote-mic-admitted', (data) => cb(data?.hostName || '')),
    onRemoteMicEnded: (cb: (reason?: string) => void) =>
      tauriSubscribe('remote-mic-ended', (data) => cb(data?.reason)),
    onRemoteMicClosed: (cb: (reason: string) => void) =>
      tauriSubscribe('remote-mic-closed', (data) => cb(data.reason)),

    // Walkie Talkie
    sendWalkieTalkieSignal: (deviceId: string, type: string, body: any) => sendPacket(deviceId, type, body || {}),
    broadcastWalkieTalkieSignal: (type: string, body: any) => invoke('broadcast_packet', { packetType: type, body: body || {} }),
    // Every link.walkietalkie.* packet is forwarded as-is; WalkieTalkieTab interprets the bodies.
    onWalkieTalkieSignal: (cb: (deviceId: string, type: string, body: any) => void) =>
      onPeerPacket('link.walkietalkie.*', (id, body, type) => cb(id, type, body)),
    startWalkieTalkieGuestListener: () => invoke('start_walkie_talkie_guest_listener'),
    stopWalkieTalkieGuestListener: () => invoke('stop_walkie_talkie_guest_listener'),
    acceptWalkieTalkieGuest: (connId: string) => invoke('accept_walkie_talkie_guest', { connId }),
    rejectWalkieTalkieGuest: (connId: string) => invoke('reject_walkie_talkie_guest', { connId }),
    kickWalkieTalkieGuest: (connId: string) => invoke('kick_walkie_talkie_guest', { connId }),
    blockWalkieTalkieGuest: (connId: string) => invoke('block_walkie_talkie_guest', { connId }),
    blockWalkieTalkieMember: (deviceId: string, label: string) => invoke('block_walkie_talkie_member', { deviceId, label }),
    sendWalkieTalkieGuestSignal: (connId: string, type: string, body: any) =>
      invoke('send_walkie_talkie_guest_signal', { connId, kind: type, body: body || {} }),
    onWalkieTalkieGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) =>
      tauriSubscribe('walkie-talkie-guest-pin-pending', (data) => cb(data[0], data[1], data[2], data[3])),
    onWalkieTalkieGuestJoined: (cb: (connId: string, remoteAddress: string, deviceName: string) => void) =>
      tauriSubscribe('walkie-talkie-guest-joined', (data) => cb(data[0], data[1], data[2])),
    onWalkieTalkieGuestSignal: (cb: (connId: string, type: string, body: any) => void) =>
      tauriSubscribe('walkie-talkie-guest-signal', (data) => cb(data[0], data[1], data[2] ?? {})),
    onWalkieTalkieGuestLeft: (cb: (connId: string) => void) => tauriSubscribe('walkie-talkie-guest-left', (data) => cb(data)),
    joinWalkieTalkieGuest: (host: string) => invoke('join_walkie_talkie_guest', { host }),
    leaveWalkieTalkieGuest: () => invoke('leave_walkie_talkie_guest'),
    sendWalkieTalkieGuestMessage: (type: string, body: any) =>
      invoke('send_walkie_talkie_guest_message', { kind: type, body: body || {} }),
    onWalkieTalkieGuestPinComputed: (cb: (pin: string) => void) => tauriSubscribe('walkie-talkie-guest-pin-computed', (data) => cb(data.pin)),
    onWalkieTalkieHostSignal: (cb: (type: string, body: any) => void) =>
      tauriSubscribe('walkie-talkie-host-signal', (data) => cb(data.type, data.body ?? {})),
    onWalkieTalkieHostEnded: (cb: (reason?: string) => void) => tauriSubscribe('walkie-talkie-host-ended', (data) => cb(data.reason)),
    onWalkieTalkieHostClosed: (cb: (reason: string) => void) => tauriSubscribe('walkie-talkie-host-closed', (data) => cb(data.reason)),
    onWalkieTalkieHostError: (cb: (message: string) => void) => tauriSubscribe('walkie-talkie-host-error', (data) => cb(data.message)),

    // File Portal
    pickPortalFiles: (mode: 'file' | 'directory') => invoke('pick_portal_files', { mode }),
    pickPortalSaveDir: () => invoke('pick_portal_save_dir'),
    startPortalReceive: (webMode?: boolean) => invoke('start_portal_receive', { webMode }),
    acceptPortalGuest: (connId: string, saveDir?: string) => invoke('accept_portal_guest', { connId, saveDir }),
    rejectPortalGuest: (connId: string) => invoke('reject_portal_guest', { connId }),
    blockPortalGuest: (connId: string) => invoke('block_portal_guest', { connId }),
    holdPortalGuest: (connId: string) => invoke('hold_portal_guest', { connId }),
    disconnectPortalConnection: (connId: string) => invoke('disconnect_portal_connection', { connId }),
    endPortalReceive: () => invoke('end_portal_receive'),
    joinPortalGuest: (host: string, files: { localPath: string; relPath: string }[]) =>
      invoke('join_portal_guest', { host, files: files.map((f) => ({ name: f.relPath, localPath: f.localPath })) }),
    setPortalDownloads: (files: { name: string; localPath: string }[]) => invoke('set_portal_downloads', { files }),
    requestPortalDownload: (fileId: string, saveDir?: string) => invoke('request_portal_download', { fileId, saveDir }),
    leavePortalSend: () => invoke('leave_portal_send'),
    getPortalStatus: () => invoke('get_portal_status'),
    onPortalGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) =>
      tauriSubscribe('portal-guest-pin-pending', (data) => cb(data[0], data[1], data[2], data[3])),
    onPortalConnectionAdmitted: (cb: (connId: string, deviceName: string) => void) =>
      tauriSubscribe('portal-connection-admitted', (data) => cb(data.connId, data.deviceName)),
    onPortalConnectionClosed: (cb: (connId: string) => void) =>
      tauriSubscribe('portal-connection-closed', (data) => cb(data.connId)),
    onPortalPeerFilesChanged: (cb: (files: { id: string; name: string; size: number }[]) => void) =>
      tauriSubscribe('portal-peer-files-changed', (data) => cb(data.files || [])),
    onPortalFileStarted: noopUnsub,
    onPortalTransferStarted: (cb: (connId: string, name: string, size: number) => void) =>
      tauriSubscribe('portal-transfer-started', (data) => cb(data.connId, data.name, data.size)),
    onPortalTransferProgress: (cb: (connId: string, received: number, size: number) => void) =>
      tauriSubscribe('portal-transfer-progress', (data) => cb(data.connId, data.received, data.size)),
    onPortalTransferComplete: (cb: (connId: string, destPath: string) => void) =>
      tauriSubscribe('portal-transfer-complete', (data) => cb(data.connId, data.destPath)),
    onPortalPinComputed: (cb: (pin: string) => void) =>
      tauriSubscribe('portal-pin-computed', (data) => cb(data.pin)),
    onPortalAdmitted: (cb: (receiverDeviceName?: string) => void) =>
      tauriSubscribe('portal-admitted', (data) => cb(data?.deviceName)),
    onPortalSendProgress: (cb: (sent: number, total: number) => void) =>
      tauriSubscribe('portal-send-progress', (data) => cb(data.sent, data.total)),
    onPortalSendComplete: (cb: () => void) =>
      tauriSubscribe('portal-send-complete', () => cb()),
    onPortalEnded: (cb: () => void) =>
      tauriSubscribe('portal-ended', () => cb()),
    onPortalClosed: (cb: (reason: string) => void) =>
      tauriSubscribe('portal-closed', (data) => cb(data.reason)),
    onPortalError: (cb: (message: string) => void) =>
      tauriSubscribe('portal-error', (data) => cb(data.message)),
    onAppResumed: noopUnsub,
    getDeviceMountConfig: (deviceId: string) => invoke('get_device_mount_config', { deviceId }),
    vcamStatus: () => invoke('vcam_status'),
    vcamStart: () => invoke('vcam_start'),
    vcamStop: () => invoke('vcam_stop'),
    vcamOpen: () => invoke('vcam_open'),
    vcamConnected: () => invoke('vcam_connected'),
    vcamLog: (message: string) => invoke('vcam_log', { message }),
    h264Status: () => invoke('h264_status'),
    // The newest photos on a paired phone, read on demand (the strip on its card); nothing is stored here.
    getRecentPhotos: (deviceId: string, limit?: number, before?: number) => invoke('get_recent_photos', { deviceId, limit, before }),
    getPhotoThumbnail: (deviceId: string, path: string, size?: number, mtime?: number) => invoke('get_photo_thumbnail', { deviceId, path, size, mtime }),
    copyPhotoToClipboard: (deviceId: string, path: string) => invoke('copy_photo_to_clipboard', { deviceId, path }),
    h264Install: () => invoke('h264_install'),
    // Rust asks for screen sharing (no payload); the virtual webcam asks from the page with `feature: 'camera'`.
    onH264ComponentNeeded: (cb: (feature: 'screen' | 'camera') => void) =>
      tauriSubscribe('h264-component-needed', (data) => cb(data?.feature === 'camera' ? 'camera' : 'screen')),
    requestH264Component: (feature: 'screen' | 'camera') => emit('h264-component-needed', { feature }),

    // Sharing files with paired devices: a device offers files, the user accepts, picks a folder, and the files stream in.
    acceptShare: (transferId: string, saveDir: string) => invoke('accept_share', { transferId, saveDir }),
    rejectShare: (transferId: string) => invoke('reject_share', { transferId }),
    sendFiles: (deviceId: string, paths: string[]) => invoke('send_files', { deviceId, paths }),
    onShareOffer: (cb: (offer: ShareOffer) => void) => tauriSubscribe('share-offer', (data) => cb(data)),
    onShareOfferClosed: (cb: (transferId: string) => void) => tauriSubscribe('share-offer-closed', (data) => cb(data.transferId)),
    onShareStatus: (cb: (status: { transferId: string; deviceId: string; state: string; message: string }) => void) =>
      tauriSubscribe('share-status', (data) => cb(data)),
    vcamNativeStart: (deviceId: string) => invoke('vcam_native_start', { deviceId }),
    vcamNativeStop: (deviceId: string) => invoke('vcam_native_stop', { deviceId }),
    vcamNativeStatus: (deviceId: string) => invoke('vcam_native_status', { deviceId }),
    vcamNativeConfig: (mirror: boolean, fill: boolean, zoom: number) => invoke('vcam_native_config', { mirror, fill, zoom }),
    cameraPreviewFrame: (since: number) => invoke<ArrayBuffer>('camera_preview_frame', { since }),
    setDeviceMountLetter: (deviceId: string, driveLetter: string) => invoke('set_device_mount_letter', { deviceId, driveLetter }),
    onDeviceMountChanged: (cb: (deviceId: string, driveLetter?: string) => void) =>
      tauriSubscribe('device-mount-changed', (data) => cb(data.deviceId, data.driveLetter ?? undefined)),

    // Filesystem Explorer
    // Replies of the device's file server (LinkFsServer.java); a failed request rejects in Rust.
    fsListRoots: (deviceId: string) =>
      fsRequest(deviceId, 'listRoots').then((res: any) => res.roots || []),
    fsReaddir: (deviceId: string, path: string, offset = 0, limit = 0) =>
      fsRequest(deviceId, 'readdir', { path, offset, limit }).then((res: any) => ({ entries: res.files || [], hasMore: !!res.hasMore })),
    fsThumbnail: (deviceId: string, path: string, size: number, mtime: number, max?: number) =>
      invoke('get_photo_thumbnail', { deviceId, path, size, mtime, max }),
    fsStat: (deviceId: string, path: string) => fsRequest(deviceId, 'stat', { path }),
    fsRead: (deviceId: string, path: string, offset: number, length: number) =>
      invoke('fs_read', { deviceId, path, offset, length }),
    fsCreateDirectory: (deviceId: string, path: string) =>
      fsRequest(deviceId, 'create', { path, isDirectory: true }).then(() => true),
    fsDelete: (deviceId: string, path: string) => fsRequest(deviceId, 'delete', { path }).then(() => true),
    fsRename: (deviceId: string, path: string, newPath: string) =>
      fsRequest(deviceId, 'rename', { path, newPath }).then(() => true),
    fsDownloadFile: (deviceId: string, remotePath: string, localPath: string) =>
      invoke('fs_download_file', { deviceId, remotePath, localPath }),
    fsPickSavePath: (defaultName: string) => invoke('fs_pick_save_path', { defaultName }),
    fsPickSaveDirectory: () => invoke('fs_pick_save_directory'),
    fsMountDevice: (deviceId: string) => invoke('fs_mount_device', { deviceId }),
    fsUnmountDevice: (deviceId: string) => invoke('fs_unmount_device', { deviceId }),
    fsUploadItem: (deviceId: string, localPath: string, remoteParentPath: string) =>
      invoke('fs_upload_item', { deviceId, localPath, remoteParentPath }),
    fsPickUploadItems: (mode: 'file' | 'directory') => invoke('fs_pick_upload_items', { mode }),
    fsCancelTransfer: (transferId: string) => invoke('fs_cancel_transfer', { transferId }),
    expandDroppedPaths: () => Promise.resolve([]),
    getPathForFile: () => '',
    fsGetStreamUrl: (deviceId: string, remotePath: string) => invoke('fs_get_stream_url', { deviceId, remotePath }),
    openExternal: (target: string) => invoke('open_external', { target }),
    fsOpenDocument: (deviceId: string, remotePath: string) => invoke('fs_open_document', { deviceId, remotePath }),
    onFsTransferProgress: (cb: (info: { transferId: string; direction: 'download' | 'upload'; deviceId: string; path: string; transferred: number; total: number }) => void) =>
      tauriSubscribe('fs-transfer-progress', cb),


    // Permissions & Devices
    getPermissions: () => invoke('get_permissions'),
    setPermissions: (permissions: any) => invoke('set_permissions', { permissions }),
    getTrustedDevices: () => invoke('get_trusted_devices').then((res: any) => res || []),
    getConnectedDevices: () => invoke('get_connected_devices').then((res: any) => res || []),
    resyncDevices: () => invoke('resync_devices'),
    openAppSettings: () => Promise.resolve(),
    renameTrustedDevice: (deviceId: string, newName: string) => invoke('rename_trusted_device', { deviceId, newName }),
    setImmersiveMode: () => Promise.resolve(),
    setSystemGestureExclusion: () => Promise.resolve(),

    // Event Listeners
    onDeviceConnected: (cb: (identity: any, trusted: boolean) => void) =>
      tauriSubscribe('device-connected', (data) => cb(data, data.trusted)),
    onDeviceDisconnected: (cb: (deviceId: string) => void) =>
      tauriSubscribe('device-disconnected', (data) => cb(data.deviceId)),
    onIncomingPairRequest: (cb: (deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null, viaQr?: boolean) => void) =>
      tauriSubscribe('incoming-pair-request', (data) => cb(data.deviceId, data.deviceName, data.deviceType, data.verificationKey, !!data.viaQr)),
    onPairingBlocked: (cb: (deviceName: string) => void) =>
      tauriSubscribe('pairing-blocked', (data) => cb(data.deviceName)),
    onPairingSuccessful: (cb: (deviceId: string) => void) =>
      tauriSubscribe('pairing-successful', (data) => cb(data.deviceId)),
    onPairingFailed: (cb: (deviceId: string, reason: string) => void) =>
      tauriSubscribe('pairing-failed', (data) => cb(data.deviceId, data.reason)),
    onUnpaired: (cb: (deviceId: string) => void) =>
      tauriSubscribe('unpaired', (data) => cb(data.deviceId)),
    onTrustMismatch: (cb: (deviceId: string) => void) =>
      tauriSubscribe('trust-mismatch', (data) => cb(data.deviceId)),
    onTrustListUpdated: (cb: () => void) =>
      tauriSubscribe('trust-list-updated', () => cb()),
    onClipboardReceived: (cb: (deviceId: string) => void) =>
      tauriSubscribe('clipboard-received', (data) => cb(data.deviceId)),
    onBatteryReceived: (cb: (deviceId: string, isCharging: boolean, currentCharge: number) => void) =>
      onPeerPacket('link.battery', (id, body) => cb(id, !!body.isCharging, body.currentCharge)),
    onFindMyDeviceTriggered: (cb: (deviceId: string) => void) =>
      tauriSubscribe('find-my-device-triggered', (data) => cb(data.deviceId)),
    onFindMyDeviceStopped: (cb: (deviceId: string) => void) =>
      tauriSubscribe('find-my-device-stopped', (data) => cb(data.deviceId)),
    onLocationReceived: (cb: (deviceId: string, body: any) => void) => onPeerPacket('link.location', (id, body) => cb(id, body)),
    onInputKicked: (cb: (deviceId: string) => void) => onPeerPacket('link.input.kicked', (id) => cb(id)),
    onLockStateReceived: (cb: (deviceId: string, isLocked: boolean) => void) =>
      onPeerPacket('link.lock', (id, body) => cb(id, !!body.isLocked)),
    onLockResultReceived: (cb: (deviceId: string, success: boolean) => void) =>
      onPeerPacket('link.lock', (id, body) => { if ('lockResult' in body) cb(id, !!body.lockResult); }),
    onShareReceived: noopUnsub,
    onNotificationReceived: (cb: (deviceId: string, body: any) => void) =>
      onPeerPacket('link.notification', (id, body) => {
        if (body.isCancel !== true && body.isCancel !== 'true') cb(id, body);
      }),
    onNotificationCancelled: (cb: (deviceId: string, id: string) => void) =>
      onPeerPacket('link.notification', (id, body) => {
        if (body.isCancel === true || body.isCancel === 'true') cb(id, body.id);
      }),
    onNotificationBroadcastReceived: noopUnsub,
    onSystemVolumeReceived: (cb: (deviceId: string, body: any) => void) =>
      onPeerPacket('link.systemvolume', (id, body) => cb(id, body)),
    // isCommand packets are requests aimed at the receiver, not state reports.
    onFlashlightStateReceived: (cb: (deviceId: string, enabled: boolean) => void) =>
      onPeerPacket('link.flashlight', (id, body) => { if (!body.isCommand) cb(id, !!body.enabled); }),
    onDndStateReceived: (cb: (deviceId: string, enabled: boolean, granted: boolean) => void) =>
      onPeerPacket('link.dnd', (id, body) => { if (!body.isCommand) cb(id, !!body.enabled, body.granted ?? true); }),
    onMprisStateReceived: (cb: (deviceId: string, body: any) => void) =>
      onPeerPacket('link.mpris', (id, body) => cb(id, body)),
    onPeerCapabilitiesReceived: (cb: (deviceId: string, capabilities: string[]) => void) =>
      onPeerPacket('link.capabilities', (id, body) => cb(id, body.capabilities ?? [])),
    onSpeedTestProgress: (cb: (deviceId: string, message: string) => void) =>
      tauriSubscribe('speed-test-progress', (data) => cb(data.deviceId, data.message)),
    onPresenterPositionReceived: noopUnsub,
    onLocalIdentityUpdated: noopUnsub,
    onCommandListReceived: (cb: (deviceId: string, commands: Record<string, { name: string; command: string }>) => void) =>
      onPeerPacket('link.runcommand', (id, body) => {
        if (typeof body.commandList !== 'string') return;
        try { cb(id, JSON.parse(body.commandList)); } catch { cb(id, {}); }
      }),
    onDeviceRenamed: noopUnsub,
    onOwnDeviceRenamed: noopUnsub,
  };
}

export {};
