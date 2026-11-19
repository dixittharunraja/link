use std::net::Ipv4Addr;

use crate::core::tailnet::{TailnetPeer, parse_status};

#[test]
fn lists_online_peers_by_ipv4_address() {
    let status = r#"{
        "Self": { "HostName": "this-pc", "TailscaleIPs": ["100.64.0.1"], "Online": true },
        "Peer": {
            "nodekey:a": { "HostName": "phone", "TailscaleIPs": ["fd7a:115c:a1e0::2", "100.64.0.2"], "Online": true },
            "nodekey:b": { "HostName": "asleep", "TailscaleIPs": ["100.64.0.3"], "Online": false },
            "nodekey:c": { "HostName": "v6-only", "TailscaleIPs": ["fd7a:115c:a1e0::4"], "Online": true }
        }
    }"#;
    assert_eq!(parse_status(status), vec![TailnetPeer { name: "phone".into(), address: Ipv4Addr::new(100, 64, 0, 2) }]);
}

#[test]
fn unusable_output_gives_no_peers() {
    assert!(parse_status("").is_empty());
    assert!(parse_status("not json").is_empty());
    assert!(parse_status("{}").is_empty());
    assert!(parse_status(r#"{"Peer": null}"#).is_empty());
}
