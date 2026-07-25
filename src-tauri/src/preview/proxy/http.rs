use std::io::Read;
use std::sync::OnceLock;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use flate2::read::{GzDecoder, ZlibDecoder};

use super::inject::inject_into_html;
use super::state::{ProxyHandle, SessionInfo};

/// Cap on request body buffering (pasted/uploaded form data must fit).
/// 32 MB is generous for dev-server traffic and bounded enough to refuse
/// runaway payloads without blowing memory.
const MAX_REQUEST_BODY: usize = 32 * 1024 * 1024;

const CONTENT_RUNTIME_PATH: &str = "__inspector_runtime.js";

/// Hop-by-hop headers per RFC 7230 §6.1 plus a couple that confuse reqwest
/// when relayed verbatim. Stripped from both request and response.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

/// Headers we forcibly drop on the response so they cannot block iframe
/// embedding or override our injected script.
const RESPONSE_BLOCKLIST: &[&str] = &[
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
];

fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // The proxy talks to localhost dev servers — no proxy chaining,
            // no redirect following (we want to surface 30x to the browser
            // so it re-requests through the proxy).
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build reqwest client for preview proxy")
    })
}

/// Entry called by the dispatcher in `server.rs` once HTTP-vs-WS routing is decided.
pub async fn proxy_http_request(
    handle: ProxyHandle,
    sid: String,
    rest: String,
    req: Request,
) -> Response {
    let Some(session) = handle.lookup_session(&sid) else {
        return bad_gateway("preview session not registered");
    };

    if rest == CONTENT_RUNTIME_PATH {
        return serve_inspector_runtime(&handle);
    }

    let proxy_port = match handle.port() {
        Some(p) => p,
        None => return bad_gateway("preview proxy port not initialised"),
    };

    forward_request(session, sid, proxy_port, rest, req).await
}

async fn forward_request(
    session: SessionInfo,
    sid: String,
    proxy_port: u16,
    rest: String,
    req: Request,
) -> Response {
    let method = req.method().clone();
    let request_headers = req.headers().clone();
    let query = req.uri().query().map(str::to_owned);

    let body_bytes = match axum::body::to_bytes(req.into_body(), MAX_REQUEST_BODY).await {
        Ok(b) => b,
        Err(e) => return bad_gateway(&format!("request body buffer failed: {}", e)),
    };

    let upstream_url = match build_upstream_url(&session, &rest, query.as_deref()) {
        Ok(u) => u,
        Err(e) => return bad_gateway(&e),
    };

    let mut upstream_req = shared_client().request(method, upstream_url);

    // Forward headers minus hop-by-hop and Host (reqwest sets Host automatically).
    let mut forwarded_headers = HeaderMap::new();
    for (name, value) in request_headers.iter() {
        if HOP_BY_HOP
            .iter()
            .any(|h| name.as_str().eq_ignore_ascii_case(h))
        {
            continue;
        }
        forwarded_headers.append(name.clone(), value.clone());
    }

    // Strip accept-encoding so the upstream returns plain bytes — we need
    // raw HTML to inject the inspector script, and streaming non-HTML
    // responses doesn't gain anything from compressing localhost traffic.
    forwarded_headers.remove("accept-encoding");

    upstream_req = upstream_req.headers(forwarded_headers);
    if !body_bytes.is_empty() {
        upstream_req = upstream_req.body(body_bytes.to_vec());
    }

    let upstream = match upstream_req.send().await {
        Ok(r) => r,
        Err(e) => return bad_gateway(&format!("upstream unreachable: {}", e)),
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let is_html = upstream_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase().starts_with("text/html"))
        .unwrap_or(false);

    // Only HTML success responses get buffered and rewritten with the
    // inspector script. Everything else — including SSE (`text/event-stream`,
    // used by webpack-dev-server / Next.js HMR), large JS bundles, images,
    // and video — must stream so we don't (a) deadlock on infinite streams,
    // and (b) blow up memory on large assets.
    if is_html && status.is_success() {
        return inject_html_response(status, upstream_headers, upstream, &sid, proxy_port).await;
    }

    let stream = upstream.bytes_stream();
    let body = Body::from_stream(stream);
    build_streaming_response(status, upstream_headers, body)
}

