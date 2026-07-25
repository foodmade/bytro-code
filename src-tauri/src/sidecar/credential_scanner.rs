// src-tauri/src/sidecar/credential_scanner.rs
//
// Scans the local machine for already-configured AI provider credentials
// (environment variables + CLI config files) so the Settings > Models panel
// can offer to auto-fill them into the corresponding platform profiles.
//
// Source of truth for env-var names: sidecar/src/credential-strategy.ts.
// Source of truth for platform IDs: src/lib/platform-config.ts.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedCredential {
    pub platform_id: String,
    /// One of: "env", "config_file".
    pub source: String,
    /// Human-readable source tag, e.g. "OPENAI_API_KEY" or "~/.codex/auth.json".
    pub source_label: String,
    pub base_url: Option<String>,
    pub api_key: String,
    pub api_key_masked: String,
    pub config_path: Option<String>,
}

/// Minimum length for a value to be treated as a plausible API key.
/// Filters out empty strings, obvious placeholders, and accidental single chars.
const MIN_KEY_LEN: usize = 8;

/// Read a provider-owned configuration file without following links or
/// accepting special files. Provider configuration is an import source only:
/// callers must never create, rewrite, or delete anything below `provider_root`.
fn read_bounded_regular_provider_file(provider_root: &Path, path: &Path) -> Option<String> {
    if path.parent() != Some(provider_root) {
        return None;
    }
    crate::provider_readonly::read_provider_text(provider_root, path).ok()
}

fn is_plausible_key(key: &str) -> bool {
    let trimmed = key.trim();
    trimmed.len() >= MIN_KEY_LEN && !trimmed.eq_ignore_ascii_case("null")
}

/// `prefix4...suffix4`, or full mask when the key is too short to partially reveal.
fn mask_api_key(key: &str) -> String {
    let len = key.chars().count();
    if len == 0 {
        return String::new();
    }
    if len < 12 {
        return "*".repeat(len.min(12));
    }
    let chars: Vec<char> = key.chars().collect();
    let prefix: String = chars.iter().take(4).collect();
    let suffix: String = chars
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{}…{}", prefix, suffix)
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn home_relative(path: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(stripped) = path.strip_prefix(&home) {
            return format!("~/{}", stripped.to_string_lossy().replace('\\', "/"));
        }
    }
    path.to_string_lossy().to_string()
}

fn make_cred(
    platform_id: &str,
    source: &str,
    source_label: String,
    api_key: String,
    base_url: Option<String>,
    config_path: Option<PathBuf>,
) -> ScannedCredential {
    let masked = mask_api_key(&api_key);
    ScannedCredential {
        platform_id: platform_id.to_string(),
        source: source.to_string(),
        source_label,
        base_url: base_url.filter(|v| !v.trim().is_empty()),
        api_key,
        api_key_masked: masked,
        config_path: config_path.map(|p| p.to_string_lossy().to_string()),
    }
}

// ---------------------------------------------------------------------------
// Environment-variable scanners
// ---------------------------------------------------------------------------

/// env-var definitions per platform, in priority order (first match wins for
/// api_key). The BASE_URL slot is optional and checked independently.
struct EnvSpec {
    platform_id: &'static str,
    api_key_vars: &'static [&'static str],
    base_url_vars: &'static [&'static str],
}

