use tauri::{AppHandle, Manager, State};

use super::context;
use super::db::MemoryDb;
use super::jsonl;
use super::models::{
    AggregateUsage, ContextUsageRecord, Conversation, ConversationSummary, Idea, IdeaStatusCounts,
    IdeaSummary, LastUsedModel, MemoryContext, MessagePage, MessageTurnUsage, SearchResult,
    TodoRecord, UsageRecord, Workspace, WorkspaceSummary,
};
use super::repository;

#[tauri::command]
pub fn get_conversation(
    db: State<'_, MemoryDb>,
    conversation_id: String,
) -> Result<Option<Conversation>, String> {
    db.with_conn(|conn| repository::get_conversation(conn, &conversation_id))
}

#[tauri::command]
pub fn get_conversation_summary(
    db: State<'_, MemoryDb>,
    conversation_id: String,
) -> Result<Option<ConversationSummary>, String> {
    db.with_conn(|conn| repository::get_conversation_summary(conn, &conversation_id))
}

#[tauri::command]
pub fn update_conversation_session(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    conversation_id: String,
    session_id: String,
) -> Result<(), String> {
    let result =
        db.with_conn(|conn| repository::update_session_id(conn, &conversation_id, &session_id));
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

#[tauri::command]
pub fn create_conversation(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    model: String,
    workspace_id: Option<String>,
    conv_type: Option<String>,
) -> Result<Conversation, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let result = db.with_conn(|conn| {
        repository::create_conversation(
            conn,
            &id,
            &model,
            workspace_id.as_deref(),
            conv_type.as_deref(),
        )
    });
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

/// Load ALL messages for a conversation (no pagination) — resolving the JSONL
/// session chain for Claude conversations, or falling back to SQLite. Shared by
/// `fork_conversation` to snapshot history up to an anchor.
fn load_all_conversation_messages(
    db: &State<'_, MemoryDb>,
    conv: &Conversation,
) -> Result<Vec<super::models::Message>, String> {
    if conv.message_source == "jsonl" {
        if let Some(ref session_id) = conv.session_id {
            if jsonl::is_claude_session(session_id) {
                let workspace_path = if let Some(ref ws_id) = conv.workspace_id {
                    db.with_conn(|conn| repository::get_workspace(conn, ws_id))?
                        .map(|ws| ws.path)
                } else {
                    None
                };
                let ws_path_ref = workspace_path.as_deref().unwrap_or("");

                let mut all_session_ids: Vec<String> = Vec::new();
                if let Some(ref prev) = conv.previous_session_ids {
                    for sid in prev.split(',') {
                        let sid = sid.trim();
                        if !sid.is_empty() {
                            all_session_ids.push(sid.to_string());
                        }
                    }
                }
                all_session_ids.push(session_id.clone());

                let mut all_messages: Vec<super::models::Message> = Vec::new();
                let mut found_any = false;
                for sid in &all_session_ids {
                    let jsonl_path = jsonl::find_jsonl_path(sid, ws_path_ref)
                        .or_else(|| jsonl::find_jsonl_path(sid, ""));
                    if let Some(ref path) = jsonl_path {
                        if let Ok(msgs) = jsonl::parse_jsonl_messages(path, -1, 0) {
                            all_messages.extend(msgs);
                            found_any = true;
                        }
                    }
                }
                if found_any {
                    return Ok(all_messages);
                }
            }
        }
    }

    // Fallback: read everything from SQLite (limit -1 = no limit).
    db.with_conn(|conn| repository::get_conversation_messages(conn, &conv.id, -1, 0))
}

/// Fork a conversation at `anchor_message_id` into a brand-new conversation.
/// Copies history up to and including the anchor; the copy renders from SQLite
/// until the new conversation's first turn forks a real SDK session (via
/// forkSession/resumeSessionAt), after which the `session` event flips its
/// message_source to 'jsonl'.
#[tauri::command]
pub fn fork_conversation(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    src_conversation_id: String,
    anchor_message_id: String,
) -> Result<Conversation, String> {
    let src = db
        .with_conn(|conn| repository::get_conversation(conn, &src_conversation_id))?
        .ok_or_else(|| format!("source conversation not found: {}", src_conversation_id))?;

    // Snapshot full history, then truncate to the anchor (inclusive).
    let all_messages = load_all_conversation_messages(&db, &src)?;
    let anchor_idx = all_messages
        .iter()
        .position(|m| m.id == anchor_message_id)
        .ok_or_else(|| format!("anchor message not found in source: {}", anchor_message_id))?;
    let history = &all_messages[..=anchor_idx];

    // Only a Claude JSONL session can be SDK-forked (forkSession + resumeSessionAt).
    // For other providers / db-backed conversations, leave forked_from_session_id
    // NULL so the first turn just replays the copied history as plain context
    // instead of attempting an SDK fork — see use-chat-streaming pending-fork.
    let forked_from_session = if src.message_source == "jsonl"
        && src
            .session_id
            .as_deref()
            .map(jsonl::is_claude_session)
            .unwrap_or(false)
    {
        src.session_id.as_deref()
    } else {
        None
    };

    let new_id = uuid::Uuid::new_v4().to_string();
    // Title stays identical to the source — the fork is signalled by the
    // GitFork icon in the conversation list (driven by parent_conversation_id),
    // not by a text suffix.
    let title = src.title.clone();
    db.with_conn(|conn| {
        repository::create_forked_conversation(
            conn,
            &new_id,
            &title,
            &src.model,
            src.workspace_id.as_deref(),
            &src.conv_type,
            &src_conversation_id,
            forked_from_session,
            &anchor_message_id,
        )
    })?;

    db.with_conn(|conn| repository::copy_messages_into(conn, &new_id, history))?;

    let forked = db
        .with_conn(|conn| repository::get_conversation(conn, &new_id))?
        .ok_or_else(|| "forked conversation vanished after creation".to_string())?;
    crate::refresh_tray_menu(&app);
    Ok(forked)
}

#[tauri::command]
pub fn list_conversations(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    limit: Option<i64>,
    offset: Option<i64>,
    workspace_id: Option<String>,
    archived: Option<bool>,
) -> Result<Vec<ConversationSummary>, String> {
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);
    let archived = archived.unwrap_or(false);
    let result = db.with_conn(|conn| {
        repository::list_conversations(conn, limit, offset, workspace_id.as_deref(), archived)
    });
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

#[tauri::command]
pub fn set_conversation_archived(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    conversation_id: String,
    archived: bool,
) -> Result<(), String> {
    let result = db
        .with_conn(|conn| repository::set_conversation_archived(conn, &conversation_id, archived));
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

#[tauri::command]
pub fn get_conversation_messages(
    db: State<'_, MemoryDb>,
    conversation_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MessagePage, String> {
    let limit = limit.unwrap_or(500);
    let offset = offset.unwrap_or(0);

    // Check if this conversation uses JSONL as message source
    let conv = db.with_conn(|conn| repository::get_conversation(conn, &conversation_id))?;

    if let Some(ref conv) = conv {
        if conv.message_source == "jsonl" {
            if let Some(ref session_id) = conv.session_id {
                if jsonl::is_claude_session(session_id) {
                    let workspace_path = if let Some(ref ws_id) = conv.workspace_id {
                        db.with_conn(|conn| repository::get_workspace(conn, ws_id))?
                            .map(|ws| ws.path)
                    } else {
                        None
                    };
                    let ws_path_ref = workspace_path.as_deref().unwrap_or("");

                    // Build session chain: previous sessions + current
                    let mut all_session_ids: Vec<String> = Vec::new();
                    if let Some(ref prev) = conv.previous_session_ids {
                        if !prev.is_empty() {
                            for sid in prev.split(',') {
                                let sid = sid.trim();
                                if !sid.is_empty() {
                                    all_session_ids.push(sid.to_string());
                                }
                            }
                        }
                    }
                    all_session_ids.push(session_id.clone());

                    // Parse and merge all chained JSONL files
                    let mut all_messages: Vec<super::models::Message> = Vec::new();
                    let mut found_any = false;

                    for sid in &all_session_ids {
                        let jsonl_path = jsonl::find_jsonl_path(sid, ws_path_ref)
                            .or_else(|| jsonl::find_jsonl_path(sid, ""));
                        if let Some(ref path) = jsonl_path {
                            if let Ok(msgs) = jsonl::parse_jsonl_messages(path, -1, 0) {
                                all_messages.extend(msgs);
                                found_any = true;
                            }
                        }
                    }

                    if found_any {
                        let total = all_messages.len() as i64;
                        let start = (offset.max(0) as usize).min(all_messages.len());
                        let end = if limit > 0 {
                            (start + limit as usize).min(all_messages.len())
                        } else {
                            all_messages.len()
                        };
                        let messages = if start >= all_messages.len() {
                            Vec::new()
                        } else {
                            all_messages[start..end].to_vec()
                        };
                        return Ok(MessagePage { messages, total });
                    }
                }
            }
        }
    }

    // Default: read from database (single lock acquisition for consistency)
    db.with_conn(|conn| {
        let messages =
            repository::get_conversation_messages(conn, &conversation_id, limit, offset)?;
        let total = repository::count_messages(conn, &conversation_id)?;
        Ok(MessagePage { messages, total })
    })
}

/// Load the latest N messages for a conversation (from the tail), returned in
/// chronological order.  Used for initial page load with pagination.
#[tauri::command]
pub fn get_latest_messages(
    db: State<'_, MemoryDb>,
    conversation_id: String,
    limit: Option<i64>,
) -> Result<MessagePage, String> {
    let limit = limit.unwrap_or(30).max(0) as usize;

    // Check if this conversation uses JSONL as message source
    let conv = db.with_conn(|conn| repository::get_conversation(conn, &conversation_id))?;

    if conv.is_none() {
        log::warn!("[get_latest_messages] conversation not found");
    }

    if let Some(ref conv) = conv {
        if conv.message_source == "jsonl" {
            if let Some(ref session_id) = conv.session_id {
                if jsonl::is_claude_session(session_id) {
                    // Resolve workspace path
                    let workspace_path = if let Some(ref ws_id) = conv.workspace_id {
                        db.with_conn(|conn| repository::get_workspace(conn, ws_id))?
                            .map(|ws| ws.path)
                    } else {
                        None
                    };

                    let ws_path_ref = workspace_path.as_deref().unwrap_or("");

                    // Collect all session IDs in chronological order:
                    // previous_session_ids (oldest → newest), then current session_id
                    let mut all_session_ids: Vec<String> = Vec::new();
                    if let Some(ref prev) = conv.previous_session_ids {
                        if !prev.is_empty() {
                            for sid in prev.split(',') {
                                let sid = sid.trim();
                                if !sid.is_empty() {
                                    all_session_ids.push(sid.to_string());
                                }
                            }
                        }
                    }
                    all_session_ids.push(session_id.clone());

                    // Parse and merge messages from all chained JSONL files
                    let mut all_messages: Vec<super::models::Message> = Vec::new();
                    let mut found_any = false;

                    for sid in &all_session_ids {
                        let jsonl_path = jsonl::find_jsonl_path(sid, ws_path_ref)
                            .or_else(|| jsonl::find_jsonl_path(sid, ""));

                        if let Some(ref path) = jsonl_path {
                            match jsonl::parse_jsonl_messages(path, -1, 0) {
                                Ok(msgs) => {
                                    all_messages.extend(msgs);
                                    found_any = true;
                                }
                                Err(_) => {
                                    log::warn!(
                                        "[get_latest_messages] provider session parse failed"
                                    );
                                }
                            }
                        }
                    }

                    if found_any {
                        let total = all_messages.len() as i64;
                        let start = all_messages.len().saturating_sub(limit);
                        return Ok(MessagePage {
                            messages: all_messages[start..].to_vec(),
                            total,
                        });
                    }

                    log::warn!(
                        "[get_latest_messages] provider session unavailable; using local database"
                    );
                }
            } else {
                log::warn!(
                    "[get_latest_messages] provider session reference missing; using local database"
                );
            }
        }
    }

    // Default: read from database
    db.with_conn(|conn| repository::get_latest_messages(conn, &conversation_id, limit as i64))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_message(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    conversation_id: String,
    id: String,
    role: String,
    content: String,
    agent: Option<String>,
    tool_calls: Option<String>,
    turn_usage: Option<MessageTurnUsage>,
) -> Result<(), String> {
    let result = db.with_conn(|conn| {
        repository::save_message(
            conn,
            &id,
            &conversation_id,
            &role,
            &content,
            agent.as_deref(),
            tool_calls.as_deref(),
            turn_usage.as_ref(),
        )
    });
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

#[tauri::command]
pub fn get_message_count(db: State<'_, MemoryDb>, conversation_id: String) -> Result<i64, String> {
    // Check if this conversation uses JSONL as message source
    let conv = db.with_conn(|conn| repository::get_conversation(conn, &conversation_id))?;

    if let Some(ref conv) = conv {
        if conv.message_source == "jsonl" {
            if let Some(ref session_id) = conv.session_id {
                let is_claude = jsonl::is_claude_session(session_id);

                if is_claude {
                    // Resolve workspace path
                    let workspace_path = if let Some(ref ws_id) = conv.workspace_id {
                        db.with_conn(|conn| repository::get_workspace(conn, ws_id))?
                            .map(|ws| ws.path)
                    } else {
                        None
                    };
                    if let Some(ref ws_path) = workspace_path {
                        let jsonl_path = jsonl::find_jsonl_path(session_id, ws_path);
                        if let Some(jsonl_path) = jsonl_path {
                            let page = jsonl::parse_jsonl_message_page(&jsonl_path, -1, 0)?;
                            return Ok(page.total);
                        }
                    }

                    // Fallback: try without workspace path (scan all project dirs)
                    let jsonl_path_fallback = jsonl::find_jsonl_path(session_id, "");
                    if let Some(jsonl_path) = jsonl_path_fallback {
                        let page = jsonl::parse_jsonl_message_page(&jsonl_path, -1, 0)?;
                        return Ok(page.total);
                    }

                    // Final fallback: read from database (legacy data)
                }
            }
        }
    }

    // Default: read from database
    db.with_conn(|conn| repository::count_messages(conn, &conversation_id))
}

#[tauri::command]
pub fn delete_conversation(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    conversation_id: String,
) -> Result<(), String> {
    // Clean up persistent Codex thread data in the Community Edition home.
    let _ = remove_codex_session_dir(&conversation_id, "delete_conversation");

    // Physical delete from database (CASCADE handles messages, summaries, todos, usage)
    let result = db.with_conn(|conn| repository::delete_conversation(conn, &conversation_id));
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

#[tauri::command]
pub fn rename_conversation(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    let result =
        db.with_conn(|conn| repository::rename_conversation(conn, &conversation_id, &title));
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

#[tauri::command]
pub fn update_conversation_model(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    conversation_id: String,
    model: String,
) -> Result<(), String> {
    let result =
        db.with_conn(|conn| repository::update_conversation_model(conn, &conversation_id, &model));
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

#[tauri::command]
pub fn pin_conversation(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    conversation_id: String,
    pinned: bool,
) -> Result<(), String> {
    let result = db.with_conn(|conn| repository::pin_conversation(conn, &conversation_id, pinned));
    if result.is_ok() {
        crate::refresh_tray_menu(&app);
    }
    result
}

#[tauri::command]
pub fn search_memory(
    db: State<'_, MemoryDb>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, String> {
    let limit = limit.unwrap_or(10);
    db.with_conn(|conn| repository::search_memory(conn, &query, limit))
}

#[tauri::command]
pub fn get_memory_context(
    db: State<'_, MemoryDb>,
    conversation_id: String,
    user_message: String,
) -> Result<MemoryContext, String> {
    db.with_conn(|conn| context::build_memory_context(conn, &conversation_id, &user_message))
}

#[tauri::command]
pub fn save_conversation_todos(
    db: State<'_, MemoryDb>,
    conversation_id: String,
    todos: Vec<TodoRecord>,
) -> Result<(), String> {
    db.with_conn(|conn| repository::save_conversation_todos(conn, &conversation_id, &todos))
}

#[tauri::command]
pub fn get_conversation_todos(
    db: State<'_, MemoryDb>,
    conversation_id: String,
) -> Result<Vec<TodoRecord>, String> {
    db.with_conn(|conn| repository::get_conversation_todos(conn, &conversation_id))
}

#[tauri::command]
pub fn save_conversation_usage(
    db: State<'_, MemoryDb>,
    conversation_id: String,
    usage: UsageRecord,
) -> Result<(), String> {
    db.with_conn(|conn| repository::save_conversation_usage(conn, &conversation_id, &usage))
}

#[tauri::command]
pub fn save_conversation_context_usage(
    db: State<'_, MemoryDb>,
    conversation_id: String,
    usage: ContextUsageRecord,
) -> Result<(), String> {
    db.with_conn(|conn| repository::save_conversation_context_usage(conn, &conversation_id, &usage))
}

#[tauri::command]
pub fn get_conversation_usage(
    db: State<'_, MemoryDb>,
    conversation_id: String,
) -> Result<Option<UsageRecord>, String> {
    db.with_conn(|conn| repository::get_conversation_usage(conn, &conversation_id))
}

#[tauri::command]
pub fn get_aggregate_usage(
    db: State<'_, MemoryDb>,
    workspace_id: String,
) -> Result<AggregateUsage, String> {
    db.with_conn(|conn| repository::get_aggregate_usage(conn, &workspace_id))
}

// ── Workspace Commands ──────────────────────────────────────────────────

#[tauri::command]
pub fn create_workspace(
    db: State<'_, MemoryDb>,
    name: String,
    path: String,
) -> Result<Workspace, String> {
    // Check for existing workspace with same path
    let existing = db.with_conn(|conn| repository::get_workspace_by_path(conn, &path))?;
    if let Some(ws) = existing {
        // Already exists, just update last_opened_at and return
        db.with_conn(|conn| repository::update_workspace_last_opened(conn, &ws.id))?;
        return db
            .with_conn(|conn| repository::get_workspace(conn, &ws.id))?
            .ok_or_else(|| "Workspace not found after update".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| repository::create_workspace(conn, &id, &name, &path))
}

#[tauri::command]
pub fn list_workspaces(db: State<'_, MemoryDb>) -> Result<Vec<WorkspaceSummary>, String> {
    db.with_conn(repository::list_workspaces)
}

#[tauri::command]
pub fn get_workspace(
    db: State<'_, MemoryDb>,
    workspace_id: String,
) -> Result<Option<Workspace>, String> {
    db.with_conn(|conn| repository::get_workspace(conn, &workspace_id))
}

#[tauri::command]
pub fn delete_workspace(db: State<'_, MemoryDb>, workspace_id: String) -> Result<(), String> {
    db.with_conn(|conn| repository::delete_workspace(conn, &workspace_id))
}

#[tauri::command]
pub fn rename_workspace(
    db: State<'_, MemoryDb>,
    workspace_id: String,
    name: String,
) -> Result<(), String> {
    db.with_conn(|conn| repository::rename_workspace(conn, &workspace_id, &name))
}

#[tauri::command]
pub fn pin_workspace(
    db: State<'_, MemoryDb>,
    workspace_id: String,
    pinned: bool,
) -> Result<(), String> {
    db.with_conn(|conn| repository::pin_workspace(conn, &workspace_id, pinned))
}

#[tauri::command]
pub fn open_workspace(db: State<'_, MemoryDb>, workspace_id: String) -> Result<(), String> {
    db.with_conn(|conn| repository::update_workspace_last_opened(conn, &workspace_id))
}

#[tauri::command]
pub fn count_orphaned_conversations(db: State<'_, MemoryDb>) -> Result<i64, String> {
    db.with_conn(repository::count_orphaned_conversations)
}

#[tauri::command]
pub fn assign_orphaned_conversations(
    db: State<'_, MemoryDb>,
    workspace_id: String,
) -> Result<(), String> {
    db.with_conn(|conn| repository::assign_orphaned_conversations(conn, &workspace_id))
}

// ── JSONL Integration Commands ────────────────────────────────────────

#[tauri::command]
pub fn set_conversation_message_source(
    db: State<'_, MemoryDb>,
    conversation_id: String,
    message_source: String,
) -> Result<(), String> {
    if message_source != "db" && message_source != "jsonl" {
        return Err(format!(
            "Invalid message_source: '{}'. Must be 'db' or 'jsonl'.",
            message_source
        ));
    }
    db.with_conn(|conn| repository::set_message_source(conn, &conversation_id, &message_source))
}

#[tauri::command]
pub fn sync_conversation_from_jsonl(
    db: State<'_, MemoryDb>,
    conversation_id: String,
) -> Result<(), String> {
    // 1. Get conversation to find session_id and workspace
    let conv = db
        .with_conn(|conn| repository::get_conversation(conn, &conversation_id))?
        .ok_or_else(|| "Conversation not found".to_string())?;

    let session_id = conv
        .session_id
        .as_ref()
        .ok_or_else(|| "No session_id for conversation".to_string())?;

    // 2. Resolve workspace path
    let workspace_path = if let Some(ref ws_id) = conv.workspace_id {
        db.with_conn(|conn| repository::get_workspace(conn, ws_id))?
            .map(|ws| ws.path)
            .unwrap_or_default()
    } else {
        String::new()
    };

    // 3. Find JSONL file
    let jsonl_path = jsonl::find_jsonl_path(session_id, &workspace_path)
        .ok_or_else(|| format!("JSONL file not found for session {}", session_id))?;

    // 4. Single-pass: count messages, extract preview, index for FTS
    db.with_conn_str(|conn| {
        jsonl::sync_from_jsonl(conn, &conversation_id, &jsonl_path).map(|_| ())
    })?;

    Ok(())
}

// ── Idea Hub Commands ─────────────────────────────────────────────────

const VALID_IDEA_STATUSES: &[&str] = &["draft", "discussing", "ready", "building", "done"];
const VALID_IDEA_PRIORITIES: &[&str] = &["low", "medium", "high"];

fn validate_idea_status(status: &str) -> Result<(), String> {
    if !VALID_IDEA_STATUSES.contains(&status) {
        return Err(format!(
            "Invalid idea status: '{}'. Must be one of: {}",
            status,
            VALID_IDEA_STATUSES.join(", ")
        ));
    }
    Ok(())
}

fn validate_idea_priority(priority: &str) -> Result<(), String> {
    if !VALID_IDEA_PRIORITIES.contains(&priority) {
        return Err(format!(
            "Invalid idea priority: '{}'. Must be one of: {}",
            priority,
            VALID_IDEA_PRIORITIES.join(", ")
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn create_idea(
    db: State<'_, MemoryDb>,
    title: String,
    raw_input: String,
    workspace_id: Option<String>,
    priority: Option<String>,
    tags: Option<String>,
) -> Result<Idea, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let priority = priority.unwrap_or_else(|| "medium".to_string());
    validate_idea_priority(&priority)?;
    let tags = tags.unwrap_or_else(|| "[]".to_string());
    db.with_conn(|conn| {
        repository::create_idea(
            conn,
            &id,
            &title,
            &raw_input,
            workspace_id.as_deref(),
            &priority,
            &tags,
        )
    })
}

#[tauri::command]
pub fn get_idea(db: State<'_, MemoryDb>, idea_id: String) -> Result<Option<Idea>, String> {
    db.with_conn(|conn| repository::get_idea(conn, &idea_id))
}

#[tauri::command]
pub fn list_ideas(
    db: State<'_, MemoryDb>,
    limit: Option<i64>,
    offset: Option<i64>,
    workspace_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<IdeaSummary>, String> {
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);
    db.with_conn(|conn| {
        repository::list_ideas(
            conn,
            limit,
            offset,
            workspace_id.as_deref(),
            status.as_deref(),
        )
    })
}

#[tauri::command]
pub fn update_idea(
    db: State<'_, MemoryDb>,
    idea_id: String,
    title: String,
    raw_input: String,
    tags: Option<String>,
    priority: Option<String>,
) -> Result<(), String> {
    let tags = tags.unwrap_or_else(|| "[]".to_string());
    let priority = priority.unwrap_or_else(|| "medium".to_string());
    validate_idea_priority(&priority)?;
    db.with_conn(|conn| {
        repository::update_idea(conn, &idea_id, &title, &raw_input, &tags, &priority)
    })
}

#[tauri::command]
pub fn update_idea_status(
    db: State<'_, MemoryDb>,
    idea_id: String,
    status: String,
) -> Result<(), String> {
    validate_idea_status(&status)?;
    db.with_conn(|conn| repository::update_idea_status(conn, &idea_id, &status))
}

#[tauri::command]
pub fn update_idea_summary(
    db: State<'_, MemoryDb>,
    idea_id: String,
    summary_json: String,
) -> Result<(), String> {
    db.with_conn(|conn| repository::update_idea_summary(conn, &idea_id, &summary_json))
}

#[tauri::command]
pub fn link_idea_discussion(
    db: State<'_, MemoryDb>,
    idea_id: String,
    conversation_id: String,
) -> Result<(), String> {
    db.with_conn(|conn| repository::link_idea_discussion(conn, &idea_id, &conversation_id))
}

#[tauri::command]
pub fn link_idea_conversation(
    db: State<'_, MemoryDb>,
    idea_id: String,
    conversation_id: String,
) -> Result<(), String> {
    db.with_conn(|conn| repository::link_idea_conversation(conn, &idea_id, &conversation_id))
}

#[tauri::command]
pub fn delete_idea(db: State<'_, MemoryDb>, idea_id: String) -> Result<(), String> {
    db.with_conn(|conn| repository::delete_idea(conn, &idea_id))
}

#[tauri::command]
pub fn search_ideas(
    db: State<'_, MemoryDb>,
    query: String,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<IdeaSummary>, String> {
    let limit = limit.unwrap_or(50);
    db.with_conn(|conn| repository::search_ideas(conn, &query, workspace_id.as_deref(), limit))
}

#[tauri::command]
pub fn count_ideas_by_status(
    db: State<'_, MemoryDb>,
    workspace_id: Option<String>,
) -> Result<IdeaStatusCounts, String> {
    db.with_conn(|conn| repository::count_ideas_by_status(conn, workspace_id.as_deref()))
}

// ── Idea Hub Extended Commands ────────────────────────────────────────

#[tauri::command]
pub fn update_idea_sort_orders(
    db: State<'_, MemoryDb>,
    updates: Vec<(String, i64)>,
) -> Result<(), String> {
    db.with_conn(|conn| repository::update_idea_sort_orders(conn, &updates))
}

#[tauri::command]
pub fn update_idea_checklist(
    db: State<'_, MemoryDb>,
    idea_id: String,
    checklist_json: Option<String>,
) -> Result<(), String> {
    db.with_conn(|conn| {
        repository::update_idea_checklist(conn, &idea_id, checklist_json.as_deref())
    })
}

#[tauri::command]
pub fn update_idea_planned_date(
    db: State<'_, MemoryDb>,
    idea_id: String,
    planned_date: Option<String>,
) -> Result<(), String> {
    db.with_conn(|conn| {
        repository::update_idea_planned_date(conn, &idea_id, planned_date.as_deref())
    })
}

#[tauri::command]
pub fn update_idea_images(
    db: State<'_, MemoryDb>,
    idea_id: String,
    images_json: Option<String>,
) -> Result<(), String> {
    db.with_conn(|conn| repository::update_idea_images(conn, &idea_id, images_json.as_deref()))
}

#[tauri::command]
pub fn complete_idea(db: State<'_, MemoryDb>, idea_id: String) -> Result<(), String> {
    db.with_conn(|conn| repository::complete_idea(conn, &idea_id))
}

#[tauri::command]
pub fn uncomplete_idea(db: State<'_, MemoryDb>, idea_id: String) -> Result<(), String> {
    db.with_conn(|conn| repository::uncomplete_idea(conn, &idea_id))
}

#[tauri::command]
pub fn save_idea_image(
    app: AppHandle,
    idea_id: String,
    image_data: Vec<u8>,
    file_extension: String,
) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let images_dir = app_data.join("idea-images");
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create idea-images dir: {}", e))?;

    let filename = format!("{}_{}.{}", idea_id, uuid::Uuid::new_v4(), file_extension);
    let file_path = images_dir.join(&filename);
    std::fs::write(&file_path, &image_data).map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(filename)
}

#[tauri::command]
pub fn delete_idea_image(app: AppHandle, filename: String) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let file_path = app_data.join("idea-images").join(&filename);
    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| format!("Failed to delete image: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_idea_image_path(app: AppHandle, filename: String) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let file_path = app_data.join("idea-images").join(&filename);
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_idea_image_base64(app: AppHandle, filename: String) -> Result<String, String> {
    use base64::Engine;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let file_path = app_data.join("idea-images").join(&filename);
    let data = std::fs::read(&file_path).map_err(|e| format!("Failed to read image: {}", e))?;

    let ext = filename.rsplit('.').next().unwrap_or("png").to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// ── Health Check Commands ─────────────────────────────────────────────

#[tauri::command]
pub fn save_health_check_result(
    db: State<'_, MemoryDb>,
    workspace_id: String,
    overall_score: i64,
    summary: String,
    dimensions: String,
) -> Result<(), String> {
    db.with_conn(|conn| {
        repository::save_health_check_result(
            conn,
            &workspace_id,
            overall_score,
            &summary,
            &dimensions,
        )
    })
}

#[tauri::command]
pub fn get_last_health_check_result(
    db: State<'_, MemoryDb>,
    workspace_id: String,
) -> Result<Option<repository::HealthCheckResult>, String> {
    db.with_conn(|conn| repository::get_last_health_check_result(conn, &workspace_id))
}

#[tauri::command]
pub fn list_health_check_results(
    db: State<'_, MemoryDb>,
    workspace_id: String,
    limit: Option<i64>,
) -> Result<Vec<repository::HealthCheckResult>, String> {
    db.with_conn(|conn| {
        repository::list_health_check_results(conn, &workspace_id, limit.unwrap_or(20))
    })
}

// ── Tech Stack Detection ──────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct TechStackItem {
    pub name: String,
    pub category: String, // "language", "framework", "runtime", "tool", "styling"
}

#[tauri::command]
pub fn detect_tech_stack(path: String) -> Result<Vec<TechStackItem>, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut stack: Vec<TechStackItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Scan root directory first
    detect_tech_in_dir(root, &mut stack, &mut seen);

    // Also scan subdirectories up to 2 levels deep (handles monorepo / nested project layouts)
    scan_subdirs(root, &mut stack, &mut seen, 2);

    // Sort: language > runtime > framework > styling > tool
    stack.sort_by_key(|item| match item.category.as_str() {
        "language" => 0,
        "runtime" => 1,
        "framework" => 2,
        "styling" => 3,
        "tool" => 4,
        _ => 5,
    });

    Ok(stack)
}

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".git",
    "__pycache__",
    "vendor",
];

fn scan_subdirs(
    dir: &std::path::Path,
    stack: &mut Vec<TechStackItem>,
    seen: &mut std::collections::HashSet<String>,
    depth: u8,
) {
    if depth == 0 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || SKIP_DIRS.contains(&name_str.as_ref()) {
            continue;
        }
        let sub = entry.path();
        detect_tech_in_dir(&sub, stack, seen);
        scan_subdirs(&sub, stack, seen, depth - 1);
    }
}

fn add_tech(
    name: &str,
    category: &str,
    stack: &mut Vec<TechStackItem>,
    seen: &mut std::collections::HashSet<String>,
) {
    if seen.insert(name.to_string()) {
        stack.push(TechStackItem {
            name: name.to_string(),
            category: category.to_string(),
        });
    }
}

fn detect_tech_in_dir(
    dir: &std::path::Path,
    stack: &mut Vec<TechStackItem>,
    seen: &mut std::collections::HashSet<String>,
) {
    // ── Languages ──────────────────────────────────────────────
    if dir.join("tsconfig.json").exists() || dir.join("tsconfig.base.json").exists() {
        add_tech("TypeScript", "language", stack, seen);
    }
    if dir.join("Cargo.toml").exists() {
        add_tech("Rust", "language", stack, seen);
    }
    if dir.join("go.mod").exists() {
        add_tech("Go", "language", stack, seen);
    }
    if dir.join("requirements.txt").exists()
        || dir.join("pyproject.toml").exists()
        || dir.join("setup.py").exists()
        || dir.join("Pipfile").exists()
    {
        add_tech("Python", "language", stack, seen);
    }
    if dir.join("pom.xml").exists()
        || dir.join("build.gradle").exists()
        || dir.join("build.gradle.kts").exists()
    {
        add_tech("Java", "language", stack, seen);
    }
    if dir.join("Gemfile").exists() {
        add_tech("Ruby", "language", stack, seen);
    }
    if dir.join("composer.json").exists() {
        add_tech("PHP", "language", stack, seen);
    }
    if dir.join("pubspec.yaml").exists() {
        add_tech("Dart", "language", stack, seen);
    }
    if dir.join("mix.exs").exists() {
        add_tech("Elixir", "language", stack, seen);
    }
    if dir.join("build.sbt").exists() {
        add_tech("Scala", "language", stack, seen);
    }
    if dir.join("Package.swift").exists() {
        add_tech("Swift", "language", stack, seen);
    }

    // Check for .sln or .csproj
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.ends_with(".sln") || name_str.ends_with(".csproj") {
                add_tech("C#", "language", stack, seen);
                break;
            }
        }
    }

    // ── Runtimes ───────────────────────────────────────────────
    if dir.join("package.json").exists() {
        add_tech("Node.js", "runtime", stack, seen);
    }
    if dir.join("deno.json").exists() || dir.join("deno.jsonc").exists() {
        add_tech("Deno", "runtime", stack, seen);
    }
    if dir.join("bun.lockb").exists() || dir.join("bunfig.toml").exists() {
        add_tech("Bun", "runtime", stack, seen);
    }

    // ── Parse package.json for frameworks/tools ────────────────
    if let Ok(content) = std::fs::read_to_string(dir.join("package.json")) {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
            let deps = collect_dep_keys(&pkg);

            if deps.contains("react") || deps.contains("react-dom") {
                add_tech("React", "framework", stack, seen);
            }
            if deps.contains("vue") {
                add_tech("Vue", "framework", stack, seen);
            }
            if deps.contains("@angular/core") {
                add_tech("Angular", "framework", stack, seen);
            }
            if deps.contains("svelte") {
                add_tech("Svelte", "framework", stack, seen);
            }
            if deps.contains("solid-js") {
                add_tech("Solid", "framework", stack, seen);
            }
            if deps.contains("next") {
                add_tech("Next.js", "framework", stack, seen);
            }
            if deps.contains("nuxt") || deps.contains("nuxt3") {
                add_tech("Nuxt", "framework", stack, seen);
            }
            if deps.contains("express") {
                add_tech("Express", "framework", stack, seen);
            }
            if deps.contains("fastify") {
                add_tech("Fastify", "framework", stack, seen);
            }
            if deps.contains("hono") {
                add_tech("Hono", "framework", stack, seen);
            }
            if deps.contains("@nestjs/core") {
                add_tech("NestJS", "framework", stack, seen);
            }
            if deps.contains("@remix-run/react") || deps.contains("remix") {
                add_tech("Remix", "framework", stack, seen);
            }
            if deps.contains("astro") {
                add_tech("Astro", "framework", stack, seen);
            }
            if deps.contains("@tauri-apps/api") || deps.contains("@tauri-apps/cli") {
                add_tech("Tauri", "framework", stack, seen);
            }
            if deps.contains("electron") {
                add_tech("Electron", "framework", stack, seen);
            }
            if deps.contains("react-native") {
                add_tech("React Native", "framework", stack, seen);
            }
            if deps.contains("@expo/cli") || deps.contains("expo") {
                add_tech("Expo", "framework", stack, seen);
            }

            if deps.contains("tailwindcss") {
                add_tech("Tailwind CSS", "styling", stack, seen);
            }

            if deps.contains("vite") {
                add_tech("Vite", "tool", stack, seen);
            }
            if deps.contains("webpack") {
                add_tech("Webpack", "tool", stack, seen);
            }
            if deps.contains("prisma") || deps.contains("@prisma/client") {
                add_tech("Prisma", "tool", stack, seen);
            }
            if deps.contains("drizzle-orm") {
                add_tech("Drizzle", "tool", stack, seen);
            }
        }
    }

    // ── Parse Cargo.toml for Rust frameworks ───────────────────
    if let Ok(content) = std::fs::read_to_string(dir.join("Cargo.toml")) {
        let content_lower = content.to_lowercase();
        if content_lower.contains("tauri") {
            add_tech("Tauri", "framework", stack, seen);
        }
        if content_lower.contains("actix-web") {
            add_tech("Actix Web", "framework", stack, seen);
        }
        if content_lower.contains("axum") {
            add_tech("Axum", "framework", stack, seen);
        }
        if content_lower.contains("rocket") {
            add_tech("Rocket", "framework", stack, seen);
        }
        if content_lower.contains("sqlx") {
            add_tech("SQLx", "tool", stack, seen);
        }
        if content_lower.contains("diesel") {
            add_tech("Diesel", "tool", stack, seen);
        }
    }

    // ── Config file detection ──────────────────────────────────
    if !seen.contains("Tailwind CSS") {
        let has_tailwind = dir.join("tailwind.config.js").exists()
            || dir.join("tailwind.config.ts").exists()
            || dir.join("tailwind.config.cjs").exists()
            || dir.join("tailwind.config.mjs").exists();
        if has_tailwind {
            add_tech("Tailwind CSS", "styling", stack, seen);
        }
    }

    if dir.join("Dockerfile").exists()
        || dir.join("docker-compose.yml").exists()
        || dir.join("docker-compose.yaml").exists()
        || dir.join("compose.yml").exists()
        || dir.join("compose.yaml").exists()
    {
        add_tech("Docker", "tool", stack, seen);
    }

    if dir.join("wrangler.toml").exists()
        || dir.join("wrangler.jsonc").exists()
        || dir.join("wrangler.json").exists()
    {
        add_tech("Cloudflare Workers", "tool", stack, seen);
    }

    if dir.join("pubspec.yaml").exists() {
        if let Ok(content) = std::fs::read_to_string(dir.join("pubspec.yaml")) {
            if content.contains("flutter") {
                add_tech("Flutter", "framework", stack, seen);
            }
        }
    }
}

/// Collect all dependency keys from package.json (dependencies + devDependencies + peerDependencies)
fn collect_dep_keys(pkg: &serde_json::Value) -> std::collections::HashSet<String> {
    let mut keys = std::collections::HashSet::new();
    for section in &["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(obj) = pkg.get(section).and_then(|v| v.as_object()) {
            for key in obj.keys() {
                keys.insert(key.clone());
            }
        }
    }
    keys
}

// ── Session Activity (Heatmap) Commands ───────────────────────────────

#[tauri::command]
pub async fn get_git_file_changes(cwd: String) -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let mut cmd = std::process::Command::new("git");
    cmd.args(["diff", "--name-only", "HEAD"]).current_dir(&cwd);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = std::str::from_utf8(&output.stderr).unwrap_or("unknown error");
        return Err(format!("git diff failed: {}", stderr));
    }

    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let files: std::collections::HashSet<&str> = stdout.lines().filter(|l| !l.is_empty()).collect();

    Ok(files.len() as u32)
}

#[tauri::command]
pub fn upsert_session_activity(
    db: State<'_, MemoryDb>,
    workspace_id: String,
    date: String,
    conversation_id: String,
    chat_count: i64,
    token_usage: i64,
    file_changes: i64,
) -> Result<(), String> {
    db.with_conn(|conn| {
        repository::upsert_session_activity(
            conn,
            &workspace_id,
            &date,
            &conversation_id,
            chat_count,
            token_usage,
            file_changes,
        )
    })
}

#[tauri::command]
pub fn get_unsynced_activity(
    db: State<'_, MemoryDb>,
) -> Result<Vec<repository::SessionActivityRecord>, String> {
    db.with_conn(repository::get_unsynced_activity)
}

#[tauri::command]
pub fn mark_activity_synced(
    db: State<'_, MemoryDb>,
    ids: Vec<(String, String, String)>,
) -> Result<(), String> {
    db.with_conn(|conn| repository::mark_activity_synced(conn, &ids))
}

#[tauri::command]
pub fn get_local_heatmap(
    db: State<'_, MemoryDb>,
    workspace_id: String,
    days: Option<i64>,
) -> Result<Vec<repository::HeatmapDayData>, String> {
    let days = days.unwrap_or(365).max(1);
    db.with_conn(|conn| repository::get_local_heatmap(conn, &workspace_id, days))
}

// ── Storage Management Commands ─────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct StorageStats {
    pub database_size_bytes: u64,
    pub database_message_count: u64,
    pub database_conversation_count: u64,
    pub jsonl_size_bytes: u64,
    pub jsonl_file_count: u64,
    pub codex_session_size_bytes: u64,
    pub codex_session_count: u64,
    pub temp_size_bytes: u64,
    pub total_size_bytes: u64,
}

fn dir_size(path: &std::path::Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if ft.is_file() {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            } else if ft.is_dir() {
                total += dir_size(&entry.path());
            }
        }
    }
    total
}

fn codex_sessions_root() -> Option<std::path::PathBuf> {
    crate::bytro_home::home_dir()
        .ok()
        .map(|home| codex_sessions_root_for(&home))
}

fn codex_sessions_root_for(bytro_home: &std::path::Path) -> std::path::PathBuf {
    bytro_home.join("codex-sessions")
}

fn codex_session_dir(conversation_id: &str) -> Option<std::path::PathBuf> {
    use sha2::{Digest, Sha256};

    let safe_id = format!("{:x}", Sha256::digest(conversation_id.as_bytes()));
    codex_sessions_root().map(|root| root.join(safe_id))
}

fn count_codex_session_dirs(dir: &std::path::Path) -> (u64, u64) {
    if !dir.exists() {
        return (0, 0);
    }

    let size = dir_size(dir);
    let count = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|ft| ft.is_dir()))
                .count() as u64
        })
        .unwrap_or(0);

    (size, count)
}

