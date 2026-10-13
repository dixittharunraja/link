export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
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

export class PcmPlayer {
  private ctx: AudioContext;
  private gainNode: GainNode;
  private nextStartTime = 0;

  constructor(sinkId?: string, preferredSampleRate?: number) {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = preferredSampleRate ? new AudioContextCtor({ sampleRate: preferredSampleRate }) : new AudioContextCtor();
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(this.ctx.destination);

    if (sinkId && typeof (this.ctx as any).setSinkId === 'function') {
      (this.ctx as any).setSinkId(sinkId).catch((e: any) => {
        console.error('[PcmPlayer] Failed to set audio output device:', e);
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

export function mapCloseReasonToError(reason?: string): string | null {
  if (!reason) return null;
  const isClean = reason === '1000' || reason.includes('1000') || reason.includes('1001') || reason.includes('normal') || reason.includes('clean') || reason === 'closed';
  if (isClean) return null;
  if (reason === 'rejected by host' || reason === 'blocked') return 'Rejected by host';
  if (reason === 'removed by host') return 'Removed by host';
  return reason;
}

export function handleListenerSessionEnd(
  reason: string | undefined,
  setPhase: (phase: 'idle') => void,
  setActiveHost: (host: null) => void,
  setPin: (pin: null) => void,
  setError: (err: string | null) => void,
  playerRef: { current: PcmPlayer | null }
) {
  setPhase('idle');
  setActiveHost(null);
  setPin(null);
  setError(reason === 'removed by host' ? 'Removed by host' : null);
  playerRef.current?.close();
  playerRef.current = null;
}


