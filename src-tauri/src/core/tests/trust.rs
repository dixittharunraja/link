// The trust store is the list of paired devices. The pool hash summarises it so devices can tell whether
// they agree on who is in the pool; it must not depend on the order devices were added in, and it must
// match the Android implementation. Expected values were computed independently (Node's crypto).

use super::helpers::{pem, TempDir};
use crate::core::identity::compute_cert_fingerprint;
use crate::core::trust::{TrustStore, TrustedDevice};

fn device(id: &str, name: &str, pem_body: &str) -> TrustedDevice {
    TrustedDevice {
        device_id: id.to_string(),
        device_name: name.to_string(),
        cert_pem: pem(pem_body),
        paired_at: 1_700_000_000_000,
        ip_address: Some("192.168.1.20".into()),
        tailscale_ip: None,
    }
}

#[test]
fn the_certificate_fingerprint_is_the_sha256_of_the_der_bytes() {
    // "AQID" is base64 for the bytes 01 02 03.
    assert_eq!(compute_cert_fingerprint(&pem("AQID")), "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    assert_eq!(compute_cert_fingerprint("not base64 !!"), "", "unreadable input gives no fingerprint");
}

#[test]
fn a_paired_device_is_remembered_across_a_restart() {
    let dir = TempDir::new("trust-persist");
    let mut store = TrustStore::new(dir.path());
    assert!(!store.is_paired("aaa"));
    store.pair(device("aaa", "Phone", "AQID"));
    assert!(store.is_paired("aaa"));

    let reloaded = TrustStore::new(dir.path());
    let dev = reloaded.get("aaa").expect("still paired after reloading");
    assert_eq!(dev.device_name, "Phone");
    assert_eq!(dev.ip_address.as_deref(), Some("192.168.1.20"));
}

#[test]
fn unpairing_removes_the_device_and_is_saved() {
    let dir = TempDir::new("trust-unpair");
    let mut store = TrustStore::new(dir.path());
    store.pair(device("aaa", "Phone", "AQID"));
    let removed = store.unpair("aaa").expect("returns the removed device");
    assert_eq!(removed.device_id, "aaa");
    assert!(store.unpair("aaa").is_none(), "a second unpair is a no-op");
    assert!(!TrustStore::new(dir.path()).is_paired("aaa"));
}

#[test]
fn renaming_is_saved_and_unknown_devices_are_ignored() {
    let dir = TempDir::new("trust-rename");
    let mut store = TrustStore::new(dir.path());
    store.pair(device("aaa", "Phone", "AQID"));
    store.rename("aaa", "Shadow");
    store.rename("nobody", "Ghost");
    let reloaded = TrustStore::new(dir.path());
    assert_eq!(reloaded.get("aaa").unwrap().device_name, "Shadow");
    assert!(!reloaded.is_paired("nobody"));
}

#[test]
fn the_pool_hash_matches_an_independent_implementation() {
    let dir = TempDir::new("trust-pool-vector");
    let mut store = TrustStore::new(dir.path());
    assert_eq!(store.compute_pool_hash(), "e3b0c44298fc1c14", "empty pool");
    store.pair(device("aaa", "A", "AQID"));
    store.pair(device("bbb", "B", "BAUG"));
    assert_eq!(store.compute_pool_hash(), "ed444f404ab70d19");
}

#[test]
fn the_pool_hash_does_not_depend_on_pairing_order() {
    let one = TempDir::new("trust-order-1");
    let two = TempDir::new("trust-order-2");
    let mut first = TrustStore::new(one.path());
    first.pair(device("aaa", "A", "AQID"));
    first.pair(device("bbb", "B", "BAUG"));
    let mut second = TrustStore::new(two.path());
    second.pair(device("bbb", "B", "BAUG"));
    second.pair(device("aaa", "A", "AQID"));
    assert_eq!(first.compute_pool_hash(), second.compute_pool_hash());
}

#[test]
fn the_pool_hash_changes_when_membership_changes() {
    let dir = TempDir::new("trust-pool-change");
    let mut store = TrustStore::new(dir.path());
    store.pair(device("aaa", "A", "AQID"));
    let before = store.compute_pool_hash();
    store.pair(device("bbb", "B", "BAUG"));
    assert_ne!(before, store.compute_pool_hash());
    store.unpair("bbb");
    assert_eq!(before, store.compute_pool_hash());
}

#[test]
fn a_device_name_change_does_not_change_the_pool_hash() {
    // Only identity (device id and certificate) defines membership; names are cosmetic.
    let dir = TempDir::new("trust-pool-name");
    let mut store = TrustStore::new(dir.path());
    store.pair(device("aaa", "A", "AQID"));
    let before = store.compute_pool_hash();
    store.rename("aaa", "Renamed");
    assert_eq!(before, store.compute_pool_hash());
}

#[test]
fn a_tailscale_address_is_saved_once_and_kept_across_a_restart() {
    let dir = TempDir::new("trust-tailscale");
    let mut store = TrustStore::new(dir.path());
    store.pair(device("aaa", "Phone", "AQID"));
    assert!(store.get("aaa").unwrap().tailscale_ip.is_none());
    assert!(store.set_tailscale_ip("aaa", "100.101.102.103"), "a new address is a change");
    assert!(!store.set_tailscale_ip("aaa", "100.101.102.103"), "the same address again is not");
    assert!(!store.set_tailscale_ip("nobody", "100.64.0.1"), "an unknown device is ignored");
    assert_eq!(TrustStore::new(dir.path()).get("aaa").unwrap().tailscale_ip.as_deref(), Some("100.101.102.103"));
}

#[test]
fn a_device_saved_before_tailscale_support_still_loads() {
    let dir = TempDir::new("trust-legacy");
    let legacy = format!(
        r#"[{{"deviceId":"aaa","deviceName":"Phone","certPem":{:?},"pairedAt":1,"lastKnownIp":"192.168.1.20"}}]"#,
        pem("AQID")
    );
    std::fs::write(dir.path().join("trusted-devices.json"), legacy).unwrap();
    let store = TrustStore::new(dir.path());
    assert!(store.is_paired("aaa"));
    assert!(store.get("aaa").unwrap().tailscale_ip.is_none());
}
