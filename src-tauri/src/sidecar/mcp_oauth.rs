//! Generic OAuth 2.1 / PKCE support for remote MCP servers.
//!
//! Remote MCP servers advertise OAuth through `WWW-Authenticate` and
//! `.well-known/oauth-protected-resource`. This module keeps the flow generic:
//! discover metadata, dynamically register a loopback client, open the browser,
//! capture the callback, exchange the code, and inject fresh Bearer tokens into
//! MCP HTTP requests.

use crate::memory::db::MemoryDb;
use crate::oauth::{pkce, token};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::header::WWW_AUTHENTICATE;
use rusqlite::{params, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MCP_CLIENT_NAME: &str = "Bytro MCP";
const CALLBACK_PATH: &str = "/mcp-oauth/callback";
const PENDING_TTL_SECS: u64 = 10 * 60;
const DEFAULT_EXPIRES_IN_SECS: i64 = 3600;

fn public_mcp_oauth_failure(
    category: &str,
    detail: impl AsRef<str>,
    public_message: &str,
) -> String {
    crate::oauth::public_oauth_failure(&format!("mcp.{}", category), detail, public_message)
}

#[derive(Debug, Clone, Deserialize)]
struct ProtectedResourceMetadata {
    #[serde(default)]
    resource: Option<String>,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct OAuthServerMetadata {
    #[serde(default)]
    issuer: Option<String>,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    registration_endpoint: Option<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ClientRegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<serde_json::Value>,
    #[serde(default)]
    token_type: Option<String>,
}

#[derive(Debug, Clone)]
struct McpOAuthDiscovery {
    resource: Option<String>,
    scope: String,
    oauth: OAuthServerMetadata,
}

#[derive(Debug, Clone)]
struct McpOAuthToken {
    server_name: String,
    server_url: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    scopes: String,
    token_type: String,
    resource: Option<String>,
    issuer: Option<String>,
    authorization_endpoint: String,
    token_endpoint: String,
    client_id: String,
    client_secret: Option<String>,
    token_endpoint_auth_method: String,
    redirect_uri: String,
}

#[derive(Debug, Clone)]
struct CallbackResult {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

struct PendingMcpOAuthSession {
    server_name: String,
    server_url: String,
    code_verifier: String,
    state: String,
    redirect_uri: String,
    discovery: McpOAuthDiscovery,
    client: ClientRegistrationResponse,
    callback: Arc<Mutex<Option<CallbackResult>>>,
    created_at: SystemTime,
}

pub struct McpOAuthManager {
    pending: Mutex<HashMap<String, PendingMcpOAuthSession>>,
}

impl McpOAuthManager {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn gc_expired(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            let now = SystemTime::now();
            pending.retain(|_, session| {
                now.duration_since(session.created_at)
                    .map(|d| d.as_secs() < PENDING_TTL_SECS)
                    .unwrap_or(true)
            });
        }
    }
}

impl Default for McpOAuthManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthStartResult {
    authorize_url: String,
    state: String,
    browser_opened: bool,
    resource: Option<String>,
    scopes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthPollResult {
    status: String,
    message: Option<String>,
    expires_at: Option<i64>,
    scopes: Option<String>,
    token_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthStatusResult {
    authorized: bool,
    expires_at: Option<i64>,
    scopes: Option<String>,
    token_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthInspectionResult {
    mode: String,
    can_authorize: bool,
    message: String,
    resource: Option<String>,
    scopes: Option<String>,
    authorization_endpoint: Option<String>,
    token_endpoint: Option<String>,
    registration_endpoint: Option<String>,
}

fn config_url(config: &serde_json::Value) -> Result<String, String> {
    let raw = config
        .as_object()
        .and_then(|obj| obj.get("url"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "MCP OAuth requires an HTTP/SSE server URL.".to_string())?;
    super::mcp::normalize_mcp_remote_url(raw)
}

fn config_has_authorization_header(config: &serde_json::Value) -> bool {
    config
        .as_object()
        .and_then(|obj| obj.get("headers"))
        .and_then(|headers| headers.as_object())
        .map(|headers| {
            headers
                .keys()
                .any(|key| key.eq_ignore_ascii_case("authorization"))
        })
        .unwrap_or(false)
}

fn scope_from_value(value: Option<serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(s)) => Some(s),
        Some(serde_json::Value::Array(values)) => {
            let scopes: Vec<String> = values
                .into_iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            if scopes.is_empty() {
                None
            } else {
                Some(scopes.join(" "))
            }
        }
        _ => None,
    }
}

fn parse_www_authenticate(value: &str) -> HashMap<String, String> {
    let mut input = value.trim();
    if let Some(rest) = input.strip_prefix("Bearer") {
        input = rest.trim_start();
    }

    let mut params = HashMap::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' && bytes[i] != b',' {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            break;
        }
        let key = input[key_start..i].trim().to_ascii_lowercase();
        i += 1;

        let value = if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let mut out = String::new();
            while i < bytes.len() {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 1;
                    out.push(bytes[i] as char);
                    i += 1;
                    continue;
                }
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                out.push(bytes[i] as char);
                i += 1;
            }
            out
        } else {
            let value_start = i;
            while i < bytes.len() && bytes[i] != b',' {
                i += 1;
            }
            input[value_start..i].trim().to_string()
        };

        if !key.is_empty() && !value.is_empty() {
            params.insert(key, value);
        }
    }
    params
}

fn url_origin(url: &Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| format!("URL has no host: {}", url))?;
    let port = url.port().map(|p| format!(":{}", p)).unwrap_or_default();
    Ok(format!("{}://{}{}", url.scheme(), host, port))
}

