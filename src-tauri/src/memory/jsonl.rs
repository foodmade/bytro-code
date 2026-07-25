use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::models::{Message, MessagePage};

const MAX_JSONL_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_JSONL_EVENTS: usize = 200_000;
const MAX_PROJECT_DIRECTORIES: usize = 4096;

fn claude_root_for_jsonl(path: &Path) -> Result<PathBuf, String> {
    for ancestor in path.ancestors() {
        if ancestor.file_name().and_then(|name| name.to_str()) != Some(".claude") {
            continue;
        }
        let relative = path
            .strip_prefix(ancestor)
            .map_err(|_| "Invalid Claude JSONL path".to_string())?;
        let components = relative.components().collect::<Vec<_>>();
        if components.len() != 3
            || components[0].as_os_str() != "projects"
            || !matches!(components[1], std::path::Component::Normal(_))
            || !matches!(components[2], std::path::Component::Normal(_))
        {
            return Err("Claude JSONL is outside the expected project layout".to_string());
        }
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Claude JSONL filename is not valid UTF-8".to_string())?;
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
            || !crate::provider_readonly::is_safe_component(filename)
        {
            return Err("Claude JSONL filename is unsafe".to_string());
        }
        return Ok(ancestor.to_path_buf());
    }
    Err("Claude JSONL path has no provider root".to_string())
}

fn read_jsonl_lines(path: &Path) -> Result<Vec<String>, String> {
    let root = claude_root_for_jsonl(path)?;
    crate::provider_readonly::read_bounded_lines(
        &root,
        path,
        MAX_JSONL_FILE_BYTES,
        MAX_JSONL_LINE_BYTES,
        MAX_JSONL_EVENTS,
    )
}

// ── Tool call record (matches frontend ToolCall interface) ───────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRecord {
    pub id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(rename = "toolInput")]
    pub tool_input: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// Byte offset in the merged content string where this tool call appears.
    /// Used by the frontend to interleave text and tool calls in the correct order.
    #[serde(rename = "textOffset", skip_serializing_if = "Option::is_none")]
    pub text_offset: Option<usize>,
}

#[derive(Debug, Clone, Default)]
struct TurnUsageParts {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read_tokens: Option<i64>,
    cache_creation_tokens: Option<i64>,
    total_tokens: Option<i64>,
    duration_ms: Option<i64>,
}

impl TurnUsageParts {
    fn merge(&mut self, other: TurnUsageParts) {
        if other.input_tokens.is_some() {
            self.input_tokens = other.input_tokens;
        }
        if other.output_tokens.is_some() {
            self.output_tokens = other.output_tokens;
        }
        if other.cache_read_tokens.is_some() {
            self.cache_read_tokens = other.cache_read_tokens;
        }
        if other.cache_creation_tokens.is_some() {
            self.cache_creation_tokens = other.cache_creation_tokens;
        }
        if other.total_tokens.is_some() {
            self.total_tokens = other.total_tokens;
        }
        if other.duration_ms.is_some() {
            self.duration_ms = other.duration_ms;
        }
    }
}

#[derive(Default)]
struct AssistantAccumulator {
    id: Option<String>,
    conversation_id: String,
    timestamp: String,
    content: String,
    tool_calls: Vec<ToolCallRecord>,
    agent: Option<String>,
    turn_usage: TurnUsageParts,
}

impl AssistantAccumulator {
    fn flush_into(&mut self, messages: &mut Vec<Message>) {
        if self.id.is_none() {
            return;
        }
        if self.content.is_empty() && self.tool_calls.is_empty() {
            self.id.take();
            self.content.clear();
            self.tool_calls.clear();
            self.agent.take();
            self.turn_usage = TurnUsageParts::default();
            return;
        }

        let tool_calls = if self.tool_calls.is_empty() {
            None
        } else {
            serde_json::to_string(&self.tool_calls).ok()
        };
        let usage = std::mem::take(&mut self.turn_usage);
        messages.push(Message {
            id: self.id.take().unwrap(),
            conversation_id: std::mem::take(&mut self.conversation_id),
            role: "claude".to_string(),
            content: std::mem::take(&mut self.content),
            tool_calls,
            agent: self.agent.take(),
            turn_input_tokens: usage.input_tokens,
            turn_output_tokens: usage.output_tokens,
            turn_cache_read_tokens: usage.cache_read_tokens,
            turn_cache_creation_tokens: usage.cache_creation_tokens,
            turn_total_tokens: usage.total_tokens,
            turn_duration_ms: usage.duration_ms,
            created_at: std::mem::take(&mut self.timestamp),
        });
        self.tool_calls.clear();
    }
}

