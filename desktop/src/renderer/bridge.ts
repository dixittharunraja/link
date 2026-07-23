// Unified Bridge: shims Electron preload IPC and Capacitor native Plugins into a single window.link API

const isCapacitor = typeof (window as any).Capacitor !== 'undefined';

if (isCapacitor) {
  const CapacitorLink = (window as any).Capacitor.Plugins.Link;

  // React.StrictMode (main.tsx) intentionally double-invokes effects in dev mode without ever
  // calling a cleanup function here (App.tsx's big setup effect returns none) — every one of
  // these listener registrations used to accumulate a second, permanent duplicate, so every real
  // event (an incoming pair request, in particular) fired its callback twice. Each event name
  // below is dedicated to exactly one App.tsx callback, so removing any previous handle before
  // adding the new one makes registration idempotent regardless of how many times it's called.
  const listenerHandles = new Map<string, Promise<{ remove: () => Promise<void> }>>();
  function subscribe(eventName: string, cb: (data: any) => void) {
    const previous = listenerHandles.get(eventName);
    if (previous) previous.then((h) => h.remove()).catch(() => {});
    // Promise.resolve(...) normalizes both addListener() shapes: older Capacitor returns
    // Promise<PluginListenerHandle>, Capacitor 6+ returns the handle synchronously (no Promise
    // wrapper) — storing the raw return value broke .then() on the SECOND subscribe() for the
    // same eventName (the handle itself has no .then), throwing uncaught inside whatever effect
    // called it. Wrapping always yields a real Promise regardless of which shape came back.
    listenerHandles.set(eventName, Promise.resolve(CapacitorLink.addListener(eventName, cb)));
  }

  (window as any).link = {
    // Identity & Discovery
    getIdentity: () => CapacitorLink.getIdentity(),
    getVisibility: () => CapacitorLink.getVisibility().then((data: any) => data.enabled),
    setVisibility: (enabled: boolean) => CapacitorLink.setVisibility({ enabled }),
    connectTo: (host: string) => {
      const [ip, portStr] = host.split(':');
      const port = portStr ? parseInt(portStr, 10) : undefined;
      return CapacitorLink.connectTo({ host: ip, port });
    },

    // Pairing
    requestPairing: (deviceId: string) => 
      CapacitorLink.requestPairing({ deviceId }).then((res: any) => res.verificationKey),
    acceptPairing: (deviceId: string) => CapacitorLink.acceptPairing({ deviceId }),
    rejectPairing: (deviceId: string) => CapacitorLink.rejectPairing({ deviceId }),
    unpair: (deviceId: string) => CapacitorLink.unpair({ deviceId }),
    removeFromPool: (deviceId: string) => CapacitorLink.removeFromPool({ deviceId }),
    exitPool: () => CapacitorLink.exitPool(),

    // Device Actions
    sendFindMyPhone: (deviceId: string) => CapacitorLink.sendFindMyPhone({ deviceId }),
    sendStopRinging: (deviceId: string) => CapacitorLink.stopFindMyPhone({ deviceId }),
    stopRingingLocal: () => CapacitorLink.stopFindMyPhone(), // stops local ringing on phone
    renameDevice: (newName: string) => 
      CapacitorLink.renameDevice({ name: newName }).then((res: any) => res.name),
    sendLockRequest: (deviceId: string, setLocked: boolean) =>
      CapacitorLink.sendLockRequest({ deviceId, setLocked }),
    sendLockStatusRequest: (deviceId: string) => CapacitorLink.sendLockQuery({ deviceId }),
    sendFlashlightToggle: (deviceId: string, enabled: boolean) => 
      CapacitorLink.sendFlashlightToggle({ deviceId, enabled }),
    sendDndSet: (deviceId: string, enabled: boolean) => 
      CapacitorLink.sendDndSet({ deviceId, enabled }),
    
    // Volume & MPRIS
    sendSetVolume: (deviceId: string, sinkName: string, volume: number) => 
      CapacitorLink.sendSetVolume({ deviceId, name: sinkName, volume }),
    sendSetMute: (deviceId: string, sinkName: string, muted: boolean) => 
      CapacitorLink.sendSetMute({ deviceId, name: sinkName, muted }),
    sendMprisAction: (deviceId: string, player: string, action: string) => 
      CapacitorLink.sendMprisAction({ deviceId, action }),

    // Speed Test & Commands (the phone never owns/edits a whitelist of its own — getCommands/
    // setCommand/removeCommand stay no-ops here — but it CAN view and trigger a paired desktop's
    // whitelist, same as the desktop app viewing another desktop's, via the native methods below
    // that were already built and proven working but never wired up to this shared UI.)
    runSpeedTest: (deviceId: string) => CapacitorLink.runSpeedTest({ deviceId }),
    getCommands: () => Promise.resolve({}),
    setCommand: () => Promise.resolve({}),
    removeCommand: () => Promise.resolve({}),
    sendRunCommandTrigger: (deviceId: string, key: string) => CapacitorLink.triggerCommand({ deviceId, key }),

    sendNotificationReply: (deviceId: string, replyId: string, message: string) =>
      Promise.resolve(), 

    // Pause music config
    getPauseMusicEnabled: () => Promise.resolve(false),
    setPauseMusicEnabled: () => Promise.resolve(),

    // Desktop-only concepts (no OS screensaver/login-item equivalent wired up on mobile) — stubs
    // so SettingsTab's desktop-only section (gated on isMobile) never actually calls these here.
    getScreensaverInhibitEnabled: () => Promise.resolve(false),
    setScreensaverInhibitEnabled: () => Promise.resolve(),
    // Desktop-only (no window/tray concept on mobile — the foreground service handles background).
    getCloseToTray: () => Promise.resolve(false),
    setCloseToTray: () => Promise.resolve(),
    getOpenAtLogin: () => Promise.resolve(false),
    setOpenAtLogin: () => Promise.resolve(),

    // --- Mobile Native-Specific Methods ---
    isMobile: true,
    checkPermissions: () => CapacitorLink.checkPermissions(),
    requestMobilePermission: (permission: string) => 
      CapacitorLink.requestPermissions({ permissions: [permission] }),
    checkNotificationAccess: () => CapacitorLink.checkNotificationAccess(),
    requestNotificationAccess: () => CapacitorLink.requestNotificationAccess(),
    checkAllFilesAccess: () => CapacitorLink.checkAllFilesAccess(),
    requestAllFilesAccess: () => CapacitorLink.requestAllFilesAccess(),
    checkDndPermission: () => CapacitorLink.checkDndPermission(),
    requestDndPermission: () => CapacitorLink.requestDndPermission(),
    checkDeviceAdmin: () => CapacitorLink.checkDeviceAdmin(),
    requestDeviceAdmin: () => CapacitorLink.requestDeviceAdmin(),
    isBatteryOptimizationIgnored: () => CapacitorLink.isBatteryOptimizationIgnored(),
    requestIgnoreBatteryOptimizations: () => CapacitorLink.requestIgnoreBatteryOptimizations(),

    // Hardware back button fallback — see backNav.ts / App.tsx's 'linkHardwareBack' listener.
    // moveTaskToBack (not finish()) so it matches standard Android back-at-root behavior: send
    // to background, don't kill the process.
    minimizeApp: () => CapacitorLink.minimizeApp(),

    // Input Relays
    sendPresenterMove: (deviceId: string, dx: number, dy: number) =>
      CapacitorLink.sendPresenterMove({ deviceId, dx, dy }),
    cycleTargetDisplay: (deviceId: string) => CapacitorLink.cycleTargetDisplay({ deviceId }),
    sendPresenterStop: (deviceId: string) => CapacitorLink.sendPresenterStop({ deviceId }),
    sendSpecialKey: (deviceId: string, key: number) => 
      CapacitorLink.sendSpecialKey({ deviceId, specialKey: key }),
    sendMouseMove: (deviceId: string, dx: number, dy: number) => 
      CapacitorLink.sendMouseMove({ deviceId, dx, dy }),
    sendMouseScroll: (deviceId: string, dx: number, dy: number) => 
      CapacitorLink.sendMouseScroll({ deviceId, dx, dy }),
    sendMouseClick: (deviceId: string, clickType: string) => 
      CapacitorLink.sendMouseClick({ deviceId, clickType }),
    sendMouseDrag: (deviceId: string, hold: boolean) => 
      CapacitorLink.sendMouseDrag({ deviceId, hold }),
    sendDigitizerSession: (deviceId: string, action: string, w: number, h: number) => 
      CapacitorLink.sendDigitizerSession({ deviceId, action, width: w, height: h, resolutionX: 100, resolutionY: 100 }),
    sendDigitizerEvent: (deviceId: string, payload: any) =>
      CapacitorLink.sendDigitizerEvent({ deviceId, ...payload }),
    sendDigitizerAction: (deviceId: string, action: string) =>
      CapacitorLink.sendDigitizerAction({ deviceId, action }),

    // Real, file-backed native storage (LinkDevicePermissions.java) — previously this only read/
    // wrote WebView localStorage, which no native code ever consulted, making every per-device
    // permission toggle purely decorative on mobile.
    getPermissions: () => CapacitorLink.getPermissions(),
    setPermissions: (permissions: any) => CapacitorLink.setPermissions(permissions).then(() => true),
    getTrustedDevices: () =>
      CapacitorLink.getTrustedDevices().then((res: any) => res.devices || []),
    getConnectedDevices: () =>
      CapacitorLink.getConnectedDevices().then((res: any) => res.devices || []),
    resyncDevices: () => CapacitorLink.resyncDevices(),
    openAppSettings: () => CapacitorLink.openAppSettings(),
    renameTrustedDevice: (deviceId: string, newName: string) => 
      CapacitorLink.renameTrustedDevice({ deviceId, name: newName }),

    // --- Dynamic Event Listener Shims ---
    onDeviceConnected: (cb: (identity: any, trusted: boolean) => void) => {
      subscribe('deviceConnected', (data: any) => cb(data, data.trusted));
    },
    onDeviceDisconnected: (cb: (deviceId: string) => void) => {
      subscribe('deviceDisconnected', (data: any) => cb(data.deviceId));
    },
    onIncomingPairRequest: (cb: (deviceId: string, verificationKey: string | null) => void) => {
      subscribe('incomingPairRequest', (data: any) => cb(data.deviceId, data.verificationKey));
    },
    onPairingSuccessful: (cb: (deviceId: string) => void) => {
      subscribe('pairingSuccessful', (data: any) => cb(data.deviceId));
    },
    onPairingFailed: (cb: (deviceId: string, reason: string) => void) => {
      subscribe('pairingFailed', (data: any) => cb(data.deviceId, data.reason));
    },
    onUnpaired: (cb: (deviceId: string) => void) => {
      subscribe('unpaired', (data: any) => cb(data.deviceId));
    },
    onTrustMismatch: (cb: (deviceId: string) => void) => {
      subscribe('trustMismatch', (data: any) => cb(data.deviceId));
    },
    onClipboardReceived: (cb: (deviceId: string) => void) => {
      // Mobile does not mirror clipboard via standard incoming event
    },
    onBatteryReceived: (cb: (deviceId: string, isCharging: boolean, currentCharge: number) => void) => {
      subscribe('batteryReceived', (data: any) => cb(data.deviceId, data.isCharging, data.currentCharge));
    },
    onFindMyPhoneTriggered: (cb: (deviceId: string) => void) => {
      subscribe('findMyPhoneTriggered', (data: any) => cb(data.deviceId));
    },
    onFindMyPhoneStopped: (cb: (deviceId: string) => void) => {
      subscribe('findMyPhoneStopped', (data: any) => cb(data.deviceId));
    },
    onLockStateReceived: (cb: (deviceId: string, isLocked: boolean) => void) => {
      subscribe('lockStateReceived', (data: any) => cb(data.deviceId, data.isLocked));
    },
    onLockResultReceived: (cb: (deviceId: string, success: boolean) => void) => {
      subscribe('lockResultReceived', (data: any) => cb(data.deviceId, data.success));
    },
    onShareReceived: (cb: (deviceId: string, filename: string, size: number) => void) => {
      subscribe('shareReceived', (data: any) => cb(data.deviceId, data.filename, data.size));
    },
    onConnectivityReceived: (cb: (deviceId: string, signalStrengths: any) => void) => {
      subscribe('connectivityReceived', (data: any) => cb(data.deviceId, data.signalStrengths));
    },
    onNotificationReceived: () => {},
    onNotificationCancelled: () => {},
    onSystemVolumeReceived: (cb: (deviceId: string, body: any) => void) => {
      subscribe('systemVolumeReceived', (data: any) => cb(data.deviceId, { sinkList: data.sinks }));
    },
    onFlashlightStateReceived: (cb: (deviceId: string, enabled: boolean, revoked?: boolean) => void) => {
      subscribe('flashlightStateReceived', (data: any) => cb(data.deviceId, data.enabled, data.revoked));
    },
    onDndStateReceived: (cb: (deviceId: string, enabled: boolean, granted: boolean, revoked?: boolean) => void) => {
      subscribe('dndStateReceived', (data: any) => cb(data.deviceId, data.enabled, data.granted, data.revoked));
    },
    onMprisStateReceived: (cb: (deviceId: string, body: any) => void) => {
      subscribe('mprisStateReceived', (data: any) => cb(data.deviceId, data.state));
    },
    onPeerCapabilitiesReceived: (cb: (deviceId: string, capabilities: string[]) => void) => {
      subscribe('peerCapabilitiesReceived', (data: any) => cb(data.deviceId, data.capabilities || []));
    },
    onSpeedTestProgress: (cb: (deviceId: string, message: string) => void) => {
      subscribe('speedTestProgress', (data: any) => cb(data.deviceId, data.message));
    },
    onCommandListReceived: (cb: (deviceId: string, commands: Record<string, { name: string; command: string }>) => void) => {
      subscribe('commandListReceived', (data: any) => {
        try {
          cb(data.deviceId, JSON.parse(data.commands));
        } catch {
          cb(data.deviceId, {});
        }
      });
    },
    onDeviceRenamed: (cb: (deviceId: string, newName: string) => void) => {
      subscribe('deviceRenamed', (data: any) => cb(data.deviceId, data.newName));
    },
    onOwnDeviceRenamed: (cb: (newName: string) => void) => {
      subscribe('ownDeviceRenamed', (data: any) => cb(data.newName));
    },

    // --- Audio Relay ---
    // Android can host too (AudioPlaybackCaptureConfiguration + MediaProjection, API 29+ — see
    // LinkAudioCapture.java/LinkAudioRelayServer.java). startAudioRelay() drives the RECORD_AUDIO
    // permission check and the MediaProjection consent dialog natively, so from here it's just a
    // single call that resolves once the user has responded (or been denied/it's unsupported).
    startAudioRelay: () => CapacitorLink.startAudioRelay(),
    acceptAudioRelayGuest: (connId: string) => CapacitorLink.acceptAudioRelayGuest({ connId }),
    rejectAudioRelayGuest: (connId: string) => CapacitorLink.rejectAudioRelayGuest({ connId }),
    setAudioRelayMuted: (muted: boolean) => CapacitorLink.setAudioRelayMuted({ muted }),
    getAudioRelayListeners: () =>
      CapacitorLink.getAudioRelayListeners().then((res: any) => res.listeners || []),
    endAudioRelay: () => CapacitorLink.endAudioRelay(),

    joinAudioRelayGuest: (host: string) => CapacitorLink.joinAudioRelayGuest({ host }),
    joinAudioRelayPaired: (host: string, token: string) => CapacitorLink.joinAudioRelayPaired({ host, token }),
    leaveAudioRelay: () => CapacitorLink.leaveAudioRelay(),
    queryAudioRelaySessions: () => CapacitorLink.queryAudioRelaySessions(),
    // Mobile plays natively (AudioTrack) — no Web Audio GainNode to reach from JS, so volume goes
    // through this dedicated native call instead. See LinkAudioRelayClient.setVolume()'s comment.
    setAudioRelayListenerVolume: (volume: number) => CapacitorLink.setAudioRelayListenerVolume({ volume }),

    onAudioRelayGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string) => void) => {
      subscribe('audioRelayGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress));
    },
    onAudioRelayListenerJoined: (cb: (id: string, label: string) => void) => {
      subscribe('audioRelayListenerJoined', (data: any) => cb(data.connId, data.label));
    },
    onAudioRelayListenerLeft: (cb: (id: string) => void) => {
      subscribe('audioRelayListenerLeft', (data: any) => cb(data.connId));
    },
    onAudioRelayPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) => {
      subscribe('audioRelayPairedSessionStarted', (data: any) => cb(data.deviceId, data.token, data.host));
    },
    onAudioRelayPairedSessionEnded: (cb: (deviceId: string) => void) => {
      subscribe('audioRelayPairedSessionEnded', (data: any) => cb(data.deviceId));
    },
    onAudioRelayPinComputed: (cb: (pin: string) => void) => {
      subscribe('audioRelayPinComputed', (data: any) => cb(data.pin));
    },
    onAudioRelayAdmitted: (cb: () => void) => {
      subscribe('audioRelayAdmitted', () => cb());
    },
    onAudioRelayFormat: (cb: (format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean }) => void) => {
      subscribe('audioRelayFormat', (data: any) => cb(data));
    },
    onAudioRelayAudioChunk: (cb: (pcm: Uint8Array) => void) => {
      subscribe('audioRelayAudioChunk', (data: any) => cb(data.pcm));
    },
    onAudioRelayHostMuted: (cb: (muted: boolean) => void) => {
      subscribe('audioRelayHostMuted', (data: any) => cb(data.muted));
    },
    onAudioRelayEnded: (cb: () => void) => {
      subscribe('audioRelayEnded', () => cb());
    },
    onAudioRelayClosed: (cb: (reason: string) => void) => {
      subscribe('audioRelayClosed', (data: any) => cb(data.reason));
    },
    onAudioRelayError: (cb: (message: string) => void) => {
      subscribe('audioRelayError', (data: any) => cb(data.message));
    },

    // --- Remote Mic ---
    startRemoteMic: () => CapacitorLink.startRemoteMic(),
    getRemoteMicListeners: () =>
      CapacitorLink.getRemoteMicListeners().then((res: any) => res.listeners || []),
    endRemoteMic: () => CapacitorLink.endRemoteMic(),

    joinRemoteMicPaired: (host: string, token: string) => CapacitorLink.joinRemoteMicPaired({ host, token }),
    leaveRemoteMic: () => CapacitorLink.leaveRemoteMic(),
    queryRemoteMicSessions: () => CapacitorLink.queryRemoteMicSessions(),

    onRemoteMicGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string) => void) => {
      subscribe('remoteMicGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress));
    },
    onRemoteMicListenerJoined: (cb: (id: string, label: string) => void) => {
      subscribe('remoteMicListenerJoined', (data: any) => cb(data.connId, data.label));
    },
    onRemoteMicListenerLeft: (cb: (id: string) => void) => {
      subscribe('remoteMicListenerLeft', (data: any) => cb(data.connId));
    },
    onRemoteMicPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) => {
      subscribe('remoteMicPairedSessionStarted', (data: any) => cb(data.deviceId, data.token, data.host));
    },
    onRemoteMicPairedSessionEnded: (cb: (deviceId: string) => void) => {
      subscribe('remoteMicPairedSessionEnded', (data: any) => cb(data.deviceId));
    },
    onRemoteMicPinComputed: (cb: (pin: string) => void) => {
      subscribe('remoteMicPinComputed', (data: any) => cb(data.pin));
    },
    onRemoteMicAdmitted: (cb: () => void) => {
      subscribe('remoteMicAdmitted', () => cb());
    },
    onRemoteMicFormat: (cb: (format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean }) => void) => {
      subscribe('remoteMicFormat', (data: any) => cb(data));
    },
    onRemoteMicAudioChunk: (cb: (pcm: Uint8Array) => void) => {
      subscribe('remoteMicAudioChunk', (data: any) => cb(data.pcm));
    },
    onRemoteMicEnded: (cb: () => void) => {
      subscribe('remoteMicEnded', () => cb());
    },
    onRemoteMicClosed: (cb: (reason: string) => void) => {
      subscribe('remoteMicClosed', (data: any) => cb(data.reason));
    },
    onRemoteMicError: (cb: (message: string) => void) => {
      subscribe('remoteMicError', (data: any) => cb(data.message));
    },
  };
}
export {};
