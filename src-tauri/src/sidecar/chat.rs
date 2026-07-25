use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpStream;
use tokio::time::timeout;

use super::events::StreamErrorEvent;
use super::protocol::SidecarCommand;
use super::{normalize_permission_mode, SidecarManager, VALID_PERMISSION_MODES};
use crate::anthropic::{parse_proxy_endpoint, Message};

// ---------------------------------------------------------------------------
// Tauri commands: chat
// ---------------------------------------------------------------------------

pub(crate) async fn ensure_agent_proxy_reachable(proxy_url: Option<&str>) -> Result<(), String> {
    let Some(proxy_url) = proxy_url.map(str::trim).filter(|url| !url.is_empty()) else {
        return Ok(());
    };
    let (host, port) = parse_proxy_endpoint(proxy_url)?;
    match timeout(Duration::from_secs(5), TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(_stream)) => Ok(()),
        Ok(Err(e)) => Err(format!(
            "Agent proxy is unreachable ({}:{}): {}. Disable Agent Proxy or fix Settings > Models > Advanced Settings.",
            host, port, e
        )),
        Err(_) => Err(format!(
            "Agent proxy is unreachable ({}:{}): connection timed out after 5s. Disable Agent Proxy or fix Settings > Models > Advanced Settings.",
            host, port
        )),
    }
}

