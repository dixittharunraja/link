use crate::core::guest::{GuestHub, query_token};
use crate::core::pairing_window::Admission;

#[test]
fn the_token_is_read_from_the_address_dialled() {
    assert_eq!(query_token(Some("t=abc123")).as_deref(), Some("abc123"));
    assert_eq!(query_token(Some("x=1&t=abc123&y=2")).as_deref(), Some("abc123"));
    assert_eq!(query_token(Some("t=")), None);
    assert_eq!(query_token(Some("other=1")), None);
    assert_eq!(query_token(None), None);
}

#[test]
fn a_guest_with_the_tools_token_is_a_qr_guest_once() {
    let hub = GuestHub::default();
    let token = hub.open_qr(1748);
    assert_eq!(hub.admit(1748, Some(&token)), Admission::Qr);
    assert_eq!(hub.admit(1748, Some(&token)), Admission::Conflict, "the second guest on the same code is refused");
}

#[test]
fn a_guest_without_a_token_goes_through_the_pin() {
    let hub = GuestHub::default();
    assert_eq!(hub.admit(1748, None), Admission::Manual, "typing the address still works");
}

#[test]
fn a_token_is_only_good_for_the_tool_that_issued_it() {
    let hub = GuestHub::default();
    let joystick = hub.open_qr(1748);
    hub.open_qr(1749);
    assert_eq!(hub.admit(1749, Some(&joystick)), Admission::BadToken);
}

#[test]
fn a_token_needs_the_code_to_be_on_screen() {
    let hub = GuestHub::default();
    assert_eq!(hub.admit(1748, Some("anything")), Admission::Closed, "nothing was ever shown");
    let token = hub.open_qr(1748);
    hub.close_qr(1748);
    assert_eq!(hub.admit(1748, Some(&token)), Admission::Closed);
}

#[test]
fn a_scanned_code_is_used_once_for_each_address_it_names() {
    let hub = GuestHub::default();
    hub.remember_scan("192.168.1.5, 10.0.0.2", "AB12", "tok");
    let scan = hub.take_scan("192.168.1.5").expect("remembered");
    assert_eq!((scan.fingerprint.as_str(), scan.token.as_str()), ("ab12", "tok"));
    assert!(hub.take_scan("192.168.1.5").is_none(), "used up");
    assert!(hub.take_scan("10.0.0.2").is_some(), "the other address still has it");
    assert!(hub.take_scan("172.16.0.9").is_none());
}
