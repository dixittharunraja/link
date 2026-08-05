import React from 'react';
import ToggleRow from './ToggleRow';

interface DevicePermissionsModalProps {
  deviceName: string;
  localDeviceType?: string;
  getPermission: (permKey: string) => boolean;
  setPermission: (permKey: string, allowed: boolean) => void;
  onClose: () => void;
}

// Extracted from DevicesTab.tsx, where this lived inline as part of one 900+ line file. Pure
// move — same JSX, same props (now passed explicitly instead of closed over), no behavior change.
const DevicePermissionsModal: React.FC<DevicePermissionsModalProps> = ({
  deviceName,
  localDeviceType,
  getPermission,
  setPermission,
  onClose,
}) => {
  // These toggles gate what the peer is allowed to do TO this (local) device, so they must
  // reflect what the LOCAL device is actually capable of executing — not the peer's type.
  // Touchpad/Presenter/Digitizer are only ever executed by desktop (cursor/slides/stylus);
  // Flashlight/DND are only ever executed by mobile (torch/notification policy). Telephony/
  // Notification are OWNED by the mobile device (only a phone actually generates calls/
  // notifications) — desktop is purely a passive display, it never decides anything. So, like
  // Flashlight/DND, those toggles only belong on the OWNER's own settings dialog: gate on LOCAL
  // device type, not on the peer being configured.
  const isLocalDesktop = localDeviceType !== 'phone';
  const isLocalMobile = localDeviceType === 'phone';

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
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700 }}>
            {deviceName} Permissions
          </div>
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

        {/* Preferences Toggles */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Clipboard Sync — sending-only, like Telephony/Notification/Flashlight/DND: this
              device owns its own clipboard, so this only controls whether IT gets sent to that
              peer. Receiving is controlled entirely by the peer's own permission-for-us on
              their side, not by anything here. */}
          <ToggleRow
            title="Clipboard Sync"
            description="Send this device your clipboard content."
            checked={getPermission('clipboard')}
            onChange={(v) => setPermission('clipboard', v)}
          />


          {/* Presenter is executed by BOTH platforms now: desktop (slides/spotlight) and mobile
              (in-app pointer-dot overlay, mobile-to-mobile) — unlike Touchpad/Digitizer below,
              which stay desktop-only until their mobile-target support is built. */}
          <ToggleRow
            title="Allow Presenter"
            description="Allow slide and spotlight presentations."
            checked={getPermission('presenter')}
            onChange={(v) => setPermission('presenter', v)}
          />

          {isLocalDesktop && (
            <ToggleRow
              title="Allow Digitizer"
              description="Allow absolute stylus graphics mapping."
              checked={getPermission('digitizer')}
              onChange={(v) => setPermission('digitizer', v)}
            />
          )}

          {/* Joystick has no allow/deny toggle at all, same as Ring below — it's inherently
              available to any connected device, so a friend's phone can be handed a controller
              without being pre-configured first. */}

          <ToggleRow
            title="Allow File Access"
            description="Allow mounting device folder storage."
            checked={getPermission('fileaccess')}
            onChange={(v) => setPermission('fileaccess', v)}
          />

          {/* Flashlight — only mobile ever executes this; desktop has no torch. */}
          {isLocalMobile && (
            <ToggleRow
              title="Allow Flashlight"
              description="Allow camera flash toggles."
              checked={getPermission('flashlight')}
              onChange={(v) => setPermission('flashlight', v)}
            />
          )}
          {/* DND — only mobile ever executes this; desktop has no notification-policy control. */}
          {isLocalMobile && (
            <ToggleRow
              title="Allow DND"
              description="Allow remote Do Not Disturb toggles."
              checked={getPermission('dnd')}
              onChange={(v) => setPermission('dnd', v)}
            />
          )}


          {/* Lock — Ring has no toggle at all: it's inherently available to any connected,
              trusted device, same as rename. */}
          <ToggleRow
            title="Allow Lock"
            description="Allow remote lock control."
            checked={getPermission('lock')}
            onChange={(v) => setPermission('lock', v)}
          />

          <ToggleRow
            title="Allow System Volume"
            description="Let this device see and control your volume/mute."
            checked={getPermission('systemvolume')}
            onChange={(v) => setPermission('systemvolume', v)}
          />

          <ToggleRow
            title="Allow Media Control"
            description="Let this device see and control your media playback."
            checked={getPermission('mpris')}
            onChange={(v) => setPermission('mpris', v)}
          />

          {/* Telephony — only mobile owns/generates call data, so only mobile's own settings
              dialog controls, per peer, whether to share it. */}
          {isLocalMobile && (
            <ToggleRow
              title="Allow Telephony"
              description="Send this device your incoming call notifications."
              checked={getPermission('telephony')}
              onChange={(v) => setPermission('telephony', v)}
            />
          )}

          {/* Notification mirroring — same reasoning: only mobile owns its own notifications,
              so only mobile's dialog controls sharing them. */}
          {isLocalMobile && (
            <ToggleRow
              title="Allow Notification Mirroring"
              description="Send this device your app notifications."
              checked={getPermission('notification')}
              onChange={(v) => setPermission('notification', v)}
            />
          )}

          <ToggleRow
            title="Allow Remote Input"
            description="Let this device send mouse clicks, touchpad movements, keyboard typing, and D-pad commands to this system."
            checked={getPermission('remoteinput')}
            onChange={(v) => setPermission('remoteinput', v)}
          />

          {/* Run Command — only desktop ever executes/whitelists commands; Android has no
              executor at all (it only receives a peer's list and triggers on THEM). */}
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