/// All parameters for a `stream_chat` invocation, deserialized from the
/// frontend `invoke("stream_chat", { ... })` payload in one step.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChatRequest {
    pub request_id: String,
    pub agent: Option<String>,
    pub messages: Vec<Message>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub system: Option<String>,
    pub permission_mode: Option<String>,
    pub session_id: Option<String>,
    pub images: Option<Vec<crate::anthropic::ImageData>>,
    pub proxy_url: Option<String>,
    pub cwd: Option<String>,
    pub mcp_servers: Option<serde_json::Value>,
    pub conversation_id: Option<String>,
    pub disable_tools: Option<bool>,
    /// Whether extended thinking / reasoning is enabled (legacy).
    pub thinking_enabled: Option<bool>,
    /// Reasoning effort level: "off" | "low" | "medium" | "high" | "max".
    pub reasoning_level: Option<String>,
    pub ultracode: Option<bool>,
    /// Claude fast mode — wired into the SDK `fastMode` session setting by the
    /// sidecar Claude handler. Claude only; other agents ignore it.
    pub fast_mode: Option<bool>,
    /// Default quality for the openai_images MCP tool: "low" | "medium" | "high" | "auto".
    pub image_gen_quality: Option<String>,
    /// Default size for the openai_images MCP tool. One of the popular
    /// gpt-image-2 presets (e.g. "1024x1024" / "2048x2048" / "3840x2160" / "auto").
    pub image_gen_size: Option<String>,
    /// User-configured outputs directory override; empty / None falls back to
    /// `<app_data_dir>/outputs`.
    pub outputs_dir: Option<String>,
    /// Codex App Server service tier override, e.g. "fast".
    pub service_tier: Option<String>,
    /// Enable Codex App Server Goals mode for this request.
    pub goal_mode_enabled: Option<bool>,
    /// Platform identifier (e.g. "claude", "codex", "gemini", "grok").
    pub platform: Option<String>,
    /// Health-check dimension prompts — injected by PreToolUse hook in the sidecar.
    pub dimension_prompts: Option<serde_json::Value>,
    /// Ollama num_ctx override.
    pub num_ctx: Option<u32>,
    /// Slash-command metadata. Passed through opaquely to the sidecar; Codex
    /// inspects `canonicalName` to route /compact via `thread/compact/start`
    /// instead of treating it as a turn/start input. Other agents ignore it.
    pub command_invocation: Option<serde_json::Value>,
    /// Caveman compression mode — "off" or "full". Sidecar appends caveman
    /// ruleset to the system prompt when "full" (Claude handler only for now).
    pub caveman_mode: Option<String>,
    pub auth_mode: Option<String>,
    pub profile_id: Option<String>,
    /// Rust-owned OAuth lookup provider. Never contains credential data.
    pub oauth_provider: Option<String>,
    /// Conversation fork: resume the source session but branch to a new session
    /// id (SDK `forkSession`). Set only on a forked conversation's first turn.
    pub fork_session: Option<bool>,
    /// Conversation fork anchor — resume up to and including this message uuid
    /// (SDK `resumeSessionAt`). Pairs with `fork_session`.
    pub resume_session_at: Option<String>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_chat(
    app: AppHandle,
    window: tauri::Window,
    request_id: String,
    agent: Option<String>,
    messages: Vec<Message>,
    model: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    system: Option<String>,
    permission_mode: Option<String>,
    session_id: Option<String>,
    images: Option<Vec<crate::anthropic::ImageData>>,
    proxy_url: Option<String>,
    cwd: Option<String>,
    mcp_servers: Option<serde_json::Value>,
    conversation_id: Option<String>,
    disable_tools: Option<bool>,
    thinking_enabled: Option<bool>,
    reasoning_level: Option<String>,
    ultracode: Option<bool>,
    fast_mode: Option<bool>,
    image_gen_quality: Option<String>,
    image_gen_size: Option<String>,
    service_tier: Option<String>,
    goal_mode_enabled: Option<bool>,
    platform: Option<String>,
    dimension_prompts: Option<serde_json::Value>,
    num_ctx: Option<u32>,
    outputs_dir: Option<String>,
    command_invocation: Option<serde_json::Value>,
    caveman_mode: Option<String>,
    auth_mode: Option<String>,
    profile_id: Option<String>,
    oauth_provider: Option<String>,
    fork_session: Option<bool>,
    resume_session_at: Option<String>,
) -> Result<(), String> {
    let req = StreamChatRequest {
        request_id,
        agent,
        messages,
        model,
        base_url,
        api_key,
        system,
        permission_mode,
        session_id,
        images,
        proxy_url,
        cwd,
        mcp_servers,
        conversation_id,
        disable_tools,
        thinking_enabled,
        reasoning_level,
        ultracode,
        fast_mode,
        image_gen_quality,
        image_gen_size,
        service_tier,
        goal_mode_enabled,
        platform,
        dimension_prompts,
        num_ctx,
        outputs_dir,
        command_invocation,
        caveman_mode,
        auth_mode,
        profile_id,
        oauth_provider,
        fork_session,
        resume_session_at,
    };
    stream_chat_inner(app, req, Some(window.label().to_string())).await
}

