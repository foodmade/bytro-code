use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub last_opened_at: String,
    pub is_pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub last_opened_at: String,
    pub is_pinned: bool,
    pub conversation_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub model: String,
    pub message_count: i64,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub message_source: String,
    pub conv_type: String,
    /// Comma-separated list of previous session IDs (oldest first).
    /// Used to chain JSONL files when session resume fails and a new session is created.
    pub previous_session_ids: Option<String>,
    /// Conversation fork lineage. All `None` for normal (non-forked) conversations.
    /// Parent conversation this one was forked from.
    pub parent_conversation_id: Option<String>,
    /// Snapshot of the source session_id captured at fork time — the resume target
    /// used by the SDK on this conversation's first turn (with `forkSession=true`).
    pub forked_from_session_id: Option<String>,
    /// Anchor message uuid the fork was taken at — passed to the SDK as `resumeSessionAt`.
    pub forked_from_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub model: String,
    pub message_count: i64,
    pub preview: String,
    pub workspace_id: Option<String>,
    pub session_id: Option<String>,
    pub is_pinned: bool,
    pub is_archived: bool,
    /// Parent conversation id when this conversation is a fork; None otherwise.
    pub parent_conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub agent: Option<String>,
    pub turn_input_tokens: Option<i64>,
    pub turn_output_tokens: Option<i64>,
    pub turn_cache_read_tokens: Option<i64>,
    pub turn_cache_creation_tokens: Option<i64>,
    pub turn_total_tokens: Option<i64>,
    pub turn_duration_ms: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub message_id: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub role: String,
    pub snippet: String,
    pub created_at: String,
    pub rank: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryContext {
    pub system_prompt: String,
    pub has_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySummary {
    pub id: String,
    pub conversation_id: String,
    pub summary: String,
    pub key_topics: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoRecord {
    pub content: String,
    pub status: String,
    pub active_form: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRecord {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub total_cost_usd: f64,
    pub context_window: i64,
    #[serde(default)]
    pub context_total_tokens: i64,
    #[serde(default)]
    pub context_max_tokens: i64,
    #[serde(default)]
    pub context_percentage: f64,
    #[serde(default)]
    pub context_usage_updated_at: i64,
    #[serde(default)]
    pub context_breakdown_json: Option<String>,
    pub model: String,
    pub total_duration_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageTurnUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub total_tokens: i64,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextUsageRecord {
    pub total_tokens: i64,
    pub max_tokens: i64,
    pub percentage: f64,
    pub updated_at: i64,
    #[serde(default)]
    pub breakdown_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateUsage {
    pub total_tokens: i64,
    pub session_count: i64,
    pub total_cost_usd: f64,
}

/// Last-used model preference restored on startup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastUsedModel {
    pub platform_id: String,
    pub model_id: String,
    pub is_official: bool,
}

/// Paginated message response: messages + total count for the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagePage {
    pub messages: Vec<Message>,
    pub total: i64,
}

// ── Idea Hub ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Idea {
    pub id: String,
    pub title: String,
    pub raw_input: String,
    pub workspace_id: Option<String>,
    pub status: String,
    pub priority: String,
    pub tags: String,
    pub summary_json: Option<String>,
    pub linked_conversation_id: Option<String>,
    pub discussion_conversation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i64,
    pub checklist_json: Option<String>,
    pub planned_date: Option<String>,
    pub images_json: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeaSummary {
    pub id: String,
    pub title: String,
    pub raw_input: String,
    pub workspace_id: Option<String>,
    pub status: String,
    pub priority: String,
    pub tags: String,
    pub has_summary: bool,
    pub discussion_conversation_id: Option<String>,
    pub linked_conversation_id: Option<String>,
    pub updated_at: String,
    pub sort_order: i64,
    pub checklist_json: Option<String>,
    pub planned_date: Option<String>,
    pub images_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeaStatusCounts {
    pub draft: i64,
    pub discussing: i64,
    pub marked: i64,
    pub ready: i64,
    pub building: i64,
    pub done: i64,
}
