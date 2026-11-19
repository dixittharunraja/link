use std::collections::HashMap;

use serde_json::json;

use super::helpers::{TempDir, pem};
use crate::core::pool::{Me, learn, sync_list};
use crate::core::trust::{TrustStore, TrustedDevice};

fn paired(id: &str, body: &str, ip: Option<&str>) -> TrustedDevice {
    TrustedDevice {
        device_id: id.into(),
        device_name: format!("Device {id}"),
        cert_pem: pem(body),
        paired_at: 1,
        ip_address: ip.map(str::to_string),
        tailscale_ip: None,
    }
}

fn entry(id: &str, body: &str, ip: &str) -> serde_json::Value {
    json!({ "deviceId": id, "deviceName": format!("Device {id}"), "certPem": pem(body), "lastKnownIp": ip })
}

fn never_blocked(_: &str) -> bool {
    false
}

#[test]
fn a_list_names_every_paired_device_and_this_one() {
    let dir = TempDir::new("pool-list");
    let mut store = TrustStore::new(dir.path());
    store.pair(paired("phone1", "AQID", Some("192.168.1.20")));
    let me_pem = pem("BAUG");
    let me = Me { device_id: "lap", device_name: "Laptop", cert_pem: &me_pem };
    let live = HashMap::new();

    let list = sync_list(&store, &me, &live);
    let ids: Vec<_> = list.iter().map(|e| e["deviceId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["phone1", "lap"]);
    assert_eq!(list[0]["lastKnownIp"], "192.168.1.20");
    assert_eq!(list[1]["certPem"], me_pem.as_str());
}

#[test]
fn a_missing_address_falls_back_to_the_live_connection() {
    let dir = TempDir::new("pool-live");
    let mut store = TrustStore::new(dir.path());
    store.pair(paired("phone1", "AQID", None));
    let me_pem = pem("BAUG");
    let me = Me { device_id: "lap", device_name: "Laptop", cert_pem: &me_pem };
    let live = HashMap::from([("phone1".to_string(), "10.0.0.7".to_string())]);
    assert_eq!(sync_list(&store, &me, &live)[0]["lastKnownIp"], "10.0.0.7");
}

#[test]
fn a_device_introduced_by_a_paired_one_is_learned() {
    let dir = TempDir::new("pool-learn");
    let mut store = TrustStore::new(dir.path());
    store.pair(paired("phone1", "AQID", Some("192.168.1.20")));

    // phone1 pairs with phone2 while this laptop is offline; later phone1 sends its list.
    let entries = vec![entry("phone1", "AQID", "192.168.1.20"), entry("phone2", "BAUG", "192.168.1.30"), entry("lap", "CAkK", "")];
    let learned = learn(&mut store, &entries, &[], "lap", "phone1", "192.168.1.20", &never_blocked);

    assert_eq!(learned.added, vec!["phone2".to_string()], "this device itself and the sender are not added again");
    let phone2 = store.get("phone2").expect("phone2 is in the pool now");
    assert_eq!(phone2.ip_address.as_deref(), Some("192.168.1.30"));
}

#[test]
fn the_senders_own_entry_gets_the_address_the_list_came_from() {
    let dir = TempDir::new("pool-sender-ip");
    let mut store = TrustStore::new(dir.path());
    store.pair(paired("phone1", "AQID", None));
    learn(&mut store, &[entry("phone1", "AQID", "")], &[], "lap", "phone1", "192.168.1.20", &never_blocked);
    assert_eq!(store.get("phone1").unwrap().ip_address.as_deref(), Some("192.168.1.20"));
}

#[test]
fn a_list_can_never_replace_a_certificate_already_trusted() {
    let dir = TempDir::new("pool-pinned");
    let mut store = TrustStore::new(dir.path());
    store.pair(paired("phone1", "AQID", Some("192.168.1.20")));
    let learned = learn(&mut store, &[entry("phone1", "BAUG", "192.168.1.99")], &[], "lap", "phone2", "10.0.0.2", &never_blocked);
    assert!(learned.added.is_empty());
    assert_eq!(store.get("phone1").unwrap().cert_pem, pem("AQID"), "the pinned certificate stays");
}

#[test]
fn blocked_devices_and_unreadable_certificates_are_not_added() {
    let dir = TempDir::new("pool-refused");
    let mut store = TrustStore::new(dir.path());
    let entries = vec![entry("banned", "AQID", "10.0.0.5"), entry("broken", "not base64 !!", "10.0.0.6"), entry("fine", "BAUG", "10.0.0.7")];
    let learned = learn(&mut store, &entries, &[], "lap", "phone1", "10.0.0.2", &|id| id == "banned");
    assert_eq!(learned.added, vec!["fine".to_string()]);
    assert!(!store.is_paired("banned"));
    assert!(!store.is_paired("broken"));
}

#[test]
fn an_empty_or_malformed_list_changes_nothing() {
    let dir = TempDir::new("pool-empty");
    let mut store = TrustStore::new(dir.path());
    let before = store.compute_pool_hash();
    learn(&mut store, &[json!({}), json!({ "deviceId": "" }), json!("text"), json!(null)], &[], "lap", "phone1", "10.0.0.2", &never_blocked);
    assert_eq!(store.compute_pool_hash(), before);
}

fn entry_at(id: &str, body: &str, paired_at: i64) -> serde_json::Value {
    json!({ "deviceId": id, "deviceName": format!("Device {id}"), "certPem": pem(body), "lastKnownIp": "", "pairedAt": paired_at })
}

#[test]
fn a_device_removed_here_is_not_brought_back_by_a_member_that_missed_it() {
    let dir = TempDir::new("pool-tombstone");
    let mut store = TrustStore::new(dir.path());
    store.pair(paired("phone1", "AQID", None));
    store.pair(paired("tv", "BAUG", None));
    assert!(store.remove_device("tv", 1_000));

    // phone1 was offline for the removal and still lists the tv, paired before it.
    let learned = learn(&mut store, &[entry_at("tv", "BAUG", 500)], &[], "lap", "phone1", "10.0.0.2", &never_blocked);
    assert!(learned.added.is_empty());
    assert!(!store.is_paired("tv"));
    assert_eq!(learned.stale, vec![("tv".to_string(), 1_000)], "the sender is told to drop it");
}

#[test]
fn a_removal_in_a_list_drops_the_device_and_is_remembered() {
    let dir = TempDir::new("pool-removal");
    let mut store = TrustStore::new(dir.path());
    store.pair(paired("phone1", "AQID", None));
    store.pair(paired("tv", "BAUG", None));

    let learned = learn(&mut store, &[], &[json!({ "deviceId": "tv", "removedAt": 5_000 })], "lap", "phone1", "10.0.0.2", &never_blocked);
    assert_eq!(learned.removed, vec!["tv".to_string()]);
    assert!(!store.is_paired("tv"));
    assert_eq!(store.removed_at("tv"), Some(5_000), "kept, so it can be passed on");
}

#[test]
fn pairing_again_after_a_removal_wins_over_it() {
    let dir = TempDir::new("pool-repair");
    let mut store = TrustStore::new(dir.path());
    store.remove_device("tv", 9_000);

    // A list that carries a pairing made after the removal brings the device back.
    let learned = learn(&mut store, &[entry_at("tv", "BAUG", 9_500)], &[], "lap", "phone1", "10.0.0.2", &never_blocked);
    assert_eq!(learned.added, vec!["tv".to_string()]);
    assert_eq!(store.removed_at("tv"), None);

    // A direct pairing is newer than the removal even when this clock is behind.
    let mut other = TrustStore::new(TempDir::new("pool-repair-direct").path());
    other.remove_device("tv", 9_000);
    other.pair(paired("tv", "BAUG", None));
    assert!(other.get("tv").unwrap().paired_at > 9_000);
}

#[test]
fn an_older_removal_does_not_drop_a_newer_pairing() {
    let dir = TempDir::new("pool-newer-pairing");
    let mut store = TrustStore::new(dir.path());
    let mut tv = paired("tv", "BAUG", None);
    tv.paired_at = 10_000;
    store.pair(tv);

    let learned = learn(&mut store, &[], &[json!({ "deviceId": "tv", "removedAt": 4_000 })], "lap", "phone1", "10.0.0.2", &never_blocked);
    assert!(learned.removed.is_empty());
    assert!(store.is_paired("tv"));
}

#[test]
fn removals_survive_a_restart() {
    let dir = TempDir::new("pool-removal-saved");
    {
        let mut store = TrustStore::new(dir.path());
        store.remove_device("tv", 7_000);
    }
    assert_eq!(TrustStore::new(dir.path()).removed_at("tv"), Some(7_000));
}
