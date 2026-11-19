import React, { useEffect, useRef, useState } from 'react';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal , PrimaryButton } from './ModalDialog';
import { SessionHostQr } from './SessionHostQr';
import { AudioListenerRow, HostFooterBar } from './AudioListenerRow';
import { LinkApi } from '../vite-env';
import { useHostQrCode } from '../utils/qr';
import { AUDIO_SINK_PORT } from '../utils/ports';

const linkApi = (window as any).link as LinkApi;

import { mapCloseReasonToError, handleListenerSessionEnd } from '../utils/audio';
import { PeerDevice, upsertPairedSession, removePairedSession } from '../types/peer';

interface AudioSinkTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[] };
  isMobile: boolean;
}

interface ListenerInfo {
  id: string;
  label: string;
}

interface PairedSession {
  deviceId: string;
  deviceName: string;
  token: string;
  host: string;
}

type ListenerPhase = 'idle' | 'connecting' | 'waiting-pin' | 'listening' | 'rejected';

const AudioSinkTab: React.FC<AudioSinkTabProps> = ({ peers, localIdentity, isMobile }) => {
  // Host state
  const [hosting, setHosting] = useState(false);
  const [listeners, setListeners] = useState<ListenerInfo[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostMuted, setHostMuted] = useState(false);
  const [outputDevices, setOutputDevices] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [isDeviceDropdownOpen, setIsDeviceDropdownOpen] = useState(false);

  // Listener state
  const [joinIpInput, setJoinIpInput] = useState('');
  const [listenerPhase, setListenerPhase] = useState<ListenerPhase>('idle');
  const [pin, setPin] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  // Playback telemetry (latency, buffer, underruns); only the Android listener reports it.
  const [stats, setStats] = useState<{ latencyMs: number; bufferMs: number; underruns: number; dropped: number; clockSynced: boolean } | null>(null);
  // Shown inline on the connect page: failed joins, rejections and removals.
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [activeHostLabel, setActiveHostLabel] = useState<string | null>(null);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; pin: string; remoteAddress: string; deviceName?: string }[]>([]);

  // Sessions hosted by paired devices that this device has not joined.
  const [pairedSessions, setPairedSessions] = useState<Map<string, PairedSession>>(new Map());

  const qrDataUrl = useHostQrCode(hosting, localIdentity, AUDIO_SINK_PORT);

  const [showScannerModal, setShowScannerModal] = useState(false);

  // Read by the onAudioSinkError handler, which is registered once and would otherwise see the
  // value from mount.
  const hostingRef = useRef(hosting);
  useEffect(() => { hostingRef.current = hosting; }, [hosting]);

  // ScannerModal captures onDecoded when it opens and calls it later, and a session token can
  // arrive in between, so the latest map is read through a ref.
  const pairedSessionsRef = useRef(pairedSessions);
  useEffect(() => { pairedSessionsRef.current = pairedSessions; }, [pairedSessions]);

  const handleDecodedHost = (host: string) => {
    setShowScannerModal(false);
    joinByAddress(host);
  };

  useEffect(() => {
    if (!linkApi) return;

    const unsubJoined = linkApi.onAudioSinkListenerJoined?.((id: string, label: string) => {
      setListeners((prev) => [...prev.filter((l) => l.id !== id), { id, label }]);
      setPendingGuests((prev) => prev.filter((g) => g.connId !== id));
    });
    const unsubLeft = linkApi.onAudioSinkListenerLeft?.((id: string) => {
      setListeners((prev) => prev.filter((l) => l.id !== id));
      setPendingGuests((prev) => prev.filter((g) => g.connId !== id));
    });
    const unsubGuestPin = linkApi.onAudioSinkGuestPinPending?.((connId: string, guestPin: string, remoteAddress: string, deviceName?: string) => {
      setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, pin: guestPin, remoteAddress, deviceName }]);
    });
    const unsubPinComputed = linkApi.onAudioSinkPinComputed?.((computedPin: string) => {
      setPin(computedPin);
      setListenerPhase('waiting-pin');
    });
    const unsubError = linkApi.onAudioSinkError?.((message: string) => {
      // One event serves both host and listener; they are mutually exclusive in the UI, so
      // `hosting` decides which panel shows the error.
      if (hostingRef.current) {
        setHostError(message);
      } else {
        setListenerError(message);
      }
    });

    const unsubStarted = linkApi.onAudioSinkPairedSessionStarted?.((deviceId: string, token: string, host: string) => {
      upsertPairedSession(setPairedSessions, peers, deviceId, token, host);
    });
    const unsubEnded = linkApi.onAudioSinkPairedSessionEnded?.((deviceId: string) => {
      removePairedSession(setPairedSessions, deviceId);
    });

    const unsubStats = linkApi.onAudioSinkStats?.((s) => setStats(s));

    const unsubAdmitted = linkApi.onAudioSinkAdmitted?.((hostLabel: string) => {
      if (hostLabel) setActiveHostLabel(hostLabel);
      setListenerPhase('listening');
    });
    const unsubHostEnded = linkApi.onAudioSinkEnded?.((reason?: string) => {
      handleListenerSessionEnd(reason, setListenerPhase, setActiveHostLabel, setPin, setListenerError);
    });
    const unsubClosed = linkApi.onAudioSinkClosed?.((reason: string) => {
      // Returns to the connect page with an inline reason, e.g. a host rejecting the join. On
      // Android a kick also arrives here (LinkAudioSinkClient does not split close codes), so the
      // reason is mapped the same way as in onAudioSinkEnded.
      setListenerPhase('idle');
      setListenerError(mapCloseReasonToError(reason));
      setPin(null);
    });

    // Restores an active session when the tab reopens. Promise.resolve() is needed because `?.()`
    // can yield undefined, and calling .then() on it would throw inside the effect.
    Promise.resolve(linkApi.getAudioSinkStatus?.()).then((status: any) => {
      if (status?.hosting) {
        setHosting(true);
        if (status.listeners) setListeners(status.listeners);
      } else if (status?.listening) {
        setListenerPhase('listening');
        if (status.hostLabel) setActiveHostLabel(status.hostLabel);
      }
    }).catch(() => {});

    linkApi.queryAudioSinkSessions?.();
    if (!isMobile && linkApi?.getAudioSinkDevices) {
      linkApi.getAudioSinkDevices().then((devs) => {
        if (Array.isArray(devs)) setOutputDevices(devs);
      }).catch(() => {});
    }

    const unsubDisconnect = linkApi.onDeviceDisconnected?.((deviceId: string) => {
      removePairedSession(setPairedSessions, deviceId);
    });

    return () => {
      unsubJoined?.();
      unsubLeft?.();
      unsubGuestPin?.();
      unsubPinComputed?.();
      unsubError?.();
      unsubDisconnect?.();
      unsubStarted?.();
      unsubEnded?.();
      unsubStats?.();
      unsubHostEnded?.();
      unsubClosed?.();
      unsubAdmitted?.();
    };
  }, []);

  useEffect(() => {
    // `?.()` does not guard the property read on an undefined linkApi, and a throw here would
    // unmount the whole tree (there is no error boundary).
    if (!linkApi) return;
    // Both platforms play natively: LinkAudioSinkClient.setVolume() on Android, the WASAPI
    // player on Windows (which also keeps the level for later sessions).
    linkApi.setAudioSinkListenerVolume?.(volume);
  }, [volume]);




  const [starting, setStarting] = useState(false);
  const startHosting = async () => {
    if (starting) return;
    setStarting(true);
    setHostError(null);
    try {
      const result = await linkApi.startAudioSink(selectedDeviceId || undefined);
      if (result?.started) {
        setHosting(true);
      } else {
        setHostError(result?.error || 'Failed to start');
      }
    } finally {
      setStarting(false);
    }
  };

  const endHosting = async () => {
    await linkApi.endAudioSink();
    setHosting(false);
    setListeners([]);
    setPendingGuests([]);
    setHostMuted(false);
  };

  const toggleHostMute = () => {
    const next = !hostMuted;
    setHostMuted(next);
    linkApi.setAudioSinkMuted?.(next);
  };

  const joinAsGuest = (overrideHost?: string) => {
    const host = (overrideHost || joinIpInput).trim();
    if (!linkApi || !host) return;
    setListenerError(null);
    setListenerPhase('connecting');
    setPin(null);
    setActiveHostLabel(host);
    linkApi.joinAudioSinkGuest(host);
  };

  const joinPaired = (session: PairedSession) => {
    setListenerError(null);
    setListenerPhase('connecting');
    setActiveHostLabel(session.deviceName);
    linkApi.joinAudioSinkPaired(session.host, session.token, session.deviceName);
    // A paired join skips the PIN; 'admitted' fires once the host verifies the token.
    setPairedSessions((prev) => {
      const copy = new Map(prev);
      copy.delete(session.deviceId);
      return copy;
    });
  };

  // Joining by a typed IP or scanned QR. Pairing is already the trust decision, so an address that
  // belongs to a paired host with a session token uses the token; unknown hosts get the PIN flow.
  const joinByAddress = (rawHost: string) => {
    // A QR can carry several addresses for the same machine, and only some may be routable.
    const candidates = rawHost.split(',').map((s) => s.trim()).filter(Boolean);
    if (candidates.length === 0) return;

    const paired = Array.from(pairedSessionsRef.current.values()).find((s) => candidates.includes(s.host));
    if (paired) {
      setJoinIpInput(paired.host);
      joinPaired(paired);
      return;
    }

    setJoinIpInput(candidates[0]);
    joinAsGuest(rawHost);
  };

  const leaveListening = async () => {
    await linkApi.leaveAudioSink();
    setListenerPhase('idle');
    setActiveHostLabel(null);
    setPin(null);
    // Re-query sessions so the user can join again straight away.
    linkApi.queryAudioSinkSessions?.();
  };

  const renderDeviceIcon = (deviceType?: string) => {
    const type = deviceType?.toLowerCase() || 'phone';
    if (type === 'tablet') {
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
          <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
      );
    }
    if (type === 'laptop' || type === 'desktop' || type === 'pc' || type === 'computer') {
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      );
    }
    if (type === 'tv') {
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="10" y1="21" x2="14" y2="21" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </svg>
    );
  };

  const getListenerDeviceType = (label: string) => {
    for (const peer of peers.values()) {
      if (peer.name === label) return peer.deviceType;
    }
    return 'phone';
  };

  // Join and host sections are both shown while idle, separated by a divider.
  const showDivider = !hosting && listenerPhase === 'idle';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', padding: '4px' }}>
      {!hosting && (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {listenerPhase === 'idle' && (
            <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Join a Session</div>
          )}

          {listenerPhase === 'idle' && pairedSessions.size > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {Array.from(pairedSessions.values()).map((s) => (
                <div key={s.deviceId} className="peer-row" style={{ padding: '10px 12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>{s.deviceName} has an audio session</span>
                  <button onClick={() => joinPaired(s)} style={{ padding: '5px 14px', fontSize: '11.5px' }}>
                    Join
                  </button>
                </div>
              ))}
            </div>
          )}

          {listenerPhase === 'idle' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                Enter the host's IP address or scan their QR code to listen in.
              </div>
              <IpScanField
                value={joinIpInput}
                onChange={setJoinIpInput}
                onScanClick={() => setShowScannerModal(true)}
                onEnter={() => joinByAddress(joinIpInput)}
                placeholder="Host's IP address"
              />
              <PrimaryButton onClick={() => joinByAddress(joinIpInput)} disabled={!joinIpInput}>Connect</PrimaryButton>
            </div>
          )}

          {(listenerPhase === 'connecting' || listenerPhase === 'waiting-pin') && (
            <ConnectingCard
              targetLabel={activeHostLabel || ''}
              phase={listenerPhase}
              pin={pin}
              onCancel={leaveListening}
              waitingLabel="Connecting..."
            />
          )}

          {listenerPhase === 'listening' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981', flexShrink: 0 }} />
                  <div style={{ fontWeight: 600, fontSize: '15px', overflowWrap: 'anywhere' }}>Receiving audio from {activeHostLabel}</div>
                </div>
                <button
                  onClick={leaveListening}
                  style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: '12px', cursor: 'pointer', flexShrink: 0 }}
                >
                  Disconnect
                </button>
              </div>

              {stats && (
                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '11.5px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                  <span
                    title={stats.clockSynced
                      ? "Capture to arrival — everything on the host side (capture buffering, Opus encoding, pacing) plus the network hop, with the two devices' clock difference measured and subtracted. Add the buffer figure for the total you actually hear."
                      : 'The host is not answering clock-sync probes — most likely it has not been rebuilt. This figure still includes the gap between the two device clocks, so it is not a real latency (it can even be negative).'}
                    style={stats.clockSynced ? undefined : { color: '#e0a05c' }}
                  >
                    Pipeline {stats.latencyMs} ms{stats.clockSynced ? '' : ' (unsynced)'}
                  </span>
                  <span title="Playback buffer depth on this device — added latency that is fully under our control.">
                    Buffer {stats.bufferMs} ms
                  </span>
                  <span
                    title="The playback buffer ran dry. Climbing means it is too shallow for how audio is arriving — raise the buffer."
                    style={stats.underruns > 0 ? { color: '#e0a05c' } : undefined}
                  >
                    Underruns {stats.underruns}
                  </span>
                  <span
                    title="Audio discarded because the playback queue was full — the writer could not keep up. The opposite of an underrun, and needs the opposite fix."
                    style={stats.dropped > 0 ? { color: '#e0a05c' } : undefined}
                  >
                    Dropped {stats.dropped}
                  </span>
                </div>
              )}

              {!isMobile && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Volume</span>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent-color)' }}
                  />
                  <span style={{ fontSize: '12px', width: '30px' }}>{Math.round(volume * 100)}%</span>
                </div>
              )}
            </div>
          )}

          {listenerError && listenerPhase !== 'listening' && (
            <div style={{ color: '#e05c5c', fontSize: '12.5px' }}>{listenerError}</div>
          )}
        </div>
      )}

      {showDivider && <div style={{ height: '1px', background: 'var(--border-color)', width: '100%' }} />}

      {listenerPhase === 'idle' && (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {!hosting ? (
            <>
              <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Host a Session</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                Streams this device's system audio to anyone who joins — a friend via IP, or any
                already-paired device with one tap.
              </div>
              {isMobile && (
                <div style={{ color: 'var(--text-muted)', fontSize: '11px', fontStyle: 'italic', lineHeight: '1.4' }}>
                  Android will ask you to confirm a system capture permission every time you start
                  a session. Apps like Spotify, Netflix, and YouTube block their audio from being
                  captured this way — local video files, games, and most other apps work fine.
                </div>
              )}
              <PrimaryButton onClick={startHosting} disabled={starting}>{starting ? 'Starting...' : 'Start Session'}</PrimaryButton>
              {hostError && <div style={{ color: '#e05c5c', fontSize: '12.5px' }}>{hostError}</div>}
            </>
          ) : (
            <>
              <SessionHostQr
                qrDataUrl={qrDataUrl}
                ipAddress={localIdentity.ipAddress}
                altText="Audio Relay QR Code"
                subtitle="Scan this QR code from the listening device."
              />

              {!isMobile && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', position: 'relative', width: '100%' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>
                    Capture Output Device
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsDeviceDropdownOpen(!isDeviceDropdownOpen)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--input-bg, rgba(255, 255, 255, 0.05))',
                      color: 'var(--text-color)',
                      fontSize: '13px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      outline: 'none',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px' }}>
                      {outputDevices.find((d) => d.id === selectedDeviceId)?.name
                        ? `${outputDevices.find((d) => d.id === selectedDeviceId)!.name}${outputDevices.find((d) => d.id === selectedDeviceId)!.isDefault ? ' (Default)' : ''}`
                        : 'Default Playback Device'}
                    </span>
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      stroke="currentColor"
                      strokeWidth="2"
                      fill="none"
                      style={{
                        transform: isDeviceDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s ease',
                        flexShrink: 0,
                        color: 'var(--text-muted)',
                      }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {isDeviceDropdownOpen && (
                    <>
                      <div
                        onClick={() => setIsDeviceDropdownOpen(false)}
                        style={{
                          position: 'fixed',
                          top: 0,
                          left: 0,
                          right: 0,
                          bottom: 0,
                          zIndex: 999,
                        }}
                      />
                      <div
                        style={{
                          position: 'absolute',
                          top: '100%',
                          left: 0,
                          right: 0,
                          marginTop: '6px',
                          background: 'var(--dropdown-bg, #141418)',
                          backgroundColor: '#141418',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '8px',
                          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.85), 0 4px 10px rgba(0, 0, 0, 0.5)',
                          zIndex: 1000,
                          maxHeight: '200px',
                          overflowY: 'auto',
                          padding: '4px 0',
                        }}
                        className="custom-scrollbar"
                      >
                        <div
                          onClick={() => {
                            setSelectedDeviceId('');
                            setIsDeviceDropdownOpen(false);
                            linkApi.switchAudioSinkDevice?.(undefined);
                          }}
                          style={{
                            padding: '8px 14px',
                            fontSize: '13px',
                            cursor: 'pointer',
                            color: !selectedDeviceId ? 'var(--accent-color)' : 'var(--text-color)',
                            background: !selectedDeviceId ? 'rgba(0, 155, 213, 0.08)' : 'transparent',
                            transition: 'background 0.15s ease',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.background = !selectedDeviceId ? 'rgba(0, 155, 213, 0.08)' : 'transparent')
                          }
                        >
                          <span>Default Playback Device</span>
                          {!selectedDeviceId && (
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </div>
                        {outputDevices.map((dev) => {
                          const isSelected = selectedDeviceId === dev.id;
                          return (
                            <div
                              key={dev.id}
                              onClick={() => {
                                setSelectedDeviceId(dev.id);
                                setIsDeviceDropdownOpen(false);
                                linkApi.switchAudioSinkDevice?.(dev.id);
                              }}
                              style={{
                                padding: '8px 14px',
                                fontSize: '13px',
                                cursor: 'pointer',
                                color: isSelected ? 'var(--accent-color)' : 'var(--text-color)',
                                background: isSelected ? 'rgba(0, 155, 213, 0.08)' : 'transparent',
                                transition: 'background 0.15s ease',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '8px',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                              onMouseLeave={(e) =>
                                (e.currentTarget.style.background = isSelected ? 'rgba(0, 155, 213, 0.08)' : 'transparent')
                              }
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {dev.name} {dev.isDefault ? '(Default)' : ''}
                              </span>
                              {isSelected && (
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}

              <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '8px 0' }} />

              <PendingGuestsModal
                guests={pendingGuests}
                title="Audio Relay Request"
                iconType="audio"
                subtitle="wants to listen to your audio"
                onAccept={(connId) => {
                  linkApi.acceptAudioSinkGuest?.(connId);
                  setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
                }}
                onReject={(connId) => {
                  linkApi.rejectAudioSinkGuest?.(connId);
                  setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
                }}
                onBlock={(connId) => {
                  linkApi.blockAudioSinkGuest?.(connId);
                  setPendingGuests((prev) => prev.filter((pg) => pg.connId !== connId));
                }}
              />

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '13px' }}>
                  Active Listeners ({listeners.length})
                </div>

                {listeners.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px' }}>
                    No listeners connected yet.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      maxHeight: '260px',
                      overflowY: 'auto',
                      paddingRight: '4px',
                    }}
                    className="custom-scrollbar"
                  >
                    {listeners.map((l) => (
                      <AudioListenerRow
                        key={l.id}
                        label={l.label}
                        icon={renderDeviceIcon(getListenerDeviceType(l.label))}
                        onKick={() => linkApi.kickAudioSinkListener?.(l.id)}
                        onBlock={() => linkApi.blockAudioSinkListener?.(l.id)}
                      />
                    ))}
                  </div>
                )}

                {hostError && <div style={{ color: '#e05c5c', fontSize: '12px' }}>{hostError}</div>}
              </div>

              <HostFooterBar
                muted={hostMuted}
                onToggleMute={toggleHostMute}
                onLeave={endHosting}
              />
            </>
          )}
        </div>
      )}

      <ScannerModal
        open={showScannerModal}
        onClose={() => setShowScannerModal(false)}
        onDecoded={handleDecodedHost}
        title="Scan Session QR Code"
      />
    </div>
  );
};

export default AudioSinkTab;
