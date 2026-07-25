use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Serialize)]
pub enum DevServerStatus {
    Idle,
    Starting,
    Running,
    Stopping,
    Error(String),
}

#[derive(Serialize)]
pub struct DevServerInfo {
    pub status: DevServerStatus,
    pub port: u16,
    pub project_path: Option<String>,
}

/// Internal state protected by a single mutex to ensure atomic updates.
struct DevServerInner {
    child: Option<Child>,
    status: DevServerStatus,
    port: u16,
    project_path: Option<String>,
}

pub struct DevServerState {
    inner: Mutex<DevServerInner>,
}

impl Default for DevServerState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DevServerInner {
                child: None,
                status: DevServerStatus::Idle,
                port: 5173,
                project_path: None,
            }),
        }
    }
}

/// Kill the process and its entire process tree on Windows.
/// On non-Windows, just send a kill signal.
fn kill_process_tree(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(pid) = child.id() {
            // Ask the current-run process tree to exit first. The Child handle
            // is checked before and after this request so a stale on-disk PID
            // can never target an unrelated process.
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .status();
            std::thread::sleep(std::time::Duration::from_millis(250));
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.start_kill();
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(pid) = child.id() {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", "--", &format!("-{}", pid)])
                .status();
            std::thread::sleep(std::time::Duration::from_millis(250));
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", "--", &format!("-{}", pid)])
                    .status();
            }
        } else {
            let _ = child.start_kill();
        }
    }
}

impl DevServerState {
    /// Kill the dev server child process if it is currently running.
    /// Called from the window-close handler so Vite doesn't survive app exit.
    pub fn kill_if_running(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(mut child) = inner.child.take() {
                kill_process_tree(&mut child);
            }
            inner.status = DevServerStatus::Idle;
            inner.project_path = None;
        }
    }
}

impl Drop for DevServerState {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(mut child) = inner.child.take() {
                kill_process_tree(&mut child);
            }
        }
    }
}

