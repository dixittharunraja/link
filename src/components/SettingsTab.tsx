import React, { useState } from 'react';
import { PERMISSION_REASONS } from '../utils/permission-reasons';
import { ModalCloseButton } from './DialogCard';
import { startVisibleInterval } from '../hooks/useVisibleInterval';
import { DeviceIcon } from './DeviceIcon';
import ToggleRow from './ToggleRow';
import { checkForUpdates, CURRENT_VERSION, UpdateCheckResult } from '../utils/updater';
import { cameraManager, useCameraManager } from '../utils/cameraManager';
import { CustomSelect } from './CustomSelect';
import { DEVICE_NAME_MAX } from '../utils/deviceName';
import { IS_TV } from '../utils/platform';

// A TV runs on mains power, so it has no battery optimization to exempt Link from, and it stays where
// it is installed, so nobody locates it.
const TV_HIDDEN_PERMISSIONS = new Set(['batteryOpt', 'location']);

interface SettingsTabProps {
  deviceName: string;
  deviceId: string;
  ipAddress?: string;
  onRename: (newName: string) => Promise<void>;
  theme: string;
  onThemeToggle: (theme: string) => void;
  isMobile?: boolean;
  mobilePermissions?: Record<string, string>;
  onRequestMobilePermission?: (type: string) => void;
  screensaverInhibitEnabled?: boolean;
  onScreensaverInhibitToggle?: (enabled: boolean) => void;
  openAtLogin?: boolean;
  onOpenAtLoginToggle?: (enabled: boolean) => void;
  visibilityEnabled?: boolean;
  onVisibilityToggle?: (enabled: boolean) => void;
}

// One setting: what it is and a short line about it on the left, its control on the right. Every row on
// this page uses it so spacing, type sizes and alignment stay the same from card to card. A control
// too wide to sit beside the text (`below`) goes underneath at full width instead.
const SettingRow: React.FC<{ title: React.ReactNode; description?: React.ReactNode; below?: boolean; children?: React.ReactNode }> = ({
  title,
  description,
  below,
  children,
}) => (
  <div style={{ display: 'flex', flexDirection: below ? 'column' : 'row', alignItems: below ? 'stretch' : 'center', justifyContent: 'space-between', gap: below ? '10px' : '14px' }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere' }}>{title}</div>
      {description && <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>{description}</div>}
    </div>
    {children && <div style={{ flexShrink: 0 }}>{children}</div>}
  </div>
);

const ROW_STACK: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px' };

// The small secondary button used for the actions inside rows.
const ROW_BUTTON: React.CSSProperties = {
  padding: '7px 14px',
  fontSize: '12.5px',
  background: 'rgba(255, 255, 255, 0.05)',
  border: '1px solid var(--border-color)',
  borderRadius: '8px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/** A row of mutually exclusive options drawn as one control. */
const Segmented: React.FC<{ value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void; fill?: boolean }> = ({ value, options, onChange, fill }) => (
  <div role="radiogroup" style={{ display: 'flex', padding: '3px', gap: '3px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--input-bg)', width: fill ? '100%' : undefined, boxSizing: 'border-box' }}>
    {options.map(([key, label]) => {
      const active = key === value;
      return (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={active}
          className="theme-toggle-btn"
          onClick={() => onChange(key)}
          style={{
            flex: fill ? 1 : 'none', padding: '7px 14px', fontSize: '12.5px', fontWeight: 600, borderRadius: '7px', border: 'none',
            background: active ? 'var(--accent-color, #009bd5)' : 'transparent',
            color: active ? 'var(--btn-primary-text, #000)' : 'var(--text-muted)',
          }}
        >
          {label}
        </button>
      );
    })}
  </div>
);

// Names for the Android permission keys that do not read well split from camelCase.
const PERMISSION_NAMES: Record<string, string> = {
  dnd: 'Do Not Disturb Access',
  batteryOpt: 'Battery Optimization',
  notificationAccess: 'Notification Listener Access',
  overlay: 'Display Over Other Apps',
};

/** One Android permission: its name, what it is for, a switch, and the full reason on request. */
const PermissionRow: React.FC<{ permKey: string; granted: boolean; onRequest?: (key: string) => void }> = ({ permKey, granted, onRequest }) => {
  const [expanded, setExpanded] = useState(false);
  const name = PERMISSION_NAMES[permKey] ?? permKey.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  const reason = PERMISSION_REASONS[permKey];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{name}</div>
          {reason && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              style={{ padding: 0, marginTop: '2px', background: 'none', border: 'none', fontSize: '11.5px', color: 'var(--text-muted)', textAlign: 'left', cursor: 'pointer' }}
            >
              {reason.title} · <span style={{ color: 'var(--accent-color)' }}>{expanded ? 'Less' : 'Why?'}</span>
            </button>
          )}
        </div>
        <label className="switch-container" style={{ margin: 0 }}>
          <span className="switch">
            <input
              type="checkbox"
              checked={granted}
              aria-label={name}
              onChange={() => {
                // Android cannot revoke a permission for an app; turning one off goes to its settings page.
                if (!granted && onRequest) onRequest(permKey);
                else window.link?.openAppSettings();
              }}
            />
            <span className="slider"></span>
          </span>
        </label>
      </div>
      {expanded && reason && (
        <div style={{ marginTop: '8px', padding: '10px 12px', borderRadius: '8px', background: 'var(--input-bg)', fontSize: '12px', lineHeight: 1.5, color: 'var(--text-muted)' }}>
          {reason.reason}
        </div>
      )}
    </div>
  );
};

