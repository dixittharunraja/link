import React, { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ConnectionsTab from './components/ConnectionsTab';
import NotificationsTab from './components/NotificationsTab';
import CommandsTab from './components/CommandsTab';
import ToolsTab from './components/ToolsTab';
import SettingsTab from './components/SettingsTab';
import OnboardingWizard from './components/OnboardingWizard';
import PresenterOverlay from './components/PresenterOverlay';
import RemoteInputOverlay from './components/RemoteInputOverlay';
import DigitizerOverlay from './components/DigitizerOverlay';
import { pushBackHandler, handleHardwareBack } from './backNav';

// linkApi global reference
const linkApi = (window as any).link;

interface PeerDevice {
  deviceId: string;
  name: string;
  deviceType?: string;
  incomingCapabilities?: string[];
  outgoingCapabilities?: string[];
  trusted: boolean;
  connected?: boolean;
  isLocked?: boolean;
  isRinging?: boolean;
  connectivity?: Record<string, { networkType: string; signalStrength: number }>;
  battery?: { isCharging: boolean; currentCharge: number };
  flashlight?: boolean;
  dnd?: { enabled: boolean; granted: boolean };
  allowedCapabilities?: string[];
}

interface VolumeSink {
  name: string;
  description: string;
  volume: number;
  muted: boolean;
  maxVolume?: number;
}

interface MprisState {
  title?: string;
  artist?: string;
  player?: string;
  isPlaying?: boolean;
}

interface NotificationItem {
  key: string;
  deviceId: string;
  body: {
    id: string;
    appName: string;
    title?: string;
    text?: string;
    ticker?: string;
    requestReplyId?: string;
  };
}

interface CommandEntry {
  name: string;
  command: string;
}

const titleMap: Record<string, string> = {
  'devices': 'Connections',
  'notifications': 'Notifications',
  'commands': 'Shell Commands',
  'tools': 'Tools',
  'settings': 'Settings'
};

const App: React.FC = () => {
  // Tab and Theme State — always opens on Devices; restoring the last-used tab across launches
  // meant leaving the app on, say, Tools would silently reopen straight into Tools next time.
  const [activeTab, setActiveTab] = useState<string>('devices');
  const [theme, setTheme] = useState<string>(() => {
    return localStorage.getItem('link-theme') || 'dark';
  });

  // Device & Identity State
  const [localIdentity, setLocalIdentity] = useState<{ deviceId: string; deviceName: string; ipAddress?: string; deviceType?: string }>({
    deviceId: '',
    deviceName: 'Loading...',
  });
  const [visibilityEnabled, setVisibilityEnabled] = useState<boolean>(true);
  const [screensaverInhibitEnabled, setScreensaverInhibitEnabled] = useState<boolean>(true);
  const [openAtLogin, setOpenAtLogin] = useState<boolean>(false);
  const [closeToTray, setCloseToTray] = useState<boolean>(true);

  // Peer & Volume States
  const [peers, setPeers] = useState<Map<string, PeerDevice>>(new Map());
  const [volumeSinks, setVolumeSinks] = useState<Map<string, VolumeSink[]>>(new Map());

  // MPRIS and Notification States
  const [mprisState, setMprisState] = useState<MprisState | null>(null);
  const [activeMprisDeviceId, setActiveMprisDeviceId] = useState<string | null>(null);
  const [activeMprisPlayer, setActiveMprisPlayer] = useState<string>('');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  // Pull down refresh states
  const [pullDistance, setPullDistance] = useState<number>(0);
  const [isPulling, setIsPulling] = useState<boolean>(false);

  // Device permissions state
  const [devicePermissions, setDevicePermissions] = useState<Record<string, Record<string, boolean | string>>>({});

  // Commands Whitelist State
  const [commands, setCommands] = useState<Record<string, CommandEntry>>({});
  // Whitelists RECEIVED FROM peers (mesh case: any device viewing a paired desktop's real
  // whitelist) — distinct from `commands` above, which is THIS device's own whitelist.
  const [peerCommandLists, setPeerCommandLists] = useState<Map<string, Record<string, CommandEntry>>>(new Map());

  const [isRingingLocal, setIsRingingLocal] = useState<boolean>(false);
  const [activeSpeedTestDeviceId, setActiveSpeedTestDeviceId] = useState<string | null>(null);

  // Remote Input Overlays (Mobile Only)
  const [activeRemoteControlMode, setActiveRemoteControlMode] = useState<'presenter' | 'touchpad' | 'digitizer' | null>(null);
  const [activeRemoteControlDeviceId, setActiveRemoteControlDeviceId] = useState<string | null>(null);
  const [mobilePermissions, setMobilePermissions] = useState<Record<string, string>>({
    phoneState: 'denied',
    contacts: 'denied',
    notifications: 'denied',
    notificationsSend: 'denied',
    allFiles: 'denied',
    dnd: 'denied',
    deviceAdmin: 'denied',
    batteryOpt: 'denied',
  });

  // General App logs & Onboarding flags
  const [logs, setLogs] = useState<string[]>([]);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    return !localStorage.getItem('onboarding-completed');
  });

  const [activePairRequest, setActivePairRequest] = useState<{ deviceId: string; verificationKey: string | null } | null>(null);

  // App Lock State (PIN Lock)
  const [appPinLockEnabled, setAppPinLockEnabled] = useState<boolean>(() => {
    return localStorage.getItem('app-pin-lock-enabled') === 'true';
  });
  const [appPinCode, setAppPinCode] = useState<string>(() => {
    return localStorage.getItem('app-pin-code') || '1234';
  });
  const [appIsLocked, setAppIsLocked] = useState<boolean>(() => {
    return localStorage.getItem('app-pin-lock-enabled') === 'true';
  });
  // Biometric Unlock — mobile-only (SettingsTab already gates its toggle behind isMobile).
  // Persisted the same way as the PIN lock flag above (plain localStorage, not a native/IPC
  // round-trip — it works identically in the Android WebView, no extra plumbing needed).
  const [biometricEnabled, setBiometricEnabled] = useState<boolean>(() => {
    return localStorage.getItem('app-biometric-enabled') === 'true';
  });
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  // Helper log function
  const addLog = (msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const updatePermissionsUI = async () => {
    if (!linkApi || !linkApi.isMobile) return;
    try {
      const perms = await linkApi.checkPermissions();
      const notifStatus = await linkApi.checkNotificationAccess();
      const allFilesStatus = await linkApi.checkAllFilesAccess();
      const dndStatus = await linkApi.checkDndPermission();
      const adminStatus = await linkApi.checkDeviceAdmin();
      const batteryStatus = await linkApi.isBatteryOptimizationIgnored();

      setMobilePermissions({
        phoneState: perms.phoneState,
        contacts: perms.contacts,
        notifications: notifStatus.enabled ? 'granted' : 'denied',
        notificationsSend: perms.notifications,
        allFiles: allFilesStatus.enabled ? 'granted' : 'denied',
        dnd: dndStatus.granted ? 'granted' : 'denied',
        deviceAdmin: adminStatus.active ? 'granted' : 'denied',
        batteryOpt: batteryStatus.isIgnoring ? 'granted' : 'denied',
      });
    } catch (e: any) {
      addLog('Failed to check permissions: ' + e.message);
    }
  };

  const handleRequestMobilePermission = async (key: string) => {
    if (!linkApi || !linkApi.isMobile) return;
    try {
      if (key === 'phoneState' || key === 'contacts' || key === 'notificationsSend') {
        // Android never re-shows the grant dialog for an already-granted normal permission — it's
        // a silent no-op — and the only place to revoke one of these is the app's own Settings
        // page. Previously this always called requestMobilePermission, so tapping the toggle to
        // revoke an already-granted permission did nothing visible at all.
        if (mobilePermissions[key] === 'granted') {
          await linkApi.openAppSettings();
        } else {
          const targetPerm = key === 'notificationsSend' ? 'notifications' : key;
          await linkApi.requestMobilePermission(targetPerm);
        }
      } else if (key === 'notifications') {
        await linkApi.requestNotificationAccess();
      } else if (key === 'allFiles') {
        await linkApi.requestAllFilesAccess();
      } else if (key === 'dnd') {
        await linkApi.requestDndPermission();
      } else if (key === 'deviceAdmin') {
        await linkApi.requestDeviceAdmin();
      } else if (key === 'batteryOpt') {
        await linkApi.requestIgnoreBatteryOptimizations();
      }
      updatePermissionsUI();
    } catch (err: any) {
      addLog(`Permission request failed for ${key}: ${err.message}`);
    }
  };

  const handleSetActiveTab = (tab: string) => {
    setActiveTab(tab);
  };

  // Hardware back button (Android): MainActivity forwards a real onBackPressed() into a
  // 'linkHardwareBack' DOM event instead of exiting/backgrounding the app itself, so any level of
  // in-app navigation gets first refusal. Root-level fallback here returns to the Devices tab;
  // if we're already there, handleHardwareBack() returns false and we ask native to minimize
  // instead of leaving the button doing nothing.
  useEffect(() => {
    if (typeof (window as any).Capacitor === 'undefined') return;
    return pushBackHandler(() => {
      if (activeTab !== 'devices') {
        handleSetActiveTab('devices');
        return true;
      }
      return false;
    });
  }, [activeTab]);

  useEffect(() => {
    if (typeof (window as any).Capacitor === 'undefined') return;
    const onHardwareBack = () => {
      if (!handleHardwareBack()) linkApi?.minimizeApp?.();
    };
    window.addEventListener('linkHardwareBack', onHardwareBack);
    return () => window.removeEventListener('linkHardwareBack', onHardwareBack);
  }, []);

  // Sync theme changes
  const applyTheme = (t: string) => {
    if (t === 'system') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
  };

  const handleThemeToggle = (newTheme: string) => {
    setTheme(newTheme);
    localStorage.setItem('link-theme', newTheme);
    applyTheme(newTheme);
  };

  // Auto-prompt biometric unlock the moment the lock screen appears, so the fingerprint/face
  // dialog shows immediately instead of making the user tap a button first every time — only
  // fires once per lock instance (guarded by attemptedRef) so a cancelled/failed prompt doesn't
  // reopen itself in a loop; the "Use Biometric" button below lets the user retry manually.
  const biometricAttemptedRef = useRef(false);
  useEffect(() => {
    if (!appIsLocked) {
      biometricAttemptedRef.current = false;
      return;
    }
    if (!biometricEnabled || !biometricAvailable || !linkApi?.isMobile) return;
    if (biometricAttemptedRef.current) return;
    biometricAttemptedRef.current = true;
    Promise.resolve(linkApi.authenticateBiometric?.())
      .then((result: any) => {
        if (result?.success) setAppIsLocked(false);
      })
      .catch(() => {});
  }, [appIsLocked, biometricEnabled, biometricAvailable]);

  // On mount actions
  useEffect(() => {
    // Initial theme set
    applyTheme(theme);

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => {
      if (localStorage.getItem('link-theme') === 'system') {
        applyTheme('system');
      }
    };
    
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleSystemThemeChange);
    } else {
      mediaQuery.addListener(handleSystemThemeChange);
    }

    if (!linkApi) {
      addLog('Error: linkApi is not available in window context.');
      return;
    }

    if (linkApi.isMobile) {
      updatePermissionsUI();
      window.addEventListener('focus', updatePermissionsUI);
    }

    // 1. Fetch Identity
    linkApi.getIdentity()
      .then((id: any) => {
        setLocalIdentity(id);
        addLog(`Identity loaded: ${id.deviceName}`);
      })
      .catch((err: any) => addLog(`Failed to load identity: ${err.message}`));

    // 2. Fetch Visibility
    linkApi.getVisibility()
      .then((enabled: boolean) => setVisibilityEnabled(enabled))
      .catch((err: any) => addLog(`Failed to fetch visibility: ${err.message}`));

    linkApi.getScreensaverInhibitEnabled()
      .then((enabled: boolean) => setScreensaverInhibitEnabled(enabled))
      .catch(() => {});
    linkApi.getOpenAtLogin()
      .then((enabled: boolean) => setOpenAtLogin(enabled))
      .catch(() => {});
    linkApi.getCloseToTray?.()
      .then((enabled: boolean) => setCloseToTray(enabled))
      .catch(() => {});
    linkApi.getPinLockEnabled?.()
      .then((enabled: boolean) => {
        setAppPinLockEnabled(enabled);
        localStorage.setItem('app-pin-lock-enabled', String(enabled));
        if (enabled) {
          setAppIsLocked(true);
        }
      })
      .catch(() => {});
    linkApi.getPinCode?.()
      .then((pin: string) => {
        setAppPinCode(pin);
        localStorage.setItem('app-pin-code', pin);
      })
      .catch(() => {});

    if (linkApi.isMobile) {
      Promise.resolve(linkApi.checkBiometricAvailable?.())
        .then((result: any) => setBiometricAvailable(!!result?.available))
        .catch(() => setBiometricAvailable(false));
    }

    // 3. Fetch Whitelisted commands
    linkApi.getCommands()
      .then((cmds: any) => setCommands(cmds))
      .catch((err: any) => addLog(`Failed to load commands: ${err.message}`));

    // 3.5 Fetch device permissions
    linkApi.getPermissions()
      .then((perms: any) => setDevicePermissions(perms || {}))
      .catch((err: any) => addLog(`Failed to fetch permissions: ${err.message}`));

    // 3.7 Fetch trusted devices list (starts offline)
    linkApi.getTrustedDevices()
      .then((list: any[]) => {
        setPeers((prev) => {
          const copy = new Map(prev);
          list.forEach((d: any) => {
            if (!copy.has(d.deviceId)) {
              copy.set(d.deviceId, {
                deviceId: d.deviceId,
                name: d.deviceName,
                deviceType: d.deviceType || 'phone',
                trusted: true,
                connected: false,
              });
            }
          });
          return copy;
        });
      })
      .catch((err: any) => addLog(`Failed to load trusted devices: ${err.message}`));

    // 3.8 Fetch REAL current connection state and reconcile over the (always connected:false)
    // trusted list above. A renderer reload (F5/Ctrl+R, or a WebView-only reload on mobile) only
    // tears down and rebuilds this JS layer — the real DeviceManager and its TCP connections in
    // the main/native process keep running completely undisturbed. Without this, every device
    // looked disconnected right after a reload even when nothing at the network level had
    // actually changed.
    if (linkApi.getConnectedDevices) {
      linkApi.getConnectedDevices()
        .then((list: any[]) => {
          if (list.length === 0) return;
          setPeers((prev) => {
            const copy = new Map(prev);
            list.forEach((identity: any) => {
              copy.set(identity.deviceId, {
                deviceId: identity.deviceId,
                name: identity.deviceName,
                deviceType: identity.deviceType,
                incomingCapabilities: identity.incomingCapabilities || [],
                outgoingCapabilities: identity.outgoingCapabilities || [],
                // Re-hydrate gated-plugin visibility on reload — main caches the peer's last-pushed
                // effective caps (see get-connected-devices). Without this, a reload blanks every
                // gated plugin until the peer re-pushed (the reload ping-pong).
                allowedCapabilities: identity.allowedCapabilities || [],
                trusted: identity.trusted,
                connected: true,
              });
            });
            return copy;
          });
        })
        .catch((err: any) => addLog(`Failed to load connected devices: ${err.message}`));
    }

    // 3.9 Ask every already-connected peer to resend their full initial-sync state (volume,
    // battery, connectivity, lock, MPRIS, etc.) — sendInitialSync only ever fires once, at the
    // moment the connection was first established, so a renderer reload otherwise leaves these
    // sections looking empty/absent until some unrelated future change happens to rebroadcast.
    if (linkApi.resyncDevices) {
      linkApi.resyncDevices().catch((err: any) => addLog(`Failed to resync devices: ${err.message}`));
    }

    // 4. Bind IPC listeners from desktop/preload.ts
    linkApi.onDeviceConnected((identity: any, trusted: boolean) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        // Spread the existing entry (if any) first — this used to build a brand-new object from
        // scratch, which silently wiped battery/connectivity/isLocked/isRinging back to undefined
        // on every reconnect (a brief Wi-Fi blip, app backgrounding, etc.), making those sections
        // flash empty until the peer's next battery/connectivity packet happened to arrive again.
        const existing = copy.get(identity.deviceId);
        copy.set(identity.deviceId, {
          ...existing,
          deviceId: identity.deviceId,
          name: identity.deviceName,
          deviceType: identity.deviceType,
          incomingCapabilities: identity.incomingCapabilities || [],
          outgoingCapabilities: identity.outgoingCapabilities || [],
          trusted,
          connected: true,
        });
        return copy;
      });
      addLog(`Device connected: ${identity.deviceName} (trusted=${trusted})`);
    });

    linkApi.onDeviceDisconnected((deviceId: string) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) {
          if (peer.trusted) {
            copy.set(deviceId, {
              ...peer,
              connected: false, // Keep trusted, mark offline
            });
          } else {
            copy.delete(deviceId); // Delete untrusted
          }
        }
        return copy;
      });
      addLog(`Device disconnected: ${deviceId.slice(0, 8)}`);
    });

    linkApi.onIncomingPairRequest((deviceId: string, verificationKey: string | null) => {
      addLog(`Pair request received from ${deviceId.slice(0, 8)}. PIN: ${verificationKey}`);
      setActivePairRequest({ deviceId, verificationKey });
    });

    linkApi.onPairingSuccessful((deviceId: string) => {
      addLog(`Paired successfully with ${deviceId.slice(0, 8)}`);
      // This effect's own closure only ever sees the peers map from mount time (registered once
      // with a [] dep array), so the peer's display name has to come out of the setPeers updater
      // itself (which does see the latest state) rather than reading the outer `peers` variable.
      let peerName = deviceId.slice(0, 8);
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) {
          peer.trusted = true;
          peerName = peer.name || peerName;
        }
        return copy;
      });
      // The backend just wrote a fresh all-denied permissions record for this device (see
      // initializeDeniedPermissionsForNewDevice in main.ts) — without refetching, the renderer's
      // devicePermissions cache still has no entry for it, so getPermission() falls through to
      // its own "unset means allowed" default and the Permissions dialog shows every toggle as ON
      // despite the backend correctly denying everything underneath.
      linkApi.getPermissions()
        .then((perms: any) => setDevicePermissions(perms || {}))
        .catch((err: any) => addLog(`Failed to refresh permissions after pairing: ${err.message}`));
      // A successful pair used to leave the user sitting on Add Device with no visible
      // confirmation beyond a log line — jump to Devices so the newly-trusted peer is
      // immediately visible instead of looking like nothing happened.
      handleSetActiveTab('devices');
      // Post-pairing nudge (Trusted Pool transformation, Wave 1 item 1 — see docs/backlog.txt):
      // auto-mesh only ever grants trust/connectivity, never a free pass to sync features (every
      // permission is seeded denied above) — so the first thing after a pair should point the
      // user at that device's Permissions rather than trusting they'll notice the gear icon.
      alert(`${peerName} joined your connections. Open its Permissions (the gear icon) to choose what to sync.`);
    });

    linkApi.onPairingFailed((deviceId: string, reason: string) => {
      addLog(`Pairing failed with ${deviceId.slice(0, 8)}: ${reason}`);
      // A "Timed out" failure 30s after clicking Pair looked identical to nothing happening at
      // all — it only ever showed up as one easy-to-miss line in the activity log, with no
      // visible signal that the request never reached the peer (usually because the underlying
      // connection had gone stale/half-open). Surface it the same way pairing success/incoming
      // requests already are.
      alert(`Pairing with ${deviceId.slice(0, 8)} failed: ${reason}`);
    });

    linkApi.onUnpaired((deviceId: string) => {
      addLog(`Unpaired from ${deviceId.slice(0, 8)}`);
      setPeers((prev) => {
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
    });

    linkApi.onTrustMismatch((deviceId: string) => {
      addLog(`⚠️ PIN Trust Mismatch for ${deviceId.slice(0, 8)}! Pinned cert mismatch.`);
    });

    linkApi.onClipboardReceived((deviceId: string) => {
      addLog(`Clipboard content synced from ${deviceId.slice(0, 8)}`);
    });

    linkApi.onBatteryReceived((deviceId: string, isCharging: boolean, currentCharge: number) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) {
          peer.battery = { isCharging, currentCharge };
        }
        return copy;
      });
    });

    linkApi.onFindMyPhoneTriggered((deviceId: string) => {
      addLog(`🔔 Remote ring alarm triggered by ${deviceId.slice(0, 8)}`);
      setIsRingingLocal(true);
    });

    linkApi.onFindMyPhoneStopped((deviceId?: string) => {
      addLog(`🔕 Ring alarm stopped`);
      setIsRingingLocal(false);
      setPeers((prev) => {
        const copy = new Map(prev);
        if (deviceId && copy.has(deviceId)) {
          const p = copy.get(deviceId);
          if (p) p.isRinging = false;
        } else {
          copy.forEach((p) => {
            p.isRinging = false;
          });
        }
        return copy;
      });
    });

    linkApi.onLockStateReceived((deviceId: string, isLocked: boolean) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) peer.isLocked = isLocked;
        return copy;
      });
    });

    linkApi.onLockResultReceived((deviceId: string, success: boolean) => {
      addLog(`Lock command result from ${deviceId.slice(0, 8)}: success=${success}`);
    });

    linkApi.onShareReceived((deviceId: string, filename: string, size: number) => {
      addLog(`📄 File synced from ${deviceId.slice(0, 8)}: ${filename} (${size} bytes)`);
    });

    linkApi.onConnectivityReceived((deviceId: string, signalStrengths: any) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) peer.connectivity = signalStrengths;
        return copy;
      });
    });

    linkApi.onDeviceRenamed((deviceId: string, newName: string) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) copy.set(deviceId, { ...peer, name: newName });
        return copy;
      });
      addLog(`Device ${deviceId.slice(0, 8)} renamed to: ${newName}`);
    });

    linkApi.onCommandListReceived((deviceId: string, receivedCommands: Record<string, CommandEntry>) => {
      setPeerCommandLists((prev) => {
        const copy = new Map(prev);
        copy.set(deviceId, receivedCommands);
        return copy;
      });
    });

    linkApi.onOwnDeviceRenamed?.((newName: string) => {
      setLocalIdentity((prev) => ({ ...prev, deviceName: newName }));
      addLog(`This device was renamed to: ${newName} (by a peer's request)`);
    });

    linkApi.onNotificationReceived((deviceId: string, body: any) => {
      setNotifications((prev) => {
        const key = `${deviceId}|${body.id}`;
        // Filter out existing and prepend new
        const filtered = prev.filter((n) => n.key !== key);
        return [{ key, deviceId, body }, ...filtered];
      });
    });

    linkApi.onNotificationCancelled((deviceId: string, id: string) => {
      setNotifications((prev) => {
        const key = `${deviceId}|${id}`;
        return prev.filter((n) => n.key !== key);
      });
    });

    linkApi.onSystemVolumeReceived((deviceId: string, body: any) => {
      setVolumeSinks((prev) => {
        const copy = new Map(prev);
        copy.set(deviceId, body.sinkList || []);
        return copy;
      });
    });

    linkApi.onFlashlightStateReceived((deviceId: string, enabled: boolean) => {
      // Visibility is no longer gated by this value's presence — it's gated by the peer's
      // pushed allowedCapabilities list (see onPeerCapabilitiesReceived below), so a permission
      // flip doesn't need to clear this to hide the button anymore.
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) peer.flashlight = enabled;
        return copy;
      });
    });

    linkApi.onDndStateReceived((deviceId: string, enabled: boolean, granted: boolean) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) peer.dnd = { enabled, granted };
        return copy;
      });
    });

    linkApi.onMprisStateReceived((deviceId: string, body: any) => {
      setActiveMprisDeviceId(deviceId);
      setActiveMprisPlayer(body.player || '');
      setMprisState({
        title: body.title,
        artist: body.artist,
        player: body.player,
        isPlaying: body.isPlaying,
      });
    });

    linkApi.onPeerCapabilitiesReceived((deviceId: string, capabilities: string[]) => {
      // Unified per-peer visibility signal — replaces the old per-plugin "revoked" flags.
      // Every gated button/section in DevicesTab checks membership in this peer's list instead
      // of relying on stale cached state being cleared out.
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) peer.allowedCapabilities = capabilities;
        return copy;
      });
    });

    linkApi.onSpeedTestProgress((deviceId: string, message: string) => {
      addLog(`[SpeedTest] Progress from ${deviceId.slice(0, 8)}: ${message}`);
    });
  }, []);

  // Pull to refresh gesture logic (Mobile only)
  useEffect(() => {
    if (typeof (window as any).Capacitor === 'undefined') return;

    let startX = 0;
    let startY = 0;
    let distance = 0;
    let pulling = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        
        // Check if starting at the upper portion of the viewport (topbar/header area)
        if (touch.clientY < 220) {
          // Traverse up parent elements to ensure we are not scrolling a container
          let parent = e.target as HTMLElement | null;
          let isScrolledDown = false;
          while (parent) {
            if (parent.scrollTop > 0) {
              isScrolledDown = true;
              break;
            }
            parent = parent.parentElement;
          }
          
          if (!isScrolledDown) {
            startX = touch.clientX;
            startY = touch.clientY;
            pulling = true;
          }
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!pulling) return;
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const diffX = currentX - startX;
      const diffY = currentY - startY;

      // Allow normal horizontal navigation (e.g. system swipe back) and ignore horizontal scrolling
      if (Math.abs(diffX) > Math.abs(diffY)) {
        pulling = false;
        setPullDistance(0);
        setIsPulling(false);
        return;
      }

      if (diffY > 0) {
        // Prevent default scrolling only when actively dragging down to pull-to-refresh
        if (e.cancelable) e.preventDefault();
        distance = Math.min(diffY * 0.4, 110);
        setPullDistance(distance);
        setIsPulling(true);
      } else {
        pulling = false;
        setPullDistance(0);
        setIsPulling(false);
      }
    };

    const handleTouchEnd = () => {
      if (!pulling) return;
      pulling = false;
      setIsPulling(false);

      if (distance >= 85) {
        setPullDistance(95);
        setTimeout(() => {
          window.location.reload();
        }, 300);
      } else {
        setPullDistance(0);
      }
      distance = 0;
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, []);

  // UI Interactive Callbacks
  const handleRename = async (newName: string) => {
    try {
      const saved = await linkApi.renameDevice(newName);
      setLocalIdentity((prev) => ({ ...prev, deviceName: saved }));
      addLog(`Device renamed to: ${saved}`);
    } catch (err: any) {
      alert(`Rename failed: ${err.message}`);
    }
  };

  const handleRenameTrustedDevice = async (deviceId: string, newName: string) => {
    try {
      await linkApi.renameTrustedDevice(deviceId, newName);
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) {
          copy.set(deviceId, { ...peer, name: newName });
        }
        return copy;
      });
      addLog(`Trusted device ${deviceId.slice(0, 8)} renamed to: ${newName}`);
    } catch (err: any) {
      alert(`Rename failed: ${err.message}`);
    }
  };

  const handleVisibilityToggle = (enabled: boolean) => {
    setVisibilityEnabled(enabled);
    linkApi.setVisibility(enabled)
      .then(() => addLog(`Discovery Visibility set to: ${enabled}`))
      .catch((err: any) => addLog(`Failed to save visibility settings: ${err.message}`));
  };

  const handleScreensaverInhibitToggle = (enabled: boolean) => {
    setScreensaverInhibitEnabled(enabled);
    linkApi.setScreensaverInhibitEnabled(enabled)
      .then(() => addLog(`Screensaver Inhibit set to: ${enabled}`))
      .catch((err: any) => addLog(`Failed to save screensaver inhibit setting: ${err.message}`));
  };

  const handleOpenAtLoginToggle = (enabled: boolean) => {
    setOpenAtLogin(enabled);
    linkApi.setOpenAtLogin(enabled)
      .then(() => addLog(`Open on Startup set to: ${enabled}`))
      .catch((err: any) => addLog(`Failed to save open-at-login setting: ${err.message}`));
  };

  const handleCloseToTrayToggle = (enabled: boolean) => {
    setCloseToTray(enabled);
    linkApi.setCloseToTray?.(enabled)
      .then(() => addLog(`Close to Tray set to: ${enabled}`))
      .catch((err: any) => addLog(`Failed to save close-to-tray setting: ${err.message}`));
  };

  const handleSetPermission = (devId: string, permKey: string, allowed: boolean | string) => {
    const updated = {
      ...devicePermissions,
      [devId]: {
        ...(devicePermissions[devId] || {}),
        [permKey]: allowed
      }
    };
    setDevicePermissions(updated);
    linkApi.setPermissions(updated)
      .then(() => addLog(`Permission updated: ${devId.slice(0, 8)} [${permKey}] = ${allowed}`))
      .catch((err: any) => addLog(`Failed to save permissions: ${err.message}`));
  };

  const handleConnect = (host: string) => {
    addLog(`Sending connection probe to ${host}...`);
    linkApi.connectTo(host).catch((err: any) => addLog(`Manual connect failed: ${err.message}`));
  };

  // Peer Action controls
  const handlePair = (id: string) => {
    linkApi.requestPairing(id).then((pin: string) => {
      addLog(`Pairing requested with ${id.slice(0, 8)}. Pin: ${pin}`);
      alert(`Pairing initiated! Confirm that this PIN matches the target device:\n\n${pin}`);
    });
  };

  const handleToggleRing = (id: string) => {
    const peer = peers.get(id);
    if (!peer) return;
    if (peer.isRinging) {
      linkApi.sendStopRinging(id);
      setPeers((prev) => {
        const copy = new Map(prev);
        const p = copy.get(id);
        if (p) p.isRinging = false;
        return copy;
      });
    } else {
      linkApi.sendFindMyPhone(id);
      setPeers((prev) => {
        const copy = new Map(prev);
        const p = copy.get(id);
        if (p) p.isRinging = true;
        return copy;
      });
    }
  };

  const handleLock = (id: string) => {
    const peer = peers.get(id);
    if (!peer) return;

    if (peer.isLocked) {
      // No mainstream OS exposes a way to remotely unlock a screen without the user's real
      // credentials — there is no "unlock" action to send. Query the peer's real current state
      // instead of pretending to unlock it; this also self-heals if it had actually drifted
      // (e.g. the peer unlocked locally in the meantime).
      linkApi.sendLockStatusRequest(id).catch((err: any) => {
        addLog(`Lock status query failed: ${err.message}`);
      });
      return;
    }

    setPeers((prev) => {
      const copy = new Map(prev);
      const p = copy.get(id);
      if (p) p.isLocked = true;
      return copy;
    });
    linkApi.sendLockRequest(id, true).catch((err: any) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const p = copy.get(id);
        if (p) p.isLocked = false;
        return copy;
      });
      addLog(`Lock request failed: ${err.message}`);
    });
  };

  const handleToggleFlashlight = (id: string) => {
    const peer = peers.get(id);
    if (!peer) return;
    const target = !peer.flashlight;
    setPeers((prev) => {
      const copy = new Map(prev);
      const p = copy.get(id);
      if (p) p.flashlight = target;
      return copy;
    });
    linkApi.sendFlashlightToggle(id, target).catch((err: any) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const p = copy.get(id);
        if (p) p.flashlight = !target;
        return copy;
      });
      addLog(`Flashlight failed: ${err.message}`);
    });
  };

  const handleToggleDnd = (id: string) => {
    const peer = peers.get(id);
    if (!peer) return;
    const target = !(peer.dnd && peer.dnd.enabled);
    setPeers((prev) => {
      const copy = new Map(prev);
      const p = copy.get(id);
      if (p) p.dnd = { enabled: target, granted: p.dnd?.granted ?? true };
      return copy;
    });
    linkApi.sendDndSet(id, target).catch((err: any) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const p = copy.get(id);
        if (p) p.dnd = { enabled: !target, granted: p.dnd?.granted ?? true };
        return copy;
      });
      addLog(`DND set failed: ${err.message}`);
    });
  };

  const handleSpeedTest = (id: string) => {
    addLog(`Speed test started with ${id.slice(0, 8)}...`);
    setActiveSpeedTestDeviceId(id);
    linkApi.runSpeedTest(id)
      .then((res: any) => {
        addLog(`Speed Test Completed: Latency: ${res.latencyMs}ms, Up: ${res.uploadSpeedMbps} Mbps, Down: ${res.downloadSpeedMbps} Mbps`);
        alert(`Speed Test Result:\n\n- Latency: ${res.latencyMs} ms\n- Upload: ${res.uploadSpeedMbps} Mbps\n- Download: ${res.downloadSpeedMbps} Mbps`);
      })
      .catch((err: any) => {
        addLog(`Speed Test error: ${err.message}`);
        alert(`Speed Test Failed: ${err.message}`);
      })
      .finally(() => {
        setActiveSpeedTestDeviceId(null);
      });
  };

  const handleUnpair = (id: string) => {
    const peer = peers.get(id);
    const deviceName = peer ? peer.name : id.slice(0, 8);
    if (confirm(`Are you sure you want to unpair and disconnect from ${deviceName}?`)) {
      linkApi.unpair(id);
      setPeers((prev) => {
        const copy = new Map(prev);
        copy.delete(id);
        return copy;
      });
    }
  };

  const handleSetVolume = (id: string, sinkName: string, vol: number) => {
    linkApi.sendSetVolume(id, sinkName, vol);
    setVolumeSinks((prev) => {
      const copy = new Map(prev);
      const list = copy.get(id) || [];
      const updated = list.map((s) => (s.name === sinkName ? { ...s, volume: vol } : s));
      copy.set(id, updated);
      return copy;
    });
  };

  const handleToggleMute = (id: string, sinkName: string) => {
    const list = volumeSinks.get(id) || [];
    const sink = list.find((s) => s.name === sinkName);
    if (sink) {
      linkApi.sendSetMute(id, sinkName, !sink.muted);
    }
  };

  // MPRIS actions
  const handleMprisPrev = () => {
    if (activeMprisDeviceId) {
      linkApi.sendMprisAction(activeMprisDeviceId, activeMprisPlayer, 'Previous');
    }
  };

  const handleMprisPlay = () => {
    if (activeMprisDeviceId) {
      linkApi.sendMprisAction(activeMprisDeviceId, activeMprisPlayer, 'PlayPause');
    }
  };

  const handleMprisNext = () => {
    if (activeMprisDeviceId) {
      linkApi.sendMprisAction(activeMprisDeviceId, activeMprisPlayer, 'Next');
    }
  };

  // Notification reply
  const handleReplyNotification = async (deviceId: string, replyId: string, message: string, notifKey: string) => {
    addLog(`Replying to notification: "${message}"`);
    try {
      await linkApi.sendNotificationReply(deviceId, replyId, message);
      addLog('Reply sent successfully!');
      setNotifications((prev) => prev.filter((n) => n.key !== notifKey));
    } catch (err: any) {
      addLog(`Failed to reply to notification: ${err.message}`);
    }
  };

  // Shell Whitelist
  const handleAddCommand = (key: string, name: string, command: string) => {
    linkApi.setCommand(key, { name, command }).then((updated: any) => {
      setCommands(updated);
      addLog(`Registered command: ${key}`);
    });
  };

  const handleRemoveCommand = (key: string) => {
    linkApi.removeCommand(key).then((updated: any) => {
      setCommands(updated);
      addLog(`Removed command: ${key}`);
    });
  };

  const handleRunCommandTrigger = (deviceId: string, key: string) => {
    linkApi.sendRunCommandTrigger(deviceId, key);
    addLog(`Triggered command "${key}" on ${deviceId.slice(0, 8)}`);
  };

  const handleLocalStopRinging = async () => {
    addLog('Stopping alarm ring locally...');
    await linkApi.stopRingingLocal();
    setIsRingingLocal(false);
  };

  return (
    <>
      {/* Pull down refresh mobile indicator */}
      {pullDistance > 0 && (
        <div
          className="pull-refresh-indicator"
          style={{
            transform: `translateX(-50%) translateY(${pullDistance}px)`,
            opacity: pullDistance / 75,
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="url(#accentGradient)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: `rotate(${pullDistance * 4.5}deg)`,
              animation: pullDistance >= 85 ? 'spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite' : 'none',
              filter: 'drop-shadow(0 0 4px #00f0ff)'
            }}
          >
            <defs>
              <linearGradient id="accentGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#00f0ff" />
                <stop offset="100%" stopColor="#3b82f6" />
              </linearGradient>
            </defs>
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
          </svg>
        </div>
      )}

      {/* Onboarding Wizard */}
      {showOnboarding && (
        <OnboardingWizard
          isMobile={linkApi?.isMobile || false}
          mobilePermissions={mobilePermissions}
          onRequestPermission={handleRequestMobilePermission}
          onComplete={() => {
            localStorage.setItem('onboarding-completed', 'true');
            setShowOnboarding(false);
          }}
        />
      )}

      {/* Ringing Alert Full-Screen Overlay */}
      {isRingingLocal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(5, 5, 8, 0.94)',
            backdropFilter: 'blur(20px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            // Must always sit above every other overlay (device control panel, Permissions
            // dialog, Touchpad/Presenter/Digitizer's .landscape-overlay) — all of those use
            // z-index 10000, and since this overlay is defined earlier in the JSX tree, equal
            // z-index meant later-painted overlays (e.g. DevicesTab's .modal) covered it.
            zIndex: 20000,
            userSelect: 'none',
            animation: 'fadeIn 0.3s ease-out'
          }}
        >
          {/* Pulsing glow ring wrapper */}
          <div style={{ position: 'relative', marginBottom: '32px' }}>
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '130px',
                height: '130px',
                borderRadius: '50%',
                background: 'rgba(0, 240, 255, 0.25)',
                filter: 'blur(15px)',
                animation: 'pulse 1.2s infinite alternate'
              }}
            />
            <div
              style={{
                width: '96px',
                height: '96px',
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(0, 240, 255, 0.4)',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                boxShadow: '0 0 25px rgba(0, 240, 255, 0.15)',
                position: 'relative',
                zIndex: 2
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="40"
                height="40"
                fill="none"
                stroke="#00f0ff"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  animation: 'vibrate 0.6s infinite'
                }}
              >
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
          </div>

          <button
            onClick={handleLocalStopRinging}
            style={{
              background: 'var(--accent-gradient)',
              color: '#000',
              border: 'none',
              padding: '14px 44px',
              borderRadius: '30px',
              fontWeight: 700,
              fontSize: '15px',
              cursor: 'pointer',
              boxShadow: '0 10px 25px rgba(0, 240, 255, 0.35)',
              transition: 'transform 0.15s, box-shadow 0.15s',
              position: 'relative',
              zIndex: 2
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.04)';
              e.currentTarget.style.boxShadow = '0 12px 30px rgba(0, 240, 255, 0.45)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 10px 25px rgba(0, 240, 255, 0.35)';
            }}
          >
            Stop Ringing
          </button>
        </div>
      )}

      {/* App Lock screen overlay (PIN Lock) */}
      {appIsLocked && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(5, 5, 8, 0.96)',
            backdropFilter: 'blur(24px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 30000,
            userSelect: 'none',
            animation: 'fadeIn 0.3s ease-out'
          }}
        >
          <div
            style={{
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '24px'
            }}
          >
            <div className="brand-title" style={{ fontSize: '32px', fontWeight: 800 }}>LINK</div>
            <div style={{ fontSize: '13.5px', color: 'var(--text-muted)' }}>Enter PIN to unlock application</div>

            <PinNumpadInput
              correctPin={appPinCode}
              onUnlock={() => setAppIsLocked(false)}
            />

            {biometricEnabled && biometricAvailable && linkApi?.isMobile && (
              <button
                onClick={() => {
                  Promise.resolve(linkApi.authenticateBiometric?.())
                    .then((result: any) => {
                      if (result?.success) setAppIsLocked(false);
                    })
                    .catch(() => {});
                }}
                style={{ padding: '8px 16px', fontSize: '12.5px', background: 'transparent', border: '1px solid var(--border-color, #444)' }}
              >
                Use Fingerprint/Face ID
              </button>
            )}
          </div>
        </div>
      )}

      {activePairRequest && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(5, 5, 8, 0.94)',
            backdropFilter: 'blur(20px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 20000,
            userSelect: 'none',
            animation: 'fadeIn 0.3s ease-out'
          }}
        >
          <div
            className="card"
            style={{
              width: '320px',
              padding: '24px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ fontSize: '18px', fontWeight: 800 }}>Pairing Request</div>
            <div style={{ fontSize: '13.5px', color: 'var(--text-muted)' }}>
              Device <strong>{activePairRequest.deviceId.slice(0, 8)}</strong> wants to pair with you.
            </div>
            
            {activePairRequest.verificationKey && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', margin: '8px 0' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>CONFIRM PIN MATCHES THEIR SCREEN</div>
                <div style={{ fontSize: '24px', fontWeight: 800, fontFamily: 'monospace', letterSpacing: '2px' }}>
                  {activePairRequest.verificationKey}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
              <button
                onClick={() => {
                  linkApi.acceptPairing(activePairRequest.deviceId);
                  setActivePairRequest(null);
                }}
                style={{ background: 'var(--accent-gradient)', color: '#000', fontWeight: 700 }}
              >
                Accept
              </button>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <button
                  onClick={() => {
                    linkApi.rejectPairing(activePairRequest.deviceId, false);
                    setActivePairRequest(null);
                  }}
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)' }}
                >
                  Reject
                </button>
                <button
                  onClick={() => {
                    linkApi.rejectPairing(activePairRequest.deviceId, true);
                    setActivePairRequest(null);
                  }}
                  style={{ background: '#ef4444', color: '#fff', border: 'none' }}
                >
                  Block
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <TopBar
          deviceName={localIdentity.deviceName}
          ipAddress={localIdentity.ipAddress}
        />

        <div id="main-content-split" style={{ display: 'flex', flexGrow: 1, width: '100%', overflow: 'hidden' }}>
          <Sidebar activeTab={activeTab} setActiveTab={handleSetActiveTab} isMobile={typeof (window as any).Capacitor !== 'undefined'} />

          <div className="main-container">
            {/* Prominent Page Title below TopBar */}
            <div className="page-title-container" style={{ padding: '24px 40px 10px 40px', userSelect: 'none' }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 800, letterSpacing: '-0.8px', color: 'var(--text-color)' }}>
                {titleMap[activeTab]}
              </h1>
            </div>

        {activeTab === 'devices' && (
          <ConnectionsTab
            peers={peers}
            localDeviceType={localIdentity.deviceType}
            volumeSinks={volumeSinks}
            mprisState={mprisState}
            activeMprisDeviceId={activeMprisDeviceId}
            onPair={handlePair}
            onToggleRing={handleToggleRing}
            onLock={handleLock}
            onToggleFlashlight={handleToggleFlashlight}
            onToggleDnd={handleToggleDnd}
            onSpeedTest={handleSpeedTest}
            peerCommandLists={peerCommandLists}
            onRunCommandTrigger={handleRunCommandTrigger}
            onUnpair={handleUnpair}
            onSetVolume={handleSetVolume}
            onToggleMute={handleToggleMute}
            onMprisPrev={handleMprisPrev}
            onMprisPlay={handleMprisPlay}
            onMprisNext={handleMprisNext}
            onShowPresenter={(id) => {
              setActiveRemoteControlDeviceId(id);
              setActiveRemoteControlMode('presenter');
            }}
            onShowTouchpad={(id) => {
              setActiveRemoteControlDeviceId(id);
              setActiveRemoteControlMode('touchpad');
            }}
            onShowDigitizer={(id) => {
              setActiveRemoteControlDeviceId(id);
              setActiveRemoteControlMode('digitizer');
            }}
            devicePermissions={devicePermissions}
            onSetPermission={handleSetPermission}
            onRenameTrustedDevice={handleRenameTrustedDevice}
            activeSpeedTestDeviceId={activeSpeedTestDeviceId}
            visibilityEnabled={visibilityEnabled}
            onVisibilityToggle={handleVisibilityToggle}
            onConnect={handleConnect}
          />
        )}

        {activeTab === 'notifications' && (
          <NotificationsTab
            notifications={notifications}
            onReply={handleReplyNotification}
          />
        )}

        {activeTab === 'commands' && (
          <CommandsTab
            commands={commands}
            onAddCommand={handleAddCommand}
            onRemoveCommand={handleRemoveCommand}
          />
        )}

        {activeTab === 'tools' && (
          <ToolsTab
            peers={peers}
            localIdentity={localIdentity}
            isMobile={typeof (window as any).Capacitor !== 'undefined'}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsTab
            deviceName={localIdentity.deviceName}
            deviceId={localIdentity.deviceId}
            ipAddress={localIdentity.ipAddress}
            onRename={handleRename}
            theme={theme}
            onThemeToggle={handleThemeToggle}
            logs={logs}
            isMobile={typeof (window as any).Capacitor !== 'undefined'}
            mobilePermissions={mobilePermissions}
            onRequestMobilePermission={handleRequestMobilePermission}
            screensaverInhibitEnabled={screensaverInhibitEnabled}
            onScreensaverInhibitToggle={handleScreensaverInhibitToggle}
            openAtLogin={openAtLogin}
            onOpenAtLoginToggle={handleOpenAtLoginToggle}
            closeToTray={closeToTray}
            onCloseToTrayToggle={handleCloseToTrayToggle}
            pinLockEnabled={appPinLockEnabled}
            onPinLockToggle={(enabled) => {
              setAppPinLockEnabled(enabled);
              localStorage.setItem('app-pin-lock-enabled', String(enabled));
              linkApi.setPinLockEnabled?.(enabled);
            }}
            pinCode={appPinCode}
            onPinCodeChange={(newPin) => {
              setAppPinCode(newPin);
              localStorage.setItem('app-pin-code', newPin);
              linkApi.setPinCode?.(newPin);
            }}
            biometricEnabled={biometricEnabled}
            biometricAvailable={biometricAvailable}
            onBiometricToggle={(enabled) => {
              setBiometricEnabled(enabled);
              localStorage.setItem('app-biometric-enabled', String(enabled));
            }}
          />
        )}
      </div>
    </div>

      {/* Full-Screen Input Overlays (Mobile Only) */}
      {activeRemoteControlMode === 'presenter' && activeRemoteControlDeviceId && (
        <PresenterOverlay
          deviceId={activeRemoteControlDeviceId}
          onClose={() => {
            setActiveRemoteControlMode(null);
            setActiveRemoteControlDeviceId(null);
          }}
        />
      )}

      {activeRemoteControlMode === 'touchpad' && activeRemoteControlDeviceId && (
        <RemoteInputOverlay
          deviceId={activeRemoteControlDeviceId}
          onClose={() => {
            setActiveRemoteControlMode(null);
            setActiveRemoteControlDeviceId(null);
          }}
        />
      )}

      {activeRemoteControlMode === 'digitizer' && activeRemoteControlDeviceId && (
        <DigitizerOverlay
          deviceId={activeRemoteControlDeviceId}
          onClose={() => {
            setActiveRemoteControlMode(null);
            setActiveRemoteControlDeviceId(null);
          }}
        />
      )}
      </div>
    </>
  );
};

