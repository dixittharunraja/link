import React, { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import JoystickOverlay, {
  DEFAULT_CUSTOM_LAYOUT, DEFAULT_DRIVING_LAYOUT, normalizeCustomPositions, normalizeCustomPreset,
  normalizeActiveModes, isBuiltinLayout, JoystickLayout, CustomPreset, ActiveModes, DEFAULT_ACTIVE_MODES, TriggerMode,
} from './JoystickOverlay';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestCard } from './ModalDialog';

const linkApi = (window as any).link;

interface JoystickTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; deviceType?: string };
  isMobile: boolean;
}

type DriverStatus = 'unknown' | 'ready' | 'missing' | 'error';
interface JoystickController { ip: string; name: string; padIndex: number; }

const SKIN_STORAGE_KEY = 'link-joystick-skin';
const HAPTICS_STORAGE_KEY = 'link-joystick-haptics';
const LAYOUT_STORAGE_KEY = 'link-joystick-layout';
// Superseded by CUSTOM_PRESETS_STORAGE_KEY (a preset LIST, not one slot) — kept read-only, as a
// one-time migration source for anyone who had a Custom layout saved by the older build.
const LEGACY_CUSTOM_LAYOUT_STORAGE_KEY = 'link-joystick-custom-layout';
const LEGACY_TRIGGER_MODE_STORAGE_KEY = 'link-joystick-trigger-mode';
const CUSTOM_PRESETS_STORAGE_KEY = 'link-joystick-custom-presets';
const LEGACY_CUSTOM_PRESET_ID = 'legacy-custom';
// LT/RT tap/pull and LS stick/steer now apply to WHICHEVER layout is active, including the fixed
// Classic/Driving built-ins — since those aren't CustomPreset objects, they need their own small
// persisted record rather than living inside a preset (see resolveActiveModes below).
const BUILTIN_MODES_STORAGE_KEY = 'link-joystick-builtin-modes';

