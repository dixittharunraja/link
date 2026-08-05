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
    getDiscoveredDevices: () => CapacitorLink.getDiscoveredDevices().then((res: any) => res.devices || []),
    onDeviceDiscovered: (cb: (info: any) => void) => {
      subscribe('deviceDiscovered', cb);
    },
    onDeviceExpired: (cb: (deviceId: string) => void) => {
      subscribe('deviceExpired', (data: any) => cb(data.deviceId));
    },
    connectTo: (host: string) => {
      const [ip, portStr] = host.split(':');
      const port = portStr ? parseInt(portStr, 10) : undefined;
      return CapacitorLink.connectTo({ host: ip, port });
    },

    // Pairing
    requestPairing: (deviceId: string) => 
      CapacitorLink.requestPairing({ deviceId }).then((res: any) => res.verificationKey),
    requestPairingByIp: (ip: string) =>
      CapacitorLink.requestPairingByIp({ ip }).then((res: any) => res.pin ? { pin: res.pin, deviceId: res.deviceId } : null),
    acceptPairing: (deviceId: string) => CapacitorLink.acceptPairing({ deviceId }),
    cancelPairing: (deviceId: string) => CapacitorLink.cancelPairing({ deviceId }),
    rejectPairing: (deviceId: string, shouldBlock?: boolean, deviceName?: string, deviceType?: string) =>
      CapacitorLink.rejectPairing({ deviceId, shouldBlock, deviceName, deviceType }),
    unpair: (deviceId: string) => CapacitorLink.unpair({ deviceId }),
    exitPool: () => CapacitorLink.exitPool(),

    // Blocklist/Banlist — was entirely absent on Android (see LinkBlocklist.java).
    getBlocklist: () => CapacitorLink.getBlocklist().then((res: any) => res.entries || []),
    blockDevice: (id: string, label: string, type: 'device' | 'ip') =>
      CapacitorLink.blockDevice({ id, label, type }).then((res: any) => res.entries || []),
    unblockDevice: (id: string) => CapacitorLink.unblockDevice({ id }).then((res: any) => res.entries || []),

    // Device Actions
    sendFindMyDevice: (deviceId: string) => CapacitorLink.sendFindMyDevice ? CapacitorLink.sendFindMyDevice({ deviceId }) : CapacitorLink.sendFindMyPhone({ deviceId }),
    sendFindMyPhone: (deviceId: string) => CapacitorLink.sendFindMyPhone({ deviceId }),
    sendStopRinging: (deviceId: string) => CapacitorLink.stopFindMyDevice ? CapacitorLink.stopFindMyDevice({ deviceId }) : CapacitorLink.stopFindMyPhone({ deviceId }),
    stopRingingLocal: () => CapacitorLink.stopFindMyDevice ? CapacitorLink.stopFindMyDevice() : CapacitorLink.stopFindMyPhone(),
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
      CapacitorLink.sendMprisAction({ deviceId, player, action }),

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
    checkAccessibility: () => CapacitorLink.checkAccessibility(),
    requestAccessibility: () => CapacitorLink.requestAccessibility(),
    checkOverlayPermission: () => CapacitorLink.checkOverlayPermission(),
    requestOverlayPermission: () => CapacitorLink.requestOverlayPermission(),

    // Hardware back button fallback — see backNav.ts / App.tsx's 'linkHardwareBack' listener.
    // moveTaskToBack (not finish()) so it matches standard Android back-at-root behavior: send
    // to background, don't kill the process.
    minimizeApp: () => CapacitorLink.minimizeApp(),

    // Biometric Unlock (Settings tab, mobile-only)
    checkBiometricAvailable: () => CapacitorLink.checkBiometricAvailable(),
    authenticateBiometric: () => CapacitorLink.authenticateBiometric(),

    // Input Relays
    sendRemoteInput: (deviceId: string, text?: string, specialKey?: string) =>
      CapacitorLink.sendRemoteInput({ deviceId, text, specialKey }),
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
    // Joystick — deliberately IP-identified, not deviceId-identified: no pairing, no permission
    // toggle, exactly like joining an Audio Sink guest session. `host` is whatever the user typed
    // or scanned (ModalDialog), not a paired deviceId. See joystick.ts's header comment.
    sendJoystickHello: (host: string, name: string) => CapacitorLink.sendJoystickHello({ host, name }),
    sendJoystickBye: (host: string) => CapacitorLink.sendJoystickBye({ host }),
    // High-frequency (~60Hz) — raw UDP:1717, same channel/cadence as sendMouseMove above.
    sendJoystickState: (host: string, lx: number, ly: number, rx: number, ry: number, lt: number, rt: number, buttons: number) =>
      CapacitorLink.sendJoystickState({ host, lx, ly, rx, ry, lt, rt, buttons }),
    onJoystickHelloAck: (cb: (ok: boolean, padIndex: number | null, error: string | null) => void) => {
      subscribe('joystickHelloAck', (data: any) => cb(!!data.ok, data.padIndex ?? null, data.error || null));
    },
    onJoystickPinRequired: (cb: (pin: string) => void) => {
      subscribe('joystickPinRequired', (data: any) => cb(data.pin));
    },
    // Heartbeat + forced-disconnect — see joystick.ts's header comment. JoystickOverlay.tsx uses
    // both to auto-close itself instead of continuing to show a dead session.
    onJoystickPing: (cb: () => void) => {
      subscribe('joystickPing', () => cb());
    },
    onJoystickForcedDisconnect: (cb: (reason: string) => void) => {
      subscribe('joystickForcedDisconnect', (data: any) => cb(data.reason || 'disconnected'));
    },
    vibrate: (amplitude: number, durationMs: number) => CapacitorLink.vibrate({ amplitude, durationMs }),

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
    onIncomingPairRequest: (cb: (deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null) => void) => {
      subscribe('incomingPairRequest', (data: any) => cb(data.deviceId, data.deviceName, data.deviceType, data.verificationKey));
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
    onFindMyDeviceTriggered: (cb: (deviceId: string) => void) => {
      subscribe('findMyDeviceTriggered', (data: any) => cb(data.deviceId));
      subscribe('findMyPhoneTriggered', (data: any) => cb(data.deviceId));
    },
    onFindMyDeviceStopped: (cb: (deviceId: string) => void) => {
      subscribe('findMyDeviceStopped', (data: any) => cb(data.deviceId));
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
    onNotificationBroadcastReceived: (cb: (sourceDeviceId: string, body: any) => void) => {
      subscribe('notificationBroadcastReceived', (data: any) => cb(data.sourceDeviceId, data));
    },
    onSystemVolumeReceived: (cb: (deviceId: string, body: any) => void) => {
      subscribe('systemVolumeReceived', (data: any) => cb(data.deviceId, { sinkList: data.sinks }));
    },
    onFlashlightStateReceived: (cb: (deviceId: string, enabled: boolean, revoked?: boolean) => void) => {
      subscribe('flashlightStateReceived', (data: any) => cb(data.deviceId, data.enabled, data.revoked));
    },
    onDndStateReceived: (cb: (deviceId: string, enabled: boolean, granted: boolean, revoked?: boolean) => void) => {
      subscribe('dndStateReceived', (data: any) => cb(data.deviceId, data.enabled, data.granted, data.revoked));
    },
    // Mobile-to-mobile presenter: this device is being controlled by a peer, driving the
    // in-app pointer-dot overlay (see PresenterDotOverlay.tsx).
    onPresenterPositionReceived: (cb: (deviceId: string, dx: number, dy: number, stop: boolean) => void) => {
      subscribe('presenterPositionReceived', (data: any) => cb(data.deviceId, data.dx || 0, data.dy || 0, !!data.stop));
    },
    onDigitizerSessionReceived: (cb: (deviceId: string, action: string, w: number, h: number) => void) => {
      subscribe('digitizerSessionReceived', (data: any) => cb(data.deviceId, data.action, data.width || 0, data.height || 0));
    },
    onDigitizerEventReceived: (cb: (deviceId: string, x: number, y: number, touching: boolean) => void) => {
      subscribe('digitizerEventReceived', (data: any) => cb(data.deviceId, data.x || 0, data.y || 0, !!data.touching));
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

    // --- Audio Sink ---
    // Android can host too (AudioPlaybackCaptureConfiguration + MediaProjection, API 29+ — see
    // LinkAudioCapture.java/LinkAudioSinkServer.java). startAudioSink() drives the RECORD_AUDIO
    // permission check and the MediaProjection consent dialog natively, so from here it's just a
    // single call that resolves once the user has responded (or been denied/it's unsupported).
    startAudioSink: () => CapacitorLink.startAudioSink(),
    setAudioSinkMuted: (muted: boolean) => CapacitorLink.setAudioSinkMuted({ muted }),
    kickAudioSinkListener: (connId: string) => CapacitorLink.kickAudioSinkListener({ connId }),
    blockAudioSinkListener: (connId: string) => CapacitorLink.blockAudioSinkListener({ connId }),
    getAudioSinkListeners: () =>
      CapacitorLink.getAudioSinkListeners().then((res: any) => res.listeners || []),
    // Was missing entirely — AudioSinkTab.tsx calls this on every mount to restore
    // "currently hosting"/"currently listening" state; without it the mobile UI always fell back
    // to the fresh idle screen even mid-session, since the call resolved to undefined and the
    // renderer had nothing to read status from.
    getAudioSinkStatus: () => CapacitorLink.getAudioSinkStatus(),
    endAudioSink: () => CapacitorLink.endAudioSink(),

    joinAudioSinkGuest: (host: string) => CapacitorLink.joinAudioSinkGuest({ host }),
    joinAudioSinkPaired: (host: string, token: string) => CapacitorLink.joinAudioSinkPaired({ host, token }),
    acceptAudioSinkGuest: (connId: string) => CapacitorLink.acceptAudioSinkGuest({ connId }),
    rejectAudioSinkGuest: (connId: string) => CapacitorLink.rejectAudioSinkGuest({ connId }),
    blockAudioSinkGuest: (connId: string) => CapacitorLink.blockAudioSinkGuest({ connId }),
    leaveAudioSink: () => CapacitorLink.leaveAudioSink(),
    queryAudioSinkSessions: () => CapacitorLink.queryAudioSinkSessions(),
    // Mobile plays natively (AudioTrack) — no Web Audio GainNode to reach from JS, so volume goes
    // through this dedicated native call instead. See LinkAudioSinkClient.setVolume()'s comment.
    setAudioSinkListenerVolume: (volume: number) => CapacitorLink.setAudioSinkListenerVolume({ volume }),

    onAudioSinkListenerJoined: (cb: (id: string, label: string) => void) => {
      subscribe('audioSinkListenerJoined', (data: any) => cb(data.connId, data.label));
    },
    onAudioSinkListenerLeft: (cb: (id: string) => void) => {
      subscribe('audioSinkListenerLeft', (data: any) => cb(data.connId));
    },
    onAudioSinkGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => {
      subscribe('audioSinkGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.deviceName));
    },
    onAudioSinkPairedSessionStarted: (cb: (deviceId: string, token: string, host: string) => void) => {
      subscribe('audioSinkPairedSessionStarted', (data: any) => cb(data.deviceId, data.token, data.host));
    },
    onAudioSinkPairedSessionEnded: (cb: (deviceId: string) => void) => {
      subscribe('audioSinkPairedSessionEnded', (data: any) => cb(data.deviceId));
    },
    onAudioSinkAdmitted: (cb: (hostName: string) => void) => {
      subscribe('audioSinkAdmitted', (data: any) => cb(data?.hostName || ''));
    },
    onAudioSinkFormat: (cb: (format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean }) => void) => {
      subscribe('audioSinkFormat', (data: any) => cb(data));
    },
    onAudioSinkAudioChunk: (cb: (pcm: Uint8Array) => void) => {
      subscribe('audioSinkAudioChunk', (data: any) => cb(data.pcm));
    },
    onAudioSinkHostMuted: (cb: (muted: boolean) => void) => {
      subscribe('audioSinkHostMuted', (data: any) => cb(data.muted));
    },
    onAudioSinkEnded: (cb: () => void) => {
      subscribe('audioSinkEnded', () => cb());
    },
    onAudioSinkClosed: (cb: (reason: string) => void) => {
      subscribe('audioSinkClosed', (data: any) => cb(data.reason));
    },
    onAudioSinkError: (cb: (message: string) => void) => {
      subscribe('audioSinkError', (data: any) => cb(data.message));
    },
    onAudioSinkPinComputed: (cb: (pin: string) => void) => {
      subscribe('audioSinkPinComputed', (data: any) => cb(data.pin));
    },

    // --- Remote Mic ---
    startRemoteMic: () => CapacitorLink.startRemoteMic(),
    // Was missing entirely — RemoteMicTab.tsx's Mute Mic button called this optional-chained, so
    // it silently no-op'd on Android even though LinkRemoteMicServer.setMuted() already worked.
    setRemoteMicMuted: (muted: boolean) => CapacitorLink.setRemoteMicMuted({ muted }),
    kickRemoteMicListener: (connId: string) => CapacitorLink.kickRemoteMicListener({ connId }),
    blockRemoteMicListener: (connId: string) => CapacitorLink.blockRemoteMicListener({ connId }),
    // Was missing entirely — RemoteMicTab.tsx's pending-guest Accept/Reject/Block buttons called
    // these optional-chained, so on Android they silently no-op'd even though LinkRemoteMicServer's
    // acceptGuest()/rejectGuest() (via LinkPlugin's acceptRemoteMicGuest/rejectRemoteMicGuest/
    // blockRemoteMicGuest @PluginMethods) already worked correctly.
    acceptRemoteMicGuest: (connId: string) => CapacitorLink.acceptRemoteMicGuest({ connId }),
    rejectRemoteMicGuest: (connId: string) => CapacitorLink.rejectRemoteMicGuest({ connId }),
    blockRemoteMicGuest: (connId: string) => CapacitorLink.blockRemoteMicGuest({ connId }),
    getRemoteMicListeners: () =>
      CapacitorLink.getRemoteMicListeners().then((res: any) => res.listeners || []),
    // Was missing entirely — RemoteMicTab.tsx calls this on every mount to restore "currently
    // hosting" state; without it the mobile UI always fell back to the fresh idle screen even
    // mid-session, since the call resolved to undefined and the renderer had nothing to read
    // status from.
    getRemoteMicStatus: () => CapacitorLink.getRemoteMicStatus(),
    endRemoteMic: () => CapacitorLink.endRemoteMic(),

    // Mobile-host / PC-listen only, by design (see RemoteMicTab.tsx's isMobile gate on the
    // "Receive Remote Microphone" card) — a phone can't do anything with a received mic stream
    // except play it back, and it was never actually wired end-to-end on Android (no native
    // join/leave methods, no listening client), so the join/leave/listener-side event wiring that
    // used to sit here was dead code, not a working feature.
    onRemoteMicGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => {
      subscribe('remoteMicGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.deviceName));
    },
    onRemoteMicListenerJoined: (cb: (id: string, label: string) => void) => {
      subscribe('remoteMicListenerJoined', (data: any) => cb(data.connId, data.label));
    },
    onRemoteMicListenerLeft: (cb: (id: string) => void) => {
      subscribe('remoteMicListenerLeft', (data: any) => cb(data.connId));
    },
    onRemoteMicError: (cb: (message: string) => void) => {
      subscribe('remoteMicError', (data: any) => cb(data.message));
    },

    // --- Walkie Talkie (real-time multi-party voice, WebRTC full mesh) ---
    // Pure signaling relay, identical in shape to preload.ts's — session membership + SDP/ICE
    // logic all lives in WalkieTalkieTab.tsx. getUserMedia/RTCPeerConnection work in the Android
    // WebView the same as they do in Chromium; Capacitor's own BridgeWebChromeClient already
    // grants RECORD_AUDIO for getUserMedia (see onPermissionRequest), so no native audio code is
    // needed here at all.
    sendWalkieTalkieSignal: (deviceId: string, type: string, body: any) =>
      CapacitorLink.sendWalkieTalkieSignal({ deviceId, type, body: JSON.stringify(body || {}) }),
    broadcastWalkieTalkieSignal: (type: string, body: any) =>
      CapacitorLink.broadcastWalkieTalkieSignal({ type, body: JSON.stringify(body || {}) }),
    onWalkieTalkieSignal: (cb: (deviceId: string, type: string, body: any) => void) => {
      subscribe('walkieTalkieSignal', (data: any) => {
        let body = {};
        try { body = JSON.parse(data.body || '{}'); } catch {}
        cb(data.deviceId, data.type, body);
      });
    },

    // --- Guest-facing (an unpaired participant reaches us via manual IP + PIN instead) ---
    startWalkieTalkieGuestListener: () => CapacitorLink.startWalkieTalkieGuestListener(),
    stopWalkieTalkieGuestListener: () => CapacitorLink.stopWalkieTalkieGuestListener(),
    acceptWalkieTalkieGuest: (connId: string) => CapacitorLink.acceptWalkieTalkieGuest({ connId }),
    rejectWalkieTalkieGuest: (connId: string) => CapacitorLink.rejectWalkieTalkieGuest({ connId }),
    kickWalkieTalkieGuest: (connId: string) => CapacitorLink.kickWalkieTalkieGuest({ connId }),
    blockWalkieTalkieGuest: (connId: string) => CapacitorLink.blockWalkieTalkieGuest({ connId }),
    blockWalkieTalkieMember: (deviceId: string, label: string) => CapacitorLink.blockWalkieTalkieMember({ deviceId, label }),
    sendWalkieTalkieGuestSignal: (connId: string, type: string, body: any) =>
      CapacitorLink.sendWalkieTalkieGuestSignal({ connId, type, body: JSON.stringify(body || {}) }),
    onWalkieTalkieGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => {
      subscribe('walkieTalkieGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.deviceName));
    },
    onWalkieTalkieGuestSignal: (cb: (connId: string, type: string, body: any) => void) => {
      subscribe('walkieTalkieGuestSignal', (data: any) => {
        let body = {};
        try { body = JSON.parse(data.body || '{}'); } catch {}
        cb(data.connId, data.type, body);
      });
    },
    onWalkieTalkieGuestLeft: (cb: (connId: string) => void) => {
      subscribe('walkieTalkieGuestLeft', (data: any) => cb(data.connId));
    },

    // --- Guest-side (us joining someone else's session via manual IP, unpaired) ---
    joinWalkieTalkieGuest: (host: string) => CapacitorLink.joinWalkieTalkieGuest({ host }),
    leaveWalkieTalkieGuest: () => CapacitorLink.leaveWalkieTalkieGuest(),
    sendWalkieTalkieGuestMessage: (type: string, body: any) =>
      CapacitorLink.sendWalkieTalkieGuestMessage({ type, body: JSON.stringify(body || {}) }),
    onWalkieTalkieGuestPinComputed: (cb: (pin: string) => void) => {
      subscribe('walkieTalkieGuestPinComputed', (data: any) => cb(data.pin));
    },
    onWalkieTalkieHostSignal: (cb: (type: string, body: any) => void) => {
      subscribe('walkieTalkieHostSignal', (data: any) => {
        let body = {};
        try { body = JSON.parse(data.body || '{}'); } catch {}
        cb(data.type, body);
      });
    },
    onWalkieTalkieHostEnded: (cb: (reason?: string) => void) => {
      subscribe('walkieTalkieHostEnded', (data: any) => cb(data?.reason));
    },
    onWalkieTalkieHostClosed: (cb: (reason: string) => void) => {
      subscribe('walkieTalkieHostClosed', (data: any) => cb(data.reason));
    },
    onWalkieTalkieHostError: (cb: (message: string) => void) => {
      subscribe('walkieTalkieHostError', (data: any) => cb(data.message));
    },

    // --- Portal Mode (one-time file transfer to an untrusted/unpaired device) ---
    // Android has no direct filesystem-path picker (no Electron dialog.showOpenDialog
    // equivalent) — pickPortalFiles() launches ACTION_OPEN_DOCUMENT (EXTRA_ALLOW_MULTIPLE) and
    // resolves an array of content:// Uri strings instead of real paths. PortalTab.tsx treats each
    // entry as an opaque string either way (stores them, then hands them straight back to
    // joinPortalGuest), so this difference is fully hidden behind this bridge. No save-directory
    // picker on Android — incoming files always land in the public Downloads/Link folder (see
    // LinkPortalTransferServer.java), so holdPortalGuest/pickPortalSaveDir are desktop-only;
    // PortalTab.tsx never calls them when isMobile.
    pickPortalFiles: () => CapacitorLink.pickPortalFiles().then((res: any) => res?.uris || []),
    startPortalReceive: () => CapacitorLink.startPortalReceive(),
    acceptPortalGuest: (connId: string) => CapacitorLink.acceptPortalGuest({ connId }),
    rejectPortalGuest: (connId: string) => CapacitorLink.rejectPortalGuest({ connId }),
    blockPortalGuest: (connId: string) => CapacitorLink.blockPortalGuest({ connId }),
    endPortalReceive: () => CapacitorLink.endPortalReceive(),
    joinPortalGuest: (host: string, filePaths: string[]) => CapacitorLink.joinPortalGuest({ host, uris: filePaths }),
    leavePortalSend: () => CapacitorLink.leavePortalSend(),
    getPortalStatus: () => CapacitorLink.getPortalStatus(),

    onPortalGuestPinPending: (cb: (connId: string, pin: string, remoteAddress: string, deviceName?: string) => void) => {
      subscribe('portalGuestPinPending', (data: any) => cb(data.connId, data.pin, data.remoteAddress, data.deviceName));
    },
    onPortalConnectionAdmitted: (cb: (connId: string, deviceName: string) => void) => {
      subscribe('portalConnectionAdmitted', (data: any) => cb(data.connId, data.deviceName));
    },
    onPortalConnectionClosed: (cb: (connId: string) => void) => {
      subscribe('portalConnectionClosed', (data: any) => cb(data.connId));
    },
    onPortalFileStarted: (cb: (fileIndex: number, fileCount: number, name: string) => void) => {
      subscribe('portalFileStarted', (data: any) => cb(data.fileIndex, data.fileCount, data.name));
    },
    onPortalTransferStarted: (cb: (connId: string, name: string, size: number) => void) => {
      subscribe('portalTransferStarted', (data: any) => cb(data.connId, data.name, data.size));
    },
    onPortalTransferProgress: (cb: (connId: string, received: number, size: number) => void) => {
      subscribe('portalTransferProgress', (data: any) => cb(data.connId, data.received, data.size));
    },
    onPortalTransferComplete: (cb: (connId: string, destPath: string) => void) => {
      subscribe('portalTransferComplete', (data: any) => cb(data.connId, data.destPath));
    },
    onPortalPinComputed: (cb: (pin: string) => void) => {
      subscribe('portalPinComputed', (data: any) => cb(data.pin));
    },
    onPortalAdmitted: (cb: (receiverDeviceName?: string) => void) => {
      subscribe('portalAdmitted', (data: any) => cb(data?.deviceName));
    },
    onPortalSendProgress: (cb: (sent: number, total: number) => void) => {
      subscribe('portalSendProgress', (data: any) => cb(data.sent, data.total));
    },
    onPortalSendComplete: (cb: () => void) => {
      subscribe('portalSendComplete', () => cb());
    },
    onPortalEnded: (cb: () => void) => {
      subscribe('portalEnded', () => cb());
    },
    onPortalClosed: (cb: (reason: string) => void) => {
      subscribe('portalClosed', (data: any) => cb(data.reason));
    },
    onPortalError: (cb: (message: string) => void) => {
      subscribe('portalError', (data: any) => cb(data.message));
    },
    onAppResumed: (cb: () => void) => {
      subscribe('appResumed', () => cb());
    },
    getDeviceMountConfig: (deviceId: string) => Promise.resolve({ preferredDriveLetter: '', occupiedLetters: [] as string[], letters: [] as string[] }),
    setDeviceMountLetter: (deviceId: string, driveLetter: string) => Promise.resolve({ success: false }),
    onDeviceMountChanged: (cb: (deviceId: string, driveLetter?: string) => void) => {},

    // ===== Built-in File Explorer Client APIs =====
    fsListRoots: (deviceId: string) =>
      CapacitorLink.fsListRoots({ deviceId }).then((res: any) => res.result || []),
    fsReaddir: (deviceId: string, path: string) =>
      CapacitorLink.fsReaddir({ deviceId, path }).then((res: any) => res.result || []),
    fsStat: (deviceId: string, path: string) =>
      CapacitorLink.fsStat({ deviceId, path }).then((res: any) => res.result || {}),
    fsRead: (deviceId: string, path: string, offset: number, length: number) =>
      Promise.resolve(''), // not used directly by UI
    fsCreateDirectory: (deviceId: string, path: string) =>
      CapacitorLink.fsCreateDirectory({ deviceId, path }).then((res: any) => !!res.result),
    fsDelete: (deviceId: string, path: string) =>
      CapacitorLink.fsDelete({ deviceId, path }).then((res: any) => !!res.result),
    fsRename: (deviceId: string, path: string, newPath: string) =>
      CapacitorLink.fsRename({ deviceId, path, newPath }).then((res: any) => !!res.result),
    fsDownloadFile: (deviceId: string, remotePath: string, localPath: string) =>
      Promise.resolve(false), // handled on mobile differently
    fsPickSavePath: (defaultName: string) => Promise.resolve(null as string | null),
    fsMountDevice: (deviceId: string) => Promise.resolve(true),
    fsUnmountDevice: (deviceId: string) => Promise.resolve(true),
    fsUploadItem: (deviceId: string, localPath: string, remoteParentPath: string) => Promise.resolve(false),
    fsPickUploadItems: (mode: 'file' | 'directory') => Promise.resolve([] as string[]),
    expandDroppedPaths: (filePaths: string[]) => Promise.resolve([] as any[]),
    getPathForFile: (file: File) => '',
    fsGetStreamUrl: (deviceId: string, remotePath: string) => Promise.resolve(''),
  };
}
export {};
