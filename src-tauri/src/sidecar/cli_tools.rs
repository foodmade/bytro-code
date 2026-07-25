use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// CLI tools installation check
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CliToolStatus {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_command: String,
    /// Resolved binary path (e.g. "/usr/local/bin/node") when detected.
    pub path: Option<String>,
}

fn cli_runtime_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(crate::constants::APP_NAME);
    match std::fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Refusing non-directory CLI runtime path".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn cli_diagnostics_log_path() -> Result<std::path::PathBuf, String> {
    let dir = cli_runtime_dir()?.join("logs");
    match std::fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Refusing non-directory CLI log path".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(dir.join("cli-install.log"))
}

fn hash_output(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{:x}", digest)[..16].to_string()
}

fn summarize_output(output: &Output) -> String {
    let status = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    format!(
        "exit={} stdout_len={} stdout_sha256={} stderr_len={} stderr_sha256={}",
        status,
        output.stdout.len(),
        hash_output(&output.stdout),
        output.stderr.len(),
        hash_output(&output.stderr),
    )
}

fn append_cli_diag_at(path: &std::path::Path, line: &str) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Refusing non-regular CLI diagnostic log".to_string());
        }
    }

    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

fn append_cli_diag(message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] {}\n", timestamp, message);

    if let Ok(path) = cli_diagnostics_log_path() {
        let _ = append_cli_diag_at(&path, &line);
    }
}

/// Build a `std::process::Command` with a platform-appropriate hidden-window
/// flag (no terminal flash on Windows).
///
/// # IMPORTANT — stdio contract
/// Callers MUST explicitly set `.stdout(...)` and `.stderr(...)` on the
/// returned command according to their needs. The defaults set here
/// (`stdout=piped, stderr=null`) are convenience initial values; do not
/// assume they are sufficient for long-running processes.
///
/// In particular, if you wait on the child via a `try_wait()` polling loop,
/// you MUST drain any `Stdio::piped()` streams on a background thread —
/// otherwise the OS pipe buffer (≈4 KiB on Windows, 64 KiB on *nix) will
/// fill up and the child will block on `write`, causing the wait loop to
/// spin forever until the hard timeout kills it.
///
/// Keep stdout/stderr piped and drained consistently for every probe.
pub(crate) fn hidden_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn safe_cli_probe_environment(
    program: &str,
    environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    const SAFE_OS_KEYS: &[&str] = &[
        "SYSTEMROOT",
        "WINDIR",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
    ];
    let mut result: Vec<_> = environment
        .into_iter()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            SAFE_OS_KEYS
                .iter()
                .any(|safe| key.eq_ignore_ascii_case(safe))
        })
        .collect();
    let stem = std::path::Path::new(program)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(program)
        .to_ascii_lowercase();
    let mut force = |key: &str, value: &str| {
        result.push((
            std::ffi::OsString::from(key),
            std::ffi::OsString::from(value),
        ));
    };
    if stem.starts_with("claude") {
        force("DISABLE_AUTOUPDATER", "1");
        force("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
        force("DISABLE_TELEMETRY", "1");
        force("DISABLE_ERROR_REPORTING", "1");
        force("DISABLE_BUG_COMMAND", "1");
    } else if stem.starts_with("codex") {
        force("CODEX_DISABLE_AUTO_UPDATE", "1");
        force("CODEX_DISABLE_TELEMETRY", "1");
        force("CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED", "1");
        force("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "bytro-community");
        force("OTEL_SDK_DISABLED", "true");
        force("DO_NOT_TRACK", "1");
    }
    result
}

pub(crate) fn apply_safe_cli_probe_env(cmd: &mut Command, program: &str) {
    cmd.env_clear();
    cmd.envs(safe_cli_probe_environment(program, std::env::vars_os()));
}

fn verified_executable(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    let metadata = std::fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical)
}

fn executable_names(binary_name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if Path::new(binary_name).extension().is_some() {
            vec![binary_name.to_string()]
        } else {
            ["exe", "cmd", "bat", "com"]
                .into_iter()
                .map(|extension| format!("{binary_name}.{extension}"))
                .collect()
        }
    }
    #[cfg(not(windows))]
    {
        vec![binary_name.to_string()]
    }
}

fn resolve_known_cli_path_in(
    binary_name: &str,
    path_value: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    for directory in std::env::split_paths(path_value?) {
        if !directory.is_absolute() {
            continue;
        }
        for name in executable_names(binary_name) {
            if let Some(path) = verified_executable(&directory.join(name)) {
                return Some(path);
            }
        }
    }
    None
}

