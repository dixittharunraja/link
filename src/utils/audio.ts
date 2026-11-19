// Shared listener-session helpers for the audio sink and remote mic tabs. The received audio itself
// never reaches the page: the desktop plays it natively (src-tauri/src/core/audio_sink/playback.rs)
// and Android through AudioTrack (LinkAudioSinkClient.java).

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
) {
  setPhase('idle');
  setActiveHost(null);
  setPin(null);
  setError(reason === 'removed by host' ? 'Removed by host' : null);
}
