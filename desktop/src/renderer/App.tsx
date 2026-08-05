import React, { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ConnectionsTab from './components/ConnectionsTab';
import { PendingGuestCard } from './components/ModalDialog';
import NotificationsTab from './components/NotificationsTab';
import CommandsTab from './components/CommandsTab';
import ToolsTab, { ToolModalHeader } from './components/ToolsTab';
import WalkieTalkieTab from './components/WalkieTalkieTab';
import SettingsTab from './components/SettingsTab';
import OnboardingWizard from './components/OnboardingWizard';
import PresenterOverlay from './components/PresenterOverlay';
import PresenterDotOverlay, { PresenterMoveHandler } from './components/PresenterDotOverlay';
import DigitizerDotOverlay, { DigitizerMoveHandler } from './components/DigitizerDotOverlay';
import RemoteInputOverlay from './components/RemoteInputOverlay';
import DigitizerOverlay from './components/DigitizerOverlay';
import FileExplorerTab from './components/FileExplorerTab';
import ModalDialog, { ModalDialogProps } from './components/ModalDialog';
import { pushBackHandler, handleHardwareBack } from './backNav';

// linkApi global reference
const linkApi = (window as any).link;

// Only the Settings tab's diagnostics pane ever displays these, and only the tail is useful.
const MAX_LOG_LINES = 300;
// Notifications are keyed and de-duplicated, but only a matching cancel packet removes one.
const MAX_NOTIFICATIONS = 200;

interface PeerDevice {
  deviceId: string;
  name: string;
  ipAddress?: string;
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
  driveLetter?: string;
  mprisState?: {
    title?: string;
    artist?: string;
    player?: string;
    isPlaying?: boolean;
  };
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

  // Walkie Talkie's session (RTCPeerConnections, the mixing AudioContext, sessionId/members) lives
  // entirely in WalkieTalkieTab's own React state/refs, with no main-process-side session object
  // to resync from on remount — unlike ToolsTab's other four tools, so it can't be mounted only
  // while ToolsTab's modal (or even the Tools tab itself) is showing, or navigating to a different
  // outer tab and back would silently end an active session. Mounted here at the app root instead,
  // permanently, and just shown/hidden — this is the only tool that needs that treatment.
  const [walkieTalkieOpen, setWalkieTalkieOpen] = useState(false);
  const [walkieTalkieActive, setWalkieTalkieActive] = useState(false);

  // Device & Identity State
  const [localIdentity, setLocalIdentity] = useState<{ deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string }>({
    deviceId: '',
    deviceName: 'Loading...',
  });
  const [visibilityEnabled, setVisibilityEnabled] = useState<boolean>(true);
  const [showAddDevice, setShowAddDevice] = useState<boolean>(false);
  const [screensaverInhibitEnabled, setScreensaverInhibitEnabled] = useState<boolean>(true);
  const [openAtLogin, setOpenAtLogin] = useState<boolean>(false);
  const [closeToTray, setCloseToTray] = useState<boolean>(true);

  // Peer & Volume States
  const [peers, setPeers] = useState<Map<string, PeerDevice>>(new Map());
  const [discoveredPeers, setDiscoveredPeers] = useState<Map<string, any>>(new Map());
  const [volumeSinks, setVolumeSinks] = useState<Map<string, VolumeSink[]>>(new Map());

  // Notification States
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
  const [activeModal, setActiveModal] = useState<ModalDialogProps | null>(null);

  // Remote Input Overlays (Mobile Only)
  const [activeRemoteControlMode, setActiveRemoteControlMode] = useState<'presenter' | 'touchpad' | 'digitizer' | null>(null);
  const [activeRemoteControlDeviceId, setActiveRemoteControlDeviceId] = useState<string | null>(null);
  const [activeFileExplorerDeviceId, setActiveFileExplorerDeviceId] = useState<string | null>(null);
  // Mobile-to-mobile presenter: this device is BEING controlled by a peer (not the controller).
  // Set as soon as the first position update arrives; cleared on stop/close.
  const [presenterDotSourceDeviceId, setPresenterDotSourceDeviceId] = useState<string | null>(null);
  const presenterMoveHandlerRef = useRef<PresenterMoveHandler | null>(null);

  // Mobile-to-mobile/desktop-to-mobile digitizer target states
  const [digitizerSourceDeviceId, setDigitizerSourceDeviceId] = useState<string | null>(null);
  const [digitizerSessionWidth, setDigitizerSessionWidth] = useState<number>(0);
  const [digitizerSessionHeight, setDigitizerSessionHeight] = useState<number>(0);
  const digitizerMoveHandlerRef = useRef<DigitizerMoveHandler | null>(null);
  const [mobilePermissions, setMobilePermissions] = useState<Record<string, string>>({
    phoneState: 'denied',
    contacts: 'denied',
    notifications: 'denied',
    notificationAccess: 'denied',
    notificationsSend: 'denied',
    microphone: 'denied',
    allFiles: 'denied',
    dnd: 'denied',
    deviceAdmin: 'denied',
    batteryOpt: 'denied',
    accessibility: 'denied',
    overlay: 'denied',
  });

  // General App logs & Onboarding flags
  const [logs, setLogs] = useState<string[]>([]);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    return !localStorage.getItem('onboarding-completed');
  });

  const [activePairRequest, setActivePairRequest] = useState<{ deviceId: string; deviceName: string; deviceType?: string; verificationKey: string | null } | null>(null);

  const peersRef = useRef(peers);
  useEffect(() => { peersRef.current = peers; }, [peers]);

  const activePairRequestRef = useRef(activePairRequest);
  useEffect(() => { activePairRequestRef.current = activePairRequest; }, [activePairRequest]);

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

  // Helper log function. Capped: this array is appended from ~60 call sites, several of them
  // per-packet (battery, connectivity, speed-test progress), and every append copied the whole
  // array. Left unbounded it grew for the entire lifetime of the process — an app left running
  // all day ended up copying a very large array on every incoming packet.
  const addLog = useCallback((msg: string) => {
    setLogs((prev) => {
      const next = [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  const updatePermissionsUI = async () => {
    if (!linkApi || !linkApi.isMobile) return;
    try {
      const perms = await linkApi.checkPermissions();
      const notifStatus = await linkApi.checkNotificationAccess();
      const allFilesStatus = await linkApi.checkAllFilesAccess();
      const dndStatus = await linkApi.checkDndPermission();
      const adminStatus = await linkApi.checkDeviceAdmin();
      const batteryStatus = await linkApi.isBatteryOptimizationIgnored();
      const accessibilityStatus = await linkApi.checkAccessibility();
      const overlayStatus = await linkApi.checkOverlayPermission();

      setMobilePermissions({
        phoneState: perms.phoneState,
        contacts: perms.contacts,
        notifications: notifStatus.enabled ? 'granted' : 'denied',
        notificationsSend: perms.notifications,
        microphone: perms.microphone,
        allFiles: allFilesStatus.enabled ? 'granted' : 'denied',
        dnd: dndStatus.granted ? 'granted' : 'denied',
        deviceAdmin: adminStatus.active ? 'granted' : 'denied',
        batteryOpt: batteryStatus.isIgnoring ? 'granted' : 'denied',
        accessibility: accessibilityStatus.enabled ? 'granted' : 'denied',
        overlay: overlayStatus.enabled ? 'granted' : 'denied',
      });
    } catch (e: any) {
      addLog('Failed to check permissions: ' + e.message);
    }
  };

  const handleRequestMobilePermission = async (key: string) => {
    if (!linkApi || !linkApi.isMobile) return;
    try {
      if (key === 'phoneState' || key === 'contacts' || key === 'notificationsSend' || key === 'microphone') {
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
      } else if (key === 'notifications' || key === 'notificationAccess') {
        await linkApi.requestNotificationAccess();
      } else if (key === 'allFiles') {
        await linkApi.requestAllFilesAccess();
      } else if (key === 'dnd') {
        await linkApi.requestDndPermission();
      } else if (key === 'deviceAdmin') {
        await linkApi.requestDeviceAdmin();
      } else if (key === 'batteryOpt') {
        await linkApi.requestIgnoreBatteryOptimizations();
      } else if (key === 'accessibility') {
        await linkApi.requestAccessibility();
      } else if (key === 'overlay') {
        await linkApi.requestOverlayPermission();
      }
      updatePermissionsUI();
    } catch (err: any) {
      addLog(`Permission request failed for ${key}: ${err.message}`);
    }
  };

  const handleSetActiveTab = (tab: string) => {
    setActiveTab(tab);
    if (tab === 'settings') {
      updatePermissionsUI();
    }
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

  // Claims the back button while Walkie Talkie's modal is open, same as ToolsTab.tsx does for its
  // own modal — this one lives at the app root (see walkieTalkieOpen's declaration comment) so it
  // needs its own registration here rather than inheriting ToolsTab's.
  useEffect(() => {
    if (!walkieTalkieOpen) return;
    return pushBackHandler(() => {
      setWalkieTalkieOpen(false);
      return true;
    });
  }, [walkieTalkieOpen]);

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
      document.body.classList.add('mobile-app');
      updatePermissionsUI();
      window.addEventListener('focus', updatePermissionsUI);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          updatePermissionsUI();
        }
      });
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
                ipAddress: d.ipAddress,
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
              const existing = copy.get(identity.deviceId);
              copy.set(identity.deviceId, {
                ...existing,
                deviceId: identity.deviceId,
                name: identity.deviceName,
                ipAddress: identity.ipAddress || existing?.ipAddress,
                deviceType: identity.deviceType,
                incomingCapabilities: identity.incomingCapabilities || [],
                outgoingCapabilities: identity.outgoingCapabilities || [],
                // Re-hydrate gated-plugin visibility on reload — main caches the peer's last-pushed
                // effective caps (see get-connected-devices). Without this, a reload blanks every
                // gated plugin until the peer re-pushed (the reload ping-pong).
                allowedCapabilities: identity.allowedCapabilities || [],
                driveLetter: identity.driveLetter,
                trusted: identity.trusted,
                connected: true,
              });
            });
            return copy;
          });
        })
        .catch((err: any) => addLog(`Failed to load connected devices: ${err.message}`));
    }

    // 3.8.5 Fetch initial UDP discovered devices
    linkApi.getDiscoveredDevices?.()
      .then((list: any[]) => {
        if (!list || list.length === 0) return;
        setDiscoveredPeers(new Map(list.map((d: any) => [d.deviceId, d])));
      })
      .catch(() => {});

    linkApi.onDeviceDiscovered?.((info: any) => {
      setDiscoveredPeers((prev) => {
        const copy = new Map(prev);
        copy.set(info.deviceId, info);
        return copy;
      });
      setPeers((prev) => {
        const existing = prev.get(info.deviceId);
        if (existing && info.ipAddress && existing.ipAddress !== info.ipAddress) {
          const copy = new Map(prev);
          copy.set(info.deviceId, { ...existing, ipAddress: info.ipAddress });
          return copy;
        }
        return prev;
      });
    });

    linkApi.onDeviceExpired?.((deviceId: string) => {
      setDiscoveredPeers((prev) => {
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
    });

    // 3.9 Ask every already-connected peer to resend their full initial-sync state (volume,
    // battery, connectivity, lock, MPRIS, etc.) — sendInitialSync only ever fires once, at the
    // moment the connection was first established, so a renderer reload otherwise leaves these
    // sections looking empty/absent until some unrelated future change happens to rebroadcast.
    if (linkApi.resyncDevices) {
      linkApi.resyncDevices().catch((err: any) => addLog(`Failed to resync devices: ${err.message}`));
    }

    linkApi.onLocalIdentityUpdated?.((identity: any) => {
      setLocalIdentity({
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        ipAddress: identity.ipAddress,
        ipAddresses: identity.ipAddresses,
        deviceType: identity.deviceType,
      });
      addLog(`Local IP updated: ${identity.ipAddress}`);
    });

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
          name: existing?.name || identity.deviceName,
          ipAddress: identity.ipAddress || existing?.ipAddress,
          deviceType: identity.deviceType,
          incomingCapabilities: identity.incomingCapabilities || [],
          outgoingCapabilities: identity.outgoingCapabilities || [],
          driveLetter: identity.driveLetter,
          trusted,
          connected: trusted,
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

    linkApi.onIncomingPairRequest((deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null) => {
      addLog(`Pair request received from ${deviceName || deviceId.slice(0, 8)}. PIN: ${verificationKey}`);
      setActivePairRequest({ deviceId, deviceName, deviceType, verificationKey });
    });

    linkApi.onPairingSuccessful((deviceId: string) => {
      const peerName = peersRef.current.get(deviceId)?.name 
        || (activePairRequestRef.current?.deviceId === deviceId ? activePairRequestRef.current.deviceName : null)
        || deviceId.slice(0, 8);
      addLog(`Paired successfully with ${peerName}`);
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) {
          peer.trusted = true;
          peer.connected = true;
        }
        return copy;
      });
      linkApi.getPermissions()
        .then((perms: any) => setDevicePermissions(perms || {}))
        .catch((err: any) => addLog(`Failed to refresh permissions after pairing: ${err.message}`));
      handleSetActiveTab('devices');
      setShowAddDevice(false);

      setActiveModal({
        type: 'info',
        title: 'Device Connected',
        message: `${peerName} is now connected. Open its settings (the gear icon) to choose what to sync.`,
        confirmLabel: 'Got It',
        onConfirm: () => setActiveModal(null),
      });
    });

    linkApi.onPairingFailed((deviceId: string, reason: string) => {
      const peerName = peersRef.current.get(deviceId)?.name 
        || (activePairRequestRef.current?.deviceId === deviceId ? activePairRequestRef.current.deviceName : null)
        || deviceId.slice(0, 8);
      setActivePairRequest((prev) => (prev && prev.deviceId === deviceId ? null : prev));
      addLog(`Pairing failed with ${peerName}: ${reason}`);
      if (reason === 'Cancelled by user') return;
      setActiveModal({
        type: 'info',
        title: 'Pairing Failed',
        message: `Pairing with ${peerName} failed: ${reason}`,
        confirmLabel: 'OK',
        onConfirm: () => setActiveModal(null),
      });
    });

    linkApi.onUnpaired((deviceId: string) => {
      addLog(`Unpaired from ${deviceId.slice(0, 8)}`);
      setPeers((prev) => {
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
      setDevicePermissions((prev) => {
        const copy = { ...prev };
        delete copy[deviceId];
        return copy;
      });
    });

    linkApi.onTrustMismatch((deviceId: string) => {
      addLog(`⚠️ PIN Trust Mismatch for ${deviceId.slice(0, 8)}! Pinned cert mismatch.`);
    });

    linkApi.onAppResumed?.(() => {
      addLog('App resumed from background. Syncing permissions...');
      updatePermissionsUI();
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

    const handleDeviceRingTriggered = (deviceId: string) => {
      addLog(`Remote ring alarm triggered by ${deviceId.slice(0, 8)}`);
      setIsRingingLocal(true);
    };

    const handleDeviceRingStopped = (deviceId?: string) => {
      addLog(`Ring alarm stopped`);
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
    };

    (linkApi.onFindMyDeviceTriggered || linkApi.onFindMyPhoneTriggered)?.(handleDeviceRingTriggered);
    (linkApi.onFindMyDeviceStopped || linkApi.onFindMyPhoneStopped)?.(handleDeviceRingStopped);

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

    // Mobile-to-mobile presenter: a peer is controlling this device's pointer-dot overlay.
    // Single owner of this bridge subscription — forwards each event to whichever
    // PresenterDotOverlay instance is currently mounted via presenterMoveHandlerRef.
    linkApi.onPresenterPositionReceived?.((deviceId: string, dx: number, dy: number, stop: boolean) => {
      if (stop) {
        setPresenterDotSourceDeviceId(null);
        presenterMoveHandlerRef.current?.(dx, dy, true);
      } else {
        setPresenterDotSourceDeviceId((prev) => prev ?? deviceId);
        presenterMoveHandlerRef.current?.(dx, dy, false);
      }
    });

    linkApi.onDigitizerSessionReceived?.((deviceId: string, action: string, w: number, h: number) => {
      if (action === 'start') {
        setDigitizerSourceDeviceId(deviceId);
        setDigitizerSessionWidth(w);
        setDigitizerSessionHeight(h);
      } else {
        setDigitizerSourceDeviceId(null);
        digitizerMoveHandlerRef.current?.(0, 0, false, false);
      }
    });

    linkApi.onDigitizerEventReceived?.((deviceId: string, x: number, y: number, touching: boolean) => {
      setDigitizerSourceDeviceId((prev) => prev ?? deviceId);
      digitizerMoveHandlerRef.current?.(x, y, touching, true);
    });

    linkApi.onShareReceived((deviceId: string, filename: string, size: number) => {
      addLog(`File synced from ${deviceId.slice(0, 8)}: ${filename} (${size} bytes)`);
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
        // Capped: an entry is only ever removed by a matching cancel packet, and plenty never
        // arrive (phone rebooted, listener service restarted, mesh-sync duplicate). Left
        // unbounded this list grew all day, and every new notification did an O(n) scan of it.
        return [{ key, deviceId, body }, ...filtered].slice(0, MAX_NOTIFICATIONS);
      });
    });

    linkApi.onNotificationCancelled((deviceId: string, id: string) => {
      setNotifications((prev) => {
        const key = `${deviceId}|${id}`;
        return prev.filter((n) => n.key !== key);
      });
    });

    // Mesh-wide notification sync from pool members
    linkApi.onNotificationBroadcastReceived?.((sourceDeviceId: string, body: any) => {
      setNotifications((prev) => {
        const key = `${sourceDeviceId}|${body.id}`;
        const filtered = prev.filter((n) => n.key !== key);
        return [{ key, deviceId: sourceDeviceId, body, isMeshSync: true }, ...filtered].slice(0, MAX_NOTIFICATIONS);
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
      addLog(`[Media] Received from ${deviceId}: "${body.title}" by ${body.artist}, playing: ${body.isPlaying}`);
      // Store media state per-device to prevent leak where device B's media shows on device A's panel
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) {
          peer.mprisState = {
            title: body.title,
            artist: body.artist,
            player: body.player,
            isPlaying: body.isPlaying,
          };
        }
        return copy;
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

    linkApi.onDeviceMountChanged?.((deviceId: string, driveLetter?: string) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) {
          copy.set(deviceId, {
            ...peer,
            driveLetter
          });
        }
        return copy;
      });
      if (driveLetter) {
        addLog(`File system mounted for device ${deviceId.slice(0, 8)} on drive ${driveLetter}`);
      } else {
        addLog(`File system unmounted for device ${deviceId.slice(0, 8)}`);
      }
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
      setActiveModal({
        type: 'info',
        title: 'Rename Failed',
        message: err.message,
        confirmLabel: 'OK',
        onConfirm: () => setActiveModal(null),
      });
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
      setActiveModal({
        type: 'info',
        title: 'Rename Failed',
        message: err.message,
        confirmLabel: 'OK',
        onConfirm: () => setActiveModal(null),
      });
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
    const rawIps = host.split(',').map((s) => s.trim().split(':')[0]);
    const ownIp = localIdentity?.ipAddress;
    const ownIps = localIdentity?.ipAddresses || [];
    
    // Filter out own IPs to prevent self-connection
    const filteredIps = rawIps.filter((ip) => ip !== ownIp && !ownIps.includes(ip) && ip !== '127.0.0.1');

    if (filteredIps.length === 0) {
      setActiveModal({
        type: 'info',
        title: 'Connection Blocked',
        message: 'A device cannot connect to itself.',
        confirmLabel: 'OK',
        onConfirm: () => setActiveModal(null),
      });
      addLog(`Blocked manual connection to self IPs: ${rawIps.join(', ')}`);
      return;
    }

    const targetHost = filteredIps.join(',');
    addLog(`Sending manual pair request to ${targetHost}...`);
    linkApi.requestPairingByIp(targetHost).then((res: any) => {
      if (res && res.pin && res.deviceId) {
        addLog(`Pairing requested with ${res.deviceId.slice(0, 8)}. Pin: ${res.pin}`);
        setActiveModal({
          type: 'pin',
          title: 'Pairing Initiated',
          message: 'Confirm that this PIN matches the target device screen:',
          pin: res.pin,
          confirmLabel: 'Done',
          cancelLabel: 'Cancel Pairing',
          onConfirm: () => setActiveModal(null),
          onCancel: () => {
            linkApi.cancelPairing(res.deviceId);
            setActiveModal(null);
          },
        });
      } else {
        addLog(`Manual connect to ${targetHost} timed out or was rejected.`);
      }
    }).catch((err: any) => {
      addLog(`Manual connect failed: ${err.message}`);
    });
  };

  // Peer Action controls
  const handlePair = (id: string) => {
    const peerName = peers.get(id)?.name || id.slice(0, 8);
    linkApi.requestPairing(id).then((pin: string) => {
      addLog(`Pairing requested with ${peerName}. Pin: ${pin}`);
      setActiveModal({
        type: 'pin',
        title: `Pairing with ${peerName}`,
        message: 'Confirm that this PIN matches the target device screen:',
        pin,
        confirmLabel: 'Done',
        cancelLabel: 'Cancel Pairing',
        onConfirm: () => setActiveModal(null),
        onCancel: () => {
          linkApi.cancelPairing(id);
          setActiveModal(null);
        },
      });
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
      if (linkApi.sendFindMyDevice) {
        linkApi.sendFindMyDevice(id);
      } else {
        linkApi.sendFindMyPhone(id);
      }
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
        setActiveModal({
          type: 'speed-test',
          title: 'Speed Test Results',
          speedTestResults: {
            latencyMs: res.latencyMs,
            uploadSpeedMbps: res.uploadSpeedMbps,
            downloadSpeedMbps: res.downloadSpeedMbps,
          },
          confirmLabel: 'Done',
          onConfirm: () => setActiveModal(null),
        });
      })
      .catch((err: any) => {
        addLog(`Speed Test error: ${err.message}`);
        setActiveModal({
          type: 'info',
          title: 'Speed Test Failed',
          message: err.message,
          confirmLabel: 'OK',
          onConfirm: () => setActiveModal(null),
        });
      })
      .finally(() => {
        setActiveSpeedTestDeviceId(null);
      });
  };

  const handleUnpair = (id: string) => {
    // Instant UI Removal
    setPeers((prev) => {
      const copy = new Map(prev);
      copy.delete(id);
      return copy;
    });
    // Unpair the device directly
    linkApi.unpair(id);
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
              filter: 'drop-shadow(0 0 4px #009bd5)'
            }}
          >
            <defs>
              <linearGradient id="accentGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#009bd5" />
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
                background: 'rgba(0, 155, 213, 0.25)',
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
                border: '1px solid rgba(0, 155, 213, 0.4)',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                boxShadow: '0 0 25px rgba(0, 155, 213, 0.15)',
                position: 'relative',
                zIndex: 2
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="40"
                height="40"
                fill="none"
                stroke="#009bd5"
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
              color: 'var(--btn-primary-text)',
              border: 'none',
              padding: '14px 44px',
              borderRadius: '30px',
              fontWeight: 700,
              fontSize: '15px',
              cursor: 'pointer',
              boxShadow: '0 10px 25px rgba(0, 155, 213, 0.35)',
              transition: 'transform 0.15s, box-shadow 0.15s',
              position: 'relative',
              zIndex: 2
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.04)';
              e.currentTarget.style.boxShadow = '0 12px 30px rgba(0, 155, 213, 0.45)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 10px 25px rgba(0, 155, 213, 0.35)';
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
          className="popup-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20000,
          }}
        >
          <div
            className="card"
            style={{
              width: '90%',
              maxWidth: '380px',
              background: '#16161b',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 20px 48px rgba(0,0,0,0.55)',
            }}
          >
            <PendingGuestCard
              title="Pairing Request"
              guest={{
                connId: activePairRequest.deviceId,
                pin: activePairRequest.verificationKey || '------',
                remoteAddress: activePairRequest.deviceId.slice(0, 8),
                deviceName: activePairRequest.deviceName,
              }}
              subtitle="wants to pair with you"
              onAccept={() => {
                linkApi.acceptPairing(activePairRequest.deviceId);
                setActivePairRequest(null);
              }}
              onReject={() => {
                linkApi.rejectPairing(activePairRequest.deviceId, false);
                setActivePairRequest(null);
              }}
              onBlock={() => {
                linkApi.rejectPairing(activePairRequest.deviceId, true, activePairRequest.deviceName, activePairRequest.deviceType);
                setActivePairRequest(null);
              }}
            />
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

        {/* Tab content scrolls here. .main-container is overflow:hidden and no tab root declared
            a scroller of its own, so anything taller than the window was simply clipped and
            unreachable rather than scrollable. */}
        <div className="tab-scroll">
        {activeTab === 'devices' && (
          <ConnectionsTab
            peers={peers}
            localDeviceType={localIdentity.deviceType}
            volumeSinks={volumeSinks}
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
            discoveredPeers={discoveredPeers}
            visibilityEnabled={visibilityEnabled}
            onVisibilityToggle={handleVisibilityToggle}
            onConnect={handleConnect}
            showAddDevice={showAddDevice}
            onSetShowAddDevice={setShowAddDevice}
            onShowFileExplorer={(id) => setActiveFileExplorerDeviceId(id)}
          />
        )}

        {activeTab === 'notifications' && (
          <NotificationsTab
            notifications={notifications}
            peers={peers}
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
            walkieTalkieActive={walkieTalkieActive}
            onOpenWalkieTalkie={() => setWalkieTalkieOpen(true)}
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
            visibilityEnabled={visibilityEnabled}
            onVisibilityToggle={handleVisibilityToggle}
          />
        )}
        </div>
      </div>
    </div>

      {/* Walkie Talkie — permanently mounted (not tied to activeTab) so navigating to a different
          tab and back doesn't end an active session; see walkieTalkieOpen's declaration comment
          above for why. Just shown/hidden via CSS instead. */}
      <div
        style={{
          display: walkieTalkieOpen ? 'flex' : 'none',
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          zIndex: 1000,
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '540px',
            backgroundColor: 'var(--modal-bg)',
            border: '1px solid var(--border-color)',
            borderRadius: '16px',
            padding: '20px 24px',
            boxShadow: '0 20px 50px var(--modal-shadow)',
          }}
        >
          <ToolModalHeader title="Walkie Talkie" onClose={() => setWalkieTalkieOpen(false)} />
          <WalkieTalkieTab
            peers={peers}
            localIdentity={localIdentity}
            isMobile={typeof (window as any).Capacitor !== 'undefined'}
            onSessionActiveChange={setWalkieTalkieActive}
          />
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

      {activeFileExplorerDeviceId && (
        <div
          className="popup-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            // No backdrop-filter. This element covers the whole viewport, so a blur here makes
            // the compositor re-snapshot and re-blur the entire window every time anything
            // inside it repaints — which, with a scrolling file list on top, is every frame.
            // The cost is proportional to window area, so it was invisible in a small window and
            // crippling maximized. At 82% opaque there is almost nothing showing through to blur.
            background: 'rgba(0, 0, 0, 0.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
        >
          <div
            className="card"
            style={{
              width: '90%',
              maxWidth: '800px',
              height: '80%',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              background: 'var(--modal-bg)',
              border: '1px solid var(--border-color)',
              boxShadow: '0 25px 60px var(--modal-shadow)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <FileExplorerTab
              deviceId={activeFileExplorerDeviceId}
              deviceName={peers.get(activeFileExplorerDeviceId)?.name || 'Device'}
              onClose={() => setActiveFileExplorerDeviceId(null)}
            />
          </div>
        </div>
      )}

      {/* Mobile-to-mobile presenter: this device is being controlled by a peer */}
      {presenterDotSourceDeviceId && (
        <PresenterDotOverlay
          moveHandlerRef={presenterMoveHandlerRef}
          onClose={() => setPresenterDotSourceDeviceId(null)}
        />
      )}

      {/* Mobile-to-mobile/desktop-to-mobile digitizer target overlay */}
      {digitizerSourceDeviceId && (
        <DigitizerDotOverlay
          moveHandlerRef={digitizerMoveHandlerRef}
          onClose={() => setDigitizerSourceDeviceId(null)}
          sessionWidth={digitizerSessionWidth}
          sessionHeight={digitizerSessionHeight}
        />
      )}

      {/* Custom Modal Dialog */}
      {activeModal && <ModalDialog {...activeModal} />}
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
                border: '2px solid ' + (error ? '#ef4444' : 'var(--accent-color, #009bd5)'),
                background: filled ? (error ? '#ef4444' : 'var(--accent-color, #009bd5)') : 'transparent',
                boxShadow: filled ? '0 0 10px ' + (error ? '#ef4444' : 'var(--accent-color, #009bd5)') : 'none',
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