/// Result of a single-pass JSONL sync operation.
#[allow(dead_code)]
pub struct SyncResult {
    pub message_count: i64,
    pub preview: String,
    pub fts_indexed: u32,
}

// ── Session ID utilities ─────────────────────────────────────────────

/// Check whether a session ID belongs to a Claude session (JSONL source).
///
/// Claude session IDs have no prefix; non-Claude sessions use:
/// - `oai-` for OpenAI/Codex
/// - `gem-` for Gemini
/// - `ccmpl-` for ChatCompletion
pub fn is_claude_session(session_id: &str) -> bool {
    !session_id.starts_with("oai-")
        && !session_id.starts_with("gem-")
        && !session_id.starts_with("ccmpl-")
}

// ── Path encoding ────────────────────────────────────────────────────

/// Encode a workspace path into Claude's project directory name.
///
/// Rules observed from Claude Code:
/// - `\` and `/` are replaced with `-`
/// - `_` is replaced with `-`
/// - `:` is replaced with `-` (e.g. `F:\` → `F--`)
/// - `.` is replaced with `-`
/// - Drive letter and original casing are preserved
pub fn encode_project_path(path: &str) -> String {
    path.replace(['\\', '/', '_', ':', '.'], "-")
}

// ── Case-variant helper ─────────────────────────────────────────────

/// Build a case-variant of an encoded path by swapping the first character's
/// case (handles Windows drive letter differences: `F-` vs `f-`).
fn case_variant(encoded: &str) -> Option<String> {
    let first = encoded.chars().next()?;
    if !first.is_alphabetic() {
        return None;
    }
    let alt_first = if first.is_lowercase() {
        first.to_uppercase().to_string()
    } else {
        first.to_lowercase().to_string()
    };
    Some(format!("{}{}", alt_first, &encoded[first.len_utf8()..]))
}

// ── JSONL file location ──────────────────────────────────────────────

