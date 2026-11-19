// The blocklist keeps unwanted devices and addresses out at the transport layer; settings hold small
// preferences. Both must survive a restart and behave predictably with repeated changes.

use super::helpers::TempDir;
use crate::core::settings::{BlockEntry, Blocklist, SettingsStore};

fn entry(id: &str, ip: Option<&str>) -> BlockEntry {
    BlockEntry {
        id: id.to_string(),
        label: format!("label for {id}"),
        kind: if ip.is_some() { "ip".into() } else { "device".into() },
        blocked_at: 1_700_000_000_000,
        device_type: None,
        ip: ip.map(str::to_string),
    }
}

#[test]
fn a_blocked_device_or_address_is_recognised_after_a_restart() {
    let dir = TempDir::new("block-persist");
    let mut list = Blocklist::load(dir.path());
    list.add(entry("device-123", None));
    list.add(entry("guest-1", Some("192.168.1.50")));

    let reloaded = Blocklist::load(dir.path());
    assert!(reloaded.is_blocked("device-123"));
    assert!(reloaded.is_blocked("192.168.1.50"), "blocked by IP address");
    assert!(reloaded.is_blocked("guest-1"));
    assert!(!reloaded.is_blocked("device-456"));
}

#[test]
fn blocking_the_same_id_twice_keeps_one_entry() {
    let dir = TempDir::new("block-dupe");
    let mut list = Blocklist::load(dir.path());
    list.add(entry("device-123", None));
    list.add(entry("device-123", None));
    assert_eq!(list.entries().len(), 1);
}

#[test]
fn unblocking_is_saved() {
    let dir = TempDir::new("block-remove");
    let mut list = Blocklist::load(dir.path());
    list.add(entry("device-123", None));
    list.remove("device-123");
    assert!(!list.is_blocked("device-123"));
    assert!(!Blocklist::load(dir.path()).is_blocked("device-123"));
}

#[test]
fn settings_return_the_default_until_set_and_then_persist() {
    let dir = TempDir::new("settings");
    let mut settings = SettingsStore::load(dir.path());
    assert!(settings.get_bool("exampleFlag", true));
    assert!(!settings.get_bool("exampleFlag", false));
    settings.set_bool("exampleFlag", false);
    assert!(!SettingsStore::load(dir.path()).get_bool("exampleFlag", true));
}

#[test]
fn a_save_replaces_the_file_whole_and_leaves_no_temp_file() {
    let dir = TempDir::new("settings-atomic");
    let mut settings = SettingsStore::load(dir.path());
    settings.set_bool("first", true);
    settings.set_bool("second", false);
    let reloaded = SettingsStore::load(dir.path());
    assert!(reloaded.get_bool("first", false));
    assert!(!reloaded.get_bool("second", true));
    assert!(!dir.path().join("settings.json.tmp").exists());
}

#[test]
fn corrupt_files_fall_back_to_empty_instead_of_crashing() {
    let dir = TempDir::new("settings-corrupt");
    std::fs::write(dir.path().join("settings.json"), "not json").unwrap();
    std::fs::write(dir.path().join("blocklist.json"), "[[[").unwrap();
    assert!(SettingsStore::load(dir.path()).get_bool("anything", true));
    assert!(Blocklist::load(dir.path()).entries().is_empty());
}
