import React, { useState, useEffect, lazy, Suspense } from 'react';
import DeviceControlPanel from './DeviceControlPanel';
import { BatteryIndicator } from './BatteryIcon';
import { DeviceIcon } from './DeviceIcon';
import DevicePermissionsModal from './DevicePermissionsModal';
import { ConfirmDialog } from './DialogCard';
import { IpScanField, ScannerModal } from './ModalDialog';
import { pushBackHandler } from '../utils/backNav';
import { PeerDevice, VolumeSink, CommandEntry } from '../types/peer';
import { createLinkQrDataUrl, createPairingQrDataUrl } from '../utils/qr';
import { LINK_PORT } from '../utils/ports';

// Full-screen overlay (it shares code with the touchpad overlay), loaded the first time it is opened.
const RemoteKeyboardOverlay = lazy(() => import('./RemoteKeyboardOverlay'));

interface ConnectionsTabProps {
  peers: Map<string, PeerDevice>;
  localDeviceType?: string;
  /** This device's addresses, joined; when they change (a new network) the pairing QR is drawn again. */
  localAddresses?: string;
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
  onShowCamera?: (id: string) => void;
  onShowSecondScreen?: (id: string) => void;
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
  localAddresses,
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
  onShowCamera,
  onShowSecondScreen,
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
  // Online devices first, then by name, so a device keeps its place and does not jump around as others
  // come and go (the map itself is in the order they were first seen).
  const peerList = Array.from(peers.entries())
    .filter(([, info]) => info.trusted)
    .sort(([, a], [, b]) =>
      Number(!!b.connected) - Number(!!a.connected) ||
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base', numeric: true }));
  const [activeControlPanelDeviceId, setActiveControlPanelDeviceId] = useState<string | null>(null);
  const [activeSettingsDeviceId, setActiveSettingsDeviceId] = useState<string | null>(null);
  const [activeRemoteKeyboardDeviceId, setActiveRemoteKeyboardDeviceId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    { type: 'remove-device'; deviceId: string; name: string } | null
  >(null);

  const selectedDevice = activeControlPanelDeviceId ? peers.get(activeControlPanelDeviceId) : null;
  const selectedSettingsDevice = activeSettingsDeviceId ? peers.get(activeSettingsDeviceId) : null;
  const selectedKeyboardDevice = activeRemoteKeyboardDeviceId ? peers.get(activeRemoteKeyboardDeviceId) : null;

  // Media controls for the device whose control panel is open.
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
      return devPerms[permKey] as boolean;
    }
    return false; // unset means denied
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

  // Back closes this tab's dialogs and panels.
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

  // New devices can pair only while this screen is up. The window opens with it, the QR carries this
  // device's key fingerprint and a one-time token, and the token is renewed before it expires.
  React.useEffect(() => {
    if (!isAddDeviceVisible) {
      setQrDataUrl(null);
      return;
    }
    const api = window.link;
    if (!api) return;
    let cancelled = false;
    let addresses = '';
    let fingerprint = '';
    const draw = async (token: string) => {
      const url = await createPairingQrDataUrl(addresses, LINK_PORT, fingerprint, token);
      if (!cancelled) setQrDataUrl(url);
    };
    (async () => {
      try {
        const id = await api.getIdentity();
        addresses = (id.ipAddresses && id.ipAddresses.length > 0)
          ? id.ipAddresses.join(',')
          : (id.ipAddress || '127.0.0.1');
        if (!api.openPairingWindow) {
          // A build without the pairing window: a plain address code, verified by comparing codes.
          const url = await createLinkQrDataUrl(addresses, LINK_PORT);
          if (!cancelled) setQrDataUrl(url);
          return;
        }
        const opened = await api.openPairingWindow();
        fingerprint = opened.fingerprint;
        await draw(opened.token);
      } catch (err) {
        console.error('Failed to generate QR Code:', err);
      }
    })();
    const renew = setInterval(() => {
      api.refreshPairingToken?.().then((token) => { if (token && fingerprint) void draw(token); }).catch(() => {});
    }, 30000);
    return () => {
      cancelled = true;
      clearInterval(renew);
      void api.closePairingWindow?.();
    };
  }, [isAddDeviceVisible, localAddresses]);

  const handleDecodedHost = (host: string) => {
    setShowScannerModal(false);
    setIpInput(host);
    if (onConnect) onConnect(host);
  };

  const selectedSinks = activeControlPanelDeviceId ? (volumeSinks.get(activeControlPanelDeviceId) || []) : [];
  // Media state of the selected device only.
  const selectedMprisState = selectedDevice?.mprisState || null;
  const isMediaActive = !!(selectedDevice && selectedMprisState);
  
  // Unpaired devices found by UDP discovery.
  const rawDiscovered = discoveredPeers ? Array.from(discoveredPeers.entries()) : [];
  const nearbyList = rawDiscovered
    // Devices heard while paired are marked trusted (a device with visibility off is only announced to paired
    // ones); those are not strangers to offer for pairing.
    .filter(([id, info]) => info.trusted !== true && (!peers.has(id) || !peers.get(id)?.trusted))
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
              // A TV has no battery, so none is shown for one (other devices' batteries still show on a TV).
              const hasBattery = battery !== undefined && info.deviceType !== 'tv';

              return (
                <div key={deviceId}>
                  {/* One bordered card per device (.peer-row); opens the control panel, which shows
                      its controls disabled while the device is offline */}
                  <div
                    className="peer-row"
                    onClick={() => info.trusted && setActiveControlPanelDeviceId(deviceId)}
                    style={{
                      cursor: info.trusted ? 'pointer' : 'default',
                      opacity: isActive ? 1 : 0.6,
                    }}
                  >
                    <div className="peer-info">
                      <div className={`status-dot ${isActive ? 'status-active' : 'status-inactive'}`}></div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        {(() => {
                          const deviceTypeIcon = (
                            <DeviceIcon deviceType={info.deviceType} size={14} style={{ color: 'var(--text-muted)' }} />
                          );

                          return (
                            <strong style={{ fontSize: '14.5px', lineHeight: 1.2, display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                              <span style={{ display: 'flex', flexShrink: 0 }}>{deviceTypeIcon}</span>
                              <span style={{ overflowWrap: 'anywhere' }}>{info.name}</span>
                            </strong>
                          );
                        })()}
                        <span style={{ color: info.connected && info.link === 'remote' ? 'var(--accent, #3b82f6)' : 'var(--text-muted)', fontSize: '11px', lineHeight: 1.2, whiteSpace: 'nowrap' }}>
                          {info.connected && info.link === 'remote' ? 'Remote (Tailscale) • ' : ''}
                          {info.ipAddress || discoveredPeers?.get(deviceId)?.ipAddress || 'Offline'}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      {hasBattery && <BatteryIndicator level={battery.currentCharge} charging={battery.isCharging} />}
                      {info.trusted && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveSettingsDeviceId(deviceId);
                          }}
                          style={{
                            background: 'rgba(255, 255, 255, 0.04)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            padding: '6px 12px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                            color: 'var(--text-color)',
                            fontSize: '11.5px',
                            transition: 'border-color 0.15s, background 0.15s',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = 'var(--accent-color)';
                            e.currentTarget.style.background = 'rgba(0, 155, 213, 0.08)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = 'var(--border-color)';
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
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
                          <span>Permissions</span>
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
                            border: 'none',
                            color: '#ffffff',
                            fontWeight: 600,
                            background: 'linear-gradient(135deg, #cf3a3a 0%, #b02a2a 100%)',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'linear-gradient(135deg, #db4545 0%, #bc3232 100%)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'linear-gradient(135deg, #cf3a3a 0%, #b02a2a 100%)')}
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
              background: 'linear-gradient(135deg, #cf3a3a 0%, #b02a2a 100%)',
              border: 'none',
              color: '#ffffff',
              borderRadius: '6px',
              cursor: 'pointer',
              marginLeft: '10px',
              transition: 'all 0.15s ease',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '7px'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'linear-gradient(135deg, #db4545 0%, #bc3232 100%)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'linear-gradient(135deg, #cf3a3a 0%, #b02a2a 100%)')}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
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

            {/* Two columns: manual connection and visibility, then this device's QR code */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* Manual connection */}
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

                {/* Discovery visibility */}
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

              {/* QR code */}
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

            {/* Nearby devices */}
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
                          <span style={{ color: 'var(--accent-color)', display: 'flex' }}>
                            <DeviceIcon deviceType={info.deviceType} size={15} />
                          </span>
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 600 }}>{info.name}</div>
                            <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                              {isPhone ? 'Mobile Device' : info.deviceType === 'tv' ? 'TV' : 'Desktop PC'}{info.ipAddress ? ` • ${info.ipAddress}` : ''}
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
          onShowCamera={(id) => {
            setActiveControlPanelDeviceId(null);
            onShowCamera?.(id);
          }}
          onShowSecondScreen={onShowSecondScreen ? (id) => {
            setActiveControlPanelDeviceId(null);
            onShowSecondScreen(id);
          } : undefined}
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
        <Suspense fallback={null}>
          <RemoteKeyboardOverlay
            deviceId={activeRemoteKeyboardDeviceId}
            deviceName={selectedKeyboardDevice.name}
            deviceType={selectedKeyboardDevice.deviceType}
            mediaVolume={(volumeSinks.get(activeRemoteKeyboardDeviceId) || []).find((s) => s.name === 'media')}
            onSetVolume={(sink, vol) => onSetVolume(activeRemoteKeyboardDeviceId, sink, vol)}
            onClose={() => setActiveRemoteKeyboardDeviceId(null)}
          />
        </Suspense>
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
