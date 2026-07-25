use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct OllamaLocalModel {
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub modified_at: String,
    #[serde(default)]
    pub digest: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct OllamaCloudModel {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pull_count: Option<u64>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct OllamaPullProgress {
    pub model: String,
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub percent: Option<f64>,
    /// Download speed in bytes per second
    pub speed: Option<u64>,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Build a `std::process::Command` with a platform-appropriate hidden-window
/// flag (no terminal flash on Windows).
///
/// # IMPORTANT — stdio contract
/// Callers MUST explicitly set `.stdout(...)` and `.stderr(...)` on the
/// returned command according to their needs. The defaults set here
/// (`stdout=piped, stderr=piped`) are convenience initial values; do not
/// assume they are sufficient for long-running processes.
///
/// In particular, if you wait on the child via a `try_wait()` polling loop,
/// you MUST drain any `Stdio::piped()` streams on a background thread —
/// otherwise the OS pipe buffer (≈4 KiB on Windows, 64 KiB on *nix) will
/// fill up and the child will block on `write`, causing the wait loop to
/// spin forever until the hard timeout kills it.
///
/// Keep stdout/stderr handling explicit for each local process invocation.
fn hidden_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn validate_proxy_url(url: &str) -> Result<(), String> {
    if url.chars().any(char::is_control) {
        return Err(public_ollama_error("Invalid proxy protocol", url, None));
    }
    let parsed =
        url::Url::parse(url).map_err(|_| public_ollama_error("Invalid proxy URL", url, None))?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5")
        || parsed.host_str().is_none()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(public_ollama_error("Invalid proxy URL", url, None));
    }
    Ok(())
}

fn build_client(proxy_url: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder().timeout(std::time::Duration::from_secs(10));
    if let Some(proxy) = proxy_url {
        let trimmed = proxy.trim();
        if !trimmed.is_empty() {
            validate_proxy_url(trimmed)?;
            let p = reqwest::Proxy::all(trimmed).map_err(|error| {
                public_ollama_error("Invalid proxy URL", &error.to_string(), None)
            })?;
            builder = builder.proxy(p);
        }
    }
    builder.build().map_err(|error| {
        public_ollama_error(
            "Ollama HTTP client could not be created",
            &error.to_string(),
            None,
        )
    })
}

fn public_ollama_error(category: &str, detail: &str, status: Option<u16>) -> String {
    let digest = Sha256::digest(detail.as_bytes());
    log::warn!(
        "[ollama-network] category={} status={} len={} sha256={:x}",
        category,
        status
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string()),
        detail.len(),
        digest
    );
    let diagnostic_id = format!("{digest:x}").chars().take(12).collect::<String>();
    match status {
        Some(status) => format!("{category} (HTTP {status}, diagnosticId: {diagnostic_id})"),
        None => format!("{category} (diagnosticId: {diagnostic_id})"),
    }
}

fn resolve_base_url(base_url: Option<&str>) -> Result<String, String> {
    let candidate = base_url
        .filter(|s| !s.is_empty())
        .unwrap_or("http://localhost:11434");
    let parsed = url::Url::parse(candidate)
        .map_err(|_| public_ollama_error("Invalid Ollama Base URL", candidate, None))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(public_ollama_error(
            "Invalid Ollama Base URL",
            candidate,
            None,
        ));
    }

    Ok(candidate
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string())
}

fn public_pull_status(status: &str) -> &'static str {
    let normalized = status.to_ascii_lowercase();
    if normalized.contains("success") || normalized.contains("complete") {
        "complete"
    } else if normalized.contains("manifest") {
        "pulling manifest"
    } else if normalized.contains("verif") {
        "verifying model"
    } else if normalized.contains("writ") {
        "writing model"
    } else {
        "downloading model"
    }
}

fn managed_ollama_process() -> &'static tokio::sync::Mutex<Option<tokio::process::Child>> {
    static PROCESS: OnceLock<tokio::sync::Mutex<Option<tokio::process::Child>>> = OnceLock::new();
    PROCESS.get_or_init(|| tokio::sync::Mutex::new(None))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Check whether Ollama is installed and running.
