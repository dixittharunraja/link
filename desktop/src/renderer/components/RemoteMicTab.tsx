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
    // Cast to any since typescript lib.d.ts might not have setSinkId on AudioContext Options yet
    const options: any = {};
    if (sinkId) {
      options.sinkId = sinkId;
    }
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)(options);
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
  
  // Streaming status states
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Ready');
  const [activeSender, setActiveSender] = useState<string | null>(null);
  
  // Active phone microphone sessions discovered on LAN
  const [pairedSessions, setPairedSessions] = useState<Map<string, PairedSession>>(new Map());

  const formatRef = useRef<AudioFormat | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);

  // Check for virtual audio devices (sinks) in the browser/renderer using Web Audio / navigator.mediaDevices
  const checkDriverStatus = async () => {
    if (isMobile) {
      setDriverInstalled(true); // Driver checks only matter for the Desktop receiver side
      return;
    }
    
    setCheckingDriver(true);
    try {
      // Trigger media permissions request if not granted so we can enumerate output devices
      await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Look for audio outputs (which represent speakers or virtual cable inputs)
      const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
      
      // Look for common virtual driver naming signatures (avoiding generic "virtual" to prevent false positives)
      const hasVirtualCable = audioOutputs.some(
        (d) =>
          d.label.toLowerCase().includes('cable input') ||
          d.label.toLowerCase().includes('vb-audio') ||
          d.label.toLowerCase().includes('voicemeeter') ||
          d.label.toLowerCase().includes('vb-cable')
      );
      
      setMicDevices(audioOutputs);
      
      // Automatically select the virtual cable if found
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

    // Mobile (Transmitter) Event Hooks
    linkApi.onRemoteMicListenerJoined?.((connId: string, label: string) => {
      setStatusMessage(`Microphone stream active. Connected listener: ${label}`);
    });
    linkApi.onRemoteMicListenerLeft?.((connId: string) => {
      setStatusMessage('Hosting remote microphone stream...');
    });
    linkApi.onRemoteMicError?.((message: string) => {
      setStatusMessage(`Error: ${message}`);
      setIsStreaming(false);
    });

    // Desktop (Receiver) Event Hooks
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
      // If we were currently listening to this peer, end it
      if (activeSender === (peers.get(deviceId)?.name || deviceId.slice(0, 8))) {
        handleDisconnectPhoneMic();
      }
    });
    linkApi.onRemoteMicAdmitted?.(() => {
      setStatusMessage('Microphone connected. Stream routing active.');
      if (!isMobile) {
        playerRef.current = new PcmPlayer(selectedSink);
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
      handleDisconnectPhoneMic();
    });
    linkApi.onRemoteMicClosed?.((reason: string) => {
      setStatusMessage(`Connection closed: ${reason}`);
      handleDisconnectPhoneMic();
    });

    linkApi.queryRemoteMicSessions?.();

    return () => {
      playerRef.current?.close();
      playerRef.current = null;
    };
  }, [isMobile]);

  const handleStartMicHost = () => {
    if (!linkApi) return;
    linkApi.startRemoteMic().then((res: any) => {
      if (res?.started) {
        setIsStreaming(true);
        setStatusMessage('Hosting remote microphone stream...');
      } else {
        setStatusMessage(`Failed to host: ${res?.error || 'Unknown error'}`);
      }
    }).catch((err: any) => {
      setStatusMessage(`Error: ${err.message}`);
    });
  };

  const handleStopMicHost = () => {
    if (!linkApi) return;
    linkApi.endRemoteMic().then(() => {
      setIsStreaming(false);
      setStatusMessage('Ready');
    });
  };

  const handleConnectToPhoneMic = (peerId: string) => {
    if (!linkApi) return;
    const session = pairedSessions.get(peerId);
    // Fall back to peer's address if session start sync packet hasn't arrived yet
    const host = session?.host || peers.get(peerId)?.deviceId; 
    const token = session?.token || '';

    setIsStreaming(true);
    const peerName = peers.get(peerId)?.name || 'Phone';
    setActiveSender(peerName);
    setStatusMessage(`Connecting to microphone stream on ${peerName}...`);

    linkApi.joinRemoteMicPaired(host, token);
  };

  const handleDisconnectPhoneMic = () => {
    if (linkApi) linkApi.leaveRemoteMic();
    setIsStreaming(false);
    setActiveSender(null);
    setStatusMessage('Ready');
  };

  return (
    <div id="tab-remote-mic" className="tab-content active" style={{ overflowX: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '18px', alignItems: 'start' }}>
        
        {/* Desktop Side: Receiver View */}
        {!isMobile && (
          <div className="card" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="card-title">Desktop Receiver</div>
            
            {driverInstalled === false && (
              <div style={{
                background: 'rgba(224, 92, 92, 0.1)',
                border: '1px solid rgba(224, 92, 92, 0.3)',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
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

            {driverInstalled === true && (
              <div style={{
                background: 'rgba(46, 204, 113, 0.1)',
                border: '1px solid rgba(46, 204, 113, 0.3)',
                borderRadius: '8px',
                padding: '12px 14px',
                color: '#2ecc71',
                fontSize: '13px',
                fontWeight: 500
              }}>
                ✓ Virtual Audio Cable detected and ready!
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>
                OUTPUT TARGET (VIRTUAL CABLE)
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
              <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '2px', lineHeight: 1.4 }}>
                Choose the virtual cable input (e.g. <em>CABLE Input</em>). Then, in Discord or Zoom, choose <em>CABLE Output</em> as your microphone.
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>
                CONNECT TO A PHONE
              </label>
              {Array.from(peers.values()).filter((p: PeerDevice) => p.connected).length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No connected devices available. Pair and connect a phone first.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {Array.from(peers.values()).filter((p: PeerDevice) => p.connected).map((p: PeerDevice) => (
                    <div key={p.deviceId} className="peer-row" style={{ padding: '10px 12px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 500 }}>{p.name}</span>
                      {isStreaming && activeSender === p.name ? (
                        <button 
                          onClick={handleDisconnectPhoneMic} 
                          style={{ padding: '4px 10px', fontSize: '11.5px', background: '#e05c5c' }}
                        >
                          Disconnect
                        </button>
                      ) : (
                        <button 
                          onClick={() => handleConnectToPhoneMic(p.deviceId)} 
                          disabled={isStreaming}
                          style={{ padding: '4px 10px', fontSize: '11.5px' }}
                        >
                          Connect
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isStreaming && (
              <div style={{ marginTop: '10px', fontSize: '13px', color: 'var(--text-accent, #007acc)', fontWeight: 500 }}>
                🔊 {statusMessage}
              </div>
            )}
          </div>
        )}

        {/* Mobile Side: Transmitter View */}
        {isMobile && (
          <div className="card" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="card-title">Phone Microphone Transmitter</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.5 }}>
              Use this device's microphone as a wireless input for your PC.
            </div>

            {!isStreaming ? (
              <button onClick={handleStartMicHost} style={{ alignSelf: 'flex-start', padding: '8px 16px' }}>
                Start Transmitter
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-accent, #007acc)' }}>
                  🎙️ Microphone is active and transmitting
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Your IP: <strong>{localIdentity.ipAddress || 'unknown'}</strong>
                </div>
                <button 
                  onClick={handleStopMicHost} 
                  style={{ alignSelf: 'flex-start', padding: '8px 16px', background: '#e05c5c' }}
                >
                  Stop Transmitter
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
};

export default RemoteMicTab;
