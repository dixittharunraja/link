import React, { useEffect, useState } from 'react';
import { LinkApi } from '../vite-env';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { SessionHostQr } from './SessionHostQr';
import { AudioListenerRow } from './AudioListenerRow';
import { DialogCard } from './DialogCard';
import { useHostQrCode } from '../utils/qr';

const linkApi = (window as any).link as LinkApi;

interface PresenterTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  onLaunchPresenter?: (targetId: string, hostDeviceType?: string) => void;
}

const PresenterTab: React.FC<PresenterTabProps> = ({
  localIdentity,
  isMobile,
  onLaunchPresenter,
}) => {
  // Host state
  const [admittedGuest, setAdmittedGuest] = useState<{ ip: string; name: string; mode: string } | null>(null);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; ip: string; name: string; pin: string }[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const qrDataUrl = useHostQrCode(true, localIdentity, 1749);

  // Client connect state
  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingPhase, setConnectingPhase] = useState<'connecting' | 'waiting-pin'>('connecting');
  const [pin, setPin] = useState<string | null>(null);
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const refreshGuestStatus = async () => {
    if (!linkApi) return;
    try {
      const res = await linkApi.getInputGuestStatus?.();
      const guests: { ip: string; name: string; mode: string }[] = res?.admittedGuests || [];
      const myGuest = guests.find((g) => g.mode === 'presenter') || null;
      setAdmittedGuest(myGuest);
      setPendingGuests((prev) => prev.filter((pg) => !guests.some((g) => g.ip === pg.ip)));
    } catch {}
  };

  useEffect(() => {
    if (!linkApi) return;

    if (isMobile) {
      setHostError(null);
      Promise.resolve(linkApi.startInputGuestHost?.()).catch((err: any) => {
        setHostError(err?.message || err?.toString?.() || 'Failed to start hosting');
      });
    }
    refreshGuestStatus();

    const unsubRoster = linkApi.onInputGuestRosterChanged?.(() => refreshGuestStatus());
    const unsubPin = linkApi.onInputGuestPinPending?.((connId: string, pinCode: string, remoteAddress: string, name: string, guestMode: string) => {
      if (guestMode === 'presenter') {
        setPendingGuests((prev) => [
          ...prev.filter((g) => g.connId !== connId),
          { connId, ip: remoteAddress, name, pin: pinCode },
        ]);
      }
    });

    const unsubPinReq = linkApi.onInputGuestPinRequired?.((computedPin: string) => {
      setPin(computedPin);
      setConnectingPhase('waiting-pin');
    });

    const unsubAdmitted = linkApi.onInputGuestAdmitted?.((admittedMode, resolvedHost, hostDeviceType) => {
      if (admittedMode === 'presenter') {
        setConnecting(false);
        setPin(null);
        setConnectingPhase('connecting');
        const launchTarget = resolvedHost || activeHost;
        if (launchTarget) {
          onLaunchPresenter?.(launchTarget, hostDeviceType);
        }
      }
    });

    const unsubClosed = linkApi.onInputGuestClosed?.((reason) => {
      setConnecting(false);
      setPin(null);
      setConnectingPhase('connecting');
      if (reason && reason !== 'disconnected') {
        setConnectError(reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host' : reason);
      }
    });

    const unsubError = linkApi.onInputGuestError?.((err) => {
      setConnecting(false);
      setPin(null);
      setConnectingPhase('connecting');
      setConnectError(err || 'Failed to connect');
    });

    return () => {
      unsubRoster?.();
      unsubPin?.();
      unsubPinReq?.();
      unsubAdmitted?.();
      unsubClosed?.();
      unsubError?.();
    };
  }, [isMobile, activeHost]);

  const handleConnect = (targetHost?: string) => {
    const target = (targetHost || joinIpInput).trim();
    if (!target) return;
    setConnectError(null);
    setConnecting(true);
    setPin(null);
    setConnectingPhase('connecting');
    setActiveHost(target);

    linkApi?.joinInputGuest?.(target, localIdentity?.deviceName || 'Presenter', 'presenter');
  };

  const handleCancelConnect = () => {
    linkApi?.leaveInputGuest?.();
    setConnecting(false);
    setPin(null);
    setActiveHost(null);
    setConnectingPhase('connecting');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '8px 0' }}>
      {/* QR Section - Top */}
      <SessionHostQr
        qrDataUrl={qrDataUrl}
        ipAddress={localIdentity?.ipAddress}
        altText="Presenter Host QR"
        subtitle="Scan with your phone to start presenter remote"
      />

      {hostError && (
        <div style={{ color: '#e05c5c', fontSize: '12px', textAlign: 'center' }}>
          Couldn't start hosting: {hostError}
        </div>
      )}

      <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '2px 0' }} />

      {/* Bottom Section - Either Connected Device or Connect Input */}
      {admittedGuest ? (
        <div style={{ width: '100%' }}>
          <AudioListenerRow
            label={admittedGuest.name}
            statusText="Controlling Presentation"
            statusColor="#10b981"
            icon={(
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            )}
            iconBg="rgba(16, 185, 129, 0.1)"
            iconColor="#10b981"
            onKick={() => linkApi.kickInputGuest?.(admittedGuest.ip)}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
            Enter the host computer's IP address or scan its QR code to start presenter remote.
          </div>

          <IpScanField
            value={joinIpInput}
            onChange={setJoinIpInput}
            onScanClick={() => setShowScannerModal(true)}
            onEnter={() => handleConnect()}
            placeholder="Host IP address (e.g. 192.168.1.100)"
          />

          {connectError && (
            <div style={{ color: '#e05c5c', fontSize: '12px' }}>
              {connectError}
            </div>
          )}

          <PrimaryButton
            onClick={() => handleConnect()}
            disabled={!joinIpInput.trim()}
          >
            Connect
          </PrimaryButton>
        </div>
      )}

      {connecting && (
        <DialogCard onCancel={handleCancelConnect} zIndex={2000}>
          <ConnectingCard
            targetLabel={activeHost || joinIpInput}
            phase={connectingPhase}
            pin={pin}
            onCancel={handleCancelConnect}
            waitingLabel="Connecting to presenter host..."
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
        title="Scan Presenter Host QR"
      />

      <PendingGuestsModal
        guests={pendingGuests.map((g) => ({ connId: g.connId, pin: g.pin, remoteAddress: g.ip, deviceName: g.name }))}
        title="Presenter Request"
        iconType="presenter"
        subtitle="wants to connect as Presenter"
        onAccept={(connId) => {
          linkApi.acceptInputGuest?.(connId);
          setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
        }}
        onReject={(connId) => {
          linkApi.rejectInputGuest?.(connId);
          setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
        }}
        onBlock={(connId) => {
          linkApi.blockInputGuest?.(connId);
          setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
        }}
      />
    </div>
  );
};

export default PresenterTab;