fn remove_codex_dir_if_exists(dir: &std::path::Path, _context: &str) -> u64 {
    if !dir.exists() {
        return 0;
    }

    let size = dir_size(dir);
    std::fs::remove_dir_all(dir).map(|()| size).unwrap_or(0)
}

fn remove_codex_session_dir(conversation_id: &str, context: &str) -> u64 {
    codex_session_dir(conversation_id)
        .map(|dir| remove_codex_dir_if_exists(&dir, context))
        .unwrap_or(0)
}

fn remove_all_codex_session_dirs(_context: &str) -> (u64, u64) {
    let Some(root) = codex_sessions_root() else {
        return (0, 0);
    };
    if !root.exists() {
        return (0, 0);
    }

    let (size, count) = count_codex_session_dirs(&root);
    std::fs::remove_dir_all(&root)
        .map(|()| (size, count))
        .unwrap_or((0, 0))
}

fn scan_database_file_size() -> u64 {
    // Database file sizes (memory.db + WAL + SHM)
    let db_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(crate::constants::APP_BUNDLE_ID);
    ["memory.db", "memory.db-wal", "memory.db-shm"]
        .iter()
        .map(|name| {
            std::fs::metadata(db_dir.join(name))
                .map(|m| m.len())
                .unwrap_or(0)
        })
        .sum()
}