#[tauri::command]
pub async fn check_ollama_status() -> Result<OllamaStatus, String> {
    let (installed, version, path) = tokio::task::spawn_blocking(|| {
        #[cfg(windows)]
        let detect_cmd = "where.exe";
        #[cfg(not(windows))]
        let detect_cmd = "which";

        let mut cmd = hidden_command(detect_cmd);
        cmd.arg("ollama");

        match cmd.output() {
            Ok(output) if output.status.success() => {
                let raw = String::from_utf8_lossy(&output.stdout);
                let path = raw.lines().next().map(|s| s.trim().to_string());

                // Get version
                let version = {
                    let mut vcmd = hidden_command("ollama");
                    vcmd.arg("--version");
                    match vcmd.output() {
                        Ok(vo) if vo.status.success() => {
                            let v = String::from_utf8_lossy(&vo.stdout);
                            let trimmed = v.trim().to_string();
                            if trimmed.is_empty() {
                                None
                            } else {
                                Some(trimmed)
                            }
                        }
                        _ => None,
                    }
                };

                (true, version, path)
            }
            _ => (false, None, None),
        }
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?;

    if !installed {
        return Ok(OllamaStatus {
            installed: false,
            running: false,
            version: None,
            path: None,
        });
    }

    // Probe if Ollama API server is running
    let running = match Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => client
            .get("http://localhost:11434/api/tags")
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false),
        Err(_) => false,
    };

    Ok(OllamaStatus {
        installed,
        running,
        version,
        path,
    })
}

/// List locally installed Ollama models.
#[tauri::command]
pub async fn ollama_list_local_models(
    base_url: Option<String>,
) -> Result<Vec<OllamaLocalModel>, String> {
    let url = format!("{}/api/tags", resolve_base_url(base_url.as_deref())?);
    let client = build_client(None)?;

    let resp = client.get(&url).send().await.map_err(|error| {
        public_ollama_error("Ollama connection failed", &error.to_string(), None)
    })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(public_ollama_error(
            "Ollama model list request failed",
            &body,
            Some(status),
        ));
    }

    #[derive(Deserialize)]
    struct TagsResponse {
        models: Vec<OllamaLocalModel>,
    }

    let data: TagsResponse = resp.json().await.map_err(|error| {
        public_ollama_error(
            "Ollama model list response was invalid",
            &error.to_string(),
            None,
        )
    })?;

    Ok(data.models)
}

/// Filter models reported by the user's local Ollama service.
#[tauri::command]
pub async fn ollama_search_models(
    query: String,
    _proxy_url: Option<String>,
    _mirror_url: Option<String>,
) -> Result<Vec<OllamaCloudModel>, String> {
    let query = query.trim().to_ascii_lowercase();
    let models = ollama_list_local_models(None)
        .await?
        .into_iter()
        .filter(|model| {
            query.is_empty()
                || model.name.to_ascii_lowercase().contains(&query)
                || model.model.to_ascii_lowercase().contains(&query)
        })
        .map(|model| OllamaCloudModel {
            name: if model.name.is_empty() {
                model.model
            } else {
                model.name
            },
            description: String::new(),
            tags: Vec::new(),
            pull_count: None,
            updated_at: if model.modified_at.is_empty() {
                None
            } else {
                Some(model.modified_at)
            },
        })
        .collect();

    Ok(models)
}

