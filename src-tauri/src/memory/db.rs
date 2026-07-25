use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const MIGRATIONS_SQL: &str = include_str!("migrations.sql");

/// Allowed table names for schema introspection — prevents SQL injection
/// in `PRAGMA table_info()` which does not support parameterised queries.
const ALLOWED_TABLES: &[&str] = &[
    "conversations",
    "messages",
    "workspaces",
    "memory_summaries",
    "conversation_todos",
    "conversation_usage",
    "ideas",
    "health_check_results",
    "session_activity",
    "user_preferences",
    "oauth_tokens",
    "mcp_oauth_tokens",
];

/// Check whether a table has a specific column.
fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    if !ALLOWED_TABLES.contains(&table) {
        return false;
    }
    conn.prepare(&format!("PRAGMA table_info({})", table))
        .map(|mut stmt| {
            let cols: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            cols.iter().any(|c| c == column)
        })
        .unwrap_or(false)
}

// Cloneable so commands can move a handle into spawn_blocking; clones share
// the same underlying connection behind the Arc<Mutex>.
#[derive(Clone)]
pub struct MemoryDb {
    conn: Arc<Mutex<Connection>>,
}

impl MemoryDb {
    pub fn new() -> Result<Self, String> {
        let db_path = Self::db_path();

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create database directory: {}", e))?;
        }

        let conn = Connection::open(&db_path).map_err(|e| {
            format!(
                "Failed to open memory database at {}: {}",
                db_path.display(),
                e
            )
        })?;

        conn.execute_batch(
            "PRAGMA journal_mode=WAL;\
             PRAGMA foreign_keys=ON;\
             PRAGMA synchronous=NORMAL;\
             PRAGMA cache_size=-8000;\
             PRAGMA mmap_size=268435456;\
             PRAGMA temp_store=MEMORY;\
             PRAGMA busy_timeout=5000;",
        )
        .map_err(|e| format!("Failed to set PRAGMAs: {}", e))?;

        conn.execute_batch(MIGRATIONS_SQL)
            .map_err(|e| format!("Failed to run migrations: {}", e))?;

