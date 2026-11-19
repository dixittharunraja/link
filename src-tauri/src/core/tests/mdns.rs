use crate::core::mdns::{epoch_at, instance_id, instance_of_fullname, pick_ipv4, trusted_instances};
use std::net::Ipv4Addr;

// Vector computed independently of this code (Node crypto):
//   sha256(b"link-mdns-v1" + b"device-1" + 8-byte big-endian 123456).hexdigest()[:16]
// The Android core (LinkMdns.java) must produce the same text.
#[test]
fn instance_id_matches_the_independent_vector() {
    assert_eq!(instance_id("device-1", 123456), "c021ed360f28d6bb");
}

#[test]
fn instance_id_is_16_hex_and_rotates_hourly() {
    let a = instance_id("device-1", 10);
    assert_eq!(a.len(), 16);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, instance_id("device-1", 11));
    assert_ne!(a, instance_id("device-2", 10));
    assert_eq!(a, instance_id("device-1", 10));
}

#[test]
fn epoch_changes_on_the_hour() {
    assert_eq!(epoch_at(3599), 0);
    assert_eq!(epoch_at(3600), 1);
    assert_eq!(epoch_at(7199), 1);
}

#[test]
fn trusted_instances_cover_the_neighbouring_hours_only() {
    let ids = vec!["a".to_string(), "b".to_string()];
    let map = trusted_instances(&ids, 100);
    assert_eq!(map.get(&instance_id("a", 99)).map(String::as_str), Some("a"));
    assert_eq!(map.get(&instance_id("b", 101)).map(String::as_str), Some("b"));
    assert!(!map.contains_key(&instance_id("a", 102)));
    assert!(!map.contains_key(&instance_id("stranger", 100)));
}

#[test]
fn instance_is_read_from_the_record_name() {
    assert_eq!(instance_of_fullname("0123456789abcdef._link._tcp.local."), Some("0123456789abcdef"));
    assert_eq!(instance_of_fullname("x._other._tcp.local."), None);
}

#[test]
fn pick_ipv4_prefers_the_local_subnet_and_skips_unusable_addresses() {
    let own = [(Ipv4Addr::new(192, 168, 1, 5), Ipv4Addr::new(255, 255, 255, 0))];
    let found = [Ipv4Addr::new(10, 0, 0, 9), Ipv4Addr::new(192, 168, 1, 20), Ipv4Addr::new(169, 254, 1, 1), Ipv4Addr::LOCALHOST];
    assert_eq!(pick_ipv4(found, &own), Some(Ipv4Addr::new(192, 168, 1, 20)));
    assert_eq!(pick_ipv4([Ipv4Addr::new(10, 0, 0, 9)], &own), Some(Ipv4Addr::new(10, 0, 0, 9)));
    assert_eq!(pick_ipv4([Ipv4Addr::LOCALHOST, Ipv4Addr::new(169, 254, 1, 1)], &own), None);
}

// Needs a network interface with multicast, so it is run by hand: cargo test --lib mdns_roundtrip -- --ignored
#[test]
#[ignore]
fn mdns_roundtrip_between_two_daemons() {
    use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
    use std::collections::HashMap;
    let id = instance_id("device-1", 1);
    let info = ServiceInfo::new(crate::core::mdns::SERVICE_TYPE, &id, &format!("{id}.local."), "", 1739, None::<HashMap<String, String>>)
        .expect("a service with no address and no TXT data is valid")
        .enable_addr_auto();
    let server = ServiceDaemon::new().unwrap();
    server.register(info).unwrap();
    let client = ServiceDaemon::new().unwrap();
    let rx = client.browse(crate::core::mdns::SERVICE_TYPE).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if let Ok(ServiceEvent::ServiceResolved(service)) = rx.recv_timeout(std::time::Duration::from_secs(1)) {
            assert_eq!(instance_of_fullname(service.get_fullname()), Some(id.as_str()));
            assert!(service.txt_properties.iter().next().is_none());
            let _ = server.shutdown();
            let _ = client.shutdown();
            return;
        }
    }
    panic!("the service was not resolved");
}
