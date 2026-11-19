import React, { useState, useEffect } from 'react';
import { LinkApi } from '../vite-env';
import { PeerDevice, VolumeSink, MprisState, CommandEntry } from '../types/peer';
import { IS_ANDROID, IS_TV } from '../utils/platform';
import { DeviceIcon } from './DeviceIcon';
import { BatteryIndicator } from './BatteryIcon';
import { DEVICE_NAME_MAX } from '../utils/deviceName';
import RecentPhotos from './RecentPhotos';
import type { LucideIcon } from 'lucide-react';
import { FEATURE_ICONS } from '../utils/featureIcons';
import LocateModal from './LocateModal';
import { ago, formatAccuracy, lastLocation } from '../utils/deviceLocation';

const linkApi = (window as any).link as LinkApi;

interface DeviceControlPanelProps {
  deviceId: string;
  device: PeerDevice;
  selectedSinks: VolumeSink[];
  isMediaActive: boolean;
  mprisState: MprisState | null;
  peerCommands: Record<string, CommandEntry>;
  activeSpeedTestDeviceId?: string | null;
  onClose: () => void;
  onPair: (id: string) => void;
  onToggleRing: (id: string) => void;
  onLock: (id: string) => void;
  onSpeedTest: (id: string) => void;
  onToggleFlashlight: (id: string) => void;
  onToggleDnd: (id: string) => void;
  onShowPresenter?: (id: string) => void;
  onShowTouchpad?: (id: string) => void;
  onShowJoystick?: (id: string) => void;
  onShowRemoteInput?: (id: string) => void;
  onShowRemoteControl?: (id: string) => void;
  onShowCamera?: (id: string) => void;
  onShowSecondScreen?: (id: string) => void;
  onRunCommandTrigger: (deviceId: string, key: string) => void;
  onSetVolume: (id: string, sinkName: string, vol: number) => void;
  onToggleMute: (id: string, sinkName: string) => void;
  onMprisPrev: () => void;
  onMprisPlay: () => void;
  onMprisNext: () => void;
  onRenameTrustedDevice?: (deviceId: string, newName: string) => void;
}

// Matches the deviceType values identities actually carry ("desktop" from core/identity.rs,
// "phone"/"tv" from LinkIdentity.java).
type DeviceCategory = 'phone' | 'tv' | 'desktop';

interface PluginDescriptor {
  id: string;
  permissionKey?: string;
  packetType?: string | string[];
  allowedTargetTypes?: DeviceCategory[];
  allowedLocalTypes?: ('mobile' | 'desktop')[];
  // Gating that depends on both the target's capabilities and the local platform (e.g. remote
  // input's touchpad-or-keyboard split), which packetType/allowedLocalTypes cannot express.
  extraFilter?: (device: PeerDevice, isLocalMobile: boolean) => boolean;
  title: (device: PeerDevice, ctx: any) => React.ReactNode;
  isActive?: (device: PeerDevice) => boolean;
  isDisabled?: (device: PeerDevice, ctx: any) => boolean;
  onClick: (deviceId: string, ctx: any, device: PeerDevice) => void;
  requiresCallback?: (ctx: any, device: PeerDevice) => boolean;
  requiresState?: (device: PeerDevice) => boolean;
}

function targetCategoryOf(d: PeerDevice): DeviceCategory {
  return d.deviceType === 'phone' || d.deviceType === 'tv' || d.deviceType === 'desktop'
    ? d.deviceType
    : 'desktop';
}

// Actions are shown in labelled groups, in this order: Quick (one tap, acts at once), Tools (open a
// screen to use or control the other device, plus any action not listed here), then the custom
// commands. Inside a group they are alphabetical by their fixed name (Ring stays where it is while it
// reads "Stop Ringing"); the lists below are kept in that order.
const ACTION_GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Quick', ids: ['dnd', 'flashlight', 'locate', 'lock', 'ring', 'speedtest'] },
  { label: 'Tools', ids: ['camera', 'secondscreen', 'joystick', 'presenter', 'remotecontrol', 'remoteinput'] },
];
const TOOLS_GROUP = ACTION_GROUPS.length - 1;
const groupOf = (id: string) => {
  const g = ACTION_GROUPS.findIndex((group) => group.ids.includes(id));
  return g < 0 ? TOOLS_GROUP : g;
};
const orderInGroup = (id: string) => {
  const i = ACTION_GROUPS[groupOf(id)].ids.indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};

