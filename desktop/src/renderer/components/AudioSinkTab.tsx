import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestCard } from './ModalDialog';

const linkApi = (window as any).link;

interface PeerDevice {
  deviceId: string;
  name: string;
  deviceType?: string;
  connected?: boolean;
  trusted: boolean;
}

interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
}

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

// ----- PCM -> Web Audio playback helpers -----
// No native/npm dependency needed here — the renderer is full Chromium, so raw PCM chunks over
// IPC are played directly via the standard Web Audio API. AudioBuffer accepts an explicit
// sampleRate independent of the AudioContext's own output rate; the browser resamples on
// playback, so this works even if the context ends up on a different device rate.
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

  constructor() {
    this.ctx = new AudioContext();
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(this.ctx.destination);
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
    // Jitter buffer: always keep playback scheduled ~TARGET_BUFFER_S ahead of real time, so a
    // chunk that arrives a little late (Wi-Fi jitter, a brief capture/send stall) doesn't starve
    // the output and cause a gap/pop. Between resyncs, chunks schedule exactly back-to-back off
    // nextStartTime for gapless, sample-accurate playback — the cushion only gets re-established
    // when we've either FALLEN BEHIND (nextStartTime already at/behind real time = underrun, the
    // actual source of the glitches) or drifted TOO FAR AHEAD (a burst inflated the schedule).
    //
    // The whole latency/glitch tradeoff lives in TARGET_BUFFER_S: it's the steady-state latency
    // this stage adds AND how much lateness the buffer can absorb before a dropout. History:
    // 45ms -> 30ms -> 20ms -> 10ms -> 5ms (all confirmed good, no pops, on real hardware) -> 2ms.
    // The underrun-detection threshold below used to be a fixed 5ms constant — harmless at larger
    // TARGET_BUFFER_S values, but degenerate once TARGET_BUFFER_S got close to it (it would fire on
    // almost every chunk instead of only on genuine underrun, breaking gapless back-to-back
    // scheduling for a reason unrelated to the actual capture-gap floor being tested). Scaled to
    // half of TARGET_BUFFER_S instead so this mechanism stays meaningful at any buffer size.
    // Reset to 5ms (the last value independently confirmed clean before the host-side send-pacing
    // feature existed at all — 2ms was only ever tested together with pacing, which had its own
    // bugs) so pacing gets validated against a known-good baseline instead of stacking unknowns.
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

const AudioSinkTab: React.FC<AudioSinkTabProps> = ({ peers, localIdentity, isMobile }) => {
  // Host state
  const [hosting, setHosting] = useState(false);
  const [listeners, setListeners] = useState<ListenerInfo[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostMuted, setHostMuted] = useState(false);

  // Listener state
  const [joinIpInput, setJoinIpInput] = useState('');
  const [listenerPhase, setListenerPhase] = useState<ListenerPhase>('idle');
  const [pin, setPin] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  // General connect-attempt failures (wrong PIN, host unreachable, driver error) — distinct from
  // getting kicked/blocked mid-session, which now returns straight to the connect page with no
  // message to dismiss (see onAudioSinkClosed's comment) rather than going through this at all.
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [activeHostLabel, setActiveHostLabel] = useState<string | null>(null);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; pin: string; remoteAddress: string; deviceName?: string }[]>([]);

  // Already-paired peers who currently have a session running that this device hasn't joined
  const [pairedSessions, setPairedSessions] = useState<Map<string, PairedSession>>(new Map());

  // QR Display State
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const formatRef = useRef<AudioFormat | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);

  const [showScannerModal, setShowScannerModal] = useState(false);

  // Read inside the onAudioSinkError handler below, which is registered once (effect deps: []) and
  // would otherwise only ever see `hosting`'s value from the moment it mounted.
  const hostingRef = useRef(hosting);
  useEffect(() => { hostingRef.current = hosting; }, [hosting]);

  const handleDecodedHost = (host: string) => {
    setShowScannerModal(false);
    setJoinIpInput(host);
    joinAsGuest(host);
  };

  useEffect(() => {
    if (!linkApi) return;

    linkApi.onAudioSinkListenerJoined((id: string, label: string) => {
      setListeners((prev) => [...prev.filter((l) => l.id !== id), { id, label }]);
      setPendingGuests((prev) => prev.filter((g) => g.connId !== id));
    });
    linkApi.onAudioSinkListenerLeft((id: string) => {
      setListeners((prev) => prev.filter((l) => l.id !== id));
      setPendingGuests((prev) => prev.filter((g) => g.connId !== id));
    });
    linkApi.onAudioSinkGuestPinPending?.((connId: string, guestPin: string, remoteAddress: string, deviceName?: string) => {
      setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, pin: guestPin, remoteAddress, deviceName }]);
    });
    linkApi.onAudioSinkPinComputed?.((computedPin: string) => {
      setPin(computedPin);
      setListenerPhase('waiting-pin');
    });
    linkApi.onAudioSinkError((message: string) => {
      // This single event covers BOTH the host-side server (only running while hosting) and the
      // listener-side client (only running while joining/listening) — the two are mutually
      // exclusive in the UI (the Join panel is hidden while hosting), so `hosting` alone is enough
      // to route it correctly instead of lighting up both panels' error lines for one failure.
      if (hostingRef.current) {
        setHostError(message);
      } else {
        setListenerError(message);
      }
    });

    linkApi.onAudioSinkPairedSessionStarted((deviceId: string, token: string, host: string) => {
      const peerName = peers.get(deviceId)?.name || deviceId.slice(0, 8);
      setPairedSessions((prev) => {
        const copy = new Map(prev);
        copy.set(deviceId, { deviceId, deviceName: peerName, token, host });
        return copy;
      });
    });
    linkApi.onAudioSinkPairedSessionEnded((deviceId: string) => {
      setPairedSessions((prev) => {
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
    });

    linkApi.onAudioSinkAdmitted((hostLabel: string) => {
      if (hostLabel) setActiveHostLabel(hostLabel);
      setListenerPhase('listening');
      // Mobile plays natively (AudioTrack, driven entirely from Java) — no chunks ever reach JS
      // there, so a Web Audio context here would just sit idle. Desktop-only.
      if (!isMobile) {
        playerRef.current = new PcmPlayer();
        playerRef.current.setVolume(volume);
      }
    });
    linkApi.onAudioSinkFormat((format: AudioFormat) => {
      formatRef.current = format;
    });
    linkApi.onAudioSinkAudioChunk((pcm: Uint8Array) => {
      if (playerRef.current && formatRef.current) {
        playerRef.current.enqueue(pcm, formatRef.current);
      }
    });
    linkApi.onAudioSinkEnded((reason?: string) => {
      setListenerPhase('idle');
      setActiveHostLabel(null);
      setPin(null);
      // A graceful whole-session end (reason undefined, or the server's 'session ended') needs no
      // explanation — but a host kicking just this one listener sends 'removed by host' with no
      // prior end-of-session message, and that DOES deserve a visible reason on the connect page.
      setListenerError(reason === 'removed by host' ? 'Removed by host' : null);
      playerRef.current?.close();
      playerRef.current = null;
    });
    linkApi.onAudioSinkClosed((reason: string) => {
      // Straight back to the connect page rather than a separate error screen to dismiss first —
      // but unlike a mid-session kick (onAudioSinkEnded, which needs no explanation), this also
      // covers a host REJECTING the join/PIN request before ever connecting, which the connect
      // page's own inline error line below should actually explain (a plain "Rejected by host",
      // not a blank return with no indication anything happened).
      // 'removed by host' also lands here (not onAudioSinkEnded) on Android — LinkAudioSinkClient
      // .java's onClose has no 1000/1001 split the way the desktop TS client does, so a kick
      // always routes through onClosed there regardless of close code. Mapped the same as
      // onAudioSinkEnded's identical case so the displayed text matches on both platforms.
      setListenerPhase('idle');
      setListenerError(
        // 'blocked' (a previously-blocked device trying to reconnect) reads the same as a plain
        // reject — it should never reveal that it was specifically blocked, just that it was
        // turned away.
        reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host'
        : reason === 'removed by host' ? 'Removed by host'
        : reason || 'Connection lost'
      );
      setPin(null);
      playerRef.current?.close();
      playerRef.current = null;
    });

    // Query backend for active session state to restore UI when reopening modal. Wrapped in
    // Promise.resolve() rather than chaining .then() straight onto the optional call — `?.()`
    // only guards the CALL itself; if getAudioSinkStatus doesn't exist at all (e.g. it was
    // missing from the mobile bridge), the expression evaluates to plain `undefined`, and
    // `undefined.then(...)` throws synchronously right here in the effect, with no error boundary
    // above it — the exact failure mode that silently blanks the whole tab. Promise.resolve(undefined)
    // just resolves to undefined harmlessly, so this degrades gracefully either way.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Guard linkApi itself, not just the method — `linkApi.setAudioSinkListenerVolume?.()`
    // only protects the CALL, not the `.setAudioSinkListenerVolume` property read on `linkApi`.
    // If linkApi is undefined (bridge not ready yet at mount), that read throws synchronously
    // inside this effect — with no error boundary above it, React silently unmounts the whole
    // tree, which is exactly what "opens to a blank page" looks like. This was missing here even
    // though the other effect above already had the equivalent guard.
    if (!linkApi) return;
    // On mobile, playback happens natively (AudioTrack) — there's no local Web Audio GainNode to
    // reach, so volume goes through a dedicated native call instead. See LinkAudioSinkClient
    // .setVolume()'s comment for why chunks aren't forwarded to JS on that platform at all.
    if (isMobile) {
      linkApi.setAudioSinkListenerVolume?.(volume);
    } else {
      playerRef.current?.setVolume(volume);
    }
  }, [volume, isMobile]);

  // Generate QR for local IP when hosting is active
  useEffect(() => {
    if (hosting) {
      const ip = (localIdentity?.ipAddresses && localIdentity.ipAddresses.length > 0)
        ? localIdentity.ipAddresses.join(',')
        : (localIdentity?.ipAddress || '127.0.0.1');
      const qrText = `link:${ip}:1719`;
      QRCode.toDataURL(qrText, {
        margin: 1,
        width: 160,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      })
        .then((url) => setQrDataUrl(url))
        .catch((err) => console.error('Failed to generate audio relay QR:', err));
    } else {
      setQrDataUrl(null);
    }
  }, [hosting, localIdentity]);


  const startHosting = async () => {
    setHostError(null);
    const result = await linkApi.startAudioSink();
    if (result?.started) {
      setHosting(true);
    } else {
      setHostError(result?.error || 'Failed to start');
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
    // Paired join skips the PIN step server-side — 'admitted' fires directly once the token's verified.
    setPairedSessions((prev) => {
      const copy = new Map(prev);
      copy.delete(session.deviceId);
      return copy;
    });
  };

  const leaveListening = async () => {
    await linkApi.leaveAudioSink();
    setListenerPhase('idle');
    setActiveHostLabel(null);
    setPin(null);
    playerRef.current?.close();
    playerRef.current = null;
    // Re-query active sessions immediately so we can join again without reloading
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

  // Both sections can be visible at once (idle + not hosting), so unlike File Transfer's single
  // flowing panel this needs a divider between them when that happens — matching the divider
  // style File Transfer uses between its connected-state header and body, not a boxed .card.
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
                onEnter={() => joinAsGuest()}
                placeholder="Host's IP address"
              />
              <button
                onClick={() => joinAsGuest()}
                disabled={!joinIpInput}
                style={{
                  width: '100%',
                  padding: '10px',
                  borderRadius: '8px',
                  // Dimming the filled button via opacity faded the white text right along with
                  // the background, so the label read as washed-out and hard to make out rather
                  // than legibly "disabled." Swapping to a flat muted fill with muted text keeps
                  // the label readable at every state.
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
                Start Session
              </button>
              {hostError && <div style={{ color: '#e05c5c', fontSize: '12.5px' }}>{hostError}</div>}
            </>
          ) : (
            <>
              {/* Stacked Layout: QR Code centered on top, Listeners list below */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
                {qrDataUrl ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                    <div style={{ background: '#fff', padding: '8px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                      <img src={qrDataUrl} alt="Audio Relay QR Code" style={{ display: 'block', width: '140px', height: '140px', imageRendering: 'pixelated' }} />
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-color)' }}>
                      {localIdentity.ipAddress || 'unknown'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
                      Scan this QR code from the listening device.
                    </div>
                  </div>
                ) : (
                  <div style={{ width: '140px', height: '140px', background: 'rgba(0,0,0,0.05)', borderRadius: '8px' }} />
                )}
              </div>

              <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '8px 0' }} />

              {pendingGuests.length > 0 && (
                // A separate popup, not a row stacked in with the QR/listeners panel — PIN
                // verification is a decision that needs its own undivided attention, not
                // something to notice while scrolling past the listener list. Styled to match the
                // Tools modal wrapper it sits on top of (ToolsTab.tsx's own popup: var(--modal-bg)/
                // var(--border-color)/var(--modal-shadow), same backdrop blur), just at a higher
                // zIndex (that wrapper is 1000) so it reads as its own dialog above it.
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
                          subtitle="wants to listen to your audio"
                          onAccept={() => {
                            linkApi.acceptAudioSinkGuest?.(g.connId);
                            setPendingGuests((prev) => prev.filter((pg) => pg.connId !== g.connId));
                          }}
                          onReject={() => {
                            linkApi.rejectAudioSinkGuest?.(g.connId);
                            setPendingGuests((prev) => prev.filter((pg) => pg.connId !== g.connId));
                          }}
                          onBlock={() => {
                            linkApi.blockAudioSinkGuest?.(g.connId);
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
                  Active Listeners ({listeners.length})
                </div>

                {listeners.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px' }}>
                    No listeners connected yet.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                              background: 'rgba(16, 185, 129, 0.1)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#10b981',
                              flexShrink: 0,
                            }}
                          >
                            {renderDeviceIcon(getListenerDeviceType(l.label))}
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
                            onClick={() => linkApi.kickAudioSinkListener?.(l.id)}
                            style={{ padding: '5px 12px', fontSize: '11.5px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
                          >
                            Kick
                          </button>
                          <button
                            onClick={() => linkApi.blockAudioSinkListener?.(l.id)}
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
              </div>

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
        title="Scan Session QR Code"
      />
    </div>
  );
};

export default AudioSinkTab;
