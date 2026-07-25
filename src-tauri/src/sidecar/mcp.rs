use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use tauri::State;

use crate::memory::db::MemoryDb;

const MCP_REGISTRY_API_BASE: &str = "https://registry.modelcontextprotocol.io/v0.1";
const MAX_MCP_CONFIG_BYTES: u64 = 1024 * 1024;
const INVALID_REMOTE_MCP_URL: &str = "Invalid remote MCP URL";

#[derive(Debug, Deserialize)]
struct McpRegistryMetadata {
    #[serde(rename = "nextCursor")]
    next_cursor: Option<String>,
    count: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct McpRegistryListResponse {
    servers: Option<Vec<serde_json::Value>>,
    metadata: Option<McpRegistryMetadata>,
}

// ---------------------------------------------------------------------------
// MCP server configuration persistence
// ---------------------------------------------------------------------------

fn mcp_config_path() -> Result<std::path::PathBuf, String> {
    // Authoritative location: ~/.bytro-community/mcp-servers.json.
    crate::bytro_home::mcp_config_path()
}

fn public_mcp_url_error(raw: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(raw.as_bytes());
    let full_hash = format!("{:x}", digest.finalize());
    let diagnostic_id = &full_hash[..12];
    eprintln!(
        "[mcp-url] validation failed category=invalid_remote_url input_len={} diagnostic_id={}",
        raw.len(),
        diagnostic_id
    );
    format!(
        "{} (diagnosticId: {})",
        INVALID_REMOTE_MCP_URL, diagnostic_id
    )
}

fn url_authority_has_userinfo(value: &str) -> bool {
    value
        .split_once("://")
        .map(|(_, remainder)| {
            let authority_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
            remainder[..authority_end].contains('@')
        })
        .unwrap_or(false)
}

/// Canonicalize a user-configured remote MCP endpoint. Authentication belongs
/// in the separate headers map; URL queries are rejected wholesale so tokens
/// cannot leak into persisted config, diagnostics, OAuth state, or runtimes.
pub(crate) fn normalize_mcp_remote_url(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty()
        || value
            .chars()
            .any(|character| character <= '\u{001f}' || character == '\u{007f}')
    {
        return Err(public_mcp_url_error(raw));
    }

    let parsed = url::Url::parse(value).map_err(|_| public_mcp_url_error(raw))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url_authority_has_userinfo(value)
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(public_mcp_url_error(raw));
    }

    Ok(parsed.to_string())
}

fn sanitize_mcp_servers(servers: serde_json::Value) -> Result<serde_json::Value, String> {
    let entries = servers
        .as_object()
        .ok_or_else(|| "Invalid MCP server configuration.".to_string())?;
    let mut sanitized = serde_json::Map::with_capacity(entries.len());

    for (name, config) in entries {
        let config_object = config
            .as_object()
            .ok_or_else(|| "Invalid MCP server configuration.".to_string())?;
        let mut normalized = config_object.clone();
        let remote_type = matches!(
            config_object
                .get("type")
                .and_then(serde_json::Value::as_str),
            Some("http" | "sse")
        );

        match config_object.get("url") {
            Some(serde_json::Value::String(raw_url)) => {
                normalized.insert(
                    "url".to_string(),
                    serde_json::Value::String(normalize_mcp_remote_url(raw_url)?),
                );
            }
            Some(_) => return Err(public_mcp_url_error("non-string")),
            None if remote_type => return Err(public_mcp_url_error("missing")),
            None => {}
        }

        sanitized.insert(name.clone(), serde_json::Value::Object(normalized));
    }

    Ok(serde_json::Value::Object(sanitized))
}

fn secure_mcp_parent(path: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "MCP config path has no parent directory".to_string())?;
    crate::bytro_home::ensure_private_dir(parent)
}

fn write_mcp_config_atomically(path: &std::path::Path, content: &str) -> Result<(), String> {
    secure_mcp_parent(path)?;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!("Refusing symlinked MCP config {}", path.display()));
        }
        if !metadata.is_file() {
            return Err(format!("MCP config is not a file: {}", path.display()));
        }
    }

    let parent = path
        .parent()
        .ok_or_else(|| "MCP config path has no parent directory".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary MCP config: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to secure temporary MCP config: {}", e))?;
    }
    temporary
        .write_all(content.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|e| format!("Failed to write temporary MCP config: {}", e))?;
    temporary
        .persist(path)
        .map_err(|e| format!("Failed to replace MCP config atomically: {}", e.error))?;
    crate::bytro_home::harden_private_file(path)
}