/// Internal pull implementation (separated for retry logic).
async fn pull_model_inner(
    app: &AppHandle,
    model: &str,
    base_url: Option<&str>,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::time::Instant;

    let url = format!("{}/api/pull", resolve_base_url(base_url)?);

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|error| {
            public_ollama_error(
                "Ollama HTTP client could not be created",
                &error.to_string(),
                None,
            )
        })?;

    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "name": model,
            "stream": true,
        }))
        .send()
        .await
        .map_err(|error| {
            public_ollama_error("Ollama pull request failed", &error.to_string(), None)
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(public_ollama_error(
            "Ollama pull request failed",
            &body,
            Some(status.as_u16()),
        ));
    }

    let mut stream = resp.bytes_stream();

    // Buffer for incomplete JSON lines (max 1MB)
    const MAX_BUF_SIZE: usize = 1_048_576;
    let mut buf = String::new();

    // Track per-layer progress for accurate overall percentage
    // Key: digest, Value: (completed, total)
    let mut layers: HashMap<String, (u64, u64)> = HashMap::new();

    // Speed tracking
    let start_time = Instant::now();
    let mut last_speed_time = Instant::now();
    let mut last_speed_bytes: u64 = 0;
    let mut current_speed: Option<u64> = None;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            public_ollama_error(
                "Ollama pull stream could not be read",
                &error.to_string(),
                None,
            )
        })?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        if buf.len() > MAX_BUF_SIZE {
            return Err(public_ollama_error(
                "Ollama pull response exceeded the size limit",
                &buf,
                None,
            ));
        }

        while let Some(newline_pos) = buf.find('\n') {
            let line = buf[..newline_pos].trim().to_string();
            buf = buf[newline_pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                // Check for error first
                if let Some(err) = val["error"].as_str() {
                    let err_lower = err.to_lowercase();
                    if err_lower.contains("manifest") || err_lower.contains("file does not exist") {
                        return Err(public_ollama_error(
                            "Ollama model manifest was not found",
                            err,
                            None,
                        ));
                    }
                    return Err(public_ollama_error("Ollama pull failed", err, None));
                }

                let status_text =
                    public_pull_status(val["status"].as_str().unwrap_or("")).to_string();

                // Track per-layer progress when digest is present
                if let Some(digest) = val["digest"].as_str() {
                    let completed = val["completed"].as_u64().unwrap_or(0);
                    let total = val["total"].as_u64().unwrap_or(0);
                    layers.insert(digest.to_string(), (completed, total));
                }

                // Calculate overall progress across all layers
                let (overall_completed, overall_total) = if layers.is_empty() {
                    (0u64, 0u64)
                } else {
                    layers.values().fold((0u64, 0u64), |(ac, at), &(c, t)| {
                        (ac.saturating_add(c), at.saturating_add(t))
                    })
                };

                let percent = if overall_total > 0 {
                    Some((overall_completed as f64 / overall_total as f64) * 100.0)
                } else {
                    None
                };

                // Calculate speed (update every 500ms to avoid jitter)
                let now = Instant::now();
                let speed_elapsed = now.duration_since(last_speed_time);
                if speed_elapsed.as_millis() >= 500 {
                    let bytes_delta = overall_completed.saturating_sub(last_speed_bytes);
                    let secs = speed_elapsed.as_secs_f64();
                    if secs > 0.0 {
                        current_speed = Some((bytes_delta as f64 / secs) as u64);
                    }
                    last_speed_bytes = overall_completed;
                    last_speed_time = now;
                }

                // For the initial period, use average speed
                if current_speed.is_none() && overall_completed > 0 {
                    let elapsed = now.duration_since(start_time).as_secs_f64();
                    if elapsed > 0.5 {
                        current_speed = Some((overall_completed as f64 / elapsed) as u64);
                    }
                }

                let progress = OllamaPullProgress {
                    model: model.to_string(),
                    status: status_text,
                    completed: if overall_total > 0 {
                        Some(overall_completed)
                    } else {
                        None
                    },
                    total: if overall_total > 0 {
                        Some(overall_total)
                    } else {
                        None
                    },
                    percent,
                    speed: current_speed,
                };

                let _ = app.emit("ollama-pull-progress", &progress);
            }
        }
    }

    // Emit completion event
    let _ = app.emit(
        "ollama-pull-progress",
        &OllamaPullProgress {
            model: model.to_string(),
            status: "complete".to_string(),
            completed: None,
            total: None,
            percent: Some(100.0),
            speed: None,
        },
    );

    Ok(format!("Model {} pulled successfully", model))
}

/// Pull (download) a model from Ollama, streaming progress events to the frontend.
/// Tracks progress across all layers for accurate overall percentage and speed.
#[tauri::command]
pub async fn ollama_pull_model(
    app: AppHandle,
    model: String,
    base_url: Option<String>,
) -> Result<String, String> {
    pull_model_inner(&app, &model, base_url.as_deref()).await
}

