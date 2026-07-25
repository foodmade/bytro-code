//! OAuth `TokenInfo` CRUD + token endpoint calls (exchange / refresh).

use super::provider::AnthropicProvider;
use super::{public_oauth_failure, OAUTH_REFRESH_ERROR, OAUTH_STORAGE_ERROR};
use crate::memory::db::MemoryDb;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Refresh the access token if it expires within this buffer.
pub const REFRESH_THRESHOLD_MS: i64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenInfo {
    pub provider: String,
    pub profile_id: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub scopes: String,
    pub account_email: Option<String>,
    pub account_uuid: Option<String>,
    pub organization_uuid: Option<String>,
    pub subscription_tier: Option<String>,
    pub token_type: String,
}

/// Public projection of a TokenInfo — never exposes the raw access/refresh token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAccountInfo {
    pub provider: String,
    pub profile_id: String,
    pub account_email: Option<String>,
    pub account_uuid: Option<String>,
    pub organization_uuid: Option<String>,
    pub subscription_tier: Option<String>,
    pub expires_at: i64,
    pub scopes: String,
    pub token_type: String,
}

impl From<&TokenInfo> for OAuthAccountInfo {
    fn from(t: &TokenInfo) -> Self {
        Self {
            provider: t.provider.clone(),
            profile_id: t.profile_id.clone(),
            account_email: t.account_email.clone(),
            account_uuid: t.account_uuid.clone(),
            organization_uuid: t.organization_uuid.clone(),
            subscription_tier: t.subscription_tier.clone(),
            expires_at: t.expires_at,
            scopes: t.scopes.clone(),
            token_type: t.token_type.clone(),
        }
    }
}

pub fn save_token(db: &MemoryDb, token: &TokenInfo) -> Result<(), String> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO oauth_tokens
                (provider, profile_id, access_token, refresh_token, expires_at, scopes,
                 account_email, account_uuid, organization_uuid, subscription_tier, token_type,
                 updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(provider, profile_id) DO UPDATE SET
                access_token=excluded.access_token,
                refresh_token=excluded.refresh_token,
                expires_at=excluded.expires_at,
                scopes=excluded.scopes,
                account_email=excluded.account_email,
                account_uuid=excluded.account_uuid,
                organization_uuid=excluded.organization_uuid,
                subscription_tier=excluded.subscription_tier,
                token_type=excluded.token_type,
                updated_at=excluded.updated_at",
            params![
                token.provider,
                token.profile_id,
                token.access_token,
                token.refresh_token,
                token.expires_at,
                token.scopes,
                token.account_email,
                token.account_uuid,
                token.organization_uuid,
                token.subscription_tier,
                token.token_type,
            ],
        )?;
        Ok(())
    })
    .map_err(|error| public_oauth_failure("token.storage.save", error, OAUTH_STORAGE_ERROR))
}

pub fn load_token(
    db: &MemoryDb,
    provider: &str,
    profile_id: &str,
) -> Result<Option<TokenInfo>, String> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT provider, profile_id, access_token, refresh_token, expires_at, scopes,
                    account_email, account_uuid, organization_uuid, subscription_tier, token_type
             FROM oauth_tokens
             WHERE provider = ?1 AND profile_id = ?2",
            params![provider, profile_id],
            |row| {
                Ok(TokenInfo {
                    provider: row.get(0)?,
                    profile_id: row.get(1)?,
                    access_token: row.get(2)?,
                    refresh_token: row.get(3)?,
                    expires_at: row.get(4)?,
                    scopes: row.get(5)?,
                    account_email: row.get(6)?,
                    account_uuid: row.get(7)?,
                    organization_uuid: row.get(8)?,
                    subscription_tier: row.get(9)?,
                    token_type: row.get(10)?,
                })
            },
        )
        .optional()
    })
    .map_err(|error| public_oauth_failure("token.storage.load", error, OAUTH_STORAGE_ERROR))
}

pub fn delete_token(db: &MemoryDb, provider: &str, profile_id: &str) -> Result<(), String> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM oauth_tokens WHERE provider = ?1 AND profile_id = ?2",
            params![provider, profile_id],
        )?;
        Ok(())
    })
    .map_err(|error| public_oauth_failure("token.storage.delete", error, OAUTH_STORAGE_ERROR))
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn is_expiring_soon(token: &TokenInfo) -> bool {
    now_ms() + REFRESH_THRESHOLD_MS >= token.expires_at
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    account: Option<Account>,
    #[serde(default)]
    organization: Option<Organization>,
}