fn protected_resource_metadata_candidates(resource_url: &str) -> Result<Vec<String>, String> {
    let parsed = Url::parse(resource_url).map_err(|e| format!("Invalid MCP URL: {}", e))?;
    let origin = url_origin(&parsed)?;
    let mut candidates = vec![format!("{}/.well-known/oauth-protected-resource", origin)];
    let path = parsed.path().trim_end_matches('/');
    if !path.is_empty() && path != "/" {
        candidates.push(format!(
            "{}/.well-known/oauth-protected-resource{}",
            origin, path
        ));
    }
    Ok(candidates)
}

fn oauth_server_metadata_candidates(issuer_or_metadata_url: &str) -> Result<Vec<String>, String> {
    let parsed = Url::parse(issuer_or_metadata_url)
        .map_err(|e| format!("Invalid OAuth metadata URL: {}", e))?;
    let path = parsed.path().trim_end_matches('/');
    if path.ends_with("/.well-known/oauth-authorization-server")
        || path.contains("/.well-known/oauth-authorization-server/")
    {
        return Ok(vec![issuer_or_metadata_url.to_string()]);
    }

    let origin = url_origin(&parsed)?;
    let mut candidates = Vec::new();
    if path.is_empty() || path == "/" {
        candidates.push(format!("{}/.well-known/oauth-authorization-server", origin));
    } else {
        candidates.push(format!(
            "{}/.well-known/oauth-authorization-server{}",
            origin, path
        ));
        candidates.push(format!(
            "{}/.well-known/oauth-authorization-server",
            issuer_or_metadata_url.trim_end_matches('/')
        ));
    }
    Ok(candidates)
}

async fn get_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    label: &str,
) -> Result<T, String> {
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", "Bytro MCP OAuth")
        .send()
        .await
        .map_err(|error| {
            public_mcp_oauth_failure(
                "metadata.request",
                format!("label={} error={}", label, error),
                "OAuth metadata request failed.",
            )
        })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|error| {
        public_mcp_oauth_failure(
            "metadata.read",
            format!("label={} error={}", label, error),
            "OAuth metadata response could not be read.",
        )
    })?;
    if !status.is_success() {
        return Err(public_mcp_oauth_failure(
            "metadata.http",
            format!("label={} status={} body={}", label, status, text),
            &format!("OAuth metadata request failed (HTTP {}).", status),
        ));
    }
    serde_json::from_str(&text).map_err(|error| {
        public_mcp_oauth_failure(
            "metadata.json",
            format!("label={} error={} body={}", label, error, text),
            "OAuth metadata response was invalid.",
        )
    })
}

async fn probe_oauth_challenge(
    client: &reqwest::Client,
    server_url: &str,
) -> Result<HashMap<String, String>, String> {
    let initialize = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "bytro-mcp-manager", "version": "1.0.0" }
        }
    });

    let mut challenges = Vec::new();
    let post = client
        .post(server_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&initialize)
        .send()
        .await;
    if let Ok(resp) = post {
        for header in resp.headers().get_all(WWW_AUTHENTICATE).iter() {
            if let Ok(value) = header.to_str() {
                challenges.push(value.to_string());
            }
        }
    }

    if challenges.is_empty() {
        let get = client
            .get(server_url)
            .header("Accept", "application/json")
            .send()
            .await;
        if let Ok(resp) = get {
            for header in resp.headers().get_all(WWW_AUTHENTICATE).iter() {
                if let Ok(value) = header.to_str() {
                    challenges.push(value.to_string());
                }
            }
        }
    }

    for challenge in challenges {
        let parsed = parse_www_authenticate(&challenge);
        if parsed.contains_key("resource_metadata")
            || parsed.contains_key("authorization_uri")
            || parsed.contains_key("scope")
        {
            return Ok(parsed);
        }
    }
    Ok(HashMap::new())
}

async fn probe_initialize_auth(
    client: &reqwest::Client,
    server_url: &str,
) -> Result<(reqwest::StatusCode, String, HashMap<String, String>), String> {
    let initialize = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "bytro-mcp-manager", "version": "1.0.0" }
        }
    });

    let response = client
        .post(server_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&initialize)
        .send()
        .await
        .map_err(|e| format!("MCP auth inspection failed: {}", e))?;
    let status = response.status();
    let mut challenge = HashMap::new();
    for header in response.headers().get_all(WWW_AUTHENTICATE).iter() {
        if let Ok(value) = header.to_str() {
            challenge.extend(parse_www_authenticate(value));
        }
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read MCP auth inspection response: {}", e))?;
    Ok((status, body, challenge))
}

fn body_mentions_auth(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("authorization")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("missing token")
        || lower.contains("api key")
        || lower.contains("credential")
}

fn oauth_inspection_result(discovery: McpOAuthDiscovery) -> McpAuthInspectionResult {
    let can_authorize = discovery.oauth.registration_endpoint.is_some();
    let message = if can_authorize {
        "MCP server supports OAuth authorization.".to_string()
    } else {
        "MCP server advertises OAuth, but does not expose dynamic client registration.".to_string()
    };
    McpAuthInspectionResult {
        mode: "oauth".to_string(),
        can_authorize,
        message,
        resource: discovery.resource,
        scopes: if discovery.scope.trim().is_empty() {
            None
        } else {
            Some(discovery.scope)
        },
        authorization_endpoint: Some(discovery.oauth.authorization_endpoint),
        token_endpoint: Some(discovery.oauth.token_endpoint),
        registration_endpoint: discovery.oauth.registration_endpoint,
    }
}

