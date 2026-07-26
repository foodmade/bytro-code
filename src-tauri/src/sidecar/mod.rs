pub(crate) mod chat;
pub(crate) mod cli_tools;
pub(crate) mod codex_auth;
pub(crate) mod credential_scanner;
mod events;
pub(crate) mod mcp;
pub(crate) mod mcp_oauth;
pub(crate) mod protocol;
pub(crate) mod session;
pub(crate) mod skills;
pub(crate) mod slash_commands;
pub(crate) mod teams_chat;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use events::{StreamDoneEvent, StreamErrorEvent};
use protocol::{SidecarCommand, SidecarEvent};

// Submodules with #[tauri::command] functions are pub(crate) so that
// lib.rs can reference the Tauri-generated hidden symbols via full paths
// (e.g. sidecar::chat::stream_chat).

// ---------------------------------------------------------------------------
// Valid permission modes
// ---------------------------------------------------------------------------

pub(crate) const VALID_PERMISSION_MODES: &[&str] = &[
    "default",
    "acceptEdits",
    "plan",
    "deep",
    "bypassPermissions",
    // Legacy values (frontend migration may not have run yet)
    "planning",
    "agent",
];

pub(crate) fn normalize_permission_mode(
    permission_mode: Option<String>,
    default_mode: &str,
) -> String {
    match permission_mode.as_deref() {
        // Historical "auto" meant bypass. Treat it as the safest interactive
        // mode so an upgrade never grants dangerous access without consent.
        Some("auto") => "default".to_string(),
        Some(mode) => mode.to_string(),
        None => default_mode.to_string(),
    }
}

fn is_http_proxy_env_compatible(proxy_url: &str) -> bool {
    let lower = proxy_url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn sidecar_diagnostic_summary(event_type: &str, value: &str) -> String {
    let safe_event: String = event_type
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
    let digest = Sha256::digest(value.as_bytes());
    format!(
        "event={} len={} sha256={:x}",
        if safe_event.is_empty() {
            "message"
        } else {
            &safe_event
        },
        value.len(),
        digest
    )
}

// ---------------------------------------------------------------------------
// Sidecar process wrapper
// ---------------------------------------------------------------------------

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
}

struct SidecarState {
    process: Option<SidecarProcess>,
    fail_count: u32,
    current_proxy: Option<String>,
}

/// Ring-buffer that keeps the last N lines of sidecar stderr for crash reports.
#[derive(Clone)]
struct StderrBuffer {
    inner: Arc<Mutex<Vec<String>>>,
}

impl StderrBuffer {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn push(&self, line: String) {
        if let Ok(mut buf) = self.inner.lock() {
            buf.push(line);
            // Keep only the last 30 lines
            if buf.len() > 30 {
                let drain = buf.len() - 30;
                buf.drain(..drain);
            }
        }
    }

    fn take_all(&self) -> String {
        if let Ok(mut buf) = self.inner.lock() {
            let joined = buf.join("\n");
            buf.clear();
            joined
        } else {
            String::new()
        }
    }
}

/// Tracks an in-flight streaming request so the frontend can query whether
/// the backend is still actively processing a conversation.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveRequestInfo {
    pub request_id: String,
    pub conversation_id: Option<String>,
    pub started_at: u64,
    /// The window that initiated this request (for targeted event routing).
    pub window_label: Option<String>,
}

