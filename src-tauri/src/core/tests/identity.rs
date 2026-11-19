// A device's identity (id, name, certificate) is created once and must never change by itself: peers pin
// the certificate, so a new one would look like an impostor. Names are filtered so they cannot break the
// wire format.

use super::helpers::TempDir;
use crate::core::identity::{filter_device_name, load_or_create_identity, save_device_name};

#[test]
fn reserved_characters_are_removed_from_names() {
    assert_eq!(filter_device_name("Sam's \"PC\": (home); [main] <1>!?.,"), "Sams PC home main 1");
}

#[test]
fn names_are_capped_at_20_characters_counting_letters_not_bytes() {
    let long = "é".repeat(40);
    let filtered = filter_device_name(&long);
    assert_eq!(filtered.chars().count(), 20);
    assert_eq!(filter_device_name("Short name"), "Short name");
}

#[test]
fn the_identity_is_created_once_and_reused() {
    let dir = TempDir::new("identity-reuse");
    let first = load_or_create_identity(dir.path()).expect("created");
    let second = load_or_create_identity(dir.path()).expect("loaded");
    assert!(first.device_id.len() >= 32, "device ids are long enough to be unique");
    assert_eq!(first.device_id, second.device_id);
    assert_eq!(first.cert_pem, second.cert_pem, "the certificate peers pinned must not change");
    assert_eq!(first.fingerprint, second.fingerprint);
    assert!(!first.fingerprint.is_empty());
}

#[test]
fn a_rename_is_filtered_saved_and_keeps_the_same_identity() {
    let dir = TempDir::new("identity-rename");
    let before = load_or_create_identity(dir.path()).unwrap();
    let stored = save_device_name(dir.path(), "Living room: PC!").unwrap();
    assert_eq!(stored, "Living room PC");
    let after = load_or_create_identity(dir.path()).unwrap();
    assert_eq!(after.device_name, "Living room PC");
    assert_eq!(after.device_id, before.device_id);
    assert_eq!(after.cert_pem, before.cert_pem);
}

#[test]
fn only_addresses_in_tailscales_range_count_as_remote() {
    use crate::core::identity::is_tailscale_addr;
    assert!(is_tailscale_addr("100.64.0.1"));
    assert!(is_tailscale_addr("100.127.255.254"));
    assert!(!is_tailscale_addr("100.63.255.255"), "just below the range");
    assert!(!is_tailscale_addr("100.128.0.1"), "just above the range");
    assert!(!is_tailscale_addr("192.168.1.20"));
    assert!(!is_tailscale_addr("fd7a:115c:a1e0::1"), "only IPv4 is used");
    assert!(!is_tailscale_addr("not an address"));
}
