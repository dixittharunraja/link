import React, { useState } from 'react';
import { PERMISSION_REASONS } from '../utils/permission-reasons';
import { ModalCloseButton } from './DialogCard';
import { DeviceIcon } from './DeviceIcon';
import ToggleRow from './ToggleRow';
import { checkForUpdates, CURRENT_VERSION, UpdateCheckResult } from '../utils/updater';

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
  visibilityEnabled?: boolean;
  onVisibilityToggle?: (enabled: boolean) => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  deviceName,
  deviceId: _deviceId,
  ipAddress,
  onRename,
  theme,
  onThemeToggle,
  logs: _logs,
  isMobile,
  mobilePermissions,
  onRequestMobilePermission,
  screensaverInhibitEnabled,
  onScreensaverInhibitToggle,
  openAtLogin,
  onOpenAtLoginToggle,
  closeToTray,
  onCloseToTrayToggle,
  visibilityEnabled: _visibilityEnabled,
  onVisibilityToggle: _onVisibilityToggle,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameInput, setRenameInput] = useState(deviceName);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const res = await checkForUpdates();
      setUpdateResult(res);
      setShowUpdateModal(true);
    } finally {
      setCheckingUpdate(false);
    }
  };

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
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              style={{ flex: '1 1 180px', minWidth: 0 }}
            />
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              <button onClick={handleRenameSave} style={{ whiteSpace: 'nowrap', padding: '10px 16px' }}>Save</button>
              <button onClick={() => setIsRenaming(false)} style={{ background: 'transparent', whiteSpace: 'nowrap', padding: '10px 16px' }}>
                Cancel
              </button>
            </div>
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
            type="button"
            className={`theme-toggle-btn ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => onThemeToggle('dark')}
          >
            Dark Mode
          </button>
          <button
            type="button"
            className={`theme-toggle-btn ${theme === 'light' ? 'active' : ''}`}
            onClick={() => onThemeToggle('light')}
          >
            Light Mode
          </button>
          <button
            type="button"
            className={`theme-toggle-btn ${theme === 'system' ? 'active' : ''}`}
            onClick={() => onThemeToggle('system')}
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
            <ToggleRow
              title="Open on Startup"
              description="Launch Link automatically when you sign in."
              checked={!!openAtLogin}
              onChange={(c) => onOpenAtLoginToggle?.(c)}
            />
            <ToggleRow
              title="Keep Screen Awake"
              description="Prevent the screensaver/lock while a trusted device is connected."
              checked={!!screensaverInhibitEnabled}
              onChange={(c) => onScreensaverInhibitToggle?.(c)}
            />
            <ToggleRow
              title="Close to Tray"
              description="Closing the window keeps Link running in the system tray instead of quitting, so devices stay connected."
              checked={!!closeToTray}
              onChange={(c) => onCloseToTrayToggle?.(c)}
            />
          </div>
        </div>
      )}

      {/* Security & Privacy Settings */}
      <div className="card">
        <div className="card-title">Security & Privacy</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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

      {/* About & Version Update */}
      <div className="card">
        <div className="card-title">About & Updates</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
            <div>
              <div style={{ fontSize: '13.5px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>Link</span>
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '12px', background: 'rgba(0, 155, 213, 0.15)', color: 'var(--accent-color)', fontWeight: 700 }}>
                  v{CURRENT_VERSION}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                Secure peer-to-peer local network device suite. Zero cloud, zero relay.
              </div>
            </div>
            <button
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              style={{
                padding: '6px 14px',
                fontSize: '12.5px',
                background: 'var(--accent-color)',
                color: 'var(--btn-primary-text)',
                border: 'none',
                borderRadius: '6px',
                cursor: checkingUpdate ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                opacity: checkingUpdate ? 0.7 : 1,
              }}
            >
              {checkingUpdate ? 'Checking…' : 'Check for Updates'}
            </button>
          </div>
        </div>
      </div>

      {/* Update Info Modal */}
      {showUpdateModal && updateResult && (
        <UpdateModal
          result={updateResult}
          isMobile={!!isMobile}
          onClose={() => setShowUpdateModal(false)}
        />
      )}

      {/* Blocklist Modal Popup */}
      {showBlocklistModal && (
        <BlocklistModal onClose={() => setShowBlocklistModal(false)} />
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
                          if (!isGranted && onRequestMobilePermission) {
                            onRequestMobilePermission(key);
                          } else {
                            window.link?.openAppSettings();
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
    if (!window.link?.getBlocklist) return;
    window.link.getBlocklist().then((list: any) => {
      setEntries(list || []);
    }).catch(() => {});
  };

  React.useEffect(() => {
    fetchBlocklist();
  }, []);

  const handleUnblock = (id: string) => {
    if (!window.link?.unblockDevice) return;
    window.link.unblockDevice(id).then((updatedList: any) => {
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
          <ModalCloseButton onClose={onClose} />
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
                        <DeviceIcon deviceType={isPhone ? 'phone' : 'pc'} strokeWidth={2} />
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

interface UpdateModalProps {
  result: UpdateCheckResult;
  isMobile: boolean;
  onClose: () => void;
}

const UpdateModal: React.FC<UpdateModalProps> = ({ result, isMobile, onClose }) => {
  const [downloading, setDownloading] = React.useState(false);
  const [downloadStatus, setDownloadStatus] = React.useState<string | null>(null);

  const release = result.release;
  const targetAsset = release?.assets?.find((a) => {
    if (isMobile) return a.name.endsWith('.apk');
    return a.name.endsWith('.exe') || a.name.endsWith('.deb');
  }) || release?.assets?.[0];

  const handleDownload = () => {
    if (!targetAsset) {
      if (release?.htmlUrl) {
        if (window.link?.openExternal) {
          window.link.openExternal(release.htmlUrl);
        } else {
          window.open(release.htmlUrl, '_blank');
        }
      }
      return;
    }

    setDownloading(true);
    setDownloadStatus('Starting download…');

    try {
      if (window.link?.openExternal) {
        window.link.openExternal(targetAsset.browser_download_url);
      } else {
        window.open(targetAsset.browser_download_url, '_blank');
      }
      setDownloadStatus('Download opened in browser / package installer.');
    } catch (err: any) {
      setDownloadStatus('Failed to start download: ' + err.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="modal">
      <div
        className="modal-content"
        style={{
          width: '440px',
          textAlign: 'left',
          background: 'var(--modal-bg)',
          border: '1px solid var(--border-color)',
          boxShadow: '0 25px 60px var(--modal-shadow)',
          padding: '28px',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
          <div style={{ fontSize: '18px', fontWeight: 800 }}>Software Update</div>
          <ModalCloseButton onClose={onClose} />
        </div>

        {result.error ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ color: '#ef4444', fontSize: '13px' }}>
              {result.error}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Current version: <strong>v{result.currentVersion}</strong>
            </div>
          </div>
        ) : result.hasUpdate ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{
                width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.15)',
                color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
              }}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v14m-5-5l5 5 5-5" />
                  <path d="M2 19h20" />
                </svg>
              </div>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-color)' }}>
                  A new version is available!
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  v{result.currentVersion} → <strong>v{result.latestVersion}</strong>
                </div>
              </div>
            </div>

            {release?.body && (
              <div style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '12px',
                lineHeight: '1.5',
                color: 'var(--text-muted)',
                maxHeight: '140px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap'
              }}>
                {release.body}
              </div>
            )}

            {targetAsset && (
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                Package: <strong>{targetAsset.name}</strong> ({(targetAsset.size / (1024 * 1024)).toFixed(1)} MB)
              </div>
            )}

            {downloadStatus && (
              <div style={{ fontSize: '12px', color: 'var(--accent-color)' }}>{downloadStatus}</div>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
              <button
                onClick={onClose}
                style={{ flex: 1, padding: '10px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, color: 'var(--text-color)' }}
              >
                Later
              </button>
              <button
                onClick={handleDownload}
                disabled={downloading}
                style={{ flex: 1.4, padding: '10px', background: 'var(--accent-color)', color: 'var(--btn-primary-text)', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}
              >
                {downloading ? 'Downloading…' : isMobile ? 'Download APK' : 'Download Update'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'center', padding: '16px 0', textAlign: 'center' }}>
            <div style={{
              width: '44px', height: '44px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.15)',
              color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-color)' }}>
                You're up to date!
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Link v{result.currentVersion} is currently the latest version.
              </div>
            </div>
            <button
              onClick={onClose}
              style={{ marginTop: '8px', padding: '8px 20px', background: 'var(--accent-color)', color: 'var(--btn-primary-text)', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
            >
              OK
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsTab;

