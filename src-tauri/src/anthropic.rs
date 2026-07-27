use futures_util::StreamExt;
use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::net::TcpStream;
use tokio::time::timeout;
use url::Url;

const DEFAULT_MODEL: &str = "claude-opus-4-7";
/// Fast, cheap model used for lightweight tasks like title generation.
const FAST_MODEL: &str = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// HTTP client — shared default instance + per-proxy builders
// ---------------------------------------------------------------------------

/// Cached default HTTP client (no proxy). `reqwest::Client` is `Arc`-backed so
/// `.clone()` is cheap and shares the underlying connection pool & TLS sessions.
static DEFAULT_CLIENT: OnceLock<Client> = OnceLock::new();

fn provider_diagnostic_id(detail: &str) -> String {
    let digest = Sha256::digest(detail.as_bytes());
    format!("{digest:x}").chars().take(12).collect()
}

pub(crate) fn auth_debug_secret(value: &str) -> String {
    if value.is_empty() {
        return "(empty)".to_string();
    }
    format!(
        "len={} sha256={}",
        value.len(),
        provider_diagnostic_id(value)
    )
}

pub(crate) fn auth_debug_base_url(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "(default)".to_string();
    }
    match Url::parse(trimmed) {
        Ok(parsed) => format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()),
        Err(_) => format!(
            "(invalid len={} sha256={})",
            trimmed.len(),
            provider_diagnostic_id(trimmed)
        ),
    }
}

fn public_provider_error(category: &str, detail: &str, status: Option<u16>) -> String {
    let digest = Sha256::digest(detail.as_bytes());
    log::warn!(
        "[provider-network] category={} status={} len={} sha256={:x}",
        category,
        status
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string()),
        detail.len(),
        digest
    );
    let diagnostic_id = provider_diagnostic_id(detail);
    match status {
        Some(status) => format!("{category} (HTTP {status}, diagnosticId: {diagnostic_id})"),
        None => format!("{category} (diagnosticId: {diagnostic_id})"),
    }
}

fn validate_proxy_url(url: &str) -> Result<(), String> {
    if url.chars().any(char::is_control) {
        return Err(public_provider_error("Invalid proxy protocol", url, None));
    }
    let parsed =
        Url::parse(url).map_err(|_| public_provider_error("Invalid proxy URL", url, None))?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h")
        || parsed.host_str().is_none()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(public_provider_error("Invalid proxy URL", url, None));
    }
    Ok(())
}

fn reqwest_proxy_url(proxy_url: &str) -> String {
    let trimmed = proxy_url.trim();
    const SOCKS5_SCHEME: &str = "socks5://";

    if trimmed.len() >= SOCKS5_SCHEME.len()
        && trimmed[..SOCKS5_SCHEME.len()].eq_ignore_ascii_case(SOCKS5_SCHEME)
    {
        format!("socks5h://{}", &trimmed[SOCKS5_SCHEME.len()..])
    } else {
        trimmed.to_string()
    }
}

/// Build a new HTTP client with an optional proxy.  Private — use `get_client`.
fn build_proxy_client(proxy_url: &str) -> Result<Client, String> {
    let trimmed = proxy_url.trim();
    validate_proxy_url(trimmed)?;
    let proxy_url = reqwest_proxy_url(trimmed);
    let proxy = Proxy::all(&proxy_url)
        .map_err(|error| public_provider_error("Invalid proxy URL", &error.to_string(), None))?;
    Client::builder().proxy(proxy).build().map_err(|error| {
        public_provider_error(
            "Proxy HTTP client could not be created",
            &error.to_string(),
            None,
        )
    })
}

/// Get a (possibly cached) HTTP client.  When no proxy is configured the shared
/// default client is returned, reusing its connection pool across all requests.
pub(crate) fn get_client(proxy_url: Option<&str>) -> Result<Client, String> {
    match proxy_url.map(str::trim).filter(|u| !u.is_empty()) {
        Some(url) => build_proxy_client(url),
        None => Ok(DEFAULT_CLIENT
            .get_or_init(|| {
                Client::builder()
                    .no_proxy()
                    .build()
                    .expect("Failed to build default HTTP client")
            })
            .clone()),
    }
}

// ---------------------------------------------------------------------------
// Common non-streaming request helpers (per provider)
//
// These extract the repetitive send → check status → parse response pattern
// so that callers only need to build the request JSON body.
// ---------------------------------------------------------------------------

/// Construct the Anthropic Messages API URL from an optional base URL.
fn anthropic_url(base_url: Option<&str>) -> Result<String, String> {
    let host = base_url
        .filter(|u| !u.is_empty())
        .unwrap_or("https://api.anthropic.com");
    let host = validate_api_base_url(host)?;
    Ok(format!("{}/v1/messages", host.trim_end_matches('/')))
}

/// Construct the OpenAI-compatible Chat Completions URL.
fn openai_url(base_url: Option<&str>) -> Result<String, String> {
    let host = base_url
        .filter(|u| !u.is_empty())
        .ok_or("Base URL is required for OpenAI-compatible providers")?;
    let host = validate_api_base_url(host)?;
    Ok(format!("{}/chat/completions", host.trim_end_matches('/')))
}

/// Construct the Gemini generateContent URL.
fn gemini_url(base_url: Option<&str>, model: &str) -> Result<String, String> {
    let host = base_url
        .filter(|u| !u.is_empty())
        .unwrap_or("https://generativelanguage.googleapis.com");
    let host = validate_api_base_url(host)?;
    Ok(format!(
        "{}/v1beta/models/{}:generateContent",
        host.trim_end_matches('/'),
        model
    ))
}

pub(crate) fn validate_api_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim();
    let parsed =
        Url::parse(trimmed).map_err(|_| "Provider base URL is not a valid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Provider base URL must use HTTP(S) and include a host".to_string());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Provider base URL must not include credentials, query parameters, or fragments"
                .to_string(),
        );
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

fn trim_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn extract_openai_content_fragment(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => (!text.is_empty()).then(|| text.to_string()),
        serde_json::Value::Array(items) => {
            let combined = items
                .iter()
                .filter_map(extract_openai_content_fragment)
                .collect::<Vec<_>>()
                .join("");
            (!combined.is_empty()).then_some(combined)
        }
        serde_json::Value::Object(map) => map
            .get("text")
            .and_then(|text| match text {
                serde_json::Value::String(text) => (!text.is_empty()).then(|| text.to_string()),
                serde_json::Value::Object(text_obj) => text_obj
                    .get("value")
                    .and_then(|value| value.as_str())
                    .and_then(|value| (!value.is_empty()).then(|| value.to_string())),
                _ => None,
            })
            .or_else(|| map.get("content").and_then(extract_openai_content_fragment))
            .or_else(|| {
                map.get("output_text")
                    .and_then(extract_openai_content_fragment)
            })
            .or_else(|| map.get("value").and_then(extract_openai_content_fragment)),
        _ => None,
    }
}

fn extract_openai_content_text(value: &serde_json::Value) -> Option<String> {
    extract_openai_content_fragment(value).and_then(|text| trim_non_empty(&text))
}

fn extract_openai_response_text(value: &serde_json::Value) -> Option<String> {
    value["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .and_then(|choice| {
            extract_openai_content_text(&choice["message"]["content"])
                .or_else(|| choice["text"].as_str().and_then(trim_non_empty))
        })
        .or_else(|| {
            value
                .get("output_text")
                .and_then(extract_openai_content_text)
        })
        .or_else(|| value.get("output").and_then(extract_openai_content_text))
        .or_else(|| value.get("content").and_then(extract_openai_content_text))
}

fn body_looks_like_html(body: &str) -> bool {
    let trimmed = body.trim_start();
    trimmed.starts_with("<!DOCTYPE html")
        || trimmed.starts_with("<!doctype html")
        || trimmed.starts_with("<html")
}