// Same icons as the Tools page (utils/featureIcons.ts), keyed by this panel's plugin ids.
const PLUGIN_ICONS: Record<string, LucideIcon> = {
  ring: FEATURE_ICONS.ring,
  lock: FEATURE_ICONS.lock,
  locate: FEATURE_ICONS.locate,
  flashlight: FEATURE_ICONS.flashlight,
  dnd: FEATURE_ICONS.dnd,
  speedtest: FEATURE_ICONS.speedTest,
  presenter: FEATURE_ICONS.presenter,
  remoteinput: FEATURE_ICONS.remoteInput,
  remotecontrol: FEATURE_ICONS.remoteControl,
  secondscreen: FEATURE_ICONS.extendScreen,
  camera: FEATURE_ICONS.camera,
  joystick: FEATURE_ICONS.joystick,
  command: FEATURE_ICONS.command,
};

const PluginIcon: React.FC<{ id: string }> = ({ id }) => {
  const Icon = PLUGIN_ICONS[id] ?? FEATURE_ICONS.command;
  return <Icon size={16} strokeWidth={2} style={{ flexShrink: 0 }} />;
};

const SECTION_TITLE: React.CSSProperties = {
  fontSize: '11.5px',
  fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: '9px',
};

// A row of equal-width chips, so they line up whatever their labels. `max` is how many fit in one row.
const actionRow = (count: number, max: number): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: `repeat(${Math.max(1, Math.min(count, max))}, minmax(0, 1fr))`,
  gap: '6px',
});

const ACTION_BUTTON: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  padding: '8px 8px',
  fontSize: '12.5px',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  minWidth: 0,
};

// Wrapping layout (PC): natural width, growing to share the row's spare space.
const ACTION_BUTTON_FLOW: React.CSSProperties = { ...ACTION_BUTTON, flex: '1 0 auto', padding: '8px 14px' };

// A label too long for its chip is cut with an ellipsis instead of spilling out of it.
const ACTION_LABEL: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };

const PLUGIN_REGISTRY: PluginDescriptor[] = [
  {
    id: 'ring',
    packetType: ['link.findmydevice.request'],
    title: (d) => (d.isRinging ? 'Stop Ringing' : 'Ring'),
    isActive: (d) => !!d.isRinging,
    onClick: (id, ctx) => ctx.onToggleRing(id),
  },
  {
    // Where a paired phone or PC is (LocateModal), from either a phone or a PC. The located device
    // allows it per device (on by default) and announces it as the 'location' capability; a TV
    // does not offer it.
    id: 'locate',
    permissionKey: 'location',
    packetType: 'link.location.request',
    allowedTargetTypes: ['phone', 'desktop'],
    requiresCallback: (ctx) => !!ctx.onLocate,
    title: () => 'Locate',
    onClick: (id, ctx) => ctx.onLocate(id),
  },
  {
    id: 'lock',
    packetType: 'link.lock',
    title: (d) => (d.isLocked ? 'Unlock' : 'Lock'),
    isActive: (d) => !!d.isLocked,
    onClick: (id, ctx) => ctx.onLock(id),
  },
  {
    id: 'flashlight',
    permissionKey: 'flashlight',
    packetType: 'link.flashlight',
    title: () => 'Flashlight',
    isActive: (d) => !!d.flashlight,
    onClick: (id, ctx) => ctx.onToggleFlashlight(id),
  },
  {
    id: 'dnd',
    permissionKey: 'dnd',
    packetType: 'link.dnd',
    title: () => 'DND',
    isActive: (d) => !!d.dnd?.enabled,
    isDisabled: (d) => !d.dnd?.granted,
    onClick: (id, ctx) => ctx.onToggleDnd(id),
  },
  {
    id: 'speedtest',
    title: () => 'Speed Test',
    isDisabled: (d, ctx) => ctx.activeSpeedTestDeviceId === d.deviceId,
    onClick: (id, ctx) => ctx.onSpeedTest(id),
  },
  {
    id: 'presenter',
    permissionKey: 'presenter',
    packetType: 'link.presenter',
    // Offered on phones only: the presenter overlay is touch-driven and uses the rotated
    // `landscape-overlay` layout meant for a portrait phone.
    allowedTargetTypes: ['desktop', 'tv', 'phone'],
    allowedLocalTypes: ['mobile'],
    // A TV is presented to, never the presenter.
    extraFilter: () => !IS_TV,
    requiresCallback: (ctx) => !!ctx.onShowPresenter,
    title: () => 'Presenter',
    onClick: (id, ctx) => ctx.onShowPresenter(id),
  },
  {
    // One button whose surface depends on the target: touchpad, keyboard and pen for a desktop; a
    // touchpad cursor, D-pad, keyboard and pen for an Android device (TV or phone). A phone target needs
    // the Accessibility Service for the injected clicks and typing, which Remote Control already
    // requires, and the controlled phone grants this per device with the 'remoteinput' permission. The
    // PC touchpad (RemoteInputOverlay) is touch-driven, so it is offered only from a phone; the Android
    // surface (RemoteKeyboardOverlay) works from either platform. The digitizer is a mode inside these.
    id: 'remoteinput',
    permissionKey: 'remoteinput',
    allowedTargetTypes: ['desktop', 'tv', 'phone'],
    extraFilter: (d, isLocalMobile) => {
      // A TV receives remote input, it has no touch screen to send it from.
      if (IS_TV) return false;
      const incoming = d.incomingCapabilities || [];
      if (targetCategoryOf(d) === 'desktop') {
        return isLocalMobile && incoming.includes('link.touchpad.request');
      }
      return incoming.includes('link.remoteinput.send');
    },
    requiresCallback: (ctx, d) =>
      targetCategoryOf(d) === 'desktop' ? !!ctx.onShowTouchpad : !!ctx.onShowRemoteInput,
    title: () => 'Remote Input',
    onClick: (id, ctx, d) => {
      if (targetCategoryOf(d) === 'desktop') ctx.onShowTouchpad(id);
      else ctx.onShowRemoteInput(id);
    },
  },
  {
    id: 'remotecontrol',
    permissionKey: 'remotecontrol',
    packetType: 'link.remotecontrol.signal',
    allowedTargetTypes: ['phone', 'tv', 'desktop'],
    allowedLocalTypes: ['desktop', 'mobile'],
    requiresCallback: (ctx) => !!ctx.onShowRemoteControl,
    title: () => 'Remote Control',
    onClick: (id, ctx) => ctx.onShowRemoteControl(id),
  },
  {
    // The phone becomes an extra screen for a PC: it shows the PC's second monitor (a real one or a
    // virtual display) and taps act on it. Uses the remote-control permission and stream.
    id: 'secondscreen',
    permissionKey: 'remotecontrol',
    packetType: 'link.remotecontrol.signal',
    allowedTargetTypes: ['desktop'],
    allowedLocalTypes: ['mobile'],
    requiresCallback: (ctx) => !!ctx.onShowSecondScreen,
    title: () => 'Extend Screen',
    onClick: (id, ctx) => ctx.onShowSecondScreen(id),
  },
  {
    // Uses this PC as the viewer of a paired phone's camera. Gated by the phone's own "camera"
    // permission (off by default), which the phone announces in its capability list.
    id: 'camera',
    permissionKey: 'camera',
    packetType: 'link.remotecontrol.signal',
    allowedTargetTypes: ['phone'],
    allowedLocalTypes: ['desktop'],
    requiresCallback: (ctx) => !!ctx.onShowCamera,
    title: () => 'Camera',
    onClick: (id, ctx) => ctx.onShowCamera(id),
  },
  {
    id: 'joystick',
    permissionKey: 'joystick',
    allowedTargetTypes: ['desktop'],
    allowedLocalTypes: ['mobile'],
    // Not offered from a TV for now (see BACKLOG.md).
    extraFilter: () => !IS_TV,
    requiresCallback: (ctx) => !!ctx.onShowJoystick,
    title: () => 'Joystick',
    onClick: (id, ctx) => ctx.onShowJoystick(id),
  },
];

