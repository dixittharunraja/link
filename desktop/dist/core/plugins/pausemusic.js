"use strict";
// Pausemusic plugin.
// LOCAL-ONLY: no wire packet of its own — reacts to the already-received
// `telephony` packet and drives the same global-media-key path the `mpris` plugin already uses,
// pausing on ringing/talking and resuming only what it paused once the call ends.
// this SCOPES DOWN to the core always-pause/always-resume behavior — no per-action toggles, no
// mute-instead-of-pause option.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PauseMusicController = void 0;
class PauseMusicController {
    pausedByCall = false;
    setEnabled(enabled) {
        // Hardcoded as always active; ignores settings.
    }
    isEnabled() {
        return true;
    }
    /**
     * Call on every incoming telephony packet. `wasPlaying` is the caller's current known
     * playback state (mpris's own tracked flag, not a real session query — see mpris.ts).
     * Returns the action to actually perform, or null if this event needs no reaction.
     */
    onCallStateChanged(event, isCancel, wasPlaying) {
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
exports.PauseMusicController = PauseMusicController;
//# sourceMappingURL=pausemusic.js.map