#[derive(Deserialize)]
struct Account {
    #[serde(default)]
    email_address: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
}

#[derive(Deserialize)]
struct Organization {
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

pub async fn exchange_code(
    proxy_url: Option<&str>,
    provider: &str,
    profile_id: &str,
    code: &str,
    code_verifier: &str,
    state: &str,
) -> Result<TokenInfo, String> {
    let client = crate::anthropic::get_client(proxy_url).map_err(|error| {
        public_oauth_failure(
            "token.exchange.client",
            error,
            "OAuth token exchange is temporarily unavailable.",
        )
    })?;
    let resp = client
        .post(AnthropicProvider::TOKEN_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": AnthropicProvider::REDIRECT_URI,
            "client_id": AnthropicProvider::CLIENT_ID,
            "code_verifier": code_verifier,
            "state": state,
        }))
        .send()
        .await
        .map_err(|error| {
            public_oauth_failure(
                "token.exchange.request",
                error.to_string(),
                "OAuth token exchange request failed.",
            )
        })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|error| {
        public_oauth_failure(
            "token.exchange.read",
            error.to_string(),
            "OAuth token exchange response could not be read.",
        )
    })?;

    if !status.is_success() {
        return Err(public_oauth_failure(
            "token.exchange.http",
            format!("status={} body={}", status, text),
            &format!("OAuth token exchange failed (HTTP {}).", status),
        ));
    }

    let parsed: TokenResponse = serde_json::from_str(&text).map_err(|error| {
        public_oauth_failure(
            "token.exchange.json",
            format!("error={} body={}", error, text),
            "OAuth token exchange response was invalid.",
        )
    })?;

    let expires_at = now_ms() + parsed.expires_in.unwrap_or(3600) * 1000;

    let (account_email, account_uuid) = parsed
        .account
        .as_ref()
        .map(|a| (a.email_address.clone(), a.uuid.clone()))
        .unwrap_or((None, None));
    let (organization_uuid, subscription_tier) = parsed
        .organization
        .as_ref()
        .map(|o| (o.uuid.clone(), o.name.clone()))
        .unwrap_or((None, None));

    Ok(TokenInfo {
        provider: provider.to_string(),
        profile_id: profile_id.to_string(),
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at,
        scopes: parsed
            .scope
            .unwrap_or_else(|| AnthropicProvider::SCOPES.to_string()),
        account_email,
        account_uuid,
        organization_uuid,
        subscription_tier,
        token_type: parsed.token_type.unwrap_or_else(|| "Bearer".to_string()),
    })
}

pub async fn refresh_token(proxy_url: Option<&str>, prev: &TokenInfo) -> Result<TokenInfo, String> {
    let refresh = prev
        .refresh_token
        .as_ref()
        .ok_or_else(|| OAUTH_REFRESH_ERROR.to_string())?;
    let client = crate::anthropic::get_client(proxy_url).map_err(|error| {
        public_oauth_failure("token.refresh.client", error, OAUTH_REFRESH_ERROR)
    })?;
    let resp = client
        .post(AnthropicProvider::TOKEN_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh,
            "client_id": AnthropicProvider::CLIENT_ID,
        }))
        .send()
        .await
        .map_err(|error| {
            public_oauth_failure(
                "token.refresh.request",
                error.to_string(),
                OAUTH_REFRESH_ERROR,
            )
        })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|error| {
        public_oauth_failure("token.refresh.read", error.to_string(), OAUTH_REFRESH_ERROR)
    })?;

    if !status.is_success() {
        return Err(public_oauth_failure(
            "token.refresh.http",
            format!("status={} body={}", status, text),
            &format!("{} (HTTP {})", OAUTH_REFRESH_ERROR, status),
        ));
    }

    let parsed: TokenResponse = serde_json::from_str(&text).map_err(|error| {
        public_oauth_failure(
            "token.refresh.json",
            format!("error={} body={}", error, text),
            OAUTH_REFRESH_ERROR,
        )
    })?;

    let expires_at = now_ms() + parsed.expires_in.unwrap_or(3600) * 1000;

    let mut next = prev.clone();
    next.access_token = parsed.access_token;
    if let Some(rt) = parsed.refresh_token {
        next.refresh_token = Some(rt);
    }
    next.expires_at = expires_at;
    if let Some(s) = parsed.scope {
        next.scopes = s;
    }
    if let Some(tt) = parsed.token_type {
        next.token_type = tt;
    }
    Ok(next)
}