fn openai_endpoint_candidates(url_or_base: &str, endpoint: &str) -> Vec<String> {
    let trimmed = url_or_base.trim().trim_end_matches('/');
    let base = trimmed
        .strip_suffix("/chat/completions")
        .or_else(|| trimmed.strip_suffix("/responses"))
        .unwrap_or(trimmed)
        .trim_end_matches('/');

    let primary = format!("{}/{}", base, endpoint);
    let fallback = format!("{}/v1/{}", base, endpoint);

    let mut candidates = vec![primary];
    if !base.ends_with("/v1") && !candidates.contains(&fallback) {
        candidates.push(fallback);
    }
    candidates
}

fn openai_base_url_hint(body: &str) -> &'static str {
    if body_looks_like_html(body) {
        " The response looked like an HTML page. The Base URL may be pointing to a website homepage instead of the OpenAI-compatible API endpoint. If your gateway exposes APIs under /v1, configure or use the Base URL with /v1."
    } else {
        ""
    }
}

/// Send a non-streaming request to the Anthropic Messages API and extract
/// text blocks from the response.
async fn send_anthropic(
    client: &Client,
    url: &str,
    api_key: &str,
    body: serde_json::Value,
) -> Result<String, String> {
    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| {
            public_provider_error("Provider network request failed", &error.to_string(), None)
        })?;

    let status = resp.status();
    let body_text = resp.text().await.map_err(|error| {
        public_provider_error(
            "Provider response could not be read",
            &error.to_string(),
            Some(status.as_u16()),
        )
    })?;

    if !status.is_success() {
        return Err(public_provider_error(
            "Provider request failed",
            &body_text,
            Some(status.as_u16()),
        ));
    }

    serde_json::from_str::<serde_json::Value>(&body_text)
        .ok()
        .and_then(|v| {
            v["content"].as_array().map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| block["text"].as_str().map(str::trim))
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            public_provider_error(
                "Provider response format was invalid",
                &body_text,
                Some(status.as_u16()),
            )
        })
}

/// Send a non-streaming request to an OpenAI-compatible Chat Completions API
/// and extract the assistant message content.
async fn send_openai(
    client: &Client,
    url: &str,
    api_key: &str,
    body: serde_json::Value,
) -> Result<String, String> {
    let candidate_urls = openai_endpoint_candidates(url, "chat/completions");
    let mut last_error: Option<String> = None;

    for (index, candidate_url) in candidate_urls.iter().enumerate() {
        let resp = client
            .post(candidate_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|error| {
                public_provider_error("Provider network request failed", &error.to_string(), None)
            })?;

        let status = resp.status();
        let body_text = resp.text().await.map_err(|error| {
            public_provider_error(
                "Provider response could not be read",
                &error.to_string(),
                Some(status.as_u16()),
            )
        })?;
        let html_hint = openai_base_url_hint(&body_text);

        if !status.is_success() {
            let err = format!(
                "{}{}",
                public_provider_error("Provider request failed", &body_text, Some(status.as_u16())),
                html_hint
            );
            if index + 1 < candidate_urls.len()
                && (status.as_u16() == 404 || body_looks_like_html(&body_text))
            {
                last_error = Some(err);
                continue;
            }
            return Err(err);
        }

        let parsed = match serde_json::from_str::<serde_json::Value>(&body_text) {
            Ok(parsed) => parsed,
            Err(_) => {
                let err = format!(
                    "{}{}",
                    public_provider_error(
                        "Provider response format was invalid",
                        &body_text,
                        Some(status.as_u16())
                    ),
                    html_hint
                );
                if index + 1 < candidate_urls.len() && body_looks_like_html(&body_text) {
                    last_error = Some(err);
                    continue;
                }
                return Err(err);
            }
        };

        if let Some(text) = extract_openai_response_text(&parsed) {
            return Ok(text);
        }

        let err = format!(
            "{}{}",
            public_provider_error(
                "Provider response format was invalid",
                &body_text,
                Some(status.as_u16())
            ),
            html_hint
        );
        if index + 1 < candidate_urls.len() && body_looks_like_html(&body_text) {
            last_error = Some(err);
            continue;
        }
        return Err(err);
    }

    Err(last_error.unwrap_or_else(|| "OpenAI-compatible request failed".to_string()))
}

/// Send a non-streaming request to the Google Gemini API and extract the
/// first text part from the response.
async fn send_gemini(
    client: &Client,
    url: &str,
    api_key: &str,
    body: serde_json::Value,
) -> Result<String, String> {
    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .header("x-goog-api-key", api_key)
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| {
            public_provider_error("Provider network request failed", &error.to_string(), None)
        })?;

    let status = resp.status();
    let body_text = resp.text().await.map_err(|error| {
        public_provider_error(
            "Provider response could not be read",
            &error.to_string(),
            Some(status.as_u16()),
        )
    })?;

    if !status.is_success() {
        return Err(public_provider_error(
            "Provider request failed",
            &body_text,
            Some(status.as_u16()),
        ));
    }

    serde_json::from_str::<serde_json::Value>(&body_text)
        .ok()
        .and_then(|v| {
            v["candidates"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|c| {
                    c["content"]["parts"]
                        .as_array()
                        .and_then(|parts| parts.first())
                        .and_then(|p| p["text"].as_str().map(|s| s.trim().to_string()))
                })
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            public_provider_error(
                "Provider response format was invalid",
                &body_text,
                Some(status.as_u16()),
            )
        })
}

// ---------------------------------------------------------------------------
// Unified lightweight AI call — single entry point for all SDK types.
//
// Callers just provide `sdk`, `model`, `base_url`, `api_key`, system/user
// prompts and max_tokens.  The function handles URL construction, body
// formatting, header selection, sending and response parsing automatically.
// ---------------------------------------------------------------------------

/// Default fallback base URL per SDK when the caller doesn't provide one.
fn default_base_url(sdk: &str) -> &'static str {
    match sdk {
        "claude" => "https://api.anthropic.com",
        "codex" => "https://api.openai.com/v1",
        "gemini" => "https://generativelanguage.googleapis.com",
        _ => "https://api.openai.com/v1", // chatcmpl platforms supply their own
    }
}

/// Default fallback model per SDK when the caller doesn't provide one.
fn default_model(sdk: &str) -> &'static str {
    match sdk {
        "claude" => FAST_MODEL,
        "gemini" => "gemini-2.5-flash",
        _ => "gpt-4o-mini", // codex / chatcmpl
    }
}

/// Perform a simple non-streaming AI call, routing to the correct provider API
/// based on the `sdk` parameter ("claude" | "codex" | "gemini" | "chatcmpl").
#[allow(clippy::too_many_arguments)]
async fn call_ai_simple(
    sdk: &str,
    model: Option<String>,
    base_url: Option<String>,
    api_key: &str,
    system_prompt: &str,
    user_content: &str,
    max_tokens: u32,
    proxy_url: Option<&str>,
) -> Result<String, String> {
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| default_model(sdk).to_string());
    let base = base_url
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| default_base_url(sdk).to_string());
    let base = validate_api_base_url(&base)?;
    let base_ref = base.as_str();

    match sdk {
        "claude" => {
            let url = format!("{}/v1/messages", base_ref);
            let client = get_client(proxy_url)?;
            let body = serde_json::json!({
                "model": model,
                "max_tokens": max_tokens,
                "system": system_prompt,
                "messages": [{ "role": "user", "content": user_content }],
            });
            send_anthropic(&client, &url, api_key, body).await
        }
        "gemini" => {
            let url = gemini_url(Some(base_ref), &model)?;
            let client = get_client(proxy_url)?;
            let body = serde_json::json!({
                "systemInstruction": { "parts": [{ "text": system_prompt }] },
                "contents": [{ "parts": [{ "text": user_content }] }],
                "generationConfig": { "maxOutputTokens": max_tokens },
            });
            send_gemini(&client, &url, api_key, body).await
        }
        // codex, chatcmpl — all OpenAI-compatible
        _ => {
            let url = format!("{}/chat/completions", base_ref);
            let client = get_client(proxy_url)?;
            let body = serde_json::json!({
                "model": model,
                "max_tokens": max_tokens,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": user_content },
                ],
            });
            send_openai(&client, &url, api_key, body).await
        }
    }
}

