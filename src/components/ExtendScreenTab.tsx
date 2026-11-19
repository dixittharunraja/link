import React, { useEffect, useState } from 'react';
import { LinkApi } from '../vite-env';
import { AudioListenerRow } from './AudioListenerRow';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { DialogCard } from './DialogCard';
import { useHostQrCode } from '../utils/qr';
import { INPUT_GUEST_PORT } from '../utils/ports';
import { startVisibleInterval } from '../hooks/useVisibleInterval';
import { FEATURE_ICONS } from '../utils/featureIcons';

const ExtendIcon = FEATURE_ICONS.extendScreen;

const linkApi = (window as any).link as LinkApi;

interface ExtendScreenTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  /** Extend a computer joined by address and PIN, nothing paired. */
  onLaunchGuest?: (hostDeviceType?: string) => void;
}

type Guest = { ip: string; name: string; mode: string };


// Laid out like Remote Input, for unpaired devices only: a paired device is extended (and ended) from
// its device panel. A computer shows its QR code and the devices extending it, and can itself extend
// another computer; a phone joins a computer by its address and PIN, nothing trusted or remembered. Only
// a computer can be extended: it makes an extra monitor for each device that joins, and that device
// shows and controls it.
const ExtendScreenTab: React.FC<ExtendScreenTabProps> = ({ localIdentity, isMobile, onLaunchGuest }) => {
  const [extending, setExtending] = useState<Guest[]>([]);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; ip: string; name: string; pin: string }[]>([]);
  // A phone cannot be extended, so only a computer shows its address to join.
  const qrDataUrl = useHostQrCode(!isMobile, localIdentity, INPUT_GUEST_PORT);

  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingPhase, setConnectingPhase] = useState<'connecting' | 'waiting-pin'>('connecting');
  const [pin, setPin] = useState<string | null>(null);
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await linkApi.getInputGuestStatus?.();
      const guests: Guest[] = res?.admittedGuests || [];
      setExtending(guests.filter((g) => g.mode === 'extendscreen'));
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
    refresh();
    const unsubRoster = linkApi.onInputGuestRosterChanged?.(() => refresh());
    const unsubPin = linkApi.onInputGuestPinPending?.((connId, pinCode, remoteAddress, name, guestMode) => {
      if (guestMode === 'extendscreen') {
        setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, ip: remoteAddress, name, pin: pinCode }]);
      }
    });
    const unsubPinReq = linkApi.onInputGuestPinRequired?.((computedPin) => {
      setPin(computedPin);
      setConnectingPhase('waiting-pin');
    });
    const unsubAdmitted = linkApi.onInputGuestAdmitted?.((admittedMode, _resolvedHost, hostDeviceType) => {
      if (admittedMode === 'extendscreen') {
        resetConnecting();
        onLaunchGuest?.(hostDeviceType);
      }
    });
    const unsubClosed = linkApi.onInputGuestClosed?.((reason) => {
      resetConnecting();
      if (reason && reason !== 'disconnected') {
        setConnectError(
          reason === 'rejected by host' || reason === 'blocked'
            ? 'Rejected by host'
            : reason === 'unsupported target'
              ? 'Only a computer can be extended, not a phone.'
              : reason,
        );
      }
    });
    const unsubError = linkApi.onInputGuestError?.((err) => {
      resetConnecting();
      setConnectError(err || 'Failed to connect');
    });
    const stopPolling = startVisibleInterval(refresh, 2000);
    return () => {
      stopPolling();
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
    linkApi?.joinInputGuest?.(target, localIdentity?.deviceName || 'Extended Screen', 'extendscreen');
  };

  const handleCancelConnect = () => {
    linkApi?.leaveInputGuest?.();
    resetConnecting();
    setActiveHost(null);
  };

  const endSession = async (guest: Guest, block: boolean) => {
    if (block) await linkApi.blockDevice?.(guest.ip, guest.name || 'Extended Screen', 'ip');
    await linkApi.kickInputGuest?.(guest.ip);
    refresh();
  };

  const dropPending = (connId: string) => setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));

  const connectColumn = (
    <div className="fx-split-col" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '12px 16px', gap: '10px', boxSizing: 'border-box' }}>
      <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Connect</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
        Enter the computer's IP address or scan its QR code.
      </div>

      {connectError && <div style={{ color: '#e05c5c', fontSize: '12px', overflowWrap: 'anywhere' }}>{connectError}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', marginTop: '6px' }}>
        <IpScanField
          value={joinIpInput}
          onChange={setJoinIpInput}
          onScanClick={() => setShowScannerModal(true)}
          onEnter={() => handleConnect()}
          placeholder="Computer IP address"
        />
        <PrimaryButton onClick={() => handleConnect()} disabled={!joinIpInput.trim()}>
          Connect
        </PrimaryButton>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '8px 0', width: '100%' }}>
      {/* Devices extending this computer */}
      {extending.map((guest) => (
        <AudioListenerRow
          key={guest.ip}
          label={guest.name || 'Extended Screen'}
          statusText="Extending this screen"
          statusColor="#10b981"
          icon={<ExtendIcon size={16} strokeWidth={2} />}
          onKick={() => endSession(guest, false)}
          onBlock={() => endSession(guest, true)}
        />
      ))}

      {isMobile ? (
        /* Phone: connect to a computer, laid out like Remote Input */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: '1.4' }}>
            Enter your computer's IP address or scan its QR code to use this phone as an extra screen.
          </div>

          <IpScanField
            value={joinIpInput}
            onChange={setJoinIpInput}
            onScanClick={() => setShowScannerModal(true)}
            onEnter={() => handleConnect()}
            placeholder="Computer IP address (e.g. 192.168.1.100)"
          />

          {connectError && <div style={{ color: '#e05c5c', fontSize: '12px' }}>{connectError}</div>}

          <PrimaryButton onClick={() => handleConnect()} disabled={!joinIpInput.trim()}>
            Connect
          </PrimaryButton>
        </div>
      ) : (
        /* Computer: host this screen, or connect to another computer */
        <div className="fx-split-container">
          <div className="fx-split">
            <div className="fx-split-col" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '12px 16px', boxSizing: 'border-box' }}>
              <div style={{ fontWeight: 600, marginBottom: '8px', color: 'var(--text-color)', fontSize: '14px' }}>Host Screen</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4', textAlign: 'center', marginBottom: '12px' }}>
                Scan this QR code with another device to use it as an extra screen.
              </div>
              {qrDataUrl ? (
                <div style={{ background: '#fff', padding: '8px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  <img src={qrDataUrl} alt="Extend Screen Host QR" style={{ display: 'block', width: '130px', height: '130px', imageRendering: 'pixelated' }} />
                </div>
              ) : (
                <div style={{ width: '130px', height: '130px', background: 'rgba(0,0,0,0.05)', borderRadius: '8px' }} />
              )}
              <div style={{ fontSize: '13.5px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-color)', marginTop: '8px' }}>
                {localIdentity?.ipAddress || 'unknown'}
              </div>
            </div>
            <div className="fx-split-divider" />
            {connectColumn}
          </div>
        </div>
      )}

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
        title="Scan Extend Screen Host QR"
      />

      {!isMobile && pendingGuests.length > 0 && (
        <PendingGuestsModal
          guests={pendingGuests.map((g) => ({ connId: g.connId, pin: g.pin, remoteAddress: g.ip, deviceName: g.name }))}
          title="Extend Screen Request"
          iconType="input"
          subtitle="wants to use itself as an extra screen for this computer"
          onAccept={(connId) => { linkApi.acceptInputGuest?.(connId); dropPending(connId); }}
          onReject={(connId) => { linkApi.rejectInputGuest?.(connId); dropPending(connId); }}
          onBlock={(connId) => { linkApi.blockInputGuest?.(connId); dropPending(connId); }}
        />
      )}
    </div>
  );
};

export default ExtendScreenTab;
