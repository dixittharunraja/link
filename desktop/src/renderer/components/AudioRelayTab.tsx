import React, { useEffect, useRef, useState } from 'react';

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

interface AudioRelayTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string };
  isMobile: boolean;
}

interface PendingGuest {
  connId: string;
  pin: string;
  remoteAddress: string;
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

type ListenerPhase = 'idle' | 'connecting' | 'waiting-pin' | 'listening' | 'rejected' | 'error';

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

const AudioRelayTab: React.FC<AudioRelayTabProps> = ({ peers, localIdentity, isMobile }) => {
  // Host state
  const [hosting, setHosting] = useState(false);
  const [listeners, setListeners] = useState<ListenerInfo[]>([]);
  const [pendingGuests, setPendingGuests] = useState<PendingGuest[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostMuted, setHostMuted] = useState(false);

  // Listener state
  const [joinIpInput, setJoinIpInput] = useState('');
  const [listenerPhase, setListenerPhase] = useState<ListenerPhase>('idle');
  const [pin, setPin] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [activeHostLabel, setActiveHostLabel] = useState<string | null>(null);

  // Already-paired peers who currently have a session running that this device hasn't joined
  const [pairedSessions, setPairedSessions] = useState<Map<string, PairedSession>>(new Map());

  const formatRef = useRef<AudioFormat | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);

