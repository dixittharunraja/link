use sha2::{Digest, Sha256};

/// Computes the out-of-band verification PIN strictly according to Equation (3) from the paper:
/// Code_{B,C} = Hex(SHA-256(max(K_B, K_C) || min(K_B, K_C) || Salt))[0..7]
pub fn compute_verification_code(key_der_a: &[u8], key_der_b: &[u8], salt: &str) -> String {
    let (max_k, min_k) = if key_der_a >= key_der_b {
        (key_der_a, key_der_b)
    } else {
        (key_der_b, key_der_a)
    };

    let mut hasher = Sha256::new();
    hasher.update(max_k);
    hasher.update(min_k);
    hasher.update(salt.as_bytes());
    
    let full_hash = hex::encode(hasher.finalize()).to_uppercase();
    full_hash.chars().take(8).collect()
}