fn scan_database_row_counts(db: &MemoryDb) -> Result<(u64, u64), String> {
    db.with_conn(|conn| {
        let msg_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap_or(0);
        let conv_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM conversations", [], |row| row.get(0))
            .unwrap_or(0);
        Ok((msg_count, conv_count))
    })
}

fn scan_jsonl_stats() -> (u64, u64) {
    dirs::home_dir()
        .map(|h| count_jsonl_files(&h.join(".claude").join("projects")))
        .unwrap_or((0, 0))
}

fn scan_codex_stats() -> (u64, u64) {
    codex_sessions_root()
        .map(|dir| count_codex_session_dirs(&dir))
        .unwrap_or((0, 0))
}

fn scan_temp_size() -> u64 {
    // Temp files (sidecar debug log + codex/gemini/skills temp dirs)
    let temp_dir = std::env::temp_dir();
    let debug_log = temp_dir.join("bytro-community-sidecar-debug.log");
    let mut total = std::fs::metadata(&debug_log).map(|m| m.len()).unwrap_or(0);
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if (name_str.starts_with("bytro-community-codex-")
                || name_str.starts_with("codex-img-")
                || name_str == "skills-clone")
                && entry.file_type().is_ok_and(|ft| ft.is_dir())
            {
                total += dir_size(&entry.path());
            }
        }
    }
    total
}