// ---------------------------------------------------------------------------
// Shared message type (used by sidecar bridge)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageData {
    pub media_type: String,
    pub data: String,
}

// ---------------------------------------------------------------------------
// Proxy connectivity test
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ProxyTestStage {
    pub id: String,
    pub success: bool,
    pub message: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyTestResult {
    pub success: bool,
    pub message: String,
    pub elapsed_ms: u64,
    pub reply: Option<String>,
    pub stages: Vec<ProxyTestStage>,
    pub quality: Option<ProxyQualityInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyQualityInfo {
    pub ip: String,
    pub quality_score: Option<u8>,
    pub risk_score: Option<u8>,
    pub risk_level: String,
    pub provider: Option<String>,
    pub asn: Option<String>,
    pub isp_type: Option<String>,
    pub broadband_type: Option<String>,
    pub native_ip: Option<bool>,
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub isocode: Option<String>,
    pub proxy: Option<bool>,
    pub proxy_type: Option<String>,
}

pub(crate) fn parse_proxy_endpoint(proxy_url: &str) -> Result<(String, u16), String> {
    validate_proxy_url(proxy_url)?;
    let parsed = Url::parse(proxy_url)
        .map_err(|error| public_provider_error("Invalid proxy URL", &error.to_string(), None))?;
    let host = parsed
        .host_str()
        .filter(|h| !h.trim().is_empty())
        .ok_or_else(|| "Proxy host is empty".to_string())?
        .to_string();
    let port = parsed
        .port()
        .or_else(|| match parsed.scheme() {
            "http" => Some(80),
            "https" => Some(443),
            "socks5" => Some(1080),
            "socks5h" => Some(1080),
            _ => None,
        })
        .ok_or_else(|| "Proxy port is empty".to_string())?;
    Ok((host, port))
}

async fn test_local_proxy_service(proxy_url: &str) -> ProxyTestStage {
    let start = Instant::now();
    let (host, port) = match parse_proxy_endpoint(proxy_url) {
        Ok(endpoint) => endpoint,
        Err(e) => {
            return ProxyTestStage {
                id: "local".to_string(),
                success: false,
                message: e,
                elapsed_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    match timeout(
        Duration::from_secs(5),
        TcpStream::connect((host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(_stream)) => ProxyTestStage {
            id: "local".to_string(),
            success: true,
            message: format!(
                "Proxy service reachable ({}ms)",
                start.elapsed().as_millis()
            ),
            elapsed_ms: start.elapsed().as_millis() as u64,
        },
        Ok(Err(error)) => {
            let message =
                public_provider_error("Proxy service is unreachable", &error.to_string(), None);
            ProxyTestStage {
                id: "local".to_string(),
                success: false,
                message,
                elapsed_ms: start.elapsed().as_millis() as u64,
            }
        }
        Err(_) => ProxyTestStage {
            id: "local".to_string(),
            success: false,
            message: "Proxy service timed out after 5 seconds".to_string(),
            elapsed_ms: start.elapsed().as_millis() as u64,
        },
    }
}

#[tauri::command]
pub async fn test_proxy(
    proxy_url: String,
    target_url: Option<String>,
) -> Result<ProxyTestResult, String> {
    let trimmed = proxy_url.trim();
    if trimmed.is_empty() {
        return Ok(ProxyTestResult {
            success: false,
            message: "Proxy URL is empty".to_string(),
            elapsed_ms: 0,
            reply: None,
            quality: None,
            stages: vec![
                ProxyTestStage {
                    id: "local".to_string(),
                    success: false,
                    message: "Proxy URL is empty".to_string(),
                    elapsed_ms: 0,
                },
                ProxyTestStage {
                    id: "target".to_string(),
                    success: false,
                    message: "Skipped because local proxy service was not tested".to_string(),
                    elapsed_ms: 0,
                },
            ],
        });
    }

    let mut stages = Vec::with_capacity(2);
    let local_stage = test_local_proxy_service(trimmed).await;
    let local_elapsed = local_stage.elapsed_ms;
    let local_success = local_stage.success;
    let local_message = local_stage.message.clone();
    stages.push(local_stage);

    if !local_success {
        stages.push(ProxyTestStage {
            id: "target".to_string(),
            success: false,
            message: "Skipped because local proxy service is unreachable".to_string(),
            elapsed_ms: 0,
        });
        return Ok(ProxyTestResult {
            success: false,
            message: local_message,
            elapsed_ms: local_elapsed,
            reply: None,
            quality: None,
            stages,
        });
    }

    let target = target_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or("https://api.anthropic.com");
    let client = match get_client(Some(trimmed)) {
        Ok(client) => client,
        Err(error) => {
            stages.push(ProxyTestStage {
                id: "target".to_string(),
                success: false,
                message: error.clone(),
                elapsed_ms: 0,
            });
            return Ok(ProxyTestResult {
                success: false,
                message: error,
                elapsed_ms: local_elapsed,
                reply: None,
                quality: None,
                stages,
            });
        }
    };
    let start = Instant::now();

    // Make a lightweight HEAD request to a known endpoint through the proxy
    match client
        .head(target)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => {
            let elapsed_ms = start.elapsed().as_millis() as u64;
            stages.push(ProxyTestStage {
                id: "target".to_string(),
                success: true,
                message: format!(
                    "Target reachable through proxy ({}ms, status {})",
                    elapsed_ms,
                    resp.status()
                ),
                elapsed_ms,
            });
            Ok(ProxyTestResult {
                success: true,
                message: format!(
                    "Proxy test passed (local {}ms, target {}ms)",
                    local_elapsed, elapsed_ms
                ),
                elapsed_ms: local_elapsed + elapsed_ms,
                reply: None,
                quality: None,
                stages,
            })
        }
        Err(error) => {
            let elapsed_ms = start.elapsed().as_millis() as u64;
            let message = public_provider_error(
                "Target connection through proxy failed",
                &error.to_string(),
                None,
            );
            stages.push(ProxyTestStage {
                id: "target".to_string(),
                success: false,
                message: message.clone(),
                elapsed_ms,
            });
            Ok(ProxyTestResult {
                success: false,
                message,
                elapsed_ms: local_elapsed + elapsed_ms,
                reply: None,
                quality: None,
                stages,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    pub elapsed_ms: u64,
    pub reply: Option<String>,
}

#[tauri::command]
pub async fn test_connection(
    base_url: String,
    api_key: String,
    model: Option<String>,
    proxy_url: Option<String>,
    platform: Option<String>,
) -> Result<TestResult, String> {
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    eprintln!(
        "[auth-debug][test] sdk=claude platform={} model={} base_url={} api_key={} proxy_set={}",
        platform.as_deref().unwrap_or("claude"),
        model,
        auth_debug_base_url(&base_url),
        auth_debug_secret(&api_key),
        proxy_url
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    );

    if api_key.is_empty() {
        return Ok(TestResult {
            success: false,
            message: "API key is empty".to_string(),
            elapsed_ms: 0,
            reply: None,
        });
    }

    // Third-party providers that implement the Anthropic Messages API use
    // Bearer token auth instead of the x-api-key header.
    let use_bearer = matches!(
        platform.as_deref(),
        Some("grok" | "deepseek" | "qwen" | "bigmodel" | "mimo" | "minimax" | "kimi" | "ollama")
    );

    let base_url = validate_api_base_url(&base_url)?;
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 32,
        "messages": [{ "role": "user", "content": "Reply with only: ok" }],
    });

    let client = get_client(proxy_url.as_deref())?;
    let start = Instant::now();

    let mut req = client
        .post(&url)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");

    if use_bearer {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    } else {
        req = req.header("x-api-key", &api_key);
    }

    let response = match req.body(body.to_string()).send().await {
        Ok(r) => r,
        Err(error) => {
            return Ok(TestResult {
                success: false,
                message: public_provider_error(
                    "Provider connection failed",
                    &error.to_string(),
                    None,
                ),
                elapsed_ms: start.elapsed().as_millis() as u64,
                reply: None,
            });
        }
    };

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let status = response.status();
    let body_text = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            return Ok(TestResult {
                success: false,
                message: public_provider_error(
                    "Provider response could not be read",
                    &error.to_string(),
                    Some(status.as_u16()),
                ),
                elapsed_ms,
                reply: None,
            });
        }
    };

    if !status.is_success() {
        return Ok(TestResult {
            success: false,
            message: public_provider_error(
                "Provider request failed",
                &body_text,
                Some(status.as_u16()),
            ),
            elapsed_ms,
            reply: None,
        });
    }

    let reply = serde_json::from_str::<serde_json::Value>(&body_text)
        .ok()
        .and_then(|v| {
            v["content"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|block| block["text"].as_str().map(|s| s.to_string()))
        });

    Ok(TestResult {
        success: true,
        message: format!("Connection successful ({}ms)", elapsed_ms),
        elapsed_ms,
        reply,
    })
}

// ---------------------------------------------------------------------------
// OpenAI connection test
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn test_openai_connection(
    base_url: String,
    api_key: String,
    model: Option<String>,
    proxy_url: Option<String>,
) -> Result<TestResult, String> {
    let model = model.unwrap_or_else(|| "openai/gpt-5.6-sol".to_string());
    eprintln!(
        "[auth-debug][test] sdk=openai-compatible model={} base_url={} api_key={} proxy_set={}",
        model,
        auth_debug_base_url(&base_url),
        auth_debug_secret(&api_key),
        proxy_url
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    );

    if api_key.is_empty() {
        return Ok(TestResult {
            success: false,
            message: "API key is empty".to_string(),
            elapsed_ms: 0,
            reply: None,
        });
    }

    let client = get_client(proxy_url.as_deref())?;
    let base_url = validate_api_base_url(&base_url)?;
    let trimmed_base = base_url.trim_end_matches('/');
    let start = Instant::now();

    // Try Responses API first (/responses), then fall back to Chat Completions (/chat/completions).
    // This ensures compatibility with relay/proxy services (e.g. Codex CRS) that only expose
    // the Responses API, while still working with standard OpenAI-compatible endpoints.

    // --- Attempt 1: Responses API ---
    let responses_url = format!("{}/responses", trimmed_base);
    let responses_body = serde_json::json!({
        "model": model,
        "input": [{"role": "user", "content": "Reply with only: ok"}],
        "stream": true,
    });

    let resp1 = client
        .post(&responses_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .body(responses_body.to_string())
        .send()
        .await
        .ok();

    // Check if Responses API succeeded (non-404)
    let (used_api, status, body_text, elapsed_ms) = if let Some(r) = resp1 {
        let st = r.status();
        if st.as_u16() == 404 {
            // Responses API not available, consume body then fall back
            let _ = r.text().await;

            // --- Attempt 2: Chat Completions API ---
            let chat_url = format!("{}/chat/completions", trimmed_base);
            let chat_body = serde_json::json!({
                "model": model,
                "max_tokens": 32,
                "messages": [{ "role": "user", "content": "Reply with only: ok" }],
            });

            match client
                .post(&chat_url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("content-type", "application/json")
                .body(chat_body.to_string())
                .send()
                .await
            {
                Ok(r2) => {
                    let elapsed = start.elapsed().as_millis() as u64;
                    let st2 = r2.status();
                    let bt2 = match r2.text().await {
                        Ok(body) => body,
                        Err(error) => {
                            return Ok(TestResult {
                                success: false,
                                message: public_provider_error(
                                    "Provider response could not be read",
                                    &error.to_string(),
                                    Some(st2.as_u16()),
                                ),
                                elapsed_ms: elapsed,
                                reply: None,
                            });
                        }
                    };
                    ("chat/completions", st2, bt2, elapsed)
                }
                Err(error) => {
                    return Ok(TestResult {
                        success: false,
                        message: public_provider_error(
                            "Provider connection failed",
                            &error.to_string(),
                            None,
                        ),
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        reply: None,
                    });
                }
            }
        } else {
            let elapsed = start.elapsed().as_millis() as u64;
            let bt = match r.text().await {
                Ok(body) => body,
                Err(error) => {
                    return Ok(TestResult {
                        success: false,
                        message: public_provider_error(
                            "Provider response could not be read",
                            &error.to_string(),
                            Some(st.as_u16()),
                        ),
                        elapsed_ms: elapsed,
                        reply: None,
                    });
                }
            };
            ("responses", st, bt, elapsed)
        }
    } else {
        // Network-level failure on Responses API, try Chat Completions
        let chat_url = format!("{}/chat/completions", trimmed_base);
        let chat_body = serde_json::json!({
            "model": model,
            "max_tokens": 32,
            "messages": [{ "role": "user", "content": "Reply with only: ok" }],
        });

        match client
            .post(&chat_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .body(chat_body.to_string())
            .send()
            .await
        {
            Ok(r2) => {
                let elapsed = start.elapsed().as_millis() as u64;
                let st2 = r2.status();
                let bt2 = match r2.text().await {
                    Ok(body) => body,
                    Err(error) => {
                        return Ok(TestResult {
                            success: false,
                            message: public_provider_error(
                                "Provider response could not be read",
                                &error.to_string(),
                                Some(st2.as_u16()),
                            ),
                            elapsed_ms: elapsed,
                            reply: None,
                        });
                    }
                };
                ("chat/completions", st2, bt2, elapsed)
            }
            Err(error) => {
                return Ok(TestResult {
                    success: false,
                    message: public_provider_error(
                        "Provider connection failed",
                        &error.to_string(),
                        None,
                    ),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    reply: None,
                });
            }
        }
    };

    if !status.is_success() {
        return Ok(TestResult {
            success: false,
            message: public_provider_error(
                "Provider request failed",
                &body_text,
                Some(status.as_u16()),
            ),
            elapsed_ms,
            reply: None,
        });
    }

    // Parse reply based on which API succeeded
    let reply = if used_api == "responses" {
        // Streaming SSE format: look for "response.output_text.done" event lines
        // Each SSE block is: "event: ...\ndata: {...}\n\n"
        body_text
            .lines()
            .filter(|line| line.starts_with("data: "))
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(&line[6..]).ok())
            .find(|v| v["type"] == "response.output_text.done")
            .and_then(|v| v["text"].as_str().map(|s| s.to_string()))
    } else {
        serde_json::from_str::<serde_json::Value>(&body_text)
            .ok()
            .and_then(|v| extract_openai_response_text(&v))
    };

    Ok(TestResult {
        success: true,
        message: format!("Connection successful via {} ({}ms)", used_api, elapsed_ms),
        elapsed_ms,
        reply,
    })
}

// ---------------------------------------------------------------------------
// Gemini connection test
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn test_gemini_connection(
    base_url: Option<String>,
    api_key: String,
    model: Option<String>,
    proxy_url: Option<String>,
) -> Result<TestResult, String> {
    let model = model.unwrap_or_else(|| "gemini-2.5-flash".to_string());
    eprintln!(
        "[auth-debug][test] sdk=gemini model={} base_url={} api_key={} proxy_set={}",
        model,
        auth_debug_base_url(base_url.as_deref().unwrap_or("")),
        auth_debug_secret(&api_key),
        proxy_url
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    );

    if api_key.is_empty() {
        return Ok(TestResult {
            success: false,
            message: "API key is empty".to_string(),
            elapsed_ms: 0,
            reply: None,
        });
    }

    let host = base_url
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());
    let host = validate_api_base_url(&host)?;
    let host = host.trim_end_matches('/');

    let url = format!("{}/v1beta/models/{}:generateContent", host, model);
    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": "Reply with only: ok" }] }],
        "generationConfig": { "maxOutputTokens": 32 },
    });

    let client = get_client(proxy_url.as_deref())?;
    let start = Instant::now();

    let response = match client
        .post(&url)
        .header("content-type", "application/json")
        .header("x-goog-api-key", &api_key)
        .body(body.to_string())
        .send()
        .await
    {
        Ok(r) => r,
        Err(error) => {
            return Ok(TestResult {
                success: false,
                message: public_provider_error(
                    "Provider connection failed",
                    &error.to_string(),
                    None,
                ),
                elapsed_ms: start.elapsed().as_millis() as u64,
                reply: None,
            });
        }
    };

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let status = response.status();
    let body_text = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            return Ok(TestResult {
                success: false,
                message: public_provider_error(
                    "Provider response could not be read",
                    &error.to_string(),
                    Some(status.as_u16()),
                ),
                elapsed_ms,
                reply: None,
            });
        }
    };

    if !status.is_success() {
        return Ok(TestResult {
            success: false,
            message: public_provider_error(
                "Provider request failed",
                &body_text,
                Some(status.as_u16()),
            ),
            elapsed_ms,
            reply: None,
        });
    }

    // Gemini response format: { "candidates": [{ "content": { "parts": [{ "text": "..." }] } }] }
    let reply = serde_json::from_str::<serde_json::Value>(&body_text)
        .ok()
        .and_then(|v| {
            v["candidates"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|c| {
                    c["content"]["parts"]
                        .as_array()
                        .and_then(|parts| parts.first())
                        .and_then(|p| p["text"].as_str().map(|s| s.to_string()))
                })
        });

    Ok(TestResult {
        success: true,
        message: format!("Connection successful ({}ms)", elapsed_ms),
        elapsed_ms,
        reply,
    })
}

// ---------------------------------------------------------------------------
// Title generation — lightweight non-streaming call
// ---------------------------------------------------------------------------

const TITLE_SYSTEM_PROMPT: &str = "Based on the user message, generate a short conversation title (3-8 words). Reply with ONLY the title text. No quotes, no punctuation at the end. Use the same language as the user message.";

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_title(
    sdk: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    user_message: String,
    proxy_url: Option<String>,
) -> Result<String, String> {
    let sdk = sdk.unwrap_or_else(|| "claude".to_string());
    let resolved_api_key = api_key
        .filter(|key| !key.trim().is_empty())
        .ok_or("API key required")?;

    match call_ai_simple(
        &sdk,
        model,
        base_url,
        &resolved_api_key,
        TITLE_SYSTEM_PROMPT,
        &user_message,
        30,
        proxy_url.as_deref(),
    )
    .await
    {
        Ok(title) => Ok(title),
        Err(_) => {
            // Fallback: truncate user message as title
            let truncated: String = user_message.chars().take(50).collect();
            Ok(if truncated.len() < user_message.len() {
                format!("{}...", truncated)
            } else {
                truncated
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Conversation summary generation — reads messages from DB, calls AI, saves
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT: &str = "Summarize this conversation in 1-3 concise sentences. Then on a NEW line write exactly \"Topics:\" followed by 3-5 comma-separated keywords. Use the same language as the conversation. Reply with ONLY the summary and topics line, nothing else.";

#[tauri::command]
pub async fn generate_conversation_summary(
    db: tauri::State<'_, crate::memory::db::MemoryDb>,
    sdk: Option<String>,
    conversation_id: String,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    proxy_url: Option<String>,
) -> Result<(), String> {
    // 1. Read last 30 messages from DB (enough context, not too expensive)
    let messages = db.with_conn(|conn| {
        crate::memory::repository::get_conversation_messages(conn, &conversation_id, 30, 0)
    })?;

    if messages.len() < 4 {
        return Ok(());
    }

    // 2. Format messages into a compact transcript
    let transcript: String = messages
        .iter()
        .map(|m| {
            let content: String = m.content.chars().take(300).collect();
            let ellipsis = if m.content.len() > 300 { "..." } else { "" };
            format!("[{}]: {}{}", m.role, content, ellipsis)
        })
        .collect::<Vec<_>>()
        .join("\n");

    // 3. Call AI API via unified helper
    let api_key = api_key
        .filter(|k| !k.is_empty())
        .ok_or("API key required")?;
    let sdk = sdk.unwrap_or_else(|| "claude".to_string());

    let response_text = call_ai_simple(
        &sdk,
        model,
        base_url,
        &api_key,
        SUMMARY_SYSTEM_PROMPT,
        &transcript,
        200,
        proxy_url.as_deref(),
    )
    .await
    .unwrap_or_default();

    if response_text.is_empty() {
        return Ok(());
    }

    // 4. Parse summary and topics
    let (summary, topics) = if let Some(idx) = response_text.to_lowercase().find("topics:") {
        let s = response_text[..idx].trim().to_string();
        let t = response_text[idx + 7..].trim().to_string();
        (s, t)
    } else {
        (response_text.trim().to_string(), String::new())
    };

    // 5. Upsert into DB — delete old summary for this conversation, then insert
    let conv_id = conversation_id.clone();
    db.with_conn(move |conn| {
        conn.execute(
            "DELETE FROM memory_summaries WHERE conversation_id = ?1",
            rusqlite::params![conv_id],
        )?;
        let summary_id = uuid::Uuid::new_v4().to_string();
        crate::memory::repository::save_summary(conn, &summary_id, &conv_id, &summary, &topics)
    })?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Idea discussion summary — reads discussion messages, calls AI, returns JSON
// ---------------------------------------------------------------------------

const IDEA_SUMMARY_SYSTEM_PROMPT: &str = r#"You are a technical idea analyst. Given an idea title, description, and discussion transcript, produce a structured JSON summary.

Respond with ONLY a valid JSON object (no markdown fences, no extra text) with these fields:
- "problem": string — concise problem statement (1-2 sentences)
- "approach": string — proposed solution approach (1-3 sentences)
- "keyPoints": string[] — 3-6 key decisions or insights from the discussion
- "complexity": "low" | "medium" | "high" — estimated implementation complexity
- "relatedFiles": string[] — mentioned file paths or components (empty array if none)

Use the same language as the discussion. If the discussion is in Chinese, write the summary in Chinese."#;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_idea_summary(
    db: tauri::State<'_, crate::memory::db::MemoryDb>,
    sdk: Option<String>,
    model: Option<String>,
    conversation_id: String,
    idea_title: String,
    idea_raw_input: String,
    base_url: Option<String>,
    api_key: Option<String>,
    proxy_url: Option<String>,
) -> Result<String, String> {
    // 1. Read discussion messages from DB (up to 50 for richer context)
    let messages = db.with_conn(|conn| {
        crate::memory::repository::get_conversation_messages(conn, &conversation_id, 50, 0)
    })?;

    // 2. Format messages into a compact transcript
    let transcript: String = messages
        .iter()
        .map(|m| {
            let content: String = m.content.chars().take(500).collect();
            let ellipsis = if m.content.len() > 500 { "..." } else { "" };
            format!("[{}]: {}{}", m.role, content, ellipsis)
        })
        .collect::<Vec<_>>()
        .join("\n");

    // 3. Call AI API via unified helper
    let api_key = api_key
        .filter(|k| !k.is_empty())
        .ok_or("API key required")?;
    let sdk = sdk.unwrap_or_else(|| "claude".to_string());

    let user_content = format!(
        "Idea Title: {}\n\nIdea Description: {}\n\nDiscussion Transcript:\n{}",
        idea_title, idea_raw_input, transcript
    );

    let response_text = call_ai_simple(
        &sdk,
        model,
        base_url,
        &api_key,
        IDEA_SUMMARY_SYSTEM_PROMPT,
        &user_content,
        800,
        proxy_url.as_deref(),
    )
    .await?;

    if response_text.is_empty() {
        return Err("AI returned empty response".to_string());
    }

    // 4. Strip markdown code fences if present (e.g. ```json\n{...}\n```)
    let cleaned = response_text.trim();
    let cleaned = if cleaned.starts_with("```") {
        cleaned
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string()
    } else {
        cleaned.to_string()
    };

    // 5. Validate that the response is valid JSON
    serde_json::from_str::<serde_json::Value>(&cleaned).map_err(|_| {
        public_provider_error("Provider response format was invalid", &cleaned, Some(200))
    })?;

    Ok(cleaned)
}

// ---------------------------------------------------------------------------
// Git commit message generation — uses chat context + diff to produce a
// conventional-commit-style message via the active provider.
// ---------------------------------------------------------------------------

const COMMIT_SYSTEM_PROMPT: &str = r#"You are a git commit message generator. Based on the conversation context and file changes provided, generate a concise git commit message in conventional commit format.

Rules:
- Format: <type>: <description>
- Types: feat, fix, refactor, docs, test, chore, perf, ci, style
- Description should be concise (under 72 characters for the first line)
- If the changes are complex, add a blank line followed by a brief body (2-3 bullet points max)
- Use the same language as the conversation context
- Reply with ONLY the commit message, no additional text, no quotes, no markdown fences
- Do not include any signatures, tags, or meta information"#;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_commit_message(
    sdk: Option<String>,
    provider: Option<String>, // legacy alias — ignored if `sdk` is present
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    proxy_url: Option<String>,
    chat_context: String,
    diff_summary: String,
) -> Result<String, String> {
    // Prefer new `sdk` param; fall back to legacy `provider` for old callers
    let resolved_sdk = sdk
        .clone()
        .or(provider.clone())
        .unwrap_or_else(|| "claude".to_string());
    let resolved_api_key = api_key
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "API key required".to_string())?;
    let user_content = format!(
        "Conversation context:\n{}\n\nChanged files:\n{}",
        chat_context, diff_summary
    );

    call_ai_simple(
        &resolved_sdk,
        model,
        base_url,
        &resolved_api_key,
        COMMIT_SYSTEM_PROMPT,
        &user_content,
        200,
        proxy_url.as_deref(),
    )
    .await
}

// Keep in sync with PR_SYSTEM_PROMPT_TEMPLATE in src/lib/ai-one-shot.ts
// (the sidecar/OAuth path uses the frontend copy).
const PR_SYSTEM_PROMPT_TEMPLATE: &str = r#"You are a pull request description generator. Based on the branch commits and code changes provided, write a pull request title and description.

Rules:
- First line: the PR title — concise, under 80 characters, may use a conventional-commit prefix (feat/fix/refactor/...)
- Then one blank line, then the description body in Markdown
- The body: a short summary paragraph, then a bullet list of the key changes
- Write the title and body in {language}
- Reply with ONLY the title and description, no extra commentary, no markdown fences"#;

fn pr_prompt_language(language: Option<&str>) -> &'static str {
    match language {
        Some("en") => "English",
        _ => "Simplified Chinese (简体中文)",
    }
}

#[tauri::command]
pub async fn generate_pr_description(
    sdk: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    proxy_url: Option<String>,
    language: Option<String>,
    branch_summary: String,
) -> Result<String, String> {
    let resolved_sdk = sdk.unwrap_or_else(|| "claude".to_string());
    let resolved_api_key = api_key
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "API key required".to_string())?;
    let system_prompt =
        PR_SYSTEM_PROMPT_TEMPLATE.replace("{language}", pr_prompt_language(language.as_deref()));

    call_ai_simple(
        &resolved_sdk,
        model,
        base_url,
        &resolved_api_key,
        &system_prompt,
        &branch_summary,
        1000,
        proxy_url.as_deref(),
    )
    .await
}

// ---------------------------------------------------------------------------
// Fetch remote model list (e.g. from Zenmux /models endpoint)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct RemoteModel {
    pub id: String,
    pub display_name: String,
    pub context_length: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FetchModelsResult {
    pub success: bool,
    pub models: Vec<RemoteModel>,
    pub message: String,
}

#[tauri::command]
pub async fn fetch_remote_models(
    base_url: String,
    api_key: String,
    proxy_url: Option<String>,
) -> Result<FetchModelsResult, String> {
    if base_url.is_empty() {
        return Ok(FetchModelsResult {
            success: false,
            models: vec![],
            message: "Base URL is empty".to_string(),
        });
    }

    let base_url = validate_api_base_url(&base_url)?;
    let trimmed_base = base_url.trim_end_matches('/');
    let url = format!("{}/models", trimmed_base);
    let client = get_client(proxy_url.as_deref())?;

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .send()
        .await
        .map_err(|error| {
            public_provider_error("Provider network request failed", &error.to_string(), None)
        })?;

    let status = resp.status();
    let body_text = resp.text().await.map_err(|error| {
        public_provider_error(
            "Provider response could not be read",
            &error.to_string(),
            Some(status.as_u16()),
        )
    })?;

    if !status.is_success() {
        return Ok(FetchModelsResult {
            success: false,
            models: vec![],
            message: public_provider_error(
                "Provider model catalog request failed",
                &body_text,
                Some(status.as_u16()),
            ),
        });
    }

    let parsed: serde_json::Value = serde_json::from_str(&body_text).map_err(|_| {
        public_provider_error(
            "Provider model catalog response was invalid",
            &body_text,
            Some(status.as_u16()),
        )
    })?;

    let models = parsed["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let id = item["id"].as_str()?;
                    let display_name = item["display_name"].as_str().unwrap_or(id);
                    let context_length = item["context_length"].as_u64();
                    Some(RemoteModel {
                        id: id.to_string(),
                        display_name: display_name.to_string(),
                        context_length,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(FetchModelsResult {
        success: true,
        models,
        message: "OK".to_string(),
    })
}

// ---------------------------------------------------------------------------
// One-click AI code review — reads prompt from frontend, calls active
// provider, returns the review text. Runs through Rust to bypass WebView CSP.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_code_review(
    sdk: Option<String>,
    provider: Option<String>, // legacy alias — ignored if `sdk` is present
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    proxy_url: Option<String>,
    prompt: String,
) -> Result<String, String> {
    let sdk = sdk.or(provider).unwrap_or_else(|| "claude".to_string());

    let api_key = api_key
        .filter(|k| !k.is_empty())
        .ok_or("API key required for code review")?;
    match sdk.as_str() {
        "claude" => {
            review_anthropic(proxy_url.as_deref(), base_url, &api_key, model, &prompt).await
        }
        "gemini" => {
            let client = get_client(proxy_url.as_deref())?;
            review_gemini(&client, base_url, &api_key, model, &prompt).await
        }
        // codex, chatcmpl — all OpenAI-compatible
        _ => {
            let client = get_client(proxy_url.as_deref())?;
            review_openai(&client, base_url, &api_key, model, &prompt).await
        }
    }
}

/// Anthropic Messages API for code review
async fn review_anthropic(
    proxy_url: Option<&str>,
    base_url: Option<String>,
    api_key: &str,
    model: Option<String>,
    prompt: &str,
) -> Result<String, String> {
    let url = anthropic_url(base_url.as_deref())?;
    let client = get_client(proxy_url)?;
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "messages": [{ "role": "user", "content": prompt }],
    });

    send_anthropic(&client, &url, api_key, body).await
}

/// OpenAI-compatible Chat Completions API for code review
async fn review_openai(
    client: &Client,
    base_url: Option<String>,
    api_key: &str,
    model: Option<String>,
    prompt: &str,
) -> Result<String, String> {
    let url = openai_url(base_url.as_deref())?;
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "gpt-4o-mini".to_string());

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "messages": [{ "role": "user", "content": prompt }],
    });

    send_openai(client, &url, api_key, body).await
}

