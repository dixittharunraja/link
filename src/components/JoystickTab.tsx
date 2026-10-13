import React, { useCallback, useEffect, useState } from 'react';
import JoystickOverlay, {
  DEFAULT_CUSTOM_LAYOUT, DEFAULT_DRIVING_LAYOUT,
  isBuiltinLayout, JoystickLayout, CustomPreset, ActiveModes, DEFAULT_ACTIVE_MODES,
  loadCustomPresetsFromStorage, loadJoystickSkinFromStorage, loadJoystickHapticsFromStorage,
  loadJoystickLayoutFromStorage, loadJoystickBuiltinModesFromStorage,
  SKIN_STORAGE_KEY, HAPTICS_STORAGE_KEY, LAYOUT_STORAGE_KEY, CUSTOM_PRESETS_STORAGE_KEY,
  BUILTIN_MODES_STORAGE_KEY, genPresetId, nextPresetName, BuiltinModes,
} from './JoystickOverlay';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { AudioListenerRow } from './AudioListenerRow';
import { SessionHostQr } from './SessionHostQr';
import { DialogCard } from './DialogCard';
import { LinkApi } from '../vite-env';
import { useHostQrCode } from '../utils/qr';

const linkApi = (window as any).link as LinkApi;

interface JoystickTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
}

type DriverStatus = 'unknown' | 'ready' | 'missing' | 'error';
interface JoystickController { ip: string; name: string; padIndex: number; }

