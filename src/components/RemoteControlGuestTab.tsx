import React, { useEffect, useState } from 'react';
import { LinkApi } from '../vite-env';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { AudioListenerRow } from './AudioListenerRow';
import { DialogCard } from './DialogCard';
import { useHostQrCode } from '../utils/qr';

const linkApi = (window as any).link as LinkApi;

interface RemoteControlGuestTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  onLaunchViewer?: (hostDeviceType?: string) => void;
}

type Guest = { ip?: string; deviceId?: string; name: string; mode: string };

// Either device can host (show its screen to whoever joins by address and PIN) and either can be the
// viewer. Unlike the Remote Control of a paired device, nothing is trusted or remembered; a paired
// device simply isn't asked for a PIN.
const RemoteControlGuestTab: React.FC<RemoteControlGuestTabProps> = ({ localIdentity, isMobile: _isMobile, onLaunchViewer }) => {
  const [admittedGuest, setAdmittedGuest] = useState<Guest | null>(null);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; ip: string; name: string; pin: string }[]>([]);
  const qrDataUrl = useHostQrCode(true, localIdentity, 1749);

  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingPhase, setConnectingPhase] = useState<'connecting' | 'waiting-pin'>('connecting');
  const [pin, setPin] = useState<string | null>(null);
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const refreshGuestStatus = async () => {
    try {
      const res = await linkApi.getInputGuestStatus?.();
      const guests: Guest[] = res?.admittedGuests || [];
      const paired: Guest[] = res?.pairedSessions || [];
      const active = guests.find((g) => g.mode === 'remotecontrol') || paired.find((p) => p.mode === 'remotecontrol') || null;
      setAdmittedGuest(active);
      setPendingGuests((prev) => prev.filter((pg) => !guests.some((g) => g.ip === pg.ip)));
    } catch {}
  };

  const resetConnecting = () => {
    setConnecting(false);
    setPin(null);
    setConnectingPhase('connecting');
  };

  useEffect(() => {
    if (!linkApi) return;
    // The phone hosts too, so the server that admits guests has to be running.
    Promise.resolve(linkApi.startInputGuestHost?.()).catch(() => {});
    refreshGuestStatus();

    const unsubRoster = linkApi.onInputGuestRosterChanged?.(() => refreshGuestStatus());
    const unsubPin = linkApi.onInputGuestPinPending?.((connId, pinCode, remoteAddress, name, guestMode) => {
      if (guestMode === 'remotecontrol') {
        setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, ip: remoteAddress, name, pin: pinCode }]);
      }
    });
    const unsubPinReq = linkApi.onInputGuestPinRequired?.((computedPin) => {
      setPin(computedPin);
      setConnectingPhase('waiting-pin');
    });
    const unsubAdmitted = linkApi.onInputGuestAdmitted?.((admittedMode, _resolvedHost, hostDeviceType) => {
      if (admittedMode === 'remotecontrol') {
        resetConnecting();
        onLaunchViewer?.(hostDeviceType);
      }
    });
    const unsubClosed = linkApi.onInputGuestClosed?.((reason) => {
      resetConnecting();
      if (reason && reason !== 'disconnected') {
        setConnectError(reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host' : reason);
      }
    });
    const unsubError = linkApi.onInputGuestError?.((err) => {
      resetConnecting();
      setConnectError(err || 'Failed to connect');
    });
    const interval = setInterval(refreshGuestStatus, 2000);

    return () => {
      clearInterval(interval);
      unsubRoster?.();
      unsubPin?.();
      unsubPinReq?.();
      unsubAdmitted?.();
      unsubClosed?.();
      unsubError?.();
    };
  }, []);

  const handleConnect = (targetHost?: string) => {
    const target = (targetHost || joinIpInput).trim();
    if (!target) return;
    setConnectError(null);
    setConnecting(true);
    setPin(null);
    setConnectingPhase('connecting');
    setActiveHost(target);
    linkApi?.joinInputGuest?.(target, localIdentity?.deviceName || 'Remote Control', 'remotecontrol');
  };

  const handleCancelConnect = () => {
    linkApi?.leaveInputGuest?.();
    resetConnecting();
    setActiveHost(null);
  };

  const dropPending = (connId: string) => setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '8px 0', width: '100%' }}>
      {/* Active Controller Banner / Details if being controlled */}
      {admittedGuest && (
        <div style={{ width: '100%', marginBottom: '4px' }}>
          <AudioListenerRow
            label={admittedGuest.name || 'Remote Device'}
            statusText="Controlling this screen"
            statusColor="#10b981"
            icon={(
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
            )}
            iconBg="rgba(16, 185, 129, 0.1)"
            iconColor="#10b981"
            onKick={async () => {
              if (admittedGuest.ip) {
                await linkApi.kickInputGuest?.(admittedGuest.ip);
              } else if (admittedGuest.deviceId) {
                // Stops this PC's own stream too; telling the phone to stop alone left it running here.
                await linkApi.kickInputGuest?.(admittedGuest.deviceId);
                await linkApi.sendRemoteControlSignal?.(admittedGuest.deviceId, { type: 'stop' });
              }
              refreshGuestStatus();
            }}
            onBlock={async () => {
              if (admittedGuest.ip) {
                await linkApi.blockDevice?.(admittedGuest.ip, admittedGuest.name || 'Remote Guest', 'ip');
                await linkApi.kickInputGuest?.(admittedGuest.ip);
              } else if (admittedGuest.deviceId) {
                await linkApi.blockDevice?.(admittedGuest.deviceId, admittedGuest.name || 'Remote Device', 'device');
                await linkApi.kickInputGuest?.(admittedGuest.deviceId);
                await linkApi.sendRemoteControlSignal?.(admittedGuest.deviceId, { type: 'stop' });
              }
              refreshGuestStatus();
            }}
          />
        </div>
      )}

      {/* Split layout: Host QR on the left, Connect to Peer input on the right (like File Transfer) */}
      <div className="fx-split-container">
        <div className="fx-split">
          {/* Host Column: QR Code & IP */}
          <div className="fx-split-col" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '12px 16px', boxSizing: 'border-box' }}>
            <div style={{ fontWeight: 600, marginBottom: '8px', color: 'var(--text-color)', fontSize: '14px' }}>
              Host Screen
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4', textAlign: 'center', marginBottom: '12px' }}>
              Scan this QR code with another device to view and control this screen.
            </div>
            {qrDataUrl ? (
              <div style={{ background: '#fff', padding: '8px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                <img src={qrDataUrl} alt="Remote Control Host QR" style={{ display: 'block', width: '130px', height: '130px', imageRendering: 'pixelated' }} />
              </div>
            ) : (
              <div style={{ width: '130px', height: '130px', background: 'rgba(0,0,0,0.05)', borderRadius: '8px' }} />
            )}
            <div style={{ fontSize: '13.5px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-color)', marginTop: '8px' }}>
              {localIdentity?.ipAddress || 'unknown'}
            </div>
          </div>

          <div className="fx-split-divider" />

          {/* Connect Column: IP Input & Scan Button */}
          <div className="fx-split-col" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '12px 16px', gap: '10px', boxSizing: 'border-box' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>
              Control Another Device
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
              Enter the target device's IP address or scan its QR code to view and control its screen.
            </div>

            {connectError && (
              <div style={{ color: '#e05c5c', fontSize: '12px', overflowWrap: 'anywhere' }}>{connectError}</div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', marginTop: '6px' }}>
              <IpScanField
                value={joinIpInput}
                onChange={setJoinIpInput}
                onScanClick={() => setShowScannerModal(true)}
                onEnter={() => handleConnect()}
                placeholder="Target device IP address"
              />
              <PrimaryButton onClick={() => handleConnect()} disabled={!joinIpInput.trim()}>
                Connect
              </PrimaryButton>
            </div>
          </div>
        </div>
      </div>

      {connecting && (
        <DialogCard onCancel={handleCancelConnect} zIndex={2000}>
          <ConnectingCard
            targetLabel={activeHost || joinIpInput}
            phase={connectingPhase}
            pin={pin}
            onCancel={handleCancelConnect}
            waitingLabel="Connecting to the computer..."
          />
        </DialogCard>
      )}

      <ScannerModal
        open={showScannerModal}
        onClose={() => setShowScannerModal(false)}
        onDecoded={(scannedIp) => {
          setJoinIpInput(scannedIp);
          setShowScannerModal(false);
          handleConnect(scannedIp);
        }}
        title="Scan Remote Control Host QR"
      />

      <PendingGuestsModal
        guests={pendingGuests.map((g) => ({ connId: g.connId, pin: g.pin, remoteAddress: g.ip, deviceName: g.name }))}
        title="Remote Control Request"
        iconType="input"
        subtitle="wants to view and control this screen"
        onAccept={(connId) => { linkApi.acceptInputGuest?.(connId); dropPending(connId); }}
        onReject={(connId) => { linkApi.rejectInputGuest?.(connId); dropPending(connId); }}
        onBlock={(connId) => { linkApi.blockInputGuest?.(connId); dropPending(connId); }}
      />
    </div>
  );
};

export default RemoteControlGuestTab;
