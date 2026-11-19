use crate::core::discovery::privacy_token;

// A hidden device announces only this token, and the other side recognises it by computing the same
// value. The expected string comes from an independent SHA-256 (Node's crypto), which is what
// LinkDiscovery.computePrivacyToken on Android computes too: lowercase hex, first 32 digits.
#[test]
fn privacy_token_matches_the_android_computation() {
    assert_eq!(privacy_token("device-123", "ab12cd"), "9658d2b2c41171343ad5e2fa60f48806");
}

#[test]
fn privacy_token_depends_on_both_id_and_fingerprint() {
    let base = privacy_token("device-123", "ab12cd");
    assert_ne!(base, privacy_token("device-124", "ab12cd"));
    assert_ne!(base, privacy_token("device-123", "ab12ce"));
    assert_eq!(base.len(), 32);
}
