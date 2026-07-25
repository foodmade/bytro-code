//! Local HTTP + WebSocket reverse proxy that injects the inspector runtime
//! into any plain web project loaded in the preview iframe.
//!
//! Architecture:
//!   iframe -> http://127.0.0.1:<P>/__bytro_preview/<sid>/<rest>
//!          -> [ axum router ]
//!          -> reqwest / tokio-tungstenite -> upstream dev server
//!
//! Build projects with `.bytro-preview` keep using their Vite plugin and
//! never touch this proxy. The frontend decides which path to take and only
//! registers a session for non-build projects.

pub mod http;
pub mod inject;
pub mod server;
pub mod state;
pub mod ws;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

pub use state::{PreviewProxyState, SessionInfo};

const PREVIEW_PROXY_UNAVAILABLE: &str = "Preview proxy is unavailable.";

/// Result returned to JS when registering a session.
#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterSessionResult {
    pub session_id: String,
    pub frame_url: String,
}

/// Status payload for `get_preview_proxy_status`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ProxyStatus {
    pub running: bool,
    pub port: Option<u16>,
}

/// Tauri command: register a target dev-server URL with the proxy and obtain
/// the iframe URL the frontend should load.
#[tauri::command]
pub async fn register_preview_session(
    app: AppHandle,
    state: State<'_, PreviewProxyState>,
    target_url: String,
) -> Result<RegisterSessionResult, String> {
    let info = SessionInfo::from_url(&target_url)?;
    let port = ensure_started(&app, &state).await?;
    let handle = state.handle();
    let session_id = new_session_id();
    let frame_url = format!("http://127.0.0.1:{}/__bytro_preview/{}/", port, session_id);

    handle.register_session(session_id.clone(), info);
    log::info!("[preview-proxy] session registered");

    Ok(RegisterSessionResult {
        session_id,
        frame_url,
    })
}

/// Tauri command: forget a session id. Subsequent requests with that id 404.
#[tauri::command]
pub fn unregister_preview_session(
    state: State<'_, PreviewProxyState>,
    session_id: String,
) -> Result<bool, String> {
    Ok(state.handle().unregister_session(&session_id))
}

/// Tauri command: report whether the proxy is up and which port it bound to.
#[tauri::command]
pub fn get_preview_proxy_status(
    state: State<'_, PreviewProxyState>,
) -> Result<ProxyStatus, String> {
    let handle = state.handle();
    let port = handle.port();
    Ok(ProxyStatus {
        running: port.is_some(),
        port,
    })
}

/// Start the loopback proxy on the first explicit preview registration.
/// `OnceCell` makes concurrent registrations share the same bound listener;
/// a failed bind remains retryable on the next explicit request.
async fn ensure_started(app: &AppHandle, state: &PreviewProxyState) -> Result<u16, String> {
    let handle = state.handle();

    state
        .ensure_started_with(|| async move {
            match inject::load_inspector_runtime(app) {
                Ok(content) => handle.set_inspector_runtime(content),
                Err(e) => {
                    log::warn!(
                        "[preview-proxy] {}",
                        preview_diagnostic_summary("inspector_runtime_load_failed", &e)
                    );
                    // Transparent proxying can still work without element
                    // selection if the inspector runtime is unavailable.
                }
            }

            let listener = server::bind_loopback().await.map_err(|error| {
                log::warn!(
                    "[preview-proxy] {}",
                    preview_diagnostic_summary("bind_failed", &error)
                );
                PREVIEW_PROXY_UNAVAILABLE.to_string()
            })?;
            let port = listener
                .local_addr()
                .map_err(|error| {
                    log::warn!(
                        "[preview-proxy] {}",
                        preview_diagnostic_summary("local_address_failed", &error.to_string())
                    );
                    PREVIEW_PROXY_UNAVAILABLE.to_string()
                })?
                .port();
            handle.set_port(port);

            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::run(listener, handle).await {
                    log::warn!(
                        "[preview-proxy] {}",
                        preview_diagnostic_summary("server_exit", &e)
                    );
                }
            });

            Ok(port)
        })
        .await
}

fn preview_diagnostic_summary(category: &str, detail: &str) -> String {
    let digest = Sha256::digest(detail.as_bytes());
    format!(
        "category={} len={} sha256={:x}",
        category,
        detail.len(),
        digest
    )
}

fn preview_diagnostic_id(detail: &str) -> String {
    let digest = Sha256::digest(detail.as_bytes());
    format!("{digest:x}").chars().take(12).collect()
}

fn new_session_id() -> String {
    // First 16 hex chars of a v4 UUID — collision-resistant for our purpose
    // (a handful of concurrent preview targets), short enough for URLs.
    let id = uuid::Uuid::new_v4();
    id.simple().to_string().chars().take(16).collect()
}

#[cfg(test)]
mod tests {
    use super::preview_diagnostic_summary;

    const TAURI_LIB: &str = include_str!("../../lib.rs");

    #[test]
    fn tauri_setup_does_not_start_the_preview_proxy() {
        let setup = TAURI_LIB
            .split_once(".setup(|app| {")
            .expect("Tauri setup closure missing")
            .1
            .split_once(".on_window_event")
            .expect("Tauri window event hook missing")
            .0;

        assert!(
            !setup.contains("preview::proxy::"),
            "Tauri setup must not bind or initialize the preview proxy"
        );
    }

    #[test]
    fn diagnostics_do_not_echo_private_preview_details() {
        let sentinel = "http://user:secret@127.0.0.1:5173/?token=private";
        let summary = preview_diagnostic_summary("preview_test", sentinel);

        assert!(!summary.contains(sentinel));
        assert!(!summary.contains("secret"));
        assert!(!summary.contains("private"));
        assert!(summary.starts_with("category=preview_test len="));
        assert!(summary.contains(" sha256="));
    }
}