async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("blocking task failed: {e}"))
}

#[derive(serde::Serialize, Clone)]
pub struct DatabaseStorageStats {
    pub size_bytes: u64,
    pub message_count: u64,
    pub conversation_count: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct StorageCategoryStats {
    pub size_bytes: u64,
    pub count: u64,
}

#[tauri::command]
pub async fn get_storage_stats_database(
    db: State<'_, MemoryDb>,
) -> Result<DatabaseStorageStats, String> {
    let size_bytes = scan_database_file_size();
    let (message_count, conversation_count) = scan_database_row_counts(&db)?;
    Ok(DatabaseStorageStats {
        size_bytes,
        message_count,
        conversation_count,
    })
}

#[tauri::command]
pub async fn get_storage_stats_jsonl() -> Result<StorageCategoryStats, String> {
    run_blocking(|| {
        let (size_bytes, count) = scan_jsonl_stats();
        StorageCategoryStats { size_bytes, count }
    })
    .await
}

#[tauri::command]
pub async fn get_storage_stats_codex() -> Result<StorageCategoryStats, String> {
    run_blocking(|| {
        let (size_bytes, count) = scan_codex_stats();
        StorageCategoryStats { size_bytes, count }
    })
    .await
}

#[tauri::command]
pub async fn get_storage_stats_temp() -> Result<StorageCategoryStats, String> {
    run_blocking(|| StorageCategoryStats {
        size_bytes: scan_temp_size(),
        count: 0,
    })
    .await
}

// Legacy aggregate command kept for older frontends. Filesystem walks run off
// the main thread via spawn_blocking.
#[tauri::command]
pub async fn get_storage_stats(db: State<'_, MemoryDb>) -> Result<StorageStats, String> {
    let database_size_bytes = scan_database_file_size();
    let (database_message_count, database_conversation_count) = scan_database_row_counts(&db)?;

    let (
        (jsonl_size_bytes, jsonl_file_count),
        (codex_session_size_bytes, codex_session_count),
        temp_size_bytes,
    ) = run_blocking(move || (scan_jsonl_stats(), scan_codex_stats(), scan_temp_size())).await?;

    let total_size_bytes =
        database_size_bytes + jsonl_size_bytes + codex_session_size_bytes + temp_size_bytes;

    Ok(StorageStats {
        database_size_bytes,
        database_message_count,
        database_conversation_count,
        jsonl_size_bytes,
        jsonl_file_count,
        codex_session_size_bytes,
        codex_session_count,
        temp_size_bytes,
        total_size_bytes,
    })
}

fn count_jsonl_files(dir: &std::path::Path) -> (u64, u64) {
    let mut total_size = 0u64;
    let mut file_count = 0u64;
    if !dir.exists() {
        return (0, 0);
    }
    fn walk(dir: &std::path::Path, total_size: &mut u64, file_count: &mut u64) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let ft = match entry.file_type() {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                if ft.is_file() {
                    let name = entry.file_name();
                    if name.to_string_lossy().ends_with(".jsonl") {
                        *total_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
                        *file_count += 1;
                    }
                } else if ft.is_dir() {
                    walk(&entry.path(), total_size, file_count);
                }
            }
        }
    }
    walk(dir, &mut total_size, &mut file_count);
    (total_size, file_count)
}