/// Buffer the upstream HTML (and decompress if needed), inject the inspector
/// script + history rewrite, and return as a fixed-length response.
async fn inject_html_response(
    status: StatusCode,
    upstream_headers: HeaderMap,
    upstream: reqwest::Response,
    sid: &str,
    proxy_port: u16,
) -> Response {
    let content_encoding = upstream_headers
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase());

    let raw = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => return bad_gateway(&format!("upstream body read failed: {}", e)),
    };

    let decoded = match decode_body(&raw, content_encoding.as_deref()) {
        Ok(d) => d,
        Err(_) => {
            log::warn!("[preview-proxy] html decode failed; passing through original body");
            // Body still carries its original Content-Encoding; let the
            // browser handle it untouched.
            return build_response(status, upstream_headers, raw, false);
        }
    };

    match String::from_utf8(decoded) {
        Ok(html) => {
            let injected = Bytes::from(inject_into_html(&html, sid, proxy_port).into_bytes());
            build_response(status, upstream_headers, injected, true)
        }
        Err(_) => {
            // Non-UTF8 HTML is highly unusual; serve the original (still
            // compressed) bytes verbatim so Content-Encoding stays valid.
            log::warn!("[preview-proxy] html body is not valid utf-8, passing through");
            build_response(status, upstream_headers, raw, false)
        }
    }
}

fn build_streaming_response(
    status: StatusCode,
    upstream_headers: HeaderMap,
    body: Body,
) -> Response {
    let mut builder = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        let name_str = name.as_str();
        if HOP_BY_HOP.iter().any(|h| name_str.eq_ignore_ascii_case(h)) {
            continue;
        }
        if RESPONSE_BLOCKLIST
            .iter()
            .any(|h| name_str.eq_ignore_ascii_case(h))
        {
            continue;
        }
        builder = builder.header(name.clone(), value.clone());
    }
    builder
        .body(body)
        .unwrap_or_else(|_| internal_error("streaming response build failed"))
}

fn build_upstream_url(
    session: &SessionInfo,
    rest: &str,
    query: Option<&str>,
) -> Result<url::Url, String> {
    let mut url = session.target.clone();
    let path = if rest.is_empty() {
        url.path().to_string()
    } else if rest.starts_with('/') {
        rest.to_string()
    } else {
        format!("/{}", rest)
    };
    url.set_path(&path);
    url.set_query(query);
    Ok(url)
}

fn decode_body(body: &Bytes, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    match encoding {
        None | Some("identity") => Ok(body.to_vec()),
        Some("gzip") => {
            let mut decoder = GzDecoder::new(body.as_ref());
            let mut out = Vec::with_capacity(body.len() * 3);
            decoder
                .read_to_end(&mut out)
                .map_err(|e| format!("gzip: {}", e))?;
            Ok(out)
        }
        Some("deflate") => {
            let mut decoder = ZlibDecoder::new(body.as_ref());
            let mut out = Vec::with_capacity(body.len() * 3);
            decoder
                .read_to_end(&mut out)
                .map_err(|e| format!("deflate: {}", e))?;
            Ok(out)
        }
        Some(other) => Err(format!("unsupported content-encoding: {}", other)),
    }
}

