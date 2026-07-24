import React, { useState } from 'react';

interface PeerDevice {
  deviceId: string;
  name: string;
  deviceType?: string;
  incomingCapabilities?: string[];
  outgoingCapabilities?: string[];
  trusted: boolean;
  isLocked?: boolean;
  isRinging?: boolean;
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

interface CommandEntry {
  name: string;
  command: string;
}

interface DevicePopupPanelProps {
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
  onShowDigitizer?: (id: string) => void;
  onRunCommandTrigger: (deviceId: string, key: string) => void;
  onSetVolume: (id: string, sinkName: string, vol: number) => void;
  onToggleMute: (id: string, sinkName: string) => void;
  onMprisPrev: () => void;
  onMprisPlay: () => void;
  onMprisNext: () => void;
  onRenameTrustedDevice?: (deviceId: string, newName: string) => void;
}

// Extracted from DevicesTab.tsx, where this was ~380 lines living inline as part of one 900+
// line file. Pure move — same JSX/logic, props now passed explicitly instead of closed over the
// parent's scope, no behavior change. The rename-in-header local state moves in with it since
// it's purely local UI state for this panel, not shared with anything else.
const DevicePopupPanel: React.FC<DevicePopupPanelProps> = ({
  deviceId,
  device,
  selectedSinks,
  isMediaActive,
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
  onShowDigitizer,
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

  const isTargetMobile = device.deviceType === 'phone' || device.deviceType === 'tablet';

  // Shared between the header icon toolbar and the Plugins list below. Gated strictly on the
  // peer's REAL advertised capability list — no "assume supported until proven otherwise"
  // fallback. Capabilities arrive as part of the connect-time identity handshake, so by the time
  // a device is selectable in this list at all, its real list should already be populated; if it
  // isn't yet, the buttons simply don't show rather than optimistically rendering wrong ones.
  const peerIncoming = device.incomingCapabilities || [];
  const supportsIncoming = (cap: string) => peerIncoming.includes(cap);

  // Unified per-peer permission gate — the peer pushes this list (see App.tsx's
  // onPeerCapabilitiesReceived) whenever what we're currently allowed to do there changes. A key's
  // absence hides the corresponding section immediately, regardless of any stale value still
  // cached from before a permission was turned off — replaces the old per-plugin "revoked" flags.
  const allowedCaps = device.allowedCapabilities;
  const isAllowed = (key: string) => allowedCaps === undefined || allowedCaps.includes(key);

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
                  background: 'var(--input-bg)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: 'var(--text-color)',
                  padding: '4px 10px',
                  fontSize: '15px',
                  fontWeight: 600,
                  outline: 'none',
                  width: '180px'
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
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-color)',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Save Name"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button
                onClick={() => setEditingDeviceName(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Cancel"
              >
                ✕
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700 }}>
                {device.name}
              </span>
              {device.trusted && onRenameTrustedDevice && (
                <button
                  onClick={() => {
                    setEditingDeviceName(device.name);
                    setRenameValue(device.name);
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '2px',
                    transition: 'color 0.15s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-color)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
                  title="Rename Device"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
              color: 'var(--text-muted)',
              fontSize: '16px',
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
              style={{ width: '100%', padding: '12px', fontWeight: 600, background: 'var(--accent-gradient)', border: 'none', color: '#000' }}
            >
              Pair Device
            </button>
          </div>
        ) : (
          <>
            {/* Plugins Grid */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                Plugins
              </div>
              <div className="peer-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {supportsIncoming('link.findmyphone.request') && (
                  <button className={device.isRinging ? 'plugin-toggle-on' : ''} onClick={() => onToggleRing(deviceId)}>
                    {device.isRinging ? 'Stop Ringing' : 'Ring'}
                  </button>
                )}
                {isAllowed('lock') && (supportsIncoming('link.lock.request') || supportsIncoming('link.lock')) && (
                  <button
                    className={device.isLocked ? 'plugin-toggle-on' : ''}
                    onClick={() => onLock(deviceId)}
                    title={device.isLocked ? 'Refresh lock status — remote unlock is not possible on any platform without the device\'s real credentials' : 'Lock this device'}
                  >
                    Lock
                  </button>
                )}
                <button
                  onClick={() => onSpeedTest(deviceId)}
                  disabled={activeSpeedTestDeviceId === deviceId}
                  className={activeSpeedTestDeviceId === deviceId ? 'testing-pulse' : ''}
                >
                  {activeSpeedTestDeviceId === deviceId ? (
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.2s linear infinite' }}>
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                      </svg>
                      Testing...
                    </span>
                  ) : (
                    'Speed Test'
                  )}
                </button>
                {isTargetMobile ? (
                  <>
                    {/* Gated on the peer's pushed allowedCapabilities list (isAllowed) — hides
                        instantly on permission revoke regardless of stale cached state — AND
                        on real state having actually arrived at all. */}
                    {isAllowed('flashlight') && device.flashlight !== undefined && (
                      <button className={device.flashlight ? 'plugin-toggle-on' : ''} onClick={() => onToggleFlashlight(deviceId)}>
                        Flashlight
                      </button>
                    )}
                    {isAllowed('dnd') && device.dnd !== undefined && (
                      <button className={device.dnd?.enabled ? 'plugin-toggle-on' : ''} onClick={() => onToggleDnd(deviceId)}>
                        DND
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {/* These buttons live on the SENDING side (mobile controlling a PC peer),
                        so the check must be whether the PEER can RECEIVE the command — its
                        incoming capability list — not its outgoing one. */}
                    {onShowPresenter && isAllowed('presenter') && supportsIncoming('link.presenter') && (
                      <button onClick={() => onShowPresenter(deviceId)}>Presenter</button>
                    )}
                    {onShowTouchpad && isAllowed('touchpad') && supportsIncoming('link.touchpad.request') && (
                      <button onClick={() => onShowTouchpad(deviceId)}>Remote Input</button>
                    )}
                    {onShowDigitizer && isAllowed('digitizer') && supportsIncoming('link.digitizer.session') && (
                      <button onClick={() => onShowDigitizer(deviceId)}>Digitizer</button>
                    )}
                    {/* Run Command — data-driven off what this peer actually sent us, PLUS
                        gated on their live allowedCapabilities list (isAllowed). The peer only
                        ever sends its whitelist if its own permission-for-us allowed it, but
                        without the isAllowed check the buttons stayed visible-but-broken after
                        a later revoke, since peerCommands is just a cache of what arrived
                        before — same staleness bug Lock had before it got the same fix. */}
                    {isAllowed('runcommand') && Object.keys(peerCommands).map((key) => (
                      <button key={key} onClick={() => onRunCommandTrigger(deviceId, key)}>
                        {peerCommands[key].name}
                      </button>
                    ))}
                  </>
                )}
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
            {isAllowed('mpris') && isMediaActive && (
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
                        boxShadow: '0 4px 12px rgba(0, 240, 255, 0.2)',
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
          </>
        )}
      </div>
    </div>
  );
};

export default DevicePopupPanel;
