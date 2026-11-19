// The control channel carries one JSON packet per line. A reader that mishandled a packet split across
// reads, or let one bad line stop the stream, would silently drop commands between devices.

use serde_json::json;

use crate::core::packet::{LinkPacket, PacketStreamReader};

fn line(packet_type: &str, n: i64) -> Vec<u8> {
    LinkPacket::new(packet_type, json!({ "n": n })).serialize().unwrap()
}

#[test]
fn a_serialized_packet_is_one_json_line_with_the_wire_field_names() {
    let bytes = LinkPacket::new("link.ping", json!({ "hello": true })).serialize().unwrap();
    assert_eq!(bytes.last(), Some(&b'\n'));
    assert_eq!(bytes.iter().filter(|&&b| b == b'\n').count(), 1, "exactly one newline, at the end");

    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["type"], "link.ping");
    assert_eq!(value["body"]["hello"], true);
    assert!(value["id"].is_i64());
    // Optional payload fields are left out rather than sent as null.
    assert!(value.get("payloadSize").is_none());
    assert!(value.get("payloadTransferInfo").is_none());
}

#[test]
fn several_packets_in_one_read_all_come_out_in_order() {
    let mut reader = PacketStreamReader::new();
    let mut chunk = line("link.a", 1);
    chunk.extend(line("link.b", 2));
    chunk.extend(line("link.c", 3));
    let types: Vec<String> = reader.push(&chunk).into_iter().map(|p| p.packet_type).collect();
    assert_eq!(types, ["link.a", "link.b", "link.c"]);
}

#[test]
fn a_packet_split_across_reads_is_reassembled() {
    let mut reader = PacketStreamReader::new();
    let bytes = line("link.split", 7);
    let (first, rest) = bytes.split_at(bytes.len() / 2);
    assert!(reader.push(first).is_empty(), "nothing is complete yet");
    let packets = reader.push(rest);
    assert_eq!(packets.len(), 1);
    assert_eq!(packets[0].packet_type, "link.split");
    assert_eq!(packets[0].body["n"], 7);
}

#[test]
fn byte_by_byte_delivery_still_works() {
    let mut reader = PacketStreamReader::new();
    let mut got = Vec::new();
    for b in line("link.slow", 1) {
        got.extend(reader.push(&[b]));
    }
    assert_eq!(got.len(), 1);
}

#[test]
fn crlf_line_endings_and_blank_lines_are_accepted() {
    let mut reader = PacketStreamReader::new();
    let mut chunk = b"\r\n\n".to_vec();
    let mut first = line("link.crlf", 1);
    first.pop();
    chunk.extend(first);
    chunk.extend(b"\r\n");
    let packets = reader.push(&chunk);
    assert_eq!(packets.len(), 1);
    assert_eq!(packets[0].packet_type, "link.crlf");
}

#[test]
fn a_malformed_line_is_skipped_without_losing_the_next_packet() {
    let mut reader = PacketStreamReader::new();
    let mut chunk = b"{not json at all}\n{\"type\":\"missing id and body\"}\n".to_vec();
    chunk.extend(line("link.after", 1));
    let packets = reader.push(&chunk);
    assert_eq!(packets.len(), 1);
    assert_eq!(packets[0].packet_type, "link.after");
}

#[test]
fn a_line_that_never_ends_is_cut_off_at_the_limit() {
    use crate::core::packet::MAX_LINE_BEFORE_IDENTITY;
    let mut reader = PacketStreamReader::new();
    let junk = vec![b'x'; 4096];
    let mut sent = 0;
    while sent <= MAX_LINE_BEFORE_IDENTITY {
        assert!(!reader.overflowed(), "overflowed after only {sent} bytes");
        assert!(reader.push(&junk).is_empty());
        sent += junk.len();
    }
    assert!(reader.overflowed(), "a peer must not grow the buffer without bound");
    // Once overflowed, the stream is dead: even a well-formed packet is not read.
    assert!(reader.push(&line("link.after", 1)).is_empty());
}

#[test]
fn a_raised_limit_admits_large_packets_from_an_identified_peer() {
    let mut reader = PacketStreamReader::new();
    reader.set_limit(crate::core::packet::MAX_LINE);
    let big = LinkPacket::new("link.big", json!({ "data": "y".repeat(1024 * 1024) })).serialize().unwrap();
    let mut got = Vec::new();
    for chunk in big.chunks(4096) {
        got.extend(reader.push(chunk));
    }
    assert!(!reader.overflowed());
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].packet_type, "link.big");
}