#[derive(serde::Serialize, Clone)]
pub struct CleanupResult {
    pub freed_bytes: u64,
    pub items_removed: u64,
}

#[tauri::command]
pub async fn clear_old_conversations(
    db: State<'_, MemoryDb>,
    days: i64,
) -> Result<CleanupResult, String> {
    let db = db.inner().clone();
    run_blocking(move || {
        db.with_conn_str(|conn| {
            let count: u64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM conversations
                 WHERE updated_at < datetime('now', ?1)
                   AND is_pinned = 0
                   AND COALESCE(is_deleted, 0) = 0",
                    rusqlite::params![format!("-{} days", days)],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to count old conversations: {}", e))?;

            let freed: u64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(LENGTH(m.content)), 0) FROM messages m
                 JOIN conversations c ON m.conversation_id = c.id
                 WHERE c.updated_at < datetime('now', ?1)
                   AND c.is_pinned = 0
                   AND COALESCE(c.is_deleted, 0) = 0",
                    rusqlite::params![format!("-{} days", days)],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to estimate size: {}", e))?;

            // Only clean up persistent Codex session directories owned by Bytro.
            // Provider-owned data such as ~/.claude/projects is read-only.
            let mut stmt = conn
                .prepare(
                    "SELECT c.id FROM conversations c
                 WHERE c.updated_at < datetime('now', ?1)
                   AND c.is_pinned = 0
                   AND COALESCE(c.is_deleted, 0) = 0",
                )
                .map_err(|e| format!("Failed to prepare session cleanup query: {}", e))?;

            let conversation_ids: Vec<String> = stmt
                .query_map(rusqlite::params![format!("-{} days", days)], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| format!("Failed to query Bytro sessions: {}", e))?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);

            let mut extra_freed = 0u64;
            for conversation_id in &conversation_ids {
                extra_freed += remove_codex_session_dir(conversation_id, "clear_old_conversations");
            }

            let cutoff = format!("-{} days", days);
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("Failed to begin conversation cleanup: {}", e))?;

            for table in [
                "messages",
                "memory_summaries",
                "conversation_todos",
                "conversation_usage",
            ] {
                tx.execute(
                    &format!(
                        "DELETE FROM {table}
                     WHERE conversation_id IN (
                         SELECT id FROM conversations
                         WHERE updated_at < datetime('now', ?1)
                           AND is_pinned = 0
                           AND COALESCE(is_deleted, 0) = 0
                           AND message_source = 'jsonl'
                           AND session_id IS NOT NULL
                           AND session_id != ''
                     )"
                    ),
                    rusqlite::params![&cutoff],
                )
                .map_err(|e| format!("Failed to clear imported conversation data: {}", e))?;
            }

            tx.execute(
                "UPDATE conversations
             SET is_deleted = 1,
                 title = '',
                 preview = '',
                 message_count = 0,
                 workspace_id = NULL,
                 is_pinned = 0,
                 is_archived = 0
             WHERE updated_at < datetime('now', ?1)
               AND is_pinned = 0
               AND COALESCE(is_deleted, 0) = 0
               AND message_source = 'jsonl'
               AND session_id IS NOT NULL
               AND session_id != ''",
                rusqlite::params![&cutoff],
            )
            .map_err(|e| format!("Failed to retain provider session tombstones: {}", e))?;

            tx.execute(
                "DELETE FROM conversations
             WHERE updated_at < datetime('now', ?1)
               AND is_pinned = 0
               AND COALESCE(is_deleted, 0) = 0",
                rusqlite::params![&cutoff],
            )
            .map_err(|e| format!("Failed to delete old conversations: {}", e))?;

            tx.commit()
                .map_err(|e| format!("Failed to commit conversation cleanup: {}", e))?;

            Ok(CleanupResult {
                freed_bytes: freed + extra_freed,
                items_removed: count,
            })
        })
    })
    .await?
}

