import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestCard } from './ModalDialog';

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
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[] };
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
    // Explicit sampleRate matching the phone's fixed 48kHz capture rate (LinkRemoteMicCapture.java)
    // — without this, the context defaults to whatever rate the system's current output device
    // happens to run at (not guaranteed to be 48kHz), silently inserting a resampling step on
    // every buffer. Requesting the source rate directly avoids that entirely wherever the OS
    // honors it, which matters here since this feed is explicitly meant to be as clean as
    // possible (e.g. for vocal recording via a virtual audio cable), not just intelligible speech.
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextCtor({ sampleRate: 48000 });
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
  const [pendingGuests, setPendingGuests] = useState<any[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

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
      setListenerPhase('idle');
      setActiveHostLabel(null);
      setPin(null);
      // Same distinction as Audio Sink's onAudioSinkEnded — a plain session end needs no
      // explanation, but the host kicking just this listener (reason 'removed by host') does.
      setListenerError(reason === 'removed by host' ? 'Removed by host' : null);
      playerRef.current?.close();
      playerRef.current = null;
    });
    linkApi.onRemoteMicClosed?.((reason: string) => {
      // Unconditional 'idle' (not just when 'listening') — matches Audio Sink's onAudioSinkClosed.
      // This also covers a host REJECTING the join/PIN request while still on the connecting/
      // waiting-pin screen: previously the phase only reset when it was 'listening', so a reject
      // during waiting-pin left the ConnectingCard (PIN box, "Connecting to X...") stuck on screen
      // underneath the "Rejected by host" line instead of returning to the plain connect screen.
      setListenerPhase('idle');
      setListenerError(
        reason === 'removed by host' ? 'Removed by host'
        // 'blocked' should never reveal that it was specifically blocked, just rejected.
        : reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host'
        : reason
      );
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

  // Generate QR for local IP when hosting is active
  useEffect(() => {
    if (hosting) {
      const ip = (localIdentity?.ipAddresses && localIdentity.ipAddresses.length > 0)
        ? localIdentity.ipAddresses.join(',')
        : (localIdentity?.ipAddress || '127.0.0.1');
      const qrText = `link:${ip}:1720`;
      QRCode.toDataURL(qrText, {
        margin: 1,
        width: 160,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      })
        .then((url) => setQrDataUrl(url))
        .catch((err) => console.error('Failed to generate remote mic QR:', err));
    } else {
      setQrDataUrl(null);
    }
  }, [hosting, localIdentity]);

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
                <select
                  value={selectedSink}
                  onChange={(e) => setSelectedSink(e.target.value)}
                  style={{ width: '100%' }}
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
                <button
                  onClick={() => joinAsGuest()}
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
                <button
                  onClick={startHosting}
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '8px',
                    background: 'var(--accent-color, #007acc)',
                    color: 'var(--btn-primary-text)',
                    border: 'none',
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                  }}
                >
                  Start Microphone
                </button>
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

                {pendingGuests.length > 0 && (
                  // Separate popup, not a row stacked in with the QR/rest of the tab — see
                  // AudioSinkTab's identical fix for the full reasoning. Styled to match the Tools
                  // modal wrapper this sits on top of (ToolsTab.tsx's own popup: var(--modal-bg)/
                  // var(--border-color)/var(--modal-shadow), same backdrop blur), just at a higher
                  // zIndex (that wrapper is 1000).
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
                            guest={g}
                            subtitle="wants to receive your microphone"
                            onAccept={() => {
                              linkApi?.acceptRemoteMicGuest?.(g.connId);
                              setPendingGuests((prev) => prev.filter((pg) => pg.connId !== g.connId));
                            }}
                            onReject={() => {
                              linkApi?.rejectRemoteMicGuest?.(g.connId);
                              setPendingGuests((prev) => prev.filter((pg) => pg.connId !== g.connId));
                            }}
                            onBlock={() => {
                              linkApi?.blockRemoteMicGuest?.(g.connId);
                              setPendingGuests((prev) => prev.filter((pg) => pg.connId !== g.connId));
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {listeners.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                    {listeners.map((l) => (
                      <div
                        key={l.id}
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
                              background: 'rgba(0, 155, 213, 0.1)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#009bd5',
                              flexShrink: 0,
                            }}
                          >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                              <line x1="8" y1="21" x2="16" y2="21" />
                              <line x1="12" y1="17" x2="12" y2="21" />
                            </svg>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere' }}>{l.label}</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Streaming</span>
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                          <button
                            onClick={() => linkApi?.kickRemoteMicListener?.(l.id)}
                            style={{ padding: '5px 12px', fontSize: '11.5px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
                          >
                            Kick
                          </button>
                          <button
                            onClick={() => linkApi?.blockRemoteMicListener?.(l.id)}
                            style={{ padding: '5px 12px', fontSize: '11.5px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
                          >
                            Block
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {hostError && <div style={{ color: '#e05c5c', fontSize: '12px' }}>{hostError}</div>}

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={toggleHostMute}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: hostMuted ? '1px solid var(--accent-color, #009bd5)' : '1px solid var(--border-color)',
                        background: hostMuted ? 'rgba(0, 155, 213, 0.1)' : 'transparent',
                        color: hostMuted ? 'var(--accent-color, #009bd5)' : 'var(--text-color)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        fontWeight: 500
                      }}
                    >
                      {hostMuted ? 'Unmute' : 'Mute'}
                    </button>
                    <button
                      onClick={endHosting}
                      style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: '12px', cursor: 'pointer', fontWeight: 500 }}
                    >
                      End Session
                    </button>
                  </div>
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