/// Delete a locally installed model.
#[tauri::command]
pub async fn ollama_delete_model(
    model: String,
    base_url: Option<String>,
) -> Result<String, String> {
    let url = format!("{}/api/delete", resolve_base_url(base_url.as_deref())?);
    let client = build_client(None)?;

    let resp = client
        .delete(&url)
        .json(&serde_json::json!({ "name": model }))
        .send()
        .await
        .map_err(|error| {
            public_ollama_error("Ollama delete request failed", &error.to_string(), None)
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(public_ollama_error(
            "Ollama delete request failed",
            &body,
            Some(status.as_u16()),
        ));
    }

    Ok(format!("Model {} deleted successfully", model))
}

// ---------------------------------------------------------------------------
// Read-only registry mirror discovery via ~/.ollama/config.json
// ---------------------------------------------------------------------------

/// Resolve the Ollama config directory (~/.ollama/).
fn ollama_config_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ollama"))
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

fn read_ollama_registry_mirror_from(config_dir: &std::path::Path) -> Result<String, String> {
    let config_path = config_dir.join("config.json");
    let content = match crate::provider_readonly::read_provider_text(config_dir, &config_path) {
        Ok(content) => content,
        Err(_) => return Ok(String::new()),
    };
    let val: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
    Ok(val
        .pointer("/registry/mirrors/registry.ollama.ai")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Read the current registry mirror URL from the provider-owned Ollama config.
/// The config is never created or modified by Bytro Community Edition.
#[tauri::command]
pub async fn get_ollama_registry_mirror() -> Result<String, String> {
    read_ollama_registry_mirror_from(&ollama_config_dir()?)
}

/// Stop only an Ollama process launched by this Bytro process.
///
/// Provider-owned or independently launched Ollama processes are never
/// terminated by name.
#[tauri::command]
pub async fn stop_ollama() -> Result<String, String> {
    let child = managed_ollama_process().lock().await.take();
    let Some(mut child) = child else {
        return Err(
            "Ollama was not started by Bytro; stop the external service yourself".to_string(),
        );
    };
    if child
        .try_wait()
        .map_err(|e| format!("Failed to inspect managed Ollama process: {}", e))?
        .is_none()
    {
        child
            .kill()
            .await
            .map_err(|e| format!("Failed to stop managed Ollama process: {}", e))?;
        let _ = child.wait().await;
    }
    Ok("Bytro-managed Ollama process stopped".to_string())
}

/// Start the Ollama process and wait for it to be ready.
#[tauri::command]
pub async fn start_ollama() -> Result<String, String> {
    {
        let mut managed = managed_ollama_process().lock().await;
        if let Some(child) = managed.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok("Bytro-managed Ollama is already starting".to_string()),
                Ok(Some(_)) | Err(_) => {
                    managed.take();
                }
            }
        }
    }

    let ollama_path = {
        #[cfg(target_os = "windows")]
        {
            let local_app = std::env::var("LOCALAPPDATA").unwrap_or_default();
            let candidate = PathBuf::from(&local_app).join("Programs/Ollama/ollama app.exe");
            if candidate.exists() {
                Some(candidate)
            } else {
                None
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            None::<PathBuf>
        }
    };

    let child = if let Some(path) = ollama_path {
        tokio::process::Command::new(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start Ollama: {}", e))?
    } else {
        tokio::process::Command::new("ollama")
            .arg("serve")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start Ollama: {}", e))?
    };
    *managed_ollama_process().lock().await = Some(child);

    let client = Client::new();
    for _ in 0..15 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if client
            .get("http://localhost:11434/api/version")
            .send()
            .await
            .is_ok()
        {
            return Ok("Ollama started successfully".to_string());
        }
    }

    if let Some(mut child) = managed_ollama_process().lock().await.take() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    Err("Ollama started but not responding after 15s".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ollama_base_urls_without_echoing_sensitive_values() {
        assert_eq!(
            resolve_base_url(None).expect("default base"),
            "http://localhost:11434"
        );
        assert_eq!(
            resolve_base_url(Some("https://ollama.example.test/custom/path/"))
                .expect("custom base path"),
            "https://ollama.example.test/custom/path"
        );
        assert_eq!(
            resolve_base_url(Some("http://127.0.0.1:11434/v1")).expect("local v1 base"),
            "http://127.0.0.1:11434"
        );

        for sentinel in [
            "https://user:secret@ollama.example.test/v1",
            "https://ollama.example.test/v1?token=opaque",
            "https://ollama.example.test/v1#prompt-do-not-disclose",
            "file:///Users/private/model",
        ] {
            let error = resolve_base_url(Some(sentinel)).expect_err("unsafe base URL");
            assert!(error.starts_with("Invalid Ollama Base URL (diagnosticId: "));
            assert!(!error.contains(sentinel));
            assert!(!error.contains("secret"));
            assert!(!error.contains("opaque"));
            assert!(!error.contains("do-not-disclose"));
            assert!(!error.contains("/Users/private"));
        }
    }

    #[test]
    fn ollama_network_errors_do_not_echo_provider_bodies() {
        let sentinel =
            "/Users/private/workspace prompt=do-not-disclose token=opaque access_token=hidden";
        let error = public_ollama_error("Ollama pull failed", sentinel, Some(500));

        assert!(error.starts_with("Ollama pull failed (HTTP 500, diagnosticId: "));
        assert!(!error.contains("/Users/private"));
        assert!(!error.contains("do-not-disclose"));
        assert!(!error.contains("opaque"));
        assert!(!error.contains("hidden"));
    }

    #[test]
    fn ollama_proxy_validation_does_not_echo_invalid_values() {
        validate_proxy_url("http://127.0.0.1:8080").expect("http proxy");
        validate_proxy_url("https://proxy.example.test:8443").expect("https proxy");
        validate_proxy_url("socks5://127.0.0.1:1080").expect("socks proxy");

        for sentinel in [
            "ftp://user:secret@proxy.example.test",
            "http://user:secret@proxy.example.test?token=opaque",
            "http://proxy.example.test#prompt-do-not-disclose",
        ] {
            let error = validate_proxy_url(sentinel).expect_err("unsafe proxy");
            assert!(error.starts_with("Invalid proxy URL (diagnosticId: "));
            assert!(!error.contains(sentinel));
            assert!(!error.contains("secret"));
            assert!(!error.contains("opaque"));
            assert!(!error.contains("do-not-disclose"));
        }
    }

    #[test]
    fn reads_existing_mirror_without_mutating_ollama_config() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".ollama");
        std::fs::create_dir(&root).expect("ollama root");
        let config = root.join("config.json");
        std::fs::write(
            &config,
            r#"{"registry":{"mirrors":{"registry.ollama.ai":"https://mirror.example"}}}"#,
        )
        .expect("ollama config");
        let before = std::fs::read(&config).expect("config snapshot");

        assert_eq!(
            read_ollama_registry_mirror_from(&root).expect("read mirror"),
            "https://mirror.example"
        );
        assert_eq!(std::fs::read(&config).expect("config after"), before);
    }

    #[test]
    fn skips_oversized_and_nonregular_ollama_config() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".ollama");
        std::fs::create_dir(&root).expect("ollama root");
        let config = root.join("config.json");
        let oversized = std::fs::File::create(&config).expect("oversized config");
        oversized
            .set_len(crate::provider_readonly::MAX_PROVIDER_TEXT_BYTES + 1)
            .expect("extend config");
        assert_eq!(
            read_ollama_registry_mirror_from(&root).expect("skip oversized"),
            ""
        );

        std::fs::remove_file(&config).expect("remove oversized");
        std::fs::create_dir(&config).expect("directory config");
        assert_eq!(
            read_ollama_registry_mirror_from(&root).expect("skip directory"),
            ""
        );
    }

    #[cfg(unix)]
    #[test]
    fn skips_linked_ollama_roots_linked_configs_and_fifo() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".ollama");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).expect("ollama root");
        std::fs::create_dir(&outside).expect("outside");
        let secret = outside.join("config.json");
        std::fs::write(
            &secret,
            r#"{"registry":{"mirrors":{"registry.ollama.ai":"https://secret.example"}}}"#,
        )
        .expect("outside config");

        let linked_root = temp.path().join("linked-ollama");
        symlink(&outside, &linked_root).expect("linked root");
        assert_eq!(
            read_ollama_registry_mirror_from(&linked_root).expect("skip linked root"),
            ""
        );

        let linked_config = root.join("config.json");
        symlink(&secret, &linked_config).expect("linked config");
        assert_eq!(
            read_ollama_registry_mirror_from(&root).expect("skip linked config"),
            ""
        );
        std::fs::remove_file(&linked_config).expect("remove config link");

        let fifo_c = CString::new(linked_config.as_os_str().as_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert_eq!(
            read_ollama_registry_mirror_from(&root).expect("skip fifo"),
            ""
        );
    }
}
