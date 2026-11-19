import React, { useEffect, useState } from 'react';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { AudioListenerRow, HostActionButtons } from './AudioListenerRow';
import { CustomSelect } from './CustomSelect';
import { LinkApi } from '../vite-env';
import { useHostQrCode } from '../utils/qr';
import { REMOTE_MIC_PORT } from '../utils/ports';
import { collectSubscriptions } from '../utils/subscriptions';

const linkApi = (window as any).link as LinkApi;

// Must stay within the allowlist in open_external (src-tauri/src/commands.rs).
const VB_CABLE_URL = 'https://vb-audio.com/Cable/';

import { mapCloseReasonToError, handleListenerSessionEnd } from '../utils/audio';
import { PeerDevice, PairedSession, upsertPairedSession, removePairedSession } from '../types/peer';

interface RemoteMicTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[] };
  isMobile: boolean;
}

const RemoteMicTab: React.FC<RemoteMicTabProps> = ({ peers, localIdentity, isMobile }) => {
  const [driverInstalled, setDriverInstalled] = useState<boolean | null>(null);
  const [checkingDriver, setCheckingDriver] = useState<boolean>(false);
  // Playback endpoints by their Windows ids; the desktop plays the received mic natively.
  const [micDevices, setMicDevices] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [selectedSink, setSelectedSink] = useState<string>('');
  useEffect(() => {
    // Applies to a running session straight away, and to the next one. Nothing is chosen until the
    // device list has loaded, and a running session keeps its output until then.
    if (!isMobile && selectedSink) linkApi?.setRemoteMicOutputDevice?.(selectedSink);
  }, [selectedSink, isMobile]);

  // Host state (sends this device's microphone)
  const [hosting, setHosting] = useState(false);
  const [listeners, setListeners] = useState<{ id: string; label: string }[]>([]);
  const [pendingGuests, setPendingGuests] = useState<any[]>([]);
  const qrDataUrl = useHostQrCode(hosting, localIdentity, REMOTE_MIC_PORT);

  const [hostError, setHostError] = useState<string | null>(null);
  const [hostMuted, setHostMuted] = useState(false);

  // Listener state (plays to a virtual cable or speaker)
  const [joinIpInput, setJoinIpInput] = useState('');
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [listenerPhase, setListenerPhase] = useState<'idle' | 'connecting' | 'waiting-pin' | 'listening'>('idle');

  const [volume, setVolume] = useState(1);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [activeHostLabel, setActiveHostLabel] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);

  // Paired devices currently hosting a Remote Mic session.
  const [pairedSessions, setPairedSessions] = useState<Map<string, PairedSession>>(new Map());

  const checkDriverStatus = async () => {
    if (isMobile) {
      setDriverInstalled(true);
      return;
    }
    
    setCheckingDriver(true);
    try {
      const audioOutputs = (await linkApi?.getAudioOutputDevices?.()) || [];
      setMicDevices(audioOutputs);
      const isVirtualCable = (label: string) => {
        const lower = label.toLowerCase();
        return lower.includes('cable input') || lower.includes('vb-audio') || lower.includes('voicemeeter') || lower.includes('vb-cable');
      };
      const virtualDevice = audioOutputs.find((d) => isVirtualCable(d.name));
      if (virtualDevice) {
        setSelectedSink(virtualDevice.id);
      } else if (audioOutputs.length > 0) {
        setSelectedSink((audioOutputs.find((d) => d.isDefault) || audioOutputs[0]).id);
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
    const [events, unsubscribeAll] = collectSubscriptions(linkApi);

    events.onRemoteMicGuestPinPending?.((connId: string, pin: string, remoteAddress: string, deviceName?: string) => {
      setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, pin, remoteAddress, deviceName }]);
    });
    events.onRemoteMicListenerJoined?.((connId: string, label: string) => {
      setListeners((prev) => [...prev.filter((l) => l.id !== connId), { id: connId, label }]);
      setPendingGuests((prev) => prev.filter((g) => g.remoteAddress !== label && g.connId !== connId));
    });
    events.onRemoteMicListenerLeft?.((connId: string) => {
      setListeners((prev) => prev.filter((l) => l.id !== connId));
    });
    events.onRemoteMicError?.((message: string) => {
      setHostError(message);
      setListenerError(message);
    });

    events.onRemoteMicPairedSessionStarted?.((deviceId: string, token: string, host: string) => {
      upsertPairedSession(setPairedSessions, peers, deviceId, token, host);
    });
    events.onRemoteMicPairedSessionEnded?.((deviceId: string) => {
      removePairedSession(setPairedSessions, deviceId);
    });

    events.onRemoteMicPinComputed?.((computedPin: string) => {
      setPin(computedPin);
      setListenerPhase('waiting-pin');
    });
    events.onRemoteMicAdmitted?.(() => {
      setListenerPhase('listening');
      setPin(null);
    });
    events.onRemoteMicEnded?.((reason?: string) => {
      handleListenerSessionEnd(reason, setListenerPhase, setActiveHostLabel, setPin, setListenerError);
    });
    events.onRemoteMicClosed?.((reason: string) => {
      // Always back to idle, including a rejection while connecting or waiting for the PIN, so the
      // connect screen shows the reason instead of a stuck connecting card.
      setListenerPhase('idle');
      setListenerError(mapCloseReasonToError(reason));
      setPin(null);
    });

    // Restores an active session. Promise.resolve() is needed because `?.()` can yield undefined,
    // and calling .then() on it would throw inside the effect.
    Promise.resolve(linkApi.getRemoteMicStatus?.()).then((status: any) => {
      if (status?.hosting) {
        setHosting(true);
        if (status.listeners) setListeners(status.listeners);
      } else if (status?.streaming) {
        setListenerPhase('listening');
      }
    }).catch(() => {});

    events.onDeviceDisconnected?.((deviceId: string) => {
      removePairedSession(setPairedSessions, deviceId);
    });

    linkApi.queryRemoteMicSessions?.();
    return () => {
      unsubscribeAll();
    };
  }, [isMobile]);

  useEffect(() => {
    if (!linkApi || isMobile) return;
    linkApi.setRemoteMicVolume?.(volume);
  }, [volume, isMobile]);



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
    linkApi?.queryRemoteMicSessions?.();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', padding: '4px' }}>
        {/* Listening is desktop-only: Android has no system-wide virtual microphone for other
            apps to use a received stream. */}
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
                  <button
                    // The WebView ignores target="_blank" links; the system browser opens it.
                    onClick={() => { linkApi.openExternal?.(VB_CABLE_URL)?.catch(() => {}); }}
                    style={{
                      padding: '6px 12px',
                      fontSize: '11.5px',
                      background: 'var(--accent-color, #007acc)',
                      color: 'var(--btn-primary-text)',
                      borderRadius: '4px',
                    }}
                  >
                    Download VB-CABLE (Free)
                  </button>
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
                    value: d.id,
                    label: d.isDefault ? `${d.name} (Default)` : d.name,
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
                    // Above 1 boosts a quiet phone mic (the native player applies the gain); too much will distort.
                    max={3}
                    step={0.05}
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

        {/* Hosting is phone-only: a PC's mic sent to a phone could only play through its
            speaker, while a PC listener can route a phone's mic into a virtual audio cable. */}
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
                {/* QR code above, addresses below */}
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

                {listeners.length === 0 && pendingGuests.length === 0 && (
                  <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
                    Waiting for device to connect...
                  </div>
                )}

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