const ENV_SPECS: &[EnvSpec] = &[
    EnvSpec {
        platform_id: "claude",
        api_key_vars: &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        base_url_vars: &["ANTHROPIC_BASE_URL"],
    },
    EnvSpec {
        platform_id: "codex",
        api_key_vars: &["OPENAI_API_KEY"],
        base_url_vars: &["OPENAI_BASE_URL"],
    },
    EnvSpec {
        platform_id: "gemini",
        api_key_vars: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        base_url_vars: &["GOOGLE_GEMINI_BASE_URL"],
    },
    EnvSpec {
        platform_id: "grok",
        api_key_vars: &["XAI_API_KEY", "GROK_API_KEY"],
        base_url_vars: &[],
    },
    EnvSpec {
        platform_id: "deepseek",
        api_key_vars: &["DEEPSEEK_API_KEY"],
        base_url_vars: &[],
    },
    EnvSpec {
        platform_id: "qwen",
        api_key_vars: &["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
        base_url_vars: &[],
    },
    EnvSpec {
        platform_id: "bigmodel",
        api_key_vars: &["ZHIPUAI_API_KEY", "BIGMODEL_API_KEY"],
        base_url_vars: &[],
    },
    EnvSpec {
        platform_id: "minimax",
        api_key_vars: &["MINIMAX_API_KEY"],
        base_url_vars: &[],
    },
    EnvSpec {
        platform_id: "kimi",
        api_key_vars: &["MOONSHOT_API_KEY", "KIMI_API_KEY"],
        base_url_vars: &[],
    },
];

fn scan_env_for_spec(spec: &EnvSpec) -> Option<ScannedCredential> {
    let (key_var, api_key) = spec
        .api_key_vars
        .iter()
        .find_map(|name| env(name).map(|v| (*name, v)))?;

    if !is_plausible_key(&api_key) {
        return None;
    }

    let base_url = spec.base_url_vars.iter().find_map(|name| env(name));

    Some(make_cred(
        spec.platform_id,
        "env",
        key_var.to_string(),
        api_key,
        base_url,
        None,
    ))
}

/// Ollama is special: has no api key, only a host. Use "ollama" as a placeholder
/// so the merge logic doesn't treat it as empty.
fn scan_env_for_ollama() -> Option<ScannedCredential> {
    let host = env("OLLAMA_HOST")?;
    Some(make_cred(
        "ollama",
        "env",
        "OLLAMA_HOST".to_string(),
        "ollama".to_string(),
        Some(host),
        None,
    ))
}

// ---------------------------------------------------------------------------
// Config-file scanners
// ---------------------------------------------------------------------------

/// `~/.codex/auth.json` (written by Codex CLI and compatible older sessions)
/// has the shape `{ "OPENAI_API_KEY": "..." }`.
fn scan_codex_config() -> Vec<ScannedCredential> {
    let mut out = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };

    let codex_root = home.join(".codex");
    let auth_path = codex_root.join("auth.json");
    let api_key = match read_bounded_regular_provider_file(&codex_root, &auth_path) {
        Some(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| {
                v.get("OPENAI_API_KEY")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
            }),
        None => None,
    };

    // config.toml can carry `openai_base_url = "..."` at root level (written by
    // an isolated legacy session code path) and/or `[model_providers.*]`
    // sections with their own `base_url`. We extract the first `openai_base_url`
    // or the first `base_url` found inside any `[model_providers.*]` section.
    let config_path = codex_root.join("config.toml");
    let base_url = read_bounded_regular_provider_file(&codex_root, &config_path)
        .and_then(|raw| extract_codex_base_url(&raw));

    if let Some(key) = api_key.filter(|k| is_plausible_key(k)) {
        out.push(make_cred(
            "codex",
            "config_file",
            home_relative(&auth_path),
            key,
            base_url,
            Some(auth_path),
        ));
    }

    out
}

/// Extract a base URL from a Codex `config.toml`. Uses line-based matching so we
/// don't need to pull in a TOML parser for a handful of scalar fields.
fn extract_codex_base_url(raw: &str) -> Option<String> {
    let mut in_provider_section = false;
    let mut section_base_url: Option<String> = None;
    let mut root_base_url: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_provider_section = trimmed.starts_with("[model_providers");
            continue;
        }

        // Match `key = "value"` (allow single quotes too)
        let (key, value) = match split_toml_scalar(trimmed) {
            Some(kv) => kv,
            None => continue,
        };

        if !in_provider_section && key == "openai_base_url" && root_base_url.is_none() {
            root_base_url = Some(value);
        } else if in_provider_section && key == "base_url" && section_base_url.is_none() {
            section_base_url = Some(value);
        }
    }

    root_base_url.or(section_base_url)
}

/// Parse a TOML-style scalar line into `(key, unquoted_value)`. Returns `None`
/// for non-scalar lines.
fn split_toml_scalar(line: &str) -> Option<(String, String)> {
    let eq = line.find('=')?;
    let key = line[..eq].trim().to_string();
    let mut value = line[eq + 1..].trim().to_string();
    // Strip a trailing inline comment.
    if let Some(hash) = find_unquoted_hash(&value) {
        value.truncate(hash);
        value = value.trim().to_string();
    }
    if ((value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\'')))
        && value.len() >= 2
    {
        value = value[1..value.len() - 1].to_string();
    } else {
        // non-string scalar (number/bool/table) — we only care about strings
        return None;
    }
    Some((key, value))
}