const genPresetId = () => `preset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** "Custom", "Custom 2", "Custom 3", ... — or "<Name> copy" when duplicating an existing preset
 *  (baseName already has a real name in that case, not the generic "Custom"). */
function nextPresetName(baseName: string, existing: CustomPreset[]): string {
  const label = baseName === 'Classic' || baseName === 'Driving' ? 'Custom' : `${baseName} copy`;
  if (!existing.some((p) => p.name === label)) return label;
  let n = 2;
  while (existing.some((p) => p.name === `${label} ${n}`)) n++;
  return `${label} ${n}`;
}

interface BuiltinModes {
  classic: ActiveModes;
  driving: ActiveModes;
}
const DEFAULT_BUILTIN_MODES: BuiltinModes = {
  classic: { ...DEFAULT_ACTIVE_MODES },
  driving: { ...DEFAULT_ACTIVE_MODES, ltMode: 'pull', rtMode: 'pull' },
};
function normalizeBuiltinModes(stored: unknown): BuiltinModes {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, any>;
  return {
    classic: raw.classic ? normalizeActiveModes(raw.classic) : DEFAULT_BUILTIN_MODES.classic,
    driving: raw.driving ? normalizeActiveModes(raw.driving) : DEFAULT_BUILTIN_MODES.driving,
  };
}

const JoystickTab: React.FC<JoystickTabProps> = ({ localIdentity, isMobile }) => {
  const isController = isMobile && localIdentity.deviceType !== 'tv';

  // ----- Desktop (host) state -----
  const [driverStatus, setDriverStatus] = useState<DriverStatus>('unknown');
  const [driverError, setDriverError] = useState<string | null>(null);
  const [checkingDriver, setCheckingDriver] = useState(false);
  const [controllers, setControllers] = useState<JoystickController[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // ----- Phone (controller) state -----
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectingPhase, setConnectingPhase] = useState<'connecting' | 'waiting-pin'>('connecting');
  const [pin, setPin] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; ip: string; name: string; pin: string }[]>([]);
  const [skin, setSkin] = useState<'xbox' | 'ps'>(() => {
    try { return (localStorage.getItem(SKIN_STORAGE_KEY) as 'xbox' | 'ps') || 'xbox'; } catch { return 'xbox'; }
  });
  const [haptics, setHaptics] = useState<boolean>(() => {
    try { return localStorage.getItem(HAPTICS_STORAGE_KEY) !== 'off'; } catch { return true; }
  });
  // Run through normalizeCustomPreset rather than used raw, so presets stored by an older build
  // (missing a control, a mode field, or using the pre-free-resize single-`scale` shape) still
  // yield a complete, correctly-shaped set instead of crashing on an undefined placement. If no
  // preset list exists yet, fall back to migrating the old single-slot Custom layout (if any) into
  // a one-item list, rather than silently discarding it.
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>(() => {
    try {
      const stored = localStorage.getItem(CUSTOM_PRESETS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed.map((p, i) => normalizeCustomPreset(p, genPresetId() + i));
      }
    } catch {}
    try {
      const legacyRaw = localStorage.getItem(LEGACY_CUSTOM_LAYOUT_STORAGE_KEY);
      if (legacyRaw) {
        const legacyTriggerMode = (localStorage.getItem(LEGACY_TRIGGER_MODE_STORAGE_KEY) as TriggerMode) || 'tap';
        return [{
          id: LEGACY_CUSTOM_PRESET_ID, name: 'Custom',
          dpadMode: 'combined', faceMode: 'combined',
          modes: { ...DEFAULT_ACTIVE_MODES, ltMode: legacyTriggerMode, rtMode: legacyTriggerMode },
          positions: normalizeCustomPositions(JSON.parse(legacyRaw)),
        }];
      }
    } catch {}
    return [];
  });

  const [layout, setLayout] = useState<JoystickLayout>(() => {
    try {
      const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (stored === 'custom') return LEGACY_CUSTOM_PRESET_ID; // old single-slot 'custom' sentinel
      if (stored) return stored;
    } catch {}
    return 'classic';
  });

  // Classic/Driving's own LT/RT + LS mode choice — see BUILTIN_MODES_STORAGE_KEY's doc comment.
  const [builtinModes, setBuiltinModes] = useState<BuiltinModes>(() => {
    try {
      const stored = localStorage.getItem(BUILTIN_MODES_STORAGE_KEY);
      return stored ? normalizeBuiltinModes(JSON.parse(stored)) : DEFAULT_BUILTIN_MODES;
    } catch { return DEFAULT_BUILTIN_MODES; }
  });

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

      const ip = localIdentity?.ipAddress || '127.0.0.1';
      QRCode.toDataURL(`link:${ip}:1717`, { margin: 1, width: 160, color: { dark: '#000000', light: '#ffffff' } })
        .then(setQrDataUrl)
        .catch(() => {});
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
              <button
                onClick={() => connect(joinIpInput)}
                disabled={!joinIpInput}
                style={{
                  width: '100%',
                  padding: '10px',
                  borderRadius: '8px',
                  background: joinIpInput ? 'var(--accent-color, #007acc)' : 'var(--input-bg)',
                  color: joinIpInput ? 'var(--btn-primary-text)' : 'var(--text-muted)',
                  border: joinIpInput ? 'none' : '1px solid var(--border-color)',
                  fontWeight: 600,
                  cursor: joinIpInput ? 'pointer' : 'not-allowed',
                  boxSizing: 'border-box',
                }}
              >
                Connect
              </button>
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

      {pendingGuests.length > 0 && (
        // Separate popup, not a row stacked in with the QR/controllers panel — see AudioSinkTab's
        // identical fix for the full reasoning. Styled to match the Tools modal wrapper this sits
        // on top of (ToolsTab.tsx's own popup: var(--modal-bg)/var(--border-color)/
        // var(--modal-shadow), same backdrop blur), just at a higher zIndex (that wrapper is 1000).
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          }}
        >
          <div style={{ width: '100%', maxWidth: '380px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {pendingGuests.map((g) => (
              <div
                key={g.connId}
                style={{
                  backgroundColor: 'var(--modal-bg)', border: '1px solid var(--border-color)',
                  borderRadius: '16px', boxShadow: '0 20px 50px var(--modal-shadow)',
                }}
              >
                <PendingGuestCard
                  guest={{ connId: g.connId, pin: g.pin, remoteAddress: g.ip, deviceName: g.name }}
                  subtitle="wants to use a controller"
                  onAccept={() => {
                    linkApi.acceptJoystickGuest?.(g.connId);
                    setPendingGuests((prev) => prev.filter((pg) => pg.connId !== g.connId));
                  }}
                  onReject={() => {
                    linkApi.rejectJoystickGuest?.(g.connId);
                    setPendingGuests((prev) => prev.filter((pg) => pg.connId !== g.connId));
                  }}
                  onBlock={() => {
                    linkApi.blockJoystickGuest?.(g.connId);
                    setPendingGuests((prev) => prev.filter((pg) => pg.connId !== g.connId));
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

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
              <div
                key={c.ip}
                className="peer-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  padding: '10px 14px',
                  background: 'var(--input-bg)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: 'rgba(16, 185, 129, 0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#10b981',
                      flexShrink: 0,
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'scale(0.95)' }}>
                      <line x1="6" y1="12" x2="10" y2="12" /><line x1="8" y1="10" x2="8" y2="14" />
                      <circle cx="15" cy="13" r="1" /><circle cx="18" cy="11" r="1" />
                      <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.152A4 4 0 0 0 17.32 5z" />
                    </svg>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere' }}>
                      Pad {c.padIndex + 1} — {c.name}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Connected</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button
                    onClick={() => linkApi?.kickJoystickController?.(c.ip)}
                    style={{ padding: '5px 12px', fontSize: '11.5px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
                  >
                    Kick
                  </button>
                  <button
                    onClick={() => linkApi?.blockJoystickController?.(c.ip, c.name)}
                    style={{ padding: '5px 12px', fontSize: '11.5px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
                  >
                    Block
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default JoystickTab;