interface PinNumpadInputProps {
  correctPin: string;
  onUnlock: () => void;
}

const PinNumpadInput: React.FC<PinNumpadInputProps> = ({ correctPin, onUnlock }) => {
  const [pin, setPin] = useState<string>('');
  const [error, setError] = useState<boolean>(false);

  const handleKeyPress = (num: string) => {
    if (error) {
      setError(false);
      setPin(num);
      return;
    }
    if (pin.length < 4) {
      const nextPin = pin + num;
      setPin(nextPin);
      if (nextPin.length === 4) {
        if (nextPin === correctPin) {
          onUnlock();
        } else {
          setError(true);
        }
      }
    }
  };

  const handleBackspace = () => {
    if (error) {
      setError(false);
      setPin('');
      return;
    }
    setPin(pin.slice(0, -1));
  };

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        handleKeyPress(e.key);
      } else if (e.key === 'Backspace') {
        handleBackspace();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pin, error, correctPin]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
      {/* Code indicators */}
      <div style={{ display: 'flex', gap: '12px' }}>
        {[0, 1, 2, 3].map((idx) => {
          const filled = pin.length > idx;
          return (
            <div
              key={idx}
              style={{
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                border: '2px solid ' + (error ? '#ef4444' : 'var(--accent-color, #00f0ff)'),
                background: filled ? (error ? '#ef4444' : 'var(--accent-color, #00f0ff)') : 'transparent',
                boxShadow: filled ? '0 0 10px ' + (error ? '#ef4444' : 'var(--accent-color, #00f0ff)') : 'none',
                transition: 'all 0.15s ease'
              }}
            />
          );
        })}
      </div>

      {error && (
        <div style={{ color: '#ef4444', fontSize: '12.5px', fontWeight: 600, animation: 'shake 0.3s ease' }}>
          Invalid PIN code. Try again.
        </div>
      )}

      {/* Grid Keyboard */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '12px',
          width: '220px',
          marginTop: '10px'
        }}
      >
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
          <button
            key={num}
            onClick={() => handleKeyPress(num)}
            style={{
              height: '56px',
              borderRadius: '50%',
              fontSize: '18px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-color)',
              cursor: 'pointer'
            }}
          >
            {num}
          </button>
        ))}
        {/* Backspace */}
        <button
          onClick={handleBackspace}
          style={{
            height: '56px',
            borderRadius: '50%',
            fontSize: '16px',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer'
          }}
        >
          ⌫
        </button>
        {/* 0 */}
        <button
          onClick={() => handleKeyPress('0')}
          style={{
            height: '56px',
            borderRadius: '50%',
            fontSize: '18px',
            fontWeight: 600,
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-color)',
            cursor: 'pointer'
          }}
        >
          0
        </button>
        {/* Clear */}
        <button
          onClick={() => { setError(false); setPin(''); }}
          style={{
            height: '56px',
            borderRadius: '50%',
            fontSize: '12px',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer'
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
};

export default App;