/// Locate the JSONL file for a given session ID and workspace path.
///
/// Strategy:
/// 1. Try exact match: `~/.claude/projects/<encoded-path>/<session_id>.jsonl`
/// 2. Fallback: scan all directories under `~/.claude/projects/` for the file
pub fn find_jsonl_path(session_id: &str, workspace_path: &str) -> Option<PathBuf> {
    if !crate::provider_readonly::is_safe_component(session_id) {
        return None;
    }
    let home = dirs::home_dir()?;
    let claude_root = home.join(".claude");
    let projects_dir = claude_root.join("projects");

    if !crate::provider_readonly::is_real_directory(&claude_root, &projects_dir) {
        return None;
    }

    let filename = format!("{}.jsonl", session_id);

    // Strategy 1: exact match with encoded path (skip if workspace_path is empty)
    if !workspace_path.is_empty() {
        let encoded = encode_project_path(workspace_path);
        let project_dir = projects_dir.join(&encoded);
        let exact_path = project_dir.join(&filename);
        if crate::provider_readonly::is_real_directory(&claude_root, &project_dir)
            && crate::provider_readonly::is_bounded_regular_file(
                &claude_root,
                &exact_path,
                MAX_JSONL_FILE_BYTES,
            )
        {
            return Some(exact_path);
        }

        // Try case variant (Windows drive letter)
        if let Some(alt) = case_variant(&encoded) {
            let alt_project_dir = projects_dir.join(&alt);
            let alt_path = alt_project_dir.join(&filename);
            if crate::provider_readonly::is_real_directory(&claude_root, &alt_project_dir)
                && crate::provider_readonly::is_bounded_regular_file(
                    &claude_root,
                    &alt_path,
                    MAX_JSONL_FILE_BYTES,
                )
            {
                return Some(alt_path);
            }
        }
    }

    // Strategy 2: scan all project directories
    if let Ok(entries) = crate::provider_readonly::read_directory_bounded(
        &claude_root,
        &projects_dir,
        MAX_PROJECT_DIRECTORIES,
    ) {
        for entry in entries {
            if entry
                .file_type()
                .is_ok_and(|ft| !ft.is_symlink() && ft.is_dir())
                && crate::provider_readonly::is_real_directory(&claude_root, &entry.path())
            {
                let candidate = entry.path().join(&filename);
                if crate::provider_readonly::is_bounded_regular_file(
                    &claude_root,
                    &candidate,
                    MAX_JSONL_FILE_BYTES,
                ) {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

// ── JSONL parsing ────────────────────────────────────────────────────

/// Check whether a user event contains actual text (not just tool_result blocks).
fn is_user_text_event(event: &Value) -> bool {
    let content = match event.get("message").and_then(|m| m.get("content")) {
        Some(c) => c,
        None => return false,
    };

    // String content is always user text
    if content.is_string() {
        return true;
    }

    // Array content: check for any text block
    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .any(|b| b.get("type").and_then(|v| v.as_str()) == Some("text"));
    }

    false
}

/// Extract the first text content from a user event for inspection.
/// Handles both string and array content formats.
fn extract_user_event_text(event: &Value) -> Option<&str> {
    let content = event.get("message").and_then(|m| m.get("content"))?;

    if let Some(s) = content.as_str() {
        return Some(s);
    }

    if let Some(arr) = content.as_array() {
        return arr.iter().find_map(|b| {
            if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                b.get("text").and_then(|v| v.as_str())
            } else {
                None
            }
        });
    }

    None
}

/// Check whether a user event is a context-compaction summary injected by the
/// Claude SDK when continuing a session.  These messages should not be rendered
/// as normal user messages — instead we emit a lightweight "system" break
/// indicator so users can see where compaction occurred.
///
/// Detected pattern:
/// - "This session is being continued from a previous conversation" (CLI resume / SDK compaction)
///
/// Note: `<conversation_history>` tags are NOT treated as compaction — they are
/// injected by our retry logic (buildRetryPromptText / buildEffectivePromptText)
/// when session resume fails. These are handled separately by
/// `extract_prompt_from_history_wrapper()` to recover the real user message.
fn is_compaction_summary(event: &Value) -> bool {
    match extract_user_event_text(event) {
        Some(text) => {
            let trimmed = text.trim_start();
            trimmed.starts_with("This session is being continued from a previous conversation")
        }
        None => false,
    }
}

/// Check whether a user event starts with `<conversation_history>` wrapper
/// (injected by our retry prompt when session resume fails or when switching
/// from a non-Claude model). If so, extract the real user prompt from after
/// the `</conversation_history>` closing tag.
fn is_history_wrapped_message(event: &Value) -> bool {
    match extract_user_event_text(event) {
        Some(text) => text.trim_start().starts_with("<conversation_history>"),
        None => false,
    }
}

/// Extract the real user prompt from a `<conversation_history>` wrapper.
/// Returns the text after `</conversation_history>`, with any leading
/// `\n\nUser: ` prefix stripped.
fn extract_prompt_from_history_wrapper(event: &Value) -> Option<String> {
    let text = extract_user_event_text(event)?;
    let close_tag = "</conversation_history>";
    let idx = text.find(close_tag)?;
    let after = &text[idx + close_tag.len()..];
    let trimmed = after.trim_start();
    // The retry prompt format is: `</conversation_history>\n\nUser: <actual prompt>`
    let prompt = if let Some(prompt) = trimmed.strip_prefix("User:") {
        prompt.trim_start()
    } else {
        trimmed
    };
    if prompt.is_empty() {
        None
    } else {
        Some(prompt.to_string())
    }
}

/// Check whether a single text block looks like system-injected content.
fn is_system_injected_text(text: &str) -> bool {
    let trimmed = text.trim_start();

    // Skill / slash-command expansion prompts
    if trimmed.contains("<command-name>") {
        return true;
    }

    // SDK-injected system reminders
    if trimmed.starts_with("<system-reminder>") {
        return true;
    }

    // Context injection tags
    if trimmed.starts_with("<context>")
        || trimmed.starts_with("<additional-instructions>")
        || trimmed.starts_with("<local-command")
    {
        return true;
    }

    // Auto-generated code review prompts
    if trimmed.starts_with("<attached-code-review>") || trimmed.starts_with("<code-review") {
        return true;
    }

    // Hook-injected context (pre-submit hooks)
    if trimmed.starts_with("<user-prompt-submit-hook>") {
        return true;
    }

    // CLI-generated async subagent completion notifications are recorded as
    // user-role JSONL events, but they are not user-authored chat input.
    if trimmed.starts_with("<task-notification") {
        return true;
    }

    false
}

/// Detect system-injected user messages that should NOT be displayed in the UI.
///
/// When the Claude SDK processes skills (e.g. `/commit`, `/review-pr`), resumes
/// interrupted sessions, or injects context, it records these as "user" type
/// events in the JSONL file.  They are not real user input and should be hidden
/// when loading conversation history.
///
/// A message is only considered fully system-injected if ALL text blocks are
/// system content.  If any text block contains real user input, the message
/// is kept (system blocks will be stripped during rendering).
fn is_system_injected_user_message(event: &Value) -> bool {
    let content = match event.get("message").and_then(|m| m.get("content")) {
        Some(c) => c,
        None => return false,
    };

    // String content: check the whole string
    if let Some(s) = content.as_str() {
        return is_system_injected_text(s);
    }

    // Array content: only filter if ALL text blocks are system-injected
    if let Some(arr) = content.as_array() {
        let text_blocks: Vec<&str> = arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                    b.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .collect();

        if text_blocks.is_empty() {
            return false;
        }

        // If ANY text block is real user content, keep the message
        return text_blocks.iter().all(|t| is_system_injected_text(t));
    }

    false
}

/// Parse JSONL file and extract user/assistant messages.
///
/// Consecutive assistant events between two user text messages are merged
/// into a single message to match the original streaming UI behaviour.
///
/// Returns messages sorted by timestamp, with pagination support.
pub fn parse_jsonl_messages(path: &Path, limit: i64, offset: i64) -> Result<Vec<Message>, String> {
    let lines = read_jsonl_lines(path)?;
    // First pass: collect all tool_results keyed by tool_use_id
    // so we can attach results to tool_use blocks in assistant messages.
    let tool_results = collect_tool_results(&lines);

    let mut messages: Vec<Message> = Vec::new();

    // Accumulator for the current assistant turn.
    // We build `acc_content` incrementally so that each tool call can record
    // the byte offset (textOffset) at the point it appeared in the stream.
    // This lets the frontend interleave text and tool calls in the correct
    // order via `buildSegments`.
    let mut assistant = AssistantAccumulator::default();

    for line in &lines {
        if line.trim().is_empty() {
            continue;
        }

        let event: Value =
            serde_json::from_str(line).map_err(|e| format!("Invalid JSON: {}", e))?;

        let event_type = match event.get("type").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => continue,
        };

        match event_type {
            "user" => {
                // User events that only contain tool_result are part of the
                // assistant turn (tool call round-trip) — skip them as messages.
                if !is_user_text_event(&event) {
                    continue;
                }

                // Context-compaction summary (SDK "This session is being continued"):
                // flush any pending assistant turn FIRST, then emit a system break.
                if is_compaction_summary(&event) {
                    assistant.flush_into(&mut messages);
                    let conv_id = event
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let ts = event
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let break_id = event
                        .get("uuid")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    messages.push(Message {
                        id: break_id,
                        conversation_id: conv_id,
                        role: "system".to_string(),
                        content: "context_compacted".to_string(),
                        tool_calls: None,
                        agent: None,
                        turn_input_tokens: None,
                        turn_output_tokens: None,
                        turn_cache_read_tokens: None,
                        turn_cache_creation_tokens: None,
                        turn_total_tokens: None,
                        turn_duration_ms: None,
                        created_at: ts,
                    });
                    continue;
                }

                // <conversation_history> wrapper (from retry prompt when resume
                // failed or model switch): extract the real user prompt and emit
                // it as a normal user message with a system break before it.
                if is_history_wrapped_message(&event) {
                    assistant.flush_into(&mut messages);
                    // Emit system break to indicate session boundary
                    let conv_id = event
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let ts = event
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let break_id = format!(
                        "{}-break",
                        event
                            .get("uuid")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                    );
                    messages.push(Message {
                        id: break_id,
                        conversation_id: conv_id.clone(),
                        role: "system".to_string(),
                        content: "context_compacted".to_string(),
                        tool_calls: None,
                        agent: None,
                        turn_input_tokens: None,
                        turn_output_tokens: None,
                        turn_cache_read_tokens: None,
                        turn_cache_creation_tokens: None,
                        turn_total_tokens: None,
                        turn_duration_ms: None,
                        created_at: ts.clone(),
                    });
                    // Extract and emit the real user prompt
                    if let Some(real_prompt) = extract_prompt_from_history_wrapper(&event) {
                        let uuid = event
                            .get("uuid")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        messages.push(Message {
                            id: uuid,
                            conversation_id: conv_id,
                            role: "user".to_string(),
                            content: real_prompt,
                            tool_calls: None,
                            agent: None,
                            turn_input_tokens: None,
                            turn_output_tokens: None,
                            turn_cache_read_tokens: None,
                            turn_cache_creation_tokens: None,
                            turn_total_tokens: None,
                            turn_duration_ms: None,
                            created_at: ts,
                        });
                    }
                    continue;
                }

                // System-injected user messages: flush the assistant accumulator
                // before skipping to prevent content merging across boundaries.
                if is_system_injected_user_message(&event) {
                    assistant.flush_into(&mut messages);
                    continue;
                }

                // A real user text message: flush any pending assistant turn
                assistant.flush_into(&mut messages);

                // Emit the user message
                if let Some(msg) = parse_event_to_message(&event, event_type, &tool_results) {
                    messages.push(msg);
                }
            }
            "result" => {
                if assistant.id.is_some() {
                    if let Some(usage) = extract_turn_usage(&event) {
                        assistant.turn_usage.merge(usage);
                    }
                }
            }
            "assistant" => {
                let uuid = match event.get("uuid").and_then(|v| v.as_str()) {
                    Some(u) => u,
                    None => continue,
                };
                let message = match event.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                let content_arr = match message.get("content").and_then(|c| c.as_array()) {
                    Some(arr) => arr,
                    None => continue,
                };

                // Initialise accumulator on first assistant event of this turn
                if assistant.id.is_none() {
                    assistant.id = Some(uuid.to_string());
                    assistant.conversation_id = event
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    assistant.timestamp = event
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    assistant.agent = message
                        .get("model")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
                if let Some(usage) = extract_turn_usage(&event) {
                    assistant.turn_usage.merge(usage);
                }

                // Accumulate content blocks in order, recording textOffset for
                // each tool_use so the frontend can interleave them correctly.
                for block in content_arr {
                    let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match block_type {
                        "text" => {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    // Append directly without separators to match
                                    // the real-time streaming behaviour where text
                                    // chunks are concatenated into a single string.
                                    assistant.content.push_str(text);
                                }
                            }
                        }
                        "tool_use" => {
                            let tool_id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let tool_name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let tool_input = block
                                .get("input")
                                .map(|v| {
                                    let s = serde_json::to_string(v).unwrap_or_default();
                                    truncate_str(&s, 1000)
                                })
                                .unwrap_or_default();

                            let (result, is_error) = tool_results
                                .get(&tool_id)
                                .map(|(r, e)| (Some(r.clone()), *e))
                                .unwrap_or((None, false));

                            let status = if is_error { "error" } else { "success" }.to_string();

                            assistant.tool_calls.push(ToolCallRecord {
                                id: tool_id,
                                tool_name,
                                tool_input,
                                status,
                                result,
                                // Use char count (not byte len) so the
                                // offset matches JS string.slice() which
                                // operates on UTF-16 code units.  For BMP
                                // characters (incl. CJK) chars().count()
                                // equals JS .length; supplementary-plane
                                // chars (emoji) would need surrogate-pair
                                // accounting but are rare in practice.
                                text_offset: Some(assistant.content.chars().count()),
                            });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    // Flush any remaining assistant turn at end of file
    assistant.flush_into(&mut messages);

    // Apply pagination
    let start = offset.max(0) as usize;
    let end = if limit > 0 {
        (start + limit as usize).min(messages.len())
    } else {
        messages.len()
    };

    if start >= messages.len() {
        return Ok(Vec::new());
    }

    Ok(messages[start..end].to_vec())
}

/// Parse JSONL file and return a `MessagePage` with total count + paginated slice.
pub fn parse_jsonl_message_page(
    path: &Path,
    limit: i64,
    offset: i64,
) -> Result<MessagePage, String> {
    // Re-use existing parser to get ALL messages, then paginate + return total.
    // Note: JSONL must be fully parsed regardless because messages are assembled
    // from interleaved events — random-access is not feasible.
    let all = parse_jsonl_messages(path, -1, 0)?; // -1 limit → no limit
    let total = all.len() as i64;

    let start = offset.max(0) as usize;
    let end = if limit > 0 {
        (start + limit as usize).min(all.len())
    } else {
        all.len()
    };

    let messages = if start >= all.len() {
        Vec::new()
    } else {
        all[start..end].to_vec()
    };

    Ok(MessagePage { messages, total })
}

/// Tool result data: (content, is_error).
type ToolResultEntry = (String, bool);

/// Collect all tool_result blocks from user messages, keyed by tool_use_id.
/// Returns (result_content, is_error) tuples.
fn collect_tool_results(lines: &[String]) -> HashMap<String, ToolResultEntry> {
    let mut results: HashMap<String, ToolResultEntry> = HashMap::new();

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }

        let event: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if event.get("type").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }

        let content = match event
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            Some(arr) => arr,
            None => continue,
        };

        for block in content {
            if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                if let Some(tool_use_id) = block.get("tool_use_id").and_then(|v| v.as_str()) {
                    let result_content = extract_tool_result_content(block);
                    let is_error = block
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    results.insert(tool_use_id.to_string(), (result_content, is_error));
                }
            }
        }
    }

    results
}

/// Extract text content from a tool_result block.
fn extract_tool_result_content(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => truncate_str(s, 50_000),
        Some(Value::Array(arr)) => {
            let mut parts = Vec::new();
            for item in arr {
                if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        parts.push(truncate_str(text, 50_000));
                    }
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

/// Parse a single JSONL event into a Message.
fn parse_event_to_message(
    event: &Value,
    event_type: &str,
    tool_results: &HashMap<String, ToolResultEntry>,
) -> Option<Message> {
    let uuid = event.get("uuid").and_then(|v| v.as_str())?;
    let session_id = event.get("sessionId").and_then(|v| v.as_str())?;
    let timestamp = event
        .get("timestamp")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let message = event.get("message")?;
    let content_value = message.get("content")?;

    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCallRecord> = Vec::new();

    // Handle both string and array content formats.
    // User messages often have content as a plain string (e.g., "Hello"),
    // while assistant messages use the array format with typed blocks.
    // For user messages, system-injected text blocks (e.g. <system-reminder>)
    // are stripped so only real user input is displayed.
    if let Some(text) = content_value.as_str() {
        if !text.is_empty() {
            // For user messages, skip if the whole string is system-injected
            if event_type != "user" || !is_system_injected_text(text) {
                text_parts.push(text.to_string());
            }
        }
    } else if let Some(content_arr) = content_value.as_array() {
        for block in content_arr {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match block_type {
                "text" => {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            // For user messages, skip system-injected text blocks
                            if event_type == "user" && is_system_injected_text(text) {
                                continue;
                            }
                            text_parts.push(text.to_string());
                        }
                    }
                }
                "tool_use" if event_type == "assistant" => {
                    let tool_id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_name = block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_input = block
                        .get("input")
                        .map(|v| {
                            let s = serde_json::to_string(v).unwrap_or_default();
                            truncate_str(&s, 1000)
                        })
                        .unwrap_or_default();

                    let (result, is_error) = tool_results
                        .get(&tool_id)
                        .map(|(r, e)| (Some(r.clone()), *e))
                        .unwrap_or((None, false));

                    let status = if is_error { "error" } else { "success" }.to_string();

                    tool_calls.push(ToolCallRecord {
                        id: tool_id,
                        tool_name,
                        tool_input,
                        status,
                        result,
                        text_offset: None,
                    });
                }
                "tool_result" => {
                    // tool_result blocks appear in user messages; skip for content extraction
                }
                _ => {}
            }
        }
    }

    let content = text_parts.join("\n\n");

    // Skip messages with no text content and no tool calls
    if content.is_empty() && tool_calls.is_empty() {
        return None;
    }

    let tool_calls_json = if tool_calls.is_empty() {
        None
    } else {
        serde_json::to_string(&tool_calls).ok()
    };

    // Map JSONL "assistant" role to "claude" to match frontend AgentRole enum
    let role = if event_type == "assistant" {
        "claude".to_string()
    } else {
        event_type.to_string()
    };

    // Extract model tag from message.model (e.g. "claude-opus-4-6")
    let agent = message
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let turn_usage = if event_type == "assistant" {
        extract_turn_usage(event)
    } else {
        None
    };

    Some(Message {
        id: uuid.to_string(),
        conversation_id: session_id.to_string(),
        role,
        content,
        tool_calls: tool_calls_json,
        agent,
        turn_input_tokens: turn_usage.as_ref().and_then(|usage| usage.input_tokens),
        turn_output_tokens: turn_usage.as_ref().and_then(|usage| usage.output_tokens),
        turn_cache_read_tokens: turn_usage
            .as_ref()
            .and_then(|usage| usage.cache_read_tokens),
        turn_cache_creation_tokens: turn_usage
            .as_ref()
            .and_then(|usage| usage.cache_creation_tokens),
        turn_total_tokens: turn_usage.as_ref().and_then(|usage| usage.total_tokens),
        turn_duration_ms: turn_usage.as_ref().and_then(|usage| usage.duration_ms),
        created_at: timestamp.to_string(),
    })
}

// ── Utility functions ────────────────────────────────────────────────

fn json_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    value.as_str().and_then(|text| text.parse::<i64>().ok())
}

fn extract_turn_usage(event: &Value) -> Option<TurnUsageParts> {
    let usage = event.get("usage").or_else(|| {
        event
            .get("message")
            .and_then(|message| message.get("usage"))
    });

    let mut parts = TurnUsageParts {
        duration_ms: json_i64(event.get("duration_ms"))
            .or_else(|| usage.and_then(|usage| json_i64(usage.get("duration_ms")))),
        ..TurnUsageParts::default()
    };

    if let Some(usage) = usage {
        parts.input_tokens = json_i64(usage.get("input_tokens"));
        parts.output_tokens = json_i64(usage.get("output_tokens"));
        parts.cache_read_tokens = json_i64(usage.get("cache_read_input_tokens"));
        parts.cache_creation_tokens = json_i64(usage.get("cache_creation_input_tokens"));
        parts.total_tokens = json_i64(usage.get("total_tokens"));
    }

    if parts.total_tokens.is_none() {
        let total = [
            parts.input_tokens,
            parts.output_tokens,
            parts.cache_read_tokens,
            parts.cache_creation_tokens,
        ]
        .into_iter()
        .flatten()
        .sum::<i64>();
        if total > 0 {
            parts.total_tokens = Some(total);
        }
    }

    if parts.total_tokens.is_some() || parts.duration_ms.is_some() {
        Some(parts)
    } else {
        None
    }
}

/// Truncate a string to a maximum byte length, respecting char boundaries.
fn truncate_str(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        return s.to_string();
    }

    let mut end = max_len;
    while !s.is_char_boundary(end) && end > 0 {
        end -= 1;
    }

    format!("{}...", &s[..end])
}

