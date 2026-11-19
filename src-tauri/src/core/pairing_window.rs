// Who may ask this device to pair, and the one-time token in its QR code.
//
// Pairing is the only door into a trusted relationship, so there are two ways in, and both end at an
// Accept button on this device:
//   - A device that is visible (Device Visibility on: "new devices can discover and pair") accepts
//     ordinary requests at any time, verified by comparing the code on both screens.
//   - A hidden device ("trusted devices only") accepts only a request that carries the one-time token
//     from its QR. The QR carries this device's key fingerprint (so the scanner can tell it reached the
//     right device, with no code to compare) and the token (so a photo of an old QR, or a second
//     device racing the first, gets nothing). The token is valid only while the Add Device screen
//     that shows the QR is open.

use std::time::{Duration, Instant};

/// How long a QR code's token works.
pub const TOKEN_LIFETIME: Duration = Duration::from_secs(120);
/// A safety cap: the window closes by itself if the screen that opened it never reports closing.
pub const WINDOW_LIFETIME: Duration = Duration::from_secs(600);

/// What to do with an incoming pair request.
#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    /// Not accepting this request: answer no, show nothing.
    Closed,
    /// No token, from a visible device: an ordinary request, verified by comparing the code on both screens.
    Manual,
    /// A valid one-time token: the scanner already verified this device, ask the user to approve.
    Qr,
    /// The token was already used, which means someone else got there first (or replayed it).
    Conflict,
    /// A token this device did not issue, or an expired one.
    BadToken,
}

#[derive(Default)]
pub struct PairingWindow {
    open_until: Option<Instant>,
    token: Option<(String, Instant)>,
    last_used: Option<String>,
}

fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl PairingWindow {
    /// Opens the window and returns a fresh token for the QR.
    pub fn open(&mut self, now: Instant) -> String {
        self.open_until = Some(now + WINDOW_LIFETIME);
        self.mint(now)
    }

    /// A new token for the QR (after the old one was used or is about to expire), if the window is open.
    pub fn refresh(&mut self, now: Instant) -> Option<String> {
        self.is_open(now).then(|| self.mint(now))
    }

    pub fn close(&mut self) {
        self.open_until = None;
        self.token = None;
    }

    pub fn is_open(&self, now: Instant) -> bool {
        self.open_until.is_some_and(|until| now < until)
    }

    fn mint(&mut self, now: Instant) -> String {
        let token = new_token();
        self.token = Some((token.clone(), now + TOKEN_LIFETIME));
        token
    }

    /// Judges a pair request; `visible` is this device's Device Visibility setting. A valid token is used
    /// up by this call.
    pub fn admit(&mut self, presented: Option<&str>, visible: bool, now: Instant) -> Admission {
        let Some(presented) = presented else {
            return if visible { Admission::Manual } else { Admission::Closed };
        };
        // A token only exists while the QR is on screen.
        if !self.is_open(now) {
            return Admission::Closed;
        }
        if let Some((token, expires)) = &self.token {
            if token == presented && now < *expires {
                self.last_used = self.token.take().map(|(token, _)| token);
                return Admission::Qr;
            }
        }
        if self.last_used.as_deref() == Some(presented) { Admission::Conflict } else { Admission::BadToken }
    }
}
