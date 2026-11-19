// Loops a system alarm sound until stopped. Used for "find my device" and for incoming-call
// ringing. The sound is Windows' own Alarm01.wav.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

// A start bumps this so an older auto-stop timer can tell it no longer owns the ringer.
static GENERATION: AtomicU64 = AtomicU64::new(0);
const AUTO_STOP: Duration = Duration::from_secs(60);

#[cfg(windows)]
fn play_loop() {
    use windows::core::w;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_LOOP};
    // SAFETY: a static, NUL-terminated path; PlaySound copies what it needs.
    unsafe {
        let _ = PlaySoundW(w!("C:\\Windows\\Media\\Alarm01.wav"), None, SND_FILENAME | SND_ASYNC | SND_LOOP);
    }
}

#[cfg(windows)]
fn stop_loop() {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_PURGE};
    // SAFETY: a null sound name with SND_PURGE stops playback.
    unsafe {
        let _ = PlaySoundW(windows::core::PCWSTR::null(), None, SND_PURGE);
    }
}

#[cfg(not(windows))]
fn play_loop() {}

#[cfg(not(windows))]
fn stop_loop() {}

pub fn start() {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    play_loop();
    std::thread::spawn(move || {
        std::thread::sleep(AUTO_STOP);
        if GENERATION.load(Ordering::SeqCst) == generation {
            stop_loop();
        }
    });
}

pub fn stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    stop_loop();
}
