use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use tokio::sync::{Notify, OnceCell};
use url::{Host, Url};

/// One registered preview session: maps a session id to an upstream dev server URL.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    /// Upstream dev server URL the user wants to preview, e.g. "http://localhost:5173".
    pub target: Url,
    /// "host:port" cached for cheap header rewrites. Kept around for future
    /// Host-header rewrites; currently not read.
    #[allow(dead_code)]
    pub target_authority: String,
}

impl SessionInfo {
    pub fn from_url(raw: &str) -> Result<Self, String> {
        let url = Url::parse(raw).map_err(|_| "invalid preview target".to_string())?;
        if url.scheme() != "http" {
            return Err("preview target must use http".to_string());
        }
        if raw_authority(raw).is_some_and(|authority| authority.contains('@'))
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("preview target credentials are not allowed".to_string());
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err("preview target query and fragment are not allowed".to_string());
        }

        let host = match url.host() {
            Some(Host::Domain(host)) if host.eq_ignore_ascii_case("localhost") => host.to_string(),
            Some(Host::Ipv4(address)) if address.is_loopback() => address.to_string(),
            Some(Host::Ipv6(address)) if address.is_loopback() => format!("[{}]", address),
            Some(_) => return Err("preview target must use a loopback host".to_string()),
            None => return Err("preview target host is required".to_string()),
        };

        let port = explicit_port(raw)
            .filter(|port| *port != 0)
            .ok_or_else(|| "preview target requires an explicit non-zero port".to_string())?;

        Ok(Self {
            target_authority: format!("{}:{}", host, port),
            target: url,
        })
    }
}

fn explicit_port(raw: &str) -> Option<u16> {
    let authority = raw_authority(raw)?;
    let port = if authority.starts_with('[') {
        let closing_bracket = authority.find(']')?;
        authority.get(closing_bracket + 1..)?.strip_prefix(':')?
    } else {
        authority.rsplit_once(':')?.1
    };

    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

fn raw_authority(raw: &str) -> Option<&str> {
    raw.split_once("://")?.1.split(['/', '?', '#']).next()
}

/// Tauri-managed global state for the preview proxy.
///
/// One process-wide instance owns the axum server, the inspector runtime
/// script content, and the session-id → upstream-url table. The store is
/// cheap to clone (Arc) so handlers can grab a snapshot without locking
/// the whole map.
pub struct PreviewProxyState {
    inner: Arc<Inner>,
}

pub struct Inner {
    pub sessions: RwLock<HashMap<String, SessionInfo>>,
    /// Most recently registered session id. Used as a fallback for
    /// absolute-path subresource requests where Referer/Cookie don't carry
    /// the sid (typical for browsers that strip path from cross-origin
    /// iframe Referer). Single-iframe preview is the primary use case.
    pub last_active: RwLock<Option<String>>,
    pub port: RwLock<Option<u16>>,
    /// Coordinates the first explicit preview request so concurrent callers
    /// share one listener instead of racing to bind multiple proxy servers.
    pub started_port: OnceCell<u16>,
    /// Loaded on first proxy use from `resources/preview-template/plugins/inspector-runtime.js`.
    pub inspector_runtime: RwLock<Option<String>>,
    /// Notify all server tasks to shut down (graceful exit on window close).
    pub shutdown: Notify,
}

impl PreviewProxyState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: RwLock::new(HashMap::new()),
                last_active: RwLock::new(None),
                port: RwLock::new(None),
                started_port: OnceCell::new(),
                inspector_runtime: RwLock::new(None),
                shutdown: Notify::new(),
            }),
        }
    }

    pub fn handle(&self) -> ProxyHandle {
        ProxyHandle {
            inner: self.inner.clone(),
        }
    }

    pub fn shutdown(&self) {
        self.inner.shutdown.notify_waiters();
    }

    pub async fn ensure_started_with<F, Fut>(&self, start: F) -> Result<u16, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<u16, String>>,
    {
        self.inner
            .started_port
            .get_or_try_init(start)
            .await
            .copied()
    }
}

impl Default for PreviewProxyState {
    fn default() -> Self {
        Self::new()
    }
}

/// Cheap-to-clone handle passed into axum handlers and lifecycle tasks.
#[derive(Clone)]
pub struct ProxyHandle {
    pub inner: Arc<Inner>,
}

