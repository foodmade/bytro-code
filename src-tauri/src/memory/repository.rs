use rusqlite::{params, Connection};

use super::models::{
    AggregateUsage, ContextUsageRecord, Conversation, ConversationSummary, Idea, IdeaStatusCounts,
    IdeaSummary, MemorySummary, Message, MessagePage, MessageTurnUsage, SearchResult, TodoRecord,
    UsageRecord, Workspace, WorkspaceSummary,
};

const MESSAGE_COLUMNS: &str = "id, conversation_id, role, content, agent, created_at, tool_calls, turn_input_tokens, turn_output_tokens, turn_cache_read_tokens, turn_cache_creation_tokens, turn_total_tokens, turn_duration_ms";

fn message_from_row(row: &rusqlite::Row<'_>) -> Result<Message, rusqlite::Error> {
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        agent: row.get(4)?,
        created_at: row.get(5)?,
        tool_calls: row.get(6)?,
        turn_input_tokens: row.get(7)?,
        turn_output_tokens: row.get(8)?,
        turn_cache_read_tokens: row.get(9)?,
        turn_cache_creation_tokens: row.get(10)?,
        turn_total_tokens: row.get(11)?,
        turn_duration_ms: row.get(12)?,
    })
}

pub fn create_conversation(
    conn: &Connection,
    id: &str,
    model: &str,
    workspace_id: Option<&str>,
    conv_type: Option<&str>,
) -> Result<Conversation, rusqlite::Error> {
    let t = conv_type.unwrap_or("chat");
    conn.execute(
        "INSERT INTO conversations (id, model, workspace_id, conv_type) VALUES (?1, ?2, ?3, ?4)",
        params![id, model, workspace_id, t],
    )?;

    conn.query_row(
        "SELECT id, title, created_at, updated_at, model, message_count, session_id, workspace_id, COALESCE(message_source, 'db'), COALESCE(conv_type, 'chat'), previous_session_ids, parent_conversation_id, forked_from_session_id, forked_from_message_id
         FROM conversations WHERE id = ?1",
        params![id],
        |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                model: row.get(4)?,
                message_count: row.get(5)?,
                session_id: row.get(6)?,
                workspace_id: row.get(7)?,
                message_source: row.get(8)?,
                conv_type: row.get(9)?,
                previous_session_ids: row.get(10)?,
                parent_conversation_id: row.get(11)?,
                forked_from_session_id: row.get(12)?,
                forked_from_message_id: row.get(13)?,
            })
        },
    )
}

/// Create a new conversation that is a fork of an existing one, recording its
/// lineage. `message_source` starts as `'db'` so the copied history renders from
/// SQLite until the first turn forks a real SDK session — at which point the
/// `session` event flips it to `'jsonl'` (see system-handlers.ts).
#[allow(clippy::too_many_arguments)]
pub fn create_forked_conversation(
    conn: &Connection,
    id: &str,
    title: &str,
    model: &str,
    workspace_id: Option<&str>,
    conv_type: &str,
    parent_conversation_id: &str,
    forked_from_session_id: Option<&str>,
    forked_from_message_id: &str,
) -> Result<Conversation, rusqlite::Error> {
    conn.execute(
        "INSERT INTO conversations
             (id, title, model, workspace_id, conv_type, message_source,
              parent_conversation_id, forked_from_session_id, forked_from_message_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 'db', ?6, ?7, ?8)",
        params![
            id,
            title,
            model,
            workspace_id,
            conv_type,
            parent_conversation_id,
            forked_from_session_id,
            forked_from_message_id
        ],
    )?;

    Ok(get_conversation(conn, id)?.expect("just-inserted conversation must exist"))
}

/// Copy a slice of messages into `conversation_id`, preserving each message's
/// original `created_at` (so chronological ordering survives) and per-turn usage,
/// while assigning a fresh primary-key id to every row (messages.id is globally
/// unique). Refreshes the destination's `message_count` once at the end.
pub fn copy_messages_into(
    conn: &Connection,
    conversation_id: &str,
    messages: &[Message],
) -> Result<(), rusqlite::Error> {
    for src in messages {
        let new_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO messages
                 (id, conversation_id, role, content, agent, tool_calls,
                  turn_input_tokens, turn_output_tokens, turn_cache_read_tokens,
                  turn_cache_creation_tokens, turn_total_tokens, turn_duration_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                new_id,
                conversation_id,
                src.role,
                src.content,
                src.agent,
                src.tool_calls,
                src.turn_input_tokens,
                src.turn_output_tokens,
                src.turn_cache_read_tokens,
                src.turn_cache_creation_tokens,
                src.turn_total_tokens,
                src.turn_duration_ms,
                src.created_at
            ],
        )?;
    }

    conn.execute(
        "UPDATE conversations
         SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?1)
         WHERE id = ?1",
        params![conversation_id],
    )?;

    Ok(())
}