fn load_mcp_servers_from(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({}));
        }
        Err(error) => return Err(format!("Failed to inspect MCP config: {}", error)),
        Ok(_) => {}
    }
    let content = crate::provider_readonly::read_bounded_text(root, path, MAX_MCP_CONFIG_BYTES)
        .map_err(|e| format!("Failed to safely read MCP config: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Invalid MCP config JSON: {}", e))
}

#[tauri::command]
pub fn load_mcp_servers() -> Result<serde_json::Value, String> {
    let path = mcp_config_path()?;
    let root = crate::bytro_home::home_dir()?;
    load_mcp_servers_from(&root, &path)
}

#[tauri::command]
pub fn save_mcp_servers(servers: serde_json::Value) -> Result<(), String> {
    let path = mcp_config_path()?;
    let sanitized = sanitize_mcp_servers(servers)?;
    let content = serde_json::to_string_pretty(&sanitized)
        .map_err(|e| format!("Failed to serialize MCP config: {}", e))?;
    write_mcp_config_atomically(&path, &content)
}

#[tauri::command]
pub async fn search_mcp_marketplace(
    query: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let page_limit = limit.unwrap_or(30).clamp(1, 100);
    let mut url = url::Url::parse(&format!("{}/servers", MCP_REGISTRY_API_BASE))
        .map_err(|_| "Invalid MCP registry URL".to_string())?;

    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("version", "latest");
        pairs.append_pair("limit", &page_limit.to_string());
        if let Some(q) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
            pairs.append_pair("search", q);
        }
        if let Some(c) = cursor.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            pairs.append_pair("cursor", c);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "Failed to create MCP registry client".to_string())?;

    let response = client
        .get(url)
        .header("accept", "application/json")
        .header("user-agent", "Bytro Community MCP Marketplace")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "MCP registry request timed out".to_string()
            } else if error.is_connect() {
                "MCP registry connection failed".to_string()
            } else {
                "MCP registry request failed".to_string()
            }
        })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "Failed to read MCP registry response".to_string())?;

    if !status.is_success() {
        return Err(format!("MCP registry returned HTTP {}", status.as_u16()));
    }

    let parsed: McpRegistryListResponse =
        serde_json::from_str(&body).map_err(|_| "Invalid MCP registry JSON".to_string())?;
    let metadata = parsed.metadata;
    let servers = parsed.servers.unwrap_or_default();

    Ok(serde_json::json!({
        "servers": servers,
        "nextCursor": metadata.as_ref().and_then(|m| m.next_cursor.clone()),
        "count": metadata.and_then(|m| m.count).unwrap_or(servers.len() as u64),
    }))
}

