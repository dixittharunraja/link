import React, { useState, useEffect, useRef, useCallback } from 'react';
import DesktopTitleBar from './components/DesktopTitleBar';
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
import RemoteInputOverlay from './components/RemoteInputOverlay';
import RemoteControlViewer from './components/RemoteControlViewer';
import JoystickOverlay, {
  DEFAULT_CUSTOM_LAYOUT, DEFAULT_DRIVING_LAYOUT,
  isBuiltinLayout, JoystickLayout, CustomPreset, ActiveModes, DEFAULT_ACTIVE_MODES,
  loadCustomPresetsFromStorage, loadJoystickSkinFromStorage, loadJoystickHapticsFromStorage,
  loadJoystickLayoutFromStorage, loadJoystickBuiltinModesFromStorage,
  SKIN_STORAGE_KEY, HAPTICS_STORAGE_KEY, LAYOUT_STORAGE_KEY, CUSTOM_PRESETS_STORAGE_KEY,
  BUILTIN_MODES_STORAGE_KEY, genPresetId, nextPresetName, BuiltinModes,
} from './components/JoystickOverlay';
import { FilesTab, hasFileAccess } from './components/FileExplorerTab';
import { CustomSelect } from './components/CustomSelect';
import ModalDialog, { ModalDialogProps } from './components/ModalDialog';
import PageHeader from './components/shared/PageHeader';
import { Smartphone, FolderTree, Wrench, Bell, Terminal, Settings2 } from 'lucide-react';
import { pushBackHandler, handleHardwareBack } from './utils/backNav';
import { GUEST_REMOTE_CONTROL_ID, IS_ANDROID } from './utils/platform';
import { LinkApi } from './vite-env';
import { PeerDevice, VolumeSink, CommandEntry } from './types/peer';

// linkApi global reference
const linkApi = (window as any).link as LinkApi;

// Only the Settings tab's diagnostics pane ever displays these, and only the tail is useful.
const MAX_LOG_LINES = 300;
// Notifications are keyed and de-duplicated, but only a matching cancel packet removes one.
const MAX_NOTIFICATIONS = 200;

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

const titleMap: Record<string, string> = {
  'devices': 'Connections',
  'notifications': 'Notifications',
  'commands': 'Shell Commands',
  'tools': 'Tools',
  'files': 'File Explorer',
  'settings': 'Settings'
};

const iconMap: Record<string, any> = {
  'devices': Smartphone,
  'files': FolderTree,
  'tools': Wrench,
  'notifications': Bell,
  'commands': Terminal,
  'settings': Settings2,
};

const VALID_TABS = ['devices', 'files', 'tools', 'notifications', 'commands', 'settings'];

const getInitialTab = (): string => {
  try {
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (VALID_TABS.includes(hash)) return hash;
    const stored = sessionStorage.getItem('link_active_tab');
    if (stored && VALID_TABS.includes(stored)) return stored;
  } catch {}
  return 'devices';
};