pub fn get_conversation(
    conn: &Connection,
    id: &str,
) -> Result<Option<Conversation>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, model, message_count, session_id, workspace_id, COALESCE(message_source, 'db'), COALESCE(conv_type, 'chat'), previous_session_ids, parent_conversation_id, forked_from_session_id, forked_from_message_id
         FROM conversations WHERE id = ?1",
    )?;

    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Conversation {
            id: row.get(0)?,
            title: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            model: row.get(4)?,
            message_count: row.get(5)?,
            session_id: row.get(6)?,
            workspace_id: row.get(7)?,
            message_source: row.get(8)?,
            conv_type: row.get(9)?,
            previous_session_ids: row.get(10)?,
            parent_conversation_id: row.get(11)?,
            forked_from_session_id: row.get(12)?,
            forked_from_message_id: row.get(13)?,
        })
    })?;

    match rows.next() {
        Some(Ok(conv)) => Ok(Some(conv)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

pub fn get_conversation_summary(
    conn: &Connection,
    id: &str,
) -> Result<Option<ConversationSummary>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.updated_at, c.model, c.message_count,
                COALESCE(
                    NULLIF(c.preview, ''),
                    (SELECT substr(m.content, 1, 100)
                     FROM messages m
                     WHERE m.conversation_id = c.id
                     ORDER BY m.created_at DESC
                     LIMIT 1),
                    ''
                ) as preview,
                c.workspace_id,
                c.session_id,
                COALESCE(c.is_pinned, 0) as is_pinned,
                COALESCE(c.is_archived, 0) as is_archived,
                c.parent_conversation_id
         FROM conversations c
         WHERE c.id = ?1 AND COALESCE(c.is_deleted, 0) = 0
               AND COALESCE(c.conv_type, 'chat') = 'chat'",
    )?;

    let mut rows = stmt.query_map(params![id], |row| {
        Ok(ConversationSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            updated_at: row.get(2)?,
            model: row.get(3)?,
            message_count: row.get(4)?,
            preview: row.get(5)?,
            workspace_id: row.get(6)?,
            session_id: row.get(7)?,
            is_pinned: row.get::<_, i64>(8)? != 0,
            is_archived: row.get::<_, i64>(9)? != 0,
            parent_conversation_id: row.get(10)?,
        })
    })?;

    match rows.next() {
        Some(Ok(conv)) => Ok(Some(conv)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

/// Update session_id, preserving the old one in `previous_session_ids` chain.
/// This prevents JSONL file orphaning when session resume fails and a new
/// session is created by the SDK retry logic.
pub fn update_session_id(
    conn: &Connection,
    conversation_id: &str,
    session_id: &str,
) -> Result<(), rusqlite::Error> {
    // Read current session_id to chain it
    let current: Option<String> = conn
        .query_row(
            "SELECT session_id FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )
        .unwrap_or(None);

    // If the session_id is actually changing, append old one to the chain
    if let Some(ref old_sid) = current {
        if !old_sid.is_empty() && old_sid != session_id {
            let prev: Option<String> = conn
                .query_row(
                    "SELECT previous_session_ids FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .unwrap_or(None);

            let new_chain = match prev {
                Some(existing) if !existing.is_empty() => format!("{},{}", existing, old_sid),
                _ => old_sid.clone(),
            };

            conn.execute(
                "UPDATE conversations SET session_id = ?2, previous_session_ids = ?3 WHERE id = ?1",
                params![conversation_id, session_id, new_chain],
            )?;
            return Ok(());
        }
    }

    conn.execute(
        "UPDATE conversations SET session_id = ?2 WHERE id = ?1",
        params![conversation_id, session_id],
    )?;
    Ok(())
}

pub fn list_conversations(
    conn: &Connection,
    limit: i64,
    offset: i64,
    workspace_id: Option<&str>,
    archived: bool,
) -> Result<Vec<ConversationSummary>, rusqlite::Error> {
    let archived_flag = archived as i64;
    let (sql, use_workspace_filter) = match workspace_id {
        Some(_) => (
            "SELECT c.id, c.title, c.updated_at, c.model, c.message_count,
                    COALESCE(
                        NULLIF(c.preview, ''),
                        (SELECT substr(m.content, 1, 100)
                         FROM messages m
                         WHERE m.conversation_id = c.id
                         ORDER BY m.created_at DESC
                         LIMIT 1),
                        ''
                    ) as preview,
                    c.workspace_id,
                    c.session_id,
                    COALESCE(c.is_pinned, 0) as is_pinned,
                    COALESCE(c.is_archived, 0) as is_archived,
                    c.parent_conversation_id
             FROM conversations c
             WHERE c.workspace_id = ?3 AND COALESCE(c.is_deleted, 0) = 0
                   AND COALESCE(c.is_archived, 0) = ?4
                   AND COALESCE(c.conv_type, 'chat') = 'chat'
             ORDER BY c.is_pinned DESC, c.updated_at DESC
             LIMIT ?1 OFFSET ?2",
            true,
        ),
        None => (
            "SELECT c.id, c.title, c.updated_at, c.model, c.message_count,
                    COALESCE(
                        NULLIF(c.preview, ''),
                        (SELECT substr(m.content, 1, 100)
                         FROM messages m
                         WHERE m.conversation_id = c.id
                         ORDER BY m.created_at DESC
                         LIMIT 1),
                        ''
                    ) as preview,
                    c.workspace_id,
                    c.session_id,
                    COALESCE(c.is_pinned, 0) as is_pinned,
                    COALESCE(c.is_archived, 0) as is_archived,
                    c.parent_conversation_id
             FROM conversations c
             WHERE COALESCE(c.is_deleted, 0) = 0
                   AND COALESCE(c.is_archived, 0) = ?3
                   AND COALESCE(c.conv_type, 'chat') = 'chat'
             ORDER BY c.is_pinned DESC, c.updated_at DESC
             LIMIT ?1 OFFSET ?2",
            false,
        ),
    };

    let mut stmt = conn.prepare(sql)?;

    let map_row = |row: &rusqlite::Row| {
        Ok(ConversationSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            updated_at: row.get(2)?,
            model: row.get(3)?,
            message_count: row.get(4)?,
            preview: row.get(5)?,
            workspace_id: row.get(6)?,
            session_id: row.get(7)?,
            is_pinned: row.get::<_, i64>(8)? != 0,
            is_archived: row.get::<_, i64>(9)? != 0,
            parent_conversation_id: row.get(10)?,
        })
    };

    let rows = if use_workspace_filter {
        stmt.query_map(params![limit, offset, workspace_id, archived_flag], map_row)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map(params![limit, offset, archived_flag], map_row)?
            .collect::<Result<Vec<_>, _>>()?
    };

    Ok(rows)
}

pub fn pin_conversation(conn: &Connection, id: &str, pinned: bool) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET is_pinned = ?2 WHERE id = ?1",
        params![id, pinned as i64],
    )?;
    Ok(())
}

pub fn set_conversation_archived(
    conn: &Connection,
    id: &str,
    archived: bool,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET is_archived = ?2 WHERE id = ?1",
        params![id, archived as i64],
    )?;
    Ok(())
}

