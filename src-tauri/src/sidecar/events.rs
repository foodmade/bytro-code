use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use super::protocol::{SidecarEvent, ToolDisplayMetaPayload};
use super::SidecarManager;

/// 每个请求是否已记录过首个 TextDelta。使用全局原子标志 + 请求ID缓存实现。
/// 简化实现：仅追踪"最近一次请求"的首个delta，避免 HashMap 内存泄漏。
static FIRST_DELTA_LOGGED: AtomicBool = AtomicBool::new(false);

fn event_diagnostic_summary(event_type: &str, value: &str) -> String {
    let safe_event: String = event_type
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_.:/-".contains(character) {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let digest = Sha256::digest(value.as_bytes());
    format!(
        "event={} len={} sha256={:x}",
        if safe_event.is_empty() {
            "message"
        } else {
            &safe_event
        },
        value.len(),
        digest
    )
}

fn public_stream_error(error: &str, status: Option<u16>) -> String {
    let normalized = error.to_ascii_lowercase();
    let category = if normalized.contains("abort") || normalized.contains("cancel") {
        "Provider request was cancelled"
    } else if status == Some(429) || normalized.contains("rate limit") || normalized.contains("429")
    {
        "Provider rate limit reached"
    } else if matches!(status, Some(401 | 403))
        || normalized.contains("unauthorized")
        || normalized.contains("authentication")
        || normalized.contains("credential")
    {
        "Provider authentication failed"
    } else if normalized.contains("timed out") || normalized.contains("timeout") {
        "Provider request timed out"
    } else if normalized.contains("not configured")
        || normalized.contains("configuration")
        || normalized.contains("base url is required")
    {
        "Provider configuration is incomplete"
    } else if normalized.contains("enoent")
        || normalized.contains("not found")
        || normalized.contains("unavailable")
    {
        "Required provider CLI is unavailable"
    } else if status == Some(400)
        || normalized.contains("invalid request")
        || normalized.contains("bad request")
        || normalized.contains("rejected the request")
    {
        "Provider rejected the request"
    } else if normalized.contains("network")
        || normalized.contains("connect")
        || normalized.contains("dns")
    {
        "Provider connection failed"
    } else {
        "Provider request failed"
    };
    let digest = format!("{:x}", Sha256::digest(error.as_bytes()));
    format!("{} (diagnosticId: {})", category, &digest[..12])
}

