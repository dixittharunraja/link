import React, { useState } from 'react';

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

          {/* Blocklist Manager Button */}
          {!isMobile && (
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
          )}
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
              const formattedName = key.replace(/([A-Z])/g, ' $1');
              const isGranted = status === 'granted';
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
                  <div>
                    <div style={{ textTransform: 'capitalize', fontSize: '13.5px', fontWeight: 600 }}>{formattedName}</div>
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
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(5, 5, 8, 0.85)',
        backdropFilter: 'blur(16px)',
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
          width: '420px',
          maxHeight: '80vh',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          border: '1px solid var(--border-color)',
          background: 'var(--card-bg, #141416)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '18px', fontWeight: 800 }}>Blocked Connections</div>
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

        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px' }}>
          {entries.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '16px 0', textAlign: 'center' }}>
              No blocked devices or IP addresses.
            </div>
          ) : (
            entries.map((entry) => (
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
                <div>
                  <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{entry.label}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                    {entry.type === 'ip' ? 'IP: ' : 'ID: '}{entry.id}
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
            ))
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
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(5, 5, 8, 0.85)',
        backdropFilter: 'blur(16px)',
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
            <button onClick={handleVerify} style={{ marginTop: '8px', background: 'var(--accent-gradient)', color: '#000', fontWeight: 700 }}>
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
            <button onClick={handleSaveNew} style={{ marginTop: '8px', background: 'var(--accent-gradient)', color: '#000', fontWeight: 700 }}>
              Save PIN
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsTab;
