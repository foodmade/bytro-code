use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::protocol::SidecarCommand;
use super::SidecarManager;

// ---------------------------------------------------------------------------
// Orchestration types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamMemberConfig {
    pub name: String,
    pub agent: String,
    pub model: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct OrchestrateKeys {
    #[serde(rename = "anthropicKey")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_key: Option<String>,
    #[serde(rename = "openaiKey")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_key: Option<String>,
    #[serde(rename = "geminiKey")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gemini_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TeamMemberInput {
    pub name: String,
    pub agent: String,
    pub model: String,
    pub role: String,
}

// ---------------------------------------------------------------------------
// Tauri commands: session + orchestration
// ---------------------------------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn init_session(
    app: AppHandle,
    request_id: String,
    model: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    cwd: Option<String>,
    mcp_servers: Option<serde_json::Value>,
    provider: Option<String>,
    auth_mode: Option<String>,
    profile_id: Option<String>,
    proxy_url: Option<String>,
    ultracode: Option<bool>,
    fast_mode: Option<bool>,
) -> Result<(), String> {
    let is_codex = provider.as_deref() == Some("codex");
    let is_third_party = matches!(
        provider.as_deref(),
        Some("grok") | Some("deepseek") | Some("qwen") | Some("bigmodel")
    );
    let resolved_model = model.unwrap_or_else(|| {
        if is_codex {
            "codex-mini-latest".to_string()
        } else {
            "claude-opus-4-7".to_string()
        }
    });

    // Resolve credentials based on provider type
    let (resolved_key, resolved_base) = if is_codex {
        let key = api_key
            .or_else(|| std::env::var("OPENAI_API_KEY").ok())
            .unwrap_or_default();
        let base = base_url.unwrap_or_default();
        (key, base)
    } else {
        let key = api_key
            .or_else(|| {
                if is_third_party {
                    None
                } else {
                    std::env::var("ANTHROPIC_API_KEY").ok()
                }
            })
            .unwrap_or_default();
        let base = base_url
            .or_else(|| {
                if is_third_party {
                    None
                } else {
                    std::env::var("ANTHROPIC_BASE_URL").ok()
                }
            })
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());
        (key, base)
    };
    let resolved_base = if resolved_base.trim().is_empty() {
        String::new()
    } else {
        crate::anthropic::validate_api_base_url(&resolved_base)?
    };

    if resolved_key.is_empty() && !(is_codex && auth_mode.as_deref() == Some("oauth")) {
        // No API key — silently skip init (non-critical)
        return Ok(());
    }

    let cwd = cwd.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    let (claude_binary_path, codex_binary_path) = if is_codex {
        (
            None,
            Some(
                crate::provider_cli::ensure_provider_cli(
                    &app,
                    crate::provider_cli::ProviderCli::Codex,
                    proxy_url.as_deref(),
                )
                .await?,
            ),
        )
    } else {
        (
            Some(
                crate::provider_cli::ensure_provider_cli(
                    &app,
                    crate::provider_cli::ProviderCli::Claude,
                    proxy_url.as_deref(),
                )
                .await?,
            ),
            None,
        )
    };

    let mgr = app.state::<SidecarManager>();
    super::chat::ensure_agent_proxy_reachable(proxy_url.as_deref()).await?;
    mgr.ensure_running(
        &resolved_key,
        &resolved_base,
        "",
        "",
        proxy_url.as_deref(),
        &app,
    )?;

    let mcp_servers = crate::sidecar::mcp_oauth::mcp_servers_with_oauth_headers(
        &app.state::<crate::memory::db::MemoryDb>(),
        mcp_servers,
    )
    .await;

    let cmd = SidecarCommand::InitSession {
        id: request_id,
        model: resolved_model,
        cwd,
        api_key: if resolved_key.is_empty() {
            None
        } else {
            Some(resolved_key)
        },
        base_url: if resolved_base.is_empty() {
            None
        } else {
            Some(resolved_base)
        },
        auth_mode,
        profile_id,
        proxy_url,
        platform: provider,
        mcp_servers,
        ultracode,
        fast_mode,
        codex_binary_path,
        claude_binary_path,
    };

    mgr.send_command(&cmd)?;
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_orchestration(
    app: AppHandle,
    request_id: String,
    task: String,
    team: Vec<TeamMemberInput>,
    permission_mode: Option<String>,
    api_key: Option<String>,
    openai_api_key: Option<String>,
    gemini_api_key: Option<String>,
    proxy_url: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let resolved_api_key = api_key
        .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
        .unwrap_or_default();
    let resolved_openai_key = openai_api_key
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .unwrap_or_default();
    let resolved_gemini_key = gemini_api_key
        .or_else(|| std::env::var("GOOGLE_API_KEY").ok())
        .unwrap_or_default();

    let mgr = app.state::<SidecarManager>();
    super::chat::ensure_agent_proxy_reachable(proxy_url.as_deref()).await?;
    mgr.ensure_running(
        &resolved_api_key,
        "https://api.anthropic.com",
        &resolved_openai_key,
        &resolved_gemini_key,
        proxy_url.as_deref(),
        &app,
    )?;

    mgr.set_last_request_id(&request_id);

    // Use Explorer's opened folder (from frontend) as cwd; fall back to process cwd
    let cwd = cwd.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    let permission_mode = super::normalize_permission_mode(permission_mode, "agent");

    let team_configs: Vec<TeamMemberConfig> = team
        .into_iter()
        .map(|m| TeamMemberConfig {
            name: m.name,
            agent: m.agent,
            model: m.model,
            role: m.role,
        })
        .collect();

    let cmd = SidecarCommand::Orchestrate {
        id: request_id,
        task,
        team: team_configs,
        cwd,
        permission_mode,
        keys: OrchestrateKeys {
            anthropic_key: if resolved_api_key.is_empty() {
                None
            } else {
                Some(resolved_api_key)
            },
            openai_key: if resolved_openai_key.is_empty() {
                None
            } else {
                Some(resolved_openai_key)
            },
            gemini_key: if resolved_gemini_key.is_empty() {
                None
            } else {
                Some(resolved_gemini_key)
            },
        },
    };

    mgr.send_command(&cmd)?;
    Ok(())
}