async fn inspect_mcp_auth_for_url(
    client: &reqwest::Client,
    server_url: &str,
) -> Result<McpAuthInspectionResult, String> {
    let (status, body, challenge) = probe_initialize_auth(client, server_url).await?;
    let has_oauth_signal =
        challenge.contains_key("resource_metadata") || challenge.contains_key("authorization_uri");

    if has_oauth_signal {
        return match discover_mcp_oauth(client, server_url).await {
            Ok(discovery) => Ok(oauth_inspection_result(discovery)),
            Err(err) => {
                let message = public_mcp_oauth_failure(
                    "inspection.discovery",
                    err,
                    "OAuth metadata was advertised but could not be resolved.",
                );
                Ok(McpAuthInspectionResult {
                    mode: "unknown".to_string(),
                    can_authorize: false,
                    message,
                    resource: None,
                    scopes: None,
                    authorization_endpoint: None,
                    token_endpoint: None,
                    registration_endpoint: None,
                })
            }
        };
    }

    let auth_like = status == reqwest::StatusCode::UNAUTHORIZED
        || status == reqwest::StatusCode::FORBIDDEN
        || body_mentions_auth(&body);
    if auth_like {
        if let Ok(discovery) = discover_mcp_oauth(client, server_url).await {
            return Ok(oauth_inspection_result(discovery));
        }
        return Ok(McpAuthInspectionResult {
            mode: "token".to_string(),
            can_authorize: false,
            message:
                "MCP server requires authentication but did not advertise OAuth metadata. Use a manual token."
                    .to_string(),
            resource: None,
            scopes: None,
            authorization_endpoint: None,
            token_endpoint: None,
            registration_endpoint: None,
        });
    }

    if status.is_success() {
        return Ok(McpAuthInspectionResult {
            mode: "none".to_string(),
            can_authorize: false,
            message: "MCP server responded without authentication.".to_string(),
            resource: None,
            scopes: None,
            authorization_endpoint: None,
            token_endpoint: None,
            registration_endpoint: None,
        });
    }

    Ok(McpAuthInspectionResult {
        mode: "unknown".to_string(),
        can_authorize: false,
        message: format!(
            "Could not determine MCP authentication mode from HTTP {}.",
            status
        ),
        resource: None,
        scopes: None,
        authorization_endpoint: None,
        token_endpoint: None,
        registration_endpoint: None,
    })
}

async fn discover_mcp_oauth(
    client: &reqwest::Client,
    server_url: &str,
) -> Result<McpOAuthDiscovery, String> {
    let challenge = probe_oauth_challenge(client, server_url).await?;
    let mut protected_resource: Option<ProtectedResourceMetadata> = None;

    let mut resource_metadata_urls = Vec::new();
    if let Some(url) = challenge.get("resource_metadata") {
        resource_metadata_urls.push(url.clone());
    }
    resource_metadata_urls.extend(protected_resource_metadata_candidates(server_url)?);
    resource_metadata_urls.sort();
    resource_metadata_urls.dedup();

    let mut resource_errors = Vec::new();
    for url in &resource_metadata_urls {
        match get_json::<ProtectedResourceMetadata>(client, url, "MCP protected resource metadata")
            .await
        {
            Ok(metadata) => {
                protected_resource = Some(metadata);
                break;
            }
            Err(err) => resource_errors.push(format!("{}: {}", url, err)),
        }
    }

    let mut auth_server_candidates = Vec::new();
    if let Some(metadata) = &protected_resource {
        auth_server_candidates.extend(metadata.authorization_servers.clone());
    }
    if let Some(url) = challenge.get("authorization_uri") {
        auth_server_candidates.push(url.clone());
    }
    auth_server_candidates.sort();
    auth_server_candidates.dedup();

    if auth_server_candidates.is_empty() {
        return Err(format!(
            "MCP server did not advertise an OAuth authorization server. Resource metadata attempts: {}",
            resource_errors.join("; ")
        ));
    }

    let mut oauth_errors = Vec::new();
    for auth_server in &auth_server_candidates {
        for metadata_url in oauth_server_metadata_candidates(auth_server)? {
            match get_json::<OAuthServerMetadata>(
                client,
                &metadata_url,
                "OAuth authorization server metadata",
            )
            .await
            {
                Ok(oauth) => {
                    let scope = challenge
                        .get("scope")
                        .cloned()
                        .or_else(|| {
                            protected_resource.as_ref().and_then(|m| {
                                if m.scopes_supported.is_empty() {
                                    None
                                } else {
                                    Some(m.scopes_supported.join(" "))
                                }
                            })
                        })
                        .or_else(|| {
                            if oauth.scopes_supported.is_empty() {
                                None
                            } else {
                                Some(oauth.scopes_supported.join(" "))
                            }
                        })
                        .unwrap_or_default();
                    return Ok(McpOAuthDiscovery {
                        resource: protected_resource
                            .as_ref()
                            .and_then(|m| m.resource.clone())
                            .or_else(|| Some(server_url.to_string())),
                        scope,
                        oauth,
                    });
                }
                Err(err) => oauth_errors.push(format!("{}: {}", metadata_url, err)),
            }
        }
    }

    Err(format!(
        "Failed to discover OAuth metadata for this MCP server: {}",
        oauth_errors.join("; ")
    ))
}

