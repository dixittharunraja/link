// Text clipboard sync. Polls the OS clipboard for local changes and applies text from peers.
// Images and copied files (link.clipboard.file) are not synced yet.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct State {
    last_seen: String,
    updated_at: i64,
    // Set when we write a remote value so the next poll doesn't echo it back to the sender.
    suppress_next: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let state = guard.get_or_insert_with(|| State { last_seen: read_text().unwrap_or_default(), updated_at: now_ms(), suppress_next: false });
    f(state)
}

/// Returns new local text if the clipboard changed since the last poll.
pub fn poll() -> Option<String> {
    let current = read_text()?;
    with_state(|state| {
        if state.suppress_next {
            state.suppress_next = false;
            return None;
        }
        if current == state.last_seen {
            return None;
        }
        state.last_seen = current.clone();
        if current.is_empty() {
            return None;
        }
        state.updated_at = now_ms();
        Some(current)
    })
}

pub fn apply_remote(text: &str) {
    with_state(|state| {
        state.suppress_next = true;
        state.last_seen = text.to_string();
        state.updated_at = now_ms();
    });
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        let _ = clipboard.set_text(text.to_string());
    }
}

/// (content, timestamp) sent to a peer right after it connects, so it can adopt the newer value.
pub fn snapshot() -> (String, i64) {
    with_state(|state| (state.last_seen.clone(), state.updated_at))
}