/// Strip ANSI escape sequences (e.g. \x1b[32m, \x1b[1m) from a string.
/// Vite outputs colored text with ANSI codes that interfere with port parsing.
fn strip_ansi_codes(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip ESC[...m sequences (CSI sequences ending with a letter)
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Determine whether a stderr line from Vite represents a real error
/// (as opposed to a harmless warning, deprecation notice, or HMR info).
fn is_real_vite_error(line: &str) -> bool {
    let lower = line.to_lowercase();

    // Definite error patterns
    let error_patterns = [
        "error",
        "failed to",
        "syntaxerror",
        "typeerror",
        "referenceerror",
        "cannot find module",
        "module not found",
        "enoent",
        "eacces",
        "segmentation fault",
        "fatal",
        "unhandled",
        "panic",
        // Vite-specific build errors
        "pre-transform error",
        "transform error",
        "build error",
        "[plugin:",
        "does not exist",
        "is not exported",
    ];

    // Patterns that look like errors but aren't (skip these)
    let false_positive_patterns = [
        "deprecationwarning",
        "experimentalwarning",
        "punycode",
        "warning:",
        "warn:",
        "(use `node --trace",
        "use `--node-modules-dir",
        "npm warn",
        "npm notice",
        // Transient @apply errors: AI writes CSS before tailwind.config.js is updated.
        // These self-resolve once the config is written; not real errors.
        "class does not exist",
    ];

    // If it matches a false positive pattern, it's not a real error
    for fp in &false_positive_patterns {
        if lower.contains(fp) {
            return false;
        }
    }

    // Check for real error patterns
    for pattern in &error_patterns {
        if lower.contains(pattern) {
            return true;
        }
    }

    false
}

/// Extract port from Vite's "Local:" output line.
/// Matches patterns like: "  ➜  Local:   http://localhost:5173/"
/// Strips ANSI color codes first since Vite outputs colored text.
fn extract_port_from_vite_output(line: &str) -> Option<u16> {
    let clean = strip_ansi_codes(line);
    if !clean.contains("Local:") && !clean.contains("localhost:") {
        return None;
    }
    // Find "localhost:" and parse the port number after it
    let marker = "localhost:";
    let start = clean.find(marker)? + marker.len();
    let rest = &clean[start..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

#[tauri::command]
pub async fn start_dev_server(
    project_path: String,
    state: State<'_, DevServerState>,
    app: AppHandle,
) -> Result<u16, String> {
    // Stop existing process first (kills entire process tree)
    {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = inner.child.take() {
            kill_process_tree(&mut child);
        }
        inner.status = DevServerStatus::Starting;
        inner.project_path = Some(project_path.clone());
        inner.port = 5173;
    }

    // Ensure PATH includes Node.js
    crate::sidecar::cli_tools::extend_process_path_with_known_dirs();

    // Detect package manager
    let project = PathBuf::from(&project_path);
    let pm = if project.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if project.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    };

    #[cfg(windows)]
    let node_exe = crate::preview::project_init::find_pm_cli("npm")
        .map(|(exe, _)| exe)
        .unwrap_or_else(|| "node".to_string());

    #[cfg(not(windows))]
    let node_exe = "node".to_string();

    if let Err(error) = crate::preview::project_init::ensure_preview_dependencies_before_start(
        &app, pm, &node_exe, &project,
    )
    .await
    {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.status = DevServerStatus::Error(error.clone());
        return Err(error);
    }

    let _ = app.emit("vite-log", &format!("Starting {} run dev...", pm));

    // Build command: on Windows, run vite.js directly via node.exe.
    // This avoids the cmd.exe subprocess chain entirely — cmd.exe + CREATE_NO_WINDOW
    // causes silent failures in GUI processes (zero output, immediate exit).
    let mut cmd;

    #[cfg(windows)]
    let mut direct_node = false;

    #[cfg(windows)]
    {
        let vite_bin = project.join("node_modules/vite/bin/vite.js");
        if vite_bin.exists() {
            // Best path: run vite.js directly, no cmd.exe in the chain at all
            let _ = app.emit(
                "vite-log",
                &format!("[debug] Running: {} {}", node_exe, vite_bin.display()),
            );
            cmd = Command::new(&node_exe);
            cmd.arg(vite_bin.to_string_lossy().as_ref());
            direct_node = true;
        } else {
            // Fallback: npm run dev via cmd.exe (may show console window)
            let _ = app.emit(
                "vite-log",
                &format!("[debug] Fallback: cmd /C {} run dev", pm),
            );
            cmd = Command::new("cmd");
            cmd.args(["/C", pm, "run", "dev"]);
        }
    }

    #[cfg(not(windows))]
    {
        cmd = Command::new(pm);
        cmd.args(["run", "dev"]);
        cmd.process_group(0);
    }

    cmd.current_dir(&project_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Hide console window on Windows — ONLY safe when running node.exe directly.
    // DO NOT use with cmd.exe fallback (causes silent failure).
    #[cfg(windows)]
    if direct_node {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.status = DevServerStatus::Error(e.to_string());
        format!("Failed to start Vite: {}", e)
    })?;
    let (port_tx, port_rx) = tokio::sync::oneshot::channel::<u16>();

    // Stream stdout and detect ready port
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            let mut port_tx = Some(port_tx);
            while let Ok(Some(line)) = lines.next_line().await {
                let raw = line.trim_end_matches('\r').to_string();
                let clean = strip_ansi_codes(&raw);
                let _ = app_clone.emit("vite-log", &clean);
                // Detect Vite's "Local:" line to extract actual port
                if port_tx.is_some() {
                    if let Some(detected) = extract_port_from_vite_output(&raw) {
                        if let Some(tx) = port_tx.take() {
                            let _ = tx.send(detected);
                        }
                    }
                }
            }
        });
    }

    // Stream stderr — classify as error or log based on content.
    // Vite writes warnings, deprecation notices, and HMR info to stderr
    // that are NOT real errors. Only emit as "vite-error" when it looks
    // like a genuine build/runtime error.
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let raw = line.trim_end_matches('\r').to_string();
                let clean = strip_ansi_codes(&raw);
                if clean.trim().is_empty() {
                    continue;
                }
                if is_real_vite_error(&clean) {
                    let _ = app_clone.emit("vite-error", &clean);
                } else {
                    let _ = app_clone.emit("vite-log", &format!("[stderr] {}", clean));
                }
            }
        });
    }

    // Store child process before waiting for port
    state.inner.lock().unwrap_or_else(|e| e.into_inner()).child = Some(child);

    // Wait for port detection from stdout
    let actual_port = match tokio::time::timeout(std::time::Duration::from_secs(30), port_rx).await
    {
        Ok(Ok(port)) => port,
        Ok(Err(_)) => {
            // Channel closed — Vite process likely exited before printing port
            let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut child) = inner.child.take() {
                kill_process_tree(&mut child);
            }
            inner.status = DevServerStatus::Error("Vite exited before printing port".into());
            return Err("Vite output channel closed unexpectedly".to_string());
        }
        Err(_) => {
            // 30-second timeout — kill the orphan process
            let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut child) = inner.child.take() {
                kill_process_tree(&mut child);
            }
            inner.status = DevServerStatus::Error("Vite failed to start within 30 seconds".into());
            return Err("Vite failed to start within 30 seconds".to_string());
        }
    };

    {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.port = actual_port;
        inner.status = DevServerStatus::Running;
    }
    let _ = app.emit(
        "vite-log",
        &format!("Vite ready at http://localhost:{}", actual_port),
    );
    Ok(actual_port)
}

#[tauri::command]
pub async fn stop_dev_server(state: State<'_, DevServerState>) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.status = DevServerStatus::Stopping;
    if let Some(mut child) = inner.child.take() {
        kill_process_tree(&mut child);
    }
    inner.status = DevServerStatus::Idle;
    inner.project_path = None;
    Ok(())
}

#[tauri::command]
pub async fn get_dev_server_status(
    state: State<'_, DevServerState>,
) -> Result<DevServerInfo, String> {
    let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    Ok(DevServerInfo {
        status: inner.status.clone(),
        port: inner.port,
        project_path: inner.project_path.clone(),
    })
}

#[cfg(test)]
mod process_safety_tests {
    use super::*;

    #[test]
    fn default_state_never_adopts_or_terminates_a_cross_restart_pid() {
        let state = DevServerState::default();
        let inner = state.inner.lock().unwrap();
        assert!(inner.child.is_none());
        assert!(matches!(inner.status, DevServerStatus::Idle));

        let source = include_str!("dev_server.rs");
        let persisted_pid_marker = ["vite", ".pid"].concat();
        let stale_killer_name = ["kill", "_stale_pid"].concat();
        assert!(!source.contains(&persisted_pid_marker));
        assert!(!source.contains(&stale_killer_name));
    }
}

#[tauri::command]
pub async fn restart_dev_server(
    project_path: String,
    state: State<'_, DevServerState>,
    app: AppHandle,
) -> Result<u16, String> {
    stop_dev_server(state.clone()).await?;
    start_dev_server(project_path, state, app).await
}
