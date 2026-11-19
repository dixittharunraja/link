// The pairing code both screens show. The phone computes it in Java (LinkPairingHandler.verificationKey and
// LinkVerification.computeCode); if the two sides ever disagreed, users would see different codes and
// could not confirm a pairing. The expected values come from an independent implementation (Node's
// crypto), using the same rule: SHA-256 over the larger key, then the smaller one (bytes compared as
// unsigned, a shorter prefix sorting first), then the salt as UTF-8; the first 8 hex digits, uppercase.

use crate::core::pairing::compute_verification_code as code;

#[test]
fn matches_independently_computed_vectors() {
    // 0x82 is above 0x7f: a signed byte comparison would order these keys the other way.
    assert_eq!(code(&[0x30, 0x82, 0x01], &[0x30, 0x7f, 0xff], "1700000000000"), "B7EF3733");
    // One key is a prefix of the other: the longer one sorts higher.
    assert_eq!(code(&[1, 2], &[1, 2, 3], ""), "20C2F234");
    // Non-ASCII salt is hashed as UTF-8.
    assert_eq!(code(&[0xff], &[0x00], "pin-ü"), "838B38A1");
}

#[test]
fn both_devices_get_the_same_code_whichever_key_is_theirs() {
    let mine = b"my-public-key-der-bytes";
    let theirs = b"their-public-key-der-bytes";
    assert_eq!(code(mine, theirs, "42"), code(theirs, mine, "42"));
}

#[test]
fn a_different_salt_gives_a_different_code() {
    let (a, b) = (b"key-a".as_slice(), b"key-b".as_slice());
    assert_ne!(code(a, b, "1"), code(a, b, "2"));
}

#[test]
fn the_code_is_eight_uppercase_hex_digits() {
    let c = code(b"one", b"two", "salt");
    assert_eq!(c.len(), 8);
    assert!(c.chars().all(|ch| ch.is_ascii_digit() || ('A'..='F').contains(&ch)), "unexpected code {c}");
}