const App: React.FC = () => {
  // Tab State — restores current tab on reload from URL hash or sessionStorage
  const [activeTab, setActiveTab] = useState<string>(getInitialTab);
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

  // Pull down refresh state
  const [pullDistance, setPullDistance] = useState<number>(0);

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
  const [activeRemoteControlMode, setActiveRemoteControlMode] = useState<'presenter' | 'touchpad' | 'joystick' | null>(null);
  const [activeRemoteControlDeviceId, setActiveRemoteControlDeviceId] = useState<string | null>(null);
  // What's actually being controlled — lets PresenterOverlay pick portrait vs landscape from the
  // real target, the same way RemoteControlViewer already does from the mirrored frame's aspect,
  // instead of always assuming a desktop target.
  const [activeRemoteControlHostDeviceType, setActiveRemoteControlHostDeviceType] = useState<string | undefined>(undefined);
  // Remote Control Viewer State
  const [activeRemoteControlViewerDeviceId, setActiveRemoteControlViewerDeviceId] = useState<string | null>(null);
  // What kind of device an unpaired remote control viewer is looking at; a paired one has a peer entry.
  const [guestRemoteControlHostType, setGuestRemoteControlHostType] = useState<string | undefined>();

  // A host that kicks or loses the unpaired viewer ends the session; there is no peer state to show it.
  useEffect(() => {
    if (activeRemoteControlViewerDeviceId !== GUEST_REMOTE_CONTROL_ID) return;
    const close = () => setActiveRemoteControlViewerDeviceId(null);
    const unsubClosed = linkApi?.onInputGuestClosed?.(close);
    const unsubError = linkApi?.onInputGuestError?.(close);
    return () => {
      unsubClosed?.();
      unsubError?.();
    };
  }, [activeRemoteControlViewerDeviceId]);
  // Which device's files the Files tab is showing — driven by the switcher in the page title
  // row, not a picker grid inside the tab itself (see FilesTab.tsx).
  const [filesSelectedDeviceId, setFilesSelectedDeviceId] = useState<string | null>(null);

  // Joystick controller state for trusted-device launch from DeviceControlPanel
  const [joystickSkin, setJoystickSkin] = useState<'xbox' | 'ps'>(loadJoystickSkinFromStorage);
  const [joystickHaptics, setJoystickHaptics] = useState<boolean>(loadJoystickHapticsFromStorage);
  const [joystickCustomPresets, setJoystickCustomPresets] = useState<CustomPreset[]>(loadCustomPresetsFromStorage);
  const [joystickLayout, setJoystickLayout] = useState<JoystickLayout>(loadJoystickLayoutFromStorage);
  const [joystickBuiltinModes, setJoystickBuiltinModes] = useState<BuiltinModes>(loadJoystickBuiltinModesFromStorage);

  const setAndPersistJoystickSkin = (v: 'xbox' | 'ps') => {
    setJoystickSkin(v);
    try { localStorage.setItem(SKIN_STORAGE_KEY, v); } catch {}
  };
  const setAndPersistJoystickHaptics = (v: boolean) => {
    setJoystickHaptics(v);
    try { localStorage.setItem(HAPTICS_STORAGE_KEY, v ? 'on' : 'off'); } catch {}
  };
  const setAndPersistJoystickLayout = (v: JoystickLayout) => {
    setJoystickLayout(v);
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, v); } catch {}
  };
  const setAndPersistJoystickCustomPresets = (v: CustomPreset[]) => {
    setJoystickCustomPresets(v);
    try { localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(v)); } catch {}
  };
  const setAndPersistJoystickBuiltinModes = (v: BuiltinModes) => {
    setJoystickBuiltinModes(v);
    try { localStorage.setItem(BUILTIN_MODES_STORAGE_KEY, JSON.stringify(v)); } catch {}
  };

  const resolvedJoystickLayout = isBuiltinLayout(joystickLayout) || joystickCustomPresets.some((p) => p.id === joystickLayout)
    ? joystickLayout : 'classic';
  const activeJoystickPresetForModes = joystickCustomPresets.find((p) => p.id === resolvedJoystickLayout);
  const activeJoystickModes: ActiveModes = isBuiltinLayout(resolvedJoystickLayout)
    ? joystickBuiltinModes[resolvedJoystickLayout]
    : (activeJoystickPresetForModes?.modes || DEFAULT_ACTIVE_MODES);

  const setActiveJoystickModes = (patch: Partial<ActiveModes>) => {
    if (isBuiltinLayout(resolvedJoystickLayout)) {
      setAndPersistJoystickBuiltinModes({
        ...joystickBuiltinModes,
        [resolvedJoystickLayout]: { ...joystickBuiltinModes[resolvedJoystickLayout], ...patch },
      });
    } else {
      updateJoystickPreset(resolvedJoystickLayout, { modes: { ...activeJoystickModes, ...patch } });
    }
  };

  const createJoystickPresetFromActive = () => {
    const base = joystickCustomPresets.find((p) => p.id === resolvedJoystickLayout);
    const newPreset: CustomPreset = base
      ? { ...base, id: genPresetId(), name: nextPresetName(base.name, joystickCustomPresets), positions: { ...base.positions } }
      : {
          id: genPresetId(),
          name: nextPresetName(resolvedJoystickLayout === 'driving' ? 'Driving' : 'Classic', joystickCustomPresets),
          dpadMode: 'combined', faceMode: 'combined',
          modes: { ...activeJoystickModes },
          positions: resolvedJoystickLayout === 'classic' ? DEFAULT_CUSTOM_LAYOUT : DEFAULT_DRIVING_LAYOUT,
        };
    setAndPersistJoystickCustomPresets([...joystickCustomPresets, newPreset]);
    setAndPersistJoystickLayout(newPreset.id);
  };

  const deleteJoystickPreset = (id: string) => {
    setAndPersistJoystickCustomPresets(joystickCustomPresets.filter((p) => p.id !== id));
    if (resolvedJoystickLayout === id) setAndPersistJoystickLayout('classic');
  };

  const [pendingToolLaunch, setPendingToolLaunch] = useState<{ mode: 'presenter' | 'touchpad'; deviceIdOrIp: string } | null>(null);
  const pendingToolLaunchRef = useRef(pendingToolLaunch);
  useEffect(() => { pendingToolLaunchRef.current = pendingToolLaunch; }, [pendingToolLaunch]);

  const renameJoystickPreset = (id: string, name: string) => {
    setAndPersistJoystickCustomPresets(joystickCustomPresets.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  const updateJoystickPreset = (id: string, patch: Partial<CustomPreset>) => {
    setAndPersistJoystickCustomPresets(joystickCustomPresets.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };
  // Mobile-to-mobile presenter: this device is BEING controlled by a peer (not the controller).
  // Set as soon as the first position update arrives; cleared on stop/close.
  const [presenterDotSourceDeviceId, setPresenterDotSourceDeviceId] = useState<string | null>(null);
  const presenterMoveHandlerRef = useRef<PresenterMoveHandler | null>(null);

  const [mobilePermissions, setMobilePermissions] = useState<Record<string, string>>({
    phoneState: 'denied',
    contacts: 'denied',
    notifications: 'denied',
    notificationAccess: 'denied',
    notificationsSend: 'denied',
    microphone: 'denied',
    allFiles: 'denied',
    dnd: 'denied',
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

  // Keeps the Files switcher pointed at something valid: falls back to another eligible device if
  // the current one disconnects or loses file access, and auto-picks the first eligible device
  // when nothing is selected yet — so opening the tab shows files immediately rather than an
  // empty state the user has to clear via the dropdown first.
  useEffect(() => {
    const eligible = Array.from(peers.values()).filter(hasFileAccess);
    const stillEligible = filesSelectedDeviceId && eligible.some((p) => p.deviceId === filesSelectedDeviceId);
    if (!stillEligible) {
      setFilesSelectedDeviceId(eligible[0]?.deviceId || null);
    }
  }, [peers, filesSelectedDeviceId]);

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

  const handleSetActiveTab = (tab: string, pushHistory = true) => {
    if (!VALID_TABS.includes(tab)) return;
    setActiveTab(tab);
    try {
      sessionStorage.setItem('link_active_tab', tab);
      if (pushHistory && window.location.hash.replace(/^#\/?/, '') !== tab) {
        window.history.pushState({ tab }, '', `#${tab}`);
      }
    } catch {}
    if (tab === 'settings') {
      updatePermissionsUI();
    }
  };

  // Sync browser back/forward and reload state with activeTab
  useEffect(() => {
    const handlePopState = () => {
      const hash = window.location.hash.replace(/^#\/?/, '');
      if (VALID_TABS.includes(hash)) {
        setActiveTab(hash);
        try {
          sessionStorage.setItem('link_active_tab', hash);
        } catch {}
        if (hash === 'settings') {
          updatePermissionsUI();
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('hashchange', handlePopState);

    // Ensure initial hash reflects activeTab
    const currentHash = window.location.hash.replace(/^#\/?/, '');
    if (currentHash !== activeTab) {
      window.history.replaceState({ tab: activeTab }, '', `#${activeTab}`);
    }

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('hashchange', handlePopState);
    };
  }, []);

  // Hardware back button (Android): LinkMainActivity forwards a real onBackPressed() into a
  // 'linkHardwareBack' DOM event instead of exiting/backgrounding the app itself, so any level of
  // in-app navigation gets first refusal. Root-level fallback here returns to the Devices tab;
  // if we're already there, handleHardwareBack() returns false and we ask native to minimize
  // instead of leaving the button doing nothing.
  useEffect(() => {
    if (!IS_ANDROID) return;
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

  // Back handler for generic App modal dialogs (ModalDialog)
  useEffect(() => {
    if (!activeModal) return;
    return pushBackHandler(() => {
      if (activeModal.onCancel) activeModal.onCancel();
      else if (activeModal.onConfirm) activeModal.onConfirm();
      else setActiveModal(null);
      return true;
    });
  }, [activeModal]);

  // Back handler for active incoming pair requests. Backing out is a plain decline, never a block —
  // same as the dialog's Reject button (blocking is a deliberate, separate choice).
  useEffect(() => {
    if (!activePairRequest) return;
    return pushBackHandler(() => {
      linkApi.rejectPairing(activePairRequest.deviceId, false);
      setActivePairRequest(null);
      return true;
    });
  }, [activePairRequest]);

  // The device being controlled removed us: close the presenter / touchpad screen instead of
  // leaving it up with nothing behind it. Read through a ref, since this subscribes once.
  const remoteControlModeRef = useRef(activeRemoteControlMode);
  remoteControlModeRef.current = activeRemoteControlMode;
  useEffect(() => {
    const unsubscribe = linkApi?.onInputKicked?.(() => {
      if (remoteControlModeRef.current === 'presenter' || remoteControlModeRef.current === 'touchpad') {
        setActiveRemoteControlMode(null);
        setActiveRemoteControlDeviceId(null);
      }
    });
    return () => unsubscribe?.();
  }, []);

  // Back handler for active Remote Control mode (Presenter / Touchpad / Digitizer)
  useEffect(() => {
    if (!activeRemoteControlMode) return;
    return pushBackHandler(() => {
      if (activeRemoteControlMode === 'presenter' && activeRemoteControlDeviceId && linkApi) {
        linkApi.sendPresenterStop?.(activeRemoteControlDeviceId);
      }
      setActiveRemoteControlMode(null);
      setActiveRemoteControlDeviceId(null);
      return true;
    });
  }, [activeRemoteControlMode, activeRemoteControlDeviceId, linkApi]);

  useEffect(() => {
    if (!IS_ANDROID) return;
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
    const reconcileConnectedDevices = () => {
      if (!linkApi.getConnectedDevices) return;
      linkApi.getConnectedDevices()
        .then((list: any[]) => {
          if (!list || list.length === 0) return;
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
                allowedCapabilities: identity.allowedCapabilities || [],
                driveLetter: identity.driveLetter,
                trusted: identity.trusted,
                connected: identity.trusted,
              });
            });
            return copy;
          });
        })
        .catch((err: any) => addLog(`Failed to load connected devices: ${err.message}`));
    };
    reconcileConnectedDevices();

    // Brings the device list in line with the trust store and the live connections. Used after
    // anything that changes who is paired, so the list never waits for a reload to catch up.
    const refreshDevices = () => {
      linkApi.getTrustedDevices()
        .then((list: any[]) => {
          setPeers((prev) => {
            const copy = new Map(prev);
            list.forEach((d: any) => {
              const existing = copy.get(d.deviceId);
              copy.set(d.deviceId, existing
                ? { ...existing, name: existing.name || d.deviceName, ipAddress: existing.ipAddress || d.ipAddress, trusted: true }
                : { deviceId: d.deviceId, name: d.deviceName, ipAddress: d.ipAddress, deviceType: d.deviceType || 'phone', trusted: true, connected: false });
            });
            return copy;
          });
        })
        .catch((err: any) => addLog(`Failed to refresh trusted devices: ${err.message}`));
      reconcileConnectedDevices();
    };

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

    linkApi.onTrustListUpdated?.(() => {
      addLog('Trust list updated from pool');
      refreshDevices();
      linkApi.getPermissions?.()
        .then((perms: any) => {
          if (perms) setDevicePermissions(perms);
        })
        .catch(() => {});
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
      refreshDevices();
      linkApi.getPermissions()
        .then((perms: any) => setDevicePermissions(perms || {}))
        .catch((err: any) => addLog(`Failed to refresh permissions after pairing: ${err.message}`));
      const pending = pendingToolLaunchRef.current;
      if (pending) {
        setPendingToolLaunch(null);
        setActiveModal(null);
        setActiveRemoteControlDeviceId(deviceId);
        setActiveRemoteControlMode(pending.mode);
      } else {
        handleSetActiveTab('devices');
        setShowAddDevice(false);

        setActiveModal({
          type: 'info',
          title: 'Device Connected',
          message: `${peerName} is now connected. Open its settings (the gear icon) to choose what to sync.`,
          confirmLabel: 'Got It',
          onConfirm: () => setActiveModal(null),
        });
      }
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

    linkApi.onFindMyDeviceTriggered(handleDeviceRingTriggered);
    linkApi.onFindMyDeviceStopped(handleDeviceRingStopped);

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

    let isPromptingRemoteControl = false;
    linkApi.onRemoteControlSignal?.(async (deviceId: string, signal: any) => {
      console.log('[RemoteControl] Received signal:', signal, 'from:', deviceId);
      if (!signal) return;
      if (signal.type === 'request') {
        if (linkApi?.isMobile) {
          if (isPromptingRemoteControl) {
            console.log('[RemoteControl] Prompt already in progress, ignoring duplicate request');
            return;
          }
          isPromptingRemoteControl = true;
          // Mobile acts as host: show native MediaProjection consent dialog, then
          // LinkRemoteControlServer starts pumping JPEG frames directly as
          // link.remotecontrol.stream packets to the requesting peer.
          try {
            console.log('[RemoteControl] Prompting MediaProjection consent on mobile host for', deviceId);
            // startActivityForResult (native side) can't reliably present the system consent
            // dialog while this app's own Activity isn't in the foreground — Android's
            // background-activity-launch restriction — and when that happens the call doesn't
            // throw, it just never resolves (onMediaProjectionResultRemoteControl's callback
            // never fires because the dialog never actually appeared). Without a timeout here,
            // isPromptingRemoteControl stayed stuck true forever after exactly that scenario,
            // silently swallowing every future request (from any device) until the app was
            // force-restarted — this is why it sometimes "did nothing" even with the UI open: a
            // PRIOR hung attempt, not the current one, was the actual cause.
            // 15 s, not longer: on a first launch the dialog sometimes never appears, and the viewer's
            // repeated requests are only honoured once this attempt has been given up.
            const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 15000));
            const granted = await Promise.race([
              linkApi.requestRemoteControlHost?.(deviceId) ?? Promise.resolve(false),
              timeout,
            ]);
            console.log('[RemoteControl] MediaProjection consent result:', granted);
            if (!granted) {
              linkApi.sendRemoteControlSignal?.(deviceId, { type: 'denied' });
            }
            // No further action needed — LinkRemoteControlServer runs in the background
            // and sends frames autonomously until linkApi.stopRemoteControlHost() is called.
          } catch (err) {
            console.error('[RemoteControl] requestRemoteControlHost error:', err);
            linkApi.sendRemoteControlSignal?.(deviceId, { type: 'denied' });
          } finally {
            isPromptingRemoteControl = false;
          }
        }
      } else if (signal.type === 'stop') {
        if (linkApi?.isMobile) {
          isPromptingRemoteControl = false;
          linkApi.stopRemoteControlHost?.();
        }
      }
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
    if (!IS_ANDROID) return;

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
        return;
      }

      if (diffY > 0) {
        // Prevent default scrolling only when actively dragging down to pull-to-refresh
        if (e.cancelable) e.preventDefault();
        distance = Math.min(diffY * 0.4, 110);
        setPullDistance(distance);
      } else {
        pulling = false;
        setPullDistance(0);
      }
    };

    const handleTouchEnd = () => {
      if (!pulling) return;
      pulling = false;

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
          cancelLabel: 'Cancel Pairing',
          // No confirm button on purpose — there's nothing to confirm here yet. Success replaces
          // this modal outright via onPairingSuccessful below; the only thing the user can
          // actually decide from this dialog is to back out.
          onCancel: () => {
            linkApi.cancelPairing(res.deviceId);
            setActiveModal(null);
          },
        });
      } else {
        addLog(`Manual connect to ${targetHost} timed out or was rejected.`);
      }
    }).catch((err: any) => showPairingError(err));
  };

  // A pair request that can't reach the device must say so; otherwise clicking Pair just does nothing.
  const showPairingError = (err: unknown) => {
    const reason = typeof err === 'string' ? err : (err as Error)?.message || 'Could not reach the device';
    addLog(`Pairing failed: ${reason}`);
    setActiveModal({
      type: 'info',
      title: 'Could not start pairing',
      message: reason,
      confirmLabel: 'OK',
      onConfirm: () => setActiveModal(null),
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
        cancelLabel: 'Cancel Pairing',
        // See the manual-connect pairing dialog above for why there's no confirm button here.
        onCancel: () => {
          linkApi.cancelPairing(id);
          setActiveModal(null);
        },
      });
    }).catch((err: any) => showPairingError(err));
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
      linkApi.sendFindMyDevice(id);
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

  const handleToolConnect = async (mode: 'presenter' | 'touchpad', target: string, hostDeviceType?: string) => {
    const rawTarget = target.trim();
    if (!rawTarget) return;

    let targetIp = rawTarget;
    if (targetIp.startsWith('link:')) {
      const parts = targetIp.split(':');
      if (parts.length >= 2) targetIp = parts[1];
    } else if (targetIp.startsWith('http://') || targetIp.startsWith('https://')) {
      targetIp = targetIp.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    } else if (targetIp.includes(':')) {
      targetIp = targetIp.split(':')[0];
    }

    const normalizeIp = (i: string) => i.replace(/^::ffff:/, '').trim();
    const cleanTargetIp = normalizeIp(targetIp);

    // 1. Check if the target matches any already-paired / connected peer by deviceId or IP
    let matchedPeer: PeerDevice | undefined;
    if (peers.has(rawTarget)) {
      matchedPeer = peers.get(rawTarget);
    } else {
      matchedPeer = Array.from(peers.values()).find((p) => p.ipAddress && normalizeIp(p.ipAddress) === cleanTargetIp);
    }

    if (matchedPeer && matchedPeer.trusted) {
      // Already trusted — open overlay directly using deviceId
      setActiveRemoteControlDeviceId(matchedPeer.deviceId);
      setActiveRemoteControlMode(mode);
      setActiveRemoteControlHostDeviceType(matchedPeer.deviceType);
      return;
    }

    // 2. Ephemeral Guest Session (admitted by InputGuestServer via Tools tab HostConnectModal).
    // hostDeviceType comes from the admission handshake itself (see PresenterTab.tsx / RemoteInputTab.tsx), not from
    // cleanTargetIp here — that's the QR/typed target, which can be a comma-joined list of the
    // host's several local IPs and was never reliable for anything but connecting.
    setActiveRemoteControlDeviceId(cleanTargetIp);
    setActiveRemoteControlMode(mode);
    setActiveRemoteControlHostDeviceType(hostDeviceType);
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
            position: 'fixed',
            top: 'max(14px, env(safe-area-inset-top, 14px))',
            left: '50%',
            transform: `translateX(-50%) translateY(${Math.min(pullDistance, 90)}px)`,
            opacity: Math.min(1, pullDistance / 45),
            zIndex: 99999,
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
              title="Add to Trusted Pool"
              iconType="trust"
              acceptLabel="Accept"
              guest={{
                connId: activePairRequest.deviceId,
                pin: activePairRequest.verificationKey || '------',
                remoteAddress: activePairRequest.deviceId.slice(0, 8),
                deviceName: activePairRequest.deviceName,
              }}
              subtitle="wants to join your trusted pool"
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
        {IS_ANDROID ? (
          <TopBar
            deviceName={localIdentity.deviceName}
            ipAddress={localIdentity.ipAddress}
            ipAddresses={localIdentity.ipAddresses}
            isMobile={true}
          />
        ) : (
          <DesktopTitleBar
            isMobile={false}
            deviceName={localIdentity.deviceName}
            ipAddress={localIdentity.ipAddress}
            ipAddresses={localIdentity.ipAddresses}
          />
        )}

        <div id="main-content-split" style={{ display: 'flex', flexGrow: 1, width: '100%', overflow: 'hidden' }}>
          <Sidebar
            activeTab={activeTab}
            setActiveTab={handleSetActiveTab}
            isMobile={IS_ANDROID}
          />

          <div className="main-container">
            {/* Tab content scrolls with LifeOS standard page container and max-width layout */}
            <div className="tab-scroll">
              <div className="page-container">
                <PageHeader
                  title={titleMap[activeTab]}
                  icon={iconMap[activeTab]}
                >
                  {/* Which device's files are shown — lives in PageHeader right actions */}
                  {activeTab === 'files' && (() => {
                    const eligible = Array.from(peers.values()).filter(hasFileAccess);
                    if (eligible.length === 0) return null;
                    return (
                      <CustomSelect
                        value={filesSelectedDeviceId || ''}
                        onChange={(val) => setFilesSelectedDeviceId(val)}
                        options={eligible.map((p) => ({
                          value: p.deviceId,
                          label: p.name,
                          deviceType: p.deviceType,
                        }))}
                        style={{ minWidth: '180px' }}
                      />
                    );
                  })()}
                </PageHeader>

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
                      setActiveRemoteControlHostDeviceType(peers.get(id)?.deviceType);
                    }}
                    onShowTouchpad={(id) => {
                      setActiveRemoteControlDeviceId(id);
                      setActiveRemoteControlMode('touchpad');
                    }}
                    onShowJoystick={(id) => {
                      const peer = peers.get(id);
                      const targetHost = peer?.ipAddress || id;
                      setActiveRemoteControlDeviceId(targetHost);
                      setActiveRemoteControlMode('joystick');
                      linkApi?.sendJoystickHello?.(targetHost, localIdentity?.deviceName || 'Player');
                    }}
                    onShowRemoteControl={(id) => {
                      setActiveRemoteControlViewerDeviceId(id);
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
                  />
                )}

                {activeTab === 'files' && (
                  <FilesTab peers={peers} selectedDeviceId={filesSelectedDeviceId} />
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
                    isMobile={IS_ANDROID}
                    walkieTalkieActive={walkieTalkieActive}
                    remoteControlViewing={activeRemoteControlViewerDeviceId !== null}
                    onOpenWalkieTalkie={() => setWalkieTalkieOpen(true)}
                    onShowPresenter={(id, hostDeviceType) => handleToolConnect('presenter', id, hostDeviceType)}
                    onShowTouchpad={(id) => handleToolConnect('touchpad', id)}
                    onShowRemoteControl={(hostDeviceType) => {
                      setGuestRemoteControlHostType(hostDeviceType);
                      setActiveRemoteControlViewerDeviceId(GUEST_REMOTE_CONTROL_ID);
                    }}
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
                    isMobile={IS_ANDROID}
                    mobilePermissions={mobilePermissions}
                    onRequestMobilePermission={handleRequestMobilePermission}
                    screensaverInhibitEnabled={screensaverInhibitEnabled}
                    onScreensaverInhibitToggle={handleScreensaverInhibitToggle}
                    openAtLogin={openAtLogin}
                    onOpenAtLoginToggle={handleOpenAtLoginToggle}
                    closeToTray={closeToTray}
                    onCloseToTrayToggle={handleCloseToTrayToggle}
                    visibilityEnabled={visibilityEnabled}
                    onVisibilityToggle={handleVisibilityToggle}
                  />
                )}
              </div>
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
            isMobile={IS_ANDROID}
            onSessionActiveChange={setWalkieTalkieActive}
          />
        </div>
      </div>

      {/* Full-Screen Input Overlays (Mobile Only) */}
      {activeRemoteControlMode === 'presenter' && activeRemoteControlDeviceId && (
        <PresenterOverlay
          deviceId={activeRemoteControlDeviceId}
          hostDeviceType={activeRemoteControlHostDeviceType}
          onClose={() => {
            linkApi?.leaveInputGuest?.();
            setActiveRemoteControlMode(null);
            setActiveRemoteControlDeviceId(null);
            setActiveRemoteControlHostDeviceType(undefined);
          }}
        />
      )}

      {activeRemoteControlMode === 'touchpad' && activeRemoteControlDeviceId && (
        <RemoteInputOverlay
          deviceId={activeRemoteControlDeviceId}
          onClose={() => {
            linkApi?.leaveInputGuest?.();
            setActiveRemoteControlMode(null);
            setActiveRemoteControlDeviceId(null);
          }}
        />
      )}

      {activeRemoteControlMode === 'joystick' && activeRemoteControlDeviceId && (
        <JoystickOverlay
          host={activeRemoteControlDeviceId}
          skin={joystickSkin}
          onSkinChange={setAndPersistJoystickSkin}
          haptics={joystickHaptics}
          onHapticsChange={setAndPersistJoystickHaptics}
          layout={resolvedJoystickLayout}
          onLayoutChange={setAndPersistJoystickLayout}
          modes={activeJoystickModes}
          onModesChange={setActiveJoystickModes}
          customPresets={joystickCustomPresets}
          onCreatePreset={createJoystickPresetFromActive}
          onDeletePreset={deleteJoystickPreset}
          onRenamePreset={renameJoystickPreset}
          onUpdatePreset={updateJoystickPreset}
          onClose={() => {
            if (activeRemoteControlDeviceId) linkApi?.sendJoystickBye?.(activeRemoteControlDeviceId);
            setActiveRemoteControlMode(null);
            setActiveRemoteControlDeviceId(null);
          }}
          onDisconnected={() => {
            setActiveRemoteControlMode(null);
            setActiveRemoteControlDeviceId(null);
          }}
        />
      )}

      {/* Mobile-to-mobile presenter: this device is being controlled by a peer */}
      {presenterDotSourceDeviceId && (
        <PresenterDotOverlay
          moveHandlerRef={presenterMoveHandlerRef}
          onClose={() => setPresenterDotSourceDeviceId(null)}
        />
      )}

      {/* Remote Control Viewer */}
      {activeRemoteControlViewerDeviceId && (
        <RemoteControlViewer
          deviceId={activeRemoteControlViewerDeviceId}
          deviceName={peers.get(activeRemoteControlViewerDeviceId)?.name || 'Remote Device'}
          hostDeviceType={activeRemoteControlViewerDeviceId === GUEST_REMOTE_CONTROL_ID ? guestRemoteControlHostType : peers.get(activeRemoteControlViewerDeviceId)?.deviceType}
          hostConnected={peers.get(activeRemoteControlViewerDeviceId)?.connected}
          onClose={() => setActiveRemoteControlViewerDeviceId(null)}
          onEndSession={() => setActiveRemoteControlViewerDeviceId(null)}
        />
      )}

      {/* Custom Modal Dialog */}
      {activeModal && <ModalDialog {...activeModal} />}
      </div>
    </>
  );
};

export default App;