  useEffect(() => {
    if (!linkApi) return;

    linkApi.onAudioRelayGuestPinPending((connId: string, guestPin: string, remoteAddress: string) => {
      setPendingGuests((prev) => [...prev, { connId, pin: guestPin, remoteAddress }]);
    });
    linkApi.onAudioRelayListenerJoined((id: string, label: string) => {
      setListeners((prev) => [...prev.filter((l) => l.id !== id), { id, label }]);
      setPendingGuests((prev) => prev.filter((g) => g.connId !== id));
    });
    linkApi.onAudioRelayListenerLeft((id: string) => {
      setListeners((prev) => prev.filter((l) => l.id !== id));
    });
    linkApi.onAudioRelayError((message: string) => {
      setHostError(message);
      setListenerError(message);
    });

    linkApi.onAudioRelayPairedSessionStarted((deviceId: string, token: string, host: string) => {
      const peerName = peers.get(deviceId)?.name || deviceId.slice(0, 8);
      setPairedSessions((prev) => {
        const copy = new Map(prev);
        copy.set(deviceId, { deviceId, deviceName: peerName, token, host });
        return copy;
      });
    });
    linkApi.onAudioRelayPairedSessionEnded((deviceId: string) => {
      setPairedSessions((prev) => {
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
    });

    linkApi.onAudioRelayPinComputed((computedPin: string) => {
      setPin(computedPin);
      setListenerPhase('waiting-pin');
    });
    linkApi.onAudioRelayAdmitted(() => {
      setListenerPhase('listening');
      // Mobile plays natively (AudioTrack, driven entirely from Java) — no chunks ever reach JS
      // there, so a Web Audio context here would just sit idle. Desktop-only.
      if (!isMobile) {
        playerRef.current = new PcmPlayer();
        playerRef.current.setVolume(volume);
      }
    });
    linkApi.onAudioRelayFormat((format: AudioFormat) => {
      formatRef.current = format;
    });
    linkApi.onAudioRelayAudioChunk((pcm: Uint8Array) => {
      if (playerRef.current && formatRef.current) {
        playerRef.current.enqueue(pcm, formatRef.current);
      }
    });
    linkApi.onAudioRelayEnded(() => {
      setListenerPhase('idle');
      setPin(null);
      setActiveHostLabel(null);
      playerRef.current?.close();
      playerRef.current = null;
    });
    linkApi.onAudioRelayClosed((reason: string) => {
      setListenerPhase((prev) => (prev === 'listening' || prev === 'waiting-pin' ? 'error' : prev));
      setListenerError(reason);
      playerRef.current?.close();
      playerRef.current = null;
    });

    // The one-shot 'started' broadcast a host sends only ever reaches whoever was connected AND
    // had this tab open at that exact moment — miss it and there was previously no way to ever
    // find out a session was active. Actively ask on every mount so opening this tab always
    // surfaces the true current state instead of depending on having caught the original event.
    linkApi.queryAudioRelaySessions?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Guard linkApi itself, not just the method — `linkApi.setAudioRelayListenerVolume?.()`
    // only protects the CALL, not the `.setAudioRelayListenerVolume` property read on `linkApi`.
    // If linkApi is undefined (bridge not ready yet at mount), that read throws synchronously
    // inside this effect — with no error boundary above it, React silently unmounts the whole
    // tree, which is exactly what "opens to a blank page" looks like. This was missing here even
    // though the other effect above already had the equivalent guard.
    if (!linkApi) return;
    // On mobile, playback happens natively (AudioTrack) — there's no local Web Audio GainNode to
    // reach, so volume goes through a dedicated native call instead. See LinkAudioRelayClient
    // .setVolume()'s comment for why chunks aren't forwarded to JS on that platform at all.
    if (isMobile) {
      linkApi.setAudioRelayListenerVolume?.(volume);
    } else {
      playerRef.current?.setVolume(volume);
    }
  }, [volume, isMobile]);

  const startHosting = async () => {
    setHostError(null);
    const result = await linkApi.startAudioRelay();
    if (result?.started) {
      setHosting(true);
    } else {
      setHostError(result?.error || 'Failed to start');
    }
  };

  const endHosting = async () => {
    await linkApi.endAudioRelay();
    setHosting(false);
    setListeners([]);
    setPendingGuests([]);
    setHostMuted(false);
  };

  const toggleHostMute = () => {
    const next = !hostMuted;
    setHostMuted(next);
    linkApi.setAudioRelayMuted?.(next);
  };

  const joinAsGuest = () => {
    const host = joinIpInput.trim();
    if (!host) return;
    setListenerError(null);
    setListenerPhase('connecting');
    setActiveHostLabel(host);
    linkApi.joinAudioRelayGuest(host);
  };

  const joinPaired = (session: PairedSession) => {
    setListenerError(null);
    setListenerPhase('connecting');
    setActiveHostLabel(session.deviceName);
    linkApi.joinAudioRelayPaired(session.host, session.token);
    // Paired join skips the PIN step server-side — 'admitted' fires directly once the token's verified.
    setPairedSessions((prev) => {
      const copy = new Map(prev);
      copy.delete(session.deviceId);
      return copy;
    });
  };

  const leaveListening = async () => {
    await linkApi.leaveAudioRelay();
    setListenerPhase('idle');
    setPin(null);
    setActiveHostLabel(null);
    playerRef.current?.close();
    playerRef.current = null;
  };

  return (
    <div id="tab-audio-relay" className="tab-content active" style={{ overflowX: 'hidden' }}>
      {pairedSessions.size > 0 && listenerPhase === 'idle' && (
        <div className="card">
          <div className="card-title">Active Sessions</div>
          {Array.from(pairedSessions.values()).map((s) => (
            <div key={s.deviceId} className="peer-row" style={{ padding: '12px 14px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>{s.deviceName} has an audio session</span>
              <button onClick={() => joinPaired(s)} style={{ padding: '5px 14px', fontSize: '11.5px' }}>
                Join
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '18px', alignItems: 'start' }}>
        {listenerPhase === 'idle' && (
        <div className="card" style={{ margin: 0 }}>
          <div className="card-title">Host</div>
          {!hosting ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '12.5px' }}>
                Streams this device's system audio to anyone who joins — a friend via IP, or any
                already-paired device with one tap.
              </div>
              {isMobile && (
                <div style={{ color: 'var(--text-muted)', fontSize: '11px', fontStyle: 'italic' }}>
                  Android will ask you to confirm a system capture permission every time you start
                  a session. Apps like Spotify, Netflix, and YouTube block their audio from being
                  captured this way — local video files, games, and most other apps work fine.
                </div>
              )}
              <button onClick={startHosting} style={{ alignSelf: 'flex-start' }}>Start Session</button>
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
                        <div style={{ fontSize: '13px', fontWeight: 600 }}>Guest wants to listen ({g.remoteAddress})</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Confirm PIN matches their screen: <strong>{g.pin}</strong></div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button onClick={() => linkApi.rejectAudioRelayGuest(g.connId)} style={{ padding: '5px 12px', fontSize: '11.5px' }}>Reject</button>
                        <button onClick={() => linkApi.acceptAudioRelayGuest(g.connId)} style={{ padding: '5px 12px', fontSize: '11.5px' }}>Accept</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                  Listeners ({listeners.length})
                </div>
                {listeners.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No one connected yet</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {listeners.map((l) => (
                      <div key={l.id} style={{ fontSize: '13px' }}>{l.label}</div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={toggleHostMute}>{hostMuted ? 'Unmute' : 'Mute'}</button>
                <button onClick={endHosting}>End Session</button>
              </div>
              {hostError && <div style={{ color: '#e05c5c', fontSize: '12px' }}>{hostError}</div>}
            </div>
          )}
        </div>
        )}

      {!hosting && (
      <div className="card" style={{ margin: 0 }}>
        <div className="card-title">Join a Session</div>
        {listenerPhase === 'idle' && (
          <div className="flex-row" style={{ flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Host's IP address"
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
              Connected to {activeHostLabel} — Listening
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
            <button onClick={leaveListening} style={{ alignSelf: 'flex-start' }}>Leave</button>
          </div>
        )}
        {listenerPhase === 'rejected' && (
          <div style={{ color: '#e05c5c', fontSize: '12px' }}>The host declined your request to join.</div>
        )}
        {listenerPhase === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ color: '#e05c5c', fontSize: '12px' }}>{listenerError || 'Connection lost'}</div>
            <button onClick={() => setListenerPhase('idle')} style={{ alignSelf: 'flex-start' }}>Dismiss</button>
          </div>
        )}
      </div>
      )}
      </div>
    </div>
  );
};

export default AudioRelayTab;