impl ProxyHandle {
    pub fn register_session(&self, sid: String, info: SessionInfo) {
        self.inner
            .sessions
            .write()
            .expect("sessions lock poisoned")
            .insert(sid.clone(), info);
        *self
            .inner
            .last_active
            .write()
            .expect("last_active lock poisoned") = Some(sid);
    }

    pub fn unregister_session(&self, sid: &str) -> bool {
        let removed = self
            .inner
            .sessions
            .write()
            .expect("sessions lock poisoned")
            .remove(sid)
            .is_some();
        let mut last = self
            .inner
            .last_active
            .write()
            .expect("last_active lock poisoned");
        if last.as_deref() == Some(sid) {
            *last = None;
        }
        removed
    }

    pub fn last_active(&self) -> Option<String> {
        self.inner
            .last_active
            .read()
            .expect("last_active lock poisoned")
            .clone()
    }

    pub fn lookup_session(&self, sid: &str) -> Option<SessionInfo> {
        self.inner
            .sessions
            .read()
            .expect("sessions lock poisoned")
            .get(sid)
            .cloned()
    }

    pub fn set_port(&self, port: u16) {
        *self.inner.port.write().expect("port lock poisoned") = Some(port);
    }

    pub fn port(&self) -> Option<u16> {
        *self.inner.port.read().expect("port lock poisoned")
    }

    pub fn set_inspector_runtime(&self, content: String) {
        *self
            .inner
            .inspector_runtime
            .write()
            .expect("inspector_runtime lock poisoned") = Some(content);
    }

    pub fn inspector_runtime(&self) -> Option<String> {
        self.inner
            .inspector_runtime
            .read()
            .expect("inspector_runtime lock poisoned")
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::Barrier;

    use super::*;

    #[test]
    fn new_state_does_not_claim_a_listener() {
        let state = PreviewProxyState::new();

        assert_eq!(state.handle().port(), None);
        assert!(state.inner.started_port.get().is_none());
    }

    #[test]
    fn preview_target_accepts_only_explicit_loopback_endpoints() {
        for target in [
            "http://localhost:5173",
            "http://LOCALHOST:3000/preview",
            "http://localhost:80",
            "http://127.0.0.1:5173",
            "http://127.42.8.9:8080",
            "http://[::1]:5173",
        ] {
            assert!(
                SessionInfo::from_url(target).is_ok(),
                "expected loopback target to be accepted: {target}"
            );
        }

        let ipv6 = SessionInfo::from_url("http://[::1]:5173").expect("IPv6 loopback rejected");
        assert_eq!(ipv6.target_authority, "[::1]:5173");
    }

    #[test]
    fn preview_target_rejects_external_or_credentialed_endpoints() {
        for target in [
            "https://localhost:5173",
            "http://example.com:5173",
            "http://localhost.evil:5173",
            "http://192.168.1.2:5173",
            "http://169.254.169.254:80/latest/meta-data",
            "http://user:password@localhost:5173",
            "http://@localhost:5173",
            "http://localhost:5173/?token=secret",
            "http://localhost:5173/#fragment",
            "http://localhost",
            "http://localhost:0",
            "http://[::ffff:127.0.0.1]:5173",
        ] {
            assert!(
                SessionInfo::from_url(target).is_err(),
                "expected unsafe target to be rejected: {target}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_initialization_runs_once() {
        const CALLERS: usize = 16;

        let state = Arc::new(PreviewProxyState::new());
        let attempts = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(CALLERS));
        let mut tasks = Vec::with_capacity(CALLERS);

        for _ in 0..CALLERS {
            let state = state.clone();
            let attempts = attempts.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                state
                    .ensure_started_with(|| async move {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        Ok(43123)
                    })
                    .await
            }));
        }

        for task in tasks {
            assert_eq!(task.await.expect("initializer task panicked"), Ok(43123));
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_initialization_can_be_retried() {
        let state = PreviewProxyState::new();

        assert_eq!(
            state
                .ensure_started_with(|| async { Err("bind failed".to_string()) })
                .await,
            Err("bind failed".to_string())
        );
        assert_eq!(
            state.ensure_started_with(|| async { Ok(43124) }).await,
            Ok(43124)
        );
    }
}
