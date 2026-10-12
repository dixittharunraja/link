// Keeps the display awake while a paired device is connected. SetThreadExecutionState only lasts
// as long as the calling thread, so one long-lived thread owns it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;
use std::time::Duration;

static WANTED: AtomicBool = AtomicBool::new(false);
static START: Once = Once::new();

#[cfg(windows)]
fn set_awake(on: bool) {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED};
    unsafe {
        SetThreadExecutionState(if on { ES_CONTINUOUS | ES_DISPLAY_REQUIRED } else { ES_CONTINUOUS });
    }
}

#[cfg(not(windows))]
fn set_awake(_on: bool) {}

pub fn set_wanted(wanted: bool) {
    WANTED.store(wanted, Ordering::SeqCst);
    START.call_once(|| {
        std::thread::spawn(|| {
            let mut applied = false;
            loop {
                let want = WANTED.load(Ordering::SeqCst);
                if want != applied || want {
                    set_awake(want);
                    applied = want;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        });
    });
}
