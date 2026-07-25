//! Tauri commands for OAuth 2.0 PKCE sign-in.
//!
//! Flow (manual-paste):
//!   oauth_start       → PKCE + authorize URL; try to open browser
//!   (user approves)   → Anthropic callback page shows a `code#state` string
//!   oauth_submit_code → exchange code for tokens, persist to SQLite
//!   oauth_refresh / oauth_sign_out / oauth_cancel / oauth_get_token

use super::pkce;
use super::provider::AnthropicProvider;
use super::token::{self, OAuthAccountInfo};
use super::{
    public_oauth_failure, OAuthManager, PendingSession, OAUTH_REFRESH_ERROR, OAUTH_SIGN_IN_REQUIRED,
};
use crate::memory::db::MemoryDb;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResult {
    pub authorize_url: String,
    pub state: String,
    pub browser_opened: bool,
}

pub(crate) fn build_authorize_url(state: &str, challenge: &str) -> Result<String, String> {
    let mut url = Url::parse(AnthropicProvider::AUTHORIZE_URL).map_err(|error| {
        public_oauth_failure(
            "authorize_url.parse",
            error.to_string(),
            "OAuth sign-in is temporarily unavailable.",
        )
    })?;
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", AnthropicProvider::CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", AnthropicProvider::REDIRECT_URI)
        .append_pair("scope", AnthropicProvider::SCOPES)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(url.to_string())
}

/// `claude` from the UI maps to Anthropic's OAuth provider.
fn normalize_provider(provider: &str) -> &str {
    match provider {
        "anthropic" | "claude" => "anthropic",
        other => other,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OAuthCredentialReference {
    pub provider: String,
    pub profile_id: String,
}

pub(crate) fn validate_credential_reference(
    provider: Option<&str>,
    profile_id: Option<&str>,
) -> Result<OAuthCredentialReference, String> {
    let provider = match provider.map(str::trim) {
        Some("claude" | "anthropic") => "anthropic".to_string(),
        _ => return Err("OAuth credential reference is invalid.".to_string()),
    };
    let profile_id = profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "OAuth credential reference is invalid.".to_string())?;
    Ok(OAuthCredentialReference {
        provider,
        profile_id,
    })
}

/// Split a user-pasted value into `(code, Option<state>)`.
///
/// Accepts these shapes from the Anthropic callback page:
///   `code#state`         (Claude CLI convention)
///   `code?state=...`     (query-style)
///   `code&state=...`     (alt query-style)
///   `code` alone         (no state echoed — caller falls back to the
///                         state returned by oauth_start)
pub(crate) fn parse_code(raw: &str) -> (String, Option<String>) {
    let trimmed = raw.trim();
    if let Some(pos) = trimmed.find('#') {
        let (c, rest) = trimmed.split_at(pos);
        return (c.trim().to_string(), Some(rest[1..].trim().to_string()));
    }
    if trimmed.contains("state=") {
        if let Some(pos) = trimmed.find(['?', '&']) {
            let code = trimmed[..pos].trim().to_string();
            let query = &trimmed[pos + 1..];
            if let Ok(parsed) = Url::parse(&format!("http://x/?{}", query)) {
                if let Some((_, v)) = parsed.query_pairs().find(|(k, _)| k == "state") {
                    return (code, Some(v.into_owned()));
                }
            }
        }
    }
    (trimmed.to_string(), None)
}

#[tauri::command]
pub fn oauth_start(
    app: AppHandle,
    manager: State<'_, OAuthManager>,
    provider: String,
    profile_id: String,
) -> Result<OAuthStartResult, String> {
    manager.gc_expired();

    let verifier = pkce::generate_verifier();
    let challenge = pkce::challenge_from_verifier(&verifier);
    let state = pkce::generate_state();
    let authorize_url = build_authorize_url(&state, &challenge)?;

    // Try to open the default browser. Ignore failure — the UI always shows
    // the URL so the user can paste it into a browser of their choice.
    let browser_opened = app
        .opener()
        .open_url(authorize_url.clone(), None::<String>)
        .is_ok();

    {
        let mut map = manager.pending.lock().map_err(|error| {
            public_oauth_failure(
                "session.lock.start",
                error.to_string(),
                "OAuth sign-in is temporarily unavailable.",
            )
        })?;
        map.insert(
            state.clone(),
            PendingSession {
                provider: normalize_provider(&provider).to_string(),
                profile_id,
                code_verifier: verifier,
                authorize_url: authorize_url.clone(),
                created_at: std::time::SystemTime::now(),
            },
        );
    }

    Ok(OAuthStartResult {
        authorize_url,
        state,
        browser_opened,
    })
}

#[tauri::command]
pub fn oauth_cancel(manager: State<'_, OAuthManager>, state: String) -> Result<(), String> {
    if let Ok(mut map) = manager.pending.lock() {
        map.remove(&state);
    }
    Ok(())
}

#[tauri::command]
pub async fn oauth_submit_code(
    app: AppHandle,
    manager: State<'_, OAuthManager>,
    db: State<'_, MemoryDb>,
    state: String,
    code: String,
    proxy_url: Option<String>,
) -> Result<OAuthAccountInfo, String> {
    let (code_part, code_state) = parse_code(&code);
    let resolved_state = code_state.unwrap_or_else(|| state.clone());

    let pending = {
        let mut map = manager.pending.lock().map_err(|error| {
            public_oauth_failure(
                "session.lock.submit",
                error.to_string(),
                "OAuth sign-in is temporarily unavailable.",
            )
        })?;
        map.remove(&resolved_state)
            .ok_or_else(|| "Invalid state — please restart sign-in.".to_string())?
    };

    let proxy = proxy_url.as_deref().filter(|s| !s.is_empty());
    let token_info = match token::exchange_code(
        proxy,
        &pending.provider,
        &pending.profile_id,
        code_part.trim(),
        &pending.code_verifier,
        &resolved_state,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            let _ = app.emit(
                "oauth://error",
                &serde_json::json!({
                    "provider": pending.provider,
                    "profileId": pending.profile_id,
                    "error": "OAuth token exchange failed.",
                }),
            );
            return Err(e);
        }
    };

    token::save_token(&db, &token_info)?;
    let info: OAuthAccountInfo = (&token_info).into();
    let _ = app.emit("oauth://signed-in", &info);
    Ok(info)
}