/// Gemini API for code review
async fn review_gemini(
    client: &Client,
    base_url: Option<String>,
    api_key: &str,
    model: Option<String>,
    prompt: &str,
) -> Result<String, String> {
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "gemini-2.5-flash".to_string());
    let url = gemini_url(base_url.as_deref(), &model)?;

    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": 8192 },
    });

    send_gemini(client, &url, api_key, body).await
}

// ---------------------------------------------------------------------------
// Streaming code review  (Tauri v2 Channel-based)
// ---------------------------------------------------------------------------

/// Event variants sent through the Tauri Channel to the frontend.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReviewStreamEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

/// Entry point: routes to the provider-specific streaming implementation.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_code_review_stream(
    on_chunk: Channel<ReviewStreamEvent>,
    sdk: Option<String>,
    provider: Option<String>, // legacy alias — ignored if `sdk` is present
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    proxy_url: Option<String>,
    prompt: String,
) -> Result<(), String> {
    let sdk = sdk.or(provider).unwrap_or_else(|| "claude".to_string());

    let resolved_api_key = api_key
        .filter(|key| !key.trim().is_empty())
        .ok_or("API key required for code review")?;

    match sdk.as_str() {
        "gemini" => {
            let client = get_client(proxy_url.as_deref())?;
            review_gemini_stream(
                &client,
                on_chunk,
                base_url,
                &resolved_api_key,
                model,
                &prompt,
            )
            .await
        }
        "claude" => {
            review_anthropic_stream(
                proxy_url.as_deref(),
                on_chunk,
                base_url,
                &resolved_api_key,
                model,
                &prompt,
            )
            .await
        }
        // codex, chatcmpl — OpenAI-compatible streaming
        _ => {
            let client = get_client(proxy_url.as_deref())?;
            review_openai_stream(
                &client,
                on_chunk,
                base_url,
                &resolved_api_key,
                model,
                &prompt,
            )
            .await
        }
    }
}