pub(crate) fn resolve_known_cli_path(binary_name: &str) -> Option<PathBuf> {
    resolve_known_cli_path_in(binary_name, std::env::var_os("PATH").as_deref())
}

pub(crate) fn run_verified_version_probe(
    program: &Path,
    timeout: Duration,
) -> Result<Output, String> {
    let executable = verified_executable(program)
        .ok_or_else(|| "CLI path is not a verified executable".to_string())?;
    let executable_text = executable
        .to_str()
        .ok_or_else(|| "CLI path is not valid Unicode".to_string())?;
    let mut command = hidden_command(executable_text);
    apply_safe_cli_probe_env(&mut command, executable_text);
    command
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        format!(
            "CLI version probe failed to start: os_code={:?}",
            error.raw_os_error()
        )
    })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "CLI version probe stdout was unavailable".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "CLI version probe stderr was unavailable".to_string())?;
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                append_cli_diag("CLI version probe timed out and was terminated");
                return Err("CLI version probe timed out".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "CLI version probe wait failed: os_code={:?}",
                    error.raw_os_error()
                ));
            }
        }
    };
    let output = Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    };
    append_cli_diag(&format!(
        "CLI version probe result: {}",
        summarize_output(&output)
    ));
    Ok(output)
}

// ---------------------------------------------------------------------------
// Git Bash local detection (Windows only)
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub(crate) fn find_git_bash() -> Option<String> {
    for key in ["BYTRO_GIT_BASH_PATH", "CLAUDE_CODE_GIT_BASH_PATH"] {
        if let Ok(path) = std::env::var(key) {
            if let Some(path) = verified_executable(Path::new(&path)) {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }

    resolve_known_cli_path("bash.exe")
        .filter(|candidate| {
            let lower = candidate.to_string_lossy().to_ascii_lowercase();
            !lower.contains("system32")
                && !lower.contains("syswow64")
                && !lower.contains("wsl")
                && (lower.contains("git")
                    || candidate
                        .parent()
                        .is_some_and(|parent| parent.join("git.exe").is_file()))
        })
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(windows)]
fn is_git_bash_available() -> (bool, Option<String>) {
    let path = find_git_bash();
    (path.is_some(), path)
}

/// Check whether a known CLI binary exists by inspecting PATH entries only.
/// Detection never executes the discovered file.
/// Returns (installed, version, resolved_path).
fn is_cli_installed(binary_name: &str) -> (bool, Option<String>, Option<String>) {
    let resolved_path =
        resolve_known_cli_path(binary_name).map(|path| path.to_string_lossy().to_string());
    (resolved_path.is_some(), None, resolved_path)
}

#[tauri::command]
pub async fn check_cli_tools(_app: AppHandle) -> Result<Vec<CliToolStatus>, String> {
    tokio::task::spawn_blocking(move || {
        extend_process_path_with_known_dirs();

        let detect = |name: &str, binary: &str, env_var: &str, hint: &str| {
            let configured_path = std::env::var(env_var)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .and_then(|value| {
                    let path = PathBuf::from(&value);
                    if path.is_file() {
                        verified_executable(&path).map(|path| path.to_string_lossy().to_string())
                    } else if path.is_dir() {
                        find_binary_in_dir(&value, binary)
                    } else {
                        None
                    }
                });

            let (installed, version, path) = if let Some(path) = configured_path {
                (true, None, Some(path))
            } else {
                is_cli_installed(binary)
            };

            CliToolStatus {
                name: name.to_string(),
                installed,
                version,
                install_command: hint.to_string(),
                path,
            }
        };

        let node_binary = if cfg!(windows) { "node.exe" } else { "node" };
        let results = vec![
            detect(
                "Node.js",
                node_binary,
                "BYTRO_NODE_PATH",
                "Install Node.js locally, add it to PATH, or set BYTRO_NODE_PATH",
            ),
            detect(
                "Codex CLI",
                "codex",
                "CODEX_CLI_PATH",
                "Install Codex locally, add it to PATH, or set CODEX_CLI_PATH",
            ),
            detect(
                "Claude CLI",
                "claude",
                "CLAUDE_CLI_PATH",
                "Install Claude locally, add it to PATH, or set CLAUDE_CLI_PATH",
            ),
            detect(
                "Gemini CLI",
                "gemini",
                "GEMINI_CLI_PATH",
                "Install Gemini locally, add it to PATH, or set GEMINI_CLI_PATH",
            ),
        ];

        #[cfg(windows)]
        let results = {
            let mut results = results;
            let (installed, path) = is_git_bash_available();
            results.push(CliToolStatus {
                name: "Git Bash".to_string(),
                installed,
                version: None,
                install_command: "Install Git for Windows locally or set BYTRO_GIT_BASH_PATH"
                    .to_string(),
                path,
            });
            results
        };

        results
    })
    .await
    .map_err(|e| format!("Check task panicked: {}", e))
}

/// Compatibility no-op for callers that historically requested PATH
/// augmentation. Community Edition only trusts the process' original PATH
/// and explicit `*_CLI_PATH` / `BYTRO_NODE_PATH` settings.
pub(crate) fn extend_process_path_with_known_dirs() {}

pub(crate) fn build_path_with_explicit_cli_dirs(
    original_path: Option<&std::ffi::OsStr>,
    configured_paths: impl IntoIterator<Item = std::path::PathBuf>,
) -> Result<std::ffi::OsString, String> {
    let mut paths: Vec<std::path::PathBuf> = configured_paths
        .into_iter()
        .filter_map(|path| {
            if path.is_dir() {
                Some(path)
            } else if path.is_file() {
                path.parent().map(std::path::Path::to_path_buf)
            } else {
                None
            }
        })
        .collect();
    if let Some(original) = original_path {
        paths.extend(std::env::split_paths(original));
    }
    paths.dedup();
    std::env::join_paths(paths).map_err(|error| error.to_string())
}

// Detect CLI executable paths
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CliPathInfo {
    pub name: String,
    pub path: Option<String>,
}

/// Resolve a known CLI from absolute PATH entries without executing helpers.
fn resolve_cli_path_via_where(binary_name: &str) -> Option<String> {
    resolve_known_cli_path(binary_name).map(|path| path.to_string_lossy().to_string())
}

/// Look for a binary (with common extensions on Windows) in a specific directory.
fn find_binary_in_dir(dir: &str, binary_name: &str) -> Option<String> {
    let dir_path = Path::new(dir);
    if !dir_path.is_absolute() || !dir_path.is_dir() {
        return None;
    }

    for name in executable_names(binary_name) {
        if let Some(candidate) = verified_executable(&dir_path.join(name)) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    None
}

/// Resolve a CLI path from the process' original PATH only.
fn resolve_cli_path(binary_name: &str) -> Option<String> {
    resolve_cli_path_via_where(binary_name)
}

#[tauri::command]
pub async fn detect_cli_paths() -> Result<Vec<CliPathInfo>, String> {
    tokio::task::spawn_blocking(move || {
        extend_process_path_with_known_dirs();

        let binaries = [
            ("gemini", "gemini", "GEMINI_CLI_PATH"),
            ("codex", "codex", "CODEX_CLI_PATH"),
            ("claude", "claude", "CLAUDE_CLI_PATH"),
        ];

        let mut results: Vec<CliPathInfo> = binaries
            .iter()
            .map(|(name, binary, env_var)| CliPathInfo {
                name: name.to_string(),
                path: std::env::var(env_var)
                    .ok()
                    .and_then(|value| {
                        verified_executable(Path::new(&value))
                            .map(|path| path.to_string_lossy().to_string())
                    })
                    .or_else(|| resolve_cli_path(binary)),
            })
            .collect();

        // Node.js: detect via where/which
        let node_binary = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        results.push(CliPathInfo {
            name: "nodejs".to_string(),
            path: std::env::var("BYTRO_NODE_PATH")
                .ok()
                .and_then(|value| {
                    verified_executable(Path::new(&value))
                        .map(|path| path.to_string_lossy().to_string())
                })
                .or_else(|| resolve_cli_path_via_where(node_binary)),
        });

        // Git Bash: Windows only, reuse existing find_git_bash()
        #[cfg(target_os = "windows")]
        {
            results.push(CliPathInfo {
                name: "gitBash".to_string(),
                path: find_git_bash(),
            });
        }

        results
    })
    .await
    .map_err(|e| format!("Detection task panicked: {}", e))
}

#[cfg(test)]
mod tests {
    use super::{
        append_cli_diag_at, build_path_with_explicit_cli_dirs, resolve_known_cli_path_in,
        run_verified_version_probe, safe_cli_probe_environment, summarize_output,
    };

    #[test]
    fn explicit_cli_path_builder_does_not_guess_sibling_directories() {
        let root = tempfile::tempdir().unwrap();
        let explicit_dir = root.path().join("explicit");
        let guessed_dir = root.path().join("untrusted-sibling");
        std::fs::create_dir_all(&explicit_dir).unwrap();
        std::fs::create_dir_all(&guessed_dir).unwrap();
        let executable = explicit_dir.join(if cfg!(windows) { "codex.cmd" } else { "codex" });
        std::fs::write(&executable, b"shim").unwrap();
        let original_dir = root.path().join("original");
        std::fs::create_dir_all(&original_dir).unwrap();
        let original = std::env::join_paths([&original_dir]).unwrap();

        let result =
            build_path_with_explicit_cli_dirs(Some(original.as_os_str()), [executable]).unwrap();
        let entries: Vec<_> = std::env::split_paths(&result).collect();

        assert_eq!(entries, vec![explicit_dir, original_dir]);
        assert!(!entries.contains(&guessed_dir));
    }

    #[test]
    fn cli_version_probe_env_excludes_caller_secrets_and_forces_safety_flags() {
        let source = [
            ("PATH", "/safe/bin"),
            ("HOME", "/safe/home"),
            ("OPENAI_API_KEY", "other-provider-secret"),
            ("BYTRO_MCP_SECRET_0", "mcp-secret"),
            ("DISABLE_AUTOUPDATER", "0"),
            ("DISABLE_TELEMETRY", "0"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()));
        let env = safe_cli_probe_environment("claude", source);
        let env: std::collections::HashMap<_, _> = env.into_iter().collect();

        assert!(!env.contains_key(&std::ffi::OsString::from("PATH")));
        assert!(!env.contains_key(&std::ffi::OsString::from("HOME")));
        assert!(!env.contains_key(&std::ffi::OsString::from("OPENAI_API_KEY")));
        assert!(!env.contains_key(&std::ffi::OsString::from("BYTRO_MCP_SECRET_0")));
        assert_eq!(
            env.get(&std::ffi::OsString::from("DISABLE_AUTOUPDATER"))
                .unwrap(),
            "1"
        );
        assert_eq!(
            env.get(&std::ffi::OsString::from("DISABLE_TELEMETRY"))
                .unwrap(),
            "1"
        );
    }

    #[cfg(unix)]
    #[test]
    fn hostile_path_discovery_never_executes_the_candidate() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let candidate = root.path().join("node");
        let marker = root.path().join("executed");
        std::fs::write(
            &candidate,
            format!("#!/bin/sh\nprintf executed > '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path_value = std::env::join_paths([root.path()]).unwrap();

        let resolved = resolve_known_cli_path_in("node", Some(path_value.as_os_str()));

        assert_eq!(resolved, std::fs::canonicalize(candidate).ok());
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn hanging_version_probe_is_killed_and_reaped() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let candidate = root.path().join("node");
        std::fs::write(&candidate, "#!/bin/sh\nwhile :; do :; done\n").unwrap();
        std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o700)).unwrap();
        let started = std::time::Instant::now();

        let error = run_verified_version_probe(&candidate, std::time::Duration::from_millis(100))
            .expect_err("hanging child must time out");

        assert_eq!(error, "CLI version probe timed out");
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn diagnostics_store_only_hashes_in_private_nofollow_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::os::unix::process::ExitStatusExt;

        let root = tempfile::tempdir().unwrap();
        let log_path = root.path().join("cli-install.log");
        let sentinel = "username-and-path-sentinel";
        let summary = summarize_output(&std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: sentinel.as_bytes().to_vec(),
            stderr: b"stderr-sentinel".to_vec(),
        });
        assert!(!summary.contains(sentinel));
        assert!(summary.contains("stdout_len="));
        assert!(summary.contains("stdout_sha256="));

        append_cli_diag_at(&log_path, &summary).unwrap();
        assert_eq!(
            std::fs::metadata(&log_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!std::fs::read_to_string(&log_path)
            .unwrap()
            .contains(sentinel));

        let outside = root.path().join("outside.log");
        std::fs::write(&outside, b"outside").unwrap();
        std::fs::remove_file(&log_path).unwrap();
        symlink(&outside, &log_path).unwrap();
        assert!(append_cli_diag_at(&log_path, "blocked").is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    }
}
