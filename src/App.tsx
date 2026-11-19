import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import type { ShareOffer } from './vite-env';
import { startLocationTracking } from './utils/deviceLocation';
import DesktopTitleBar from './components/DesktopTitleBar';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ConnectionsTab from './components/ConnectionsTab';
import { PendingGuestCard } from './components/ModalDialog';
import NotificationsTab from './components/NotificationsTab';
import CommandsTab from './components/CommandsTab';
import { ToolModalHeader } from './components/ToolModalHeader';
// Shown at startup on a first run, so it is kept in the main bundle to avoid a flash of the main UI.
const OnboardingWizard = lazy(() => import('./components/OnboardingWizard'));
import PullToRefresh from './components/PullToRefresh';
// Eager: pointer moves that arrive while it was still loading would be lost, shifting the dot.
import PresenterDotOverlay, { PresenterMoveHandler } from './components/PresenterDotOverlay';
import { cameraManager } from './utils/cameraManager';
import { useJoystickSettings } from './hooks/useJoystickSettings';
import { hasFileAccess } from './utils/fileAccess';
import { appendLog } from './utils/logStore';
import { CustomSelect } from './components/CustomSelect';
import ModalDialog, { ModalDialogProps } from './components/ModalDialog';
import PageHeader from './components/shared/PageHeader';
import { Smartphone, FolderTree, Wrench, Bell, Terminal, Settings2 } from 'lucide-react';
import { pushBackHandler, handleHardwareBack } from './utils/backNav';
import { GUEST_REMOTE_CONTROL_ID, IS_ANDROID, IS_TV } from './utils/platform';
import { collectSubscriptions } from './utils/subscriptions';
import { parsePairingQr } from './utils/qr';
import { LinkApi } from './vite-env';
import { PeerDevice, VolumeSink, CommandEntry } from './types/peer';

const linkApi = (window as any).link as LinkApi;

// Tabs other than the startup ones, and the full-screen overlays, are split out of the main bundle and loaded
// the first time they are shown (and prefetched once the app is idle, see below). The Devices tab, which the
// app opens on, stays eager.
const loadToolsTab = () => import('./components/ToolsTab');
const loadSettingsTab = () => import('./components/SettingsTab');
const loadFilesTab = () => import('./components/FileExplorerTab');
const ToolsTab = lazy(loadToolsTab);
const SettingsTab = lazy(loadSettingsTab);
const FilesTab = lazy(() => loadFilesTab().then((m) => ({ default: m.FilesTab })));
// Mounted at startup (see walkieTalkieOpen) but never visible until opened, so it can arrive a moment later.
const WalkieTalkieTab = lazy(() => import('./components/WalkieTalkieTab'));
const PresenterOverlay = lazy(() => import('./components/PresenterOverlay'));
const RemoteInputOverlay = lazy(() => import('./components/RemoteInputOverlay'));
const RemoteControlViewer = lazy(() => import('./components/RemoteControlViewer'));
const CameraViewer = lazy(() => import('./components/CameraViewer'));
const JoystickOverlay = lazy(() => import('./components/JoystickOverlay'));

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

function formatShareSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

