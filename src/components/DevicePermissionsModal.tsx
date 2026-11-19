import React from 'react';
import ToggleRow from './ToggleRow';
import { useEscapeAndBack } from '../hooks/useEscapeAndBack';
import { ModalCloseButton } from './DialogCard';

interface DevicePermissionsModalProps {
  deviceName: string;
  localDeviceType?: string;
  getPermission: (permKey: string) => boolean;
  setPermission: (permKey: string, allowed: boolean) => void;
  onClose: () => void;
}

// Per-device permissions dialog, opened from ConnectionsTab.tsx.
const DevicePermissionsModal: React.FC<DevicePermissionsModalProps> = ({
  deviceName,
  localDeviceType,
  getPermission,
  setPermission,
  onClose,
}) => {
  useEscapeAndBack(onClose);
  // The toggles control what the peer may do to, or receive from, this device, so they follow
  // the local device type rather than the peer's: input and commands run on a desktop, while
  // calls, notifications and the camera belong to a phone.
  const isLocalDesktop = localDeviceType !== 'phone';
  const isLocalMobile = localDeviceType === 'phone';

  // Android's own location grant, needed for "Allow Location" to work at all.
  const [locationAccess, setLocationAccess] = React.useState<{ granted: boolean; precise: boolean } | null>(null);
  const linkApi = (window as any).link;
  const readLocationAccess = React.useCallback(async () => {
    try {
      if (linkApi?.getLocationAccess) setLocationAccess(await linkApi.getLocationAccess());
    } catch {
      // Unknown: no hint is shown.
    }
  }, [linkApi]);
  React.useEffect(() => {
    if (isLocalMobile) readLocationAccess();
  }, [isLocalMobile, readLocationAccess]);

  const onLocationToggle = async (allowed: boolean) => {
    setPermission('location', allowed);
    if (!allowed || !linkApi?.requestMobilePermission) return;
    try {
      await linkApi.requestMobilePermission('location');
      // Once granted, the background service declares the location type so fixes work with Link closed.
      await linkApi.refreshLocationAccess?.();
    } catch {
      // Refused: the hint below offers to ask again.
    }
    readLocationAccess();
  };

  return (
    <div className="modal">
      <div
        className="modal-content"
        style={{
          width: '90%',
          maxWidth: '440px',
          background: 'var(--modal-bg)',
          border: '1px solid var(--border-color)',
          boxShadow: '0 25px 60px var(--modal-shadow)',
          padding: '28px',
          maxHeight: '90vh',
          overflowY: 'auto',
          textAlign: 'left'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700 }}>
            {deviceName} Permissions
          </div>
          <ModalCloseButton onClose={onClose} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Clipboard only controls sending this device's clipboard; receiving is decided by the
              peer's own setting. */}
          <ToggleRow
            title="Clipboard Sync"
            description="Send this device your clipboard content."
            checked={getPermission('clipboard')}
            onChange={(v) => setPermission('clipboard', v)}
          />

          {/* Low-risk features (lock, volume, media, presenter, touchpad, flashlight, DND) are
              always allowed for a paired device (UNGATED_KEYS in core/permissions.rs and
              LinkDevicePermissions.java), so they have no toggle. */}
          <ToggleRow
            title="Allow File Access"
            description="Allow mounting device folder storage."
            checked={getPermission('fileaccess')}
            onChange={(v) => setPermission('fileaccess', v)}
          />

          {/* Calls and notifications come from a phone, so only a phone shows these. */}
          {isLocalMobile && (
            <ToggleRow
              title="Allow Telephony"
              description="Send this device your incoming call notifications."
              checked={getPermission('telephony')}
              onChange={(v) => setPermission('telephony', v)}
            />
          )}

          {isLocalMobile && (
            <ToggleRow
              title="Allow Notification Mirroring"
              description="Send this device your app notifications."
              checked={getPermission('notification')}
              onChange={(v) => setPermission('notification', v)}
            />
          )}

          {/* Only desktops and TVs accept remote input (see the 'remoteinput' entry in
              DeviceControlPanel.tsx); isLocalDesktop means "not a phone". */}
          {isLocalDesktop && (
            <ToggleRow
              title="Allow Remote Input"
              description="Let this device send mouse clicks, touchpad movements, stylus/digitizer input, keyboard typing, and D-pad commands to this system."
              checked={getPermission('remoteinput')}
              onChange={(v) => setPermission('remoteinput', v)}
            />
          )}

          {/* Camera sharing is phone-only. On by default; the camera itself only runs while the
              paired device is using it. */}
          {isLocalMobile && (
            <ToggleRow
              title="Allow Camera as Webcam"
              description="Let this device use your camera as its webcam. Your camera only turns on when it asks."
              checked={getPermission('camera')}
              onChange={(v) => setPermission('camera', v)}
            />
          )}

          {/* On by default per device, like the others. A phone also needs Android's location
              permission (asked during setup); turning this on asks for it if it is missing. */}
          {localDeviceType !== 'tv' && (
            <>
              <ToggleRow
                title="Allow Location"
                description={isLocalMobile
                  ? 'Let this device see where your phone is, to find it if it is lost. It also keeps your last known position.'
                  : 'Let this device see where this PC is, to find it if it is lost. Needs Location services and "Let desktop apps access your location" on in Windows Settings.'}
                checked={getPermission('location')}
                onChange={(v) => onLocationToggle(v)}
              />
              {getPermission('location') && locationAccess && !locationAccess.granted && (
                <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.45, marginTop: '-8px' }}>
                  Link has no location access, so this device cannot locate your phone yet.{' '}
                  <button className="link-button" onClick={() => onLocationToggle(true)} style={{ padding: 0, background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: 'inherit' }}>
                    Allow location
                  </button>
                </div>
              )}
              {getPermission('location') && locationAccess?.granted && !locationAccess.precise && (
                <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.45, marginTop: '-8px' }}>
                  Only approximate location is allowed, so positions are off by up to a few kilometres. Allow precise location for Link in Android settings for GPS accuracy.
                </div>
              )}
            </>
          )}

          <ToggleRow
            title="Allow Remote Control & Extend Screen"
            description="Let this device view your screen, use it as an extra display, and interact with touch, mouse, and keyboard input."
            checked={getPermission('remotecontrol')}
            onChange={(v) => setPermission('remotecontrol', v)}
          />

          {/* The virtual gamepad runs on a desktop; phones only send to it. */}
          {isLocalDesktop && (
            <ToggleRow
              title="Allow Joystick"
              description="Let this device act as a game controller on this system."
              checked={getPermission('joystick')}
              onChange={(v) => setPermission('joystick', v)}
            />
          )}

          {/* Only a desktop runs whitelisted commands; Android can only trigger a peer's. */}
          {isLocalDesktop && (
            <ToggleRow
              title="Allow Run Command"
              description="Let this device see and trigger your whitelisted commands."
              checked={getPermission('runcommand')}
              onChange={(v) => setPermission('runcommand', v)}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default DevicePermissionsModal;
