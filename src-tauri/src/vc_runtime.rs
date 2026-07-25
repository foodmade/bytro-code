//! Visual C++ Redistributable detection for local Windows installations.
//!
//! Codex and other MSVC binaries may require `vcruntime140.dll` and
//! `msvcp140.dll`. Community Edition never downloads or launches an
//! installer; when the runtime is missing it returns an official Microsoft
//! download link for the user to handle manually.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Default, Serialize, Deserialize)]
struct LocalState {
    installed: bool,
    version: Option<String>,
    installer_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct VcRuntimeStatus {
    /// Whether VC Runtime is present (always true on non-Windows).
    pub installed: bool,
    /// Whether this platform actually needs the runtime (false on non-Windows).
    pub platform_required: bool,
    /// Detected version string from the registry (e.g. "v14.44.35211.00").
    pub version: Option<String>,
    /// How the installed check was performed: "registry+dll", "skipped", "none".
    pub detection_method: String,
}

pub struct VcRuntimeManager {
    state: Mutex<LocalState>,
}

impl VcRuntimeManager {
    pub fn new() -> Self {
        let persisted = load_local_state().unwrap_or_default();
        Self {
            state: Mutex::new(persisted),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, LocalState> {
        self.state.lock().unwrap_or_else(|poisoned| {
            log::warn!("[vc-runtime] Mutex was poisoned, recovering");
            poisoned.into_inner()
        })
    }
}

fn vc_runtime_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::constants::APP_BUNDLE_ID)
        .join("vc-runtime")
}

fn state_file_path() -> PathBuf {
    vc_runtime_data_dir().join("state.json")
}

fn load_local_state() -> Option<LocalState> {
    let path = state_file_path();
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_local_state(state: &LocalState) {
    let path = state_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(&path, json);
    }
}

/// Detect installation state. Returns `(installed, version_opt, method)`.
fn detect_vc_runtime() -> (bool, Option<String>, String) {
    #[cfg(not(target_os = "windows"))]
    {
        (true, None, "skipped".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        detect_vc_runtime_windows()
    }
}

#[cfg(target_os = "windows")]
fn detect_vc_runtime_windows() -> (bool, Option<String>, String) {
    let registry_ok = read_vc_runtime_registry();
    let dlls_ok = check_vc_runtime_dlls();
    let installed = registry_ok.is_some() && dlls_ok;
    let version = registry_ok.clone();

    log::info!(
        "[vc-runtime] detect: registry={:?} dlls={} => installed={}",
        registry_ok,
        dlls_ok,
        installed
    );

    (installed, version, "registry+dll".to_string())
}

/// Read `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64`.
#[cfg(target_os = "windows")]
fn read_vc_runtime_registry() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let key = r"HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64";

    let output = Command::new("reg.exe")
        .args(["query", key, "/v", "Installed"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let installed = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("Installed") {
                trimmed.split_whitespace().nth(2)
            } else {
                None
            }
        })
        .any(|value| value == "0x1" || value == "1");
    if !installed {
        return None;
    }

    let version = Command::new("reg.exe")
        .args(["query", key, "/v", "Version"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| {
                    let trimmed = line.trim();
                    if trimmed.starts_with("Version") {
                        trimmed.split_whitespace().nth(2).map(str::to_string)
                    } else {
                        None
                    }
                })
        });

    Some(version.unwrap_or_else(|| "installed".to_string()))
}

#[cfg(target_os = "windows")]
fn check_vc_runtime_dlls() -> bool {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let system32 = PathBuf::from(system_root).join("System32");
    system32.join("vcruntime140.dll").is_file() && system32.join("msvcp140.dll").is_file()
}

/// Check the current installation status without side effects.
#[tauri::command]
pub async fn check_vc_runtime() -> Result<VcRuntimeStatus, String> {
    let platform_required = cfg!(target_os = "windows");
    if !platform_required {
        return Ok(VcRuntimeStatus {
            installed: true,
            platform_required: false,
            version: None,
            detection_method: "skipped".to_string(),
        });
    }

    let (installed, version, detection_method) = detect_vc_runtime();
    Ok(VcRuntimeStatus {
        installed,
        platform_required,
        version,
        detection_method,
    })
}

/// Verify the local runtime and provide manual installation guidance if absent.
#[tauri::command]
pub async fn ensure_vc_runtime(
    app: AppHandle,
    _proxy_url: Option<String>,
) -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        let _ = app.emit(
            "vc-runtime-status",
            serde_json::json!({ "status": "skipped" }),
        );
        return Ok("skipped: not Windows".to_string());
    }

    let _ = app.emit(
        "vc-runtime-status",
        serde_json::json!({ "status": "checking" }),
    );
    let (installed, version, _) = detect_vc_runtime();
    if installed {
        if let Some(state_mgr) = app_state::<VcRuntimeManager>(&app) {
            let mut state = state_mgr.lock_state();
            state.installed = true;
            state.version = version.clone();
            save_local_state(&state);
        }

        let _ = app.emit(
            "vc-runtime-status",
            serde_json::json!({ "status": "ready", "version": version }),
        );
        return Ok(format!("already installed: {:?}", version));
    }

    let message = "Microsoft Visual C++ Redistributable 2015-2022 (x64) is required. Install it manually from https://aka.ms/vs/17/release/vc_redist.x64.exe and retry.";
    let _ = app.emit(
        "vc-runtime-status",
        serde_json::json!({ "status": "manual-install-required", "error": message }),
    );
    Err(message.to_string())
}

fn app_state<T: Send + Sync + 'static>(app: &AppHandle) -> Option<tauri::State<'_, T>> {
    use tauri::Manager;
    app.try_state::<T>()
}