// ---------------------------------------------------------------------------
// Verify a single MCP server's connectivity
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct McpVerifyResult {
    ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpToolsResult {
    ok: bool,
    message: String,
    tools: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn verify_mcp_server(
    db: State<'_, MemoryDb>,
    name: String,
    config: serde_json::Value,
) -> Result<McpVerifyResult, String> {
    let config_obj = config
        .as_object()
        .ok_or_else(|| "Invalid config: expected object".to_string())?;

    let server_type = config_obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("stdio");

    match server_type {
        "stdio" => verify_stdio_server(&name, config_obj).await,
        "sse" | "http" => verify_http_server(&db, &name, config_obj, server_type).await,
        other => Ok(McpVerifyResult {
            ok: false,
            message: format!("Unknown server type: {}", other),
        }),
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::{
        load_mcp_servers_from, mcp_process_environment_from, normalize_mcp_remote_url,
        sanitize_mcp_servers, verify_stdio_server, write_mcp_config_atomically,
        MAX_MCP_CONFIG_BYTES,
    };

    #[test]
    fn mcp_config_is_private_and_replaced_atomically() {
        let temp = tempfile::tempdir().expect("create temp directory");
        let path = temp.path().join("private").join("mcp-servers.json");

        write_mcp_config_atomically(&path, r#"{"token":"first"}"#).expect("write initial config");
        write_mcp_config_atomically(&path, r#"{"token":"second"}"#).expect("replace config");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read config"),
            r#"{"token":"second"}"#
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path.parent().expect("parent"))
                    .expect("parent metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn mcp_config_load_is_bounded_and_uses_the_managed_root() {
        let temp = tempfile::tempdir().expect("create temp directory");
        let root = temp.path().join(".bytro-community");
        std::fs::create_dir(&root).expect("create managed root");
        let path = root.join("mcp-servers.json");
        std::fs::write(&path, r#"{"local":{"command":"node"}}"#).expect("write config");

        assert_eq!(
            load_mcp_servers_from(&root, &path).expect("load config"),
            serde_json::json!({"local":{"command":"node"}})
        );

        let oversized = root.join("oversized.json");
        std::fs::File::create(&oversized)
            .expect("create oversized config")
            .set_len(MAX_MCP_CONFIG_BYTES + 1)
            .expect("extend oversized config");
        assert!(load_mcp_servers_from(&root, &oversized).is_err());

        let directory = root.join("directory.json");
        std::fs::create_dir(&directory).expect("create directory leaf");
        assert!(load_mcp_servers_from(&root, &directory).is_err());
    }

    #[test]
    fn remote_mcp_urls_are_normalized_before_persistence() {
        let sanitized = sanitize_mcp_servers(serde_json::json!({
            "remote": {
                "type": "http",
                "url": "  https://mcp.example.test:443/a/b  ",
                "headers": { "Authorization": "Bearer private" }
            }
        }))
        .expect("sanitize MCP config");

        assert_eq!(
            sanitized["remote"]["url"],
            serde_json::Value::String("https://mcp.example.test/a/b".to_string())
        );
        assert_eq!(
            sanitized["remote"]["headers"]["Authorization"],
            serde_json::Value::String("Bearer private".to_string())
        );
    }

    #[test]
    fn remote_mcp_urls_reject_embedded_credentials_query_and_fragment_privately() {
        for raw in [
            "https://user:secret@remote.example/mcp",
            "https://remote.example/mcp?token=QUERY_TOKEN_SENTINEL",
            "https://remote.example/mcp#FRAGMENT_SENTINEL",
            "https://remote.example/mcp?",
            "file:///tmp/REMOTE_URL_SENTINEL",
        ] {
            let error = normalize_mcp_remote_url(raw).expect_err("URL must be rejected");
            assert!(error.starts_with("Invalid remote MCP URL (diagnosticId: "));
            assert!(error.ends_with(')'));
            assert!(!error.contains(raw));
            assert!(!error.contains("secret"));
            assert!(!error.contains("QUERY_TOKEN_SENTINEL"));
            assert!(!error.contains("FRAGMENT_SENTINEL"));
            assert!(!error.contains("REMOTE_URL_SENTINEL"));
        }

        let error = sanitize_mcp_servers(serde_json::json!({
            "remote": {
                "type": "sse",
                "url": "https://user:secret@remote.example/mcp"
            }
        }))
        .expect_err("unsafe URL must not be persisted");
        assert!(!error.contains("secret"));
        assert!(!error.contains("remote.example"));
    }

    #[cfg(unix)]
    #[test]
    fn mcp_config_refuses_symlink_targets() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("create temp directory");
        let target = temp.path().join("target.json");
        let link = temp.path().join("mcp-servers.json");
        std::fs::write(&target, "sentinel").expect("write target");
        symlink(&target, &link).expect("create symlink");

        assert!(write_mcp_config_atomically(&link, "{}")
            .expect_err("symlink must be rejected")
            .contains("symlinked"));
        assert_eq!(
            std::fs::read_to_string(&target).expect("read target"),
            "sentinel"
        );

        let root = temp.path().join("managed");
        std::fs::create_dir(&root).expect("create managed root");
        let read_link = root.join("mcp-servers.json");
        symlink(&target, &read_link).expect("create read symlink");
        assert!(load_mcp_servers_from(&root, &read_link).is_err());
    }

    #[test]
    fn mcp_child_environment_excludes_unrelated_ambient_secrets() {
        let declared = std::collections::HashMap::from([(
            "CURRENT_MCP_TOKEN".to_string(),
            "declared-secret".to_string(),
        )]);
        let ambient = [
            ("HOME", "/safe/home"),
            ("OPENAI_API_KEY", "other-provider-secret"),
            ("HTTP_PROXY", "http://user:password@proxy.invalid"),
            ("BYTRO_MCP_SECRET_0", "unrelated-runtime-secret"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()));
        let env = mcp_process_environment_from(&declared, "/safe/bin", ambient);

        assert_eq!(
            env.get(&std::ffi::OsString::from("HOME")).unwrap(),
            "/safe/home"
        );
        assert_eq!(
            env.get(&std::ffi::OsString::from("CURRENT_MCP_TOKEN"))
                .unwrap(),
            "declared-secret"
        );
        assert!(!env.contains_key(&std::ffi::OsString::from("OPENAI_API_KEY")));
        assert!(!env.contains_key(&std::ffi::OsString::from("HTTP_PROXY")));
        assert!(!env.contains_key(&std::ffi::OsString::from("BYTRO_MCP_SECRET_0")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_verification_spawns_once_times_out_and_never_returns_output() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let script = temp.path().join("server.sh");
        let count = temp.path().join("count.txt");
        let sentinel = "sentinel-private-stderr";
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '1\\n' >> \"$1\"\nprintf '{}' >&2\nsleep 30\n",
                sentinel
            ),
        )
        .expect("write script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
            .expect("chmod script");
        let config = serde_json::json!({
            "command": script.to_string_lossy(),
            "args": [count.to_string_lossy()],
            "env": {}
        });
        let started = std::time::Instant::now();

        let result = verify_stdio_server(
            "private-server-name",
            config.as_object().expect("config object"),
        )
        .await
        .expect("verify result");

        assert!(result.ok);
        assert!(started.elapsed() < std::time::Duration::from_secs(8));
        assert_eq!(
            std::fs::read_to_string(count)
                .expect("read count")
                .lines()
                .count(),
            1
        );
        assert!(!result.message.contains(sentinel));
        assert!(!result.message.contains("private-server-name"));
    }
}

/// On Windows, resolve Node.js-based commands (npx, npm, node) to direct
/// `node.exe` + JS script invocations, completely bypassing `cmd.exe` which is
/// fundamentally broken when spawned from a GUI process without a console.
///
/// Returns `Some((node_exe_path, new_args))` if we successfully resolved it,
/// or `None` if the command is not a Node.js command or we can't find node.exe.
#[cfg(target_os = "windows")]
fn resolve_node_command(command: &str, original_args: &[String]) -> Option<(String, Vec<String>)> {
    let cmd_lower = command.to_lowercase();
    let is_npx = cmd_lower == "npx" || cmd_lower == "npx.cmd";
    let is_npm = cmd_lower == "npm" || cmd_lower == "npm.cmd";
    let is_node = cmd_lower == "node" || cmd_lower == "node.exe";

    if !is_npx && !is_npm && !is_node {
        return None;
    }

    let node_dir_and_exe = find_node_exe();
    let (node_dir, node_exe) = match node_dir_and_exe {
        Some(v) => v,
        None => return None,
    };

    if is_node {
        // For `node`, just use node.exe directly with the original args
        return Some((node_exe, original_args.to_vec()));
    }

    // For npx/npm, find the corresponding CLI JS file
    let cli_js = if is_npx { "npx-cli.js" } else { "npm-cli.js" };

    // Look for the CLI JS in node_modules/npm/bin/ relative to node's directory
    let cli_js_path = std::path::PathBuf::from(&node_dir)
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join(cli_js);

    if !cli_js_path.is_file() {
        return None;
    }

    // Build new args: [npx-cli.js, ...original_args]
    let mut new_args = vec![cli_js_path.to_string_lossy().to_string()];
    new_args.extend_from_slice(original_args);

    Some((node_exe, new_args))
}

/// Find node.exe on Windows through the explicit override or original PATH.
/// Returns `Some((node_directory, node_exe_full_path))`.
#[cfg(target_os = "windows")]
fn find_node_exe() -> Option<(String, String)> {
    if let Ok(configured) = std::env::var("BYTRO_NODE_PATH") {
        let configured = std::path::PathBuf::from(configured);
        let candidate = if configured.is_dir() {
            configured.join("node.exe")
        } else {
            configured
        };
        if candidate.is_file() {
            let parent = candidate.parent()?.to_string_lossy().to_string();
            return Some((parent, candidate.to_string_lossy().to_string()));
        }
    }

    for dir in std::env::var_os("PATH")
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
    {
        let candidate = dir.join("node.exe");
        if candidate.is_file() {
            return Some((
                dir.to_string_lossy().to_string(),
                candidate.to_string_lossy().to_string(),
            ));
        }
    }

    None
}

#[derive(Debug)]
struct McpStreamSummary {
    len: u64,
    sha256_prefix: String,
}

fn read_mcp_stream_summary(mut reader: impl Read) -> McpStreamSummary {
    let mut digest = Sha256::new();
    let mut len = 0_u64;
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                len = len.saturating_add(read as u64);
                digest.update(&buffer[..read]);
            }
            Err(error) => {
                eprintln!("[mcp-verify] output reader error kind={:?}", error.kind());
                break;
            }
        }
    }
    let full_hash = format!("{:x}", digest.finalize());
    McpStreamSummary {
        len,
        sha256_prefix: full_hash[..16].to_string(),
    }
}

fn empty_mcp_stream_summary() -> McpStreamSummary {
    read_mcp_stream_summary(std::io::empty())
}

fn mcp_output_summary(stdout: &McpStreamSummary, stderr: &McpStreamSummary) -> String {
    format!(
        "stdout_len={} stdout_sha256={} stderr_len={} stderr_sha256={}",
        stdout.len, stdout.sha256_prefix, stderr.len, stderr.sha256_prefix,
    )
}

fn mcp_process_environment(
    declared: &std::collections::HashMap<String, String>,
    path: &str,
) -> std::collections::HashMap<std::ffi::OsString, std::ffi::OsString> {
    mcp_process_environment_from(declared, path, std::env::vars_os())
}

fn mcp_process_environment_from(
    declared: &std::collections::HashMap<String, String>,
    path: &str,
    ambient: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> std::collections::HashMap<std::ffi::OsString, std::ffi::OsString> {
    const SAFE_OS_KEYS: &[&str] = &[
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SHELL",
        "USER",
        "USERNAME",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "TZ",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
    ];
    let mut environment = std::collections::HashMap::new();
    for (key, value) in ambient {
        let key_text = key.to_string_lossy();
        if SAFE_OS_KEYS
            .iter()
            .any(|safe| key_text.eq_ignore_ascii_case(safe))
        {
            environment.insert(key, value);
        }
    }
    for (key, value) in declared {
        environment.insert(key.into(), value.into());
    }
    environment.insert("PATH".into(), path.into());
    environment
}

fn configure_mcp_process_group(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

fn terminate_mcp_process_tree(child: &mut std::process::Child) {
    let pid = child.id();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

async fn terminate_tokio_mcp_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn verify_stdio_server(
    _name: &str,
    config: &serde_json::Map<String, serde_json::Value>,
) -> Result<McpVerifyResult, String> {
    let command = config
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'command' in stdio config".to_string())?;

    let args: Vec<String> = config
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let env_vars: std::collections::HashMap<String, String> = config
        .get("env")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    // Try to spawn the process and check if it starts successfully.
    // MCP stdio servers should start and wait for JSON-RPC input on stdin.
    // We spawn, wait briefly for early exit (which indicates failure), then
    // kill the process if it's still running (which indicates success).
    use std::process::{Command, Stdio};

    let enhanced_path = build_mcp_enhanced_path(&env_vars);

    // On Windows, Node.js commands (npx, npm, node) cannot be run via cmd.exe
    // in a GUI process because cmd.exe's PATH resolution is broken without a
    // real console. Instead, we resolve directly to node.exe + the CLI JS script.
    #[cfg(target_os = "windows")]
    let (actual_command, actual_args) = {
        match resolve_node_command(command, &args) {
            Some((node_exe, new_args)) => {
                eprintln!("[mcp-verify] resolved declared Node.js MCP command");
                (node_exe, new_args)
            }
            None => (command.to_string(), args.clone()),
        }
    };
    #[cfg(not(target_os = "windows"))]
    let (actual_command, actual_args) = (command.to_string(), args.clone());

    eprintln!(
        "[mcp-verify] launch prepared: args_count={} declared_env_count={} path_len={}",
        actual_args.len(),
        env_vars.len(),
        enhanced_path.len(),
    );

    // ── Spawn the MCP server ──
    // Result: (exit_code_or_none, stdout summary, stderr summary)
    // None = process stayed alive (success), Some(code) = exited with this code
    let verify_result = tokio::task::spawn_blocking({
        let actual_command = actual_command.clone();
        let actual_args = actual_args.clone();
        let env_vars = env_vars.clone();
        let enhanced_path = enhanced_path.clone();
        move || -> (Option<i32>, McpStreamSummary, McpStreamSummary) {
            let mut cmd = Command::new(&actual_command);
            let process_environment = mcp_process_environment(&env_vars, &enhanced_path);
            cmd.args(&actual_args)
                .env_clear()
                .envs(process_environment)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            configure_mcp_process_group(&mut cmd);

            // On Windows, npm/npx internally uses cmd.exe as `script-shell` to
            // execute downloaded package binaries (.cmd wrappers). This fails
            // in GUI processes because cmd.exe cannot resolve commands without
            // a real console. Force PowerShell as the script shell instead.
            #[cfg(windows)]
            {
                cmd.env("npm_config_script_shell", "powershell");
            }

            eprintln!("[mcp-verify] spawning one declared MCP process");
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "[mcp-verify] spawn failed: kind={:?} os_code={}",
                        e.kind(),
                        e.raw_os_error()
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "unknown".to_string())
                    );
                    if e.kind() == std::io::ErrorKind::NotFound {
                        return (
                            Some(-1),
                            empty_mcp_stream_summary(),
                            empty_mcp_stream_summary(),
                        );
                    }
                    return (
                        Some(-1),
                        empty_mcp_stream_summary(),
                        empty_mcp_stream_summary(),
                    );
                }
            };

            // Take pipe handles and read them in background threads so data is
            // drained as it arrives (avoids pipe deadlock / lost output on Windows).
            let stdout_handle = child.stdout.take();
            let stderr_handle = child.stderr.take();

            let stdout_thread = std::thread::spawn(move || {
                if let Some(mut r) = stdout_handle {
                    read_mcp_stream_summary(&mut r)
                } else {
                    empty_mcp_stream_summary()
                }
            });
            let stderr_thread = std::thread::spawn(move || {
                if let Some(mut r) = stderr_handle {
                    read_mcp_stream_summary(&mut r)
                } else {
                    empty_mcp_stream_summary()
                }
            });

            // Poll for early exit (up to 3 seconds)
            for _ in 0..30 {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let code = status.code().unwrap_or(-1);
                        terminate_mcp_process_tree(&mut child);
                        // Process exited — reader threads will finish once pipes close
                        let stdout = stdout_thread
                            .join()
                            .unwrap_or_else(|_| empty_mcp_stream_summary());
                        let stderr = stderr_thread
                            .join()
                            .unwrap_or_else(|_| empty_mcp_stream_summary());
                        return (Some(code), stdout, stderr);
                    }
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("[mcp-verify] try_wait error kind={:?}", e.kind());
                        terminate_mcp_process_tree(&mut child);
                        let stdout = stdout_thread
                            .join()
                            .unwrap_or_else(|_| empty_mcp_stream_summary());
                        let stderr = stderr_thread
                            .join()
                            .unwrap_or_else(|_| empty_mcp_stream_summary());
                        return (Some(-1), stdout, stderr);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            // Still running after 3s — this means the server started successfully.
            eprintln!("[mcp-verify] process stayed alive for verification window");
            terminate_mcp_process_tree(&mut child);
            // Reader threads will finish now that the process is dead
            let stdout = stdout_thread
                .join()
                .unwrap_or_else(|_| empty_mcp_stream_summary());
            let stderr = stderr_thread
                .join()
                .unwrap_or_else(|_| empty_mcp_stream_summary());
            // None = stayed alive = success
            (None, stdout, stderr)
        }
    })
    .await;

    match verify_result {
        Ok((exit_code, stdout, stderr)) => {
            eprintln!(
                "[mcp-verify] result exit_code={:?} {}",
                exit_code,
                mcp_output_summary(&stdout, &stderr),
            );

            match exit_code {
                // None = process stayed alive for 3s = success
                None => Ok(McpVerifyResult {
                    ok: true,
                    message: "MCP server started successfully".to_string(),
                }),
                // Exited with code 0 = success
                Some(0) => Ok(McpVerifyResult {
                    ok: true,
                    message: "MCP server started successfully".to_string(),
                }),
                // Exited with non-zero code = failure
                Some(code) => Ok(McpVerifyResult {
                    ok: false,
                    message: format!("MCP server failed to start (exit code {})", code),
                }),
            }
        }
        Err(_) => {
            eprintln!("[mcp-verify] verification worker failed");
            Ok(McpVerifyResult {
                ok: false,
                message: "MCP verification task failed".to_string(),
            })
        }
    }
}

async fn verify_http_server(
    db: &MemoryDb,
    name: &str,
    config: &serde_json::Map<String, serde_json::Value>,
    _server_type: &str,
) -> Result<McpVerifyResult, String> {
    let url = config
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'url' in MCP HTTP config".to_string())?;
    let url = normalize_mcp_remote_url(url)?;

    let headers: std::collections::HashMap<String, String> = config
        .get("headers")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let headers = crate::sidecar::mcp_oauth::headers_with_mcp_oauth(db, name, &url, &headers)
        .await
        .map_err(|_| "Failed to resolve MCP OAuth token".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "Failed to create MCP HTTP client".to_string())?;

    let mut request = client.get(&url);
    for (key, value) in &headers {
        request = request.header(key.as_str(), value.as_str());
    }

    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() || status.as_u16() == 405 || status.as_u16() == 426 {
                // 200-299: normal success
                // 405 Method Not Allowed: server exists but expects POST (valid for MCP)
                // 426 Upgrade Required: SSE server expects protocol upgrade (valid)
                Ok(McpVerifyResult {
                    ok: true,
                    message: format!(
                        "MCP server is reachable ({} {})",
                        status.as_u16(),
                        status.canonical_reason().unwrap_or("OK")
                    ),
                })
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                Ok(McpVerifyResult {
                    ok: false,
                    message: format!(
                        "MCP server is reachable but requires authentication ({})",
                        status.as_u16(),
                    ),
                })
            } else {
                Ok(McpVerifyResult {
                    ok: false,
                    message: format!(
                        "MCP server returned error: {} {}",
                        status.as_u16(),
                        status.canonical_reason().unwrap_or("")
                    ),
                })
            }
        }
        Err(e) => {
            let detail = if e.is_timeout() {
                "connection timed out".to_string()
            } else if e.is_connect() {
                "connection refused or unreachable".to_string()
            } else {
                "request failed".to_string()
            };
            Ok(McpVerifyResult {
                ok: false,
                message: format!("MCP server is not reachable: {}", detail),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// List tools from an installed MCP server
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_mcp_tools(
    db: State<'_, MemoryDb>,
    name: String,
    config: serde_json::Value,
) -> Result<McpToolsResult, String> {
    let config_obj = config
        .as_object()
        .ok_or_else(|| "Invalid config: expected object".to_string())?;

    let server_type = config_obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("stdio");

    match server_type {
        "stdio" => list_stdio_tools(&name, config_obj).await,
        "sse" | "http" => list_http_tools(&db, &name, config_obj, server_type).await,
        _ => Ok(McpToolsResult {
            ok: false,
            message: "Unknown MCP server type".to_string(),
            tools: vec![],
        }),
    }
}

fn build_mcp_enhanced_path(env_vars: &std::collections::HashMap<String, String>) -> String {
    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    let base_path = env_vars
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let explicit_node_dir = std::env::var("BYTRO_NODE_PATH")
        .ok()
        .and_then(|value| {
            let path = std::path::PathBuf::from(value);
            if path.is_dir() {
                Some(path)
            } else if path.is_file() {
                path.parent().map(std::path::Path::to_path_buf)
            } else {
                None
            }
        })
        .map(|path| path.to_string_lossy().to_string());
    match explicit_node_dir {
        Some(dir) if !dir.is_empty() => format!("{}{}{}", dir, sep, base_path),
        _ => base_path,
    }
}

fn extract_mcp_tools_page(value: &serde_json::Value) -> (Vec<serde_json::Value>, Option<String>) {
    let result = value.get("result").unwrap_or(value);
    let tools = result
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let next_cursor = result
        .get("nextCursor")
        .and_then(|v| v.as_str())
        .map(String::from);
    (tools, next_cursor)
}

fn parse_mcp_http_body(body_text: &str) -> Result<serde_json::Value, String> {
    let trimmed = body_text.trim();
    if trimmed.is_empty() {
        return Err("MCP server returned an empty response".to_string());
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Ok(value);
    }

    for line in trimmed.lines() {
        let line = line.trim();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                return Ok(value);
            }
        }
    }

    Err("MCP server response was not valid JSON or SSE data".to_string())
}

async fn read_stdio_response(
    lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    expected_id: i64,
) -> Result<serde_json::Value, String> {
    let deadline = std::time::Duration::from_secs(20);

    loop {
        let line = tokio::time::timeout(deadline, lines.next_line())
            .await
            .map_err(|_| "Timed out waiting for MCP stdio response".to_string())?
            .map_err(|e| format!("Failed to read MCP stdio response: {}", e))?;

        let Some(line) = line else {
            return Err("MCP stdio server closed stdout before responding".to_string());
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if value.get("id").and_then(|v| v.as_i64()) == Some(expected_id) {
            if value.get("error").is_some() {
                return Err("MCP server returned a protocol error".to_string());
            }
            return Ok(value);
        }
    }
}

async fn write_stdio_message(
    stdin: &mut tokio::process::ChildStdin,
    value: serde_json::Value,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut text = serde_json::to_string(&value)
        .map_err(|e| format!("Failed to encode MCP message: {}", e))?;
    text.push('\n');
    stdin
        .write_all(text.as_bytes())
        .await
        .map_err(|e| format!("Failed to write MCP message: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush MCP message: {}", e))
}

async fn list_stdio_tools(
    _name: &str,
    config: &serde_json::Map<String, serde_json::Value>,
) -> Result<McpToolsResult, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    let command = config
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'command' in stdio config".to_string())?;

    let args: Vec<String> = config
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let env_vars: std::collections::HashMap<String, String> = config
        .get("env")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    let (actual_command, actual_args) = match resolve_node_command(command, &args) {
        Some((node_exe, new_args)) => (node_exe, new_args),
        None => (command.to_string(), args.clone()),
    };
    #[cfg(not(target_os = "windows"))]
    let (actual_command, actual_args) = (command.to_string(), args.clone());

    let mut cmd = Command::new(&actual_command);
    let enhanced_path = build_mcp_enhanced_path(&env_vars);
    let process_environment = mcp_process_environment(&env_vars, &enhanced_path);
    cmd.args(&actual_args)
        .env_clear()
        .envs(process_environment)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    configure_mcp_process_group(cmd.as_std_mut());

    #[cfg(windows)]
    {
        cmd.env("npm_config_script_shell", "powershell");
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to start MCP server (kind={:?}, os_code={})",
            e.kind(),
            e.raw_os_error()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )
    })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open MCP stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open MCP stdout".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let initialize = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "bytro-community-mcp-manager", "version": "1.0.0" }
        }
    });
    let initialized = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });

    let result = async {
        write_stdio_message(&mut stdin, initialize).await?;
        let _ = read_stdio_response(&mut lines, 1).await?;
        write_stdio_message(&mut stdin, initialized).await?;

        let mut all_tools = Vec::new();
        let mut cursor: Option<String> = None;
        for request_id in 2..12 {
            let params = cursor
                .as_ref()
                .map(|c| serde_json::json!({ "cursor": c }))
                .unwrap_or_else(|| serde_json::json!({}));
            let request = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/list",
                "params": params
            });
            write_stdio_message(&mut stdin, request).await?;
            let response = read_stdio_response(&mut lines, request_id).await?;
            let (tools, next_cursor) = extract_mcp_tools_page(&response);
            all_tools.extend(tools);
            cursor = next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Ok::<Vec<serde_json::Value>, String>(all_tools)
    }
    .await;

    terminate_tokio_mcp_process_tree(&mut child).await;

    match result {
        Ok(tools) => Ok(McpToolsResult {
            ok: true,
            message: format!("Loaded {} MCP tools", tools.len()),
            tools,
        }),
        Err(message) => Ok(McpToolsResult {
            ok: false,
            message,
            tools: vec![],
        }),
    }
}