pub struct SidecarManager {
    state: Mutex<SidecarState>,
    /// Shared with the stdout reader thread so it can emit errors on sidecar crash.
    last_request_id: Arc<Mutex<Option<String>>>,
    /// All currently in-flight streaming requests, keyed by request_id.
    /// Inserted when `stream_chat` is called, removed when `Done` or `Error`
    /// events are received (or on sidecar crash).
    active_requests: Arc<Mutex<HashMap<String, ActiveRequestInfo>>>,
    /// Captured stderr output from the sidecar — included in crash error messages.
    stderr_buffer: StderrBuffer,
    /// Set to true when the stdout reader thread exits (normally or via panic).
    /// Checked by ensure_running to detect orphaned process handles.
    stdout_reader_dead: Arc<AtomicBool>,
    /// Subset of requests that are *actively streaming* output right now.
    /// Warm sessions keep their `active_requests` entry alive between turns, so a
    /// non-empty `active_requests` does NOT mean work is in flight. This set is
    /// emptied as soon as a request's Done/Error/SessionEnded arrives, so it is the
    /// reliable "is anything streaming?" signal. `ensure_running` consults it to
    /// avoid killing the sidecar (and aborting a reply mid-stream) on proxy change.
    streaming_requests: Arc<Mutex<HashSet<String>>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SidecarState {
                process: None,
                fail_count: 0,
                current_proxy: None,
            }),
            last_request_id: Arc::new(Mutex::new(None)),
            active_requests: Arc::new(Mutex::new(HashMap::new())),
            stderr_buffer: StderrBuffer::new(),
            stdout_reader_dead: Arc::new(AtomicBool::new(false)),
            streaming_requests: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub(crate) fn ensure_running(
        &self,
        _api_key: &str,
        _base_url: &str,
        _openai_api_key: &str,
        _gemini_api_key: &str,
        proxy_url: Option<&str>,
        app: &AppHandle,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        // If the stdout reader thread died (panic, stack overflow, or normal exit),
        // the process handle is orphaned — force-clear it so we respawn.
        if self.stdout_reader_dead.load(Ordering::Relaxed) {
            eprintln!("[sidecar] stdout reader thread dead, clearing orphaned process");
            if let Some(mut proc) = state.process.take() {
                let _ = proc.child.kill();
            }
            self.stdout_reader_dead.store(false, Ordering::Relaxed);
        }

        // Normalize proxy value for comparison
        let new_proxy = proxy_url
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        // Check proxy change before borrowing the process
        let proxy_changed = state.current_proxy != new_proxy;

        // Already running?
        // Determine action first, then handle outside the borrow.
        let needs_proxy_restart = if let Some(ref mut proc) = state.process {
            match proc.child.try_wait() {
                Ok(Some(_)) => {
                    // Process exited — drop it and re-spawn below
                    state.process = None;
                    false
                }
                Ok(None) if !proxy_changed => {
                    return Ok(()); // Still running with same proxy
                }
                Ok(None) => {
                    // Proxy changed. The sidecar is a single shared process, so killing
                    // it would abort any reply that is streaming right now — the user
                    // would see "Sidecar process exited unexpectedly" mid-answer. If
                    // something is actively streaming, defer the restart: keep serving on
                    // the current proxy and leave `current_proxy` unchanged so the switch
                    // is retried on the next request once the stream finishes. Idle warm
                    // sessions are not counted — restarting for them is acceptable.
                    let streaming = self.streaming_requests.lock().map(|s| s.len()).unwrap_or(0);
                    if streaming > 0 {
                        eprintln!(
                            "[sidecar] proxy changed but {} request(s) streaming — deferring restart to avoid aborting them",
                            streaming
                        );
                        return Ok(());
                    }
                    // Nothing streaming — safe to restart so the new proxy takes effect.
                    let cmd = SidecarCommand::Shutdown {};
                    if let Ok(json) = serde_json::to_string(&cmd) {
                        let _ = proc.stdin.write_all(json.as_bytes());
                        let _ = proc.stdin.write_all(b"\n");
                        let _ = proc.stdin.flush();
                    }
                    true
                }
                Err(_) => {
                    state.process = None;
                    false
                }
            }
        } else {
            false
        };

        // If proxy changed, release the Mutex before sleeping to avoid contention.
        if needs_proxy_restart {
            if let Some(mut old_proc) = state.process.take() {
                drop(state);
                std::thread::sleep(std::time::Duration::from_millis(300));
                let _ = old_proc.child.kill();
                // Re-acquire lock to continue with spawn
                state = self
                    .state
                    .lock()
                    .map_err(|e| format!("Lock error: {}", e))?;
            }
        }

        if state.fail_count >= 3 {
            return Err(
                "Sidecar failed to start 3 times consecutively. Please check Node.js installation."
                    .to_string(),
            );
        }

        // Locate node executable and sidecar entry point.
        // Dev mode (cfg!(dev)): system `node` + sidecar/dist/index.js
        // Production: node from NodeRuntimeManager + bundle.mjs from Tauri resources
        let (node_exe, sidecar_path) = if cfg!(dev) {
            let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../sidecar/dist/index.js");
            if dev_path.exists() {
                ("node".to_string(), dev_path)
            } else {
                return Err(
                    "Cannot find sidecar/dist/index.js. Run 'npm run build:sidecar' first."
                        .to_string(),
                );
            }
        } else {
            // Get the user-configured or PATH-discovered local Node.js runtime.
            let rt_manager = app.state::<crate::node_runtime::NodeRuntimeManager>();
            let node_path = rt_manager.get_node_path().map_err(|_| {
                "Node.js v20 or newer was not found. Install it locally, launch Bytro \
                 from an environment with Node.js on PATH, or set BYTRO_NODE_PATH."
                    .to_string()
            })?;

            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("Cannot resolve resource dir: {}", e))?;

            let bundle = resource_dir.join("sidecar/bundle.mjs");

            if bundle.exists() {
                (node_path.to_string_lossy().to_string(), bundle)
            } else {
                return Err(
                    "Cannot find bundle.mjs in resources. Build may be corrupted.".to_string(),
                );
            }
        };

        // On Windows, Tauri's resource_dir() may return paths with the
        // \\?\ (UNC extended-length) prefix. Node.js's module resolver
        // cannot handle this prefix — it misparses the drive letter and
        // fails with `EISDIR: illegal operation on a directory, lstat 'C:'`.
        // Strip the prefix so Node.js receives a standard Windows path.
        let sidecar_arg = strip_unc_prefix(&sidecar_path);
        let node_arg = strip_unc_prefix_str(&node_exe);

        log::info!(
            "[sidecar] Spawning: node_exe={}, sidecar_path={}",
            node_arg,
            sidecar_arg
        );

        let mut cmd = Command::new(&node_arg);
        cmd.arg(&sidecar_arg)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Strip provider env vars inherited from the parent process to prevent
        // the developer's personal CLI credentials (system env vars,
        // ~/.claude/settings.json env section, or other tool configs) from
        // leaking into the sidecar and its child processes.
        //
        // Also strip proxy env vars inherited from the launch terminal. The
        // sidecar/Codex pipeline should only use a proxy when Bytro settings
        // pass one explicitly via `new_proxy` below; otherwise a dev shell with
        // http_proxy/ALL_PROXY set would silently force all Codex traffic through
        // the local terminal proxy.
        // Each request sends its own credentials via the NDJSON QueryCommand,
        // and handlers set env vars only for the duration of each individual request.
        const PROXY_ENV_KEYS: &[&str] = &[
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ];
        for (key, _) in std::env::vars() {
            if key.starts_with("ANTHROPIC_")
                || key.starts_with("OPENAI_")
                || PROXY_ENV_KEYS.contains(&key.as_str())
            {
                cmd.env_remove(&key);
            }
        }

        // Hide the console window on Windows (prevents black terminal flash).
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        // Provider binaries are discovered only from explicit settings or the
        // app launcher's original PATH. Never guess package-manager locations.
        let explicit_cli_paths = [
            "BYTRO_NODE_PATH",
            "CODEX_CLI_PATH",
            "CLAUDE_CLI_PATH",
            "GEMINI_CLI_PATH",
            "BYTRO_GIT_BASH_PATH",
            "CLAUDE_CODE_GIT_BASH_PATH",
        ]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(std::path::PathBuf::from));
        if let Ok(path) = cli_tools::build_path_with_explicit_cli_dirs(
            std::env::var_os("PATH").as_deref(),
            explicit_cli_paths,
        ) {
            cmd.env("PATH", path);
        }

        if let Some(ref proxy) = new_proxy {
            // Claude Code's Node/Bun proxy env parser only accepts HTTP(S)
            // proxy URLs. SOCKS proxies are bridged per request inside the
            // sidecar before spawning the Claude CLI child process.
            if is_http_proxy_env_compatible(proxy) {
                cmd.env("HTTP_PROXY", proxy)
                    .env("HTTPS_PROXY", proxy)
                    .env("ALL_PROXY", proxy)
                    .env("http_proxy", proxy)
                    .env("https_proxy", proxy)
                    .env("all_proxy", proxy);
            }
        }

        let mut child = cmd.spawn().map_err(|e| {
            state.fail_count += 1;
            format!(
                "Failed to spawn sidecar (Node.js). Is Node.js installed? Error: {}",
                e
            )
        })?;
        // Reset fail counter on successful spawn
        state.fail_count = 0;

        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to capture sidecar stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to capture sidecar stdout")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Failed to capture sidecar stderr")?;

        // Clone the shared Arcs for the reader thread
        let last_req_id = Arc::clone(&self.last_request_id);
        let active_reqs = Arc::clone(&self.active_requests);
        let streaming_reqs = Arc::clone(&self.streaming_requests);
        let stderr_buf = self.stderr_buffer.clone();

        // Spawn stderr reader thread. Raw child output can contain prompts,
        // arguments, provider credentials, and local paths, so only fixed
        // metadata summaries cross the log, crash-buffer, or frontend boundary.
        // Explicit auth-debug lines are assembled from redacted fields by the
        // sidecar and are safe to pass through during authentication diagnosis.
        let stderr_buf_for_reader = stderr_buf.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if l.starts_with("[auth-debug]") {
                            log::warn!("{}", l);
                            stderr_buf_for_reader.push(l);
                        } else {
                            let summary = sidecar_diagnostic_summary("sidecar.stderr", &l);
                            log::warn!("[sidecar-stderr] {}", summary);
                            stderr_buf_for_reader.push(summary);
                        }
                    }
                    Err(e) => {
                        log::error!("[sidecar-stderr] read error kind={:?}", e.kind());
                        break;
                    }
                }
            }
        });

        // Spawn persistent stdout reader thread
        let app_clone = app.clone();
        let reader_dead_flag = Arc::clone(&self.stdout_reader_dead);
        reader_dead_flag.store(false, Ordering::Relaxed);
        std::thread::spawn(move || {
            // RAII guard: ensures the flag is set when this thread exits,
            // whether normally or via panic (e.g. stack overflow).
            struct ReaderDeadGuard(Arc<AtomicBool>);
            impl Drop for ReaderDeadGuard {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::Relaxed);
                }
            }
            let _dead_guard = ReaderDeadGuard(reader_dead_flag);

            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!("[sidecar-bridge] stdout read error kind={:?}", e.kind());
                        break;
                    }
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                match serde_json::from_str::<SidecarEvent>(trimmed) {
                    Ok(event) => {
                        // Look up the originating window before terminal events
                        // remove the request from active tracking.
                        let target_window = extract_id_field(trimmed)
                            .and_then(|req_id| {
                                active_reqs.lock().ok().map(|guard| {
                                    guard.get(req_id).and_then(|info| info.window_label.clone())
                                })
                            })
                            .flatten();

                        // Maintain the live-streaming set. Any event carrying an id
                        // means that request is producing output right now; the terminal
                        // events (Done/Error/SessionEnded) mean it has stopped. Warm
                        // sessions keep their `active_requests` entry between turns, so
                        // this set — not `active_requests` — is what tells whether
                        // anything is actually streaming at this instant.
                        if let Some(req_id) = extract_id_field(trimmed) {
                            let is_terminal = matches!(
                                &event,
                                SidecarEvent::Done { .. }
                                    | SidecarEvent::Error { .. }
                                    | SidecarEvent::SessionEnded { .. }
                            );
                            if let Ok(mut s) = streaming_reqs.lock() {
                                if is_terminal {
                                    s.remove(req_id);
                                } else {
                                    s.insert(req_id.to_string());
                                }
                            }
                        }

                        // Clear tracking state for completed requests.
                        // For warm sessions (sessionAlive=true), keep the request
                        // tracked so subsequent messages can still route to it.
                        match &event {
                            SidecarEvent::Done {
                                id, session_alive, ..
                            } => {
                                let is_warm = session_alive.unwrap_or(false);
                                if !is_warm {
                                    if let Ok(mut guard) = last_req_id.lock() {
                                        if guard.as_deref() == Some(id.as_str()) {
                                            *guard = None;
                                        }
                                    }
                                    if let Ok(mut guard) = active_reqs.lock() {
                                        guard.remove(id);
                                    }
                                }
                            }
                            SidecarEvent::Error { id, .. } => {
                                if let Ok(mut guard) = last_req_id.lock() {
                                    if guard.as_deref() == Some(id.as_str()) {
                                        *guard = None;
                                    }
                                }
                                if let Ok(mut guard) = active_reqs.lock() {
                                    guard.remove(id);
                                }
                            }
                            SidecarEvent::SessionEnded { id, .. } => {
                                // Warm session ended — now clean up tracking
                                if let Ok(mut guard) = last_req_id.lock() {
                                    if guard.as_deref() == Some(id.as_str()) {
                                        *guard = None;
                                    }
                                }
                                if let Ok(mut guard) = active_reqs.lock() {
                                    guard.remove(id);
                                }
                            }
                            _ => {}
                        }
                        events::translate_event(&app_clone, event, target_window.as_deref());
                    }
                    Err(e) => {
                        let summary =
                            sidecar_diagnostic_summary("sidecar.stdout.invalid_event", trimmed);
                        log::warn!(
                            "[sidecar-bridge] failed to parse event category={:?} {}",
                            e.classify(),
                            summary
                        );
                    }
                }
            }

            // Stdout closed — sidecar process likely crashed or exited.
            // Wait briefly for stderr reader to flush remaining lines.
            std::thread::sleep(std::time::Duration::from_millis(100));
            let stderr_output = stderr_buf.take_all();
            if !stderr_output.is_empty() {
                log::error!(
                    "[sidecar-bridge] {}",
                    sidecar_diagnostic_summary("sidecar.crash_diagnostics", &stderr_output)
                );
            }
            let error_detail =
                "Sidecar process exited unexpectedly. Diagnostic metadata was recorded."
                    .to_string();
            log::error!("[sidecar-bridge] process exited unexpectedly");

            let mut requests_to_close: Vec<(String, Option<String>)> = Vec::new();
            if let Ok(mut guard) = active_reqs.lock() {
                requests_to_close.extend(
                    guard
                        .values()
                        .map(|info| (info.request_id.clone(), info.conversation_id.clone())),
                );
                guard.clear();
            }
            if let Ok(mut guard) = streaming_reqs.lock() {
                guard.clear();
            }
            if let Ok(mut guard) = last_req_id.lock() {
                if let Some(req_id) = guard.take() {
                    if !requests_to_close.iter().any(|(id, _)| id == &req_id) {
                        requests_to_close.push((req_id, None));
                    }
                }
            }

            for (req_id, conversation_id) in requests_to_close {
                let _ = app_clone.emit(
                    "chat-error",
                    StreamErrorEvent {
                        request_id: req_id.clone(),
                        error: error_detail.clone(),
                        error_status: None,
                    },
                );
                let _ = app_clone.emit(
                    "chat-done",
                    StreamDoneEvent {
                        request_id: req_id,
                        session_alive: None,
                        conversation_id,
                    },
                );
            }
        });

        state.current_proxy = new_proxy;

        state.process = Some(SidecarProcess { child, stdin });

        Ok(())
    }

    pub(crate) fn send_command(&self, cmd: &SidecarCommand) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        let proc = state.process.as_mut().ok_or("Sidecar is not running")?;

        let json = serde_json::to_string(cmd).map_err(|e| format!("Serialize error: {}", e))?;
        let write_result = proc
            .stdin
            .write_all(json.as_bytes())
            .and_then(|_| proc.stdin.write_all(b"\n"))
            .and_then(|_| proc.stdin.flush());

        if let Err(e) = write_result {
            eprintln!("[sidecar] stdin write failed, clearing process: {}", e);
            if let Some(mut dead) = state.process.take() {
                let _ = dead.child.kill();
            }
            return Err(format!("Failed to write to sidecar stdin: {}", e));
        }
        Ok(())
    }

    pub(crate) fn set_last_request_id(&self, request_id: &str) {
        if let Ok(mut guard) = self.last_request_id.lock() {
            *guard = Some(request_id.to_string());
        }
    }

    pub(crate) fn clear_last_request_id(&self) {
        if let Ok(mut guard) = self.last_request_id.lock() {
            *guard = None;
        }
    }

    pub(crate) fn clear_last_request_id_if_matches(&self, request_id: &str) {
        if let Ok(mut guard) = self.last_request_id.lock() {
            if guard.as_deref() == Some(request_id) {
                *guard = None;
            }
        }
    }

    pub(crate) fn track_request(
        &self,
        request_id: &str,
        conversation_id: Option<String>,
        window_label: Option<String>,
    ) {
        if let Ok(mut guard) = self.active_requests.lock() {
            guard.insert(
                request_id.to_string(),
                ActiveRequestInfo {
                    request_id: request_id.to_string(),
                    conversation_id,
                    started_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    window_label,
                },
            );
        }
    }

    pub(crate) fn untrack_request(&self, request_id: &str) {
        if let Ok(mut guard) = self.active_requests.lock() {
            guard.remove(request_id);
        }
    }

    /// Reverse lookup: find the conversation_id for a given request_id.
    pub(crate) fn find_conversation_for_request(&self, request_id: &str) -> Option<String> {
        self.active_requests.lock().ok().and_then(|guard| {
            guard
                .get(request_id)
                .and_then(|info| info.conversation_id.clone())
        })
    }

    fn shutdown(&self) {
        // Take the process out under lock, then handle sleep+kill outside
        // to avoid holding the Mutex for 500ms.
        let old_process = {
            let mut state = match self.state.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            state.process.take()
        };
        // Mutex released here

        if let Some(mut proc) = old_process {
            let cmd = SidecarCommand::Shutdown {};
            if let Ok(json) = serde_json::to_string(&cmd) {
                let _ = proc.stdin.write_all(json.as_bytes());
                let _ = proc.stdin.write_all(b"\n");
                let _ = proc.stdin.flush();
            }

            // Give it a moment then kill — no Mutex contention
            std::thread::sleep(std::time::Duration::from_millis(500));
            let _ = proc.child.kill();
        }

        self.clear_last_request_id();
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Strip the `\\?\` UNC extended-length prefix from a PathBuf.
/// Node.js cannot handle this prefix in its module resolver on Windows.
fn strip_unc_prefix(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Strip the `\\?\` prefix from an already-converted String.
fn strip_unc_prefix_str(s: &str) -> String {
    s.strip_prefix(r"\\?\").unwrap_or(s).to_string()
}

/// Fast extraction of the `"id"` field value from a raw JSON string.
/// Returns `None` if the field is not found.
fn extract_id_field(json: &str) -> Option<&str> {
    let marker = r#""id":""#;
    let start = json.find(marker)? + marker.len();
    let end = json[start..].find('"')? + start;
    Some(&json[start..end])
}

#[cfg(test)]
mod tests {
    use super::{normalize_permission_mode, sidecar_diagnostic_summary, VALID_PERMISSION_MODES};

    #[test]
    fn legacy_auto_is_normalized_to_safe_default_and_not_allowed_directly() {
        assert_eq!(
            normalize_permission_mode(Some("auto".to_string()), "agent"),
            "default"
        );
        assert!(!VALID_PERMISSION_MODES.contains(&"auto"));
        assert!(VALID_PERMISSION_MODES.contains(&"bypassPermissions"));
    }

    #[test]
    fn sidecar_diagnostics_never_include_raw_child_output() {
        let sentinel = "SECRET_SENTINEL prompt=private api_key=sk-private /Users/private";
        let summary = sidecar_diagnostic_summary("sidecar.stderr", sentinel);

        assert!(summary.starts_with("event=sidecar.stderr len="));
        assert!(summary.contains("sha256="));
        assert!(!summary.contains("SECRET_SENTINEL"));
        assert!(!summary.contains("sk-private"));
        assert!(!summary.contains("/Users/private"));
    }
}