#[tauri::command]
pub async fn clear_all_conversations(db: State<'_, MemoryDb>) -> Result<CleanupResult, String> {
    let db = db.inner().clone();
    run_blocking(move || {
        db.with_conn_str(|conn| {
            let count: u64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM conversations WHERE COALESCE(is_deleted, 0) = 0",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to count conversations: {}", e))?;

            let freed: u64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(LENGTH(m.content)), 0)
                     FROM messages m
                     JOIN conversations c ON c.id = m.conversation_id
                     WHERE COALESCE(c.is_deleted, 0) = 0",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to estimate size: {}", e))?;

            let (codex_session_freed, _) = remove_all_codex_session_dirs("clear_all_conversations");

            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("Failed to begin conversation cleanup: {}", e))?;

            for table in [
                "messages",
                "memory_summaries",
                "conversation_todos",
                "conversation_usage",
            ] {
                tx.execute(
                    &format!(
                        "DELETE FROM {table}
                         WHERE conversation_id IN (
                             SELECT id FROM conversations
                             WHERE COALESCE(is_deleted, 0) = 0
                               AND message_source = 'jsonl'
                               AND session_id IS NOT NULL
                               AND session_id != ''
                         )"
                    ),
                    [],
                )
                .map_err(|e| format!("Failed to clear imported conversation data: {}", e))?;
            }

            tx.execute(
                "UPDATE conversations
                 SET is_deleted = 1,
                     title = '',
                     preview = '',
                     message_count = 0,
                     workspace_id = NULL,
                     is_pinned = 0,
                     is_archived = 0
                 WHERE COALESCE(is_deleted, 0) = 0
                   AND message_source = 'jsonl'
                   AND session_id IS NOT NULL
                   AND session_id != ''",
                [],
            )
            .map_err(|e| format!("Failed to retain provider session tombstones: {}", e))?;

            tx.execute(
                "DELETE FROM conversations WHERE COALESCE(is_deleted, 0) = 0",
                [],
            )
            .map_err(|e| format!("Failed to clear conversations: {}", e))?;

            tx.commit()
                .map_err(|e| format!("Failed to commit conversation cleanup: {}", e))?;

            Ok(CleanupResult {
                freed_bytes: freed + codex_session_freed,
                items_removed: count,
            })
        })
    })
    .await?
}

