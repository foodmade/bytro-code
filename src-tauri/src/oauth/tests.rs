//! Unit tests for PKCE + URL construction.
//! Network-dependent tests (exchange/refresh) live behind `--ignored`.

use super::commands::{build_authorize_url, parse_code, validate_credential_reference};
use super::pkce;
use super::{
    oauth_diagnostic_summary, public_oauth_failure, OAUTH_REFRESH_ERROR, OAUTH_SIGN_IN_REQUIRED,
};

#[test]
fn verifier_is_base64url_no_pad_43_chars() {
    let v = pkce::generate_verifier();
    assert_eq!(v.len(), 43);
    assert!(v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
}

#[test]
fn verifier_is_random() {
    let a = pkce::generate_verifier();
    let b = pkce::generate_verifier();
    assert_ne!(a, b);
}

#[test]
fn challenge_is_sha256_base64url_of_verifier() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};
    let v = pkce::generate_verifier();
    let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes()));
    assert_eq!(pkce::challenge_from_verifier(&v), expected);
}

#[test]
fn state_is_urlsafe_and_random() {
    let a = pkce::generate_state();
    let b = pkce::generate_state();
    assert_ne!(a, b);
    assert!(a.len() >= 32);
    assert!(a
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
}

#[test]
fn authorize_url_contains_required_oauth_params() {
    let url = build_authorize_url("STATE123", "CHALLENGE456").unwrap();
    assert!(url.contains("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"));
    assert!(url.contains("code_challenge=CHALLENGE456"));
    assert!(url.contains("code_challenge_method=S256"));
    assert!(url.contains("state=STATE123"));
    assert!(url.contains("response_type=code"));
    assert!(url.contains("scope="));
    assert!(url.contains("redirect_uri="));
    // URL-encoded redirect_uri
    assert!(
        url.contains("redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback")
    );
}

#[test]
fn parse_code_hash_style() {
    let (c, s) = parse_code("ABCDE#STATE");
    assert_eq!(c, "ABCDE");
    assert_eq!(s.as_deref(), Some("STATE"));
}

#[test]
fn parse_code_query_style() {
    let (c, s) = parse_code("ABCDE?state=STATE");
    assert_eq!(c, "ABCDE");
    assert_eq!(s.as_deref(), Some("STATE"));
}

#[test]
fn parse_code_ampersand_style() {
    let (c, s) = parse_code("ABCDE&state=STATE");
    assert_eq!(c, "ABCDE");
    assert_eq!(s.as_deref(), Some("STATE"));
}

#[test]
fn parse_code_plain() {
    let (c, s) = parse_code("  ABCDE  ");
    assert_eq!(c, "ABCDE");
    assert!(s.is_none());
}

#[test]
fn valid_stream_credential_reference_is_normalized_without_a_token() {
    let reference = validate_credential_reference(Some("claude"), Some(" profile-1 ")).unwrap();
    assert_eq!(reference.provider, "anthropic");
    assert_eq!(reference.profile_id, "profile-1");
}

#[test]
fn missing_stream_credential_reference_has_a_fixed_public_error() {
    assert_eq!(
        validate_credential_reference(Some("claude"), None).unwrap_err(),
        "OAuth credential reference is invalid."
    );
    assert_eq!(
        validate_credential_reference(Some("other"), Some("profile")).unwrap_err(),
        "OAuth credential reference is invalid."
    );
    assert_eq!(
        OAUTH_SIGN_IN_REQUIRED,
        "OAuth sign-in is required. Please sign in again."
    );
}

#[test]
fn refresh_and_expired_failures_share_a_fixed_reauthentication_category() {
    assert_eq!(
        OAUTH_REFRESH_ERROR,
        "OAuth session expired. Please sign in again."
    );
}

#[test]
fn private_oauth_diagnostics_never_echo_secret_or_path_text() {
    let sentinel = "ACCESS_TOKEN_SENTINEL /Users/private/oauth.json";
    let summary = oauth_diagnostic_summary("oauth.refresh", sentinel);
    assert!(!summary.contains("ACCESS_TOKEN_SENTINEL"));
    assert!(!summary.contains("/Users/private"));
    assert!(summary.contains("len="));
    assert!(summary.contains("sha256="));

    let public = public_oauth_failure("oauth.refresh", sentinel, "OAuth request failed.");
    assert_eq!(public, "OAuth request failed.");
    assert!(!public.contains("ACCESS_TOKEN_SENTINEL"));
}
