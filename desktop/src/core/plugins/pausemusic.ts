// Pausemusic plugin.
// LOCAL-ONLY: no wire packet of its own — reacts to the already-received
// `telephony` packet and drives the same global-media-key path the `mpris` plugin already uses,
// pausing on ringing/talking and resuming only what it paused once the call ends.
// this SCOPES DOWN to the core always-pause/always-resume behavior — no per-action toggles, no
// mute-instead-of-pause option.

export type PauseMusicAction = 'pause' | 'resume' | null;

export class PauseMusicController {
  private pausedByCall = false;

  public setEnabled(enabled: boolean) {
    // Hardcoded as always active; ignores settings.
  }

  public isEnabled(): boolean {
    return true;
  }

  /**
   * Call on every incoming telephony packet. `wasPlaying` is the caller's current known
   * playback state (mpris's own tracked flag, not a real session query — see mpris.ts).
   * Returns the action to actually perform, or null if this event needs no reaction.
   */
  onCallStateChanged(event: string | undefined, isCancel: boolean, wasPlaying: boolean): PauseMusicAction {
    const isActiveCall = !isCancel && (event === 'ringing' || event === 'talking');

    if (isActiveCall) {
      if (wasPlaying && !this.pausedByCall) {
        this.pausedByCall = true;
        return 'pause';
      }
      return null;
    }

    if (this.pausedByCall) {
      this.pausedByCall = false;
      return 'resume';
    }
    return null;
  }
}
