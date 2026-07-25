use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use super::events::StreamErrorEvent;
use super::protocol::{SidecarCommand, TeamsAgentConfigPayload};
use super::{normalize_permission_mode, SidecarManager, VALID_PERMISSION_MODES};

// ---------------------------------------------------------------------------
// Tauri commands: teams chat
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsAgentConfigRequest {
    pub name: String,
    pub role: String,
    pub description: String,
    pub prompt: String,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_teams_chat(
    app: AppHandle,
    window: tauri::Window,
    request_id: String,
    task: String,
    agents: Vec<TeamsAgentConfigRequest>,
    cwd: Option<String>,
    permission_mode: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    auth_mode: Option<String>,
    profile_id: Option<String>,
    oauth_provider: Option<String>,
    proxy_url: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    mcp_servers: Option<serde_json::Value>,
    response_language: Option<String>,
) -> Result<(), String> {
    let permission_mode = normalize_permission_mode(permission_mode, "default");

    // Validate permission mode
    if !VALID_PERMISSION_MODES.contains(&permission_mode.as_str()) {
        return Err(format!(
            "Invalid permission mode '{}'. Must be one of: {}",
            permission_mode,
            VALID_PERMISSION_MODES.join(", ")
        ));
    }

    // Validate at least one agent
    if agents.is_empty() {
        return Err("At least one agent is required".to_string());
    }

    // Validate task is not empty
    if task.trim().is_empty() {
        return Err("Task description cannot be empty".to_string());
    }

    // Teams mode runs through the Claude-compatible SDK and only accepts the
    // active local profile supplied by the frontend.
    let is_third_party = matches!(
        provider.as_deref(),
        Some("zenmux") | Some("deepseek") | Some("qwen") | Some("bigmodel")
    );

    let is_oauth = auth_mode.as_deref() == Some("oauth");
    let oauth_reference = if is_oauth {
        Some(crate::oauth::commands::validate_credential_reference(
            oauth_provider.as_deref(),
            profile_id.as_deref(),
        )?)
    } else {
        None
    };
    let resolved_api_key = api_key.filter(|key| !key.trim().is_empty());
    if resolved_api_key.is_none() && oauth_reference.is_none() {
        let error = "Anthropic API key is not configured. Go to Settings > Models to set it.";
        let _ = app.emit(
            "chat-error",
            StreamErrorEvent {
                request_id: request_id.clone(),
                error: error.to_string(),
                error_status: None,
            },
        );
        return Err("Anthropic API key not configured".to_string());
    }
    let resolved_api_key = resolved_api_key.unwrap_or_default();
    let resolved_base_url = match base_url.filter(|url| !url.trim().is_empty()) {
        Some(url) => crate::anthropic::validate_api_base_url(&url)?,
        None if is_third_party => {
            return Err("Base URL is required for this provider profile".to_string())
        }
        None => crate::anthropic::validate_api_base_url("https://api.anthropic.com")?,
    };

    let cwd = cwd.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    super::chat::ensure_agent_proxy_reachable(proxy_url.as_deref()).await?;
    let claude_binary_path = crate::provider_cli::ensure_provider_cli(
        &app,
        crate::provider_cli::ProviderCli::Claude,
        proxy_url.as_deref(),
    )
    .await?;

    let mgr = app.state::<SidecarManager>();
    mgr.ensure_running(
        &resolved_api_key,
        &resolved_base_url,
        "",
        "",
        proxy_url.as_deref(),
        &app,
    )?;
    // Convert agent configs
    let agent_configs: Vec<TeamsAgentConfigPayload> = agents
        .into_iter()
        .map(|a| TeamsAgentConfigPayload {
            name: a.name,
            role: a.role,
            description: a.description,
            prompt: a.prompt,
            tools: a.tools,
            model: a.model,
        })
        .collect();

    let mcp_servers = crate::sidecar::mcp_oauth::mcp_servers_with_oauth_headers(
        &app.state::<crate::memory::db::MemoryDb>(),
        mcp_servers,
    )
    .await;

    let resolved_api_key = if let Some(reference) = oauth_reference {
        match crate::oauth::commands::load_fresh_token(
            &app,
            &app.state::<crate::memory::db::MemoryDb>(),
            &reference.provider,
            &reference.profile_id,
            proxy_url.as_deref(),
        )
        .await
        {
            Ok(token_info) => token_info.access_token,
            Err(error) => {
                let _ = app.emit(
                    "chat-error",
                    StreamErrorEvent {
                        request_id: request_id.clone(),
                        error: error.clone(),
                        error_status: None,
                    },
                );
                return Err(error);
            }
        }
    } else {
        resolved_api_key
    };

    mgr.set_last_request_id(&request_id);
    mgr.track_request(&request_id, None, Some(window.label().to_string()));

    let cmd = SidecarCommand::TeamsQuery {
        id: request_id,
        task,
        agents: agent_configs,
        cwd,
        permission_mode,
        api_key: Some(resolved_api_key),
        base_url: Some(resolved_base_url),
        proxy_url,
        provider,
        model,
        mcp_servers,
        response_language,
        claude_binary_path,
    };

    mgr.send_command(&cmd)?;
    Ok(())
}