pub fn get_conversation_messages(
    conn: &Connection,
    conversation_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Message>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {}
         FROM messages
         WHERE conversation_id = ?1
         ORDER BY created_at ASC
         LIMIT ?2 OFFSET ?3",
        MESSAGE_COLUMNS
    ))?;

    let rows = stmt.query_map(params![conversation_id, limit, offset], message_from_row)?;

    rows.collect()
}

/// Count total messages for a conversation.
pub fn count_messages(conn: &Connection, conversation_id: &str) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
        params![conversation_id],
        |row| row.get(0),
    )
}

/// Get the latest N messages (from the tail) for a conversation, returning them
/// in chronological (ASC) order along with the total count.
pub fn get_latest_messages(
    conn: &Connection,
    conversation_id: &str,
    limit: i64,
) -> Result<MessagePage, rusqlite::Error> {
    let total = count_messages(conn, conversation_id)?;

    // Use a sub-query: select the last N rows (DESC) then re-order ASC
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM (
             SELECT {}
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2
         ) ORDER BY created_at ASC",
        MESSAGE_COLUMNS, MESSAGE_COLUMNS
    ))?;

    let rows = stmt.query_map(params![conversation_id, limit], message_from_row)?;

    let messages: Vec<Message> = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(MessagePage { messages, total })
}

pub fn set_message_source(
    conn: &Connection,
    conversation_id: &str,
    message_source: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET message_source = ?2 WHERE id = ?1",
        params![conversation_id, message_source],
    )?;
    Ok(())
}

// This repository boundary maps the explicit message fields to a single SQL row.
#[allow(clippy::too_many_arguments)]
pub fn save_message(
    conn: &Connection,
    id: &str,
    conversation_id: &str,
    role: &str,
    content: &str,
    agent: Option<&str>,
    tool_calls: Option<&str>,
    turn_usage: Option<&MessageTurnUsage>,
) -> Result<(), rusqlite::Error> {
    // Pre-check the conversation row so a late-arriving message (e.g. chat-done
    // firing after the user deleted the conversation) becomes a no-op instead
    // of a FOREIGN KEY violation that surfaces as a toast error to the user.
    let exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM conversations
            WHERE id = ?1 AND COALESCE(is_deleted, 0) = 0
        )",
        params![conversation_id],
        |row| row.get(0),
    )?;
    if !exists {
        log::info!(
            "[save_message] skipping message {} — conversation {} no longer exists",
            id,
            conversation_id
        );
        return Ok(());
    }

    let turn_input_tokens = turn_usage.map(|u| u.input_tokens);
    let turn_output_tokens = turn_usage.map(|u| u.output_tokens);
    let turn_cache_read_tokens = turn_usage.map(|u| u.cache_read_tokens);
    let turn_cache_creation_tokens = turn_usage.map(|u| u.cache_creation_tokens);
    let turn_total_tokens = turn_usage.map(|u| u.total_tokens);
    let turn_duration_ms = turn_usage.map(|u| u.duration_ms);

    conn.execute(
        "INSERT INTO messages (
             id, conversation_id, role, content, agent, tool_calls,
             turn_input_tokens, turn_output_tokens, turn_cache_read_tokens,
             turn_cache_creation_tokens, turn_total_tokens, turn_duration_ms
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
             conversation_id = excluded.conversation_id,
             role = excluded.role,
             content = excluded.content,
             agent = excluded.agent,
             tool_calls = excluded.tool_calls,
             turn_input_tokens = COALESCE(excluded.turn_input_tokens, messages.turn_input_tokens),
             turn_output_tokens = COALESCE(excluded.turn_output_tokens, messages.turn_output_tokens),
             turn_cache_read_tokens = COALESCE(excluded.turn_cache_read_tokens, messages.turn_cache_read_tokens),
             turn_cache_creation_tokens = COALESCE(excluded.turn_cache_creation_tokens, messages.turn_cache_creation_tokens),
             turn_total_tokens = COALESCE(excluded.turn_total_tokens, messages.turn_total_tokens),
             turn_duration_ms = COALESCE(excluded.turn_duration_ms, messages.turn_duration_ms)",
        params![
            id,
            conversation_id,
            role,
            content,
            agent,
            tool_calls,
            turn_input_tokens,
            turn_output_tokens,
            turn_cache_read_tokens,
            turn_cache_creation_tokens,
            turn_total_tokens,
            turn_duration_ms,
        ],
    )?;

    conn.execute(
        "UPDATE conversations
         SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?1),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![conversation_id],
    )?;

    Ok(())
}

