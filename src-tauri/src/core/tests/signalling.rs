// WebRTC signalling from the viewer (answers and ICE candidates) arrives as JSON from another device.
// Anything malformed must be ignored, never half-applied.

use serde_json::json;

use crate::core::rtc_share::{parse_signal, Signal};

#[test]
fn an_answer_is_read_with_its_sdp() {
    match parse_signal(&json!({ "type": "webrtc_answer", "sdp": "v=0..." })) {
        Some(Signal::Answer(sdp)) => assert_eq!(sdp, "v=0..."),
        _ => panic!("expected an answer"),
    }
}

#[test]
fn a_candidate_is_read_with_its_fields() {
    let body = json!({
        "type": "webrtc_candidate",
        "candidate": { "candidate": "candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host", "sdpMid": "0", "sdpMLineIndex": 0 }
    });
    match parse_signal(&body) {
        Some(Signal::Candidate(c)) => {
            assert!(c.candidate.starts_with("candidate:1"));
            assert_eq!(c.sdp_mid.as_deref(), Some("0"));
            assert_eq!(c.sdp_mline_index, Some(0));
        }
        _ => panic!("expected a candidate"),
    }
}

#[test]
fn a_candidate_without_optional_fields_is_still_accepted() {
    let body = json!({ "type": "webrtc_candidate", "candidate": { "candidate": "candidate:2 1 udp 1 10.0.0.2 4000 typ host" } });
    match parse_signal(&body) {
        Some(Signal::Candidate(c)) => {
            assert!(c.sdp_mid.is_none());
            assert!(c.sdp_mline_index.is_none());
        }
        _ => panic!("expected a candidate"),
    }
}

#[test]
fn malformed_or_unrelated_signals_are_ignored() {
    assert!(parse_signal(&json!({ "type": "webrtc_answer" })).is_none(), "an answer without sdp");
    assert!(parse_signal(&json!({ "type": "webrtc_answer", "sdp": 5 })).is_none(), "sdp that is not text");
    assert!(parse_signal(&json!({ "type": "webrtc_candidate" })).is_none(), "a candidate without its object");
    assert!(parse_signal(&json!({ "type": "webrtc_candidate", "candidate": {} })).is_none(), "an empty candidate");
    assert!(parse_signal(&json!({ "type": "request" })).is_none(), "other signal types are not WebRTC");
    assert!(parse_signal(&json!({})).is_none());
    assert!(parse_signal(&json!("text")).is_none());
}