fn choose_token_auth_method(metadata: &OAuthServerMetadata) -> String {
    let methods = &metadata.token_endpoint_auth_methods_supported;
    if methods.iter().any(|m| m == "none") {
        "none".to_string()
    } else if methods.iter().any(|m| m == "client_secret_post") {
        "client_secret_post".to_string()
    } else if methods.iter().any(|m| m == "client_secret_basic") {
        "client_secret_basic".to_string()
    } else {
        "none".to_string()
    }
}

async fn register_dynamic_client(
    client: &reqwest::Client,
    discovery: &McpOAuthDiscovery,
    redirect_uri: &str,
) -> Result<ClientRegistrationResponse, String> {
    let registration_endpoint = discovery
        .oauth
        .registration_endpoint
        .as_deref()
        .ok_or_else(|| {
            "OAuth authorization server does not expose dynamic client registration.".to_string()
        })?;
    let token_auth_method = choose_token_auth_method(&discovery.oauth);
    let resp = client
        .post(registration_endpoint)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "client_name": MCP_CLIENT_NAME,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": token_auth_method,
        }))
        .send()
        .await
        .map_err(|error| {
            public_mcp_oauth_failure(
                "registration.request",
                error.to_string(),
                "Dynamic OAuth client registration failed.",
            )
        })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|error| {
        public_mcp_oauth_failure(
            "registration.read",
            error.to_string(),
            "Dynamic OAuth client registration response could not be read.",
        )
    })?;
    if !status.is_success() {
        return Err(public_mcp_oauth_failure(
            "registration.http",
            format!("status={} body={}", status, text),
            &format!(
                "Dynamic OAuth client registration failed (HTTP {}).",
                status
            ),
        ));
    }
    let mut parsed: ClientRegistrationResponse = serde_json::from_str(&text).map_err(|error| {
        public_mcp_oauth_failure(
            "registration.json",
            format!("error={} body={}", error, text),
            "Dynamic OAuth client registration response was invalid.",
        )
    })?;
    if parsed.token_endpoint_auth_method.is_none() {
        parsed.token_endpoint_auth_method = Some(token_auth_method);
    }
    Ok(parsed)
}

fn build_authorize_url(
    discovery: &McpOAuthDiscovery,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = Url::parse(&discovery.oauth.authorization_endpoint)
        .map_err(|e| format!("Invalid authorization endpoint: {}", e))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state);
        if !discovery.scope.trim().is_empty() {
            pairs.append_pair("scope", discovery.scope.trim());
        }
        if let Some(resource) = discovery
            .resource
            .as_deref()
            .filter(|v| !v.trim().is_empty())
        {
            pairs.append_pair("resource", resource);
        }
    }
    Ok(url.to_string())
}

fn create_callback_listener() -> Result<(TcpListener, String), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind OAuth callback listener: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to read OAuth callback listener address: {}", e))?;
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("Failed to configure OAuth callback listener: {}", e))?;
    let redirect_uri = format!("http://127.0.0.1:{}{}", addr.port(), CALLBACK_PATH);
    Ok((listener, redirect_uri))
}

fn callback_response_html(success: bool) -> String {
    let app_name = crate::constants::APP_NAME;
    let title = if success {
        format!("{} MCP authorization complete", app_name)
    } else {
        format!("{} MCP authorization failed", app_name)
    };
    let body = if success {
        format!("Authorization is complete. You can return to {}.", app_name)
    } else {
        format!(
            "Authorization failed. Return to {} and try again.",
            app_name
        )
    };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body style=\"font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#101014;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0\"><main style=\"max-width:520px;padding:32px\"><h1>{}</h1><p style=\"color:#a1a1aa;font-size:16px;line-height:1.6\">{}</p></main></body></html>",
        title, title, body
    )
}

fn start_callback_listener(
    listener: TcpListener,
    expected_state: String,
    callback: Arc<Mutex<Option<CallbackResult>>>,
) {
    std::thread::spawn(move || {
        let result = (|| -> Result<CallbackResult, String> {
            listener
                .set_nonblocking(true)
                .map_err(|e| format!("Failed to configure callback listener: {}", e))?;
            let started_at = Instant::now();
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if started_at.elapsed().as_secs() >= PENDING_TTL_SECS {
                            return Err("OAuth callback timed out.".to_string());
                        }
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    Err(e) => return Err(format!("OAuth callback listener failed: {}", e)),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .map_err(|e| format!("Failed to set callback read timeout: {}", e))?;
            let mut buffer = [0u8; 8192];
            let size = stream
                .read(&mut buffer)
                .map_err(|e| format!("Failed to read OAuth callback request: {}", e))?;
            let request = String::from_utf8_lossy(&buffer[..size]);
            let first_line = request.lines().next().unwrap_or_default();
            let target = first_line
                .split_whitespace()
                .nth(1)
                .ok_or_else(|| "Invalid OAuth callback request.".to_string())?;
            let parsed = Url::parse(&format!("http://127.0.0.1{}", target))
                .map_err(|e| format!("Invalid OAuth callback URL: {}", e))?;
            let query: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
            let state = query.get("state").cloned();
            let error = query
                .get("error_description")
                .or_else(|| query.get("error"))
                .cloned();
            let code = query.get("code").cloned();
            let state_matches = state.as_deref() == Some(expected_state.as_str());
            let success = error.is_none() && code.is_some() && state_matches;
            let body = callback_response_html(success);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            if !state_matches {
                return Ok(CallbackResult {
                    code: None,
                    state,
                    error: Some(
                        "OAuth callback state did not match. Please restart authorization."
                            .to_string(),
                    ),
                });
            }
            Ok(CallbackResult { code, state, error })
        })();

        let callback_result = match result {
            Ok(value) => value,
            Err(error) => CallbackResult {
                code: None,
                state: None,
                error: Some(error),
            },
        };
        if let Ok(mut slot) = callback.lock() {
            *slot = Some(callback_result);
        }
    });
}

