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

// Extracted from DevicesTab.tsx, where this lived inline as part of one 900+ line file. Pure
// move — same JSX, same props (now passed explicitly instead of closed over), no behavior change.
const DevicePermissionsModal: React.FC<DevicePermissionsModalProps> = ({
  deviceName,
  localDeviceType,
  getPermission,
  setPermission,
  onClose,
}) => {
  useEscapeAndBack(onClose);
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
          <ModalCloseButton onClose={onClose} />
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


          {/* Presenter is only executed on desktop/TV (slides/spotlight). A mobile device is
              never presented on from a PC. */}
          {isLocalDesktop && (
            <ToggleRow
              title="Allow Presenter"
              description="Allow slide and spotlight presentations."
              checked={getPermission('presenter')}
              onChange={(v) => setPermission('presenter', v)}
            />
          )}

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

          {/* Remote Input — only desktop/TV are ever a target (see DeviceControlPanel.tsx's
              'remoteinput' entry for why phone was dropped as a target); isLocalDesktop covers
              both, since it's really "not phone". */}
          {isLocalDesktop && (
            <ToggleRow
              title="Allow Remote Input"
              description="Let this device send mouse clicks, touchpad movements, stylus/digitizer input, keyboard typing, and D-pad commands to this system."
              checked={getPermission('remoteinput')}
              onChange={(v) => setPermission('remoteinput', v)}
            />
          )}

          {/* Remote Control — screen streaming and interactive control */}
          <ToggleRow
            title="Allow Remote Control"
            description="Let this device view your screen and interact with touch, mouse, and keyboard input."
            checked={getPermission('remotecontrol')}
            onChange={(v) => setPermission('remotecontrol', v)}
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