fn find_unquoted_hash(s: &str) -> Option<usize> {
    let mut in_string = false;
    let mut quote = '\0';
    for (i, c) in s.char_indices() {
        match c {
            '"' | '\'' if !in_string => {
                in_string = true;
                quote = c;
            }
            c if in_string && c == quote => {
                in_string = false;
            }
            '#' if !in_string => return Some(i),
            _ => {}
        }
    }
    None
}

/// `~/.claude/settings.json` may contain an `env` section written by prior CLI
/// sessions. We extract ANTHROPIC_* from there.
fn scan_claude_config() -> Option<ScannedCredential> {
    let home = dirs::home_dir()?;
    let provider_root = home.join(".claude");
    let path = provider_root.join("settings.json");
    let raw = read_bounded_regular_provider_file(&provider_root, &path)?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let env_obj = value.get("env")?.as_object()?;

    let api_key = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
        .iter()
        .find_map(|k| {
            env_obj
                .get(*k)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .filter(|s| is_plausible_key(s))?;

    let base_url = env_obj
        .get("ANTHROPIC_BASE_URL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Some(make_cred(
        "claude",
        "config_file",
        home_relative(&path),
        api_key,
        base_url,
        Some(path),
    ))
}

/// `~/.gemini/settings.json` may contain credentials; structure varies by CLI
/// version so we probe common shapes conservatively.
fn scan_gemini_config() -> Option<ScannedCredential> {
    let home = dirs::home_dir()?;
    let provider_root = home.join(".gemini");
    let path = provider_root.join("settings.json");
    let raw = read_bounded_regular_provider_file(&provider_root, &path)?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;

    // Probe: top-level `apiKey` / `api_key`, or nested `env.GEMINI_API_KEY`.
    let api_key = value
        .get("apiKey")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("api_key").and_then(|v| v.as_str()))
        .or_else(|| {
            value
                .get("env")
                .and_then(|e| e.as_object())
                .and_then(|env| {
                    env.get("GEMINI_API_KEY")
                        .or_else(|| env.get("GOOGLE_API_KEY"))
                        .and_then(|v| v.as_str())
                })
        })
        .map(|s| s.to_string())
        .filter(|s| is_plausible_key(s))?;

    let base_url = value
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Some(make_cred(
        "gemini",
        "config_file",
        home_relative(&path),
        api_key,
        base_url,
        Some(path),
    ))
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn scan_local_credentials() -> Vec<ScannedCredential> {
    let mut out = Vec::new();

    // 1. Environment variables (one per platform at most).
    for spec in ENV_SPECS {
        if let Some(cred) = scan_env_for_spec(spec) {
            out.push(cred);
        }
    }
    if let Some(cred) = scan_env_for_ollama() {
        out.push(cred);
    }

    // 2. Config files.
    out.extend(scan_codex_config());
    if let Some(cred) = scan_claude_config() {
        out.push(cred);
    }
    if let Some(cred) = scan_gemini_config() {
        out.push(cred);
    }

    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn mask_empty() {
        assert_eq!(mask_api_key(""), "");
    }

    #[test]
    fn mask_short() {
        assert_eq!(mask_api_key("abc"), "***");
        assert_eq!(mask_api_key("abcdefghijk"), "***********"); // 11 chars
    }

    #[test]
    fn mask_exactly_12() {
        assert_eq!(mask_api_key("abcdefghijkl"), "abcd…ijkl");
    }

    #[test]
    fn mask_long() {
        assert_eq!(mask_api_key("sk-proj-abc123xyz"), "sk-p…3xyz");
    }

    #[test]
    fn is_plausible_filters_short_and_null() {
        assert!(!is_plausible_key(""));
        assert!(!is_plausible_key("abc"));
        assert!(!is_plausible_key("null"));
        assert!(!is_plausible_key("NULL"));
        assert!(is_plausible_key("sk-abcd1234"));
    }

    #[test]
    fn extract_codex_base_url_root_scalar() {
        let toml = r#"
openai_base_url = "https://example.com/v1"
"#;
        assert_eq!(
            extract_codex_base_url(toml),
            Some("https://example.com/v1".to_string())
        );
    }

    #[test]
    fn extract_codex_base_url_section() {
        let toml = r#"
[model_providers.openai]
name = "OpenAI"
base_url = "https://relay.example.com"
"#;
        assert_eq!(
            extract_codex_base_url(toml),
            Some("https://relay.example.com".to_string())
        );
    }

    #[test]
    fn extract_codex_base_url_root_beats_section() {
        let toml = r#"
openai_base_url = "https://root.example"

[model_providers.openai]
base_url = "https://section.example"
"#;
        assert_eq!(
            extract_codex_base_url(toml),
            Some("https://root.example".to_string())
        );
    }

    #[test]
    fn extract_codex_base_url_comment_only() {
        let toml = r#"
# openai_base_url = "https://ignored"
"#;
        assert_eq!(extract_codex_base_url(toml), None);
    }

    #[test]
    fn split_toml_scalar_strips_inline_comment() {
        let line = r#"base_url = "https://x.com"   # comment"#;
        assert_eq!(
            split_toml_scalar(line),
            Some(("base_url".to_string(), "https://x.com".to_string()))
        );
    }

    #[test]
    fn split_toml_scalar_rejects_non_string() {
        assert_eq!(split_toml_scalar("enabled = true"), None);
        assert_eq!(split_toml_scalar("count = 42"), None);
    }

    #[test]
    fn bounded_provider_reader_accepts_small_regular_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        let provider_root = temp.path().join(".codex");
        std::fs::create_dir(&provider_root).expect("provider root");
        let config = provider_root.join("auth.json");
        std::fs::write(&config, br#"{"OPENAI_API_KEY":"test-key"}"#).expect("config");

        assert_eq!(
            read_bounded_regular_provider_file(&provider_root, &config).as_deref(),
            Some(r#"{"OPENAI_API_KEY":"test-key"}"#)
        );
    }

    #[test]
    fn bounded_provider_reader_rejects_oversized_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        let provider_root = temp.path().join(".codex");
        std::fs::create_dir(&provider_root).expect("provider root");
        let config = provider_root.join("auth.json");
        let mut file = std::fs::File::create(&config).expect("config");
        file.write_all(&vec![
            b'x';
            crate::provider_readonly::MAX_PROVIDER_TEXT_BYTES
                as usize
                + 1
        ])
        .expect("oversized config");

        assert!(read_bounded_regular_provider_file(&provider_root, &config).is_none());
    }

    #[test]
    fn bounded_provider_reader_rejects_non_regular_leaf() {
        let temp = tempfile::tempdir().expect("temp dir");
        let provider_root = temp.path().join(".codex");
        std::fs::create_dir(&provider_root).expect("provider root");
        let directory_leaf = provider_root.join("auth.json");
        std::fs::create_dir(&directory_leaf).expect("directory leaf");

        assert!(read_bounded_regular_provider_file(&provider_root, &directory_leaf).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_provider_reader_rejects_symlinked_leaf_and_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let real_root = temp.path().join("real-provider");
        std::fs::create_dir(&real_root).expect("provider root");
        let real_config = real_root.join("real-auth.json");
        std::fs::write(&real_config, "secret-value").expect("config");

        let linked_leaf = real_root.join("auth.json");
        symlink(&real_config, &linked_leaf).expect("leaf symlink");
        assert!(read_bounded_regular_provider_file(&real_root, &linked_leaf).is_none());

        let linked_root = temp.path().join(".codex");
        symlink(&real_root, &linked_root).expect("root symlink");
        let path_through_link = linked_root.join("real-auth.json");
        assert!(read_bounded_regular_provider_file(&linked_root, &path_through_link).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_provider_reader_rejects_fifo_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let provider_root = temp.path().join(".codex");
        std::fs::create_dir(&provider_root).expect("provider root");
        let fifo = provider_root.join("auth.json");
        let fifo_path = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        let result = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );

        assert!(read_bounded_regular_provider_file(&provider_root, &fifo).is_none());
    }
}