fn build_response(
    status: StatusCode,
    upstream_headers: HeaderMap,
    body: Bytes,
    decompressed_html: bool,
) -> Response {
    let mut builder = Response::builder().status(status);

    for (name, value) in upstream_headers.iter() {
        let name_str = name.as_str();
        if HOP_BY_HOP.iter().any(|h| name_str.eq_ignore_ascii_case(h)) {
            continue;
        }
        if RESPONSE_BLOCKLIST
            .iter()
            .any(|h| name_str.eq_ignore_ascii_case(h))
        {
            continue;
        }
        if decompressed_html && name_str.eq_ignore_ascii_case("content-encoding") {
            continue;
        }
        builder = builder.header(name.clone(), value.clone());
    }

    if decompressed_html {
        builder = builder.header(
            HeaderName::from_static("content-length"),
            HeaderValue::from(body.len()),
        );
    }

    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| internal_error("response build failed"))
}

pub fn serve_inspector_runtime(handle: &ProxyHandle) -> Response {
    let Some(content) = handle.inspector_runtime() else {
        return internal_error("inspector runtime not loaded");
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/javascript; charset=utf-8")
        .header("cache-control", "no-cache")
        .body(Body::from(content))
        .unwrap_or_else(|_| internal_error("runtime response build failed"))
}

pub fn bad_gateway(msg: &str) -> Response {
    let diagnostic_id = super::preview_diagnostic_id(msg);
    log::warn!(
        "[preview-proxy] {}",
        super::preview_diagnostic_summary("upstream_request_failed", msg)
    );
    let body = format!(
        "<!doctype html><html><body style=\"font-family:system-ui;padding:24px;\">\
         <h2 style=\"color:#b00\">Preview proxy request failed</h2>\
         <p>diagnosticId: {diagnostic_id}</p></body></html>"
    );
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header("content-type", "text/html; charset=utf-8")
        .body(Body::from(body))
        .expect("static error body")
}

fn internal_error(msg: &str) -> Response {
    let diagnostic_id = super::preview_diagnostic_id(msg);
    log::warn!(
        "[preview-proxy] {}",
        super::preview_diagnostic_summary("internal_response_failed", msg)
    );
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Preview proxy internal error. diagnosticId: {diagnostic_id}"),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preview::proxy::state::SessionInfo;

    #[test]
    fn build_upstream_url_basic() {
        let s = SessionInfo::from_url("http://localhost:5173").unwrap();
        let u = build_upstream_url(&s, "src/main.tsx", Some("v=1")).unwrap();
        assert_eq!(u.as_str(), "http://localhost:5173/src/main.tsx?v=1");
    }

    #[test]
    fn build_upstream_url_root() {
        let s = SessionInfo::from_url("http://localhost:5173").unwrap();
        let u = build_upstream_url(&s, "", None).unwrap();
        assert_eq!(u.as_str(), "http://localhost:5173/");
    }

    #[test]
    fn build_upstream_url_handles_leading_slash() {
        let s = SessionInfo::from_url("http://localhost:5173").unwrap();
        let u = build_upstream_url(&s, "/foo", None).unwrap();
        assert_eq!(u.as_str(), "http://localhost:5173/foo");
    }

    #[test]
    fn decode_identity_passthrough() {
        let bytes = Bytes::from_static(b"plain");
        let out = decode_body(&bytes, None).unwrap();
        assert_eq!(out, b"plain");
    }

    #[tokio::test]
    async fn public_proxy_errors_do_not_echo_private_details() {
        let sentinel =
            "/Users/private/workspace secret-token prompt=do-not-disclose access_token=opaque";
        let response = bad_gateway(sentinel);

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("error response body");
        let body = String::from_utf8(body.to_vec()).expect("utf-8 error response");

        assert!(body.contains("Preview proxy request failed"));
        assert!(body.contains("diagnosticId: "));
        assert!(!body.contains("/Users/private"));
        assert!(!body.contains("secret-token"));
        assert!(!body.contains("do-not-disclose"));
        assert!(!body.contains("opaque"));
        let diagnostic_id = super::super::preview_diagnostic_id(sentinel);
        assert_eq!(diagnostic_id.len(), 12);
        assert!(diagnostic_id.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(body.contains(&diagnostic_id));
    }
}
