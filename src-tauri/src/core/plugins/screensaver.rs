// Keeps the display awake while a paired device is connected. SetThreadExecutionState only lasts
// as long as the calling thread, so one long-lived thread owns it. ES_CONTINUOUS holds until it is
// changed, so the thread sleeps until asked to switch rather than waking on a timer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

static WANTED: AtomicBool = AtomicBool::new(false);
static OWNER: OnceLock<Mutex<Sender<bool>>> = OnceLock::new();

#[cfg(windows)]
fn set_awake(on: bool) {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED};
    unsafe {
        SetThreadExecutionState(if on { ES_CONTINUOUS | ES_DISPLAY_REQUIRED } else { ES_CONTINUOUS });
    }
}

#[cfg(not(windows))]
fn set_awake(_on: bool) {}

fn owner() -> &'static Mutex<Sender<bool>> {
    OWNER.get_or_init(|| {
        let (tx, rx) = channel::<bool>();
        let _ = std::thread::Builder::new().name("link-screensaver".into()).spawn(move || {
            let mut applied = false;
            while let Ok(want) = rx.recv() {
                if want != applied {
                    set_awake(want);
                    applied = want;
                }
            }
        });
        Mutex::new(tx)
    })
}

pub fn set_wanted(wanted: bool) {
    if WANTED.swap(wanted, Ordering::SeqCst) == wanted && OWNER.get().is_some() {
        return;
    }
    // Sent under the lock and read back from WANTED, so two racing callers still leave the latest value applied.
    let tx = owner().lock().unwrap_or_else(|e| e.into_inner());
    let _ = tx.send(WANTED.load(Ordering::SeqCst));
}