/// 重置首个 delta 追踪标志（每次新请求时应调用）。
pub(crate) fn reset_first_delta_tracking() {
    FIRST_DELTA_LOGGED.store(false, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Frontend event payloads (same structure as before, protocol unchanged)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub(crate) struct DeltaEvent {
    pub request_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CompleteEvent {
    pub request_id: String,
    pub full_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct StreamErrorEvent {
    pub request_id: String,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_status: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CodexAuthStartedFrontendEvent {
    pub request_id: String,
    pub profile_id: String,
    pub login_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CodexAuthCompletedFrontendEvent {
    pub request_id: String,
    pub profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_openai_auth: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CodexAuthSignedOutFrontendEvent {
    pub request_id: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CodexAuthErrorFrontendEvent {
    pub request_id: String,
    pub profile_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct StreamDoneEvent {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_alive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ToolUseEvent {
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub tool_input: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ToolResultFrontendEvent {
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub tool_input: String,
    pub success: bool,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<ToolDisplayMetaPayload>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ToolOutputFrontendEvent {
    pub request_id: String,
    pub tool_call_id: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ToolConfirmEvent {
    pub request_id: String,
    pub confirm_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub tool_input: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ToolDeniedFrontendEvent {
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionFrontendEvent {
    pub request_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MediaFrontendEvent {
    pub request_id: String,
    pub media_type: String,
    pub data: String,
}

// -- Orchestration frontend events --

#[derive(Debug, Clone, Serialize)]
pub(crate) struct OrchestrateStartFrontendEvent {
    pub request_id: String,
    pub team_size: u32,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubtaskStartFrontendEvent {
    pub request_id: String,
    pub subtask_id: String,
    pub assigned_to: String,
    pub agent: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubtaskCompleteFrontendEvent {
    pub request_id: String,
    pub subtask_id: String,
    pub assigned_to: String,
    pub result: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct OrchestrateCompleteFrontendEvent {
    pub request_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct UsageFrontendEvent {
    pub request_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub context_window: u64,
    pub model: String,
}

/// Real-time token usage from stream events (message_start / message_delta).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct StreamUsageFrontendEvent {
    pub request_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// Current context-window usage from provider snapshots.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ContextUsageFrontendEvent {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub requested_at: u64,
    pub total_tokens: u64,
    pub max_tokens: u64,
    pub percentage: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct GoalUpdatedFrontendEvent {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub goal: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct McpServerStatusPayload {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SlashCommandInfoPayload {
    pub name: String,
    pub description: String,
    /// Optional. Hint string for the command's arguments (e.g. "<file>", "[query]").
    /// Sourced from Claude CLI slash-command discovery. Filesystem-scanned
    /// .md commands don't carry this and serialize as `null`.
    #[serde(
        rename = "argumentHint",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub argument_hint: Option<String>,
    /// Optional. Alternate names that resolve to this command (e.g. /cost → /usage).
    /// Sourced from CLI slash-command discovery. Filesystem-scanned commands omit this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TodoItemPayload {
    pub content: String,
    pub status: String,
    #[serde(rename = "activeForm")]
    pub active_form: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TodoDiffEntryPayload {
    pub content: String,
    #[serde(rename = "changeType")]
    pub change_type: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "oldStatus")]
    pub old_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "newStatus")]
    pub new_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AskUserQuestionOptionPayload {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AskUserQuestionItemPayload {
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub header: String,
    #[serde(default)]
    pub options: Vec<AskUserQuestionOptionPayload>,
    #[serde(default, rename = "multiSelect")]
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AskUserQuestionFrontendEvent {
    pub request_id: String,
    pub confirm_id: String,
    pub tool_call_id: String,
    pub questions: Vec<AskUserQuestionItemPayload>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubagentStartedFrontendEvent {
    pub request_id: String,
    pub agent_id: String,
    pub agent_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubagentStoppedFrontendEvent {
    pub request_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubagentCompletedFrontendEvent {
    pub request_id: String,
    pub tool_use_id: String,
    pub result: String,
    pub subagent_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TaskStartedFrontendEvent {
    pub request_id: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TaskProgressFrontendEvent {
    pub request_id: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub total_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub tool_uses: Option<u32>,
    pub duration_ms: Option<u64>,
    pub last_tool_name: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TaskNotificationFrontendEvent {
    pub request_id: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub status: String,
    pub summary: Option<String>,
    pub total_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub tool_uses: Option<u32>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TodoUpdatedFrontendEvent {
    pub request_id: String,
    pub todos: Vec<TodoItemPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<Vec<TodoDiffEntryPayload>>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SystemInitFrontendEvent {
    pub request_id: String,
    pub tools: Vec<String>,
    pub mcp_servers: Vec<McpServerStatusPayload>,
    pub model: String,
    pub fast_mode_state: Option<String>,
    pub slash_commands: Vec<SlashCommandInfoPayload>,
}

/// Emitted when the Claude SDK begins context compaction.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct CompactFrontendEvent {
    pub request_id: String,
    pub trigger: String,
    pub pre_tokens: u64,
}

/// Emitted when the Claude SDK produces a thinking/reasoning delta.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ThinkingDeltaFrontendEvent {
    pub request_id: String,
    pub delta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_new_block: Option<bool>,
}

/// Subagent natural-language reply delta — routed to the subagent panel.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubagentTextDeltaFrontendEvent {
    pub request_id: String,
    pub subagent_session_id: String,
    pub parent_tool_use_id: String,
    pub delta: String,
}

/// Subagent thinking delta — routed to the subagent panel.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubagentThinkingDeltaFrontendEvent {
    pub request_id: String,
    pub subagent_session_id: String,
    pub parent_tool_use_id: String,
    pub delta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_new_block: Option<bool>,
}

/// Emitted by PostToolUse hook when a file-modifying tool completes.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct FileChangedFrontendEvent {
    pub request_id: String,
    pub file_path: String,
    pub action: String,
    pub tool_name: String,
    pub additions: u64,
    pub deletions: u64,
}

/// Emitted when the turn-level aggregated unified diff is updated (Codex mode).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TurnDiffFrontendEvent {
    pub request_id: String,
    pub diff: String,
}

/// Emitted by the Stop hook when the Claude SDK finishes a turn.
/// Powers the live-reviewer's PR-style batched review trigger.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TurnFinishedFrontendEvent {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_message: Option<String>,
}

/// Emitted when a user message UUID is captured from the SDK stream.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct UserMessageUuidFrontendEvent {
    pub request_id: String,
    pub uuid: String,
}

/// Emitted when a queued mid-stream user message is about to start a new turn.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct NewTurnFrontendEvent {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_name: Option<String>,
}

/// Result of a rewindFiles operation.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct RewindFilesResultFrontendEvent {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insertions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
}

/// Emitted when a persistent (warm) CLI session ends.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionEndedFrontendEvent {
    pub request_id: String,
    pub conversation_id: String,
}

/// Emitted when the CLI process crashes and all retries are exhausted —
/// the frontend should clear the sessionId so the next message starts fresh.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionInvalidatedFrontendEvent {
    pub request_id: String,
    pub conversation_id: String,
    pub reason: String,
}

/// Emitted when the sidecar retries a query after a transient/network error.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct StreamRetryFrontendEvent {
    pub request_id: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub reason: String,
}

// ---- Teams frontend events ----

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsStartFrontendEvent {
    pub request_id: String,
    pub agent_count: u32,
    pub agents: Vec<TeamsAgentInfoFrontend>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsAgentInfoFrontend {
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsAgentDeltaFrontendEvent {
    pub request_id: String,
    pub agent_name: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsAgentToolStartFrontendEvent {
    pub request_id: String,
    pub agent_name: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub tool_input: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsAgentToolResultFrontendEvent {
    pub request_id: String,
    pub agent_name: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub tool_input: String,
    pub success: bool,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<ToolDisplayMetaPayload>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsAgentStatusFrontendEvent {
    pub request_id: String,
    pub agent_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsAgentThinkingFrontendEvent {
    pub request_id: String,
    pub agent_name: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsStartupStatusFrontendEvent {
    pub request_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_delay_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_status: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsReadyFrontendEvent {
    pub request_id: String,
    pub agents: Vec<TeamsAgentInfoFrontend>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsCompleteFrontendEvent {
    pub request_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsErrorFrontendEvent {
    pub request_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamsMessageRoutedFrontendEvent {
    pub request_id: String,
    pub target_agent: String,
    pub content: String,
    pub timestamp: u64,
}

// ---------------------------------------------------------------------------
// Targeted emit helper
// ---------------------------------------------------------------------------

/// Emit an event to a specific window if `window_label` is Some and the window
/// still exists; otherwise fall back to global broadcast.
fn emit_to_window_or_broadcast<S: Serialize + Clone>(
    app: &AppHandle,
    window_label: Option<&str>,
    event: &str,
    payload: S,
) {
    if let Some(label) = window_label {
        // Tauri v2: use emit_to(label) for true window-scoped delivery.
        // The previous w.emit() was a global broadcast in Tauri v2, defeating
        // multi-window isolation. emit_to(label) only reaches listeners
        // registered via getCurrentWebviewWindow().listen() on the target window.
        let _ = app.emit_to(label, event, payload);
        return;
    }
    // Fallback: global broadcast (single-window mode, remote API, or window gone)
    let _ = app.emit(event, payload);
}

// ---------------------------------------------------------------------------
// Event translation: SidecarEvent -> Tauri emit (1:1 mapping)
// ---------------------------------------------------------------------------

pub(crate) fn translate_event(app: &AppHandle, event: SidecarEvent, window_label: Option<&str>) {
    match event {
        SidecarEvent::Ready => {
            // No frontend event needed
        }

        SidecarEvent::Session { id, session_id } => {
            eprintln!(
                "[sidecar-events] {}",
                event_diagnostic_summary(
                    "session.received",
                    &format!("request={id} session={session_id}")
                )
            );
            // Persist session_id to DB so remote-initiated chats can resume
            let mgr = app.state::<SidecarManager>();
            if let Some(conv_id) = mgr.find_conversation_for_request(&id) {
                if let Some(db) = app.try_state::<crate::memory::db::MemoryDb>() {
                    let sid = session_id.clone();
                    let _ = db.with_conn(|conn| {
                        crate::memory::repository::update_session_id(conn, &conv_id, &sid)
                    });
                }
            }

            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-session",
                SessionFrontendEvent {
                    request_id: id,
                    session_id,
                },
            );
        }

        SidecarEvent::TextDelta { id, delta } => {
            // 追踪首个 text_delta 经过 Rust 层的时机
            if !FIRST_DELTA_LOGGED.swap(true, Ordering::Relaxed) {
                eprintln!(
                    "[sidecar-events] {}",
                    event_diagnostic_summary("text_delta.first", &id)
                );
            }
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-delta",
                DeltaEvent {
                    request_id: id,
                    delta,
                },
            );
        }

        SidecarEvent::ToolStart {
            id,
            tool_call_id,
            tool_name,
            tool_input,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-tool-use",
                ToolUseEvent {
                    request_id: id,
                    tool_call_id,
                    tool_name,
                    tool_input,
                },
            );
        }

        SidecarEvent::ToolResult {
            id,
            tool_call_id,
            tool_name,
            tool_input,
            success,
            result,
            display,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-tool-result",
                ToolResultFrontendEvent {
                    request_id: id,
                    tool_call_id,
                    tool_name,
                    tool_input,
                    success,
                    result,
                    display,
                },
            );
        }

        SidecarEvent::ToolOutput {
            id,
            tool_call_id,
            output,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-tool-output",
                ToolOutputFrontendEvent {
                    request_id: id,
                    tool_call_id,
                    output,
                },
            );
        }

        SidecarEvent::PermissionRequest {
            id,
            confirm_id,
            tool_call_id,
            tool_name,
            tool_input,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-tool-confirm",
                ToolConfirmEvent {
                    request_id: id,
                    confirm_id,
                    tool_call_id,
                    tool_name,
                    tool_input,
                },
            );
        }

        SidecarEvent::ToolDenied {
            id,
            tool_call_id,
            tool_name,
            reason,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-tool-denied",
                ToolDeniedFrontendEvent {
                    request_id: id,
                    tool_call_id,
                    tool_name,
                    reason,
                },
            );
        }

        SidecarEvent::CodexAuthStarted {
            id,
            profile_id,
            login_id,
            auth_url,
            verification_url,
            user_code,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "codex-auth-started",
                CodexAuthStartedFrontendEvent {
                    request_id: id,
                    profile_id,
                    login_id,
                    auth_url,
                    verification_url,
                    user_code,
                },
            );
        }

        SidecarEvent::CodexAuthCompleted {
            id,
            profile_id,
            email,
            plan_type,
            requires_openai_auth,
            rate_limits,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "codex-auth-completed",
                CodexAuthCompletedFrontendEvent {
                    request_id: id,
                    profile_id,
                    email,
                    plan_type,
                    requires_openai_auth,
                    rate_limits,
                },
            );
        }

        SidecarEvent::CodexAuthSignedOut { id, profile_id } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "codex-auth-signed-out",
                CodexAuthSignedOutFrontendEvent {
                    request_id: id,
                    profile_id,
                },
            );
        }

        SidecarEvent::CodexAuthError {
            id,
            profile_id,
            error,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "codex-auth-error",
                CodexAuthErrorFrontendEvent {
                    request_id: id,
                    profile_id,
                    error,
                },
            );
        }

        SidecarEvent::Complete { id, full_text } => {
            // NOTE: Do NOT persist the assistant message here. The frontend's
            // chat-done handler calls persistMessage() with the correct message
            // ID, role (e.g. "codex"), and agent label. Saving here with a new
            // UUID and role="assistant" caused duplicate messages in history.
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-complete",
                CompleteEvent {
                    request_id: id,
                    full_text,
                },
            );
        }

        SidecarEvent::Done {
            id,
            session_alive,
            conversation_id,
        } => {
            // 重置首个 delta 追踪标志，为下一个请求做准备
            reset_first_delta_tracking();
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-done",
                StreamDoneEvent {
                    request_id: id,
                    session_alive,
                    conversation_id,
                },
            );
        }

        SidecarEvent::Error {
            id,
            error,
            api_error_status,
        } => {
            let public_error = public_stream_error(&error, api_error_status);
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-error",
                StreamErrorEvent {
                    request_id: id,
                    error: public_error,
                    error_status: api_error_status,
                },
            );
        }

        SidecarEvent::Media {
            id,
            media_type,
            data,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-media",
                MediaFrontendEvent {
                    request_id: id,
                    media_type,
                    data,
                },
            );
        }

        SidecarEvent::OrchestrateStart { id, team_size } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "orchestrate-start",
                OrchestrateStartFrontendEvent {
                    request_id: id,
                    team_size,
                },
            );
        }

        SidecarEvent::SubtaskStart {
            id,
            subtask_id,
            assigned_to,
            agent,
            description,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "orchestrate-subtask-start",
                SubtaskStartFrontendEvent {
                    request_id: id,
                    subtask_id,
                    assigned_to,
                    agent,
                    description,
                },
            );
        }

        SidecarEvent::SubtaskComplete {
            id,
            subtask_id,
            assigned_to,
            result,
            success,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "orchestrate-subtask-complete",
                SubtaskCompleteFrontendEvent {
                    request_id: id,
                    subtask_id,
                    assigned_to,
                    result,
                    success,
                },
            );
        }

        SidecarEvent::OrchestrateComplete { id, summary } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "orchestrate-complete",
                OrchestrateCompleteFrontendEvent {
                    request_id: id,
                    summary,
                },
            );
        }

        SidecarEvent::Usage {
            id,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            total_cost_usd,
            context_window,
            model,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-usage",
                UsageFrontendEvent {
                    request_id: id,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    total_cost_usd,
                    context_window,
                    model,
                },
            );
        }

        SidecarEvent::StreamUsage {
            id,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            context_window,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-stream-usage",
                StreamUsageFrontendEvent {
                    request_id: id,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    context_window,
                },
            );
        }

        SidecarEvent::ContextUsage {
            id,
            conversation_id,
            requested_at,
            total_tokens,
            max_tokens,
            percentage,
            snapshot,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-context-usage",
                ContextUsageFrontendEvent {
                    request_id: id,
                    conversation_id,
                    requested_at,
                    total_tokens,
                    max_tokens,
                    percentage,
                    snapshot,
                },
            );
        }

        SidecarEvent::GoalUpdated {
            id,
            conversation_id,
            thread_id,
            goal,
            source,
        } => {
            let goal_diagnostic = event_diagnostic_summary("goal.updated", &goal.to_string());
            eprintln!(
                "[goal-panel] source={:?} conversation_present={} thread_present={} {}",
                source,
                conversation_id.is_some(),
                thread_id.is_some(),
                goal_diagnostic
            );
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-goal-updated",
                GoalUpdatedFrontendEvent {
                    request_id: id,
                    conversation_id,
                    thread_id,
                    goal,
                    source,
                },
            );
        }

        SidecarEvent::SubagentStarted {
            id,
            agent_id,
            agent_type,
            name,
            description,
            prompt,
            session_id,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-subagent-started",
                SubagentStartedFrontendEvent {
                    request_id: id,
                    agent_id,
                    agent_type,
                    name,
                    description,
                    prompt,
                    session_id,
                },
            );
        }

        SidecarEvent::SubagentStopped { id, agent_id } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-subagent-stopped",
                SubagentStoppedFrontendEvent {
                    request_id: id,
                    agent_id,
                },
            );
        }

        SidecarEvent::SubagentCompleted {
            id,
            tool_use_id,
            result,
            subagent_type,
            agent_id,
            description,
            prompt,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-subagent-completed",
                SubagentCompletedFrontendEvent {
                    request_id: id,
                    tool_use_id,
                    result,
                    subagent_type,
                    agent_id,
                    description,
                    prompt,
                },
            );
        }

        SidecarEvent::TaskStarted {
            id,
            task_id,
            description,
            task_type,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-task-started",
                TaskStartedFrontendEvent {
                    request_id: id,
                    task_id,
                    description,
                    task_type,
                },
            );
        }

        SidecarEvent::TaskProgress {
            id,
            task_id,
            agent_id,
            total_tokens,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            tool_uses,
            duration_ms,
            last_tool_name,
            summary,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-task-progress",
                TaskProgressFrontendEvent {
                    request_id: id,
                    task_id,
                    agent_id,
                    total_tokens,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    tool_uses,
                    duration_ms,
                    last_tool_name,
                    summary,
                },
            );
        }

        SidecarEvent::TaskNotification {
            id,
            task_id,
            agent_id,
            status,
            summary,
            total_tokens,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            tool_uses,
            duration_ms,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-task-notification",
                TaskNotificationFrontendEvent {
                    request_id: id,
                    task_id,
                    agent_id,
                    status,
                    summary,
                    total_tokens,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    tool_uses,
                    duration_ms,
                },
            );
        }

        SidecarEvent::TodoUpdated { id, todos, diff } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-todo-updated",
                TodoUpdatedFrontendEvent {
                    request_id: id,
                    todos,
                    diff,
                },
            );
        }

        SidecarEvent::AskUserQuestion {
            id,
            confirm_id,
            tool_call_id,
            questions,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-ask-user-question",
                AskUserQuestionFrontendEvent {
                    request_id: id,
                    confirm_id,
                    tool_call_id,
                    questions,
                },
            );
        }

        SidecarEvent::SystemInit {
            id,
            tools,
            mcp_servers,
            model,
            fast_mode_state,
            slash_commands,
        } => {
            eprintln!(
                "[sidecar-events] system_init tools={} mcp_servers={} {}",
                tools.len(),
                mcp_servers.len(),
                event_diagnostic_summary("system_init.model", &model)
            );
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-system-init",
                SystemInitFrontendEvent {
                    request_id: id,
                    tools,
                    mcp_servers,
                    model,
                    fast_mode_state,
                    slash_commands,
                },
            );
        }

        SidecarEvent::Compact {
            id,
            trigger,
            pre_tokens,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-compact",
                CompactFrontendEvent {
                    request_id: id,
                    trigger,
                    pre_tokens,
                },
            );
        }

        SidecarEvent::ThinkingDelta {
            id,
            delta,
            kind,
            start_new_block,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-thinking-delta",
                ThinkingDeltaFrontendEvent {
                    request_id: id,
                    delta,
                    kind,
                    start_new_block,
                },
            );
        }

        SidecarEvent::SubagentTextDelta {
            id,
            subagent_session_id,
            parent_tool_use_id,
            delta,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-subagent-text-delta",
                SubagentTextDeltaFrontendEvent {
                    request_id: id,
                    subagent_session_id,
                    parent_tool_use_id,
                    delta,
                },
            );
        }

        SidecarEvent::SubagentThinkingDelta {
            id,
            subagent_session_id,
            parent_tool_use_id,
            delta,
            start_new_block,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-subagent-thinking-delta",
                SubagentThinkingDeltaFrontendEvent {
                    request_id: id,
                    subagent_session_id,
                    parent_tool_use_id,
                    delta,
                    start_new_block,
                },
            );
        }

        SidecarEvent::FileChanged {
            id,
            file_path,
            action,
            tool_name,
            additions,
            deletions,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-file-changed",
                FileChangedFrontendEvent {
                    request_id: id,
                    file_path,
                    action,
                    tool_name,
                    additions,
                    deletions,
                },
            );
        }

        SidecarEvent::TurnDiff { id, diff } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-turn-diff",
                TurnDiffFrontendEvent {
                    request_id: id,
                    diff,
                },
            );
        }

        SidecarEvent::TurnFinished {
            id,
            last_assistant_message,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-turn-finished",
                TurnFinishedFrontendEvent {
                    request_id: id,
                    last_assistant_message,
                },
            );
        }

        SidecarEvent::UserMessageUuid { id, uuid } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-user-message-uuid",
                UserMessageUuidFrontendEvent {
                    request_id: id,
                    uuid,
                },
            );
        }

        SidecarEvent::NewTurn { id, command_name } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-new-turn",
                NewTurnFrontendEvent {
                    request_id: id,
                    command_name,
                },
            );
        }

        SidecarEvent::RewindFilesResult {
            id,
            success,
            error,
            files_changed,
            insertions,
            deletions,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-rewind-result",
                RewindFilesResultFrontendEvent {
                    request_id: id,
                    success,
                    error,
                    files_changed,
                    insertions,
                    deletions,
                },
            );
        }

        // ---- Teams Events ----
        SidecarEvent::TeamsStart {
            id,
            agent_count,
            agents,
        } => {
            eprintln!(
                "[teams-bridge] teams-start count={} {}",
                agent_count,
                event_diagnostic_summary(
                    "teams.start.agents",
                    &agents
                        .iter()
                        .map(|agent| agent.name.as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            );
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-start",
                TeamsStartFrontendEvent {
                    request_id: id,
                    agent_count,
                    agents: agents
                        .into_iter()
                        .map(|a| TeamsAgentInfoFrontend {
                            name: a.name,
                            role: a.role,
                        })
                        .collect(),
                },
            );
        }

        SidecarEvent::TeamsAgentDelta {
            id,
            agent_name,
            delta,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-agent-delta",
                TeamsAgentDeltaFrontendEvent {
                    request_id: id,
                    agent_name,
                    delta,
                },
            );
        }

        SidecarEvent::TeamsAgentToolStart {
            id,
            agent_name,
            tool_call_id,
            tool_name,
            tool_input,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-agent-tool-start",
                TeamsAgentToolStartFrontendEvent {
                    request_id: id,
                    agent_name,
                    tool_call_id,
                    tool_name,
                    tool_input,
                },
            );
        }

        SidecarEvent::TeamsAgentToolResult {
            id,
            agent_name,
            tool_call_id,
            tool_name,
            tool_input,
            success,
            result,
            display,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-agent-tool-result",
                TeamsAgentToolResultFrontendEvent {
                    request_id: id,
                    agent_name,
                    tool_call_id,
                    tool_name,
                    tool_input,
                    success,
                    result,
                    display,
                },
            );
        }

        SidecarEvent::TeamsAgentStatus {
            id,
            agent_name,
            status,
            message,
        } => {
            let message_diagnostic = event_diagnostic_summary(
                "teams.agent_status.message",
                message.as_deref().unwrap_or_default(),
            );
            eprintln!(
                "[teams-bridge] agent-status status={} message_present={} agent={} {}",
                status,
                message.is_some(),
                event_diagnostic_summary("teams.agent_status.agent", &agent_name),
                message_diagnostic
            );
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-agent-status",
                TeamsAgentStatusFrontendEvent {
                    request_id: id,
                    agent_name,
                    status,
                    message,
                },
            );
        }

        SidecarEvent::TeamsAgentThinking {
            id,
            agent_name,
            delta,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-agent-thinking",
                TeamsAgentThinkingFrontendEvent {
                    request_id: id,
                    agent_name,
                    delta,
                },
            );
        }

        SidecarEvent::TeamsStartupStatus {
            id,
            status,
            message,
            attempt,
            max_attempts,
            retry_delay_ms,
            error_status,
        } => {
            let public_message = message
                .as_deref()
                .map(|value| public_stream_error(value, error_status));
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-startup-status",
                TeamsStartupStatusFrontendEvent {
                    request_id: id,
                    status,
                    message: public_message,
                    attempt,
                    max_attempts,
                    retry_delay_ms,
                    error_status,
                },
            );
        }

        SidecarEvent::TeamsReady { id, agents } => {
            let agent_names = agents
                .iter()
                .map(|agent| agent.name.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            eprintln!(
                "[teams-bridge] teams-ready count={} {}",
                agents.len(),
                event_diagnostic_summary("teams.ready.agents", &agent_names)
            );
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-ready",
                TeamsReadyFrontendEvent {
                    request_id: id,
                    agents: agents
                        .into_iter()
                        .map(|a| TeamsAgentInfoFrontend {
                            name: a.name,
                            role: a.role,
                        })
                        .collect(),
                },
            );
        }

        SidecarEvent::TeamsComplete { id, summary } => {
            eprintln!("[teams-bridge] teams-complete");
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-complete",
                TeamsCompleteFrontendEvent {
                    request_id: id,
                    summary,
                },
            );
        }

        SidecarEvent::TeamsError { id, error } => {
            let public_error = public_stream_error(&error, None);
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-error",
                TeamsErrorFrontendEvent {
                    request_id: id,
                    error: public_error,
                },
            );
        }

        SidecarEvent::TeamsMessageRouted {
            id,
            target_agent,
            content,
            timestamp,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "teams-message-routed",
                TeamsMessageRoutedFrontendEvent {
                    request_id: id,
                    target_agent,
                    content,
                    timestamp,
                },
            );
        }

        SidecarEvent::SessionEnded {
            id,
            conversation_id,
        } => {
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-session-ended",
                SessionEndedFrontendEvent {
                    request_id: id,
                    conversation_id,
                },
            );
        }

        SidecarEvent::SessionInvalidated {
            id,
            conversation_id,
            reason,
        } => {
            log::warn!(
                "[sidecar-events] session invalidated {}",
                event_diagnostic_summary(
                    "session.invalidated",
                    &format!("conversation={conversation_id} reason={reason}")
                )
            );

            // Fix C: 会话因 session_not_found 等原因失效时，清空数据库中的活跃
            // session_id，保留 previous_session_ids 链，避免下次打开该会话时再次
            // 用失效 sessionId 尝试 resume。
            let should_clear = reason == "session_not_found"
                || reason == "process_exit_fresh_start"
                || reason.contains("session_not_found");
            if should_clear && !conversation_id.is_empty() {
                if let Some(db) = app.try_state::<crate::memory::db::MemoryDb>() {
                    let conv_id = conversation_id.clone();
                    let _ = db.with_conn(|conn| {
                        conn.execute(
                            "UPDATE conversations SET session_id = NULL WHERE id = ?1",
                            rusqlite::params![conv_id],
                        )
                    });
                    log::warn!(
                        "[sidecar-events] cleared invalid session {}",
                        event_diagnostic_summary("session.invalidated_cleared", &conversation_id)
                    );
                }
            }

            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-session-invalidated",
                SessionInvalidatedFrontendEvent {
                    request_id: id,
                    conversation_id,
                    reason,
                },
            );
        }

        SidecarEvent::StreamRetry {
            id,
            attempt,
            max_attempts,
            reason,
        } => {
            let public_reason = public_stream_error(&reason, None);
            emit_to_window_or_broadcast(
                app,
                window_label,
                "chat-stream-retry",
                StreamRetryFrontendEvent {
                    request_id: id,
                    attempt,
                    max_attempts,
                    reason: public_reason,
                },
            );
        }
    }
}