// ── Single-pass sync ─────────────────────────────────────────────────

/// Perform a single-pass sync of a JSONL file: count messages, extract preview,
/// and index content for FTS search — all in one file read.
///
/// This replaces the previous approach of calling `count_jsonl_messages`,
/// `extract_preview`, and `index_for_fts` separately (which read the file 3x).
pub fn sync_from_jsonl(
    conn: &rusqlite::Connection,
    conversation_id: &str,
    path: &Path,
) -> Result<SyncResult, String> {
    let lines = read_jsonl_lines(path)?;

    let mut count: i64 = 0;
    let mut last_preview = String::new();
    let mut indexed: u32 = 0;

    for line in &lines {
        if line.trim().is_empty() {
            continue;
        }

        let event: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = match event.get("type").and_then(|v| v.as_str()) {
            Some(t @ "user") | Some(t @ "assistant") => t,
            _ => continue,
        };

        // Must have a message field with content
        let content_arr = match event
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            Some(arr) => arr,
            None => continue,
        };

        // Count this message
        count += 1;

        // Extract text content for preview + FTS
        let mut text_parts: Vec<&str> = Vec::new();
        for block in content_arr {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        text_parts.push(text);
                    }
                }
            }
        }

        let content = text_parts.join("\n\n");
        if content.is_empty() {
            continue;
        }

        // Update preview (last non-empty text wins)
        last_preview = truncate_str(&content, 100);

        // FTS indexing: INSERT OR IGNORE into messages table
        let uuid = match event.get("uuid").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => continue,
        };

        let timestamp = event
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Map "assistant" to "claude" to match frontend AgentRole
        let role = if event_type == "assistant" {
            "claude"
        } else {
            event_type
        };

        let result = conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, agent, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            rusqlite::params![uuid, conversation_id, role, content, timestamp],
        );

        match result {
            Ok(rows) if rows > 0 => indexed += 1,
            Ok(_) => {} // Already existed
            Err(e) => {
                log::warn!("FTS index insert failed for {}: {}", uuid, e);
            }
        }
    }

    // Update conversation metadata
    let _ = conn.execute(
        "UPDATE conversations
         SET message_count = ?2,
             preview = ?3,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        rusqlite::params![conversation_id, count, last_preview],
    );

    Ok(SyncResult {
        message_count: count,
        preview: last_preview,
        fts_indexed: indexed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_session_path(temp: &tempfile::TempDir, session_id: &str) -> PathBuf {
        let project = temp
            .path()
            .join(".claude")
            .join("projects")
            .join("-tmp-workspace");
        std::fs::create_dir_all(&project).expect("project directory");
        project.join(format!("{}.jsonl", session_id))
    }

    #[test]
    fn valid_jsonl_pagination_remains_compatible_and_read_only() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = make_session_path(&temp, "session-1");
        let content = concat!(
            "{\"type\":\"user\",\"uuid\":\"u1\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n",
            "{\"type\":\"assistant\",\"uuid\":\"a1\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"model\":\"claude\",\"content\":[{\"type\":\"text\",\"text\":\"world\"}]}}\n"
        );
        std::fs::write(&path, content).expect("session");
        let before = std::fs::read(&path).expect("snapshot");

        let page = parse_jsonl_message_page(&path, 1, 1).expect("page");

        assert_eq!(page.total, 2);
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].content, "world");
        assert_eq!(std::fs::read(&path).expect("session after"), before);
    }

    #[test]
    fn rejects_oversized_file_line_and_directory_leaf() {
        let temp = tempfile::tempdir().expect("temp dir");
        let oversized = make_session_path(&temp, "oversized");
        let file = std::fs::File::create(&oversized).expect("oversized");
        file.set_len(MAX_JSONL_FILE_BYTES + 1)
            .expect("extend oversized file");
        assert!(read_jsonl_lines(&oversized).is_err());

        let long_line = make_session_path(&temp, "long-line");
        std::fs::write(&long_line, vec![b'x'; MAX_JSONL_LINE_BYTES + 1]).expect("long line");
        assert!(read_jsonl_lines(&long_line).is_err());

        let directory_leaf = make_session_path(&temp, "directory");
        std::fs::create_dir(&directory_leaf).expect("directory leaf");
        assert!(read_jsonl_lines(&directory_leaf).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_root_intermediate_leaf_links_and_fifo_quickly() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let real = make_session_path(&temp, "real");
        std::fs::write(&real, "{}\n").expect("real session");
        let project = real.parent().expect("project");

        let leaf = project.join("leaf.jsonl");
        symlink(&real, &leaf).expect("leaf link");
        assert!(read_jsonl_lines(&leaf).is_err());

        let outside = temp.path().join("outside-project");
        std::fs::create_dir(&outside).expect("outside project");
        std::fs::write(outside.join("nested.jsonl"), "{}\n").expect("outside session");
        let linked_project = temp
            .path()
            .join(".claude")
            .join("projects")
            .join("linked-project");
        symlink(&outside, &linked_project).expect("project link");
        assert!(read_jsonl_lines(&linked_project.join("nested.jsonl")).is_err());

        let linked_root = temp.path().join("linked-root");
        symlink(temp.path().join(".claude"), &linked_root).expect("root link");
        let linked_root_path = linked_root
            .join("projects")
            .join("-tmp-workspace")
            .join("real.jsonl");
        assert!(read_jsonl_lines(&linked_root_path).is_err());

        let fifo = project.join("fifo.jsonl");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(read_jsonl_lines(&fifo).is_err());
    }
}
