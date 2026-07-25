-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Chat',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    model TEXT NOT NULL DEFAULT '',
    message_count INTEGER NOT NULL DEFAULT 0,
    session_id TEXT DEFAULT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    agent TEXT,
    turn_input_tokens INTEGER DEFAULT NULL,
    turn_output_tokens INTEGER DEFAULT NULL,
    turn_cache_read_tokens INTEGER DEFAULT NULL,
    turn_cache_creation_tokens INTEGER DEFAULT NULL,
    turn_total_tokens INTEGER DEFAULT NULL,
    turn_duration_ms INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Memory summaries table
CREATE TABLE IF NOT EXISTS memory_summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_topics TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON memory_summaries(conversation_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON memory_summaries(created_at DESC);

-- Conversation todos (accumulated across turns)
CREATE TABLE IF NOT EXISTS conversation_todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    active_form TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(conversation_id, content)
);

CREATE INDEX IF NOT EXISTS idx_todos_conversation ON conversation_todos(conversation_id);

-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    is_pinned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened ON workspaces(last_opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_path ON workspaces(path);

-- Conversation token usage (accumulated per conversation)
CREATE TABLE IF NOT EXISTS conversation_usage (
    conversation_id TEXT PRIMARY KEY,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0.0,
    context_window INTEGER NOT NULL DEFAULT 0,
    context_total_tokens INTEGER NOT NULL DEFAULT 0,
    context_max_tokens INTEGER NOT NULL DEFAULT 0,
    context_percentage REAL NOT NULL DEFAULT 0.0,
    context_usage_updated_at INTEGER NOT NULL DEFAULT 0,
    context_breakdown_json TEXT DEFAULT NULL,
    model TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Ideas table (Idea Hub)
CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    raw_input TEXT NOT NULL DEFAULT '',
    workspace_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    priority TEXT NOT NULL DEFAULT 'medium',
    tags TEXT NOT NULL DEFAULT '[]',
    summary_json TEXT,
    linked_conversation_id TEXT,
    discussion_conversation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ideas_workspace ON ideas(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);

-- Health check results
CREATE TABLE IF NOT EXISTS health_check_results (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    overall_score INTEGER NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    dimensions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_health_check_workspace ON health_check_results(workspace_id, created_at DESC);

-- ── Activity heatmap ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_activity (
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

-- Index created in db.rs after migration check

-- ── User Preferences (key-value store) ──────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ── OAuth Tokens (Anthropic subscription login, etc.) ───────────────
CREATE TABLE IF NOT EXISTS oauth_tokens (
    provider          TEXT NOT NULL,
    profile_id        TEXT NOT NULL,
    access_token      TEXT NOT NULL,
    refresh_token     TEXT,
    expires_at        INTEGER NOT NULL,
    scopes            TEXT NOT NULL DEFAULT '',
    account_email     TEXT,
    account_uuid      TEXT,
    organization_uuid TEXT,
    subscription_tier TEXT,
    token_type        TEXT NOT NULL DEFAULT 'Bearer',
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (provider, profile_id)
);

-- ── MCP OAuth Tokens (dynamic OAuth for remote MCP servers) ─────────
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    server_name                 TEXT NOT NULL,
    server_url                  TEXT NOT NULL,
    access_token                TEXT NOT NULL,
    refresh_token               TEXT,
    expires_at                  INTEGER NOT NULL,
    scopes                      TEXT NOT NULL DEFAULT '',
    token_type                  TEXT NOT NULL DEFAULT 'Bearer',
    resource                    TEXT,
    issuer                      TEXT,
    authorization_endpoint      TEXT NOT NULL,
    token_endpoint              TEXT NOT NULL,
    client_id                   TEXT NOT NULL,
    client_secret               TEXT,
    token_endpoint_auth_method  TEXT NOT NULL DEFAULT 'none',
    redirect_uri                TEXT NOT NULL,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (server_name, server_url)
);