/// True when `base_url` already includes a non-empty path beyond `host:port`.
/// Used to decide whether to auto-append `/v1` for OpenAI-compatible gateways.
fn has_explicit_path(base_url: &str) -> bool {
    let after_scheme = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url);
    match after_scheme.find('/') {
        None => false,
        Some(idx) => after_scheme[idx + 1..].chars().any(|c| !c.is_whitespace()),
    }
}

/// Read SSE response bytes into a line-oriented buffer and call `handle_line`
/// for each complete line. Returns Ok(true) if a terminal event was emitted
/// (Done or Error), Ok(false) if the stream ended without one.
async fn drain_sse<F>(
    resp: reqwest::Response,
    channel: &Channel<ReviewStreamEvent>,
    _url: &str,
    mut handle_line: F,
) -> Result<bool, String>
where
    F: FnMut(&str, &Channel<ReviewStreamEvent>) -> bool, // returns true → done
{
    let status = resp.status();
    if !status.is_success() {
        let body = match resp.text().await {
            Ok(body) => body,
            Err(error) => error.to_string(),
        };
        let message = public_provider_error(
            "Provider stream request failed",
            &body,
            Some(status.as_u16()),
        );
        let _ = channel.send(ReviewStreamEvent::Error {
            message: message.clone(),
        });
        return Err(message);
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut raw_body = String::new(); // captures the entire response for non-SSE fallback
    let mut done = false;

    while let Some(chunk_result) = stream.next().await {
        let bytes = chunk_result.map_err(|error| {
            public_provider_error(
                "Provider stream could not be read",
                &error.to_string(),
                Some(status.as_u16()),
            )
        })?;
        let chunk_str = String::from_utf8_lossy(&bytes).to_string();
        raw_body.push_str(&chunk_str);
        buffer.push_str(&chunk_str);

        // Process every complete line in the buffer
        loop {
            match buffer.find('\n') {
                None => break,
                Some(pos) => {
                    let line = buffer[..pos].trim_end_matches('\r').to_string();
                    buffer = buffer[pos + 1..].to_string();
                    if handle_line(&line, channel) {
                        done = true;
                        break;
                    }
                }
            }
        }

        if done {
            break;
        }
    }

    // Stream ended without a trailing newline — flush whatever remains.  Some
    // upstream proxies emit the last `data: ...` line without a final `\n`,
    // which would otherwise be silently dropped.
    if !done {
        let trailing = buffer.trim_end_matches('\r').trim();
        if !trailing.is_empty() && handle_line(trailing, channel) {
            done = true;
        }
    }

    // Non-SSE fallback: a misconfigured proxy may return a single JSON object
    // with `stream: true` requested but no SSE framing.  If we got a 200 but
    // never matched a streaming line, try to parse the whole body as a
    // non-streaming OpenAI ChatCompletion response and emit its content.
    if !done && !raw_body.trim().is_empty() && !raw_body.contains("data:") {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(raw_body.trim()) {
            // OpenAI non-stream:  choices[0].message.content
            // Anthropic non-stream:  content[0].text
            // Gemini non-stream:  candidates[0].content.parts[0].text
            let text_opt = json["choices"][0]["message"]["content"]
                .as_str()
                .or_else(|| json["content"][0]["text"].as_str())
                .or_else(|| json["candidates"][0]["content"]["parts"][0]["text"].as_str());
            if let Some(text) = text_opt {
                if !text.is_empty() {
                    let _ = channel.send(ReviewStreamEvent::Delta {
                        text: text.to_string(),
                    });
                    let _ = channel.send(ReviewStreamEvent::Done);
                    done = true;
                }
            }
        }
        if !done {
            let message = public_provider_error(
                "Provider stream returned no usable content",
                &raw_body,
                Some(status.as_u16()),
            );
            let _ = channel.send(ReviewStreamEvent::Error { message });
            done = true;
        }
    }

    Ok(done)
}

/// Anthropic Messages API — streaming (SSE).
async fn review_anthropic_stream(
    proxy_url: Option<&str>,
    channel: Channel<ReviewStreamEvent>,
    base_url: Option<String>,
    api_key: &str,
    model: Option<String>,
    prompt: &str,
) -> Result<(), String> {
    let host = base_url
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let host = validate_api_base_url(&host)?;
    let url = format!("{}/v1/messages", host.trim_end_matches('/'));
    let client = get_client(proxy_url)?;
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "stream": true,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| {
            public_provider_error("Provider network request failed", &error.to_string(), None)
        })?;

    let done = drain_sse(resp, &channel, &url, |line, ch| {
        let Some(data) = line.strip_prefix("data: ") else {
            return false;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
            return false;
        };
        match json["type"].as_str() {
            Some("content_block_delta") => {
                if let Some(text) = json["delta"]["text"].as_str() {
                    if !text.is_empty() {
                        let _ = ch.send(ReviewStreamEvent::Delta {
                            text: text.to_string(),
                        });
                    }
                }
                false
            }
            Some("message_stop") => {
                let _ = ch.send(ReviewStreamEvent::Done);
                true
            }
            _ => false,
        }
    })
    .await?;

    if !done {
        let _ = channel.send(ReviewStreamEvent::Done);
    }
    Ok(())
}

