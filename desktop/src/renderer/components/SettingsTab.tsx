import React, { useState } from 'react';
import { PERMISSION_REASONS } from '../utils/permission-reasons';

interface SettingsTabProps {
  deviceName: string;
  deviceId: string;
  ipAddress?: string;
  onRename: (newName: string) => Promise<void>;
  theme: string;
  onThemeToggle: (theme: string) => void;
  logs: string[];
  isMobile?: boolean;
  mobilePermissions?: Record<string, string>;
  onRequestMobilePermission?: (type: string) => void;
  screensaverInhibitEnabled?: boolean;
  onScreensaverInhibitToggle?: (enabled: boolean) => void;
  openAtLogin?: boolean;
  onOpenAtLoginToggle?: (enabled: boolean) => void;
  closeToTray?: boolean;
  onCloseToTrayToggle?: (enabled: boolean) => void;
  pinLockEnabled?: boolean;
  onPinLockToggle?: (enabled: boolean) => void;
  pinCode?: string;
  onPinCodeChange?: (pin: string) => void;
  biometricEnabled?: boolean;
  onBiometricToggle?: (enabled: boolean) => void;
  biometricAvailable?: boolean;
  visibilityEnabled?: boolean;
  onVisibilityToggle?: (enabled: boolean) => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  deviceName,
  deviceId,
  ipAddress,
  onRename,
  theme,
  onThemeToggle,
  logs,
  isMobile,
  mobilePermissions,
  onRequestMobilePermission,
  screensaverInhibitEnabled,
  onScreensaverInhibitToggle,
  openAtLogin,
  onOpenAtLoginToggle,
  closeToTray,
  onCloseToTrayToggle,
  pinLockEnabled,
  onPinLockToggle,
  pinCode = '1234',
  onPinCodeChange,
  biometricEnabled,
  onBiometricToggle,
  biometricAvailable,
  visibilityEnabled,
  onVisibilityToggle,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameInput, setRenameInput] = useState(deviceName);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const [showPinModal, setShowPinModal] = useState<{ mode: 'enable' | 'disable' | 'change' } | null>(null);

  const handleRenameSave = () => {
    const trimmed = renameInput.trim();
    if (!trimmed) return;
    onRename(trimmed).then(() => {
      setIsRenaming(false);
    });
  };

  return (
    <div id="tab-settings" className="tab-content active">
      {/* Device Identity */}
      <div className="card">
        <div className="card-title">Device Identity</div>
        {isRenaming ? (
          <div className="flex-row">
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              style={{ width: '180px' }}
            />
            <button onClick={handleRenameSave}>Save</button>
            <button onClick={() => setIsRenaming(false)} style={{ background: 'transparent' }}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13.5px' }}>
              <div>Device Name: <strong style={{ color: 'var(--text-color)' }}>{deviceName}</strong></div>
              {ipAddress && <div>IP Address: <strong style={{ color: 'var(--accent-color)' }}>{ipAddress}</strong></div>}
            </div>
            <button onClick={() => { setRenameInput(deviceName); setIsRenaming(true); }} style={{ padding: '6px 12px' }}>
              Rename
            </button>
          </div>
        )}
      </div>

      {/* Appearance Settings */}
      <div className="card">
        <div className="card-title">Appearance</div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            onClick={() => onThemeToggle('dark')}
            style={{
              flex: 1,
              padding: '10px',
              fontWeight: 600,
              fontSize: '13px',
              borderRadius: '8px',
              border: '1px solid ' + (theme === 'dark' ? 'var(--accent-color)' : 'var(--border-color)'),
              background: theme === 'dark' ? 'var(--accent-glow)' : 'rgba(255,255,255,0.02)',
              color: theme === 'dark' ? 'var(--text-color)' : 'var(--text-muted)',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            Dark Mode
          </button>
          <button
            onClick={() => onThemeToggle('light')}
            style={{
              flex: 1,
              padding: '10px',
              fontWeight: 600,
              fontSize: '13px',
              borderRadius: '8px',
              border: '1px solid ' + (theme === 'light' ? 'var(--accent-color)' : 'var(--border-color)'),
              background: theme === 'light' ? 'var(--accent-glow)' : 'rgba(255,255,255,0.02)',
              color: theme === 'light' ? 'var(--text-color)' : 'var(--text-muted)',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            Light Mode
          </button>
          <button
            onClick={() => onThemeToggle('system')}
            style={{
              flex: 1,
              padding: '10px',
              fontWeight: 600,
              fontSize: '13px',
              borderRadius: '8px',
              border: '1px solid ' + (theme === 'system' ? 'var(--accent-color)' : 'var(--border-color)'),
              background: theme === 'system' ? 'var(--accent-glow)' : 'rgba(255,255,255,0.02)',
              color: theme === 'system' ? 'var(--text-color)' : 'var(--text-muted)',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            System
          </button>
        </div>
      </div>

      {/* Startup & Power (desktop-only — no OS login-item or screensaver equivalent on mobile) */}
      {!isMobile && (
        <div className="card">
          <div className="card-title">Startup & Power</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>Open on Startup</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Launch Link automatically when you sign in.</div>
              </div>
              <label className="switch-container" style={{ margin: 0 }}>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={!!openAtLogin}
                    onChange={(e) => onOpenAtLoginToggle?.(e.target.checked)}
                  />
                  <span className="slider"></span>
                </span>
              </label>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>Keep Screen Awake</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Prevent the screensaver/lock while a trusted device is connected.</div>
              </div>
              <label className="switch-container" style={{ margin: 0 }}>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={!!screensaverInhibitEnabled}
                    onChange={(e) => onScreensaverInhibitToggle?.(e.target.checked)}
                  />
                  <span className="slider"></span>
                </span>
              </label>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>Close to Tray</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Closing the window keeps Link running in the system tray instead of quitting, so devices stay connected.</div>
              </div>
              <label className="switch-container" style={{ margin: 0 }}>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={!!closeToTray}
                    onChange={(e) => onCloseToTrayToggle?.(e.target.checked)}
                  />
                  <span className="slider"></span>
                </span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Security & Privacy Settings */}
      <div className="card">
        <div className="card-title">Security & Privacy</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* PIN Lock Switch & Change PIN Inline */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '13.5px', fontWeight: 600 }}>Enable PIN Lock</span>
                {pinLockEnabled && (
                  <button
                    onClick={() => setShowPinModal({ mode: 'change' })}
                    style={{
                      padding: '3px 8px',
                      fontSize: '11px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Change PIN
                  </button>
                )}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Require a 4-digit PIN to access this application.</div>
            </div>
            <label className="switch-container" style={{ margin: 0 }}>
              <span className="switch">
                <input
                  type="checkbox"
                  checked={!!pinLockEnabled}
                  onChange={() => {}}
                  onClick={() => {
                    const currentVal = !!pinLockEnabled;
                    if (currentVal) {
                      setShowPinModal({ mode: 'disable' });
                    } else {
                      setShowPinModal({ mode: 'enable' });
                    }
                  }}
                />
                <span className="slider"></span>
              </span>
            </label>
          </div>

          {/* Biometric Toggle (Mobile Only) */}
          {isMobile && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>Biometric Unlock</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {biometricAvailable === false
                    ? 'No fingerprint/face enrolled on this device.'
                    : 'Use Fingerprint/Face ID to unlock the application.'}
                </div>
              </div>
              <label className="switch-container" style={{ margin: 0 }}>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={!!biometricEnabled}
                    disabled={biometricAvailable === false}
                    onChange={(e) => onBiometricToggle?.(e.target.checked)}
                  />
                  <span className="slider"></span>
                </span>
              </label>
            </div>
          )}

          {/* Blocklist Manager Button — now backed on both platforms, see LinkBlocklist.java */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
            <div>
              <div style={{ fontSize: '13.5px', fontWeight: 600 }}>Manage Blocklist</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>View and unblock restricted devices or IP addresses.</div>
            </div>
            <button
              onClick={() => setShowBlocklistModal(true)}
              style={{
                padding: '6px 14px',
                fontSize: '12.5px',
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              Open Blocklist
            </button>
          </div>
        </div>
      </div>

      {/* Blocklist Modal Popup */}
      {showBlocklistModal && (
        <BlocklistModal onClose={() => setShowBlocklistModal(false)} />
      )}

      {/* PIN Setting / Changing Modal Popup */}
      {showPinModal && (
        <PinSetupModal
          mode={showPinModal.mode}
          pinCode={pinCode}
          onClose={() => setShowPinModal(null)}
          onPinLockToggle={onPinLockToggle}
          onPinCodeChange={onPinCodeChange}
        />
      )}

      {/* Mobile Permissions Panel */}
      {isMobile && (
        <div className="card">
          <div className="card-title">Permissions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {Object.entries(mobilePermissions || {}).map(([key, status]) => {
              let formattedName = key.replace(/([A-Z])/g, ' $1');
              if (key === 'dnd') {
                formattedName = 'Do Not Disturb Access';
              }
              if (key === 'batteryOpt') {
                formattedName = 'Battery Optimization';
              }
              if (key === 'notificationAccess') {
                formattedName = 'Notification Listener Access';
              }
              if (key === 'overlay') {
                formattedName = 'Display Over Other Apps';
              }
              const isGranted = status === 'granted';
              const reason = PERMISSION_REASONS[key];
              const [showTooltip, setShowTooltip] = useState(false);

              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                    <div style={{ textTransform: 'capitalize', fontSize: '13.5px', fontWeight: 600 }}>{formattedName}</div>
                    {reason && (
                      <button
                        onClick={() => setShowTooltip(!showTooltip)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '0',
                          fontSize: '14px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '18px',
                          height: '18px',
                          borderRadius: '50%',
                          color: 'var(--text-muted)',
                          transition: 'color 0.2s',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-color)')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                        title={reason.title}
                      >
                        ⓘ
                      </button>
                    )}
                    {showTooltip && reason && (
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: '100%',
                          marginTop: '8px',
                          background: 'var(--modal-bg, #1a1a1e)',
                          backdropFilter: 'blur(12px)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '8px',
                          padding: '10px 12px',
                          maxWidth: '280px',
                          fontSize: '12px',
                          lineHeight: '1.5',
                          color: 'var(--text-color)',
                          zIndex: 1000,
                          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
                        }}
                      >
                        <strong style={{ display: 'block', marginBottom: '4px' }}>{reason.title}</strong>
                        {reason.reason}
                      </div>
                    )}
                  </div>
                  <label className="switch-container" style={{ margin: 0 }}>
                    <span className="switch">
                      <input
                        type="checkbox"
                        checked={isGranted}
                        onChange={() => {
                          // Device Admin toggles BOTH ways in-app: requestDeviceAdmin() grants
                          // when off and deactivates (removeActiveAdmin) when on. Routing it here
                          // regardless of state is what lets a user actually turn it off — the
                          // required step before Android will allow uninstalling Link. Every other
                          // permission is revoked through the OS's own app-settings page instead.
                          if (key === 'deviceAdmin') {
                            onRequestMobilePermission?.(key);
                          } else if (!isGranted && onRequestMobilePermission) {
                            onRequestMobilePermission(key);
                          } else {
                            (window as any).link.openAppSettings();
                          }
                        }}
                      />
                      <span className="slider"></span>
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

interface BlocklistModalProps {
  onClose: () => void;
}

const BlocklistModal: React.FC<BlocklistModalProps> = ({ onClose }) => {
  const [entries, setEntries] = React.useState<any[]>([]);

  const fetchBlocklist = () => {
    if (!(window as any).link?.getBlocklist) return;
    (window as any).link.getBlocklist().then((list: any) => {
      setEntries(list || []);
    }).catch(() => {});
  };

  React.useEffect(() => {
    fetchBlocklist();
  }, []);

  const handleUnblock = (id: string) => {
    if (!(window as any).link?.unblockDevice) return;
    (window as any).link.unblockDevice(id).then((updatedList: any) => {
      setEntries(updatedList || []);
    }).catch(() => {});
  };

  return (
    <div className="modal">
      <div
        className="modal-content"
        style={{
          width: '420px',
          textAlign: 'left',
          background: 'var(--modal-bg)',
          border: '1px solid var(--border-color)',
          boxShadow: '0 25px 60px var(--modal-shadow)',
          padding: '28px',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          overflow: 'hidden'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
          <div style={{ fontSize: '18px', fontWeight: 800 }}>Blocked Connections</div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '30px',
              height: '30px',
              minWidth: '30px',
              borderRadius: '50%',
              padding: 0,
              fontSize: '16px',
              background: 'rgba(255, 255, 255, 0.08)',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              transition: 'background 0.15s ease, color 0.15s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.16)';
              e.currentTarget.style.color = 'var(--text-color)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
              e.currentTarget.style.color = 'var(--text-muted)';
            }}
          >
            &times;
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px' }}>
          {entries.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '16px 0', textAlign: 'center' }}>
              No blocked devices or IP addresses.
            </div>
          ) : (
            entries.map((entry) => {
              // Same phone/desktop icon + type label pattern "Nearby Discovered Devices" uses —
              // deviceType is only known when it happened to be available at block time (e.g.
              // rejecting an incoming pair request, whose identity carries it); an IP-only guest
              // block (Audio Relay/Remote Mic/Portal Mode) never has one, so falls back to a
              // generic "Blocked IP" label with no phone/desktop distinction to draw.
              const isPhone = entry.deviceType === 'phone';
              const isKnownDevice = entry.type === 'device' && !!entry.deviceType;
              return (
                <div
                  key={entry.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {isKnownDevice ? (
                        isPhone ? (
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
                        )
                      ) : (
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                        </svg>
                      )}
                    </span>
                    <div>
                      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{entry.label}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {isKnownDevice ? (isPhone ? 'Mobile Device' : 'Desktop PC') : 'Blocked IP'}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleUnblock(entry.id)}
                    style={{
                      padding: '4px 10px',
                      fontSize: '11.5px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    Unblock
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

interface PinSetupModalProps {
  mode: 'enable' | 'disable' | 'change';
  pinCode: string;
  onClose: () => void;
  onPinLockToggle?: (enabled: boolean) => void;
  onPinCodeChange?: (pin: string) => void;
}

const PinSetupModal: React.FC<PinSetupModalProps> = ({ mode, pinCode, onClose, onPinLockToggle, onPinCodeChange }) => {
  const [pinVal, setPinVal] = useState('');
  const [newPinVal, setNewPinVal] = useState('');
  const [step, setStep] = useState(mode === 'change' || mode === 'disable' ? 'verify' : 'new');
  const [errorMsg, setErrorMsg] = useState('');

  const titleMap: Record<string, string> = {
    enable: 'Enable PIN Lock',
    disable: 'Disable PIN Lock',
    change: 'Change PIN Code'
  };

  const handleVerify = () => {
    if (pinVal === pinCode) {
      setErrorMsg('');
      if (mode === 'disable') {
        onPinLockToggle?.(false);
        onClose();
      } else {
        // change mode
        setPinVal('');
        setStep('new');
      }
    } else {
      setErrorMsg('Incorrect PIN code.');
    }
  };

  const handleSaveNew = () => {
    if (/^[0-9]{4}$/.test(newPinVal)) {
      onPinCodeChange?.(newPinVal);
      if (mode === 'enable') {
        onPinLockToggle?.(true);
      }
      onClose();
    } else {
      setErrorMsg('PIN must be exactly 4 digits.');
    }
  };

  return (
    <div
      className="popup-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        // Full-viewport overlay: no backdrop-filter, and the shared .popup-overlay class also
        // clamps the panel inside it to the viewport so a fixed pixel width cannot overflow.
        background: 'rgba(5, 5, 8, 0.92)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10000,
        animation: 'fadeIn 0.2s ease-out'
      }}
    >
      <div
        className="card"
        style={{
          width: '340px',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          border: '1px solid var(--border-color)',
          background: 'var(--card-bg, #141416)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '16px', fontWeight: 800 }}>{titleMap[mode]}</div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '18px',
              cursor: 'pointer',
              padding: '4px'
            }}
          >
            ✕
          </button>
        </div>

        {step === 'verify' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Enter your current 4-digit PIN:</div>
            <input
              type="password"
              pattern="[0-9]*"
              maxLength={4}
              value={pinVal}
              onChange={(e) => setPinVal(e.target.value.replace(/[^0-9]/g, ''))}
              style={{ textAlign: 'center', fontSize: '20px', letterSpacing: '4px', fontFamily: 'monospace' }}
            />
            {errorMsg && <div style={{ color: '#ef4444', fontSize: '12px', textAlign: 'center' }}>{errorMsg}</div>}
            <button onClick={handleVerify} style={{ marginTop: '8px', background: 'var(--accent-gradient)', color: 'var(--btn-primary-text)', fontWeight: 700 }}>
              Verify
            </button>
          </div>
        )}

        {step === 'new' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Choose a new 4-digit PIN:</div>
            <input
              type="password"
              pattern="[0-9]*"
              maxLength={4}
              value={newPinVal}
              onChange={(e) => setNewPinVal(e.target.value.replace(/[^0-9]/g, ''))}
              style={{ textAlign: 'center', fontSize: '20px', letterSpacing: '4px', fontFamily: 'monospace' }}
            />
            {errorMsg && <div style={{ color: '#ef4444', fontSize: '12px', textAlign: 'center' }}>{errorMsg}</div>}
            <button onClick={handleSaveNew} style={{ marginTop: '8px', background: 'var(--accent-gradient)', color: 'var(--btn-primary-text)', fontWeight: 700 }}>
              Save PIN
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsTab;