#[tauri::command]
pub fn oauth_get_token(
    db: State<'_, MemoryDb>,
    provider: String,
    profile_id: String,
) -> Result<Option<OAuthAccountInfo>, String> {
    let p = normalize_provider(&provider);
    match token::load_token(&db, p, &profile_id)? {
        Some(t) => Ok(Some((&t).into())),
        None => Ok(None),
    }
}

/// Load the stored token, refreshing (and persisting + broadcasting) it first
/// when it is about to expire. Shared by Rust-owned stream credential
/// resolution and `oauth_get_usage`.
pub(crate) async fn load_fresh_token(
    app: &AppHandle,
    db: &MemoryDb,
    provider: &str,
    profile_id: &str,
    proxy_url: Option<&str>,
) -> Result<token::TokenInfo, String> {
    let mut current = token::load_token(db, provider, profile_id)?
        .ok_or_else(|| OAUTH_SIGN_IN_REQUIRED.to_string())?;

    if token::is_expiring_soon(&current) {
        match token::refresh_token(proxy_url, &current).await {
            Ok(next) => {
                token::save_token(db, &next)?;
                let info: OAuthAccountInfo = (&next).into();
                let _ = app.emit("oauth://refreshed", &info);
                current = next;
            }
            Err(e) => {
                let _ = app.emit(
                    "oauth://expired",
                    &serde_json::json!({
                        "provider": provider,
                        "profileId": profile_id,
                        "error": OAUTH_REFRESH_ERROR,
                    }),
                );
                let _ = e;
                return Err(OAUTH_REFRESH_ERROR.to_string());
            }
        }
    }

    Ok(current)
}

async fn request_usage(
    proxy_url: Option<&str>,
    access_token: &str,
) -> Result<reqwest::Response, String> {
    let client = crate::anthropic::get_client(proxy_url).map_err(|error| {
        public_oauth_failure(
            "usage.client",
            error,
            "OAuth usage is temporarily unavailable.",
        )
    })?;
    client
        .get(AnthropicProvider::USAGE_URL)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json")
        .header("anthropic-beta", AnthropicProvider::OAUTH_BETA)
        .send()
        .await
        .map_err(|error| {
            public_oauth_failure(
                "usage.request",
                error.to_string(),
                "OAuth usage request failed.",
            )
        })
}

/// Fetch subscription quota utilization (GET /api/oauth/usage) for the
/// signed-in account. Returns the raw JSON payload; the UI parses the
/// `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` windows.
#[tauri::command]
pub async fn oauth_get_usage(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    provider: String,
    profile_id: String,
    proxy_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let p = normalize_provider(&provider).to_string();
    let proxy = proxy_url.as_deref().filter(|s| !s.is_empty());
    let current = load_fresh_token(&app, &db, &p, &profile_id, proxy).await?;

    let mut resp = request_usage(proxy, &current.access_token).await?;

    // A 401 means the access token went stale server-side even though it has
    // not hit our local expiry threshold — force one refresh and retry.
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let next = token::refresh_token(proxy, &current).await?;
        token::save_token(&db, &next)?;
        let info: OAuthAccountInfo = (&next).into();
        let _ = app.emit("oauth://refreshed", &info);
        resp = request_usage(proxy, &next.access_token).await?;
    }

    let status = resp.status();
    let text = resp.text().await.map_err(|error| {
        public_oauth_failure(
            "usage.read",
            error.to_string(),
            "OAuth usage response could not be read.",
        )
    })?;

    if !status.is_success() {
        return Err(public_oauth_failure(
            "usage.http",
            format!("status={} body={}", status, text),
            &format!("OAuth usage request failed (HTTP {}).", status),
        ));
    }

    serde_json::from_str(&text).map_err(|error| {
        public_oauth_failure(
            "usage.json",
            format!("error={} body={}", error, text),
            "OAuth usage response was invalid.",
        )
    })
}

#[tauri::command]
pub async fn oauth_refresh(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    provider: String,
    profile_id: String,
    proxy_url: Option<String>,
) -> Result<OAuthAccountInfo, String> {
    let p = normalize_provider(&provider).to_string();
    let current =
        token::load_token(&db, &p, &profile_id)?.ok_or_else(|| "Not signed in.".to_string())?;
    let proxy = proxy_url.as_deref().filter(|s| !s.is_empty());
    let next = token::refresh_token(proxy, &current).await?;
    token::save_token(&db, &next)?;
    let info: OAuthAccountInfo = (&next).into();
    let _ = app.emit("oauth://refreshed", &info);
    Ok(info)
}

#[tauri::command]
pub fn oauth_sign_out(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    provider: String,
    profile_id: String,
) -> Result<(), String> {
    let p = normalize_provider(&provider);
    token::delete_token(&db, p, &profile_id)?;
    let _ = app.emit(
        "oauth://signed-out",
        &serde_json::json!({
            "provider": p,
            "profileId": profile_id,
        }),
    );
    Ok(())
}
