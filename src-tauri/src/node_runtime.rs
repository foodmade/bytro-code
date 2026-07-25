use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SYSTEM_NODE_MAJOR: u32 = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NodeRuntimeStatus {
    Unknown,
    Checking,
    Ready {
        #[serde(rename = "nodePath")]
        node_path: String,
        source: NodeSource,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeSource {
    System,
    Configured,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntimeInfo {
    pub status: NodeRuntimeStatus,
    pub node_path: Option<String>,
    pub npm_path: Option<String>,
    pub source: Option<NodeSource>,
    pub version: Option<String>,
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

struct NodeRuntimeState {
    status: NodeRuntimeStatus,
    node_path: Option<PathBuf>,
    npm_path: Option<PathBuf>,
    source: Option<NodeSource>,
    version: Option<String>,
}

pub struct NodeRuntimeManager {
    state: Mutex<NodeRuntimeState>,
}

impl NodeRuntimeManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(NodeRuntimeState {
                status: NodeRuntimeStatus::Unknown,
                node_path: None,
                npm_path: None,
                source: None,
                version: None,
            }),
        }
    }

    /// Acquire the Mutex, recovering from poison if a prior holder panicked.
    /// This prevents the entire app from crashing when an unrelated panic
    /// leaves the Mutex in a poisoned state.
    fn lock_state(&self) -> std::sync::MutexGuard<'_, NodeRuntimeState> {
        self.state.lock().unwrap_or_else(|poisoned| {
            log::warn!("[node-runtime] Mutex was poisoned, recovering");
            poisoned.into_inner()
        })
    }

    pub fn get_info(&self) -> NodeRuntimeInfo {
        let state = self.lock_state();
        NodeRuntimeInfo {
            status: state.status.clone(),
            node_path: state
                .node_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            npm_path: state
                .npm_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            source: state.source.clone(),
            version: state.version.clone(),
        }
    }

    pub fn get_node_path(&self) -> Result<PathBuf, String> {
        let state = self.lock_state();
        state
            .node_path
            .clone()
            .ok_or_else(|| "Node.js runtime not ready".to_string())
    }

    fn set_status(&self, status: NodeRuntimeStatus, app: &AppHandle) {
        let info = {
            let mut state = self.lock_state();
            state.status = status;
            NodeRuntimeInfo {
                status: state.status.clone(),
                node_path: state
                    .node_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                npm_path: state
                    .npm_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                source: state.source.clone(),
                version: state.version.clone(),
            }
        };
        let _ = app.emit("node-runtime-status", info);
    }

    fn set_ready(
        &self,
        node_path: PathBuf,
        npm_path: PathBuf,
        source: NodeSource,
        version: Option<String>,
        app: &AppHandle,
    ) {
        let info = {
            let mut state = self.lock_state();
            state.status = NodeRuntimeStatus::Ready {
                node_path: node_path.to_string_lossy().to_string(),
                source: source.clone(),
            };
            state.node_path = Some(node_path);
            state.npm_path = Some(npm_path);
            state.source = Some(source);
            state.version = version;
            NodeRuntimeInfo {
                status: state.status.clone(),
                node_path: state
                    .node_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                npm_path: state
                    .npm_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                source: state.source.clone(),
                version: state.version.clone(),
            }
        };
        let _ = app.emit("node-runtime-status", info);
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn node_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

/// Derive the npm path relative to the node directory.
///
/// For local Node installations, npm is normally in the same directory.
fn derive_npm_path(node_path: &Path) -> PathBuf {
    if let Some(parent) = node_path.parent() {
        if cfg!(target_os = "windows") {
            parent.join("npm.cmd")
        } else {
            parent.join("npm")
        }
    } else if cfg!(target_os = "windows") {
        PathBuf::from("npm.cmd")
    } else {
        PathBuf::from("npm")
    }
}

// ---------------------------------------------------------------------------
// System Node.js detection
// ---------------------------------------------------------------------------

/// Result of system Node.js detection.
enum SystemNodeResult {
    /// Node.js found and meets minimum version requirement.
    Found(PathBuf, PathBuf, String, NodeSource),
    /// Node.js found but version is too old.
    TooOld { version: String },
    /// Node.js not found at all.
    NotFound,
}

/// Detect system-installed Node.js >= 20 in PATH.
/// Returns `Found` with paths if a suitable version exists,
/// `TooOld` if Node.js is present but below minimum version,
/// or `NotFound` if not installed.
fn detect_system_node() -> SystemNodeResult {
    log::info!(
        "[node-runtime] detect_system_node: PATH_length={}",
        std::env::var("PATH").unwrap_or_default().len()
    );

    // Prefer an explicit local binary, then fall back to PATH discovery.
    let configured_path = std::env::var("BYTRO_NODE_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|path| {
            if path.is_dir() {
                path.join(node_binary_name())
            } else {
                path
            }
        });
    let configured = configured_path.is_some();
    let node_path = configured_path.or_else(|| {
        crate::sidecar::cli_tools::resolve_known_cli_path(node_binary_name()).or_else(|| {
            if cfg!(target_os = "windows") {
                crate::sidecar::cli_tools::resolve_known_cli_path("node")
            } else {
                None
            }
        })
    });

    let node_path = match node_path {
        Some(p) => {
            log::info!("[node-runtime] Found a local Node.js binary");
            p
        }
        None => {
            log::warn!("[node-runtime] compatible node path was not found");
            return SystemNodeResult::NotFound;
        }
    };

    // Run only the verified absolute path. The probe owns its child timeout
    // and forcibly reaps a hung executable before returning.
    let version_output = match crate::sidecar::cli_tools::run_verified_version_probe(
        &node_path,
        Duration::from_secs(3),
    ) {
        Ok(o) => o,
        Err(_) => {
            log::warn!("[node-runtime] Node.js version probe failed");
            return SystemNodeResult::NotFound;
        }
    };

    if !version_output.status.success() {
        log::warn!(
            "[node-runtime] Node.js --version exited with status {}",
            version_output.status
        );
        return SystemNodeResult::NotFound;
    }

    let Ok(version_str) = String::from_utf8(version_output.stdout) else {
        log::warn!("[node-runtime] Node.js returned a non-UTF-8 version");
        return SystemNodeResult::NotFound;
    };
    let version_str = version_str.trim().to_string();

    // 3. Parse version: "v20.18.1" -> major=20
    let major = match parse_node_major(&version_str) {
        Some(m) => m,
        None => {
            log::warn!("[node-runtime] Node.js returned an invalid version");
            return SystemNodeResult::NotFound;
        }
    };

    if major < MIN_SYSTEM_NODE_MAJOR {
        log::warn!(
            "[node-runtime] System node version {} (major={}) is too old. \
             Minimum required: v{}.x. Install a newer local Node.js runtime or set BYTRO_NODE_PATH.",
            version_str,
            major,
            MIN_SYSTEM_NODE_MAJOR
        );
        return SystemNodeResult::TooOld {
            version: version_str,
        };
    }

    let npm_path = derive_npm_path(&node_path);

    log::info!(
        "[node-runtime] Compatible local Node.js found ({})",
        version_str
    );

    SystemNodeResult::Found(
        node_path,
        npm_path,
        version_str,
        if configured {
            NodeSource::Configured
        } else {
            NodeSource::System
        },
    )
}

fn parse_node_major(version: &str) -> Option<u32> {
    if version.len() > 32 || version.lines().count() != 1 {
        return None;
    }
    let stripped = version.strip_prefix('v').unwrap_or(version);
    let parts = stripped.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    parts[0].parse().ok()
}

// ---------------------------------------------------------------------------
// Local runtime detection
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

pub async fn ensure_node_runtime_internal(
    app: &AppHandle,
    _proxy_url: Option<&str>,
) -> Result<NodeRuntimeInfo, String> {
    let info = detect_node_runtime_internal(app).await?;
    match &info.status {
        NodeRuntimeStatus::Ready { .. } => Ok(info),
        _ => Err(format!(
            "Node.js v{}.x or newer was not found. Install it locally, add it to PATH, or set BYTRO_NODE_PATH.",
            MIN_SYSTEM_NODE_MAJOR
        )),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_node_runtime(app: AppHandle) -> Result<NodeRuntimeInfo, String> {
    let manager = app.state::<NodeRuntimeManager>();
    Ok(manager.get_info())
}

#[tauri::command]
pub async fn ensure_node_runtime(
    app: AppHandle,
    proxy_url: Option<String>,
) -> Result<NodeRuntimeInfo, String> {
    ensure_node_runtime_internal(&app, proxy_url.as_deref()).await
}

/// Detect a compatible local Node.js runtime without any network access.
pub async fn detect_node_runtime_internal(app: &AppHandle) -> Result<NodeRuntimeInfo, String> {
    log::info!("[node-runtime] detect_node_runtime_internal invoked");
    let manager = app.state::<NodeRuntimeManager>();

    // Already ready → return immediately
    {
        let state = manager.lock_state();
        if matches!(state.status, NodeRuntimeStatus::Ready { .. }) {
            log::info!("[node-runtime] already ready, returning cached state");
            return Ok(manager.get_info());
        }
    }

    manager.set_status(NodeRuntimeStatus::Checking, app);

    // Local Node.js detection has a timeout to avoid hanging on broken binaries.
    let system_result = match tokio::time::timeout(
        Duration::from_secs(15),
        tokio::task::spawn_blocking(detect_system_node),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => {
            log::error!(
                "[node-runtime] detect: system node detection panicked: {}",
                e
            );
            SystemNodeResult::NotFound
        }
        Err(_) => {
            log::warn!("[node-runtime] detect: system node detection timed out after 15s");
            SystemNodeResult::NotFound
        }
    };

    match system_result {
        SystemNodeResult::Found(node_path, npm_path, version, source) => {
            log::info!("[node-runtime] detect: local node found ({})", version);
            manager.set_ready(node_path, npm_path, source, Some(version), app);
            return Ok(manager.get_info());
        }
        SystemNodeResult::TooOld { version } => {
            log::warn!(
                "[node-runtime] detect: system node {} too old (need v{}.x+)",
                version,
                MIN_SYSTEM_NODE_MAJOR
            );
            let _ = app.emit(
                "node-runtime-version-warning",
                serde_json::json!({
                    "found_version": version,
                    "min_required": format!("v{}.x", MIN_SYSTEM_NODE_MAJOR),
                    "message": format!(
                        "System Node.js {} is too old. Minimum required: v{}.x. \
                         Install a newer local runtime, add it to PATH, or set BYTRO_NODE_PATH.",
                        version, MIN_SYSTEM_NODE_MAJOR
                    )
                }),
            );
        }
        SystemNodeResult::NotFound => {}
    }

    log::info!("[node-runtime] detect: compatible local node not found");
    manager.set_status(NodeRuntimeStatus::Unknown, app);
    Ok(manager.get_info())
}

/// Tauri command wrapper for detect_node_runtime_internal.
#[tauri::command]
pub async fn detect_node_runtime(app: AppHandle) -> Result<NodeRuntimeInfo, String> {
    detect_node_runtime_internal(&app).await
}

#[tauri::command]
pub async fn get_node_runtime_status(app: AppHandle) -> Result<NodeRuntimeInfo, String> {
    let manager = app.state::<NodeRuntimeManager>();
    Ok(manager.get_info())
}