pub fn delete_conversation(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    let imported_provider_session: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM conversations
            WHERE id = ?1
              AND message_source = 'jsonl'
              AND session_id IS NOT NULL
              AND session_id != ''
        )",
        params![id],
        |row| row.get(0),
    )?;

    if imported_provider_session {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM memory_summaries WHERE conversation_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM conversation_todos WHERE conversation_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM conversation_usage WHERE conversation_id = ?1",
            params![id],
        )?;
        tx.execute(
            "UPDATE conversations
             SET is_deleted = 1,
                 title = '',
                 preview = '',
                 message_count = 0,
                 workspace_id = NULL,
                 is_pinned = 0,
                 is_archived = 0
             WHERE id = ?1",
            params![id],
        )?;
        tx.commit()?;
    } else {
        // Bytro-owned sessions can be physically removed.
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    }
    Ok(())
}

pub fn rename_conversation(
    conn: &Connection,
    id: &str,
    title: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET title = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![id, title],
    )?;
    Ok(())
}

pub fn update_conversation_model(
    conn: &Connection,
    id: &str,
    model: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET model = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![id, model],
    )?;
    Ok(())
}

pub fn search_memory(
    conn: &Connection,
    query: &str,
    limit: i64,
) -> Result<Vec<SearchResult>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.conversation_id, c.title, m.role,
                snippet(messages_fts, 0, '**', '**', '...', 32) as snippet,
                m.created_at,
                rank
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?1 AND COALESCE(c.is_deleted, 0) = 0
               AND COALESCE(c.is_archived, 0) = 0
         ORDER BY rank
         LIMIT ?2",
    )?;

    let rows = stmt.query_map(params![query, limit], |row| {
        Ok(SearchResult {
            message_id: row.get(0)?,
            conversation_id: row.get(1)?,
            conversation_title: row.get(2)?,
            role: row.get(3)?,
            snippet: row.get(4)?,
            created_at: row.get(5)?,
            rank: row.get(6)?,
        })
    })?;

    rows.collect()
}

pub fn get_recent_summaries(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<MemorySummary>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, summary, key_topics, created_at
         FROM memory_summaries
         ORDER BY created_at DESC
         LIMIT ?1",
    )?;

    let rows = stmt.query_map(params![limit], |row| {
        Ok(MemorySummary {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            summary: row.get(2)?,
            key_topics: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;

    rows.collect()
}

pub fn save_summary(
    conn: &Connection,
    id: &str,
    conversation_id: &str,
    summary: &str,
    key_topics: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO memory_summaries (id, conversation_id, summary, key_topics)
         VALUES (?1, ?2, ?3, ?4)",
        params![id, conversation_id, summary, key_topics],
    )?;
    Ok(())
}

pub fn save_conversation_todos(
    conn: &Connection,
    conversation_id: &str,
    todos: &[TodoRecord],
) -> Result<(), rusqlite::Error> {
    for todo in todos {
        conn.execute(
            "INSERT INTO conversation_todos (conversation_id, content, status, active_form)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(conversation_id, content) DO UPDATE SET
                status = excluded.status,
                active_form = excluded.active_form",
            params![conversation_id, todo.content, todo.status, todo.active_form],
        )?;
    }
    Ok(())
}

pub fn get_conversation_todos(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<TodoRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT content, status, active_form
         FROM conversation_todos
         WHERE conversation_id = ?1
         ORDER BY id ASC",
    )?;

    let rows = stmt.query_map(params![conversation_id], |row| {
        Ok(TodoRecord {
            content: row.get(0)?,
            status: row.get(1)?,
            active_form: row.get(2)?,
        })
    })?;

    rows.collect()
}

// ── Workspace CRUD ──────────────────────────────────────────────────────

pub fn create_workspace(
    conn: &Connection,
    id: &str,
    name: &str,
    path: &str,
) -> Result<Workspace, rusqlite::Error> {
    conn.execute(
        "INSERT INTO workspaces (id, name, path) VALUES (?1, ?2, ?3)",
        params![id, name, path],
    )?;

    conn.query_row(
        "SELECT id, name, path, created_at, last_opened_at, is_pinned
         FROM workspaces WHERE id = ?1",
        params![id],
        |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
                last_opened_at: row.get(4)?,
                is_pinned: row.get::<_, i64>(5)? != 0,
            })
        },
    )
}

pub fn list_workspaces(conn: &Connection) -> Result<Vec<WorkspaceSummary>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT w.id, w.name, w.path, w.last_opened_at, w.is_pinned,
                (SELECT COUNT(*) FROM conversations c WHERE c.workspace_id = w.id AND COALESCE(c.is_deleted, 0) = 0 AND COALESCE(c.is_archived, 0) = 0) as conversation_count
         FROM workspaces w
         ORDER BY w.is_pinned DESC, w.last_opened_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(WorkspaceSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            last_opened_at: row.get(3)?,
            is_pinned: row.get::<_, i64>(4)? != 0,
            conversation_count: row.get(5)?,
        })
    })?;

    rows.collect()
}

