//! PKCE S256 helpers: random verifier/state + SHA-256 challenge.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// 32 random bytes → base64url (no pad) = 43 ASCII chars. RFC 7636 §4.1
/// requires verifier length between 43 and 128.
pub fn generate_verifier() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 24 random bytes → base64url (no pad) = 32 ASCII chars. CSRF state token.
pub fn generate_state() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// S256 challenge = base64url(SHA256(verifier)).
pub fn challenge_from_verifier(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}
