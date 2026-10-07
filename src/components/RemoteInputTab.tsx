import React, { useEffect, useState } from 'react';
import { LinkApi } from '../vite-env';
import { ScannerModal, IpScanField, ConnectingCard, PrimaryButton } from './ModalDialog';
import { DialogCard } from './DialogCard';

const linkApi = (window as any).link as LinkApi;

interface RemoteInputTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  onLaunchTouchpad?: (targetId: string, hostDeviceType?: string) => void;
}

const RemoteInputTab: React.FC<RemoteInputTabProps> = ({
  localIdentity,
  onLaunchTouchpad,
}) => {
  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingPhase, setConnectingPhase] = useState<'connecting' | 'waiting-pin'>('connecting');
  const [pin, setPin] = useState<string | null>(null);
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!linkApi) return;

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '8px 0' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: '1.4' }}>
        Enter the host computer's IP address or scan its QR code to control mouse, keyboard, and stylus.
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