#[cfg(test)]
mod privacy_tests {
    use super::{event_diagnostic_summary, public_stream_error};

    #[test]
    fn event_diagnostics_never_include_raw_goal_or_status_text() {
        let sentinel = "SECRET_SENTINEL objective=private token=sk-private /Users/private";
        let summary = event_diagnostic_summary("goal.updated", sentinel);

        assert!(summary.starts_with("event=goal.updated len="));
        assert!(summary.contains("sha256="));
        assert!(!summary.contains("SECRET_SENTINEL"));
        assert!(!summary.contains("sk-private"));
        assert!(!summary.contains("/Users/private"));
    }

    #[test]
    fn stream_errors_expose_only_category_and_bounded_diagnostic_id() {
        let sentinels = [
            "/Users/private/project",
            "opaque-token-Z9x7Q2",
            "write the unreleased acquisition memo",
        ];
        let raw = format!(
            "authentication failed provider_body={} token={} prompt={}",
            sentinels[0], sentinels[1], sentinels[2]
        );
        let public = public_stream_error(&raw, Some(401));

        assert!(public.starts_with("Provider authentication failed (diagnosticId: "));
        assert_eq!(
            public.len(),
            "Provider authentication failed (diagnosticId: )".len() + 12
        );
        for sentinel in sentinels {
            assert!(!public.contains(sentinel));
        }
    }

    #[test]
    fn stream_error_categories_preserve_actionable_status() {
        assert!(public_stream_error("provider body", Some(429))
            .starts_with("Provider rate limit reached"));
        assert!(public_stream_error("request timed out provider body", None)
            .starts_with("Provider request timed out"));
        assert!(
            public_stream_error("API key is not configured provider body", None)
                .starts_with("Provider configuration is incomplete")
        );
    }
}