#[tauri::command]
pub async fn vacuum_database(db: State<'_, MemoryDb>) -> Result<CleanupResult, String> {
    let db = db.inner().clone();
    run_blocking(move || {
        db.with_conn_str(|conn| {
            let freelist_count: u64 = conn
                .query_row("PRAGMA freelist_count", [], |row| row.get(0))
                .map_err(|e| format!("Failed to get freelist_count: {}", e))?;
            let page_size: u64 = conn
                .query_row("PRAGMA page_size", [], |row| row.get(0))
                .map_err(|e| format!("Failed to get page_size: {}", e))?;

            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|e| format!("WAL checkpoint failed: {}", e))?;

            conn.execute_batch("INSERT INTO messages_fts(messages_fts) VALUES('optimize');")
                .map_err(|e| format!("FTS optimize failed: {}", e))?;

            conn.execute_batch("VACUUM;")
                .map_err(|e| format!("VACUUM failed: {}", e))?;

            let freed = freelist_count * page_size;

            Ok(CleanupResult {
                freed_bytes: freed,
                items_removed: 0,
            })
        })
    })
    .await?
}

#[tauri::command]
pub async fn clear_activity_data(db: State<'_, MemoryDb>) -> Result<CleanupResult, String> {
    let db = db.inner().clone();
    run_blocking(move || {
        db.with_conn_str(|conn| {
            let activity_count: u64 = conn
                .query_row("SELECT COUNT(*) FROM session_activity", [], |row| {
                    row.get(0)
                })
                .map_err(|e| format!("Failed to count activity: {}", e))?;
            let health_count: u64 = conn
                .query_row("SELECT COUNT(*) FROM health_check_results", [], |row| {
                    row.get(0)
                })
                .map_err(|e| format!("Failed to count health checks: {}", e))?;

            conn.execute_batch(
                "DELETE FROM session_activity;
             DELETE FROM health_check_results;",
            )
            .map_err(|e| format!("Failed to clear activity data: {}", e))?;

            Ok(CleanupResult {
                freed_bytes: 0,
                items_removed: activity_count + health_count,
            })
        })
    })
    .await?
}

