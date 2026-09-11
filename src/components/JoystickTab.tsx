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
import { LinkApi } from '../vite-env';
import { useHostQrCode } from '../utils/qr';

const linkApi = (window as any).link as LinkApi;

interface JoystickTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; deviceType?: string };
  isMobile: boolean;
}

type DriverStatus = 'unknown' | 'ready' | 'missing' | 'error';
interface JoystickController { ip: string; name: string; padIndex: number; }

const JoystickTab: React.FC<JoystickTabProps> = ({ localIdentity, isMobile }) => {
  const isController = isMobile && localIdentity.deviceType !== 'tv';

  // ----- Desktop (host) state -----
  const [driverStatus, setDriverStatus] = useState<DriverStatus>('unknown');
  const [driverError, setDriverError] = useState<string | null>(null);
  const [checkingDriver, setCheckingDriver] = useState(false);
  const [controllers, setControllers] = useState<JoystickController[]>([]);
  const qrDataUrl = useHostQrCode(!isController, localIdentity, 1717);

  // ----- Phone (controller) state -----
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectingPhase, setConnectingPhase] = useState<'connecting' | 'waiting-pin'>('connecting');
  const [pin, setPin] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; ip: string; name: string; pin: string }[]>([]);
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

  // A stored active-layout id can point at a preset that's since been deleted (or a stale legacy
  // migration id) — fall back to Classic rather than handing JoystickOverlay a dangling reference.
  const resolvedLayout = isBuiltinLayout(layout) || customPresets.some((p) => p.id === layout)
    ? layout : 'classic';

  // Wherever the active layout's LT/RT/LS modes + sensitivities actually live — a customPresets[]
  // entry's .modes, or the small per-built-in record above — resolved once here so the rest of
  // the component (and JoystickOverlay) can treat "the active layout's modes" as one uniform thing.
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

  // Passive — just reads whatever's cached (roster + last-known driver status). Cheap, safe to
  // call on every roster change; does NOT itself trigger a driver probe (see verifyDriver below).
  const refreshStatus = async () => {
    if (isController || !linkApi) return;
    const status = await linkApi.getJoystickStatus?.();
    setDriverStatus(status?.driverStatus || 'unknown');
    setDriverError(status?.driverError || null);
    const connected = status?.connectedControllers || [];
    setControllers(connected);
    setPendingGuests((prev) => prev.filter((pg) => !connected.some((c: any) => c.ip === pg.ip)));
  };

  // Active — actually spawns/probes the helper. getJoystickStatus alone would stay 'unknown'
  // forever on a fresh app start until a phone happens to connect first, since that's the only
  // other thing that triggers the probe on the main-process side.
  const verifyDriver = async () => {
    if (isController || !linkApi) return;
    setCheckingDriver(true);
    try {
      const status = await linkApi.checkJoystickDriver?.();
      setDriverStatus(status?.driverStatus || 'unknown');
      setDriverError(status?.driverError || null);
    } finally {
      setCheckingDriver(false);
    }
  };

  useEffect(() => {
    if (!linkApi) return;

    if (!isController) {
      verifyDriver();
      refreshStatus();
      linkApi.onJoystickDriverStatus?.((status: DriverStatus, error: string | null) => {
        setDriverStatus(status);
        setDriverError(error);
      });
      linkApi.onJoystickRosterChanged?.(() => refreshStatus());
      linkApi.onJoystickGuestPinPending?.((connId: string, pin: string, remoteAddress: string, name: string) => {
        setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, ip: remoteAddress, name, pin }]);
      });

      return;
    }

    linkApi.onJoystickPinRequired?.((computedPin: string) => {
      setPin(computedPin);
      setConnectingPhase('waiting-pin');
    });

    linkApi.onJoystickHelloAck?.((ok: boolean, _padIndex: number | null, error: string | null) => {
      setConnecting(false);
      setPin(null);
      setConnectingPhase('connecting');
      if (!ok) {
        // 'blocked' reads the same as a plain reject — it should never reveal that it was
        // specifically blocked, just that it was turned away.
        setConnectError(error === 'slots_full' ? 'That PC already has 4 controllers connected.'
          : error === 'driver_missing' ? "That PC doesn't have the Joystick driver installed."
          : error === 'rejected by host' || error === 'blocked' ? 'Rejected by host'
          : error === 'kicked' ? 'Removed by host'
          : 'Failed to connect — try again.');
        setActiveHost(null);
      }
    });
  }, [isController]);


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

  // Session ended without the user tapping Exit — see JoystickOverlay's onDisconnected doc
  // comment. No "bye" send here: the host either already knows (kicked/blocked/its own driver
  // crashed) or is unreachable (connection_lost), so there's nothing productive to tell it.
  //
  // useCallback (with only setState setters inside, all of which React guarantees are stable)
  // keeps this identity-stable across renders. JoystickOverlay guards against a churning
  // callback on its own side too, but this stops the churn at the source — ToolsTab's 2s status
  // poll re-renders this component constantly, which would otherwise hand the overlay a brand
  // new function every couple of seconds.
  const handleDisconnected = useCallback((reason: string) => {
    setActiveHost(null);
    setConnecting(false);
    setConnectError(
      // 'blocked' reads the same as a plain reject — see onJoystickHelloAck's comment.
      reason === 'kicked' ? 'Removed by host'
      : reason === 'blocked' ? 'Rejected by host'
      : reason === 'host_error' ? "The host's controller driver stopped working."
      : reason === 'connection_lost' || reason === 'timeout' ? 'Lost connection to the PC.'
      : 'Disconnected from the PC.'
    );
  }, []);

  if (isController && activeHost && !connecting) {
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

  if (isController) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', padding: '4px' }}>
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {connecting ? (
            <ConnectingCard
              targetLabel={activeHost || ''}
              phase={connectingPhase}
              pin={pin}
              onCancel={disconnect}
              waitingLabel="Connecting..."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                Scan the QR code shown on the PC's Joystick tab, or enter its IP address.
              </div>
              <IpScanField
                value={joinIpInput}
                onChange={setJoinIpInput}
                onEnter={() => connect(joinIpInput)}
                onScanClick={() => setShowScannerModal(true)}
                placeholder="PC's IP address"
              />
              <PrimaryButton onClick={() => connect(joinIpInput)} disabled={!joinIpInput}>
                Connect
              </PrimaryButton>
              {connectError && <div style={{ color: '#e05c5c', fontSize: '12.5px', marginTop: '4px' }}>{connectError}</div>}
            </div>
          )}
        </div>

        <ScannerModal open={showScannerModal} onClose={() => setShowScannerModal(false)} onDecoded={handleDecodedHost} title="Scan PC's Joystick QR" />
      </div>
    );
  }

  // ----- Desktop host view -----
  return (
    <div style={{ padding: '4px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

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
            Virtual Controller Driver Missing
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.5 }}>
            Joystick emulates an Xbox controller using ViGEmBus, a free virtual gamepad driver for Windows.
            {driverError === 'helper_not_bundled' && ' (The Joystick driver helper isn’t bundled in this build yet.)'}
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
            <a
              href="https://github.com/ViGEm/ViGEmBus/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="button"
              style={{ padding: '6px 12px', fontSize: '11.5px', background: 'var(--accent-color, #007acc)', color: 'var(--btn-primary-text)', textDecoration: 'none', borderRadius: '4px', textAlign: 'center' }}
            >
              Download ViGEmBus (Free)
            </a>
            <button onClick={verifyDriver} disabled={checkingDriver} style={{ padding: '6px 12px', fontSize: '11.5px' }}>
              {checkingDriver ? 'Verifying...' : 'Verify Installation'}
            </button>
          </div>
        </div>
      )}

      {/* Stacked Layout: QR Code centered on top, Controllers list below */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
        {qrDataUrl ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            <div style={{ background: '#fff', padding: '8px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
              <img src={qrDataUrl} alt="Joystick QR Code" style={{ display: 'block', width: '140px', height: '140px', imageRendering: 'pixelated' }} />
            </div>
            <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-color)' }}>
              {localIdentity.ipAddress || 'unknown'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
              Scan from a friend's phone's Joystick tab to connect, up to 4 at once.
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Generating QR code…</div>
        )}
      </div>

      <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '8px 0' }} />

      <PendingGuestsModal
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
        <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '13px' }}>
          Connected Controllers ({controllers.length}/4)
        </div>
        {controllers.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px' }}>
            No controllers connected yet.
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
  );
};

export default JoystickTab;
