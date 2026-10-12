import React, { useState, useEffect } from 'react';
import DeviceControlPanel from './DeviceControlPanel';
import DevicePermissionsModal from './DevicePermissionsModal';
import { ConfirmDialog } from './DialogCard';
import RemoteKeyboardOverlay from './RemoteKeyboardOverlay';
import { IpScanField, ScannerModal } from './ModalDialog';
import { pushBackHandler } from '../utils/backNav';
import { PeerDevice, VolumeSink, CommandEntry } from '../types/peer';
import { createLinkQrDataUrl } from '../utils/qr';

interface ConnectionsTabProps {
  peers: Map<string, PeerDevice>;
  localDeviceType?: string;
  volumeSinks: Map<string, VolumeSink[]>;
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
  onShowPresenter?: (id: string) => void;
  onShowTouchpad?: (id: string) => void;
  onShowJoystick?: (id: string) => void;
  onShowRemoteControl?: (id: string) => void;
  devicePermissions?: Record<string, Record<string, boolean | string>>;
  onSetPermission?: (deviceId: string, permKey: string, allowed: boolean | string) => void;
  onRenameTrustedDevice?: (deviceId: string, newName: string) => void;
  activeSpeedTestDeviceId?: string | null;
  discoveredPeers?: Map<string, any>;
  visibilityEnabled?: boolean;
  onVisibilityToggle?: (enabled: boolean) => void;
  onConnect?: (host: string) => void;
  showAddDevice?: boolean;
  onSetShowAddDevice?: (show: boolean) => void;
}