const SettingsTab: React.FC<SettingsTabProps> = ({
  deviceName,
  deviceId: _deviceId,
  ipAddress: _ipAddress,
  onRename,
  theme,
  onThemeToggle,
  isMobile,
  mobilePermissions,
  onRequestMobilePermission,
  screensaverInhibitEnabled,
  onScreensaverInhibitToggle,
  openAtLogin,
  onOpenAtLoginToggle,
  visibilityEnabled: _visibilityEnabled,
  onVisibilityToggle: _onVisibilityToggle,
}) => {
  const camera = useCameraManager();
  // "Use Tailscale when away": off by default, because away from the LAN every byte goes over the internet.
  const [remoteOn, setRemoteOn] = useState(false);
  const [tailscale, setTailscale] = useState<{ running: boolean; ip: string | null } | null>(null);
  React.useEffect(() => {
    window.link?.getRemoteTailscaleEnabled?.().then(setRemoteOn).catch(() => {});
    const refresh = () => window.link?.getTailscaleStatus?.().then(setTailscale).catch(() => {});
    refresh();
    const stopPolling = startVisibleInterval(refresh, 5000);
    return stopPolling;
  }, []);
  const toggleRemote = (on: boolean) => {
    setRemoteOn(on);
    window.link?.setRemoteTailscaleEnabled?.(on).catch(() => setRemoteOn(!on));
  };
  // The H.264 video component (Cisco's OpenH264): screen sharing on a PC without a hardware encoder, and the phone webcam.
  const [h264, setH264] = useState<{ supported: boolean; installed: boolean } | null>(null);
  const [h264Busy, setH264Busy] = useState(false);
  const [h264Error, setH264Error] = useState<string | null>(null);
  React.useEffect(() => {
    if (isMobile) return;
    window.link?.h264Status?.().then(setH264).catch(() => {});
  }, [isMobile]);
  const downloadH264 = async () => {
    setH264Busy(true);
    setH264Error(null);
    try {
      await window.link?.h264Install?.();
      setH264(await (window.link?.h264Status?.() ?? Promise.resolve(null)));
    } catch (err: any) {
      setH264Error(typeof err === 'string' ? err : err?.message || 'The download failed.');
    } finally {
      setH264Busy(false);
    }
  };
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
      {/* General: who this device is, and how Link looks */}
      <div className="card">
        <div className="card-title">General</div>
        <div style={ROW_STACK}>
          {isRenaming ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
              <input
                type="text"
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                maxLength={DEVICE_NAME_MAX}
                style={{ flex: '1 1 180px', minWidth: 0 }}
              />
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <button onClick={handleRenameSave} style={{ whiteSpace: 'nowrap', padding: '8px 16px' }}>Save</button>
                <button onClick={() => setIsRenaming(false)} style={{ background: 'transparent', whiteSpace: 'nowrap', padding: '8px 16px' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <SettingRow title={deviceName} description="Device name, shown to the devices you pair with">
              <button onClick={() => { setRenameInput(deviceName); setIsRenaming(true); }} style={ROW_BUTTON}>
                Rename
              </button>
            </SettingRow>
          )}
          <SettingRow title="Theme" description="Dark, light, or follow your system" below={isMobile}>
            <Segmented
              value={theme}
              options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']] as const}
              onChange={onThemeToggle}
              fill={isMobile}
            />
          </SettingRow>
        </div>
      </div>

      {/* Startup and power (desktop only) */}
      {!isMobile && (
        <div className="card">
          <div className="card-title">Startup & Power</div>
          <div style={ROW_STACK}>
            <ToggleRow
              title="Open on Startup"
              description="Start Link in the tray when you sign in. Closing the window also keeps it in the tray; quit from the tray menu."
              checked={!!openAtLogin}
              onChange={(c) => onOpenAtLoginToggle?.(c)}
            />
            <ToggleRow
              title="Keep Screen Awake"
              description="Stop the screensaver and lock screen while a trusted device is connected."
              checked={!!screensaverInhibitEnabled}
              onChange={(c) => onScreensaverInhibitToggle?.(c)}
            />
          </div>
        </div>
      )}

      {/* Away from home: reach paired devices through Tailscale when they are not on the LAN */}
      {window.link?.getTailscaleStatus && (
        <div className="card">
          <div className="card-title">Away from Home</div>
          <div style={ROW_STACK}>
            <ToggleRow
              title="Use Tailscale when away"
              description="On the same network, devices connect directly and nothing leaves it. Away from it, Link reconnects through Tailscale and switches back on its own when you return. Away from the network this uses internet data, and screen sharing, camera and file transfers can use a lot of it."
              checked={remoteOn}
              onChange={toggleRemote}
            />
            {remoteOn && (
              <SettingRow
                title="Tailscale"
                description={
                  tailscale?.running
                    ? `Running on this ${isMobile ? 'phone' : 'PC'} (${tailscale.ip}). Your other devices also need Tailscale running, and must have connected to this one once while it was on.`
                    : `Not running on this ${isMobile ? 'phone' : 'PC'}. Install Tailscale from tailscale.com and sign in, on this device and on your other devices.`
                }
              >
                <span style={{ fontWeight: 600 }}>{tailscale?.running ? 'Ready' : 'Not running'}</span>
              </SettingRow>
            )}
          </div>
        </div>
      )}

      {/* Virtual webcam (desktop only): a connected phone's camera shows up in other programs on demand */}
      {!isMobile && camera.supported && (
        <div className="card">
          <div className="card-title">Virtual Webcam</div>
          <div style={ROW_STACK}>
            <ToggleRow
              title="Phone as virtual webcam"
              description={`Shows a connected phone as the camera “${camera.cameraName}” in Zoom, Chrome and other apps. The phone's camera only turns on while an app is using it.`}
              checked={camera.virtualEnabled}
              onChange={(on) => void cameraManager.setVirtualEnabled(on)}
            />
            {camera.virtualEnabled && (
              <SettingRow
                title="Phone to use"
                description={
                  camera.phones.length === 0
                    ? 'No connected phone has "Allow Camera as Webcam" turned on for this PC.'
                    : `Using ${camera.phones.find((p) => p.id === camera.activePhone)?.name ?? '—'}. Only one phone can be the camera at a time.`
                }
              >
                <CustomSelect
                  value={camera.preferredPhone}
                  onChange={(id) => cameraManager.setPreferredPhone(id)}
                  disabled={camera.phones.length === 0}
                  placeholder="Automatic"
                  options={[
                    { value: '', label: 'Automatic (last one used)' },
                    ...camera.phones.map((p) => ({ value: p.id, label: p.name })),
                    // A pinned phone that is not connected is still shown, so the choice is not silently lost.
                    ...(camera.preferredPhone && !camera.phones.some((p) => p.id === camera.preferredPhone)
                      ? [{ value: camera.preferredPhone, label: 'Pinned phone (not connected)' }]
                      : []),
                  ]}
                  style={{ minWidth: '210px' }}
                />
              </SettingRow>
            )}
            {camera.virtualError && <div style={{ fontSize: '12px', color: '#ef4444' }}>{camera.virtualError}</div>}
          </div>
        </div>
      )}

      {/* Android permissions */}
      {isMobile && (
        <div className="card">
          <div className="card-title">Permissions</div>
          <div style={ROW_STACK}>
            {Object.entries(mobilePermissions || {}).filter(([key]) => !(IS_TV && TV_HIDDEN_PERMISSIONS.has(key))).map(([key, status]) => (
              <PermissionRow key={key} permKey={key} granted={status === 'granted'} onRequest={onRequestMobilePermission} />
            ))}
          </div>
        </div>
      )}

      {/* Privacy */}
      <div className="card">
        <div className="card-title">Privacy</div>
        <div style={ROW_STACK}>
          <SettingRow title="Blocklist" description="Devices and addresses you blocked; unblock them here.">
            <button onClick={() => setShowBlocklistModal(true)} style={ROW_BUTTON}>
              Manage
            </button>
          </SettingRow>
        </div>
      </div>

      {/* About */}
      <div className="card">
        <div className="card-title">About</div>
        <div style={ROW_STACK}>
          <SettingRow
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <span>Link</span>
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '12px', background: 'rgba(0, 155, 213, 0.15)', color: 'var(--accent-color)', fontWeight: 700 }}>
                  v{CURRENT_VERSION}
                </span>
              </span>
            }
            description="Secure peer-to-peer device suite on your own network. No cloud, no relay."
          >
            <button
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              title="Check for updates"
              aria-label="Check for updates"
              style={{
                ...ROW_BUTTON,
                display: 'inline-flex', alignItems: 'center', gap: '7px',
                padding: isMobile ? '0' : ROW_BUTTON.padding,
                width: isMobile ? '36px' : undefined, height: '34px', justifyContent: 'center',
                cursor: checkingUpdate ? 'default' : 'pointer',
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={checkingUpdate ? { animation: 'spin 1s linear infinite' } : undefined}>
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {!isMobile && (checkingUpdate ? 'Checking…' : 'Check for updates')}
            </button>
          </SettingRow>
          {!isMobile && h264?.supported && (
            <SettingRow
              title="H.264 video component"
              description="Needed to use a phone as this PC's webcam, and to share this screen on a PC without a hardware video encoder. A small one-time download from Cisco (openh264.org), checked before use. Link does not use the internet for anything else."
            >
              {h264.installed ? (
                <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#10b981' }}>Installed</span>
              ) : (
                <button onClick={downloadH264} disabled={h264Busy} style={{ ...ROW_BUTTON, opacity: h264Busy ? 0.7 : 1 }}>
                  {h264Busy ? 'Downloading…' : 'Download'}
                </button>
              )}
            </SettingRow>
          )}
          {h264Error && <div style={{ fontSize: '12px', color: '#ef4444' }}>{h264Error}</div>}
        </div>
      </div>

      {showUpdateModal && updateResult && (
        <UpdateModal
          result={updateResult}
          isMobile={!!isMobile}
          onClose={() => setShowUpdateModal(false)}
        />
      )}

      {showBlocklistModal && (
        <BlocklistModal onClose={() => setShowBlocklistModal(false)} />
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
              // deviceType is known only if it was available at block time (e.g. a rejected pair
              // request); IP-only guest blocks have none and show a generic "Blocked IP" label.
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
  // A release carries link.apk (phones, 64-bit ARM) and link-tv.apk (TVs, which often run 32-bit Android).
  // An older release with a single APK still matches through the second lookup. When nothing fits, there is no
  // asset and the button opens the release page, never some other platform's file.
  const assets = release?.assets ?? [];
  const targetAsset = isMobile
    ? assets.find((a) => a.name === (IS_TV ? 'link-tv.apk' : 'link.apk')) ?? assets.find((a) => a.name.endsWith('.apk'))
    : assets.find((a) => a.name.endsWith('.exe') || a.name.endsWith('.deb'));

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

