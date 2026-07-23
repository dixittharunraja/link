import React, { useState } from 'react';
import DevicePopupPanel from './DevicePopupPanel';
import DevicePermissionsModal from './DevicePermissionsModal';

interface PeerDevice {
  deviceId: string;
  name: string;
  deviceType?: string;
  incomingCapabilities?: string[];
  outgoingCapabilities?: string[];
  trusted: boolean;
  isLocked?: boolean;
  isRinging?: boolean;
  connectivity?: Record<string, { networkType: string; signalStrength: number }>;
  battery?: { isCharging: boolean; currentCharge: number };
  flashlight?: boolean;
  dnd?: { enabled: boolean; granted: boolean };
  connected?: boolean;
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

interface ConnectionsTabProps {
  peers: Map<string, PeerDevice>;
  localDeviceType?: string;
  volumeSinks: Map<string, VolumeSink[]>;
  mprisState: MprisState | null;
  activeMprisDeviceId: string | null;
  onPair: (id: string) => void;
  onToggleRing: (id: string) => void;
  onLock: (id: string) => void;
  onToggleFlashlight: (id: string) => void;
  onToggleDnd: (id: string) => void;
  onSpeedTest: (id: string) => void;
  peerCommandLists: Map<string, Record<string, CommandEntry>>;
  onRunCommandTrigger: (deviceId: string, key: string) => void;
  onUnpair: (id: string) => void;
  onSetVolume: (id: string, sinkName: string, vol: number) => void;
  onToggleMute: (id: string, sinkName: string) => void;
  onMprisPrev: () => void;
  onMprisPlay: () => void;
  onMprisNext: () => void;
  onShowPresenter?: (id: string) => void;
  onShowTouchpad?: (id: string) => void;
  onShowDigitizer?: (id: string) => void;
  devicePermissions?: Record<string, Record<string, boolean | string>>;
  onSetPermission?: (deviceId: string, permKey: string, allowed: boolean | string) => void;
  onRenameTrustedDevice?: (deviceId: string, newName: string) => void;
  activeSpeedTestDeviceId?: string | null;
  visibilityEnabled?: boolean;
  onVisibilityToggle?: (enabled: boolean) => void;
  onConnect?: (host: string) => void;
}

const ConnectionsTab: React.FC<ConnectionsTabProps> = ({
  peers,
  localDeviceType,
  volumeSinks,
  mprisState,
  activeMprisDeviceId,
  onPair,
  onToggleRing,
  onLock,
  onToggleFlashlight,
  onToggleDnd,
  onSpeedTest,
  peerCommandLists,
  onRunCommandTrigger,
  onUnpair,
  onSetVolume,
  onToggleMute,
  onMprisPrev,
  onMprisPlay,
  onMprisNext,
  onShowPresenter,
  onShowTouchpad,
  onShowDigitizer,
  devicePermissions = {},
  onSetPermission,
  onRenameTrustedDevice,
  activeSpeedTestDeviceId,
  visibilityEnabled = true,
  onVisibilityToggle,
  onConnect,
}) => {
  const peerList = Array.from(peers.entries()).filter(([, info]) => info.trusted);
  const [activePopupDeviceId, setActivePopupDeviceId] = useState<string | null>(null);
  const [activeSettingsDeviceId, setActiveSettingsDeviceId] = useState<string | null>(null);

  const selectedDevice = activePopupDeviceId ? peers.get(activePopupDeviceId) : null;
  const selectedSettingsDevice = activeSettingsDeviceId ? peers.get(activeSettingsDeviceId) : null;

  const getPermission = (devId: string, permKey: string): boolean => {
    const devPerms = devicePermissions[devId];
    if (devPerms && devPerms[permKey] !== undefined) {
      const value = devPerms[permKey];
      // Clipboard used to store a directional string ('both'/'incoming'/'sending'/'none') from
      // before it became a plain sending-only toggle — treat any legacy value that included
      // sending as "on", so a device configured under the old system doesn't silently flip off.
      if (typeof value === 'string') {
        return value === 'both' || value === 'sending';
      }
      return value as boolean;
    }
    return true; // default allowed
  };

  const setPermission = (devId: string, permKey: string, allowed: boolean) => {
    if (onSetPermission) {
      onSetPermission(devId, permKey, allowed);
    }
  };

  const [showAddDevice, setShowAddDevice] = useState(false);
  const [ipInput, setIpInput] = useState('');

  const selectedSinks = activePopupDeviceId ? (volumeSinks.get(activePopupDeviceId) || []) : [];
  const isMediaActive = !!(selectedDevice && activeMprisDeviceId === activePopupDeviceId && mprisState);
  
  const nearbyList = Array.from(peers.entries()).filter(([, info]) => !info.trusted);

  const handleConnect = () => {
    const trimmed = ipInput.trim();
    if (!trimmed || !onConnect) return;
    onConnect(trimmed);
  };

  return (
    <div id="tab-devices" className="tab-content active">
      {/* Inline Discovery and Manual Add Panel */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
        <button
          onClick={() => setShowAddDevice(!showAddDevice)}
          style={{
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            background: showAddDevice ? 'transparent' : 'var(--accent-gradient)',
            border: showAddDevice ? '1px solid var(--border-color)' : 'none',
            color: showAddDevice ? 'var(--text-color)' : '#000000',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.15s ease'
          }}
        >
          {showAddDevice ? 'Hide Add Device Panel' : '+ Add Device'}
        </button>
      </div>

      {showAddDevice && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '18px', marginBottom: '24px' }}>
          {/* Discovery Visibility switch */}
          {onVisibilityToggle && (
            <div className="card" style={{ margin: 0 }}>
              <div className="card-title">Discovery Settings</div>
              <label className="switch-container">
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={visibilityEnabled}
                    onChange={(e) => onVisibilityToggle(e.target.checked)}
                  />
                  <span className="slider"></span>
                </span>
                Visible to LAN (Auto-Discovery Broadcast)
              </label>
            </div>
          )}

          {/* Manual Connection Input */}
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Add Device Manually</div>
            <div className="flex-row">
              <input
                type="text"
                placeholder="Enter target IP address"
                value={ipInput}
                onChange={(e) => setIpInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConnect();
                }}
                style={{ flex: 1 }}
              />
              <button onClick={handleConnect}>Connect</button>
            </div>
          </div>

          {/* Discovered Nearby Unpaired list */}
          <div className="card" style={{ margin: 0, gridColumn: '1 / -1' }}>
            <div className="card-title">Nearby Discovered Devices</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {nearbyList.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic', padding: '10px 0' }}>
                  No nearby devices discovered yet. Ensure devices are on the same Wi-Fi/LAN.
                </div>
              ) : (
                nearbyList.map(([id, info]) => {
                  const isPhone = info.deviceType === 'phone' || info.deviceType === 'tablet';
                  return (
                    <div
                      key={id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px 16px',
                        borderRadius: '8px',
                        border: '1px solid var(--border-color)',
                        background: 'rgba(255, 255, 255, 0.01)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ color: 'var(--accent-color)' }}>
                          {isPhone ? (
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                              <line x1="12" y1="18" x2="12.01" y2="18" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                              <line x1="8" y1="21" x2="16" y2="21" />
                              <line x1="12" y1="17" x2="12" y2="21" />
                            </svg>
                          )}
                        </span>
                        <div>
                          <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{info.name}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{isPhone ? 'Mobile Device' : 'Desktop PC'}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => onPair(id)}
                        style={{ padding: '5px 12px', fontSize: '11.5px' }}
                      >
                        Pair
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">
          <span>Trusted Devices</span>
          {peerList.length > 0 && (
            <button
              onClick={() => {
                // Wave 2: leave the pool — a single owner-signed "I'm leaving" that drops us from
                // every member. Falls back to unpairing each device on an older backend that
                // doesn't expose exitPool yet.
                if (window.confirm(`Exit this connection? This device will leave the pool and be removed from all ${peerList.length} device(s).`)) {
                  const api = (window as any).link;
                  if (api?.exitPool) api.exitPool();
                  else for (const [deviceId] of peerList) onUnpair(deviceId);
                }
              }}
              style={{
                padding: '5px 12px',
                fontSize: '11.5px',
                borderColor: '#ef4444',
                color: '#ef4444',
                background: 'transparent',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              Exit Connection
            </button>
          )}
        </div>
        <div id="peers">
          {peerList.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic', padding: '10px 0' }}>
              No devices paired or discovered in this room yet. Click "+ Add Device" to discover peers.
            </div>
          ) : (
            peerList.map(([deviceId, info]) => {
              const isActive = !!info.connected;
              const battery = info.battery;
              const hasBattery = battery !== undefined;

              let connText = '';
              if (info.connectivity) {
                connText = Object.entries(info.connectivity)
                  .map(([id, state]) => `[SIM ${id}: ${state.networkType} (${state.signalStrength}/4)]`)
                  .join(' ');
              }

              return (
                <div key={deviceId} style={{ marginBottom: '14px', borderBottom: '1px solid var(--border-color)', paddingBottom: '14px' }}>
                  {/* Clean List Item Row (Clickable if online) */}
                  <div
                    className="peer-row"
                    onClick={() => isActive && setActivePopupDeviceId(deviceId)}
                    style={{
                      cursor: isActive ? 'pointer' : 'default',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '14px 18px',
                      borderRadius: '8px',
                      border: '1px solid transparent',
                      transition: 'all 0.2s',
                      opacity: isActive ? 1 : 0.6,
                    }}
                    onMouseEnter={(e) => isActive && (e.currentTarget.style.borderColor = 'var(--border-color)')}
                    onMouseLeave={(e) => isActive && (e.currentTarget.style.borderColor = 'transparent')}
                  >
                    <div className="peer-info">
                      <div className={`status-dot ${isActive ? 'status-active' : 'status-inactive'}`}></div>
                      <div>
                        {(() => {
                          const isMobile = info.deviceType === 'phone' ||
                                           info.deviceType === 'tablet';

                          const deviceTypeIcon = isMobile ? (
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                              <line x1="12" y1="18" x2="12.01" y2="18" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                              <line x1="8" y1="21" x2="16" y2="21" />
                              <line x1="12" y1="17" x2="12" y2="21" />
                            </svg>
                          );

                          return (
                            <strong style={{ fontSize: '14.5px', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                              {deviceTypeIcon}
                              {info.name}
                            </strong>
                          );
                        })()}
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px', marginLeft: '6px' }}>
                          ({deviceId.slice(0, 8)})
                        </span>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          {hasBattery && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              Battery: {battery.currentCharge}%
                              {battery.isCharging && (
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style={{ color: '#10b981' }}>
                                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                                </svg>
                              )}
                            </span>
                          )}
                          {hasBattery && connText && ' | '}
                          {connText && <span>{connText}</span>}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      {info.trusted && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveSettingsDeviceId(deviceId);
                          }}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '6px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--text-muted)',
                            transition: 'color 0.15s, transform 0.15s',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = 'var(--text-color)';
                            e.currentTarget.style.transform = 'rotate(30deg)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = 'var(--text-muted)';
                            e.currentTarget.style.transform = 'rotate(0deg)';
                          }}
                          title="Device Permissions"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                          </svg>
                        </button>
                      )}

                      {info.trusted ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            // Wave 2: removing a device owner-signs + gossips a revocation so it's
                            // dropped pool-wide. Falls back to a plain unpair on an older backend.
                            const api = (window as any).link;
                            if (api?.removeFromPool) api.removeFromPool(deviceId);
                            else onUnpair(deviceId);
                          }}
                          style={{
                            padding: '6px 12px',
                            fontSize: '11.5px',
                            borderColor: '#ef4444',
                            color: '#ef4444',
                            background: 'transparent',
                            borderRadius: '6px',
                            cursor: 'pointer',
                          }}
                        >
                          Remove
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onPair(deviceId);
                          }}
                          style={{
                            padding: '6px 12px',
                            fontSize: '11.5px',
                            borderColor: 'var(--accent-color)',
                            color: 'var(--accent-color)',
                            background: 'transparent',
                            borderRadius: '6px',
                            cursor: 'pointer',
                          }}
                        >
                          Pair
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {activePopupDeviceId && selectedDevice && (
        <DevicePopupPanel
          deviceId={activePopupDeviceId}
          device={selectedDevice}
          selectedSinks={selectedSinks}
          isMediaActive={isMediaActive}
          mprisState={mprisState}
          peerCommands={peerCommandLists.get(activePopupDeviceId) || {}}
          activeSpeedTestDeviceId={activeSpeedTestDeviceId}
          onClose={() => setActivePopupDeviceId(null)}
          onPair={onPair}
          onToggleRing={onToggleRing}
          onLock={onLock}
          onSpeedTest={onSpeedTest}
          onToggleFlashlight={onToggleFlashlight}
          onToggleDnd={onToggleDnd}
          onShowPresenter={onShowPresenter}
          onShowTouchpad={onShowTouchpad}
          onShowDigitizer={onShowDigitizer}
          onRunCommandTrigger={onRunCommandTrigger}
          onSetVolume={onSetVolume}
          onToggleMute={onToggleMute}
          onMprisPrev={onMprisPrev}
          onMprisPlay={onMprisPlay}
          onMprisNext={onMprisNext}
          onRenameTrustedDevice={onRenameTrustedDevice}
        />
      )}

      {activeSettingsDeviceId && selectedSettingsDevice && (
        <DevicePermissionsModal
          deviceName={selectedSettingsDevice.name}
          localDeviceType={localDeviceType}
          getPermission={(permKey) => getPermission(activeSettingsDeviceId, permKey)}
          setPermission={(permKey, allowed) => setPermission(activeSettingsDeviceId, permKey, allowed)}
          onClose={() => setActiveSettingsDeviceId(null)}
        />
      )}
    </div>
  );
};

export default ConnectionsTab;