// Control panel for one device, opened from ConnectionsTab.tsx: device status, actions and tools
// gated by PLUGIN_REGISTRY, volume, media controls and drive mounting.
const DeviceControlPanel: React.FC<DeviceControlPanelProps> = ({
  deviceId,
  device,
  selectedSinks,
  isMediaActive: _isMediaActive,
  mprisState,
  peerCommands,
  activeSpeedTestDeviceId,
  onClose,
  onPair,
  onToggleRing,
  onLock,
  onSpeedTest,
  onToggleFlashlight,
  onToggleDnd,
  onShowPresenter,
  onShowTouchpad,
  onShowJoystick,
  onShowRemoteInput,
  onShowRemoteControl,
  onShowCamera,
  onShowSecondScreen,
  onRunCommandTrigger,
  onSetVolume,
  onToggleMute,
  onMprisPrev,
  onMprisPlay,
  onMprisNext,
  onRenameTrustedDevice,
}) => {
  const [editingDeviceName, setEditingDeviceName] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const [preferredLetter, setPreferredLetter] = useState<string>('');
  const [occupiedLetters, setOccupiedLetters] = useState<string[]>([]);
  const [lettersList, setLettersList] = useState<string[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const isLocalMobile = IS_ANDROID;

  useEffect(() => {
    if (linkApi && !isLocalMobile) {
      linkApi.getDeviceMountConfig?.(deviceId).then((res: any) => {
        if (res) {
          setPreferredLetter(res.preferredDriveLetter || '');
          setOccupiedLetters(res.occupiedLetters || []);
          setLettersList(res.letters || []);
        }
      }).catch(() => {});
    }
  }, [deviceId, isLocalMobile]);

  const handleLetterChange = async (letter: string) => {
    setPreferredLetter(letter);
    if (linkApi) {
      await linkApi.setDeviceMountLetter?.(deviceId, letter);
      const res = await linkApi.getDeviceMountConfig?.(deviceId);
      if (res) {
        setPreferredLetter(res.preferredDriveLetter || '');
        setOccupiedLetters(res.occupiedLetters || []);
        setLettersList(res.letters || []);
      }
    }
  };

  const handleToggleMount = async () => {
    if (linkApi) {
      if (device.driveLetter) {
        await linkApi.fsUnmountDevice?.(deviceId);
      } else {
        await linkApi.fsMountDevice?.(deviceId);
      }
    }
  };

  const isTargetMobile = device.deviceType === 'phone';
  const targetCategory: DeviceCategory = (device.deviceType as DeviceCategory) || (isTargetMobile ? 'phone' : 'desktop');

  const offline = !device.connected;

  // Packet types the peer accepts, from its handshake. A device that has not connected since Link
  // started has no handshake yet; its controls are listed by device type until it does.
  const supportsIncoming = (cap?: string | string[]) => {
    if (!cap) return true;
    const peerIncoming = device.incomingCapabilities || [];
    if (offline && peerIncoming.length === 0) return true;
    const caps = Array.isArray(cap) ? cap : [cap];
    return caps.some((c) => peerIncoming.includes(c));
  };

  // Features the peer currently allows this device; everything is shown until its list arrives.
  const allowedCaps = device.allowedCapabilities;
  const isAllowed = (key?: string) => !key || allowedCaps === undefined || allowedCaps.includes(key);


  const contextHelpers = {
    onClose,
    onToggleRing,
    onLock,
    onSpeedTest,
    onToggleFlashlight,
    onToggleDnd,
    onShowPresenter,
    onShowTouchpad,
    onShowJoystick,
    onShowRemoteInput,
    onShowRemoteControl,
    onShowCamera,
    onShowSecondScreen,
    onLocate: () => setLocating(true),
    activeSpeedTestDeviceId,
  };

  // A plugin is shown only if the peer allows it, accepts its packet type, and it suits both the
  // target and the local platform.
  const activePlugins = PLUGIN_REGISTRY.filter((p) => {
    if (!isAllowed(p.permissionKey)) return false;
    if (!supportsIncoming(p.packetType)) return false;
    if (p.allowedTargetTypes && !p.allowedTargetTypes.includes(targetCategory)) return false;
    if (p.allowedLocalTypes && !p.allowedLocalTypes.includes(isLocalMobile ? 'mobile' : 'desktop')) return false;
    if (p.extraFilter && !p.extraFilter(device, isLocalMobile)) return false;
    if (p.requiresCallback && !p.requiresCallback(contextHelpers, device)) return false;
    if (p.requiresState && !p.requiresState(device)) return false;

    return true;
  });

  // Where this device was last seen (utils/deviceLocation.ts), shown while it is offline.
  const lastSeen = device.deviceType !== 'tv' ? lastLocation(deviceId) : null;

  return (
    <>
    <div className="modal" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '500px',
          textAlign: 'left',
          background: 'var(--modal-bg)',
          border: '1px solid var(--border-color)',
          boxShadow: '0 25px 60px var(--modal-shadow)',
          padding: '22px 26px 24px',
          maxHeight: '92vh',
          overflowY: 'auto'
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '14px' }}>
          {editingDeviceName !== null ? (
            // Takes only the room left beside the battery and close button, so the row never overflows on a phone.
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                maxLength={DEVICE_NAME_MAX}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (renameValue.trim()) {
                      onRenameTrustedDevice?.(device.deviceId, renameValue.trim());
                    }
                    setEditingDeviceName(null);
                  } else if (e.key === 'Escape') {
                    setEditingDeviceName(null);
                  }
                }}
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  padding: '4px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--accent-color)',
                  flex: 1,
                  minWidth: 0,
                  width: '100%'
                }}
                autoFocus
              />
              <button
                onClick={() => {
                  if (renameValue.trim()) {
                    onRenameTrustedDevice?.(device.deviceId, renameValue.trim());
                  }
                  setEditingDeviceName(null);
                }}
                style={{ padding: '4px 10px', fontSize: '12px', flexShrink: 0 }}
              >
                Save
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {device.trusted && (
                  <span
                    className={`status-dot ${device.connected ? 'status-active' : 'status-inactive'}`}
                    title={device.connected ? 'Connected' : 'Offline'}
                    aria-label={device.connected ? 'Connected' : 'Offline'}
                    style={{ width: '8px', height: '8px', flexShrink: 0, marginRight: '8px' }}
                  />
                )}
                <DeviceIcon deviceType={device.deviceType} size={16} style={{ color: 'var(--text-muted)', flexShrink: 0, marginRight: '6px' }} />
                <h2
                  style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700, margin: 0, cursor: onRenameTrustedDevice ? 'text' : undefined }}
                  title={onRenameTrustedDevice ? 'Click to rename' : undefined}
                  onClick={() => {
                    if (!onRenameTrustedDevice) return;
                    setRenameValue(device.name);
                    setEditingDeviceName(device.name);
                  }}
                >
                  {device.name}
                </h2>
                {onRenameTrustedDevice && (
                  <button
                    onClick={() => {
                      setRenameValue(device.name);
                      setEditingDeviceName(device.name);
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: '3px 5px',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      opacity: 0.55,
                      transition: 'opacity 0.15s',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.55')}
                    title="Rename device"
                    aria-label="Rename device"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                    </svg>
                  </button>
                )}
              </div>
              </div>
            </div>
          )}
          {/* Right side: the battery, then close. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
            {device.trusted && device.battery && device.deviceType !== 'tv' && (
              <BatteryIndicator level={device.battery.currentCharge} charging={device.battery.isCharging} />
            )}
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'transparent',
                border: 'none',
                fontSize: '16px',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '4px'
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {!device.trusted ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <span style={{ fontSize: '13.5px', color: 'var(--text-muted)' }}>
              This device is currently unpaired. Pair it to establish trust and view controls.
            </span>
            <button
              onClick={() => {
                onPair(deviceId);
                onClose();
              }}
              style={{ width: '100%', padding: '12px', fontWeight: 600, background: 'var(--accent-gradient)', border: 'none', color: 'var(--btn-primary-text)' }}
            >
              Pair Device
            </button>
          </div>
        ) : (
          <>
            {offline && (
              <div style={{ marginBottom: '16px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.03)', fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                {device.name} is offline. These controls work again when it reconnects.
              </div>
            )}
            {offline && lastSeen && (
              <button
                onClick={() => setLocating(true)}
                style={{ ...ACTION_BUTTON, width: '100%', justifyContent: 'flex-start', marginBottom: '16px', padding: '10px 12px', whiteSpace: 'normal', textAlign: 'left' }}
              >
                <PluginIcon id="locate" />
                <span>
                  Last seen {ago(lastSeen.time)} · {formatAccuracy(lastSeen.accuracy)}. Show on map
                </span>
              </button>
            )}
            {/* Disabled as a whole while offline: a fieldset disables every button and input in it. */}
            <fieldset disabled={offline} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0, opacity: offline ? 0.45 : 1, pointerEvents: offline ? 'none' : undefined }}>
            {/* Actions, grouped by purpose (ACTION_GROUPS), then custom commands */}
            {(() => {
              const groups = ACTION_GROUPS.map((group, g) => ({
                label: group.label,
                plugins: activePlugins.filter((pl) => groupOf(pl.id) === g).sort((a, b) => orderInGroup(a.id) - orderInGroup(b.id)),
              }));
              const commands = isAllowed('runcommand')
                ? Object.keys(peerCommands).sort((a, b) => peerCommands[a].name.localeCompare(peerCommands[b].name))
                : [];
              if (groups.every((g) => g.plugins.length === 0) && commands.length === 0) return null;
              const renderPlugin = (plugin: PluginDescriptor) => (
                <button
                  key={plugin.id}
                  className={
                    (plugin.isActive?.(device) ? 'plugin-toggle-on ' : '') +
                    (plugin.isDisabled?.(device, contextHelpers) ? 'testing-pulse' : '')
                  }
                  style={isLocalMobile ? ACTION_BUTTON : ACTION_BUTTON_FLOW}
                  disabled={plugin.isDisabled?.(device, contextHelpers)}
                  onClick={() => plugin.onClick(deviceId, contextHelpers, device)}
                >
                  <PluginIcon id={plugin.id} />
                  <span style={ACTION_LABEL}>{plugin.title(device, contextHelpers)}</span>
                </button>
              );
              const renderCommand = (key: string) => (
                <button key={key} style={isLocalMobile ? ACTION_BUTTON : ACTION_BUTTON_FLOW} onClick={() => onRunCommandTrigger(deviceId, key)}>
                  <PluginIcon id="command" />
                  <span style={ACTION_LABEL}>{peerCommands[key].name}</span>
                </button>
              );
              // Each group starts on its own row under its label; empty groups are left out.
              const sections: { label: string; buttons: React.ReactNode[] }[] = [
                ...groups.map((g) => ({ label: g.label, buttons: g.plugins.map(renderPlugin) })),
                { label: 'Commands', buttons: commands.map(renderCommand) },
              ].filter((s) => s.buttons.length > 0);
              return (
                <div style={{ marginBottom: '22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {sections.map((section) => (
                    <div key={section.label}>
                      <div style={SECTION_TITLE}>{section.label}</div>
                      {/* A phone gets an even two-column grid. A PC lets buttons take their natural width
                          and stretch to fill each row, so labels are never cut and rows end flush. */}
                      <div
                        className="peer-actions"
                        style={isLocalMobile ? { ...actionRow(2, 2), gap: '8px' } : { display: 'flex', flexWrap: 'wrap', gap: '8px' }}
                      >
                        {section.buttons}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Volume Control */}
            {isAllowed('systemvolume') && selectedSinks.length > 0 && (
              <div style={{ marginBottom: '22px' }}>
                <div style={SECTION_TITLE}>Volume Control</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {selectedSinks.map((sink) => (
                    <div key={sink.name} style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', height: '28px' }}>
                      <span style={{ display: 'inline-block', fontSize: '12px', color: 'var(--text-muted)', width: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {sink.description}
                      </span>
                      <input
                        type="range"
                        min="0"
                        max={sink.maxVolume || 100}
                        value={sink.volume}
                        onChange={(e) => onSetVolume(deviceId, sink.name, parseInt(e.target.value, 10))}
                        className="volume-slider"
                        style={{
                          flexGrow: 1,
                          opacity: sink.muted ? 0.45 : 1,
                          background: `linear-gradient(to right, var(--accent-color) ${Math.round((sink.volume / (sink.maxVolume || 100)) * 100)}%, var(--slider-track) ${Math.round((sink.volume / (sink.maxVolume || 100)) * 100)}%)`,
                        }}
                        aria-label={sink.description}
                      />
                      <span style={{ width: '38px', textAlign: 'right', fontSize: '12px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                        {Math.round((sink.volume / (sink.maxVolume || 100)) * 100)}%
                      </span>
                      <div style={{ width: '32px', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
                        {sink.name === 'alarm' && (
                          // The alarm stream cannot be muted from here; the icon stays (dimmed) so every row lines up.
                          <span title="The alarm volume can't be muted" style={{ padding: '4px', display: 'flex', opacity: 0.35 }}>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 5L6 9H2v6h4l5 4V5z" />
                              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                            </svg>
                          </span>
                        )}
                        {sink.name === 'brightness' && (
                          <span title="Screen brightness" style={{ padding: '4px', display: 'flex', opacity: 0.6 }}>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="4" />
                              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                            </svg>
                          </span>
                        )}
                        {sink.name !== 'alarm' && sink.name !== 'brightness' && (
                          <button
                            onClick={() => onToggleMute(deviceId, sink.name)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '4px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              transition: 'transform 0.15s',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.15)')}
                            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1.0)')}
                            title={sink.muted ? 'Unmute' : 'Mute'}
                          >
                            {sink.muted ? (
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 5L6 9H2v6h4l5 4V5z" />
                                <line x1="23" y1="9" x2="17" y2="15" />
                                <line x1="17" y1="9" x2="23" y2="15" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 5L6 9H2v6h4l5 4V5z" />
                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Media Controller */}
            {isAllowed('mpris') && (
              <div style={{ marginBottom: '22px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)', borderRadius: '10px', overflow: 'hidden' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                  {/* The source app; the play/pause button already shows the state, the dot echoes it. */}
                  {mprisState?.player && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: mprisState.isPlaying ? '#10b981' : '#6b7280' }} />
                      <span>{mprisState.player}</span>
                    </div>
                  )}
                  <div
                    title={mprisState?.title ? (mprisState.title.includes('?') ? mprisState.title.split('?')[0] : mprisState.title) : 'Unknown Track'}
                    style={{
                      fontSize: '13px',
                      fontWeight: 500,
                      lineHeight: 1.4,
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {mprisState?.title ? (mprisState.title.includes('?') ? mprisState.title.split('?')[0] : mprisState.title) : 'Unknown Track'}
                  </div>
                  <div
                    title={mprisState?.artist || 'Unknown Artist'}
                    style={{
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      marginBottom: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {mprisState?.artist || 'Unknown Artist'}
                  </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <button
                      onClick={onMprisPrev}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        padding: '0',
                      }}
                      title="Previous"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                        <polygon points="19 20 9 12 19 4 19 20" />
                        <line x1="5" y1="5" x2="5" y2="19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                    </button>
                    <button
                      onClick={onMprisPlay}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '38px',
                        height: '38px',
                        borderRadius: '50%',
                        padding: '0',
                        background: 'var(--accent-gradient)',
                        color: 'var(--btn-primary-text)',
                        border: 'none',
                        boxShadow: '0 4px 12px rgba(0, 155, 213, 0.2)',
                      }}
                      title={mprisState?.isPlaying ? 'Pause' : 'Play'}
                    >
                      {mprisState?.isPlaying ? (
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--btn-primary-text)">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--btn-primary-text)">
                          <polygon points="7.5 5 17.5 12 7.5 19" />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={onMprisNext}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        padding: '0',
                      }}
                      title="Next"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                        <polygon points="5 4 15 12 5 20 5 4" />
                        <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* File System Mount Configuration */}
            {!isLocalMobile && isAllowed('fileaccess') && (
              <div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600 }}>Virtual Drive Mount</div>
                      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                        {device.driveLetter ? `Mounted on ${device.driveLetter}` : 'Not mounted'}
                      </div>
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      {/* Dropdown letter selection */}
                      <div style={{ position: 'relative' }}>
                        <button
                          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '6px 12px',
                            borderRadius: '8px',
                            border: '1px solid var(--border-color)',
                            background: 'rgba(255, 255, 255, 0.03)',
                            color: 'var(--text-color)',
                            fontSize: '13px',
                            minWidth: '120px',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            outline: 'none',
                          }}
                        >
                          <span>{preferredLetter || device.driveLetter || 'Auto Detect'}</span>
                          <svg
                            viewBox="0 0 24 24"
                            width="14"
                            height="14"
                            stroke="currentColor"
                            strokeWidth="2"
                            fill="none"
                            style={{
                              transform: isDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                              transition: 'transform 0.2s ease',
                              marginLeft: '8px'
                            }}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        {isDropdownOpen && (
                          <>
                            <div
                              onClick={() => setIsDropdownOpen(false)}
                              style={{
                                position: 'fixed',
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                zIndex: 999
                              }}
                            />
                            <div
                              style={{
                                position: 'absolute',
                                bottom: '100%',
                                right: 0,
                                marginBottom: '6px',
                                background: 'var(--modal-bg, #1e1e24)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '8px',
                                boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
                                zIndex: 1000,
                                minWidth: '160px',
                                maxHeight: '180px',
                                overflowY: 'auto',
                                padding: '4px 0',
                              }}
                              className="custom-scrollbar"
                            >
                              <div
                                onClick={() => {
                                  handleLetterChange('');
                                  setIsDropdownOpen(false);
                                }}
                                style={{
                                  padding: '8px 14px',
                                  fontSize: '13px',
                                  cursor: 'pointer',
                                  color: !(preferredLetter || device.driveLetter) ? 'var(--accent-color)' : 'var(--text-color)',
                                  background: !(preferredLetter || device.driveLetter) ? 'rgba(0, 155, 213, 0.05)' : 'transparent',
                                  transition: 'background 0.15s ease'
                                }}
                                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                                onMouseLeave={(e) => (e.currentTarget.style.background = !(preferredLetter || device.driveLetter) ? 'rgba(0, 155, 213, 0.05)' : 'transparent')}
                              >
                                Auto Detect
                              </div>
                              {lettersList
                                .filter((letter) => !occupiedLetters.includes(letter) || letter === (preferredLetter || device.driveLetter))
                                .map((letter) => {
                                  const isSelected = letter === (preferredLetter || device.driveLetter);
                                  return (
                                    <div
                                      key={letter}
                                      onClick={() => {
                                        handleLetterChange(letter);
                                        setIsDropdownOpen(false);
                                      }}
                                      style={{
                                        padding: '8px 14px',
                                        fontSize: '13px',
                                        cursor: 'pointer',
                                        color: isSelected ? 'var(--accent-color)' : 'var(--text-color)',
                                        background: isSelected ? 'rgba(0, 155, 213, 0.05)' : 'transparent',
                                        transition: 'background 0.15s ease'
                                      }}
                                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                                      onMouseLeave={(e) => (e.currentTarget.style.background = isSelected ? 'rgba(0, 155, 213, 0.05)' : 'transparent')}
                                    >
                                      {letter}
                                    </div>
                                  );
                                })}
                            </div>
                          </>
                        )}
                      </div>

                      {/* Action Toggle */}
                      <label className="switch-container" style={{ margin: 0 }}>
                        <span className="switch">
                          <input
                            type="checkbox"
                            checked={!!device.driveLetter}
                            onChange={handleToggleMount}
                          />
                          <span className="slider"></span>
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* The newest photos on a phone, pulled on demand (desktop only) */}
            {!isLocalMobile && isAllowed('fileaccess') && device.deviceType === 'phone' && device.connected && (
              <RecentPhotos deviceId={deviceId} />
            )}
            </fieldset>
          </>
        )}
      </div>
    </div>
    {locating && (
      <LocateModal deviceId={deviceId} deviceName={device.name} online={!offline} onClose={() => setLocating(false)} />
    )}
    </>
  );
};

export default DeviceControlPanel;