async fn send_mcp_http_request(
    client: &reqwest::Client,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    session_id: Option<&str>,
    body: serde_json::Value,
) -> Result<(serde_json::Value, Option<String>), String> {
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&body);

    for (key, value) in headers {
        request = request.header(key.as_str(), value.as_str());
    }
    if let Some(session_id) = session_id {
        request = request.header("Mcp-Session-Id", session_id);
    }

    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            "MCP HTTP request timed out".to_string()
        } else if e.is_connect() {
            "MCP HTTP connection failed".to_string()
        } else {
            "MCP HTTP request failed".to_string()
        }
    })?;
    let status = response.status();
    let session = response
        .headers()
        .get("mcp-session-id")
        .or_else(|| response.headers().get("Mcp-Session-Id"))
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body_text = response
        .text()
        .await
        .map_err(|_| "Failed to read MCP HTTP response".to_string())?;

    if !status.is_success() {
        return Err(format!("MCP server returned HTTP {}", status));
    }

    Ok((parse_mcp_http_body(&body_text)?, session))
}

async fn list_http_tools(
    db: &MemoryDb,
    name: &str,
    config: &serde_json::Map<String, serde_json::Value>,
    _server_type: &str,
) -> Result<McpToolsResult, String> {
    let url = config
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'url' in MCP HTTP config".to_string())?;
    let url = normalize_mcp_remote_url(url)?;

    let headers: std::collections::HashMap<String, String> = config
        .get("headers")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let headers = crate::sidecar::mcp_oauth::headers_with_mcp_oauth(db, name, &url, &headers)
        .await
        .map_err(|_| "Failed to resolve MCP OAuth token".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "Failed to create MCP HTTP client".to_string())?;

    let initialize = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "bytro-community-mcp-manager", "version": "1.0.0" }
        }
    });

    let result = async {
        let (_, session) = send_mcp_http_request(&client, &url, &headers, None, initialize).await?;
        let session_ref = session.as_deref();
        let initialized = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        });
        let _ = send_mcp_http_request(&client, &url, &headers, session_ref, initialized).await;

        let mut all_tools = Vec::new();
        let mut cursor: Option<String> = None;
        for request_id in 2..12 {
            let params = cursor
                .as_ref()
                .map(|c| serde_json::json!({ "cursor": c }))
                .unwrap_or_else(|| serde_json::json!({}));
            let body = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/list",
                "params": params
            });
            let (response, _) =
                send_mcp_http_request(&client, &url, &headers, session_ref, body).await?;
            let (tools, next_cursor) = extract_mcp_tools_page(&response);
            all_tools.extend(tools);
            cursor = next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Ok::<Vec<serde_json::Value>, String>(all_tools)
    }
    .await;

    match result {
        Ok(tools) => Ok(McpToolsResult {
            ok: true,
            message: format!("Loaded {} MCP tools", tools.len()),
            tools,
        }),
        Err(message) => Ok(McpToolsResult {
            ok: false,
            message,
            tools: vec![],
        }),
    }
}
