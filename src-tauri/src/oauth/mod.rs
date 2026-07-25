//! Anthropic OAuth 2.0 PKCE subscription login.
//!
//! Stores only OAuth account metadata and access/refresh tokens in SQLite.
//! Raw tokens never enter the WebView. Rust resolves them immediately before
//! writing a request to the local sidecar process.

pub mod commands;
pub mod pkce;
pub mod provider;
pub mod token;

#[cfg(test)]
mod tests;

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;

pub(crate) const OAUTH_STORAGE_ERROR: &str = "OAuth credentials are temporarily unavailable.";
pub(crate) const OAUTH_SIGN_IN_REQUIRED: &str = "OAuth sign-in is required. Please sign in again.";
pub(crate) const OAUTH_REFRESH_ERROR: &str = "OAuth session expired. Please sign in again.";

pub(crate) fn oauth_diagnostic_summary(category: &str, detail: &str) -> String {
    let safe_category: String = category
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_.:/-".contains(character) {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let digest = Sha256::digest(detail.as_bytes());
    format!(
        "category={} len={} sha256={:x}",
        if safe_category.is_empty() {
            "oauth"
        } else {
            &safe_category
        },
        detail.len(),
        digest
    )
}

pub(crate) fn public_oauth_failure(
    category: &str,
    detail: impl AsRef<str>,
    public_message: &str,
) -> String {
    log::warn!(
        "[oauth] {}",
        oauth_diagnostic_summary(category, detail.as_ref())
    );
    public_message.to_string()
}

/// In-memory bookkeeping for OAuth flows waiting on the user to paste a code.
pub struct PendingSession {
    pub provider: String,
    pub profile_id: String,
    pub code_verifier: String,
    /// Kept so the UI can re-query the URL if the panel reopens mid-flow;
    /// also handy for debug logging.
    #[allow(dead_code)]
    pub authorize_url: String,
    pub created_at: SystemTime,
}

/// Garbage-collect pending sessions older than this.
pub const PENDING_TTL_SECS: u64 = 10 * 60;

pub struct OAuthManager {
    pub pending: Mutex<HashMap<String, PendingSession>>,
}

impl OAuthManager {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn gc_expired(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            let now = SystemTime::now();
            pending.retain(|_, s| {
                now.duration_since(s.created_at)
                    .map(|d| d.as_secs() < PENDING_TTL_SECS)
                    .unwrap_or(true)
            });
        }
    }
}

impl Default for OAuthManager {
    fn default() -> Self {
        Self::new()
    }
}