pub fn get_workspace(conn: &Connection, id: &str) -> Result<Option<Workspace>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, path, created_at, last_opened_at, is_pinned
         FROM workspaces WHERE id = ?1",
    )?;

    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Workspace {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            created_at: row.get(3)?,
            last_opened_at: row.get(4)?,
            is_pinned: row.get::<_, i64>(5)? != 0,
        })
    })?;

    match rows.next() {
        Some(Ok(ws)) => Ok(Some(ws)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

pub fn get_workspace_by_path(
    conn: &Connection,
    path: &str,
) -> Result<Option<Workspace>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, path, created_at, last_opened_at, is_pinned
         FROM workspaces WHERE path = ?1",
    )?;

    let mut rows = stmt.query_map(params![path], |row| {
        Ok(Workspace {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            created_at: row.get(3)?,
            last_opened_at: row.get(4)?,
            is_pinned: row.get::<_, i64>(5)? != 0,
        })
    })?;

    match rows.next() {
        Some(Ok(ws)) => Ok(Some(ws)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

pub fn delete_workspace(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    // Unlink conversations (don't delete them)
    conn.execute(
        "UPDATE conversations SET workspace_id = NULL WHERE workspace_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn update_workspace_last_opened(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE workspaces SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn rename_workspace(conn: &Connection, id: &str, name: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE workspaces SET name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    Ok(())
}

pub fn pin_workspace(conn: &Connection, id: &str, pinned: bool) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE workspaces SET is_pinned = ?2 WHERE id = ?1",
        params![id, pinned as i64],
    )?;
    Ok(())
}

pub fn count_orphaned_conversations(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM conversations WHERE workspace_id IS NULL AND COALESCE(is_deleted, 0) = 0 AND COALESCE(is_archived, 0) = 0",
        [],
        |row| row.get(0),
    )
}

pub fn assign_orphaned_conversations(
    conn: &Connection,
    workspace_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET workspace_id = ?1 WHERE workspace_id IS NULL AND COALESCE(is_deleted, 0) = 0 AND COALESCE(is_archived, 0) = 0",
        params![workspace_id],
    )?;
    Ok(())
}

// ── Conversation Usage ──────────────────────────────────────────────────

pub fn save_conversation_usage(
    conn: &Connection,
    conversation_id: &str,
    usage: &UsageRecord,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO conversation_usage (conversation_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd, context_window, model, total_duration_ms, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(conversation_id) DO UPDATE SET
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            cache_creation_tokens = excluded.cache_creation_tokens,
            total_cost_usd = excluded.total_cost_usd,
            context_window = excluded.context_window,
            model = excluded.model,
            total_duration_ms = excluded.total_duration_ms,
            updated_at = excluded.updated_at",
        params![
            conversation_id,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens,
            usage.total_cost_usd,
            usage.context_window,
            usage.model,
            usage.total_duration_ms,
        ],
    )?;
    Ok(())
}

pub fn save_conversation_context_usage(
    conn: &Connection,
    conversation_id: &str,
    usage: &ContextUsageRecord,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO conversation_usage (conversation_id, context_window, context_total_tokens, context_max_tokens, context_percentage, context_usage_updated_at, context_breakdown_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(conversation_id) DO UPDATE SET
            context_window = CASE
                WHEN excluded.context_usage_updated_at >= conversation_usage.context_usage_updated_at
                THEN excluded.context_window
                ELSE conversation_usage.context_window
            END,
            context_total_tokens = CASE
                WHEN excluded.context_usage_updated_at >= conversation_usage.context_usage_updated_at
                THEN excluded.context_total_tokens
                ELSE conversation_usage.context_total_tokens
            END,
            context_max_tokens = CASE
                WHEN excluded.context_usage_updated_at >= conversation_usage.context_usage_updated_at
                THEN excluded.context_max_tokens
                ELSE conversation_usage.context_max_tokens
            END,
            context_percentage = CASE
                WHEN excluded.context_usage_updated_at >= conversation_usage.context_usage_updated_at
                THEN excluded.context_percentage
                ELSE conversation_usage.context_percentage
            END,
            context_usage_updated_at = MAX(conversation_usage.context_usage_updated_at, excluded.context_usage_updated_at),
            context_breakdown_json = CASE
                WHEN excluded.context_usage_updated_at >= conversation_usage.context_usage_updated_at
                THEN excluded.context_breakdown_json
                ELSE conversation_usage.context_breakdown_json
            END,
            updated_at = CASE
                WHEN excluded.context_usage_updated_at >= conversation_usage.context_usage_updated_at
                THEN excluded.updated_at
                ELSE conversation_usage.updated_at
            END",
        params![
            conversation_id,
            usage.max_tokens,
            usage.total_tokens,
            usage.max_tokens,
            usage.percentage,
            usage.updated_at,
            usage.breakdown_json,
        ],
    )?;
    Ok(())
}

pub fn get_conversation_usage(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Option<UsageRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd, context_window, model, total_duration_ms, context_total_tokens, context_max_tokens, context_percentage, context_usage_updated_at, context_breakdown_json
         FROM conversation_usage
         WHERE conversation_id = ?1",
    )?;

    let mut rows = stmt.query_map(params![conversation_id], |row| {
        Ok(UsageRecord {
            input_tokens: row.get(0)?,
            output_tokens: row.get(1)?,
            cache_read_tokens: row.get(2)?,
            cache_creation_tokens: row.get(3)?,
            total_cost_usd: row.get(4)?,
            context_window: row.get(5)?,
            model: row.get(6)?,
            total_duration_ms: row.get(7)?,
            context_total_tokens: row.get(8)?,
            context_max_tokens: row.get(9)?,
            context_percentage: row.get(10)?,
            context_usage_updated_at: row.get(11)?,
            context_breakdown_json: row.get(12)?,
        })
    })?;

    match rows.next() {
        Some(Ok(usage)) => Ok(Some(usage)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

pub fn get_aggregate_usage(
    conn: &Connection,
    workspace_id: &str,
) -> Result<AggregateUsage, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(SUM(cu.input_tokens + cu.output_tokens + cu.cache_read_tokens + cu.cache_creation_tokens), 0),
                COUNT(*),
                COALESCE(SUM(cu.total_cost_usd), 0.0)
         FROM conversation_usage cu
         JOIN conversations c ON cu.conversation_id = c.id
         WHERE c.workspace_id = ?1",
    )?;

    stmt.query_row(params![workspace_id], |row| {
        Ok(AggregateUsage {
            total_tokens: row.get(0)?,
            session_count: row.get(1)?,
            total_cost_usd: row.get(2)?,
        })
    })
}

