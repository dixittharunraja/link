import React, { useEffect, useState, useRef } from 'react';

const linkApi = (window as any).link;

interface PeerDevice {
  deviceId: string;
  name: string;
  connected?: boolean;
  trusted: boolean;
}

interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
}

interface PairedSession {
  deviceId: string;
  deviceName: string;
  token: string;
  host: string;
}

interface RemoteMicTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string };
  isMobile: boolean;
}

// ----- PCM -> Web Audio playback helpers -----
function bytesToFloat32(bytes: Uint8Array, format: AudioFormat): Float32Array {
  const bytesPerSample = format.bitsPerSample / 8;
  const sampleCount = Math.floor(bytes.length / bytesPerSample);
  const out = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (format.isFloat && format.bitsPerSample === 32) {
    for (let i = 0; i < sampleCount; i++) out[i] = view.getFloat32(i * 4, true);
  } else if (format.bitsPerSample === 16) {
    for (let i = 0; i < sampleCount; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  } else if (format.bitsPerSample === 32) {
    for (let i = 0; i < sampleCount; i++) out[i] = view.getInt32(i * 4, true) / 2147483648;
  } else {
    for (let i = 0; i < sampleCount; i++) out[i] = (bytes[i] - 128) / 128;
  }
  return out;
}

class PcmPlayer {
  private ctx: AudioContext;
  private gainNode: GainNode;
  private nextStartTime = 0;

  constructor(sinkId?: string) {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(this.ctx.destination);

    // sinkId is NOT a real AudioContextOptions constructor field — that was silently ignored
    // (unrecognized dictionary members don't throw, they just do nothing), which is exactly why
    // output always stayed on the system default device regardless of what was selected in the
    // UI. The actual Web Audio Output Devices API is this instance method, called after
    // construction, which is what's needed to genuinely redirect this context's output — e.g. to
    // a virtual audio cable so other apps can pick up the phone's mic as their input.
    if (sinkId && typeof (this.ctx as any).setSinkId === 'function') {
      (this.ctx as any).setSinkId(sinkId).catch((e: any) => {
        console.error('[RemoteMic] Failed to set audio output device:', e);
      });
    }
  }

  setVolume(v: number) {
    this.gainNode.gain.value = v;
  }

  enqueue(pcm: Uint8Array, format: AudioFormat) {
    const interleaved = bytesToFloat32(pcm, format);
    const frameCount = Math.floor(interleaved.length / format.channels);
    if (frameCount === 0) return;

    const buffer = this.ctx.createBuffer(format.channels, frameCount, format.sampleRate);
    for (let c = 0; c < format.channels; c++) {
      const channelData = buffer.getChannelData(c);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = interleaved[i * format.channels + c];
      }
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);

    const now = this.ctx.currentTime;
    const TARGET_BUFFER_S = 0.005;
    const MAX_BUFFER_S = 0.25;
    if (this.nextStartTime < now + TARGET_BUFFER_S / 2 || this.nextStartTime - now > MAX_BUFFER_S) {
      this.nextStartTime = now + TARGET_BUFFER_S;
    }
    const startAt = this.nextStartTime;
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  close() {
    this.ctx.close().catch(() => {});
  }
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
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; pin: string; remoteAddress: string }[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostMuted, setHostMuted] = useState(false);

  // Listener state (Receiver / Output to Virtual Cable or Speaker)
  const [joinIpInput, setJoinIpInput] = useState('');
  const [listenerPhase, setListenerPhase] = useState<'idle' | 'connecting' | 'waiting-pin' | 'listening' | 'rejected' | 'error'>('idle');
  const [pin, setPin] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [activeHostLabel, setActiveHostLabel] = useState<string | null>(null);

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
      const hasVirtualCable = audioOutputs.some(
        (d) =>
          d.label.toLowerCase().includes('cable input') ||
          d.label.toLowerCase().includes('vb-audio') ||
          d.label.toLowerCase().includes('voicemeeter') ||
          d.label.toLowerCase().includes('vb-cable')
      );
      const virtualDevice = audioOutputs.find(
        (d) =>
          d.label.toLowerCase().includes('cable input') ||
          d.label.toLowerCase().includes('vb-audio') ||
          d.label.toLowerCase().includes('voicemeeter') ||
          d.label.toLowerCase().includes('vb-cable')
      );
      if (virtualDevice) {
        setSelectedSink(virtualDevice.deviceId);
      } else if (audioOutputs.length > 0) {
        setSelectedSink(audioOutputs[0].deviceId);
      }
      setDriverInstalled(hasVirtualCable);
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

    linkApi.onRemoteMicGuestPinPending?.((connId: string, guestPin: string, remoteAddress: string) => {
      setPendingGuests((prev) => [...prev, { connId, pin: guestPin, remoteAddress }]);
    });
    linkApi.onRemoteMicListenerJoined?.((connId: string, label: string) => {
      setListeners((prev) => [...prev.filter((l) => l.id !== connId), { id: connId, label }]);
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
    });
    linkApi.onRemoteMicListenerLeft?.((connId: string) => {
      setListeners((prev) => prev.filter((l) => l.id !== connId));
    });
    linkApi.onRemoteMicError?.((message: string) => {
      setHostError(message);
      setListenerError(message);
    });

    linkApi.onRemoteMicPairedSessionStarted?.((deviceId: string, token: string, host: string) => {
      const peerName = peers.get(deviceId)?.name || deviceId.slice(0, 8);
      setPairedSessions((prev) => {
        const copy = new Map(prev);
        copy.set(deviceId, { deviceId, deviceName: peerName, token, host });
        return copy;
      });
    });
    linkApi.onRemoteMicPairedSessionEnded?.((deviceId: string) => {
      setPairedSessions((prev) => {
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
    });

    linkApi.onRemoteMicPinComputed?.((computedPin: string) => {
      setPin(computedPin);
      setListenerPhase('waiting-pin');
    });
    linkApi.onRemoteMicAdmitted?.(() => {
      setListenerPhase('listening');
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
    linkApi.onRemoteMicEnded?.(() => {
      setListenerPhase('idle');
      setPin(null);
      setActiveHostLabel(null);
      playerRef.current?.close();
      playerRef.current = null;
    });
    linkApi.onRemoteMicClosed?.((reason: string) => {
      setListenerPhase((prev) => (prev === 'listening' || prev === 'waiting-pin' ? 'error' : prev));
      setListenerError(reason);
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

    linkApi.queryRemoteMicSessions?.();
    return () => {
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

  const joinAsGuest = () => {
    const host = joinIpInput.trim();
    if (!host) return;
    setListenerError(null);
    setListenerPhase('connecting');
    setActiveHostLabel(host);
    linkApi?.joinRemoteMicGuest?.(host);
  };

  const joinPaired = (session: PairedSession) => {
    setListenerError(null);
    setListenerPhase('connecting');
    setActiveHostLabel(session.deviceName);
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
    setPin(null);
    setActiveHostLabel(null);
    playerRef.current?.close();
    playerRef.current = null;
    linkApi?.queryRemoteMicSessions?.();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {!hosting && (
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Receive Remote Microphone</div>

            {listenerPhase === 'idle' && pairedSessions.size > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
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
                <div style={{ fontWeight: 600, color: '#e05c5c', fontSize: '13px' }}>
                  ⚠️ Virtual Audio Driver Missing
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
                      color: '#fff',
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
                <select
                  value={selectedSink}
                  onChange={(e) => setSelectedSink(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: 'var(--card-bg, #202020)',
                    color: 'var(--text-color, #fff)',
                    border: '1px solid var(--border-color, #333)',
                    fontSize: '13px'
                  }}
                >
                  {micDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Audio Output Device (${d.deviceId.slice(0, 5)}...)`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {listenerPhase === 'idle' && (
              <div className="flex-row" style={{ flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="Microphone Host's IP address"
                  value={joinIpInput}
                  onChange={(e) => setJoinIpInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') joinAsGuest(); }}
                  style={{ flex: '1 1 160px', minWidth: 0 }}
                />
                <button onClick={joinAsGuest}>Connect</button>
              </div>
            )}
            {listenerPhase === 'connecting' && (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Connecting to {activeHostLabel}...</div>
            )}
            {listenerPhase === 'waiting-pin' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '13px' }}>Waiting for the host to confirm this PIN matches theirs:</div>
                <div style={{ fontSize: '20px', fontWeight: 700, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{pin}</div>
              </div>
            )}
            {listenerPhase === 'listening' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere' }}>
                  Receiving microphone stream from {activeHostLabel}
                </div>
                <div className="flex-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    style={{ flex: '1 1 120px', minWidth: 0 }}
                  />
                </div>
                <button onClick={leaveListening} style={{ alignSelf: 'flex-start' }}>Disconnect</button>
              </div>
            )}
            {listenerPhase === 'rejected' && (
              <div style={{ color: '#e05c5c', fontSize: '12px' }}>The host declined your request to receive mic stream.</div>
            )}
            {listenerPhase === 'error' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ color: '#e05c5c', fontSize: '12px' }}>{listenerError || 'Connection lost'}</div>
                <button onClick={() => setListenerPhase('idle')} style={{ alignSelf: 'flex-start' }}>Dismiss</button>
              </div>
            )}
          </div>
        )}

        {listenerPhase === 'idle' && (
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Host Microphone</div>
            {!hosting ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '12.5px' }}>
                  Streams this device's microphone audio to anyone who joins — a friend via IP, or any already-paired device with one tap.
                </div>
                <button onClick={startHosting} style={{ alignSelf: 'flex-start' }}>Start Microphone</button>
                {hostError && <div style={{ color: '#e05c5c', fontSize: '12px' }}>{hostError}</div>}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                    Your IP — share this with anyone joining manually
                  </div>
                  <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                    {localIdentity.ipAddress || 'unknown'}
                  </div>
                </div>

                {pendingGuests.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {pendingGuests.map((g) => (
                      <div key={g.connId} className="peer-row" style={{ padding: '10px 14px', flexWrap: 'wrap' }}>
                        <div style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                          <div style={{ fontSize: '13px', fontWeight: 600 }}>Guest wants to connect mic ({g.remoteAddress})</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Confirm PIN matches their screen: <strong>{g.pin}</strong></div>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <button onClick={() => linkApi.acceptRemoteMicGuest?.(g.connId)} style={{ padding: '5px 12px', fontSize: '11.5px' }}>Accept</button>
                          <button onClick={() => linkApi.rejectRemoteMicGuest?.(g.connId)} style={{ padding: '5px 12px', fontSize: '11.5px' }}>Reject</button>
                          <button
                            onClick={() => {
                              linkApi.blockDevice?.(g.remoteAddress, `Guest (${g.remoteAddress})`, 'ip');
                              linkApi.rejectRemoteMicGuest?.(g.connId);
                            }}
                            style={{ padding: '5px 12px', fontSize: '11.5px', background: '#ef4444', color: '#fff', border: 'none' }}
                          >
                            Block
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>Connected Receivers ({listeners.length})</div>
                  {listeners.length === 0 ? (
                    <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No receivers connected yet.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {listeners.map((l) => (
                        <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                          <span style={{ fontSize: '13px', overflowWrap: 'anywhere' }}>{l.label}</span>
                          <button
                            onClick={() => linkApi?.kickRemoteMicListener?.(l.id)}
                            style={{ padding: '3px 10px', fontSize: '11px', background: 'transparent', border: '1px solid var(--border-color, #444)' }}
                          >
                            Kick
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={toggleHostMute}>{hostMuted ? 'Unmute Mic' : 'Mute Mic'}</button>
                  <button onClick={endHosting}>End Session</button>
                </div>
                {hostError && <div style={{ color: '#e05c5c', fontSize: '12px' }}>{hostError}</div>}
              </div>
            )}
          </div>
        )}
    </div>
  );
};

export default RemoteMicTab;