const ConnectionsTab: React.FC<ConnectionsTabProps> = ({
  peers,
  localDeviceType,
  volumeSinks,
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
  onShowPresenter,
  onShowTouchpad,
  onShowJoystick,
  onShowRemoteControl,
  devicePermissions = {},
  onSetPermission,
  onRenameTrustedDevice,
  activeSpeedTestDeviceId,
  discoveredPeers,
  visibilityEnabled = true,
  onVisibilityToggle,
  onConnect,
  showAddDevice,
  onSetShowAddDevice,
}) => {
  const peerList = Array.from(peers.entries()).filter(([, info]) => info.trusted);
  const [activeControlPanelDeviceId, setActiveControlPanelDeviceId] = useState<string | null>(null);
  const [activeSettingsDeviceId, setActiveSettingsDeviceId] = useState<string | null>(null);
  const [activeRemoteKeyboardDeviceId, setActiveRemoteKeyboardDeviceId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    { type: 'remove-device'; deviceId: string; name: string } | null
  >(null);

  const selectedDevice = activeControlPanelDeviceId ? peers.get(activeControlPanelDeviceId) : null;
  const selectedSettingsDevice = activeSettingsDeviceId ? peers.get(activeSettingsDeviceId) : null;
  const selectedKeyboardDevice = activeRemoteKeyboardDeviceId ? peers.get(activeRemoteKeyboardDeviceId) : null;

  // Media control handlers — defined here so they have access to activeControlPanelDeviceId and peers
  const handleMprisPrev = () => {
    if (activeControlPanelDeviceId && window.link?.sendMprisAction) {
      const device = peers.get(activeControlPanelDeviceId);
      const playerName = device?.mprisState?.player || '';
      window.link.sendMprisAction(activeControlPanelDeviceId, playerName, 'Previous');
    }
  };

  const handleMprisPlay = () => {
    if (activeControlPanelDeviceId && window.link?.sendMprisAction) {
      const device = peers.get(activeControlPanelDeviceId);
      const playerName = device?.mprisState?.player || '';
      window.link.sendMprisAction(activeControlPanelDeviceId, playerName, 'PlayPause');
    }
  };

  const handleMprisNext = () => {
    if (activeControlPanelDeviceId && window.link?.sendMprisAction) {
      const device = peers.get(activeControlPanelDeviceId);
      const playerName = device?.mprisState?.player || '';
      window.link.sendMprisAction(activeControlPanelDeviceId, playerName, 'Next');
    }
  };

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
    return false; // default denied for newly connected / unconfigured devices
  };

  const setPermission = (devId: string, permKey: string, allowed: boolean) => {
    if (onSetPermission) {
      onSetPermission(devId, permKey, allowed);
    }
  };

  const [localShowAddDevice, setLocalShowAddDevice] = useState(false);
  const isAddDeviceVisible = showAddDevice !== undefined ? showAddDevice : localShowAddDevice;
  const setIsAddDeviceVisible = onSetShowAddDevice || setLocalShowAddDevice;
  const [ipInput, setIpInput] = useState('');

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showScannerModal, setShowScannerModal] = useState(false);

  // Back Navigation Handlers for ConnectionsTab modals & sub-panels
  useEffect(() => {
    if (!activeControlPanelDeviceId) return;
    return pushBackHandler(() => {
      setActiveControlPanelDeviceId(null);
      return true;
    });
  }, [activeControlPanelDeviceId]);

  useEffect(() => {
    if (!activeSettingsDeviceId) return;
    return pushBackHandler(() => {
      setActiveSettingsDeviceId(null);
      return true;
    });
  }, [activeSettingsDeviceId]);

  useEffect(() => {
    if (!activeRemoteKeyboardDeviceId) return;
    return pushBackHandler(() => {
      setActiveRemoteKeyboardDeviceId(null);
      return true;
    });
  }, [activeRemoteKeyboardDeviceId]);

  useEffect(() => {
    if (!isAddDeviceVisible) return;
    return pushBackHandler(() => {
      setIsAddDeviceVisible(false);
      return true;
    });
  }, [isAddDeviceVisible, setIsAddDeviceVisible]);

  React.useEffect(() => {
    const generateLocalQr = async () => {
      const api = window.link;
      if (!api) return;
      try {
        const id = await api.getIdentity();
        const ip = (id.ipAddresses && id.ipAddresses.length > 0)
          ? id.ipAddresses.join(',')
          : (id.ipAddress || '127.0.0.1');
        const url = await createLinkQrDataUrl(ip, 1716);
        setQrDataUrl(url);
      } catch (err) {
        console.error('Failed to generate QR Code:', err);
      }
    };
    generateLocalQr();
  }, []);

  const handleDecodedHost = (host: string) => {
    setShowScannerModal(false);
    setIpInput(host);
    if (onConnect) onConnect(host);
  };

  const selectedSinks = activeControlPanelDeviceId ? (volumeSinks.get(activeControlPanelDeviceId) || []) : [];
  // Get this device's media state (not global) to prevent leak where other device's media shows
  const selectedMprisState = selectedDevice?.mprisState || null;
  const isMediaActive = !!(selectedDevice && selectedMprisState);
  
  // nearbyList comes from UDP discovery (unpaired discovered peers)
  const rawDiscovered = discoveredPeers ? Array.from(discoveredPeers.entries()) : [];
  const nearbyList = rawDiscovered
    .filter(([id]) => !peers.has(id) || !peers.get(id)?.trusted)
    .map(([id, info]) => [id, {
      name: info.deviceName || id.slice(0, 8),
      deviceType: info.deviceType || 'phone',
      ipAddress: info.ipAddress,
      trusted: false,
    }] as [string, any]);

  const handleConnect = () => {
    const trimmed = ipInput.trim();
    if (!trimmed || !onConnect) return;
    onConnect(trimmed);
  };

  return (
    <div id="tab-devices" className="tab-content active">
      <div className="card">
        <div className="card-title">
          <span>Trusted Devices</span>
        </div>
        <div id="peers">
          {peerList.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic', padding: '10px 0' }}>
              No devices paired or discovered in this room yet. Click "+ Add Device" to discover peers.
            </div>
          ) : (
            peerList.map(([deviceId, info]) => {
              const isActive = !!(info.trusted && info.connected);
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
                    onClick={() => isActive && setActiveControlPanelDeviceId(deviceId)}
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
                          const isMobile = info.deviceType === 'phone';

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
                          ({info.ipAddress || discoveredPeers?.get(deviceId)?.ipAddress || 'Offline'})
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
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = 'var(--text-muted)';
                          }}
                          title="Device Permissions"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="4" y1="21" x2="4" y2="14" />
                            <line x1="4" y1="10" x2="4" y2="3" />
                            <line x1="12" y1="21" x2="12" y2="12" />
                            <line x1="12" y1="8" x2="12" y2="3" />
                            <line x1="20" y1="21" x2="20" y2="16" />
                            <line x1="20" y1="12" x2="20" y2="3" />
                            <line x1="1" y1="14" x2="7" y2="14" />
                            <line x1="9" y1="8" x2="15" y2="8" />
                            <line x1="17" y1="16" x2="23" y2="16" />
                          </svg>
                        </button>
                      )}

                      {info.trusted ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmAction({ type: 'remove-device', deviceId, name: info.name });
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

      <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '0 0 10px 0' }}>
        <button
          onClick={() => setIsAddDeviceVisible(!isAddDeviceVisible)}
          style={{
            padding: '7px 14px',
            fontSize: '12.5px',
            fontWeight: 600,
            background: isAddDeviceVisible ? 'transparent' : 'var(--accent-gradient)',
            border: isAddDeviceVisible ? '1px solid var(--border-color)' : 'none',
            color: isAddDeviceVisible ? 'var(--text-color)' : 'var(--btn-primary-text)',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.15s ease'
          }}
        >
          {isAddDeviceVisible ? 'Hide Add Device Panel' : '+ Add Device'}
        </button>
        {peerList.length > 0 && (
          <button
            onClick={() => {
              setConfirmAction({ type: 'exit-pool' as any, deviceId: '', name: '' });
            }}
            style={{
              padding: '7px 14px',
              fontSize: '12.5px',
              fontWeight: 600,
              background: 'transparent',
              border: '1px solid #ef4444',
              color: '#ef4444',
              borderRadius: '6px',
              cursor: 'pointer',
              marginLeft: '10px',
              transition: 'all 0.15s ease'
            }}
          >
            Exit Pool
          </button>
        )}
      </div>

      {isAddDeviceVisible && (
        <div
          className="card"
          style={{
            width: '100%',
            background: 'var(--card-bg)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 8px 32px var(--modal-shadow, rgba(0, 0, 0, 0.2))',
            borderRadius: '14px',
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            marginTop: '4px',
            marginBottom: '12px',
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-color)' }}>Add Device</div>
              <button
                onClick={() => setIsAddDeviceVisible(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '18px',
                  cursor: 'pointer',
                  padding: '4px',
                }}
              >
                ✕
              </button>
            </div>

            {/* Two-Column Grid: Left: Connection Input & Vis, Right: QR Code */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
              {/* Left Side: Manual Connection & Discovery visibility */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* Manual Connection Input */}
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-color)' }}>Add Device Manually</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <IpScanField
                      value={ipInput}
                      onChange={setIpInput}
                      onScanClick={() => setShowScannerModal(true)}
                      onEnter={() => {
                        handleConnect();
                        setIsAddDeviceVisible(false);
                      }}
                      placeholder="Enter target IP address"
                    />
                    <button
                      onClick={() => {
                        handleConnect();
                        setIsAddDeviceVisible(false);
                      }}
                      style={{ padding: '8px 16px', width: '100%', boxSizing: 'border-box' }}
                    >
                      Connect
                    </button>
                  </div>
                </div>

                {/* Discovery Settings */}
                {onVisibilityToggle && (
                  <div style={{ padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ marginRight: '12px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 600 }}>Device Visibility</div>
                        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                          {visibilityEnabled ? 'Visible to Everyone (New devices can discover & pair)' : 'Trusted Devices Only (Hidden from strangers on public Wi-Fi)'}
                        </div>
                      </div>
                      <label className="switch-container" style={{ margin: 0 }}>
                        <span className="switch">
                          <input
                            type="checkbox"
                            checked={visibilityEnabled}
                            onChange={(e) => onVisibilityToggle(e.target.checked)}
                          />
                          <span className="slider"></span>
                        </span>
                      </label>
                    </div>
                  </div>
                )}
              </div>

              {/* Right Side: QR Code always visible */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid var(--border-color)', paddingLeft: '20px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-color)', textAlign: 'center' }}>Show My QR</div>
                {qrDataUrl ? (
                  <div style={{ background: '#fff', padding: '10px', borderRadius: '10px', display: 'inline-block', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                    <img src={qrDataUrl} alt="Device QR Code" style={{ width: '130px', height: '130px', display: 'block' }} />
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>Generating QR...</div>
                )}
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px', textAlign: 'center', maxWidth: '180px' }}>
                  Scan from your other device to connect instantly
                </div>
              </div>
            </div>

            {/* Nearby Devices Section (full width below the columns) */}
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-color)' }}>Nearby Devices</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto' }}>
                {nearbyList.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic', padding: '6px 0' }}>
                    Searching LAN for nearby devices...
                  </div>
                ) : (
                  nearbyList.map(([id, info]) => {
                    const isPhone = info.deviceType === 'phone';
                    return (
                      <div
                        key={id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 14px',
                          borderRadius: '8px',
                          border: '1px solid var(--border-color)',
                          background: 'rgba(255, 255, 255, 0.02)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ color: 'var(--accent-color)' }}>
                            {isPhone ? (
                              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                                <line x1="12" y1="18" x2="12.01" y2="18" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                                <line x1="8" y1="21" x2="16" y2="21" />
                                <line x1="12" y1="17" x2="12" y2="21" />
                              </svg>
                            )}
                          </span>
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 600 }}>{info.name}</div>
                            <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                              {isPhone ? 'Mobile Device' : 'Desktop PC'}{info.ipAddress ? ` • ${info.ipAddress}` : ''}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            onPair(id);
                            setIsAddDeviceVisible(false);
                          }}
                          style={{ padding: '4px 10px', fontSize: '11px' }}
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

      {activeControlPanelDeviceId && selectedDevice && (
        <DeviceControlPanel
          deviceId={activeControlPanelDeviceId}
          device={selectedDevice}
          selectedSinks={selectedSinks}
          isMediaActive={isMediaActive}
          mprisState={selectedMprisState}
          peerCommands={peerCommandLists.get(activeControlPanelDeviceId) || {}}
          activeSpeedTestDeviceId={activeSpeedTestDeviceId}
          onClose={() => setActiveControlPanelDeviceId(null)}
          onPair={onPair}
          onToggleRing={onToggleRing}
          onLock={onLock}
          onSpeedTest={onSpeedTest}
          onToggleFlashlight={onToggleFlashlight}
          onToggleDnd={onToggleDnd}
          onShowPresenter={(id) => {
            setActiveControlPanelDeviceId(null);
            onShowPresenter?.(id);
          }}
          onShowTouchpad={(id) => {
            setActiveControlPanelDeviceId(null);
            onShowTouchpad?.(id);
          }}
          onShowJoystick={(id) => {
            setActiveControlPanelDeviceId(null);
            onShowJoystick?.(id);
          }}
          onShowRemoteControl={(id) => {
            setActiveControlPanelDeviceId(null);
            onShowRemoteControl?.(id);
          }}
          onShowRemoteInput={(id) => setActiveRemoteKeyboardDeviceId(id)}
          onRunCommandTrigger={onRunCommandTrigger}
          onSetVolume={onSetVolume}
          onToggleMute={onToggleMute}
          onMprisPrev={handleMprisPrev}
          onMprisPlay={handleMprisPlay}
          onMprisNext={handleMprisNext}
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

      {activeRemoteKeyboardDeviceId && selectedKeyboardDevice && (
        <RemoteKeyboardOverlay
          deviceId={activeRemoteKeyboardDeviceId}
          deviceName={selectedKeyboardDevice.name}
          onClose={() => setActiveRemoteKeyboardDeviceId(null)}
        />
      )}



      {confirmAction?.type === 'remove-device' && (
        <ConfirmDialog
          title="Remove Device"
          message={`Remove "${confirmAction.name}"? It will need to be paired again to reconnect.`}
          confirmLabel="Remove"
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            const targetId = confirmAction.deviceId;
            setConfirmAction(null);
            onUnpair(targetId);
          }}
        />
      )}

      {confirmAction?.type === 'exit-pool' as any && (
        <ConfirmDialog
          title="Exit Pool"
          message="Are you sure you want to exit the pool? This will unpair all other devices on this device."
          confirmLabel="Exit Pool"
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            setConfirmAction(null);
            window.link?.exitPool()?.then(() => {
              window.location.reload();
            });
          }}
        />
      )}



      <ScannerModal
        open={showScannerModal}
        onClose={() => setShowScannerModal(false)}
        onDecoded={handleDecodedHost}
        title="Scan Connection QR Code"
      />
    </div>
  );
};

export default ConnectionsTab;