// ── Idea Hub CRUD ─────────────────────────────────────────────────────

fn map_idea(row: &rusqlite::Row) -> Result<Idea, rusqlite::Error> {
    Ok(Idea {
        id: row.get(0)?,
        title: row.get(1)?,
        raw_input: row.get(2)?,
        workspace_id: row.get(3)?,
        status: row.get(4)?,
        priority: row.get(5)?,
        tags: row.get(6)?,
        summary_json: row.get(7)?,
        linked_conversation_id: row.get(8)?,
        discussion_conversation_id: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        sort_order: row.get(12)?,
        checklist_json: row.get(13)?,
        planned_date: row.get(14)?,
        images_json: row.get(15)?,
        completed_at: row.get(16)?,
    })
}

const IDEA_COLUMNS: &str =
    "id, title, raw_input, workspace_id, status, priority, tags, summary_json, \
     linked_conversation_id, discussion_conversation_id, created_at, updated_at, \
     sort_order, checklist_json, planned_date, images_json, completed_at";

pub fn create_idea(
    conn: &Connection,
    id: &str,
    title: &str,
    raw_input: &str,
    workspace_id: Option<&str>,
    priority: &str,
    tags: &str,
) -> Result<Idea, rusqlite::Error> {
    conn.execute(
        "INSERT INTO ideas (id, title, raw_input, workspace_id, priority, tags)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, title, raw_input, workspace_id, priority, tags],
    )?;

    conn.query_row(
        &format!("SELECT {} FROM ideas WHERE id = ?1", IDEA_COLUMNS),
        params![id],
        map_idea,
    )
}

pub fn get_idea(conn: &Connection, id: &str) -> Result<Option<Idea>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("SELECT {} FROM ideas WHERE id = ?1", IDEA_COLUMNS))?;

    let mut rows = stmt.query_map(params![id], map_idea)?;

    match rows.next() {
        Some(Ok(idea)) => Ok(Some(idea)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

pub fn list_ideas(
    conn: &Connection,
    limit: i64,
    offset: i64,
    workspace_id: Option<&str>,
    status: Option<&str>,
) -> Result<Vec<IdeaSummary>, rusqlite::Error> {
    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ws) = workspace_id {
        conditions.push(format!("workspace_id = ?{}", param_values.len() + 1));
        param_values.push(Box::new(ws.to_string()));
    }
    if let Some(st) = status {
        conditions.push(format!("status = ?{}", param_values.len() + 1));
        param_values.push(Box::new(st.to_string()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let limit_idx = param_values.len() + 1;
    let offset_idx = param_values.len() + 2;
    param_values.push(Box::new(limit));
    param_values.push(Box::new(offset));

    let sql = format!(
        "SELECT id, title, raw_input, workspace_id, status, priority, tags,
                summary_json IS NOT NULL as has_summary,
                discussion_conversation_id, linked_conversation_id, updated_at,
                sort_order, checklist_json, planned_date, images_json
         FROM ideas
         {}
         ORDER BY sort_order ASC, updated_at DESC
         LIMIT ?{} OFFSET ?{}",
        where_clause, limit_idx, offset_idx
    );

    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();

    let rows = stmt.query_map(params_ref.as_slice(), |row| {
        Ok(IdeaSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            raw_input: row.get(2)?,
            workspace_id: row.get(3)?,
            status: row.get(4)?,
            priority: row.get(5)?,
            tags: row.get(6)?,
            has_summary: row.get::<_, i64>(7)? != 0,
            discussion_conversation_id: row.get(8)?,
            linked_conversation_id: row.get(9)?,
            updated_at: row.get(10)?,
            sort_order: row.get(11)?,
            checklist_json: row.get(12)?,
            planned_date: row.get(13)?,
            images_json: row.get(14)?,
        })
    })?;

    rows.collect()
}

pub fn update_idea(
    conn: &Connection,
    id: &str,
    title: &str,
    raw_input: &str,
    tags: &str,
    priority: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET title = ?2, raw_input = ?3, tags = ?4, priority = ?5,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, title, raw_input, tags, priority],
    )?;
    Ok(())
}

pub fn update_idea_status(
    conn: &Connection,
    id: &str,
    status: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET status = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, status],
    )?;
    Ok(())
}

pub fn update_idea_summary(
    conn: &Connection,
    id: &str,
    summary_json: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET summary_json = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, summary_json],
    )?;
    Ok(())
}

pub fn link_idea_discussion(
    conn: &Connection,
    id: &str,
    conversation_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET discussion_conversation_id = ?2,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, conversation_id],
    )?;
    Ok(())
}

