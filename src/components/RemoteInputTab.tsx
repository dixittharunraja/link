import React, { useEffect, useState } from 'react';
import { LinkApi } from '../vite-env';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { SessionHostQr } from './SessionHostQr';
import { AudioListenerRow } from './AudioListenerRow';
import { DialogCard } from './DialogCard';
import { useHostQrCode } from '../utils/qr';
import { INPUT_GUEST_PORT } from '../utils/ports';
import { startVisibleInterval } from '../hooks/useVisibleInterval';
import { IS_TV } from '../utils/platform';

const linkApi = (window as any).link as LinkApi;

interface RemoteInputTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  onLaunchTouchpad?: (targetId: string, hostDeviceType?: string) => void;
}

const RemoteInputTab: React.FC<RemoteInputTabProps> = ({
  localIdentity,
  isMobile,
  onLaunchTouchpad,
}) => {
  // Host state (PC)
  const [admittedGuest, setAdmittedGuest] = useState<{ ip?: string; deviceId?: string; name: string; mode: string } | null>(null);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; ip: string; name: string; pin: string }[]>([]);
  const qrDataUrl = useHostQrCode(true, localIdentity, INPUT_GUEST_PORT);

  // Client connect state (Mobile)
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
      const guests: { ip?: string; deviceId?: string; name: string; mode: string }[] = res?.admittedGuests || [];
      const paired: { ip?: string; deviceId?: string; name: string; mode: string }[] = res?.pairedSessions || [];
      const myGuest = guests.find((g) => g.mode === 'touchpad') || paired.find((p) => p.mode === 'touchpad') || null;
      setAdmittedGuest(myGuest);
      setPendingGuests((prev) => prev.filter((pg) => !guests.some((g) => g.ip === pg.ip)));
    } catch {}
  };

  // Every device can be controlled; a PC and a TV only that, a phone can also control others.
  const canSend = isMobile && !IS_TV;

  useEffect(() => {
    if (!linkApi) return;

    // The PC's host runs on its own; a phone or TV starts it while this tool is open.
    if (isMobile) Promise.resolve(linkApi.startInputGuestHost?.()).catch(() => {});
    refreshGuestStatus();

    const unsubRoster = linkApi.onInputGuestRosterChanged?.(() => refreshGuestStatus());
    const unsubPin = linkApi.onInputGuestPinPending?.((connId: string, pinCode: string, remoteAddress: string, name: string, guestMode: string) => {
      if (guestMode === 'touchpad') {
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
      if (admittedMode === 'touchpad') {
        setConnecting(false);
        setPin(null);
        setConnectingPhase('connecting');
        const launchTarget = resolvedHost || activeHost;
        if (launchTarget) {
          onLaunchTouchpad?.(launchTarget, hostDeviceType);
        }
      }
    });

    const unsubClosed = linkApi.onInputGuestClosed?.((reason) => {
      setConnecting(false);
      setPin(null);
      setConnectingPhase('connecting');
      if (reason && reason !== 'disconnected') {
        setConnectError(reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host' : reason === 'unsupported target' ? 'That phone needs a newer Link to be controlled.' : reason);
      }
    });

    const unsubError = linkApi.onInputGuestError?.((err) => {
      setConnecting(false);
      setPin(null);
      setConnectingPhase('connecting');
      setConnectError(err || 'Failed to connect');
    });

    const stopPolling = startVisibleInterval(refreshGuestStatus, 2000);

    return () => {
      stopPolling();
      unsubRoster?.();
      unsubPin?.();
      unsubPinReq?.();
      unsubAdmitted?.();
      unsubClosed?.();
      unsubError?.();
    };
  }, [activeHost]);

  const handleConnect = (targetHost?: string) => {
    const target = (targetHost || joinIpInput).trim();
    if (!target) return;
    setConnectError(null);
    setConnecting(true);
    setPin(null);
    setConnectingPhase('connecting');
    setActiveHost(target);

    linkApi?.joinInputGuest?.(target, localIdentity?.deviceName || 'Remote Input', 'touchpad');
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
      {/* Pending Guest Approval Modal */}
      {pendingGuests.length > 0 && (
        <PendingGuestsModal
          guests={pendingGuests.map((g) => ({
            connId: g.connId,
            pin: g.pin,
            remoteAddress: g.ip,
            deviceName: g.name,
          }))}
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
      )}

      {/* This device's QR code, and the phone controlling it (or, on a PC or TV, that it is waiting for one) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }}>
          <SessionHostQr
            qrDataUrl={qrDataUrl}
            ipAddress={localIdentity?.ipAddress}
            altText="Remote Input Host QR"
            subtitle={isMobile ? 'Scan with another phone to control this one' : 'Scan with your phone to use it as a trackpad, keyboard, or stylus'}
          />

          <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '2px 0' }} />

          {(admittedGuest || !canSend) && <div style={{ width: '100%' }}>
            {admittedGuest ? (
              <AudioListenerRow
                label={admittedGuest.name}
                statusText="Controlling Input"
                statusColor="#10b981"
                icon={(
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                )}
                iconBg="rgba(16, 185, 129, 0.1)"
                iconColor="#10b981"
                onKick={async () => {
                  if (admittedGuest.ip) {
                    await linkApi.kickInputGuest?.(admittedGuest.ip);
                  } else if (admittedGuest.deviceId) {
                    await linkApi.kickInputGuest?.(admittedGuest.deviceId); // mutes it; the phone keeps sending
                    await linkApi.sendSpecialKey?.(admittedGuest.deviceId, 14); // Escape
                    await linkApi.sendDigitizerSession?.(admittedGuest.deviceId, 'end', 0, 0);
                  }
                  refreshGuestStatus();
                }}
                onBlock={async () => {
                  if (admittedGuest.ip) {
                    await linkApi.blockDevice?.(admittedGuest.ip, admittedGuest.name || 'Remote Guest', 'ip');
                    await linkApi.kickInputGuest?.(admittedGuest.ip);
                  } else if (admittedGuest.deviceId) {
                    await linkApi.blockDevice?.(admittedGuest.deviceId, admittedGuest.name || 'Remote Device', 'device');
                    await linkApi.sendSpecialKey?.(admittedGuest.deviceId, 14); // Escape
                    await linkApi.sendDigitizerSession?.(admittedGuest.deviceId, 'end', 0, 0);
                  }
                  refreshGuestStatus();
                }}
              />
            ) : (
              <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
                Waiting for phone to connect...
              </div>
            )}
          </div>}
      </div>

      {/* A phone also controls others: by address or by scanning their QR code */}
      {canSend && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: '1.4' }}>
            Enter another device's IP address or scan its QR code to control its mouse, keyboard, and stylus.
          </div>

          <IpScanField
            value={joinIpInput}
            onChange={setJoinIpInput}
            onScanClick={() => setShowScannerModal(true)}
            onEnter={() => handleConnect()}
            placeholder="IP address (e.g. 192.168.1.100)"
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
            waitingLabel="Connecting to remote input host..."
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
        title="Scan Remote Input Host QR"
      />
    </div>
  );
};

export default RemoteInputTab;
