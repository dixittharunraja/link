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
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameInput, setRenameInput] = useState(deviceName);

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

export default SettingsTab;