fn save_token(db: &MemoryDb, token: &McpOAuthToken) -> Result<(), String> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO mcp_oauth_tokens
                (server_name, server_url, access_token, refresh_token, expires_at, scopes,
                 token_type, resource, issuer, authorization_endpoint, token_endpoint,
                 client_id, client_secret, token_endpoint_auth_method, redirect_uri, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(server_name, server_url) DO UPDATE SET
                access_token=excluded.access_token,
                refresh_token=excluded.refresh_token,
                expires_at=excluded.expires_at,
                scopes=excluded.scopes,
                token_type=excluded.token_type,
                resource=excluded.resource,
                issuer=excluded.issuer,
                authorization_endpoint=excluded.authorization_endpoint,
                token_endpoint=excluded.token_endpoint,
                client_id=excluded.client_id,
                client_secret=excluded.client_secret,
                token_endpoint_auth_method=excluded.token_endpoint_auth_method,
                redirect_uri=excluded.redirect_uri,
                updated_at=excluded.updated_at",
            params![
                token.server_name,
                token.server_url,
                token.access_token,
                token.refresh_token,
                token.expires_at,
                token.scopes,
                token.token_type,
                token.resource,
                token.issuer,
                token.authorization_endpoint,
                token.token_endpoint,
                token.client_id,
                token.client_secret,
                token.token_endpoint_auth_method,
                token.redirect_uri,
            ],
        )?;
        Ok(())
    })
}

fn load_token(
    db: &MemoryDb,
    server_name: &str,
    server_url: &str,
) -> Result<Option<McpOAuthToken>, String> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT server_name, server_url, access_token, refresh_token, expires_at, scopes,
                    token_type, resource, issuer, authorization_endpoint, token_endpoint,
                    client_id, client_secret, token_endpoint_auth_method, redirect_uri
             FROM mcp_oauth_tokens
             WHERE server_name = ?1 AND server_url = ?2",
            params![server_name, server_url],
            |row| {
                Ok(McpOAuthToken {
                    server_name: row.get(0)?,
                    server_url: row.get(1)?,
                    access_token: row.get(2)?,
                    refresh_token: row.get(3)?,
                    expires_at: row.get(4)?,
                    scopes: row.get(5)?,
                    token_type: row.get(6)?,
                    resource: row.get(7)?,
                    issuer: row.get(8)?,
                    authorization_endpoint: row.get(9)?,
                    token_endpoint: row.get(10)?,
                    client_id: row.get(11)?,
                    client_secret: row.get(12)?,
                    token_endpoint_auth_method: row.get(13)?,
                    redirect_uri: row.get(14)?,
                })
            },
        )
        .optional()
    })
}

fn delete_token(db: &MemoryDb, server_name: &str, server_url: &str) -> Result<(), String> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM mcp_oauth_tokens WHERE server_name = ?1 AND server_url = ?2",
            params![server_name, server_url],
        )?;
        Ok(())
    })
}

async fn exchange_token(
    client: &reqwest::Client,
    session: &PendingMcpOAuthSession,
    code: &str,
) -> Result<McpOAuthToken, String> {
    let auth_method = session
        .client
        .token_endpoint_auth_method
        .clone()
        .unwrap_or_else(|| choose_token_auth_method(&session.discovery.oauth));
    let mut params = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), session.redirect_uri.clone()),
        ("client_id".to_string(), session.client.client_id.clone()),
        ("code_verifier".to_string(), session.code_verifier.clone()),
    ];
    if auth_method == "client_secret_post" {
        if let Some(secret) = &session.client.client_secret {
            params.push(("client_secret".to_string(), secret.clone()));
        }
    }
    if let Some(resource) = session
        .discovery
        .resource
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        params.push(("resource".to_string(), resource.to_string()));
    }

    let mut request = client
        .post(&session.discovery.oauth.token_endpoint)
        .header("Accept", "application/json")
        .form(&params);
    if auth_method == "client_secret_basic" {
        let secret = session.client.client_secret.clone().unwrap_or_default();
        let basic = BASE64_STANDARD.encode(format!("{}:{}", session.client.client_id, secret));
        request = request.header("Authorization", format!("Basic {}", basic));
    }

    let resp = request.send().await.map_err(|error| {
        public_mcp_oauth_failure(
            "token.exchange.request",
            error.to_string(),
            "MCP OAuth token exchange failed.",
        )
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|error| {
        public_mcp_oauth_failure(
            "token.exchange.read",
            error.to_string(),
            "MCP OAuth token exchange response could not be read.",
        )
    })?;
    if !status.is_success() {
        return Err(public_mcp_oauth_failure(
            "token.exchange.http",
            format!("status={} body={}", status, text),
            &format!("MCP OAuth token exchange failed (HTTP {}).", status),
        ));
    }
    let parsed: TokenResponse = serde_json::from_str(&text).map_err(|error| {
        public_mcp_oauth_failure(
            "token.exchange.json",
            format!("error={} body={}", error, text),
            "MCP OAuth token exchange response was invalid.",
        )
    })?;
    let expires_at = token::now_ms() + parsed.expires_in.unwrap_or(DEFAULT_EXPIRES_IN_SECS) * 1000;
    Ok(McpOAuthToken {
        server_name: session.server_name.clone(),
        server_url: session.server_url.clone(),
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at,
        scopes: scope_from_value(parsed.scope).unwrap_or_else(|| session.discovery.scope.clone()),
        token_type: parsed.token_type.unwrap_or_else(|| "Bearer".to_string()),
        resource: session.discovery.resource.clone(),
        issuer: session.discovery.oauth.issuer.clone(),
        authorization_endpoint: session.discovery.oauth.authorization_endpoint.clone(),
        token_endpoint: session.discovery.oauth.token_endpoint.clone(),
        client_id: session.client.client_id.clone(),
        client_secret: session.client.client_secret.clone(),
        token_endpoint_auth_method: auth_method,
        redirect_uri: session.redirect_uri.clone(),
    })
}

