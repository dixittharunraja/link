import React, { useEffect, useState } from 'react';
import { LinkApi } from '../vite-env';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { SessionHostQr } from './SessionHostQr';
import { AudioListenerRow } from './AudioListenerRow';
import { DialogCard } from './DialogCard';
import { useHostQrCode } from '../utils/qr';

const linkApi = (window as any).link as LinkApi;

export interface InputGuestTabConfig {
  mode: 'presenter' | 'touchpad';
  toolName: string;
  statusText: string;
  hostIcon: React.ReactNode;
  qrSubtitle: string;
  clientHelpText: string;
  scannerTitle: string;
  connectingLabel: string;
  onLaunchTool?: (targetId: string) => void;
}

interface InputGuestTabProps {
  config: InputGuestTabConfig;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
}

export const InputGuestTab: React.FC<InputGuestTabProps> = ({
  config,
  localIdentity,
  isMobile,
}) => {
  const isDesktop = !isMobile && localIdentity.deviceType !== 'phone';

  // Desktop (Host) state
  const [admittedGuest, setAdmittedGuest] = useState<{ ip: string; name: string; mode: string } | null>(null);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; ip: string; name: string; pin: string }[]>([]);
  const qrDataUrl = useHostQrCode(isDesktop, localIdentity, 1749);

  // Mobile (Client) state
  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectingPhase, setConnectingPhase] = useState<'connecting' | 'waiting-pin'>('connecting');
  const [pin, setPin] = useState<string | null>(null);
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const refreshGuestStatus = async () => {
    if (!linkApi || !isDesktop) return;
    try {
      const res = await linkApi.getInputGuestStatus?.();
      const guests: { ip: string; name: string; mode: string }[] = res?.admittedGuests || [];
      const myGuest = guests.find((g) => g.mode === config.mode) || null;
      setAdmittedGuest(myGuest);
      setPendingGuests((prev) => prev.filter((pg) => !guests.some((g) => g.ip === pg.ip)));
    } catch {}
  };

  useEffect(() => {
    if (!linkApi) return;

    if (isDesktop) {
      refreshGuestStatus();
      const unsubRoster = linkApi.onInputGuestRosterChanged?.(() => refreshGuestStatus());
      const unsubPin = linkApi.onInputGuestPinPending?.((connId: string, pinCode: string, remoteAddress: string, name: string, guestMode: string) => {
        if (guestMode === config.mode) {
          setPendingGuests((prev) => [
            ...prev.filter((g) => g.connId !== connId),
            { connId, ip: remoteAddress, name, pin: pinCode },
          ]);
        }
      });
      return () => {
        unsubRoster?.();
        unsubPin?.();
      };
    }

    const unsubPinReq = linkApi.onInputGuestPinRequired?.((computedPin: string) => {
      setPin(computedPin);
      setConnectingPhase('waiting-pin');
    });

    const unsubAdmitted = linkApi.onInputGuestAdmitted?.((admittedMode) => {
      if (admittedMode === config.mode) {
        setConnecting(false);
        setPin(null);
        setConnectingPhase('connecting');
        if (activeHost) {
          config.onLaunchTool?.(activeHost);
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
  }, [isDesktop, activeHost, config]);

  const handleConnect = (targetHost?: string) => {
    const target = (targetHost || joinIpInput).trim();
    if (!target) return;
    setConnectError(null);
    setConnecting(true);
    setPin(null);
    setConnectingPhase('connecting');
    setActiveHost(target);

    linkApi?.joinInputGuest?.(target, localIdentity?.deviceName || config.toolName, config.mode);
  };

  const handleCancelConnect = () => {
    linkApi?.leaveInputGuest?.();
    setConnecting(false);
    setPin(null);
    setActiveHost(null);
    setConnectingPhase('connecting');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Desktop (Host) View */}
      {isDesktop && (
        <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <SessionHostQr
            qrDataUrl={qrDataUrl}
            ipAddress={localIdentity?.ipAddress}
            altText={`${config.toolName} Host QR`}
            subtitle={config.qrSubtitle}
          />

          <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '4px 0' }} />

          {/* Connected Device Info */}
          <div style={{ width: '100%' }}>
            {!admittedGuest ? (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px' }}>
                No device connected
              </div>
            ) : (
              <AudioListenerRow
                label={admittedGuest.name}
                statusText={config.statusText}
                statusColor="#10b981"
                icon={config.hostIcon}
                iconBg="rgba(16, 185, 129, 0.1)"
                iconColor="#10b981"
                onKick={() => linkApi.kickInputGuest?.(admittedGuest.ip)}
              />
            )}
          </div>

          <PendingGuestsModal
            guests={pendingGuests.map((g) => ({ connId: g.connId, pin: g.pin, remoteAddress: g.ip, deviceName: g.name }))}
            subtitle={`wants to connect as ${config.toolName}`}
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
      )}

      {/* Mobile (Client) View */}
      {!isDesktop && (
        <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
            {config.clientHelpText}
          </div>

          <IpScanField
            value={joinIpInput}
            onChange={setJoinIpInput}
            onScanClick={() => setShowScannerModal(true)}
            onEnter={() => handleConnect()}
            placeholder="Host PC IP address (e.g. 192.168.1.100)"
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
                waitingLabel={config.connectingLabel}
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
            title={config.scannerTitle}
          />
        </div>
      )}
    </div>
  );
};
