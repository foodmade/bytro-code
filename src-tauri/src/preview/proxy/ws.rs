use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message as AxMessage, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TgMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::http::bad_gateway;
use super::state::ProxyHandle;

const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

type UpstreamStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Entry called by the dispatcher in `server.rs` for WebSocket-upgrade requests.
pub async fn proxy_ws_upgrade(
    handle: ProxyHandle,
    sid: String,
    rest: String,
    ws: WebSocketUpgrade,
    query: Option<String>,
    subprotocol: Option<String>,
) -> Response {
    let Some(session) = handle.lookup_session(&sid) else {
        return bad_gateway("preview session not registered");
    };

    let mut upstream_url = session.target.clone();
    if upstream_url.set_scheme("ws").is_err() {
        return bad_gateway("failed to set ws scheme on upstream url");
    }

    let path = if rest.starts_with('/') {
        rest.clone()
    } else {
        format!("/{}", rest)
    };
    upstream_url.set_path(&path);
    upstream_url.set_query(query.as_deref());
    let upstream_str = upstream_url.to_string();

    // Connect to upstream BEFORE upgrading the client. If we upgrade first
    // and then the upstream connect hangs (vite ≥ 6 silently drops the
    // handshake when the subprotocol is missing), the browser thinks the
    // socket is open but never receives any frames. Connecting first lets
    // us return 502 cleanly when the upstream is unreachable.
    let upstream_stream = match connect_upstream(&upstream_str, subprotocol.as_deref()).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                "[preview-proxy] {}",
                super::preview_diagnostic_summary("websocket_connect_failed", &e)
            );
            return bad_gateway(&format!("ws upstream connect failed: {}", e));
        }
    };

    log::info!("[preview-proxy] websocket upstream connected");

    // Echo the subprotocol back to the browser so HMR clients see the
    // negotiated protocol they expect.
    let ws = match subprotocol.as_deref() {
        Some(p) if !p.is_empty() => ws.protocols([p.to_string()]),
        _ => ws,
    };

    ws.on_upgrade(move |socket| async move {
        match bridge(socket, upstream_stream).await {
            Ok(stats) => log::info!(
                "[preview-proxy] websocket bridge closed: c2u={} u2c={}",
                stats.client_to_upstream,
                stats.upstream_to_client,
            ),
            Err(e) => log::warn!(
                "[preview-proxy] {}",
                super::preview_diagnostic_summary("websocket_bridge_failed", &e)
            ),
        }
    })
}

async fn connect_upstream(
    upstream_url: &str,
    subprotocol: Option<&str>,
) -> Result<UpstreamStream, String> {
    let mut request = upstream_url
        .into_client_request()
        .map_err(|e| format!("invalid upstream url: {}", e))?;

    if let Some(p) = subprotocol {
        if !p.is_empty() {
            let value = p
                .parse()
                .map_err(|e| format!("invalid subprotocol header: {}", e))?;
            request
                .headers_mut()
                .insert("sec-websocket-protocol", value);
        }
    }

    let connect = tokio_tungstenite::connect_async(request);
    match tokio::time::timeout(UPSTREAM_CONNECT_TIMEOUT, connect).await {
        Ok(Ok((stream, _resp))) => Ok(stream),
        Ok(Err(e)) => Err(format!("connect: {}", e)),
        Err(_) => Err(format!(
            "connect timed out after {}s",
            UPSTREAM_CONNECT_TIMEOUT.as_secs()
        )),
    }
}

#[derive(Default)]
struct BridgeStats {
    client_to_upstream: u64,
    upstream_to_client: u64,
}

async fn bridge(client_ws: WebSocket, upstream: UpstreamStream) -> Result<BridgeStats, String> {
    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut client_tx, mut client_rx) = client_ws.split();

    // Atomic counters shared with both forwarding tasks. `tokio::select!`
    // cancels the loser future, so observed counts must be written into
    // shared state as messages flow — capturing the return value of only
    // the winning future would always show the canceled side as 0.
    let c2u = Arc::new(AtomicU64::new(0));
    let u2c = Arc::new(AtomicU64::new(0));

    let c2u_inner = c2u.clone();
    let client_to_up = async move {
        while let Some(Ok(msg)) = client_rx.next().await {
            let Some(t) = ax_to_tg(msg) else { continue };
            if up_tx.send(t).await.is_err() {
                break;
            }
            c2u_inner.fetch_add(1, Ordering::Relaxed);
        }
    };

    let u2c_inner = u2c.clone();
    let up_to_client = async move {
        while let Some(Ok(msg)) = up_rx.next().await {
            let Some(a) = tg_to_ax(msg) else { continue };
            if client_tx.send(a).await.is_err() {
                break;
            }
            u2c_inner.fetch_add(1, Ordering::Relaxed);
        }
    };

    tokio::select! {
        _ = client_to_up => {}
        _ = up_to_client => {}
    }

    Ok(BridgeStats {
        client_to_upstream: c2u.load(Ordering::Relaxed),
        upstream_to_client: u2c.load(Ordering::Relaxed),
    })
}

fn ax_to_tg(msg: AxMessage) -> Option<TgMessage> {
    match msg {
        AxMessage::Text(t) => Some(TgMessage::Text(t.as_str().into())),
        AxMessage::Binary(b) => Some(TgMessage::Binary(b.into())),
        AxMessage::Ping(b) => Some(TgMessage::Ping(b.into())),
        AxMessage::Pong(b) => Some(TgMessage::Pong(b.into())),
        AxMessage::Close(_) => Some(TgMessage::Close(None)),
    }
}

fn tg_to_ax(msg: TgMessage) -> Option<AxMessage> {
    match msg {
        TgMessage::Text(t) => Some(AxMessage::Text(t.as_str().to_owned().into())),
        TgMessage::Binary(b) => Some(AxMessage::Binary(b.to_vec().into())),
        TgMessage::Ping(b) => Some(AxMessage::Ping(b.to_vec().into())),
        TgMessage::Pong(b) => Some(AxMessage::Pong(b.to_vec().into())),
        TgMessage::Close(_) => Some(AxMessage::Close(None)),
        TgMessage::Frame(_) => None,
    }
}
