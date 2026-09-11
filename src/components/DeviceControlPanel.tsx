import React, { useState, useEffect } from 'react';
import { LinkApi } from '../vite-env';
import { PeerDevice, VolumeSink, MprisState, CommandEntry } from '../types/peer';

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
  onRunCommandTrigger: (deviceId: string, key: string) => void;
  onSetVolume: (id: string, sinkName: string, vol: number) => void;
  onToggleMute: (id: string, sinkName: string) => void;
  onMprisPrev: () => void;
  onMprisPlay: () => void;
  onMprisNext: () => void;
  onRenameTrustedDevice?: (deviceId: string, newName: string) => void;
}

// Matches core/identity.ts's real DeviceType union exactly.
type DeviceCategory = 'phone' | 'tv' | 'desktop';

interface PluginDescriptor {
  id: string;
  permissionKey?: string;
  packetType?: string | string[];
  allowedTargetTypes?: DeviceCategory[];
  allowedLocalTypes?: ('mobile' | 'desktop')[];
  // Escape hatch for gating that depends on BOTH the target device's declared capabilities and
  // the local platform at once (e.g. remote-input's touch-vs-keyboard split below) — the plain
  // packetType/allowedLocalTypes checks can't express "capability X only when local is mobile".
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

const PLUGIN_REGISTRY: PluginDescriptor[] = [
  {
    id: 'ring',
    packetType: ['link.findmydevice.request'],
    title: (d) => (d.isRinging ? 'Stop Ringing' : 'Ring'),
    isActive: (d) => !!d.isRinging,
    onClick: (id, ctx) => ctx.onToggleRing(id),
  },
  {
    id: 'lock',
    permissionKey: 'lock',
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
    // Mobile-to-desktop/tv presenter only. The keyboard/mouse/presenter overlays
    // (the controller UI opened by onShowPresenter below) still uses the phone-only
    // `landscape-overlay` CSS class (rotates a portrait phone screen into a landscape control
    // strip) and touch-only event handlers — it will render sideways and won't respond to mouse
    // input when opened from a desktop. That's a separate, follow-up fix.
    allowedTargetTypes: ['desktop', 'tv', 'phone'],
    allowedLocalTypes: ['mobile'],
    requiresCallback: (ctx) => !!ctx.onShowPresenter,
    title: () => 'Presenter',
    onClick: (id, ctx) => ctx.onShowPresenter(id),
  },
  {
    // One "Remote Input" button whose actual surface depends on the TARGET device: touchpad
    // (mouse) + keyboard + pen for a desktop target, keyboard + D-Pad + pen for a TV target. No
    // phone target: a phone-to-phone "remote control" isn't a real use case, and injecting text/
    // D-pad/touch into another phone needs that phone's OWN Accessibility Service enabled, which
    // conflicts with banking/UPI apps on a device people actually carry and pay with day to day —
    // not a cost worth imposing for a feature nobody asked for. TVs rarely run those apps and
    // already expect this exact grant from any TV remote app, so the trade-off is fine there.
    // The touchpad surface is touch-driven (RemoteInputOverlay), so it only makes sense when the
    // LOCAL device is mobile; the keyboard/D-Pad surface (RemoteKeyboardOverlay) is plain key/text
    // events and works from either platform. Digitizer (absolute stylus input) is a mode toggle
    // inside whichever of these two overlays opens, not its own button/permission.
    id: 'remoteinput',
    permissionKey: 'remoteinput',
    allowedTargetTypes: ['desktop', 'tv'],
    extraFilter: (d, isLocalMobile) => {
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
    id: 'joystick',
    allowedTargetTypes: ['desktop'],
    allowedLocalTypes: ['mobile'],
    requiresCallback: (ctx) => !!ctx.onShowJoystick,
    title: () => 'Joystick',
    onClick: (id, ctx) => ctx.onShowJoystick(id),
  },
];

// Extracted from DevicesTab.tsx, where this was ~380 lines living inline as part of one 900+
// line file. Pure move — same JSX/logic, props now passed explicitly instead of closed over the
// parent's scope, no behavior change. The rename-in-header local state moves in with it since
// it's purely local UI state for this panel, not shared with anything else.
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
  onRunCommandTrigger,
  onSetVolume,
  onToggleMute,
  onMprisPrev,
  onMprisPlay,
  onMprisNext,
  onRenameTrustedDevice,
}) => {
  const [editingDeviceName, setEditingDeviceName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [preferredLetter, setPreferredLetter] = useState<string>('');
  const [occupiedLetters, setOccupiedLetters] = useState<string[]>([]);
  const [lettersList, setLettersList] = useState<string[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const isLocalMobile = typeof (window as any).Capacitor !== 'undefined';

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

  // Real-time capability check helper
  const supportsIncoming = (cap?: string | string[]) => {
    if (!cap) return true;
    const caps = Array.isArray(cap) ? cap : [cap];
    const peerIncoming = device.incomingCapabilities || [];
    return caps.some((c) => peerIncoming.includes(c));
  };

  // Real-time permission gate check helper
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
    activeSpeedTestDeviceId,
  };

  // 100% Real-Time Data-Driven Plugin Registry evaluation
  const activePlugins = PLUGIN_REGISTRY.filter((p) => {
    // 1. Permission Gate (real-time TLS permission list)
    if (!isAllowed(p.permissionKey)) return false;
    // 2. Incoming Capability Check (handshake capabilities)
    if (!supportsIncoming(p.packetType)) return false;
    // 3. Target Device Type Scope
    if (p.allowedTargetTypes && !p.allowedTargetTypes.includes(targetCategory)) return false;
    // 4. Local Sender Platform Scope (Mobile vs Desktop)
    if (p.allowedLocalTypes && !p.allowedLocalTypes.includes(isLocalMobile ? 'mobile' : 'desktop')) return false;
    // 5. Combined target-capability + local-platform gating (see PluginDescriptor.extraFilter)
    if (p.extraFilter && !p.extraFilter(device, isLocalMobile)) return false;
    // 6. Callback Requirement Check
    if (p.requiresCallback && !p.requiresCallback(contextHelpers, device)) return false;
    // 7. Device State Presence Requirement
    if (p.requiresState && !p.requiresState(device)) return false;

    return true;
  });

  return (
    <div className="modal" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '540px',
          textAlign: 'left',
          background: 'var(--modal-bg)',
          border: '1px solid var(--border-color)',
          boxShadow: '0 25px 60px var(--modal-shadow)',
          padding: '28px',
          maxHeight: '90vh',
          overflowY: 'auto'
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
          {editingDeviceName !== null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
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
                  border: '1px solid var(--accent-color)'
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
                style={{ padding: '4px 10px', fontSize: '12px' }}
              >
                Save
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700, margin: 0 }}>
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
                    padding: '2px 6px',
                    fontSize: '13px',
                    color: 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                  title="Rename device"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </button>
              )}
            </div>
          )}
          <button
            onClick={onClose}
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
            {/* Real-time Dynamic Plugins Grid */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                Plugins
              </div>
              <div className="peer-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {activePlugins.map((plugin) => (
                  <button
                    key={plugin.id}
                    className={
                      (plugin.isActive?.(device) ? 'plugin-toggle-on ' : '') +
                      (plugin.isDisabled?.(device, contextHelpers) ? 'testing-pulse' : '')
                    }
                    disabled={plugin.isDisabled?.(device, contextHelpers)}
                    onClick={() => plugin.onClick(deviceId, contextHelpers, device)}
                  >
                    {plugin.title(device, contextHelpers)}
                  </button>
                ))}

                {/* Run Command whitelist items (data-driven from peer script list) */}
                {isAllowed('runcommand') && Object.keys(peerCommands).map((key) => (
                  <button key={key} onClick={() => onRunCommandTrigger(deviceId, key)}>
                    {peerCommands[key].name}
                  </button>
                ))}
              </div>
            </div>

            {/* Volume Control */}
            {isAllowed('systemvolume') && selectedSinks.length > 0 && (
              <div style={{ marginBottom: '20px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                  Volume Control
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {selectedSinks.map((sink) => (
                    <div key={sink.name} style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', height: '32px' }}>
                      <span style={{ display: 'inline-block', fontSize: '12px', color: 'var(--text-muted)', width: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {sink.description}
                      </span>
                      <input
                        type="range"
                        min="0"
                        max={sink.maxVolume || 100}
                        value={sink.volume}
                        onChange={(e) => onSetVolume(deviceId, sink.name, parseInt(e.target.value, 10))}
                        style={{ flexGrow: 1 }}
                      />
                      <div style={{ width: '32px', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
                        {sink.name !== 'alarm' && (
                          <button
                            onClick={() => onToggleMute(deviceId, sink.name)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '6px',
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
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                  Media Controller
                </div>
                <div style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{mprisState?.title || 'Unknown Track'}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>{mprisState?.artist || 'Unknown Artist'}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                      onClick={onMprisPrev}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '36px',
                        height: '36px',
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
                        width: '40px',
                        height: '40px',
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
                        width: '36px',
                        height: '36px',
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
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: '20px' }}>
                <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                  File System Mount
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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
          </>
        )}
      </div>
    </div>
  );
};

export default DeviceControlPanel;