/// OpenAI-compatible Chat Completions API — streaming (SSE).
async fn review_openai_stream(
    client: &Client,
    channel: Channel<ReviewStreamEvent>,
    base_url: Option<String>,
    api_key: &str,
    model: Option<String>,
    prompt: &str,
) -> Result<(), String> {
    let host = base_url
        .filter(|u| !u.is_empty())
        .ok_or("Base URL is required for OpenAI-compatible providers")?;
    let host = validate_api_base_url(&host)?;
    // OpenAI-compatible gateways universally expose the API under `/v1/...`
    // (OpenAI itself, DeepSeek, Qwen, Sub2API, vLLM, etc.).  If the user
    // pasted just `https://host:port` without any path, default to `/v1`
    // so we don't end up POSTing to an SPA index page.  When the user has
    // already specified a path (e.g. `https://api.openai.com/v1` or
    // `https://gw.example.com/api/openai/v1`), respect it verbatim.
    let host_trimmed = host.trim_end_matches('/').to_string();
    let host_with_path = if has_explicit_path(&host_trimmed) {
        host_trimmed
    } else {
        format!("{}/v1", host_trimmed)
    };
    let url = format!("{}/chat/completions", host_with_path);
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "gpt-4o-mini".to_string());

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "stream": true,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| {
            public_provider_error("Provider network request failed", &error.to_string(), None)
        })?;

    let done = drain_sse(resp, &channel, &url, |line, ch| {
        let Some(data) = line.strip_prefix("data: ") else {
            return false;
        };
        if data.trim() == "[DONE]" {
            let _ = ch.send(ReviewStreamEvent::Done);
            return true;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
            return false;
        };
        if let Some(text) = json["choices"][0]["delta"]["content"].as_str() {
            if !text.is_empty() {
                let _ = ch.send(ReviewStreamEvent::Delta {
                    text: text.to_string(),
                });
            }
        }
        false
    })
    .await?;

    if !done {
        let _ = channel.send(ReviewStreamEvent::Done);
    }
    Ok(())
}