const JoystickTab: React.FC<JoystickTabProps> = ({ localIdentity, isMobile }) => {
  // Host state
  const [driverStatus, setDriverStatus] = useState<DriverStatus>('unknown');
  const [driverError, setDriverError] = useState<string | null>(null);
  const [checkingDriver, setCheckingDriver] = useState(false);
  const [controllers, setControllers] = useState<JoystickController[]>([]);
  const qrDataUrl = useHostQrCode(true, localIdentity, 1748);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; ip: string; name: string; pin: string }[]>([]);

  // Client (Controller) state
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectingPhase, setConnectingPhase] = useState<'connecting' | 'waiting-pin'>('connecting');
  const [pin, setPin] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [skin, setSkin] = useState<'xbox' | 'ps'>(loadJoystickSkinFromStorage);
  const [haptics, setHaptics] = useState<boolean>(loadJoystickHapticsFromStorage);
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>(loadCustomPresetsFromStorage);
  const [layout, setLayout] = useState<JoystickLayout>(loadJoystickLayoutFromStorage);
  const [builtinModes, setBuiltinModes] = useState<BuiltinModes>(loadJoystickBuiltinModesFromStorage);

  const setAndPersistSkin = (v: 'xbox' | 'ps') => {
    setSkin(v);
    try { localStorage.setItem(SKIN_STORAGE_KEY, v); } catch {}
  };

  const setAndPersistHaptics = (v: boolean) => {
    setHaptics(v);
    try { localStorage.setItem(HAPTICS_STORAGE_KEY, v ? 'on' : 'off'); } catch {}
  };

  const setAndPersistLayout = (v: JoystickLayout) => {
    setLayout(v);
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, v); } catch {}
  };

  const setAndPersistCustomPresets = (v: CustomPreset[]) => {
    setCustomPresets(v);
    try { localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(v)); } catch {}
  };

  const setAndPersistBuiltinModes = (v: BuiltinModes) => {
    setBuiltinModes(v);
    try { localStorage.setItem(BUILTIN_MODES_STORAGE_KEY, JSON.stringify(v)); } catch {}
  };

  const resolvedLayout = isBuiltinLayout(layout) || customPresets.some((p) => p.id === layout)
    ? layout : 'classic';

  const activePresetForModes = customPresets.find((p) => p.id === resolvedLayout);
  const activeModes: ActiveModes = isBuiltinLayout(resolvedLayout)
    ? builtinModes[resolvedLayout]
    : (activePresetForModes?.modes || DEFAULT_ACTIVE_MODES);

  const setActiveModes = (patch: Partial<ActiveModes>) => {
    if (isBuiltinLayout(resolvedLayout)) {
      setAndPersistBuiltinModes({ ...builtinModes, [resolvedLayout]: { ...builtinModes[resolvedLayout], ...patch } });
    } else {
      updatePreset(resolvedLayout, { modes: { ...activeModes, ...patch } });
    }
  };

  const createPresetFromActive = () => {
    const base = customPresets.find((p) => p.id === resolvedLayout);
    const newPreset: CustomPreset = base
      ? { ...base, id: genPresetId(), name: nextPresetName(base.name, customPresets), positions: { ...base.positions } }
      : {
          id: genPresetId(),
          name: nextPresetName(resolvedLayout === 'driving' ? 'Driving' : 'Classic', customPresets),
          dpadMode: 'combined', faceMode: 'combined',
          modes: { ...activeModes },
          positions: resolvedLayout === 'classic' ? DEFAULT_CUSTOM_LAYOUT : DEFAULT_DRIVING_LAYOUT,
        };
    setAndPersistCustomPresets([...customPresets, newPreset]);
    setAndPersistLayout(newPreset.id);
  };

  const deletePreset = (id: string) => {
    setAndPersistCustomPresets(customPresets.filter((p) => p.id !== id));
    if (resolvedLayout === id) setAndPersistLayout('classic');
  };

  const renamePreset = (id: string, name: string) => {
    setAndPersistCustomPresets(customPresets.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  const updatePreset = (id: string, patch: Partial<CustomPreset>) => {
    setAndPersistCustomPresets(customPresets.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const refreshStatus = async () => {
    if (!linkApi) return;
    try {
      const status = await linkApi.getJoystickStatus?.();
      setDriverStatus(status?.driverStatus || 'unknown');
      setDriverError(status?.driverError || null);
      const connected = status?.connectedControllers || [];
      setControllers(connected);
      setPendingGuests((prev) => prev.filter((pg) => !connected.some((c: any) => c.ip === pg.ip)));
    } catch {}
  };

  const verifyDriver = async () => {
    if (!linkApi) return;
    setCheckingDriver(true);
    try {
      const status = await linkApi.checkJoystickDriver?.();
      setDriverStatus(status?.driverStatus || 'unknown');
      setDriverError(status?.driverError || null);
    } catch {
      // Driver check error handled by state
    } finally {
      setCheckingDriver(false);
    }
  };

  useEffect(() => {
    if (!linkApi) return;

    if (!isMobile) {
      verifyDriver();
      refreshStatus();
    }

    const unsubStatus = !isMobile ? linkApi.onJoystickDriverStatus?.((status: DriverStatus, error: string | null) => {
      setDriverStatus(status);
      setDriverError(error);
    }) : undefined;
    
    const unsubRoster = !isMobile ? linkApi.onJoystickRosterChanged?.(() => refreshStatus()) : undefined;
    
    const unsubGuest = !isMobile ? linkApi.onJoystickGuestPinPending?.((connId: string, pinCode: string, remoteAddress: string, name: string) => {
      setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, ip: remoteAddress, name, pin: pinCode }]);
    }) : undefined;

    const unsubPinReq = linkApi.onJoystickPinRequired?.((computedPin: string) => {
      setPin(computedPin);
      setConnectingPhase('waiting-pin');
    });

    const unsubHelloAck = linkApi.onJoystickHelloAck?.((ok: boolean, _padIndex: number | null, error: string | null) => {
      setConnecting(false);
      setPin(null);
      setConnectingPhase('connecting');
      if (!ok) {
        setConnectError(
          error === 'slots_full' ? 'That host already has 4 controllers connected.'
          : error === 'driver_missing' ? "That host doesn't have the Joystick driver installed."
          : error === 'rejected by host' || error === 'blocked' ? 'Rejected by host'
          : error === 'kicked' ? 'Removed by host'
          : 'Failed to connect — try again.'
        );
        setActiveHost(null);
      }
    });

    return () => {
      unsubStatus?.();
      unsubRoster?.();
      unsubGuest?.();
      unsubPinReq?.();
      unsubHelloAck?.();
    };
  }, [isMobile]);

  const handleDecodedHost = (host: string) => {
    setShowScannerModal(false);
    setJoinIpInput(host);
    connect(host);
  };

  const connect = (host: string) => {
    const target = host.trim();
    if (!target) return;
    setConnectError(null);
    setConnecting(true);
    setPin(null);
    setConnectingPhase('connecting');
    setActiveHost(target);
    linkApi?.sendJoystickHello?.(target, localIdentity?.deviceName || 'Player');
  };

  const disconnect = () => {
    if (activeHost) linkApi?.sendJoystickBye?.(activeHost);
    setActiveHost(null);
    setConnecting(false);
    setPin(null);
    setConnectingPhase('connecting');
  };

  const handleDisconnected = useCallback((reason: string) => {
    setActiveHost(null);
    setConnecting(false);
    setConnectError(
      reason === 'kicked' ? 'Removed by host'
      : reason === 'blocked' ? 'Rejected by host'
      : reason === 'host_error' ? "The host's controller driver stopped working."
      : reason === 'connection_lost' || reason === 'timeout' ? 'Lost connection to the host.'
      : 'Disconnected from the host.'
    );
  }, []);

  if (activeHost && !connecting) {
    return (
      <JoystickOverlay
        host={activeHost}
        skin={skin}
        onSkinChange={setAndPersistSkin}
        haptics={haptics}
        onHapticsChange={setAndPersistHaptics}
        layout={resolvedLayout}
        onLayoutChange={setAndPersistLayout}
        modes={activeModes}
        onModesChange={setActiveModes}
        customPresets={customPresets}
        onCreatePreset={createPresetFromActive}
        onDeletePreset={deletePreset}
        onRenamePreset={renamePreset}
        onUpdatePreset={updatePreset}
        onClose={disconnect}
        onDisconnected={handleDisconnected}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '8px 0' }}>
      {(driverStatus === 'missing' || driverStatus === 'error') && (
        <div style={{
          background: 'rgba(224, 92, 92, 0.1)', border: '1px solid rgba(224, 92, 92, 0.3)',
          borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: '#e05c5c', fontSize: '13px' }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            {isMobile ? 'Gamepad Permissions Required' : 'Virtual Controller Driver Missing'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.5 }}>
            {isMobile ? (
              driverError === 'shizuku_not_running'
                ? 'Shizuku is not running. Please start Shizuku (via Wireless Debugging or Root) to enable native virtual gamepad input for Android games and emulators.'
                : 'Shizuku permission is required to inject gamepad buttons and analog sticks.'
            ) : (
              <>
                Joystick emulates an Xbox controller using ViGEmBus, a free virtual gamepad driver for Windows.
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
            {isMobile ? (
              <button
                onClick={() => linkApi.requestShizukuPermission?.()}
                style={{ padding: '6px 12px', fontSize: '11.5px', background: 'var(--accent-color, #007acc)', color: 'var(--btn-primary-text)', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              >
                Grant via Shizuku
              </button>
            ) : (
              <a
                href="https://github.com/ViGEm/ViGEmBus/releases"
                target="_blank"
                rel="noopener noreferrer"
                className="button"
                style={{ padding: '6px 12px', fontSize: '11.5px', background: 'var(--accent-color, #007acc)', color: 'var(--btn-primary-text)', textDecoration: 'none', borderRadius: '4px', textAlign: 'center' }}
              >
                Download ViGEmBus (Free)
              </a>
            )}
            <button onClick={verifyDriver} disabled={checkingDriver} style={{ padding: '6px 12px', fontSize: '11.5px' }}>
              {checkingDriver ? 'Verifying...' : 'Verify Status'}
            </button>
          </div>
        </div>
      )}

      {/* Desktop View: Host QR & Connected Controllers */}
      {!isMobile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }}>
          <SessionHostQr
            qrDataUrl={qrDataUrl}
            ipAddress={localIdentity?.ipAddress}
            altText="Joystick Host QR"
            subtitle="Scan with your phone to use it as a gamepad"
          />

          <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '2px 0' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '13px' }}>
              Connected Controllers ({controllers.length}/4)
            </div>

            {controllers.length === 0 ? (
              <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>
                Waiting for controllers to connect...
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {controllers.map((c) => (
                  <AudioListenerRow
                    key={c.ip}
                    label={`Pad ${c.padIndex + 1} — ${c.name}`}
                    statusText="Connected"
                    icon={
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'scale(0.95)' }}>
                        <line x1="6" y1="12" x2="10" y2="12" /><line x1="8" y1="10" x2="8" y2="14" />
                        <circle cx="15" cy="13" r="1" /><circle cx="18" cy="11" r="1" />
                        <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.152A4 4 0 0 0 17.32 5z" />
                      </svg>
                    }
                    onKick={() => linkApi?.kickJoystickController?.(c.ip)}
                    onBlock={() => linkApi?.blockJoystickController?.(c.ip, c.name)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mobile View: Connect Gamepad to Desktop */}
      {isMobile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
            Enter your computer's IP address or scan its QR code to use this device as a gamepad.
          </div>

          <IpScanField
            value={joinIpInput}
            onChange={setJoinIpInput}
            onScanClick={() => setShowScannerModal(true)}
            onEnter={() => connect(joinIpInput)}
            placeholder="Computer IP address (e.g. 192.168.1.100)"
          />

          {connectError && (
            <div style={{ color: '#e05c5c', fontSize: '12.5px' }}>
              {connectError}
            </div>
          )}

          <PrimaryButton
            onClick={() => connect(joinIpInput)}
            disabled={!joinIpInput.trim()}
          >
            Connect Gamepad
          </PrimaryButton>
        </div>
      )}

      {connecting && (
        <DialogCard onCancel={disconnect} zIndex={2000}>
          <ConnectingCard
            targetLabel={activeHost || joinIpInput}
            phase={connectingPhase}
            pin={pin}
            onCancel={disconnect}
            waitingLabel="Connecting to gamepad host..."
          />
        </DialogCard>
      )}

      <ScannerModal
        open={showScannerModal}
        onClose={() => setShowScannerModal(false)}
        onDecoded={handleDecodedHost}
        title="Scan Joystick Host QR"
      />

      <PendingGuestsModal
        title="Joystick Request"
        iconType="joystick"
        guests={pendingGuests.map((g) => ({
          connId: g.connId,
          pin: g.pin,
          remoteAddress: g.ip,
          deviceName: g.name,
        }))}
        subtitle="wants to use a controller"
        onAccept={(connId) => {
          linkApi.acceptJoystickGuest?.(connId);
          setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
        }}
        onReject={(connId) => {
          linkApi.rejectJoystickGuest?.(connId);
          setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
        }}
        onBlock={(connId) => {
          linkApi.blockJoystickGuest?.(connId);
          setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
        }}
      />
    </div>
  );
};

export default JoystickTab;