pub fn link_idea_conversation(
    conn: &Connection,
    id: &str,
    conversation_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET linked_conversation_id = ?2,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, conversation_id],
    )?;
    Ok(())
}

pub fn delete_idea(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM ideas WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn update_idea_sort_orders(
    conn: &Connection,
    updates: &[(String, i64)],
) -> Result<(), rusqlite::Error> {
    let mut stmt = conn.prepare("UPDATE ideas SET sort_order = ?2 WHERE id = ?1")?;
    for (id, sort_order) in updates {
        stmt.execute(params![id, sort_order])?;
    }
    Ok(())
}

pub fn update_idea_checklist(
    conn: &Connection,
    id: &str,
    checklist_json: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET checklist_json = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, checklist_json],
    )?;
    Ok(())
}

pub fn update_idea_planned_date(
    conn: &Connection,
    id: &str,
    planned_date: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET planned_date = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, planned_date],
    )?;
    Ok(())
}

pub fn update_idea_images(
    conn: &Connection,
    id: &str,
    images_json: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET images_json = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, images_json],
    )?;
    Ok(())
}

pub fn complete_idea(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET status = 'done', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn uncomplete_idea(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE ideas SET status = 'building', completed_at = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn search_ideas(
    conn: &Connection,
    query: &str,
    workspace_id: Option<&str>,
    limit: i64,
) -> Result<Vec<IdeaSummary>, rusqlite::Error> {
    // Escape LIKE special characters so user input is treated literally
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let like_query = format!("%{}%", escaped);

    let (sql, use_ws) = match workspace_id {
        Some(_) => (
            "SELECT id, title, raw_input, workspace_id, status, priority, tags,
                    summary_json IS NOT NULL as has_summary,
                    discussion_conversation_id, linked_conversation_id, updated_at,
                    sort_order, checklist_json, planned_date, images_json
             FROM ideas
             WHERE workspace_id = ?3 AND (title LIKE ?1 ESCAPE '\\' OR raw_input LIKE ?1 ESCAPE '\\')
             ORDER BY sort_order ASC, updated_at DESC
             LIMIT ?2",
            true,
        ),
        None => (
            "SELECT id, title, raw_input, workspace_id, status, priority, tags,
                    summary_json IS NOT NULL as has_summary,
                    discussion_conversation_id, linked_conversation_id, updated_at,
                    sort_order, checklist_json, planned_date, images_json
             FROM ideas
             WHERE title LIKE ?1 ESCAPE '\\' OR raw_input LIKE ?1 ESCAPE '\\'
             ORDER BY sort_order ASC, updated_at DESC
             LIMIT ?2",
            false,
        ),
    };

    let mut stmt = conn.prepare(sql)?;

    let map_row = |row: &rusqlite::Row| {
        Ok(IdeaSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            raw_input: row.get(2)?,
            workspace_id: row.get(3)?,
            status: row.get(4)?,
            priority: row.get(5)?,
            tags: row.get(6)?,
            has_summary: row.get::<_, i64>(7)? != 0,
            discussion_conversation_id: row.get(8)?,
            linked_conversation_id: row.get(9)?,
            updated_at: row.get(10)?,
            sort_order: row.get(11)?,
            checklist_json: row.get(12)?,
            planned_date: row.get(13)?,
            images_json: row.get(14)?,
        })
    };

    let rows = if use_ws {
        stmt.query_map(params![like_query, limit, workspace_id], map_row)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map(params![like_query, limit], map_row)?
            .collect::<Result<Vec<_>, _>>()?
    };

    Ok(rows)
}

pub fn count_ideas_by_status(
    conn: &Connection,
    workspace_id: Option<&str>,
) -> Result<IdeaStatusCounts, rusqlite::Error> {
    let (sql, use_ws) = match workspace_id {
        Some(_) => (
            "SELECT
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'discussing' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'marked' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'building' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)
             FROM ideas WHERE workspace_id = ?1",
            true,
        ),
        None => (
            "SELECT
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'discussing' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'marked' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'building' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)
             FROM ideas",
            false,
        ),
    };

    if use_ws {
        conn.query_row(sql, params![workspace_id], |row| {
            Ok(IdeaStatusCounts {
                draft: row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                discussing: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                marked: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                ready: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                building: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                done: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            })
        })
    } else {
        conn.query_row(sql, [], |row| {
            Ok(IdeaStatusCounts {
                draft: row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                discussing: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                marked: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                ready: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                building: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                done: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            })
        })
    }
}

// ── Session Activity (Heatmap) ────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionActivityRecord {
    pub workspace_id: String,
    pub date: String,
    pub conversation_id: String,
    pub chat_count: i64,
    pub token_usage: i64,
    pub file_changes: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HeatmapDayData {
    pub date: String,
    pub chat_count: i64,
    pub token_usage: i64,
    pub file_changes: i64,
}

pub fn upsert_session_activity(
    conn: &Connection,
    workspace_id: &str,
    date: &str,
    conversation_id: &str,
    chat_count: i64,
    token_usage: i64,
    file_changes: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO session_activity (workspace_id, date, conversation_id, chat_count, token_usage, file_changes, synced, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, datetime('now'))
         ON CONFLICT (workspace_id, date, conversation_id) DO UPDATE SET
           chat_count   = session_activity.chat_count + excluded.chat_count,
           token_usage  = excluded.token_usage,
           file_changes = excluded.file_changes,
           synced       = 0,
           updated_at   = excluded.updated_at",
        params![workspace_id, date, conversation_id, chat_count, token_usage, file_changes],
    )?;
    Ok(())
}

