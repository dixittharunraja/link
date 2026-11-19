use std::time::{Duration, Instant};

use crate::core::pairing_window::{Admission, PairingWindow, TOKEN_LIFETIME, WINDOW_LIFETIME};

#[test]
fn a_visible_device_takes_ordinary_requests_at_any_time() {
    let mut window = PairingWindow::default();
    let now = Instant::now();
    assert_eq!(window.admit(None, true, now), Admission::Manual, "no Add Device screen needed");
}

#[test]
fn a_hidden_device_refuses_requests_without_a_token() {
    let mut window = PairingWindow::default();
    let now = Instant::now();
    assert_eq!(window.admit(None, false, now), Admission::Closed);
    window.open(now);
    assert_eq!(window.admit(None, false, now), Admission::Closed, "an open QR does not make it pairable by anyone");
}

#[test]
fn a_token_needs_the_qr_to_be_on_screen() {
    let mut window = PairingWindow::default();
    let now = Instant::now();
    assert_eq!(window.admit(Some("anything"), true, now), Admission::Closed);
    let token = window.open(now);
    window.close();
    assert_eq!(window.admit(Some(&token), false, now), Admission::Closed);
}

#[test]
fn the_window_closes_by_itself() {
    let mut window = PairingWindow::default();
    let now = Instant::now();
    let token = window.open(now);
    assert_eq!(window.admit(Some(&token), false, now + WINDOW_LIFETIME + Duration::from_secs(1)), Admission::Closed);
}

#[test]
fn a_token_works_once_even_on_a_hidden_device() {
    let mut window = PairingWindow::default();
    let now = Instant::now();
    let token = window.open(now);
    assert_eq!(window.admit(Some(&token), false, now), Admission::Qr);
    // The second device to present the same QR is refused and reported.
    assert_eq!(window.admit(Some(&token), false, now), Admission::Conflict);
}

#[test]
fn a_wrong_or_expired_token_is_refused() {
    let mut window = PairingWindow::default();
    let now = Instant::now();
    let token = window.open(now);
    assert_eq!(window.admit(Some("not-the-token"), true, now), Admission::BadToken);
    assert_eq!(window.admit(Some(&token), true, now + TOKEN_LIFETIME + Duration::from_secs(1)), Admission::BadToken);
}

#[test]
fn a_refreshed_token_replaces_the_old_one() {
    let mut window = PairingWindow::default();
    let now = Instant::now();
    let first = window.open(now);
    let second = window.refresh(now).expect("open window");
    assert_ne!(first, second);
    assert_eq!(window.admit(Some(&first), false, now), Admission::BadToken);
    assert_eq!(window.admit(Some(&second), false, now), Admission::Qr);
}

#[test]
fn nothing_is_minted_while_closed() {
    let mut window = PairingWindow::default();
    assert!(window.refresh(Instant::now()).is_none());
}