const App: React.FC = () => {
  // Restored on reload from the URL hash or sessionStorage.
  const [activeTab, setActiveTab] = useState<string>(getInitialTab);
  const [theme, setTheme] = useState<string>(() => {
    return localStorage.getItem('link-theme') || 'system';
  });


  // Walkie Talkie's session (peer connections, mixing AudioContext, members) lives only in
  // WalkieTalkieTab's React state, with no native session to resync from on remount. It is
  // therefore mounted permanently at the app root and only shown/hidden, so leaving the Tools
  // tab does not end an active session.
  const [walkieTalkieOpen, setWalkieTalkieOpen] = useState(false);
  const [walkieTalkieActive, setWalkieTalkieActive] = useState(false);

  const [localIdentity, setLocalIdentity] = useState<{ deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string }>({
    deviceId: '',
    deviceName: 'Loading...',
  });
  const [visibilityEnabled, setVisibilityEnabled] = useState<boolean>(true);
  const [showAddDevice, setShowAddDevice] = useState<boolean>(false);
  const [screensaverInhibitEnabled, setScreensaverInhibitEnabled] = useState<boolean>(true);
  const [openAtLogin, setOpenAtLogin] = useState<boolean>(false);

  const [peers, setPeers] = useState<Map<string, PeerDevice>>(new Map());
  const [discoveredPeers, setDiscoveredPeers] = useState<Map<string, any>>(new Map());
  const [volumeSinks, setVolumeSinks] = useState<Map<string, VolumeSink[]>>(new Map());

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  const [devicePermissions, setDevicePermissions] = useState<Record<string, Record<string, boolean | string>>>({});

  // This device's own shell command whitelist.
  const [commands, setCommands] = useState<Record<string, CommandEntry>>({});
  // Whitelists received from peers, so any device can view a paired desktop's commands.
  const [peerCommandLists, setPeerCommandLists] = useState<Map<string, Record<string, CommandEntry>>>(new Map());

  const [isRingingLocal, setIsRingingLocal] = useState<boolean>(false);
  const [activeSpeedTestDeviceId, setActiveSpeedTestDeviceId] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<ModalDialogProps | null>(null);

  // Full-screen remote input overlays (mobile only).
  const [activeRemoteControlMode, setActiveRemoteControlMode] = useState<'presenter' | 'touchpad' | 'joystick' | null>(null);
  const [activeRemoteControlDeviceId, setActiveRemoteControlDeviceId] = useState<string | null>(null);
  // Type of the controlled device, so PresenterOverlay can pick portrait or landscape to match it.
  const [activeRemoteControlHostDeviceType, setActiveRemoteControlHostDeviceType] = useState<string | undefined>(undefined);
  const [activeRemoteControlViewerDeviceId, setActiveRemoteControlViewerDeviceId] = useState<string | null>(null);
  // Whether that viewer shows the PC's second screen (phone as an extended display) rather than its main screen.
  const [remoteControlSecondScreen, setRemoteControlSecondScreen] = useState(false);
  // Starts the virtual webcam's on-demand watcher (desktop only; it does nothing unless the user turned it on).
  useEffect(() => {
    if (!IS_ANDROID) void cameraManager.init();
  }, []);

  // Fetches the lazily loaded tabs once startup work is done, so the first switch to one does not wait.
  useEffect(() => {
    const prefetch = () => {
      for (const load of [loadToolsTab, loadSettingsTab, loadFilesTab]) load().catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(prefetch, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Sharing this PC's screen (on a PC without a hardware encoder) and using a phone as the webcam need Cisco's free
  // H.264 component. It is not bundled (that is what keeps its patent cover valid), so the first time it is needed
  // the user is asked once and it is downloaded from Cisco.
  useEffect(() => {
    if (IS_ANDROID) return;
    return linkApi.onH264ComponentNeeded?.((feature) => {
      const purpose = feature === 'camera' ? "To use a phone's camera as this PC's webcam" : "To share this PC's screen with a phone";
      setActiveModal({
        type: 'confirm',
        title: 'Download the video component?',
        message: `${purpose}, Link needs Cisco's free H.264 video component (about 0.5 MB). It is downloaded once from Cisco (openh264.org) and checked before it is used. Nothing else leaves your network.`,
        confirmLabel: 'Download',
        cancelLabel: 'Not now',
        onCancel: () => setActiveModal(null),
        onConfirm: async () => {
          setActiveModal(null);
          addLog('Downloading the H.264 video component from Cisco...');
          try {
            await linkApi.h264Install?.();
            addLog('The H.264 video component is installed.');
            setActiveModal({
              type: 'info',
              title: 'Video component installed',
              message: "You can start sharing this PC's screen from the phone again.",
              confirmLabel: 'OK',
              onConfirm: () => setActiveModal(null),
            });
          } catch (err: any) {
            const reason = typeof err === 'string' ? err : err?.message || 'The download failed.';
            addLog(`Video component download failed: ${reason}`);
            setActiveModal({ type: 'info', title: 'Download failed', message: reason, confirmLabel: 'OK', onConfirm: () => setActiveModal(null) });
          }
        },
      });
    });
  }, []);

  // Phones that are connected and have switched on "Allow Camera as Webcam" for this PC. The virtual
  // webcam may only ever use one of these.
  useEffect(() => {
    if (IS_ANDROID) return;
    const eligible = Array.from(peers.values())
      .filter((p) => p.deviceType === 'phone' && p.connected && p.allowedCapabilities?.includes('camera'))
      .map((p) => ({ id: p.deviceId, name: p.name || 'Phone' }));
    cameraManager.setPhones(eligible);
  }, [peers]);

  // A paired phone whose camera is being used as a webcam on this PC.
  const [activeCameraDeviceId, setActiveCameraDeviceId] = useState<string | null>(null);
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
  // Device shown in the Files tab, chosen by the switcher in the page header (see FilesTab in
  // FileExplorerTab.tsx).
  const [filesSelectedDeviceId, setFilesSelectedDeviceId] = useState<string | null>(null);

  // Joystick settings, used when the controller is launched from DeviceControlPanel.
  const joystickSettings = useJoystickSettings();

  const [pendingToolLaunch, setPendingToolLaunch] = useState<{ mode: 'presenter' | 'touchpad'; deviceIdOrIp: string } | null>(null);
  const pendingToolLaunchRef = useRef(pendingToolLaunch);
  // Capability lists that arrived for a device the UI has not created an entry for yet (the packet
  // can beat the device-connected event, or the trusted-device list at startup). Applied as soon as
  // the entry exists, otherwise the control panel would hide every control until a reload.
  const pendingCapabilitiesRef = useRef<Map<string, string[]>>(new Map());
  useEffect(() => { pendingToolLaunchRef.current = pendingToolLaunch; }, [pendingToolLaunch]);

  // Mobile-to-mobile presenter: set when a peer starts controlling this device's pointer dot
  // (on the first position update) and cleared on stop or close.
  const [presenterDotSourceDeviceId, setPresenterDotSourceDeviceId] = useState<string | null>(null);
  const presenterMoveHandlerRef = useRef<PresenterMoveHandler | null>(null);

  const [mobilePermissions, setMobilePermissions] = useState<Record<string, string>>({
    phoneState: 'denied',
    contacts: 'denied',
    notifications: 'denied',
    notificationAccess: 'denied',
    notificationsSend: 'denied',
    microphone: 'denied',
    location: 'denied',
    allFiles: 'denied',
    dnd: 'denied',
    batteryOpt: 'denied',
    accessibility: 'denied',
    overlay: 'denied',
  });

  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    return !localStorage.getItem('onboarding-completed');
  });

  const [activePairRequest, setActivePairRequest] = useState<{ deviceId: string; deviceName: string; deviceType?: string; verificationKey: string | null; viaQr?: boolean } | null>(null);

  const peersRef = useRef(peers);
  useEffect(() => { peersRef.current = peers; }, [peers]);

  const activePairRequestRef = useRef(activePairRequest);
  useEffect(() => { activePairRequestRef.current = activePairRequest; }, [activePairRequest]);

  // Keeps the Files switcher on an eligible device: falls back to another one if the current device
  // disconnects or loses file access, and picks the first one when nothing is selected, so the tab
  // opens straight onto a file list.
  useEffect(() => {
    const eligible = Array.from(peers.values()).filter(hasFileAccess);
    const stillEligible = filesSelectedDeviceId && eligible.some((p) => p.deviceId === filesSelectedDeviceId);
    if (!stillEligible) {
      setFilesSelectedDeviceId(eligible[0]?.deviceId || null);
    }
  }, [peers, filesSelectedDeviceId]);

  // Some callers log per packet (battery, speed-test progress). The log lives in utils/logStore.ts rather
  // than App state, so a log line no longer re-renders the whole app.
  const addLog = useCallback((msg: string) => appendLog(msg), []);

  // A paired device offers files to this PC. The user is always asked: Accept (then pick a folder, every time) or Reject.
  const [shareQueue, setShareQueue] = useState<ShareOffer[]>([]);
  const shownShareId = useRef<string | null>(null);
  useEffect(() => {
    if (IS_ANDROID) return;
    const unsubOffer = linkApi.onShareOffer?.((offer) =>
      setShareQueue((q) => (q.some((o) => o.transferId === offer.transferId) ? q : [...q, offer])),
    );
    const unsubClosed = linkApi.onShareOfferClosed?.((transferId) => {
      setShareQueue((q) => q.filter((o) => o.transferId !== transferId));
      if (shownShareId.current === transferId) {
        shownShareId.current = null;
        setActiveModal(null);
      }
    });
    const unsubStatus = linkApi.onShareStatus?.((status) => {
      if (status.state !== 'offered') addLog(status.message);
    });
    return () => {
      unsubOffer?.();
      unsubClosed?.();
      unsubStatus?.();
    };
  }, [addLog]);

  // Shows the oldest waiting offer whenever no other dialog is open.
  useEffect(() => {
    if (IS_ANDROID || activeModal || shareQueue.length === 0) return;
    const offer = shareQueue[0];
    const done = () => {
      shownShareId.current = null;
      setShareQueue((q) => q.filter((o) => o.transferId !== offer.transferId));
      setActiveModal(null);
    };
    shownShareId.current = offer.transferId;
    const more = offer.count > offer.names.length ? ` and ${offer.count - offer.names.length} more` : '';
    setActiveModal({
      type: 'confirm',
      title: `${offer.deviceName} wants to send you ${offer.count === 1 ? '1 file' : `${offer.count} files`}`,
      message: `${offer.names.join(', ')}${more} (${formatShareSize(offer.totalSize)}). Nothing is copied until you accept and choose where to save it.`,
      confirmLabel: 'Accept',
      cancelLabel: 'Reject',
      onCancel: () => {
        void linkApi.rejectShare?.(offer.transferId);
        done();
      },
      onConfirm: async () => {
        // The folder is asked for every time. Closing the picker leaves this prompt open.
        const dir = await linkApi.pickPortalSaveDir?.();
        if (!dir) return;
        try {
          await linkApi.acceptShare?.(offer.transferId, dir);
        } catch (err: any) {
          addLog(`Could not accept the files: ${typeof err === 'string' ? err : err?.message || 'unknown error'}`);
        }
        done();
      },
    });
  }, [activeModal, shareQueue, addLog]);

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
        // Locate: not asked on a TV, which nobody locates (see SettingsTab's TV_HIDDEN_PERMISSIONS).
        location: perms.location,
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
      if (key === 'phoneState' || key === 'contacts' || key === 'notificationsSend' || key === 'microphone' || key === 'location') {
        // Requesting an already-granted runtime permission is a silent no-op on Android, and it can
        // only be revoked from the app's system Settings page, so open that instead.
        if (mobilePermissions[key] === 'granted') {
          await linkApi.openAppSettings();
        } else {
          const targetPerm = key === 'notificationsSend' ? 'notifications' : key;
          await linkApi.requestMobilePermission(targetPerm);
          // Once granted, the background service declares the location type so Locate works with Link closed.
          if (key === 'location') await linkApi.refreshLocationAccess?.();
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
      if (pushHistory && !IS_TV && window.location.hash.replace(/^#\/?/, '') !== tab) {
        window.history.pushState({ tab }, '', `#${tab}`);
      }
    } catch {}
    if (tab === 'settings') {
      updatePermissionsUI();
    }
  };

  // Files shared to "File Transfer (Link)" from another app: open the File Transfer tool with them staged, exactly as if
  // they had been picked there.
  const [sharedFiles, setSharedFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!IS_ANDROID) return;
    const take = () => {
      Promise.resolve(linkApi.takePendingSharedFiles?.())
        .then((uris) => {
          if (uris && uris.length > 0) {
            setSharedFiles(uris);
            handleSetActiveTab('tools');
          }
        })
        .catch(() => {});
    };
    take();
    return linkApi.onSharedFiles?.(take);
  }, []);

  // Keeps browser back/forward and reloads in sync with activeTab.
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

    const currentHash = window.location.hash.replace(/^#\/?/, '');
    if (currentHash !== activeTab) {
      window.history.replaceState({ tab: activeTab }, '', `#${activeTab}`);
    }

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('hashchange', handlePopState);
    };
  }, []);

  // Android hardware back: MainActivity forwards the press as a 'linkHardwareBack' DOM event so
  // in-app navigation handles it first. This root-level handler returns to the Devices tab; when
  // already there, nothing claims the press and the app is minimized (see the listener below).
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

  // Walkie Talkie's modal lives at the app root rather than in ToolsTab, so it registers its own
  // back handler.
  useEffect(() => {
    if (!walkieTalkieOpen) return;
    return pushBackHandler(() => {
      setWalkieTalkieOpen(false);
      return true;
    });
  }, [walkieTalkieOpen]);

  // Back closes the generic ModalDialog.
  useEffect(() => {
    if (!activeModal) return;
    return pushBackHandler(() => {
      if (activeModal.onCancel) activeModal.onCancel();
      else if (activeModal.onConfirm) activeModal.onConfirm();
      else setActiveModal(null);
      return true;
    });
  }, [activeModal]);

  // Back on an incoming pair request declines it without blocking, like the Reject button.
  useEffect(() => {
    if (!activePairRequest) return;
    return pushBackHandler(() => {
      linkApi.rejectPairing(activePairRequest.deviceId, false);
      setActivePairRequest(null);
      return true;
    });
  }, [activePairRequest]);

  // Back exits the active remote input overlay.
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

  useEffect(() => {
    applyTheme(theme);

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

    // Subscriptions go through `events` so the cleanup can drop them all; otherwise a remount
    // (React.StrictMode runs effects twice) would leave every handler registered twice.
    const [events, unsubscribeAll] = collectSubscriptions(linkApi);

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

    linkApi.getIdentity()
      .then((id: any) => {
        setLocalIdentity(id);
        addLog(`Identity loaded: ${id.deviceName}`);
      })
      .catch((err: any) => addLog(`Failed to load identity: ${err.message}`));

    linkApi.getVisibility()
      .then((enabled: boolean) => setVisibilityEnabled(enabled))
      .catch((err: any) => addLog(`Failed to fetch visibility: ${err.message}`));

    linkApi.getScreensaverInhibitEnabled()
      .then((enabled: boolean) => setScreensaverInhibitEnabled(enabled))
      .catch(() => {});
    linkApi.getOpenAtLogin()
      .then((enabled: boolean) => setOpenAtLogin(enabled))
      .catch(() => {});
    linkApi.getCommands()
      .then((cmds: any) => setCommands(cmds))
      .catch((err: any) => addLog(`Failed to load commands: ${err.message}`));

    linkApi.getPermissions()
      .then((perms: any) => setDevicePermissions(perms || {}))
      .catch((err: any) => addLog(`Failed to fetch permissions: ${err.message}`));

    // Trusted devices start out offline; reconcileConnectedDevices marks the live ones.
    linkApi.getTrustedDevices()
      .then((list: any[]) => {
        setPeers((prev) => {
          const copy = new Map(prev);
          list.forEach((d: any) => {
            if (!copy.has(d.deviceId)) {
              copy.set(d.deviceId, {
                deviceId: d.deviceId,
                name: d.deviceName,
                ipAddress: d.lastKnownIp,
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

    // A WebView reload rebuilds only this JS layer; the native connections keep running. Query
    // them so connected devices do not show as offline after a reload.
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
                link: identity.link ?? existing?.link,
                deviceType: identity.deviceType,
                incomingCapabilities: identity.incomingCapabilities || [],
                outgoingCapabilities: identity.outgoingCapabilities || [],
                allowedCapabilities: identity.allowedCapabilities ?? pendingCapabilitiesRef.current.get(identity.deviceId) ?? existing?.allowedCapabilities,
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
                ? { ...existing, name: existing.name || d.deviceName, ipAddress: existing.ipAddress || d.lastKnownIp, trusted: true }
                : { deviceId: d.deviceId, name: d.deviceName, ipAddress: d.lastKnownIp, deviceType: d.deviceType || 'phone', trusted: true, connected: false });
            });
            return copy;
          });
        })
        .catch((err: any) => addLog(`Failed to refresh trusted devices: ${err.message}`));
      reconcileConnectedDevices();
    };

    linkApi.getDiscoveredDevices?.()
      .then((list: any[]) => {
        if (!list || list.length === 0) return;
        setDiscoveredPeers(new Map(list.map((d: any) => [d.deviceId, d])));
      })
      .catch(() => {});

    events.onDeviceDiscovered?.((info: any) => {
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

    events.onDeviceExpired?.((deviceId: string) => {
      setDiscoveredPeers((prev) => {
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
    });

    // Peers send their initial state (volume, battery, lock, media) only when the
    // connection is established, so ask them to resend it after a reload.
    if (linkApi.resyncDevices) {
      linkApi.resyncDevices().catch((err: any) => addLog(`Failed to resync devices: ${err.message}`));
    }

    events.onLocalIdentityUpdated?.((identity: any) => {
      setLocalIdentity({
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        ipAddress: identity.ipAddress,
        ipAddresses: identity.ipAddresses,
        deviceType: identity.deviceType,
      });
      addLog(`Local IP updated: ${identity.ipAddress}`);
    });

    events.onDeviceConnected((identity: any, trusted: boolean) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        // Keep the existing entry's battery, lock and ringing state across a
        // reconnect; the peer only resends them when they change.
        const existing = copy.get(identity.deviceId);
        copy.set(identity.deviceId, {
          ...existing,
          deviceId: identity.deviceId,
          name: existing?.name || identity.deviceName,
          ipAddress: identity.ipAddress || existing?.ipAddress,
          link: identity.link,
          deviceType: identity.deviceType,
          incomingCapabilities: identity.incomingCapabilities || [],
          outgoingCapabilities: identity.outgoingCapabilities || [],
          allowedCapabilities: pendingCapabilitiesRef.current.get(identity.deviceId) ?? identity.allowedCapabilities ?? existing?.allowedCapabilities,
          driveLetter: identity.driveLetter,
          trusted,
          connected: trusted,
        });
        return copy;
      });
      addLog(`Device connected: ${identity.deviceName} (trusted=${trusted})`);
    });

    events.onDeviceDisconnected((deviceId: string) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) {
          if (peer.trusted) {
            copy.set(deviceId, {
              ...peer,
              connected: false,
            });
          } else {
            copy.delete(deviceId);
          }
        }
        return copy;
      });
      addLog(`Device disconnected: ${deviceId.slice(0, 8)}`);
    });

    events.onTrustListUpdated?.(() => {
      addLog('Trust list updated from pool');
      refreshDevices();
      // A device learned from the pool connects soon; ask connected devices for their state so nothing waits for a reload.
      linkApi.resyncDevices?.().catch(() => {});
      linkApi.getPermissions?.()
        .then((perms: any) => {
          if (perms) setDevicePermissions(perms);
        })
        .catch(() => {});
    });

    events.onIncomingPairRequest((deviceId: string, deviceName: string, deviceType: string | undefined, verificationKey: string | null, viaQr?: boolean) => {
      addLog(`Pair request received from ${deviceName || deviceId.slice(0, 8)}${viaQr ? ' (scanned the QR code)' : `. PIN: ${verificationKey}`}`);
      setActivePairRequest({ deviceId, deviceName, deviceType, verificationKey, viaQr });
    });

    events.onPairingBlocked((deviceName: string) => {
      addLog(`Refused a second device using the same QR code: ${deviceName}`);
      setActiveModal({
        type: 'info',
        title: 'Another device tried to pair',
        message: `${deviceName || 'A device'} tried to use the QR code after it had been used. It was refused. If this was not you, someone nearby may have photographed the code.`,
        confirmLabel: 'OK',
        onConfirm: () => setActiveModal(null),
      });
    });

    events.onPairingSuccessful((deviceId: string) => {
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
      // The other device sends its state (what it allows, battery, media and so on) once, the moment it accepts.
      // A reload used to be what asked for it again; ask now, and once more shortly after in case this side was
      // not ready for the first answer.
      linkApi.resyncDevices?.().catch(() => {});
      setTimeout(() => { linkApi.resyncDevices?.().catch(() => {}); }, 1500);
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

    events.onPairingFailed((deviceId: string, reason: string) => {
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

    events.onUnpaired((deviceId: string) => {
      addLog(`Unpaired from ${deviceId.slice(0, 8)}`);
      // A paired device is listed as discovered even with its visibility off (it announces itself to paired
      // devices only). Once it is removed that entry must go, or it would appear in Nearby Devices as a
      // stranger; a device that is visible is simply heard again a moment later.
      setDiscoveredPeers((prev) => {
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
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

    events.onTrustMismatch((deviceId: string) => {
      addLog(`⚠️ PIN Trust Mismatch for ${deviceId.slice(0, 8)}! Pinned cert mismatch.`);
    });

    events.onAppResumed?.(() => {
      addLog('App resumed from background. Syncing permissions...');
      updatePermissionsUI();
    });

    events.onClipboardReceived((deviceId: string) => {
      addLog(`Clipboard content synced from ${deviceId.slice(0, 8)}`);
    });

    // Keeps each paired phone's newest position ("last seen") even while no Locate screen is open.
    startLocationTracking();

    events.onBatteryReceived((deviceId: string, isCharging: boolean, currentCharge: number) => {
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

    events.onFindMyDeviceTriggered(handleDeviceRingTriggered);
    events.onFindMyDeviceStopped(handleDeviceRingStopped);

    events.onLockStateReceived((deviceId: string, isLocked: boolean) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) peer.isLocked = isLocked;
        return copy;
      });
    });

    events.onLockResultReceived((deviceId: string, success: boolean) => {
      addLog(`Lock command result from ${deviceId.slice(0, 8)}: success=${success}`);
    });

    // Mobile-to-mobile presenter: the single subscriber for pointer-dot updates, forwarding each one
    // to the mounted PresenterDotOverlay through presenterMoveHandlerRef.
    events.onPresenterPositionReceived?.((deviceId: string, dx: number, dy: number, stop: boolean) => {
      if (stop) {
        setPresenterDotSourceDeviceId(null);
        presenterMoveHandlerRef.current?.(dx, dy, true);
      } else {
        setPresenterDotSourceDeviceId((prev) => prev ?? deviceId);
        presenterMoveHandlerRef.current?.(dx, dy, false);
      }
    });

    events.onShareReceived((deviceId: string, filename: string, size: number) => {
      addLog(`File synced from ${deviceId.slice(0, 8)}: ${filename} (${size} bytes)`);
    });

    events.onDeviceRenamed((deviceId: string, newName: string) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) copy.set(deviceId, { ...peer, name: newName });
        return copy;
      });
      addLog(`Device ${deviceId.slice(0, 8)} renamed to: ${newName}`);
    });

    events.onCommandListReceived((deviceId: string, receivedCommands: Record<string, CommandEntry>) => {
      setPeerCommandLists((prev) => {
        const copy = new Map(prev);
        copy.set(deviceId, receivedCommands);
        return copy;
      });
    });

    events.onOwnDeviceRenamed?.((newName: string) => {
      setLocalIdentity((prev) => ({ ...prev, deviceName: newName }));
      addLog(`This device was renamed to: ${newName} (by a peer's request)`);
    });

    events.onNotificationReceived((deviceId: string, body: any) => {
      setNotifications((prev) => {
        const key = `${deviceId}|${body.id}`;
        const filtered = prev.filter((n) => n.key !== key);
        // Capped: entries are removed only by a matching cancel packet, which often never arrives
        // (phone rebooted, listener service restarted, mesh-sync duplicate).
        return [{ key, deviceId, body }, ...filtered].slice(0, MAX_NOTIFICATIONS);
      });
    });

    events.onNotificationCancelled((deviceId: string, id: string) => {
      setNotifications((prev) => {
        const key = `${deviceId}|${id}`;
        return prev.filter((n) => n.key !== key);
      });
    });

    // Notifications relayed by other members of the pool.
    events.onNotificationBroadcastReceived?.((sourceDeviceId: string, body: any) => {
      setNotifications((prev) => {
        const key = `${sourceDeviceId}|${body.id}`;
        const filtered = prev.filter((n) => n.key !== key);
        return [{ key, deviceId: sourceDeviceId, body, isMeshSync: true }, ...filtered].slice(0, MAX_NOTIFICATIONS);
      });
    });

    events.onSystemVolumeReceived((deviceId: string, body: any) => {
      setVolumeSinks((prev) => {
        const copy = new Map(prev);
        copy.set(deviceId, body.sinkList || []);
        return copy;
      });
    });

    events.onFlashlightStateReceived((deviceId: string, enabled: boolean) => {
      // Button visibility comes from allowedCapabilities (see onPeerCapabilitiesReceived), not
      // from this value.
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) peer.flashlight = enabled;
        return copy;
      });
    });

    events.onDndStateReceived((deviceId: string, enabled: boolean, granted: boolean) => {
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        if (peer) peer.dnd = { enabled, granted };
        return copy;
      });
    });

    events.onMprisStateReceived((deviceId: string, body: any) => {
      addLog(`[Media] Received from ${deviceId}: "${body.title}" by ${body.artist}, playing: ${body.isPlaying}`);
      // Stored per device so one device's media never shows on another device's panel.
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

    events.onPeerCapabilitiesReceived((deviceId: string, capabilities: string[]) => {
      // The single per-peer visibility signal: every gated control in the device panel checks
      // membership in this list.
      setPeers((prev) => {
        const copy = new Map(prev);
        const peer = copy.get(deviceId);
        // Remembered even without an entry, so a later device-connected or reconcile picks it up.
        pendingCapabilitiesRef.current.set(deviceId, capabilities);
        if (peer) copy.set(deviceId, { ...peer, allowedCapabilities: capabilities });
        return copy;
      });
    });

    let isPromptingRemoteControl = false;
    events.onRemoteControlSignal?.(async (deviceId: string, signal: any) => {
      console.log('[RemoteControl] Received signal:', signal, 'from:', deviceId);
      if (!signal) return;
      if (signal.type === 'request') {
        if (linkApi?.isMobile) {
          if (isPromptingRemoteControl) {
            console.log('[RemoteControl] Prompt already in progress, ignoring duplicate request');
            return;
          }
          if (signal.source === 'camera') {
            // A PC wants to use this phone as a webcam. Unlike screen sharing there is no system
            // consent dialog, so the native side checks this device's own per-device camera
            // permission before opening the camera.
            try {
              const granted = await linkApi.requestCameraHost?.(deviceId, signal.facing === 'front' ? 'front' : 'back');
              if (!granted) linkApi.sendRemoteControlSignal?.(deviceId, { type: 'denied', reason: 'camera' });
            } catch (err) {
              console.error('[Camera] requestCameraHost error:', err);
              linkApi.sendRemoteControlSignal?.(deviceId, { type: 'denied', reason: 'camera' });
            }
            return;
          }
          isPromptingRemoteControl = true;
          // This phone is the host: show the MediaProjection consent dialog, after which
          // LinkRemoteControlServer streams the screen to the requesting peer.
          try {
            console.log('[RemoteControl] Prompting MediaProjection consent on mobile host for', deviceId);
            // Android's background-activity-launch restriction can stop the consent dialog from
            // appearing while the app is not in the foreground, and the native call then never
            // resolves. The timeout releases isPromptingRemoteControl so later requests are not
            // ignored forever; it is kept short because the viewer's retries are only honoured
            // once this attempt is given up.
            // On a TV the dialog is answered with the remote's D-pad (pick "Entire screen", then Start), which
            // takes far longer than a tap. 15 seconds expired first, the viewer showed "disconnected", and only a
            // retry (when the user was ready for the dialog) worked. Kept below the viewer's 45 second give-up.
            const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), IS_TV ? 40000 : 15000));
            const granted = await Promise.race([
              linkApi.requestRemoteControlHost?.(deviceId) ?? Promise.resolve(false),
              timeout,
            ]);
            console.log('[RemoteControl] MediaProjection consent result:', granted);
            if (!granted) {
              linkApi.sendRemoteControlSignal?.(deviceId, { type: 'denied' });
            }
            // LinkRemoteControlServer keeps streaming until stopRemoteControlHost() is called.
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

    events.onSpeedTestProgress((deviceId: string, message: string) => {
      addLog(`[SpeedTest] Progress from ${deviceId.slice(0, 8)}: ${message}`);
    });

    events.onDeviceMountChanged?.((deviceId: string, driveLetter?: string) => {
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

    return unsubscribeAll;
  }, []);

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
    // A scanned pairing QR carries the device's key fingerprint and a one-time token beside its addresses.
    const scanned = parsePairingQr(host);
    const rawIps = (scanned ? scanned.addresses : host).split(',').map((s) => s.trim().split(':')[0]);
    const ownIp = localIdentity?.ipAddress;
    const ownIps = localIdentity?.ipAddresses || [];
    
    // Drop this device's own addresses so it cannot pair with itself.
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
    linkApi.requestPairingByIp(targetHost, scanned ? { fingerprint: scanned.fingerprint, token: scanned.token } : undefined).then((res: any) => {
      if (res && res.verified && res.deviceId) {
        addLog(`Pairing requested with ${res.deviceId.slice(0, 8)}. Verified by its QR code.`);
        setActiveModal({
          type: 'info',
          title: 'Waiting for approval',
          message: 'The device is verified. Approve this phone on the other screen.',
          confirmLabel: 'Cancel Pairing',
          onConfirm: () => {
            linkApi.cancelPairing(res.deviceId);
            setActiveModal(null);
          },
        });
      } else if (res && res.pin && res.deviceId) {
        addLog(`Pairing requested with ${res.deviceId.slice(0, 8)}. Pin: ${res.pin}`);
        setActiveModal({
          type: 'pin',
          title: 'Pairing Initiated',
          message: 'Confirm that this PIN matches the target device screen:',
          pin: res.pin,
          cancelLabel: 'Cancel Pairing',
          // No confirm button: a successful pairing replaces this modal, so the only choice here
          // is to cancel.
          onCancel: () => {
            linkApi.cancelPairing(res.deviceId);
            setActiveModal(null);
          },
        });
      } else {
        // Shown, not only logged: a scan that silently does nothing looks like a broken scanner.
        showPairingError(`No answer from ${targetHost}. Check that both devices are on the same network, then try again.`);
      }
    }).catch((err: any) => showPairingError(err));
  };

  // Surfaces pair requests that cannot reach the device, which would otherwise fail silently.
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
        // No confirm button; see handleConnect.
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
      // Operating systems offer no way to unlock a screen remotely without the user's credentials,
      // so query the peer's actual lock state instead (it may have been unlocked locally).
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
    setPeers((prev) => {
      const copy = new Map(prev);
      copy.delete(id);
      return copy;
    });
    linkApi.unpair(id);
  };

  // A peer sends its volume sinks once, when the connection is established, and again only when they
  // change. If that packet arrives before this side is ready it is lost, and the volume control stays
  // missing until a reload asks again. So when a connected peer that may share volume has sent no sinks
  // yet, ask for its state again a few times.
  const peersWithoutVolume = Array.from(peers.values())
    .filter((p) => p.trusted && p.connected
      && (p.allowedCapabilities === undefined || p.allowedCapabilities.includes('systemvolume'))
      && !volumeSinks.has(p.deviceId))
    .map((p) => p.deviceId)
    .sort()
    .join(',');
  useEffect(() => {
    if (!peersWithoutVolume) return;
    const timers = [1500, 4000, 10000].map((delay) =>
      setTimeout(() => { linkApi.resyncDevices?.().catch(() => {}); }, delay));
    return () => timers.forEach(clearTimeout);
  }, [peersWithoutVolume]);

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

    // A paired device matched by id or IP is controlled over its existing connection.
    let matchedPeer: PeerDevice | undefined;
    if (peers.has(rawTarget)) {
      matchedPeer = peers.get(rawTarget);
    } else {
      matchedPeer = Array.from(peers.values()).find((p) => p.ipAddress && normalizeIp(p.ipAddress) === cleanTargetIp);
    }

    if (matchedPeer && matchedPeer.trusted) {
      setActiveRemoteControlDeviceId(matchedPeer.deviceId);
      setActiveRemoteControlMode(mode);
      setActiveRemoteControlHostDeviceType(matchedPeer.deviceType);
      return;
    }

    // Otherwise this is an unpaired guest session. hostDeviceType comes from the admission handshake
    // (see PresenterTab.tsx and RemoteInputTab.tsx) because the typed or scanned target may be a
    // comma-separated list of the host's addresses.
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
      {/* Swipe-down reload would fight the gestures of these full-screen control surfaces. */}
      <PullToRefresh
        disabled={
          activeRemoteControlMode !== null ||
          activeRemoteControlViewerDeviceId !== null ||
          presenterDotSourceDeviceId !== null ||
          activeCameraDeviceId !== null
        }
      />

      {showOnboarding && (
        <Suspense fallback={null}>
        <OnboardingWizard
          isMobile={linkApi?.isMobile || false}
          mobilePermissions={mobilePermissions}
          onRequestPermission={handleRequestMobilePermission}
          onComplete={() => {
            localStorage.setItem('onboarding-completed', 'true');
            setShowOnboarding(false);
          }}
        />
        </Suspense>
      )}

      {/* Full-screen alert while this device is ringing */}
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
            // Above every other overlay (device panel, permissions dialog, .landscape-overlay),
            // which use z-index 10000 and are painted later in the tree.
            zIndex: 20000,
            userSelect: 'none',
            animation: 'fadeIn 0.3s ease-out'
          }}
        >
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
                // A device that scanned the QR already verified this one: nothing to compare.
                pin: activePairRequest.viaQr ? '' : (activePairRequest.verificationKey || '------'),
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
            <div className="tab-scroll">
              <div className="page-container">
                <PageHeader
                  title={titleMap[activeTab]}
                  icon={iconMap[activeTab]}
                >
                  {/* Files tab device switcher */}
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
                    localAddresses={(localIdentity.ipAddresses ?? []).join(',')}
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
                      setRemoteControlSecondScreen(false);
                      setActiveRemoteControlViewerDeviceId(id);
                    }}
                    onShowSecondScreen={(id) => {
                      setRemoteControlSecondScreen(true);
                      setActiveRemoteControlViewerDeviceId(id);
                    }}
                    onShowCamera={(id) => setActiveCameraDeviceId(id)}
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

                <Suspense fallback={null}>
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
                    sharedFiles={sharedFiles}
                    onSharedFilesHandled={() => setSharedFiles([])}
                    remoteControlViewing={activeRemoteControlViewerDeviceId !== null}
                    extendScreenViewing={remoteControlSecondScreen}
                    onOpenWalkieTalkie={() => setWalkieTalkieOpen(true)}
                    onShowPresenter={(id, hostDeviceType) => handleToolConnect('presenter', id, hostDeviceType)}
                    onShowTouchpad={(id) => handleToolConnect('touchpad', id)}
                    onShowRemoteControl={(hostDeviceType) => {
                      setRemoteControlSecondScreen(false);
                      setGuestRemoteControlHostType(hostDeviceType);
                      setActiveRemoteControlViewerDeviceId(GUEST_REMOTE_CONTROL_ID);
                    }}
                    onShowExtendScreenGuest={(hostDeviceType) => {
                      setRemoteControlSecondScreen(true);
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
                    isMobile={IS_ANDROID}
                    mobilePermissions={mobilePermissions}
                    onRequestMobilePermission={handleRequestMobilePermission}
                    screensaverInhibitEnabled={screensaverInhibitEnabled}
                    onScreensaverInhibitToggle={handleScreensaverInhibitToggle}
                    openAtLogin={openAtLogin}
                    onOpenAtLoginToggle={handleOpenAtLoginToggle}
                    visibilityEnabled={visibilityEnabled}
                    onVisibilityToggle={handleVisibilityToggle}
                  />
                )}
                </Suspense>
              </div>
            </div>
          </div>
        </div>

      {/* Walkie Talkie stays mounted and is only hidden; see walkieTalkieOpen. */}
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
          <Suspense fallback={null}>
            <WalkieTalkieTab
              peers={peers}
              localIdentity={localIdentity}
              isMobile={IS_ANDROID}
              onSessionActiveChange={setWalkieTalkieActive}
            />
          </Suspense>
        </div>
      </div>

      {/* Full-screen remote input overlays (mobile only) */}
      <Suspense fallback={null}>
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
      </Suspense>

      <Suspense fallback={null}>
      {activeRemoteControlMode === 'touchpad' && activeRemoteControlDeviceId && (
        <RemoteInputOverlay
          deviceId={activeRemoteControlDeviceId}
          hostDeviceType={activeRemoteControlHostDeviceType}
          onClose={() => {
            linkApi?.leaveInputGuest?.();
            setActiveRemoteControlMode(null);
            setActiveRemoteControlDeviceId(null);
          }}
        />
      )}
      </Suspense>

      <Suspense fallback={null}>
      {activeRemoteControlMode === 'joystick' && activeRemoteControlDeviceId && (
        <JoystickOverlay
          {...joystickSettings}
          host={activeRemoteControlDeviceId}
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
      </Suspense>

      {/* Mobile-to-mobile presenter: this device is being controlled by a peer */}
      {presenterDotSourceDeviceId && (
        <PresenterDotOverlay
          moveHandlerRef={presenterMoveHandlerRef}
          onClose={() => setPresenterDotSourceDeviceId(null)}
        />
      )}

      <Suspense fallback={null}>
      {activeRemoteControlViewerDeviceId && (
        <RemoteControlViewer
          deviceId={activeRemoteControlViewerDeviceId}
          deviceName={peers.get(activeRemoteControlViewerDeviceId)?.name || 'Remote Device'}
          hostDeviceType={activeRemoteControlViewerDeviceId === GUEST_REMOTE_CONTROL_ID ? guestRemoteControlHostType : peers.get(activeRemoteControlViewerDeviceId)?.deviceType}
          hostConnected={peers.get(activeRemoteControlViewerDeviceId)?.connected}
          onClose={() => setActiveRemoteControlViewerDeviceId(null)}
          onEndSession={() => setActiveRemoteControlViewerDeviceId(null)}
          secondScreen={remoteControlSecondScreen}
        />
      )}
      </Suspense>

      <Suspense fallback={null}>
      {activeCameraDeviceId && (
        <CameraViewer
          deviceId={activeCameraDeviceId}
          deviceName={peers.get(activeCameraDeviceId)?.name || 'Phone'}
          onClose={() => setActiveCameraDeviceId(null)}
        />
      )}
      </Suspense>

      {activeModal && <ModalDialog {...activeModal} />}
      </div>
    </>
  );
};

export default App;