        // Idempotent migrations: add columns if missing
        if !has_column(&conn, "conversations", "session_id") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN session_id TEXT DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add session_id column: {}", e))?;
        }

        if !has_column(&conn, "conversations", "workspace_id") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN workspace_id TEXT DEFAULT NULL;
                 CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id, updated_at DESC);"
            )
            .map_err(|e| format!("Failed to add workspace_id column: {}", e))?;
        }

        if !has_column(&conn, "conversations", "message_source") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN message_source TEXT DEFAULT 'db';",
            )
            .map_err(|e| format!("Failed to add message_source column: {}", e))?;
        }

        if !has_column(&conn, "conversations", "preview") {
            conn.execute_batch("ALTER TABLE conversations ADD COLUMN preview TEXT DEFAULT '';")
                .map_err(|e| format!("Failed to add preview column: {}", e))?;
        }

        if !has_column(&conn, "conversations", "is_pinned") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|e| format!("Failed to add is_pinned column: {}", e))?;
        }

        if !has_column(&conn, "conversations", "is_deleted") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|e| format!("Failed to add is_deleted column: {}", e))?;
        }

        if !has_column(&conn, "conversations", "is_archived") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|e| format!("Failed to add is_archived column: {}", e))?;
        }

        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_conversations_workspace_archived_updated ON conversations(workspace_id, is_archived, updated_at DESC);"
        )
        .map_err(|e| format!("Failed to create conversation archive index: {}", e))?;

        if !has_column(&conn, "conversations", "conv_type") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN conv_type TEXT NOT NULL DEFAULT 'chat';",
            )
            .map_err(|e| format!("Failed to add conv_type column: {}", e))?;
        }

        if !has_column(&conn, "conversation_usage", "total_duration_ms") {
            conn.execute_batch("ALTER TABLE conversation_usage ADD COLUMN total_duration_ms INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| format!("Failed to add total_duration_ms column: {}", e))?;
        }
        if !has_column(&conn, "conversation_usage", "context_total_tokens") {
            conn.execute_batch("ALTER TABLE conversation_usage ADD COLUMN context_total_tokens INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| format!("Failed to add context_total_tokens column: {}", e))?;
        }
        if !has_column(&conn, "conversation_usage", "context_max_tokens") {
            conn.execute_batch("ALTER TABLE conversation_usage ADD COLUMN context_max_tokens INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| format!("Failed to add context_max_tokens column: {}", e))?;
        }
        if !has_column(&conn, "conversation_usage", "context_percentage") {
            conn.execute_batch("ALTER TABLE conversation_usage ADD COLUMN context_percentage REAL NOT NULL DEFAULT 0.0;")
                .map_err(|e| format!("Failed to add context_percentage column: {}", e))?;
        }
        if !has_column(&conn, "conversation_usage", "context_usage_updated_at") {
            conn.execute_batch("ALTER TABLE conversation_usage ADD COLUMN context_usage_updated_at INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| format!("Failed to add context_usage_updated_at column: {}", e))?;
        }
        if !has_column(&conn, "conversation_usage", "context_breakdown_json") {
            conn.execute_batch("ALTER TABLE conversation_usage ADD COLUMN context_breakdown_json TEXT DEFAULT NULL;")
                .map_err(|e| format!("Failed to add context_breakdown_json column: {}", e))?;
        }

        // Migrate session_activity: add workspace_id (requires table rebuild for PK change)
        if !has_column(&conn, "session_activity", "workspace_id") {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS session_activity_new (
                    workspace_id    TEXT    NOT NULL DEFAULT '',
                    date            TEXT    NOT NULL,
                    conversation_id TEXT    NOT NULL,
                    chat_count      INTEGER NOT NULL DEFAULT 0,
                    token_usage     INTEGER NOT NULL DEFAULT 0,
                    file_changes    INTEGER NOT NULL DEFAULT 0,
                    synced          INTEGER NOT NULL DEFAULT 0,
                    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY (workspace_id, date, conversation_id)
                );
                INSERT OR IGNORE INTO session_activity_new
                    (workspace_id, date, conversation_id, chat_count, token_usage, file_changes, synced, updated_at)
                SELECT '', date, conversation_id, chat_count, token_usage, file_changes, synced, updated_at
                FROM session_activity;
                DROP TABLE session_activity;
                ALTER TABLE session_activity_new RENAME TO session_activity;"
            )
            .map_err(|e| format!("Failed to migrate session_activity: {}", e))?;
        }

        if !has_column(&conn, "messages", "tool_calls") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN tool_calls TEXT DEFAULT NULL;")
                .map_err(|e| format!("Failed to add tool_calls column: {}", e))?;
        }
        if !has_column(&conn, "messages", "turn_input_tokens") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN turn_input_tokens INTEGER DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add turn_input_tokens column: {}", e))?;
        }
        if !has_column(&conn, "messages", "turn_output_tokens") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN turn_output_tokens INTEGER DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add turn_output_tokens column: {}", e))?;
        }
        if !has_column(&conn, "messages", "turn_cache_read_tokens") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN turn_cache_read_tokens INTEGER DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add turn_cache_read_tokens column: {}", e))?;
        }
        if !has_column(&conn, "messages", "turn_cache_creation_tokens") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN turn_cache_creation_tokens INTEGER DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add turn_cache_creation_tokens column: {}", e))?;
        }
        if !has_column(&conn, "messages", "turn_total_tokens") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN turn_total_tokens INTEGER DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add turn_total_tokens column: {}", e))?;
        }
        if !has_column(&conn, "messages", "turn_duration_ms") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN turn_duration_ms INTEGER DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add turn_duration_ms column: {}", e))?;
        }

        if !has_column(&conn, "conversations", "previous_session_ids") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN previous_session_ids TEXT DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add previous_session_ids column: {}", e))?;
        }

        // Conversation fork: derive a new conversation from a point in an existing one.
        if !has_column(&conn, "conversations", "parent_conversation_id") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add parent_conversation_id column: {}", e))?;
        }
        if !has_column(&conn, "conversations", "forked_from_session_id") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN forked_from_session_id TEXT DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add forked_from_session_id column: {}", e))?;
        }
        if !has_column(&conn, "conversations", "forked_from_message_id") {
            conn.execute_batch(
                "ALTER TABLE conversations ADD COLUMN forked_from_message_id TEXT DEFAULT NULL;",
            )
            .map_err(|e| format!("Failed to add forked_from_message_id column: {}", e))?;
        }

        // Idea Hub: add new columns for enhanced kanban features
        if !has_column(&conn, "ideas", "sort_order") {
            conn.execute_batch(
                "ALTER TABLE ideas ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|e| format!("Failed to add sort_order column: {}", e))?;
        }
        if !has_column(&conn, "ideas", "checklist_json") {
            conn.execute_batch("ALTER TABLE ideas ADD COLUMN checklist_json TEXT DEFAULT NULL;")
                .map_err(|e| format!("Failed to add checklist_json column: {}", e))?;
        }
        if !has_column(&conn, "ideas", "planned_date") {
            conn.execute_batch("ALTER TABLE ideas ADD COLUMN planned_date TEXT DEFAULT NULL;")
                .map_err(|e| format!("Failed to add planned_date column: {}", e))?;
        }
        if !has_column(&conn, "ideas", "images_json") {
            conn.execute_batch("ALTER TABLE ideas ADD COLUMN images_json TEXT DEFAULT NULL;")
                .map_err(|e| format!("Failed to add images_json column: {}", e))?;
        }
        if !has_column(&conn, "ideas", "completed_at") {
            conn.execute_batch("ALTER TABLE ideas ADD COLUMN completed_at TEXT DEFAULT NULL;")
                .map_err(|e| format!("Failed to add completed_at column: {}", e))?;
        }

        // Ensure index exists (covers both fresh installs and upgrades)
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_session_activity_date;
             CREATE INDEX IF NOT EXISTS idx_session_activity_workspace_date ON session_activity(workspace_id, date);"
        )
        .map_err(|e| format!("Failed to create session_activity index: {}", e))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn db_path() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(crate::constants::APP_BUNDLE_ID)
            .join("memory.db")
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        f(&conn).map_err(|e| format!("Database error: {}", e))
    }

    /// Like `with_conn`, but for closures that already return `Result<T, String>`.
    pub fn with_conn_str<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        f(&conn)
    }
}