/// Google Gemini API — streaming (SSE via `alt=sse` query param).
async fn review_gemini_stream(
    client: &Client,
    channel: Channel<ReviewStreamEvent>,
    base_url: Option<String>,
    api_key: &str,
    model: Option<String>,
    prompt: &str,
) -> Result<(), String> {
    let host = base_url
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());
    let host = validate_api_base_url(&host)?;
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "gemini-2.5-flash".to_string());
    let url = format!(
        "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
        host.trim_end_matches('/'),
        model
    );

    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": 8192 },
    });

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .header("x-goog-api-key", api_key)
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| {
            public_provider_error("Provider network request failed", &error.to_string(), None)
        })?;

    let done = drain_sse(resp, &channel, &url, |line, ch| {
        let Some(data) = line.strip_prefix("data: ") else {
            return false;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
            return false;
        };
        if let Some(text) = json["candidates"][0]["content"]["parts"][0]["text"].as_str() {
            if !text.is_empty() {
                let _ = ch.send(ReviewStreamEvent::Delta {
                    text: text.to_string(),
                });
            }
        }
        // Gemini signals completion via finishReason
        if json["candidates"][0]["finishReason"].as_str().is_some() {
            let _ = ch.send(ReviewStreamEvent::Done);
            return true;
        }
        false
    })
    .await?;

    if !done {
        let _ = channel.send(ReviewStreamEvent::Done);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        body_looks_like_html, build_proxy_client, extract_openai_content_text,
        extract_openai_response_text, get_client, openai_endpoint_candidates, parse_proxy_endpoint,
        public_provider_error, reqwest_proxy_url, validate_api_base_url, validate_proxy_url,
    };
    use serde_json::json;

    #[test]
    fn proxy_validation_preserves_supported_protocols_without_echoing_invalid_values() {
        for proxy in [
            "http://127.0.0.1:8080",
            "https://proxy.example.test:8443",
            "socks5://127.0.0.1:1080",
            "socks5h://127.0.0.1:1080",
            "http://user:password@proxy.example.test:8080",
        ] {
            validate_proxy_url(proxy).expect("supported proxy protocol");
            build_proxy_client(proxy).expect("supported proxy client");
        }

        for sentinel in [
            "ftp://user:secret@proxy.example.test/private",
            "https://user:secret@proxy.example.test/private?token=opaque",
            "https://proxy.example.test#prompt-do-not-disclose",
        ] {
            let error = validate_proxy_url(sentinel).expect_err("unsafe proxy URL");
            assert!(error.starts_with("Invalid proxy URL (diagnosticId: "));
            assert!(!error.contains(sentinel));
            assert!(!error.contains("secret"));
            assert!(!error.contains("opaque"));
            assert!(!error.contains("do-not-disclose"));
        }
    }

    #[test]
    fn provider_base_validation_accepts_paths_and_never_echoes_secrets() {
        assert_eq!(
            validate_api_base_url("https://api.example.test/v1").unwrap(),
            "https://api.example.test/v1"
        );

        let sentinel = "sentinel-provider-base-secret";
        for value in [
            format!("https://user:{sentinel}@api.example.test/v1"),
            format!("https://api.example.test/v1?token={sentinel}"),
            format!("https://api.example.test/v1#{sentinel}"),
        ] {
            let error = validate_api_base_url(&value).expect_err("unsafe provider base URL");
            assert!(!error.contains(sentinel));
        }
    }

    #[test]
    fn provider_errors_expose_only_category_status_and_diagnostic_id() {
        let sentinel = concat!(
            "https://user:secret@provider.example/private?token=opaque ",
            "/Users/private/workspace prompt=do-not-disclose access_token=hidden"
        );
        let error = public_provider_error("Provider request failed", sentinel, Some(401));

        assert!(error.starts_with("Provider request failed (HTTP 401, diagnosticId: "));
        assert!(!error.contains("provider.example"));
        assert!(!error.contains("/Users/private"));
        assert!(!error.contains("secret"));
        assert!(!error.contains("opaque"));
        assert!(!error.contains("do-not-disclose"));
        assert!(!error.contains("hidden"));
        let diagnostic_id = error
            .split("diagnosticId: ")
            .nth(1)
            .and_then(|value| value.strip_suffix(')'))
            .expect("diagnostic id");
        assert_eq!(diagnostic_id.len(), 12);
        assert!(diagnostic_id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn extracts_chat_completion_string_content() {
        let value = json!({
            "choices": [{
                "message": {
                    "content": "fix: handle OpenAI commit generation parsing"
                }
            }]
        });

        assert_eq!(
            extract_openai_response_text(&value).as_deref(),
            Some("fix: handle OpenAI commit generation parsing")
        );
    }

    #[test]
    fn extracts_chat_completion_array_content() {
        let value = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "text", "text": "fix: handle " },
                        { "type": "text", "text": { "value": "OpenAI-compatible parsing" } }
                    ]
                }
            }]
        });

        assert_eq!(
            extract_openai_response_text(&value).as_deref(),
            Some("fix: handle OpenAI-compatible parsing")
        );
    }

    #[test]
    fn extracts_responses_output_items() {
        let value = json!({
            "output": [{
                "type": "message",
                "content": [
                    { "type": "output_text", "text": "fix: support responses-style text extraction" }
                ]
            }]
        });

        assert_eq!(
            extract_openai_response_text(&value).as_deref(),
            Some("fix: support responses-style text extraction")
        );
    }

    #[test]
    fn extracts_nested_content_text_directly() {
        let value = json!([
            { "type": "text", "text": "fix: support " },
            { "type": "output_text", "text": "segmented content" }
        ]);

        assert_eq!(
            extract_openai_content_text(&value).as_deref(),
            Some("fix: support segmented content")
        );
    }

    #[test]
    fn generates_v1_fallback_for_root_base_url() {
        let urls = openai_endpoint_candidates("https://sub2api.example.com", "chat/completions");

        assert_eq!(
            urls,
            vec![
                "https://sub2api.example.com/chat/completions".to_string(),
                "https://sub2api.example.com/v1/chat/completions".to_string(),
            ]
        );
    }

    #[test]
    fn does_not_duplicate_v1_suffix() {
        let urls = openai_endpoint_candidates(
            "https://api.openai.com/v1/chat/completions",
            "chat/completions",
        );

        assert_eq!(
            urls,
            vec!["https://api.openai.com/v1/chat/completions".to_string()]
        );
    }

    #[test]
    fn detects_html_bodies() {
        assert!(body_looks_like_html(
            "<!doctype html><html><head></head></html>"
        ));
        assert!(body_looks_like_html("   <html lang=\"zh-CN\">"));
        assert!(!body_looks_like_html("{\"choices\":[]}"));
    }

    #[test]
    fn converts_socks5_proxy_to_remote_dns_for_reqwest() {
        assert_eq!(
            reqwest_proxy_url("socks5://user:pass@192.168.1.6:63603"),
            "socks5h://user:pass@192.168.1.6:63603"
        );
        assert_eq!(
            reqwest_proxy_url("SOCKS5://user:pass@192.168.1.6:63603"),
            "socks5h://user:pass@192.168.1.6:63603"
        );
        assert_eq!(
            reqwest_proxy_url("http://user:pass@192.168.1.6:63603"),
            "http://user:pass@192.168.1.6:63603"
        );
    }

    #[test]
    fn accepts_socks5h_proxy_urls_for_endpoint_parsing() {
        validate_proxy_url("socks5h://user:pass@192.168.1.6:63603").unwrap();
        assert_eq!(
            parse_proxy_endpoint("socks5h://user:pass@192.168.1.6:63603").unwrap(),
            ("192.168.1.6".to_string(), 63603)
        );
    }

    #[test]
    fn builds_client_without_proxy() {
        get_client(None).unwrap();
        get_client(Some("")).unwrap();
    }

    #[test]
    fn builds_client_with_supported_proxy_schemes() {
        get_client(Some("socks5://user:pass@192.168.1.6:63603")).unwrap();
        get_client(Some("http://user:pass@192.168.1.6:63603")).unwrap();
        get_client(Some("https://user:pass@192.168.1.6:63603")).unwrap();
    }
}
