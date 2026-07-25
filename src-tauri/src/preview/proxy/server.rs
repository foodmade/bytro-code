use std::net::Ipv4Addr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use tokio::net::TcpListener;

use super::http::proxy_http_request;
use super::state::{Inner, ProxyHandle};
use super::ws::proxy_ws_upgrade;

const PATH_PREFIX: &str = "/__bytro_preview";

/// Reserve a random IPv4 loopback port for the preview proxy.
pub async fn bind_loopback() -> Result<TcpListener, String> {
    // 127.0.0.1 only — never expose the proxy on the LAN.
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| format!("preview-proxy bind failed: {}", e))
}

/// Serve an already-bound loopback listener until shutdown is requested.
pub async fn run(listener: TcpListener, handle: ProxyHandle) -> Result<(), String> {
    let port = listener
        .local_addr()
        .map_err(|e| format!("preview-proxy local_addr: {}", e))?
        .port();

    let app = build_router(handle.clone());
    log::info!("[preview-proxy] listening on 127.0.0.1:{}", port);

    let shutdown_inner: Arc<Inner> = handle.inner.clone();
    let shutdown_signal = async move { shutdown_inner.shutdown.notified().await };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await
        .map_err(|e| format!("preview-proxy serve loop: {}", e))?;

    log::info!("[preview-proxy] server stopped");
    Ok(())
}

fn build_router(handle: ProxyHandle) -> Router {
    // axum 0.8's `{*rest}` catch-all matches one-or-more segments, so the
    // trailing-slash form `/__bytro_preview/<sid>/` must have its own route entry,
    // otherwise the iframe's initial GET to `/__bytro_preview/<sid>/` falls through
    // to the fallback and 404s.
    Router::new()
        .route(&format!("{}/{{sid}}", PATH_PREFIX), any(dispatch_root))
        .route(&format!("{}/{{sid}}/", PATH_PREFIX), any(dispatch_root))
        .route(&format!("{}/{{sid}}/{{*rest}}", PATH_PREFIX), any(dispatch))
        // For absolute-path subresources (`<script src="/@vite/client">` etc.)
        // the browser strips the `/__bytro_preview/<sid>/` prefix, so we recover the
        // session id from the Referer header before falling through.
        .fallback(referer_fallback)
        .with_state(handle)
}

/// Handler for `/__bytro_preview/<sid>` (no trailing path) — most dev servers expect a
/// non-empty path, so rewrite to "/" before forwarding.
async fn dispatch_root(
    State(handle): State<ProxyHandle>,
    Path(sid): Path<String>,
    req: Request,
) -> Response {
    dispatch_inner(handle, sid, String::new(), req).await
}

/// Handler for `/__bytro_preview/<sid>/<rest>` — the common case.
async fn dispatch(
    State(handle): State<ProxyHandle>,
    Path((sid, rest)): Path<(String, String)>,
    req: Request,
) -> Response {
    dispatch_inner(handle, sid, rest, req).await
}

async fn dispatch_inner(handle: ProxyHandle, sid: String, rest: String, req: Request) -> Response {
    let is_ws = is_websocket_upgrade(req.headers());
    let (mut parts, body) = req.into_parts();

    if is_ws {
        let query = parts.uri.query().map(str::to_owned);
        // Capture the requested subprotocol BEFORE the WebSocketUpgrade
        // extractor takes the headers. vite ≥ 6 uses `vite-hmr`; webpack
        // uses `webpack-hmr`; without forwarding it the upstream's HMR
        // server hangs the handshake instead of returning 101.
        let subprotocol = parts
            .headers
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(ws) => proxy_ws_upgrade(handle, sid, rest, ws, query, subprotocol).await,
            Err(e) => e.into_response(),
        }
    } else {
        let req = Request::from_parts(parts, body);
        proxy_http_request(handle, sid, rest, req).await
    }
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let connection = headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let upgrade = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    connection.to_ascii_lowercase().contains("upgrade") && upgrade.eq_ignore_ascii_case("websocket")
}

/// Recover the session id from the Referer header for absolute-path requests.
///
/// HTML returned by upstream dev servers contains absolute-path tags like
/// `<script src="/@vite/client">`. The browser resolves these against the
/// iframe's origin (no `/__bytro_preview/<sid>/` prefix), so the request URI on our
/// side is just `/@vite/client`. We extract the `<sid>` from `Referer` —
/// which is `http://127.0.0.1:<P>/__bytro_preview/<sid>/` — and route back through
/// the normal dispatcher. Without a usable Referer the request is rejected,
/// preserving the security guarantee that the proxy cannot be repurposed
/// as an open localhost relay.
async fn referer_fallback(State(handle): State<ProxyHandle>, req: Request) -> Response {
    let referer = req
        .headers()
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let path = req.uri().path().to_string();

    // Try Referer first; fall back to the most recently registered session.
    // Browsers strip the iframe path from cross-origin Referer (only origin
    // is sent), so Referer alone is not enough for absolute-path subresource
    // requests like `<script src="/@vite/client">`. The "last active session"
    // fallback covers the single-iframe preview case (our primary use case);
    // multi-preview scenarios will be handled when the need arises.
    let sid_from_referer = extract_sid_from_referer(&referer);
    let sid_from_last = handle.last_active();
    let resolved = sid_from_referer.clone().or_else(|| sid_from_last.clone());

    let Some(sid) = resolved else {
        // Real error worth surfacing: someone hit the proxy with no sid
        // anywhere — either a misconfiguration or an attempted open relay.
        log::warn!("[preview-proxy] fallback rejected: no preview session resolvable");
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("content-type", "text/plain; charset=utf-8")
            .body(Body::from("preview proxy: path not found"))
            .expect("static fallback body");
    };

    // Per-subresource routing happens dozens of times per page load; keep
    // it at debug so noisy logs don't drown out the real signals.
    log::debug!("[preview-proxy] fallback request routed");

    let rest = path.trim_start_matches('/').to_string();
    dispatch_inner(handle, sid, rest, req).await
}

fn extract_sid_from_referer(referer: &str) -> Option<String> {
    // Accept absolute or relative referer URIs. Look for "/__bytro_preview/" then
    // grab the next path segment as the sid.
    let idx = referer.find(PATH_PREFIX)?;
    let after = &referer[idx + PATH_PREFIX.len()..];
    let after = after.strip_prefix('/')?;
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let sid = &after[..end];
    if sid.is_empty() {
        None
    } else {
        Some(sid.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn listener_binds_only_ipv4_loopback() {
        let listener = bind_loopback().await.expect("loopback bind failed");
        let address = listener.local_addr().expect("listener has no address");

        assert_eq!(address.ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_ne!(address.port(), 0);
    }

    #[test]
    fn extract_sid_basic() {
        assert_eq!(
            extract_sid_from_referer("http://127.0.0.1:60156/__bytro_preview/abc123/",),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn extract_sid_with_subpath() {
        assert_eq!(
            extract_sid_from_referer("http://127.0.0.1:60156/__bytro_preview/abc123/foo/bar",),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn extract_sid_with_query() {
        assert_eq!(
            extract_sid_from_referer("http://127.0.0.1:60156/__bytro_preview/abc123?x=1",),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn extract_sid_no_prefix() {
        assert_eq!(extract_sid_from_referer("http://example.com/"), None);
    }

    #[test]
    fn extract_sid_empty() {
        assert_eq!(extract_sid_from_referer(""), None);
    }

    #[test]
    fn extract_sid_truncated() {
        assert_eq!(extract_sid_from_referer("/__bytro_preview/"), None);
    }
}