async fn refresh_token(
    client: &reqwest::Client,
    prev: &McpOAuthToken,
) -> Result<McpOAuthToken, String> {
    let refresh = prev.refresh_token.as_ref().ok_or_else(|| {
        "No refresh token is available. Please authorize this MCP again.".to_string()
    })?;
    let auth_method = prev.token_endpoint_auth_method.as_str();
    let mut params = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh.clone()),
        ("client_id".to_string(), prev.client_id.clone()),
    ];
    if auth_method == "client_secret_post" {
        if let Some(secret) = &prev.client_secret {
            params.push(("client_secret".to_string(), secret.clone()));
        }
    }
    if let Some(resource) = prev
        .resource
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        params.push(("resource".to_string(), resource.to_string()));
    }

    let mut request = client
        .post(&prev.token_endpoint)
        .header("Accept", "application/json")
        .form(&params);
    if auth_method == "client_secret_basic" {
        let secret = prev.client_secret.clone().unwrap_or_default();
        let basic = BASE64_STANDARD.encode(format!("{}:{}", prev.client_id, secret));
        request = request.header("Authorization", format!("Basic {}", basic));
    }

    let resp = request.send().await.map_err(|error| {
        public_mcp_oauth_failure(
            "token.refresh.request",
            error.to_string(),
            "MCP OAuth session expired. Please authorize again.",
        )
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|error| {
        public_mcp_oauth_failure(
            "token.refresh.read",
            error.to_string(),
            "MCP OAuth session expired. Please authorize again.",
        )
    })?;
    if !status.is_success() {
        return Err(public_mcp_oauth_failure(
            "token.refresh.http",
            format!("status={} body={}", status, text),
            &format!(
                "MCP OAuth session expired. Please authorize again. (HTTP {})",
                status
            ),
        ));
    }
    let parsed: TokenResponse = serde_json::from_str(&text).map_err(|error| {
        public_mcp_oauth_failure(
            "token.refresh.json",
            format!("error={} body={}", error, text),
            "MCP OAuth session expired. Please authorize again.",
        )
    })?;
    let mut next = prev.clone();
    next.access_token = parsed.access_token;
    if let Some(refresh_token) = parsed.refresh_token {
        next.refresh_token = Some(refresh_token);
    }
    next.expires_at = token::now_ms() + parsed.expires_in.unwrap_or(DEFAULT_EXPIRES_IN_SECS) * 1000;
    if let Some(scope) = scope_from_value(parsed.scope) {
        next.scopes = scope;
    }
    if let Some(token_type) = parsed.token_type {
        next.token_type = token_type;
    }
    Ok(next)
}

pub async fn headers_with_mcp_oauth(
    db: &MemoryDb,
    server_name: &str,
    server_url: &str,
    base_headers: &HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let mut headers = base_headers.clone();
    if headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("authorization"))
    {
        return Ok(headers);
    }

    let Some(mut current) = load_token(db, server_name, server_url)? else {
        return Ok(headers);
    };
    if token::now_ms() + token::REFRESH_THRESHOLD_MS >= current.expires_at {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to create OAuth HTTP client: {}", e))?;
        current = refresh_token(&client, &current).await?;
        save_token(db, &current)?;
    }

    headers.insert(
        "Authorization".to_string(),
        format!("{} {}", current.token_type, current.access_token),
    );
    Ok(headers)
}

