// Per-device permissions decide what a paired device may do on this PC. These tests pin down the rules:
// simple controls are always allowed, everything else needs the switch, and decisions survive a restart.

use serde_json::json;

use super::helpers::TempDir;
use crate::core::permissions::{PermissionStore, ALL_PERMISSION_KEYS, IMPLEMENTED_KEYS, UNGATED_KEYS};

const PHONE: &str = "phone-0123456789abcdef0123456789ab";

/// Keys that are behind a switch (everything that is not always allowed).
fn gated_keys() -> Vec<&'static str> {
    ALL_PERMISSION_KEYS.iter().copied().filter(|k| !UNGATED_KEYS.contains(k)).collect()
}

#[test]
fn an_unknown_device_gets_nothing_that_needs_a_switch() {
    let dir = TempDir::new("perm-unknown");
    let store = PermissionStore::load(dir.path());
    for key in gated_keys() {
        assert!(!store.check("someone-else", key), "{key} must be denied without a grant");
    }
}

#[test]
fn simple_controls_are_always_allowed() {
    let dir = TempDir::new("perm-ungated");
    let store = PermissionStore::load(dir.path());
    for key in UNGATED_KEYS {
        assert!(store.check(PHONE, key), "{key} is meant to need no switch");
    }
}

#[test]
fn a_new_pairing_starts_with_every_switch_on_and_that_survives_a_restart() {
    let dir = TempDir::new("perm-defaults");
    let mut store = PermissionStore::load(dir.path());
    store.init_defaults(PHONE);
    for key in ALL_PERMISSION_KEYS {
        assert!(store.check(PHONE, key), "{key} should start on");
    }
    drop(store);

    let reloaded = PermissionStore::load(dir.path());
    for key in ALL_PERMISSION_KEYS {
        assert!(reloaded.check(PHONE, key), "{key} should still be on after reloading");
    }
}

#[test]
fn a_permission_added_later_starts_on_for_devices_paired_before_it_and_keeps_a_choice() {
    let dir = TempDir::new("perm-fill");
    let mut store = PermissionStore::load(dir.path());
    // Paired by an older version: no "location" key, and clipboard switched off by the user.
    store.replace(json!({ PHONE: { "clipboard": false } }));
    store.fill_missing(PHONE);
    assert!(store.check(PHONE, "location"), "a new key starts on");
    assert!(!store.check(PHONE, "clipboard"), "the user's choice is kept");
    assert!(PermissionStore::load(dir.path()).check(PHONE, "location"), "the filled value is saved");
}

#[test]
fn turning_a_switch_off_blocks_that_feature_only() {
    let dir = TempDir::new("perm-revoke");
    let mut store = PermissionStore::load(dir.path());
    store.init_defaults(PHONE);

    let mut all = store.all();
    all[PHONE]["fileaccess"] = json!(false);
    store.replace(all);

    assert!(!store.check(PHONE, "fileaccess"));
    assert!(store.check(PHONE, "clipboard"), "other switches are untouched");
    assert!(!store.effective(PHONE).contains(&"fileaccess".to_string()));

    let reloaded = PermissionStore::load(dir.path());
    assert!(!reloaded.check(PHONE, "fileaccess"), "the change is saved");
}

#[test]
fn a_simple_control_cannot_be_switched_off_by_a_stored_value() {
    let dir = TempDir::new("perm-ungated-stored");
    let mut store = PermissionStore::load(dir.path());
    store.replace(json!({ PHONE: { "lock": false, "systemvolume": false } }));
    assert!(store.check(PHONE, "lock"));
    assert!(store.check(PHONE, "systemvolume"));
}

#[test]
fn forgetting_a_device_removes_all_of_its_grants() {
    let dir = TempDir::new("perm-delete");
    let mut store = PermissionStore::load(dir.path());
    store.init_defaults(PHONE);
    store.delete(PHONE);
    for key in gated_keys() {
        assert!(!store.check(PHONE, key), "{key} must be gone after forgetting the device");
    }
    assert!(PermissionStore::load(dir.path()).all().get(PHONE).is_none(), "removal is saved");
}

#[test]
fn effective_lists_only_features_this_pc_implements() {
    let dir = TempDir::new("perm-effective");
    let mut store = PermissionStore::load(dir.path());
    store.init_defaults(PHONE);
    let effective = store.effective(PHONE);
    for key in &effective {
        assert!(IMPLEMENTED_KEYS.contains(&key.as_str()), "{key} is advertised but not implemented");
    }
    // With every switch on, every implemented feature is offered.
    assert_eq!(effective.len(), IMPLEMENTED_KEYS.len());
}

#[test]
fn a_corrupt_permissions_file_denies_rather_than_crashes() {
    let dir = TempDir::new("perm-corrupt");
    std::fs::write(dir.path().join("device-permissions.json"), "{ this is not json").unwrap();
    let store = PermissionStore::load(dir.path());
    assert!(!store.check(PHONE, "fileaccess"));
    assert!(store.check(PHONE, "lock"), "always-allowed controls still work");
}