pub fn get_unsynced_activity(
    conn: &Connection,
) -> Result<Vec<SessionActivityRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT workspace_id, date, conversation_id, chat_count, token_usage, file_changes
         FROM session_activity WHERE synced = 0",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(SessionActivityRecord {
            workspace_id: row.get(0)?,
            date: row.get(1)?,
            conversation_id: row.get(2)?,
            chat_count: row.get(3)?,
            token_usage: row.get(4)?,
            file_changes: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn mark_activity_synced(
    conn: &Connection,
    ids: &[(String, String, String)],
) -> Result<(), rusqlite::Error> {
    for (workspace_id, date, conv_id) in ids {
        conn.execute(
            "UPDATE session_activity SET synced = 1 WHERE workspace_id = ?1 AND date = ?2 AND conversation_id = ?3",
            params![workspace_id, date, conv_id],
        )?;
    }
    Ok(())
}

pub fn get_local_heatmap(
    conn: &Connection,
    workspace_id: &str,
    days: i64,
) -> Result<Vec<HeatmapDayData>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT date,
                SUM(chat_count)  AS chat_count,
                SUM(token_usage)  AS token_usage,
                SUM(file_changes) AS file_changes
         FROM session_activity
         WHERE workspace_id = ?1 AND date >= date('now', '-' || ?2 || ' days')
         GROUP BY date
         ORDER BY date ASC",
    )?;

    let rows = stmt.query_map(params![workspace_id, days], |row| {
        Ok(HeatmapDayData {
            date: row.get(0)?,
            chat_count: row.get(1)?,
            token_usage: row.get(2)?,
            file_changes: row.get(3)?,
        })
    })?;
    rows.collect()
}

// ── Health Check ──────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct HealthCheckResult {
    pub id: String,
    pub workspace_id: String,
    pub overall_score: i64,
    pub summary: String,
    pub dimensions: String,
    pub created_at: String,
}

pub fn save_health_check_result(
    conn: &Connection,
    workspace_id: &str,
    overall_score: i64,
    summary: &str,
    dimensions: &str,
) -> Result<(), rusqlite::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO health_check_results (id, workspace_id, overall_score, summary, dimensions) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, workspace_id, overall_score, summary, dimensions],
    )?;
    Ok(())
}

pub fn get_last_health_check_result(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Option<HealthCheckResult>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, overall_score, summary, dimensions, created_at FROM health_check_results WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![workspace_id])?;
    match rows.next()? {
        Some(row) => Ok(Some(HealthCheckResult {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            overall_score: row.get(2)?,
            summary: row.get(3)?,
            dimensions: row.get(4)?,
            created_at: row.get(5)?,
        })),
        None => Ok(None),
    }
}

pub fn list_health_check_results(
    conn: &Connection,
    workspace_id: &str,
    limit: i64,
) -> Result<Vec<HealthCheckResult>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, overall_score, summary, dimensions, created_at FROM health_check_results WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![workspace_id, limit], |row| {
        Ok(HealthCheckResult {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            overall_score: row.get(2)?,
            summary: row.get(3)?,
            dimensions: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

// ── User Preferences ─────────────────────────────────────────────────

pub fn get_user_preference(
    conn: &Connection,
    key: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let result = conn.query_row(
        "SELECT value FROM user_preferences WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    );

    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn set_user_preference(
    conn: &Connection,
    key: &str,
    value: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO user_preferences (key, value, updated_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open test database");
        conn.execute_batch(include_str!("migrations.sql"))
            .expect("create base schema");
        conn.execute_batch(
            "ALTER TABLE conversations ADD COLUMN workspace_id TEXT DEFAULT NULL;
             ALTER TABLE conversations ADD COLUMN message_source TEXT DEFAULT 'db';
             ALTER TABLE conversations ADD COLUMN preview TEXT DEFAULT '';
             ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE conversations ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE conversations ADD COLUMN conv_type TEXT NOT NULL DEFAULT 'chat';",
        )
        .expect("add current conversation columns");
        conn
    }

    #[test]
    fn deleting_imported_jsonl_session_keeps_hidden_tombstone() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO workspaces (id, name, path) VALUES ('workspace', 'Workspace', '/project')",
            [],
        )
        .expect("insert workspace");
        conn.execute(
            "INSERT INTO conversations (
                id, title, model, workspace_id, session_id, message_source, message_count, preview
             ) VALUES (
                'conversation', 'Imported', 'claude', 'workspace', 'provider-session',
                'jsonl', 1, 'preview'
             )",
            [],
        )
        .expect("insert imported conversation");
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content)
             VALUES ('message', 'conversation', 'user', 'secret')",
            [],
        )
        .expect("insert imported message");

        delete_conversation(&conn, "conversation").expect("delete imported conversation");

        let tombstone: (i64, String, Option<String>, i64) = conn
            .query_row(
                "SELECT is_deleted, session_id, workspace_id, message_count
                 FROM conversations WHERE id = 'conversation'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read tombstone");
        assert_eq!(tombstone, (1, "provider-session".to_string(), None, 0));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = 'conversation'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count messages"),
            0
        );
    }

    #[test]
    fn deleting_bytro_owned_conversation_removes_row() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO conversations (id, title, model, message_source)
             VALUES ('local', 'Local', 'codex', 'db')",
            [],
        )
        .expect("insert local conversation");

        delete_conversation(&conn, "local").expect("delete local conversation");

        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM conversations WHERE id = 'local'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count local conversation"),
            0
        );
    }
}