pub async fn mcp_servers_with_oauth_headers(
    db: &MemoryDb,
    mcp_servers: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    let mut next = mcp_servers?;
    let Some(servers) = next.as_object_mut() else {
        return Some(next);
    };

    for (name, config) in servers.iter_mut() {
        let Some(config_obj) = config.as_object_mut() else {
            continue;
        };
        let server_type = config_obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("stdio");
        if server_type != "http" && server_type != "sse" {
            continue;
        }
        let Some(url) = config_obj.get("url").and_then(|v| v.as_str()) else {
            continue;
        };

        let base_headers: HashMap<String, String> = config_obj
            .get("headers")
            .and_then(|headers| headers.as_object())
            .map(|headers| {
                headers
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|value| (key.clone(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();

        let headers = match headers_with_mcp_oauth(db, name, url, &base_headers).await {
            Ok(headers) => headers,
            Err(err) => {
                let _ = public_mcp_oauth_failure(
                    "header.inject",
                    format!("server={} error={}", name, err),
                    "MCP OAuth header injection failed.",
                );
                continue;
            }
        };
        if headers.is_empty() {
            continue;
        }

        let headers_value = config_obj
            .entry("headers".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(headers_obj) = headers_value.as_object_mut() {
            for (key, value) in headers {
                headers_obj.insert(key, serde_json::json!(value));
            }
        }
    }

    Some(next)
}

#[tauri::command]
pub async fn mcp_auth_inspect(
    config: serde_json::Value,
) -> Result<McpAuthInspectionResult, String> {
    let server_url = config_url(&config)?;
    if config_has_authorization_header(&config) {
        return Ok(McpAuthInspectionResult {
            mode: "token".to_string(),
            can_authorize: false,
            message: "Manual Authorization header is configured.".to_string(),
            resource: None,
            scopes: None,
            authorization_endpoint: None,
            token_endpoint: None,
            registration_endpoint: None,
        });
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| {
            public_mcp_oauth_failure(
                "inspection.client",
                error.to_string(),
                "MCP authentication inspection is temporarily unavailable.",
            )
        })?;
    inspect_mcp_auth_for_url(&client, &server_url)
        .await
        .map_err(|error| {
            public_mcp_oauth_failure(
                "inspection.failed",
                error,
                "MCP authentication inspection failed.",
            )
        })
}

#[tauri::command]
pub async fn mcp_oauth_start(
    app: AppHandle,
    manager: State<'_, McpOAuthManager>,
    name: String,
    config: serde_json::Value,
) -> Result<McpOAuthStartResult, String> {
    manager.gc_expired();
    let server_url = config_url(&config)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| {
            public_mcp_oauth_failure(
                "start.client",
                error.to_string(),
                "MCP OAuth authorization is temporarily unavailable.",
            )
        })?;
    let discovery = discover_mcp_oauth(&client, &server_url)
        .await
        .map_err(|error| {
            public_mcp_oauth_failure(
                "start.discovery",
                error,
                "MCP OAuth metadata could not be resolved.",
            )
        })?;
    let (listener, redirect_uri) = create_callback_listener().map_err(|error| {
        public_mcp_oauth_failure(
            "start.listener",
            error,
            "MCP OAuth callback could not be started.",
        )
    })?;
    let registration = register_dynamic_client(&client, &discovery, &redirect_uri)
        .await
        .map_err(|error| {
            public_mcp_oauth_failure(
                "start.registration",
                error,
                "MCP OAuth client registration failed.",
            )
        })?;
    let verifier = pkce::generate_verifier();
    let challenge = pkce::challenge_from_verifier(&verifier);
    let state = pkce::generate_state();
    let authorize_url = build_authorize_url(
        &discovery,
        &registration.client_id,
        &redirect_uri,
        &state,
        &challenge,
    )
    .map_err(|error| {
        public_mcp_oauth_failure(
            "start.authorize_url",
            error,
            "MCP OAuth authorization URL was invalid.",
        )
    })?;
    let callback = Arc::new(Mutex::new(None));
    start_callback_listener(listener, state.clone(), callback.clone());

    {
        let mut pending = manager.pending.lock().map_err(|error| {
            public_mcp_oauth_failure(
                "start.lock",
                error.to_string(),
                "MCP OAuth authorization is temporarily unavailable.",
            )
        })?;
        pending.insert(
            state.clone(),
            PendingMcpOAuthSession {
                server_name: name,
                server_url,
                code_verifier: verifier,
                state: state.clone(),
                redirect_uri,
                discovery: discovery.clone(),
                client: registration,
                callback,
                created_at: SystemTime::now(),
            },
        );
    }

    let browser_opened = app
        .opener()
        .open_url(authorize_url.clone(), None::<String>)
        .is_ok();

    Ok(McpOAuthStartResult {
        authorize_url,
        state,
        browser_opened,
        resource: discovery.resource,
        scopes: discovery.scope,
    })
}

#[tauri::command]
pub async fn mcp_oauth_complete(
    manager: State<'_, McpOAuthManager>,
    db: State<'_, MemoryDb>,
    state: String,
) -> Result<McpOAuthPollResult, String> {
    let callback = {
        let pending = manager.pending.lock().map_err(|error| {
            public_mcp_oauth_failure(
                "complete.lock.read",
                error.to_string(),
                "MCP OAuth authorization is temporarily unavailable.",
            )
        })?;
        let session = pending.get(&state).ok_or_else(|| {
            "OAuth session expired. Please start authorization again.".to_string()
        })?;
        let callback = session
            .callback
            .lock()
            .map_err(|error| {
                public_mcp_oauth_failure(
                    "complete.callback.lock",
                    error.to_string(),
                    "MCP OAuth authorization is temporarily unavailable.",
                )
            })?
            .clone();
        callback
    };

    let Some(callback) = callback else {
        return Ok(McpOAuthPollResult {
            status: "pending".to_string(),
            message: None,
            expires_at: None,
            scopes: None,
            token_type: None,
        });
    };

    if let Some(error) = callback.error {
        let mut pending = manager.pending.lock().map_err(|lock_error| {
            public_mcp_oauth_failure(
                "complete.lock.error",
                lock_error.to_string(),
                "MCP OAuth authorization is temporarily unavailable.",
            )
        })?;
        pending.remove(&state);
        return Ok(McpOAuthPollResult {
            status: "error".to_string(),
            message: Some(public_mcp_oauth_failure(
                "complete.callback",
                error,
                "MCP OAuth authorization failed. Please try again.",
            )),
            expires_at: None,
            scopes: None,
            token_type: None,
        });
    }

    if callback.state.as_deref() != Some(state.as_str()) {
        let mut pending = manager.pending.lock().map_err(|error| {
            public_mcp_oauth_failure(
                "complete.lock.state",
                error.to_string(),
                "MCP OAuth authorization is temporarily unavailable.",
            )
        })?;
        pending.remove(&state);
        return Ok(McpOAuthPollResult {
            status: "error".to_string(),
            message: Some(
                "OAuth callback state did not match. Please restart authorization.".to_string(),
            ),
            expires_at: None,
            scopes: None,
            token_type: None,
        });
    }

    let code = callback
        .code
        .ok_or_else(|| "OAuth callback did not include an authorization code.".to_string())?;
    let session = {
        let mut pending = manager.pending.lock().map_err(|error| {
            public_mcp_oauth_failure(
                "complete.lock.take",
                error.to_string(),
                "MCP OAuth authorization is temporarily unavailable.",
            )
        })?;
        pending
            .remove(&state)
            .ok_or_else(|| "OAuth session expired. Please start authorization again.".to_string())?
    };
    if session.state != state {
        return Err("OAuth session state did not match. Please restart authorization.".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| {
            public_mcp_oauth_failure(
                "complete.client",
                error.to_string(),
                "MCP OAuth token exchange is temporarily unavailable.",
            )
        })?;
    let token_info = exchange_token(&client, &session, &code)
        .await
        .map_err(|error| {
            public_mcp_oauth_failure(
                "complete.exchange",
                error,
                "MCP OAuth token exchange failed.",
            )
        })?;
    save_token(&db, &token_info).map_err(|error| {
        public_mcp_oauth_failure(
            "complete.storage",
            error,
            "MCP OAuth credentials could not be saved.",
        )
    })?;

    Ok(McpOAuthPollResult {
        status: "authorized".to_string(),
        message: Some(format!("Authorized {}", session.server_name)),
        expires_at: Some(token_info.expires_at),
        scopes: Some(token_info.scopes),
        token_type: Some(token_info.token_type),
    })
}

#[tauri::command]
pub fn mcp_oauth_get_status(
    db: State<'_, MemoryDb>,
    name: String,
    config: serde_json::Value,
) -> Result<McpOAuthStatusResult, String> {
    let server_url = config_url(&config)?;
    let Some(token_info) = load_token(&db, &name, &server_url).map_err(|error| {
        public_mcp_oauth_failure(
            "status.storage",
            error,
            "MCP OAuth status is temporarily unavailable.",
        )
    })?
    else {
        return Ok(McpOAuthStatusResult {
            authorized: false,
            expires_at: None,
            scopes: None,
            token_type: None,
        });
    };
    Ok(McpOAuthStatusResult {
        authorized: true,
        expires_at: Some(token_info.expires_at),
        scopes: Some(token_info.scopes),
        token_type: Some(token_info.token_type),
    })
}

#[tauri::command]
pub fn mcp_oauth_sign_out(
    db: State<'_, MemoryDb>,
    name: String,
    config: serde_json::Value,
) -> Result<(), String> {
    let server_url = config_url(&config)?;
    delete_token(&db, &name, &server_url).map_err(|error| {
        public_mcp_oauth_failure("sign_out.storage", error, "MCP OAuth sign-out failed.")
    })
}

#[cfg(test)]
mod privacy_tests {
    use super::*;
    use std::net::TcpListener;

    fn serve_once(status_line: &str, body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status_line = status_line.to_string();
        let body = body.to_string();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            let response = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status_line,
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        format!("http://{}/metadata", address)
    }

    #[tokio::test]
    async fn metadata_http_error_never_echoes_remote_body() {
        let sentinel = "REMOTE_BODY_SENTINEL access_token=private";
        let url = serve_once("400 Bad Request", sentinel);
        let client = reqwest::Client::new();
        let error = get_json::<serde_json::Value>(&client, &url, "metadata")
            .await
            .unwrap_err();

        assert!(error.contains("HTTP 400"));
        assert!(!error.contains("REMOTE_BODY_SENTINEL"));
        assert!(!error.contains("access_token"));
    }

    #[tokio::test]
    async fn malformed_metadata_never_echoes_remote_body() {
        let sentinel = "MALFORMED_JSON_SENTINEL";
        let url = serve_once("200 OK", sentinel);
        let client = reqwest::Client::new();
        let error = get_json::<serde_json::Value>(&client, &url, "metadata")
            .await
            .unwrap_err();

        assert_eq!(error, "OAuth metadata response was invalid.");
        assert!(!error.contains("MALFORMED_JSON_SENTINEL"));
    }

    #[test]
    fn public_mcp_failure_never_echoes_secret_or_path_detail() {
        let error = public_mcp_oauth_failure(
            "test",
            "TOKEN_SENTINEL /Users/private/mcp.json",
            "MCP OAuth failed.",
        );
        assert_eq!(error, "MCP OAuth failed.");
        assert!(!error.contains("TOKEN_SENTINEL"));
        assert!(!error.contains("/Users/private"));
    }

    #[test]
    fn oauth_rejects_unsafe_mcp_urls_without_echoing_them() {
        for raw in [
            "https://user:secret@remote.example/mcp",
            "https://remote.example/mcp?token=OAUTH_QUERY_SENTINEL",
            "https://remote.example/mcp#OAUTH_FRAGMENT_SENTINEL",
        ] {
            let error = config_url(&serde_json::json!({
                "type": "http",
                "url": raw,
            }))
            .expect_err("unsafe OAuth MCP URL must be rejected");
            assert!(error.starts_with("Invalid remote MCP URL (diagnosticId: "));
            assert!(!error.contains(raw));
            assert!(!error.contains("secret"));
            assert!(!error.contains("OAUTH_QUERY_SENTINEL"));
            assert!(!error.contains("OAUTH_FRAGMENT_SENTINEL"));
        }
    }
}
