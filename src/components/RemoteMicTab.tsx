import React, { useEffect, useState, useRef } from 'react';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { AudioListenerRow, HostActionButtons } from './AudioListenerRow';
import { CustomSelect } from './CustomSelect';
import { LinkApi } from '../vite-env';
import { useHostQrCode } from '../utils/qr';

const linkApi = (window as any).link as LinkApi;

import { AudioFormat, PcmPlayer, mapCloseReasonToError, handleListenerSessionEnd } from '../utils/audio';
import { PeerDevice, PairedSession, upsertPairedSession, removePairedSession } from '../types/peer';

interface RemoteMicTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[] };
  isMobile: boolean;
}

const RemoteMicTab: React.FC<RemoteMicTabProps> = ({ peers, localIdentity, isMobile }) => {
  const [driverInstalled, setDriverInstalled] = useState<boolean | null>(null);
  const [checkingDriver, setCheckingDriver] = useState<boolean>(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedSink, setSelectedSink] = useState<string>('');
  // The event-listener effect below registers its callbacks once (deps: [isMobile]) and never
  // re-runs when selectedSink changes later — so onRemoteMicAdmitted's closure would otherwise be
  // permanently frozen on whatever selectedSink was at mount (the initial '', since device
  // detection resolves asynchronously afterward). A ref stays live across renders without needing
  // the effect to re-run, so reading selectedSinkRef.current at the moment a session is admitted
  // always reflects the user's actual current dropdown selection.
  const selectedSinkRef = useRef(selectedSink);
  useEffect(() => { selectedSinkRef.current = selectedSink; }, [selectedSink]);

  // Host state (Transmitter / Microphone source)
  const [hosting, setHosting] = useState(false);
  const [listeners, setListeners] = useState<{ id: string; label: string }[]>([]);
  const [pendingGuests, setPendingGuests] = useState<any[]>([]);
  const qrDataUrl = useHostQrCode(hosting, localIdentity, 1720);

  const [hostError, setHostError] = useState<string | null>(null);
  const [hostMuted, setHostMuted] = useState(false);

  // Listener state (Receiver / Output to Virtual Cable or Speaker)
  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [listenerPhase, setListenerPhase] = useState<'idle' | 'connecting' | 'waiting-pin' | 'listening'>('idle');

  const [volume, setVolume] = useState(1);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [activeHostLabel, setActiveHostLabel] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);

  // Already-paired devices hosting a Remote Mic session
  const [pairedSessions, setPairedSessions] = useState<Map<string, PairedSession>>(new Map());

  const formatRef = useRef<AudioFormat | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);

  const checkDriverStatus = async () => {
    if (isMobile) {
      setDriverInstalled(true);
      return;
    }
    
    setCheckingDriver(true);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
      setMicDevices(audioOutputs);
      const isVirtualCable = (label: string) => {
        const lower = label.toLowerCase();
        return lower.includes('cable input') || lower.includes('vb-audio') || lower.includes('voicemeeter') || lower.includes('vb-cable');
      };
      const virtualDevice = audioOutputs.find((d) => isVirtualCable(d.label));
      if (virtualDevice) {
        setSelectedSink(virtualDevice.deviceId);
      } else if (audioOutputs.length > 0) {
        setSelectedSink(audioOutputs[0].deviceId);
      }
      setDriverInstalled(!!virtualDevice);
    } catch (e) {
      console.error('Failed to check audio devices:', e);
      setDriverInstalled(false);
    } finally {
      setCheckingDriver(false);
    }
  };

  useEffect(() => {
    checkDriverStatus();
    if (!linkApi) return;


    linkApi.onRemoteMicGuestPinPending?.((connId: string, pin: string, remoteAddress: string, deviceName?: string) => {
      setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, pin, remoteAddress, deviceName }]);
    });
    linkApi.onRemoteMicListenerJoined?.((connId: string, label: string) => {
      setListeners((prev) => [...prev.filter((l) => l.id !== connId), { id: connId, label }]);
      setPendingGuests((prev) => prev.filter((g) => g.remoteAddress !== label && g.connId !== connId));
    });
    linkApi.onRemoteMicListenerLeft?.((connId: string) => {
      setListeners((prev) => prev.filter((l) => l.id !== connId));
    });
    linkApi.onRemoteMicError?.((message: string) => {
      setHostError(message);
      setListenerError(message);
    });

    linkApi.onRemoteMicPairedSessionStarted?.((deviceId: string, token: string, host: string) => {
      upsertPairedSession(setPairedSessions, peers, deviceId, token, host);
    });
    linkApi.onRemoteMicPairedSessionEnded?.((deviceId: string) => {
      removePairedSession(setPairedSessions, deviceId);
    });

    linkApi.onRemoteMicPinComputed?.((computedPin: string) => {
      setPin(computedPin);
      setListenerPhase('waiting-pin');
    });
    linkApi.onRemoteMicAdmitted?.(() => {
      setListenerPhase('listening');
      setPin(null);
      if (!isMobile) {
        playerRef.current = new PcmPlayer(selectedSinkRef.current);
        playerRef.current.setVolume(volume);
      }
    });
    linkApi.onRemoteMicFormat?.((format: AudioFormat) => {
      formatRef.current = format;
    });
    linkApi.onRemoteMicAudioChunk?.((pcm: Uint8Array) => {
      if (playerRef.current && formatRef.current) {
        playerRef.current.enqueue(pcm, formatRef.current);
      }
    });
    linkApi.onRemoteMicEnded?.((reason?: string) => {
      handleListenerSessionEnd(reason, setListenerPhase, setActiveHostLabel, setPin, setListenerError, playerRef);
    });
    linkApi.onRemoteMicClosed?.((reason: string) => {
      // Unconditional 'idle' (not just when 'listening') — matches Audio Sink's onAudioSinkClosed.
      // This also covers a host REJECTING the join/PIN request while still on the connecting/
      // waiting-pin screen: previously the phase only reset when it was 'listening', so a reject
      // during waiting-pin left the ConnectingCard (PIN box, "Connecting to X...") stuck on screen
      // underneath the "Rejected by host" line instead of returning to the plain connect screen.
      setListenerPhase('idle');
      setListenerError(mapCloseReasonToError(reason));
      setPin(null);
      playerRef.current?.close();
      playerRef.current = null;
    });

    // Wrapped in Promise.resolve() rather than chaining .then() straight onto the optional call —
    // `?.()` only guards the CALL itself; if getRemoteMicStatus doesn't exist at all (it was
    // missing from the mobile bridge until this fix), the expression evaluates to plain
    // `undefined`, and `undefined.then(...)` throws synchronously right here in the effect, with
    // no error boundary above it — the exact failure mode that silently blanks the whole tab.
    // Promise.resolve(undefined) just resolves to undefined harmlessly either way.
    Promise.resolve(linkApi.getRemoteMicStatus?.()).then((status: any) => {
      if (status?.hosting) {
        setHosting(true);
        if (status.listeners) setListeners(status.listeners);
      } else if (status?.streaming) {
        setListenerPhase('listening');
      }
    }).catch(() => {});

    const unsubDisconnect = linkApi.onDeviceDisconnected?.((deviceId: string) => {
      removePairedSession(setPairedSessions, deviceId);
    });

    linkApi.queryRemoteMicSessions?.();
    return () => {
      unsubDisconnect?.();
      playerRef.current?.close();
      playerRef.current = null;
    };
  }, [isMobile]);

  useEffect(() => {
    if (!linkApi) return;
    playerRef.current?.setVolume(volume);
  }, [volume]);



  const startHosting = async () => {
    if (!linkApi) return;
    setHostError(null);
    const result = await linkApi.startRemoteMic?.();
    if (result?.started) {
      setHosting(true);
    } else {
      setHostError(result?.error || 'Failed to start microphone host');
    }
  };

  const endHosting = async () => {
    if (!linkApi) return;
    await linkApi.endRemoteMic?.();
    setHosting(false);
    setListeners([]);
    setPendingGuests([]);
    setHostMuted(false);
  };

  const toggleHostMute = () => {
    const next = !hostMuted;
    setHostMuted(next);
    linkApi?.setRemoteMicMuted?.(next);
  };

  const joinAsGuest = (overrideHost?: string) => {
    const host = (overrideHost || joinIpInput).trim();
    if (!host) return;
    setListenerError(null);
    setListenerPhase('connecting');
    setActiveHostLabel(host);
    setPin(null);
    linkApi?.joinRemoteMicGuest?.(host);
  };

  const handleDecodedHost = (rawText: string) => {
    let host = rawText.trim();
    if (host.startsWith('link:')) {
      const parts = host.split(':');
      if (parts.length >= 2) host = parts[1];
    }
    setJoinIpInput(host);
    setShowScannerModal(false);
    joinAsGuest(host);
  };

  const joinPaired = (session: PairedSession) => {
    setListenerError(null);
    setListenerPhase('connecting');
    setActiveHostLabel(session.deviceName);
    setPin(null);
    linkApi?.joinRemoteMicPaired?.(session.host, session.token);
    setPairedSessions((prev) => {
      const copy = new Map(prev);
      copy.delete(session.deviceId);
      return copy;
    });
  };

  const leaveListening = async () => {
    await linkApi?.leaveRemoteMic?.();
    setListenerPhase('idle');
    setActiveHostLabel(null);
    setPin(null);
    playerRef.current?.close();
    playerRef.current = null;
    linkApi?.queryRemoteMicSessions?.();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', padding: '4px' }}>
        {/* PC-listen only, by design — a phone can't do anything useful with a received mic
            stream (no system-wide "virtual microphone" API for other apps to pick it up), so
            listening was never wired end-to-end on Android and is not offered here. */}
        {!isMobile && !hosting && (
          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {listenerPhase === 'idle' && pairedSessions.size > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {Array.from(pairedSessions.values()).map((s) => (
                  <div key={s.deviceId} className="peer-row" style={{ padding: '10px 12px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>
                      {s.deviceName} is broadcasting microphone
                    </span>
                    <button onClick={() => joinPaired(s)} style={{ padding: '5px 14px', fontSize: '11.5px' }}>
                      Join Stream
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!isMobile && driverInstalled === false && (
              <div style={{
                background: 'rgba(224, 92, 92, 0.1)',
                border: '1px solid rgba(224, 92, 92, 0.3)',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                marginBottom: '14px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: '#e05c5c', fontSize: '13px' }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  Virtual Audio Driver Missing
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.5 }}>
                  To expose your phone's microphone to Zoom, Discord, or browser calls, Windows requires a virtual audio device.
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
                  <a
                    href="https://vb-audio.com/Cable/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="button"
                    style={{
                      padding: '6px 12px',
                      fontSize: '11.5px',
                      background: 'var(--accent-color, #007acc)',
                      color: 'var(--btn-primary-text)',
                      textDecoration: 'none',
                      borderRadius: '4px',
                      textAlign: 'center'
                    }}
                  >
                    Download VB-CABLE (Free)
                  </a>
                  <button
                    onClick={checkDriverStatus}
                    disabled={checkingDriver}
                    style={{ padding: '6px 12px', fontSize: '11.5px' }}
                  >
                    {checkingDriver ? 'Verifying...' : 'Verify Installation'}
                  </button>
                </div>
              </div>
            )}

            {!isMobile && (
              <div style={{ marginBottom: '14px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                  OUTPUT TARGET DEVICE
                </label>
                <CustomSelect
                  value={selectedSink}
                  onChange={(val) => setSelectedSink(val)}
                  options={micDevices.map((d) => ({
                    value: d.deviceId,
                    label: d.label || `Audio Output Device (${d.deviceId.slice(0, 5)}...)`,
                  }))}
                  style={{ width: '100%' }}
                />
              </div>
            )}

            {listenerPhase === 'idle' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                  Enter the phone's IP address to receive its microphone as audio input.
                </div>
                <IpScanField
                  value={joinIpInput}
                  onChange={setJoinIpInput}
                  onScanClick={() => setShowScannerModal(true)}
                  onEnter={() => joinAsGuest()}
                  placeholder="Microphone Host's IP address"
                />
                <PrimaryButton onClick={() => joinAsGuest()} disabled={!joinIpInput}>
                  Connect
                </PrimaryButton>
              </div>
            )}
            {(listenerPhase === 'connecting' || listenerPhase === 'waiting-pin') && (
              <ConnectingCard
                targetLabel={activeHostLabel || ''}
                phase={listenerPhase}
                pin={pin}
                onCancel={leaveListening}
              />
            )}
            {listenerPhase === 'listening' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
                  <div style={{ fontWeight: 600, fontSize: '15px', overflowWrap: 'anywhere' }}>
                    Receiving mic from {activeHostLabel}
                  </div>
                  <button
                    onClick={leaveListening}
                    style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: '12px', cursor: 'pointer', flexShrink: 0 }}
                  >
                    Disconnect
                  </button>
                </div>
                <div className="flex-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    style={{ flex: '1 1 120px', minWidth: 0, accentColor: 'var(--accent-color)' }}
                  />
                </div>
              </div>
            )}
            {listenerError && listenerPhase !== 'listening' && (
              <div style={{ color: '#e05c5c', fontSize: '12.5px' }}>{listenerError}</div>
            )}
          </div>
        )}

        {/* Mobile-host / PC-listen only: a PC's mic streamed to a phone can only ever be played
            back through the phone's speaker, never picked up by other apps as a real system
            microphone (unlike a PC listener, which can route it into a virtual audio cable) — so
            PC-as-host has no genuine use and is intentionally not offered here. */}
        {isMobile && listenerPhase === 'idle' && (
          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {!hosting ? (
              <>
                <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Host Microphone</div>
                <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                  Streams this device's microphone audio to anyone who joins — a friend via IP, or any already-paired device with one tap.
                </div>
                <PrimaryButton onClick={startHosting}>Start Session</PrimaryButton>
                {hostError && <div style={{ color: '#e05c5c', fontSize: '12.5px' }}>{hostError}</div>}
              </>
            ) : (
              <>
                {/* Stacked Layout: QR Code centered on top, IP below, no unwanted text/headers */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
                  {qrDataUrl ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                      <div style={{ background: '#fff', padding: '8px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                        <img src={qrDataUrl} alt="Remote Mic QR Code" style={{ display: 'block', width: '140px', height: '140px', imageRendering: 'pixelated' }} />
                      </div>
                      <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-color)' }}>
                        {localIdentity.ipAddress || 'unknown'}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
                        Scan this QR code from the receiving device.
                      </div>
                    </div>
                  ) : (
                    <div style={{ width: '140px', height: '140px', background: 'rgba(0,0,0,0.05)', borderRadius: '8px' }} />
                  )}
                </div>

                <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '8px 0' }} />

                <PendingGuestsModal
                  guests={pendingGuests}
                  title="Remote Mic Request"
                  iconType="mic"
                  subtitle="wants to receive your microphone"
                  onAccept={(connId) => {
                    linkApi?.acceptRemoteMicGuest?.(connId);
                    setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
                  }}
                  onReject={(connId) => {
                    linkApi?.rejectRemoteMicGuest?.(connId);
                    setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
                  }}
                  onBlock={(connId) => {
                    linkApi?.blockRemoteMicGuest?.(connId);
                    setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
                  }}
                />

                {listeners.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                    {listeners.map((l) => (
                      <AudioListenerRow
                        key={l.id}
                        label={l.label}
                        iconBg="rgba(0, 155, 213, 0.1)"
                        iconColor="#009bd5"
                        icon={
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                          </svg>
                        }
                        onKick={() => linkApi?.kickRemoteMicListener?.(l.id)}
                        onBlock={() => linkApi?.blockRemoteMicListener?.(l.id)}
                      />
                    ))}
                  </div>
                )}

                {hostError && <div style={{ color: '#e05c5c', fontSize: '12px' }}>{hostError}</div>}

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
                  <HostActionButtons
                    muted={hostMuted}
                    onToggleMute={toggleHostMute}
                    onLeave={endHosting}
                  />
                </div>
              </>
            )}
          </div>
        )}

      <ScannerModal
        open={showScannerModal}
        onClose={() => setShowScannerModal(false)}
        onDecoded={handleDecodedHost}
        title="Scan Microphone Host QR"
      />
    </div>
  );
};

export default RemoteMicTab;