/// Inner implementation that accepts a single `StreamChatRequest`.
pub(crate) async fn stream_chat_inner(
    app: AppHandle,
    req: StreamChatRequest,
    window_label: Option<String>,
) -> Result<(), String> {
    let agent_type = req.agent.unwrap_or_else(|| "claude".to_string());

    let StreamChatRequest {
        request_id,
        messages,
        model,
        base_url,
        api_key,
        system,
        permission_mode,
        session_id,
        images,
        proxy_url,
        cwd,
        mcp_servers,
        conversation_id,
        disable_tools,
        thinking_enabled,
        reasoning_level,
        ultracode,
        fast_mode,
        image_gen_quality,
        image_gen_size,
        service_tier,
        goal_mode_enabled,
        platform,
        dimension_prompts,
        num_ctx,
        outputs_dir,
        command_invocation,
        caveman_mode,
        auth_mode,
        profile_id,
        oauth_provider,
        fork_session,
        resume_session_at,
        ..
    } = req;

    // Resolve model with sensible defaults per agent type.
    let resolved_model = model.unwrap_or_else(|| match agent_type.as_str() {
        "codex" => "codex-mini-latest".to_string(),
        "chatcmpl" => "deepseek-chat".to_string(),
        "gemini" => "gemini-2.5-flash".to_string(),
        _ => "claude-opus-4-7".to_string(),
    });

    // Community Edition only uses the active local profile supplied by the
    // frontend. Provider OAuth remains supported and intentionally carries no
    // API key in this command.
    let resolved_api_key = api_key.unwrap_or_default();
    let resolved_base_url = match base_url.filter(|url| !url.trim().is_empty()) {
        Some(url) => crate::anthropic::validate_api_base_url(&url)?,
        None => String::new(),
    };

    let permission_mode = normalize_permission_mode(permission_mode, "default");
    let system_prompt = system.unwrap_or_default();

    // Validate permission mode
    if !VALID_PERMISSION_MODES.contains(&permission_mode.as_str()) {
        return Err(format!(
            "Invalid permission mode '{}'. Must be one of: {}",
            permission_mode,
            VALID_PERMISSION_MODES.join(", ")
        ));
    }

    // OAuth profiles cross the WebView boundary only as a provider/profile
    // reference. Codex resolves its own CLI login; Claude is resolved from the
    // Rust token store immediately before the local sidecar write.
    let is_codex_oauth = agent_type == "codex" && auth_mode.as_deref() == Some("oauth");
    let is_claude_oauth = agent_type == "claude" && auth_mode.as_deref() == Some("oauth");
    let claude_oauth_reference = if is_claude_oauth {
        Some(crate::oauth::commands::validate_credential_reference(
            oauth_provider.as_deref(),
            profile_id.as_deref(),
        )?)
    } else {
        None
    };
    if resolved_api_key.is_empty() && !is_codex_oauth && !is_claude_oauth {
        let provider_name = match agent_type.as_str() {
            "codex" | "chatcmpl" => "OpenAI-compatible",
            "gemini" => "Google Gemini",
            _ => "Anthropic",
        };
        let _ = app.emit(
            "chat-error",
            StreamErrorEvent {
                request_id,
                error: format!(
                    "{} API key is not configured. Go to Settings > Models to set it.",
                    provider_name
                ),
                error_status: None,
            },
        );
        return Err(format!("{} API key not configured", provider_name));
    }

    // Extract the last user message as prompt for the SDK
    let prompt = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    if prompt.is_empty() {
        return Err("No user message found in messages".to_string());
    }

    if let Err(error) = ensure_agent_proxy_reachable(proxy_url.as_deref()).await {
        let _ = app.emit(
            "chat-error",
            StreamErrorEvent {
                request_id,
                error: error.clone(),
                error_status: None,
            },
        );
        return Err(error);
    }

    let mgr = app.state::<SidecarManager>();
    mgr.ensure_running(
        &resolved_api_key,
        &resolved_base_url,
        "",
        "",
        proxy_url.as_deref(),
        &app,
    )?;

    // Use Explorer's opened folder (from frontend) as cwd; fall back to process cwd
    let cwd = cwd.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    // Validate JSONL file existence for Claude resume sessions.
    // Claude CLI generates a NEW session_id per turn, writing a new JSONL
    // file (copying prior turns + appending current turn). If the app crashes
    // between session_id emission and JSONL flush, the stored session_id points
    // to a non-existent/incomplete JSONL, causing "No conversation found" errors
    // that trigger an infinite resume-retry loop.
    //
    // Strategy:
    //   1. If current sessionId's JSONL exists → keep it.
    //   2. Else → walk `previous_session_ids` chain (newest→oldest) and find the
    //      most recent sessionId with an existing JSONL. Resuming from an older
    //      turn loses only the last N turns instead of the whole session.
    //   3. Else → clear sessionId so sidecar starts fresh with SQLite history.
    let session_id: Option<String> = if agent_type == "claude" {
        match session_id {
            Some(sid) => {
                let is_non_claude =
                    sid.starts_with("oai-") || sid.starts_with("gem-") || sid.starts_with("ccmpl-");
                if is_non_claude || crate::memory::jsonl::find_jsonl_path(&sid, &cwd).is_some() {
                    Some(sid)
                } else {
                    let recovered: Option<String> = (|| -> Option<String> {
                        let conv_id = conversation_id.as_ref()?;
                        let db = app.try_state::<crate::memory::db::MemoryDb>()?;
                        let chain: Option<String> = db
                            .with_conn(|conn| {
                                conn.query_row(
                                    "SELECT previous_session_ids FROM conversations WHERE id = ?1",
                                    rusqlite::params![conv_id],
                                    |row| row.get::<_, Option<String>>(0),
                                )
                            })
                            .ok()
                            .flatten();
                        let chain = chain?;
                        chain
                            .split(',')
                            .rev()
                            .map(|s| s.trim().to_string())
                            .find(|s| {
                                !s.is_empty()
                                    && crate::memory::jsonl::find_jsonl_path(s, &cwd).is_some()
                            })
                    })();

                    match recovered {
                        Some(r) => {
                            eprintln!(
                                "[chat.rs] JSONL missing for sid={}, recovered via previous_session_ids chain to sid={}",
                                sid, r
                            );
                            Some(r)
                        }
                        None => {
                            eprintln!(
                                "[chat.rs] JSONL missing for sid={} and no recoverable chain — clearing sessionId, will start fresh with SQLite history",
                                sid
                            );
                            None
                        }
                    }
                }
            }
            None => None,
        }
    } else {
        session_id
    };

    // Pass the unified api_key and base_url directly to sidecar
    let sidecar_api_key = if resolved_api_key.is_empty() {
        None
    } else {
        Some(resolved_api_key)
    };
    let sidecar_base_url = if resolved_base_url.is_empty() {
        None
    } else {
        Some(resolved_base_url)
    };

    // Pass conversation history to sidecar for cross-model context preservation.
    // For the Claude agent with an existing session: skip sending history.
    let is_claude_with_session = agent_type == "claude" && session_id.is_some();
    let sidecar_messages = if is_claude_with_session {
        None
    } else {
        let history_messages: Vec<Message> = messages
            .iter()
            .rev()
            .skip_while(|m| m.role == "user")
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .cloned()
            .collect();
        if history_messages.is_empty() {
            None
        } else {
            Some(history_messages)
        }
    };

    // Resolve against the Rust-owned native-picker allowlist. A frontend path
    // is never enough to broaden the asset protocol scope.
    let resolved_outputs_path = crate::outputs::resolve_effective(&app, outputs_dir.as_deref())?;
    crate::outputs::allow_asset_access(&app, &resolved_outputs_path);
    let resolved_outputs_dir = Some(resolved_outputs_path.to_string_lossy().to_string());

    let mcp_servers = crate::sidecar::mcp_oauth::mcp_servers_with_oauth_headers(
        &app.state::<crate::memory::db::MemoryDb>(),
        mcp_servers,
    )
    .await;

    let sidecar_api_key = if let Some(reference) = claude_oauth_reference {
        match crate::oauth::commands::load_fresh_token(
            &app,
            &app.state::<crate::memory::db::MemoryDb>(),
            &reference.provider,
            &reference.profile_id,
            proxy_url.as_deref(),
        )
        .await
        {
            Ok(token_info) => Some(token_info.access_token),
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
        sidecar_api_key
    };

    // Track only after all preflight and credential resolution succeeds.
    mgr.set_last_request_id(&request_id);
    mgr.track_request(&request_id, conversation_id.clone(), window_label.clone());

    let cmd = SidecarCommand::Query {
        // request_id 后面 send_command 失败分支还要用来 untrack_request /
        // clear_last_request_id_if_matches,这里克隆一份给命令本身。
        id: request_id.clone(),
        agent: agent_type,
        prompt,
        model: resolved_model,
        system_prompt,
        permission_mode,
        cwd,
        session_id,
        api_key: sidecar_api_key,
        base_url: sidecar_base_url,
        auth_mode,
        profile_id,
        proxy_url,
        platform,
        images,
        messages: sidecar_messages,
        mcp_servers,
        disable_tools,
        thinking_enabled,
        reasoning_level,
        ultracode,
        fast_mode,
        image_gen_quality,
        image_gen_size,
        outputs_dir: resolved_outputs_dir,
        service_tier,
        goal_mode_enabled,
        conversation_id,
        dimension_prompts,
        num_ctx,
        command_invocation,
        caveman_mode,
        fork_session,
        resume_session_at,
    };

    if let Err(e) = mgr.send_command(&cmd) {
        mgr.untrack_request(&request_id);
        mgr.clear_last_request_id_if_matches(&request_id);
        return Err(e);
    }
    Ok(())
}

/// Inner function callable without AppHandle (used by remote API).
pub fn respond_tool_confirmation_inner(
    mgr: &SidecarManager,
    confirm_id: &str,
    approved: bool,
) -> Result<(), String> {
    let cmd = SidecarCommand::PermissionResponse {
        confirm_id: confirm_id.to_string(),
        approved,
    };
    mgr.send_command(&cmd)
}

#[tauri::command]
pub fn respond_tool_confirmation(
    app: AppHandle,
    confirm_id: String,
    approved: bool,
) -> Result<(), String> {
    let mgr = app.state::<SidecarManager>();
    respond_tool_confirmation_inner(&mgr, &confirm_id, approved)
}

#[tauri::command]
pub fn respond_ask_user_question(
    app: AppHandle,
    confirm_id: String,
    answers: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let mgr = app.state::<SidecarManager>();
    let cmd = SidecarCommand::AskUserQuestionResponse {
        confirm_id,
        answers,
    };
    mgr.send_command(&cmd)
}

/// Send a mid-stream user message to an active Claude conversation.
#[tauri::command]
pub async fn send_user_input(
    app: AppHandle,
    request_id: String,
    content: String,
    images: Option<Vec<crate::anthropic::ImageData>>,
    reasoning_level: Option<String>,
    command_invocation: Option<serde_json::Value>,
    proxy_url: Option<String>,
) -> Result<(), String> {
    let has_images = images.as_ref().is_some_and(|v| !v.is_empty());
    if content.trim().is_empty() && !has_images {
        return Err("Cannot send empty message".to_string());
    }
    ensure_agent_proxy_reachable(proxy_url.as_deref()).await?;
    let mgr = app.state::<SidecarManager>();
    let cmd = SidecarCommand::UserInput {
        id: request_id,
        content,
        images,
        reasoning_level,
        command_invocation,
    };
    mgr.send_command(&cmd)
}

/// Inner function callable without AppHandle (used by remote API).
pub fn abort_chat_inner(mgr: &SidecarManager, request_id: &str) -> Result<(), String> {
    mgr.clear_last_request_id();
    mgr.untrack_request(request_id);
    let cmd = SidecarCommand::Abort {
        id: request_id.to_string(),
    };
    mgr.send_command(&cmd)
}

#[tauri::command]
pub fn abort_chat(app: AppHandle, request_id: String) -> Result<(), String> {
    let mgr = app.state::<SidecarManager>();
    abort_chat_inner(&mgr, &request_id)
}

#[tauri::command]
pub fn rewind_files(
    app: AppHandle,
    request_id: String,
    user_message_uuid: String,
) -> Result<(), String> {
    let mgr = app.state::<SidecarManager>();
    let cmd = SidecarCommand::RewindFiles {
        id: request_id,
        user_message_uuid,
    };
    mgr.send_command(&cmd)
}

#[tauri::command]
pub fn kill_session(app: AppHandle, conversation_id: String) -> Result<(), String> {
    let mgr = app.state::<SidecarManager>();
    let cmd = SidecarCommand::KillSession { conversation_id };
    mgr.send_command(&cmd)
}