#[tauri::command]
pub async fn clear_temp_files() -> Result<CleanupResult, String> {
    run_blocking(|| {
        let temp_dir = std::env::temp_dir();
        let mut freed = 0u64;
        let mut count = 0u64;

        let debug_log = temp_dir.join("bytro-community-sidecar-debug.log");
        if debug_log.exists() {
            freed += std::fs::metadata(&debug_log).map(|m| m.len()).unwrap_or(0);
            let _ = std::fs::remove_file(&debug_log);
            count += 1;
        }

        if let Ok(entries) = std::fs::read_dir(&temp_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if (name_str.starts_with("bytro-community-codex-")
                    || name_str.starts_with("codex-img-")
                    || name_str == "skills-clone")
                    && entry.file_type().is_ok_and(|ft| ft.is_dir())
                {
                    let size = dir_size(&entry.path());
                    if std::fs::remove_dir_all(entry.path()).is_ok() {
                        freed += size;
                        count += 1;
                    }
                }
            }
        }

        CleanupResult {
            freed_bytes: freed,
            items_removed: count,
        }
    })
    .await
}

// ── User Preferences / Last-Used Model ───────────────────────────────

#[tauri::command]
pub fn set_last_used_model(
    db: State<'_, MemoryDb>,
    platform_id: String,
    model_id: String,
    is_official: bool,
) -> Result<(), String> {
    db.with_conn(|conn| {
        repository::set_user_preference(conn, "last_platform_id", &platform_id)?;
        repository::set_user_preference(conn, "last_model_id", &model_id)?;
        repository::set_user_preference(
            conn,
            "last_is_official",
            if is_official { "true" } else { "false" },
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_last_used_model(db: State<'_, MemoryDb>) -> Result<Option<LastUsedModel>, String> {
    db.with_conn(|conn| {
        let platform_id = repository::get_user_preference(conn, "last_platform_id")?;
        let model_id = repository::get_user_preference(conn, "last_model_id")?;
        let is_official = repository::get_user_preference(conn, "last_is_official")?;

        match (platform_id, model_id) {
            (Some(pid), Some(mid)) => Ok(Some(LastUsedModel {
                platform_id: pid,
                model_id: mid,
                is_official: is_official.map(|v| v == "true").unwrap_or(false),
            })),
            _ => Ok(None),
        }
    })
}

#[cfg(test)]
mod codex_session_storage_tests {
    use super::codex_sessions_root_for;

    #[test]
    fn codex_session_deletion_root_is_bytro_owned() {
        let temp = tempfile::tempdir().expect("temporary root");
        let bytro_home = temp.path().join(".bytro-community");
        let deletion_root = codex_sessions_root_for(&bytro_home);

        assert!(deletion_root.starts_with(&bytro_home));
        assert_eq!(deletion_root, bytro_home.join("codex-sessions"));
        for provider_root in [".codex", ".claude", ".gemini"] {
            assert!(!deletion_root.starts_with(temp.path().join(provider_root)));
            assert!(!deletion_root
                .components()
                .any(|component| component.as_os_str() == provider_root));
        }
    }
}
