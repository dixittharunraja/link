// Plugin packets reach the UI only when it has a handler for them: an exact type, or a "prefix*" key.

use crate::core::transport::PacketSubscriptions;

fn subs(keys: &[&str]) -> PacketSubscriptions {
    PacketSubscriptions::new(keys.iter().map(|k| k.to_string()).collect())
}

#[test]
fn exact_types_match_only_themselves() {
    let s = subs(&["link.battery"]);
    assert!(s.wants("link.battery"));
    assert!(!s.wants("link.battery.request"));
    assert!(!s.wants("link.clipboard"));
}

#[test]
fn a_trailing_star_matches_every_type_with_that_prefix() {
    let s = subs(&["link.walkietalkie.*"]);
    assert!(s.wants("link.walkietalkie.offer"));
    assert!(s.wants("link.walkietalkie.answer"));
    assert!(!s.wants("link.walkie"));
    assert!(!s.wants("link.battery"));
}

#[test]
fn nothing_subscribed_means_nothing_is_wanted() {
    assert!(!subs(&[]).wants("link.battery"));
}
