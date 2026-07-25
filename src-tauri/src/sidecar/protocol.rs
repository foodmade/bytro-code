use serde::{Deserialize, Serialize};

use super::events::{
    AskUserQuestionItemPayload, McpServerStatusPayload, TodoDiffEntryPayload, TodoItemPayload,
};
use super::session::{OrchestrateKeys, TeamMemberConfig};

// ---------------------------------------------------------------------------
// NDJSON protocol types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub(crate) enum SidecarCommand {
    Query {
        id: String,
        agent: String,
        prompt: String,
        model: String,
        #[serde(rename = "systemPrompt")]
        system_prompt: String,
        #[serde(rename = "permissionMode")]
        permission_mode: String,
        cwd: String,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        /// Conversation fork: branch the resumed session into a new session id.
        #[serde(rename = "forkSession")]
        #[serde(skip_serializing_if = "Option::is_none")]
        fork_session: Option<bool>,
        /// Conversation fork anchor — resume up to and including this message uuid.
        #[serde(rename = "resumeSessionAt")]
        #[serde(skip_serializing_if = "Option::is_none")]
        resume_session_at: Option<String>,
        #[serde(rename = "apiKey")]
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        #[serde(rename = "baseUrl")]
        #[serde(skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
        #[serde(rename = "authMode")]
        #[serde(skip_serializing_if = "Option::is_none")]
        auth_mode: Option<String>,
        #[serde(rename = "profileId")]
        #[serde(skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
        #[serde(rename = "proxyUrl")]
        #[serde(skip_serializing_if = "Option::is_none")]
        proxy_url: Option<String>,
        /// Platform identifier (e.g. "claude", "codex", "gemini").
        #[serde(skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<crate::anthropic::ImageData>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        messages: Option<Vec<crate::anthropic::Message>>,
        #[serde(rename = "mcpServers")]
        #[serde(skip_serializing_if = "Option::is_none")]
        mcp_servers: Option<serde_json::Value>,
        #[serde(rename = "disableTools")]
        #[serde(skip_serializing_if = "Option::is_none")]
        disable_tools: Option<bool>,
        /// Whether extended thinking / reasoning is enabled (legacy).
        #[serde(rename = "thinkingEnabled")]
        #[serde(skip_serializing_if = "Option::is_none")]
        thinking_enabled: Option<bool>,
        /// Reasoning effort level: "off" | "low" | "medium" | "high" | "max".
        #[serde(rename = "reasoningLevel")]
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_level: Option<String>,
        #[serde(rename = "ultracode")]
        #[serde(skip_serializing_if = "Option::is_none")]
        ultracode: Option<bool>,
        /// Claude fast mode — wired into the SDK `fastMode` session setting by
        /// the sidecar Claude handler. Claude only; other agents ignore it.
        #[serde(rename = "fastMode")]
        #[serde(skip_serializing_if = "Option::is_none")]
        fast_mode: Option<bool>,
        /// Default quality for the openai_images MCP tool: "low" | "medium" | "high" | "auto".
        #[serde(rename = "imageGenQuality")]
        #[serde(skip_serializing_if = "Option::is_none")]
        image_gen_quality: Option<String>,
        /// Default size for the openai_images MCP tool (popular gpt-image-2 preset string).
        #[serde(rename = "imageGenSize")]
        #[serde(skip_serializing_if = "Option::is_none")]
        image_gen_size: Option<String>,
        /// Absolute path to the app-managed outputs directory. Sidecar wires
        /// this into `OPENAI_IMAGES_OUT` and tells the model in the system
        /// prompt to write all generated artifacts here (decoupled from cwd).
        #[serde(rename = "outputsDir")]
        #[serde(skip_serializing_if = "Option::is_none")]
        outputs_dir: Option<String>,
        /// Codex App Server service tier override, e.g. "fast".
        #[serde(rename = "serviceTier")]
        #[serde(skip_serializing_if = "Option::is_none")]
        service_tier: Option<String>,
        /// Enable Codex App Server Goals mode for this request.
        #[serde(rename = "goalModeEnabled")]
        #[serde(skip_serializing_if = "Option::is_none")]
        goal_mode_enabled: Option<bool>,
        /// Frontend conversation ID for persistent (warm) session routing.
        #[serde(rename = "conversationId")]
        #[serde(skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
        /// Health-check dimension prompts — injected by PreToolUse hook in the sidecar.
        #[serde(rename = "dimensionPrompts")]
        #[serde(skip_serializing_if = "Option::is_none")]
        dimension_prompts: Option<serde_json::Value>,
        /// Ollama num_ctx override.
        #[serde(rename = "numCtx")]
        #[serde(skip_serializing_if = "Option::is_none")]
        num_ctx: Option<u32>,
        #[serde(rename = "codexBinaryPath")]
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_binary_path: Option<String>,
        #[serde(rename = "claudeBinaryPath")]
        #[serde(skip_serializing_if = "Option::is_none")]
        claude_binary_path: Option<String>,
        /// Slash-command metadata. Codex inspects `canonicalName === "compact"`
        /// to route via `thread/compact/start` RPC; opaque to Rust otherwise.
        #[serde(rename = "commandInvocation")]
        #[serde(skip_serializing_if = "Option::is_none")]
        command_invocation: Option<serde_json::Value>,
        /// Caveman compression mode — "off" or "full". When "full", the sidecar
        /// appends caveman ruleset to the system prompt for ~65% output token
        /// reduction. Currently honored by the Claude handler.
        #[serde(rename = "cavemanMode")]
        #[serde(skip_serializing_if = "Option::is_none")]
        caveman_mode: Option<String>,
    },
    PermissionResponse {
        #[serde(rename = "confirmId")]
        confirm_id: String,
        approved: bool,
    },
    AskUserQuestionResponse {
        #[serde(rename = "confirmId")]
        confirm_id: String,
        answers: std::collections::HashMap<String, String>,
    },
    Abort {
        id: String,
    },
    CodexAuthStart {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
        #[serde(rename = "codexBinaryPath")]
        codex_binary_path: String,
    },
    CodexAuthRead {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
        #[serde(rename = "refreshToken")]
        #[serde(skip_serializing_if = "Option::is_none")]
        refresh_token: Option<bool>,
        #[serde(rename = "codexBinaryPath")]
        codex_binary_path: String,
    },
    CodexAuthCancel {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
        #[serde(rename = "loginId")]
        login_id: String,
        #[serde(rename = "codexBinaryPath")]
        codex_binary_path: String,
    },
    CodexAuthSignOut {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
        #[serde(rename = "codexBinaryPath")]
        codex_binary_path: String,
    },
    UserInput {
        id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<crate::anthropic::ImageData>>,
        #[serde(rename = "reasoningLevel")]
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_level: Option<String>,
        /// Slash-command metadata routed through to the sidecar. Mirrors the
        /// `commandInvocation` field on `Query`; Codex uses it on warm-session
        /// follow-up turns to detect /compact and route via `thread/compact/start`.
        #[serde(rename = "commandInvocation")]
        #[serde(skip_serializing_if = "Option::is_none")]
        command_invocation: Option<serde_json::Value>,
    },
    InitSession {
        id: String,
        model: String,
        cwd: String,
        #[serde(rename = "apiKey")]
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        #[serde(rename = "baseUrl")]
        #[serde(skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
        #[serde(rename = "authMode")]
        #[serde(skip_serializing_if = "Option::is_none")]
        auth_mode: Option<String>,
        #[serde(rename = "profileId")]
        #[serde(skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
        #[serde(rename = "proxyUrl")]
        #[serde(skip_serializing_if = "Option::is_none")]
        proxy_url: Option<String>,
        /// Platform identifier (e.g. "claude", "codex", "gemini").
        #[serde(skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(rename = "mcpServers")]
        #[serde(skip_serializing_if = "Option::is_none")]
        mcp_servers: Option<serde_json::Value>,
        #[serde(rename = "ultracode")]
        #[serde(skip_serializing_if = "Option::is_none")]
        ultracode: Option<bool>,
        #[serde(rename = "fastMode")]
        #[serde(skip_serializing_if = "Option::is_none")]
        fast_mode: Option<bool>,
        #[serde(rename = "codexBinaryPath")]
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_binary_path: Option<String>,
        #[serde(rename = "claudeBinaryPath")]
        #[serde(skip_serializing_if = "Option::is_none")]
        claude_binary_path: Option<String>,
    },
    /// Kill a persistent (warm) CLI session by conversation ID.
    KillSession {
        #[serde(rename = "conversationId")]
        conversation_id: String,
    },
    Shutdown {},
    Orchestrate {
        id: String,
        task: String,
        team: Vec<TeamMemberConfig>,
        cwd: String,
        #[serde(rename = "permissionMode")]
        permission_mode: String,
        keys: OrchestrateKeys,
    },
    RewindFiles {
        id: String,
        #[serde(rename = "userMessageUuid")]
        user_message_uuid: String,
    },
    TeamsQuery {
        id: String,
        task: String,
        agents: Vec<TeamsAgentConfigPayload>,
        cwd: String,
        #[serde(rename = "permissionMode")]
        permission_mode: String,
        #[serde(rename = "apiKey")]
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        #[serde(rename = "baseUrl")]
        #[serde(skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
        #[serde(rename = "proxyUrl")]
        #[serde(skip_serializing_if = "Option::is_none")]
        proxy_url: Option<String>,
        /// Platform identifier (e.g. "claude", "deepseek", "qwen", "kimi").
        /// Wire name is "platform" to match `Query` and sidecar `credential-strategy.ts` —
        /// using "provider" caused the sidecar to fall back to ANTHROPIC_OFFICIAL
        /// strategy and break third-party relays in teams mode.
        #[serde(rename = "platform")]
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(rename = "mcpServers")]
        #[serde(skip_serializing_if = "Option::is_none")]
        mcp_servers: Option<serde_json::Value>,
        #[serde(rename = "responseLanguage")]
        #[serde(skip_serializing_if = "Option::is_none")]
        response_language: Option<String>,
        #[serde(rename = "claudeBinaryPath")]
        claude_binary_path: String,
    },
}

/// A subagent definition sent from the frontend for the SDK `agents` option.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct TeamsAgentConfigPayload {
    pub name: String,
    pub role: String,
    pub description: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ToolDisplayMetaPayload {
    pub status: String,
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "evt", rename_all = "snake_case")]
pub(crate) enum SidecarEvent {
    Ready,
    Session {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    TextDelta {
        id: String,
        delta: String,
    },
    ToolStart {
        id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: String,
    },
    ToolResult {
        id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: String,
        success: bool,
        result: String,
        #[serde(default)]
        display: Option<ToolDisplayMetaPayload>,
    },
    ToolOutput {
        id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        output: String,
    },
    PermissionRequest {
        id: String,
        #[serde(rename = "confirmId")]
        confirm_id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: String,
    },
    ToolDenied {
        id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        reason: String,
    },
    Complete {
        id: String,
        #[serde(rename = "fullText")]
        full_text: String,
    },
    Done {
        id: String,
        #[serde(default, rename = "sessionAlive")]
        session_alive: Option<bool>,
        #[serde(default, rename = "conversationId")]
        conversation_id: Option<String>,
    },
    Error {
        id: String,
        error: String,
        #[serde(default, rename = "apiErrorStatus")]
        api_error_status: Option<u16>,
    },
    CodexAuthStarted {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
        #[serde(rename = "loginId")]
        login_id: String,
        #[serde(default, rename = "authUrl")]
        auth_url: Option<String>,
        #[serde(default, rename = "verificationUrl")]
        verification_url: Option<String>,
        #[serde(default, rename = "userCode")]
        user_code: Option<String>,
    },
    CodexAuthCompleted {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
        #[serde(default)]
        email: Option<String>,
        #[serde(default, rename = "planType")]
        plan_type: Option<String>,
        #[serde(default, rename = "requiresOpenaiAuth")]
        requires_openai_auth: Option<bool>,
        #[serde(default, rename = "rateLimits")]
        rate_limits: Option<serde_json::Value>,
    },
    CodexAuthSignedOut {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    CodexAuthError {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
        error: String,
    },
    Media {
        id: String,
        #[serde(rename = "mediaType")]
        media_type: String,
        data: String,
    },
    OrchestrateStart {
        id: String,
        #[serde(rename = "teamSize")]
        team_size: u32,
    },
    SubtaskStart {
        id: String,
        #[serde(rename = "subtaskId")]
        subtask_id: String,
        #[serde(rename = "assignedTo")]
        assigned_to: String,
        agent: String,
        description: String,
    },
    SubtaskComplete {
        id: String,
        #[serde(rename = "subtaskId")]
        subtask_id: String,
        #[serde(rename = "assignedTo")]
        assigned_to: String,
        result: String,
        success: bool,
    },
    OrchestrateComplete {
        id: String,
        summary: String,
    },
    Usage {
        id: String,
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
        #[serde(rename = "cacheReadTokens")]
        cache_read_tokens: u64,
        #[serde(rename = "cacheCreationTokens")]
        cache_creation_tokens: u64,
        #[serde(rename = "totalCostUsd")]
        total_cost_usd: f64,
        #[serde(rename = "contextWindow")]
        context_window: u64,
        model: String,
    },
    /// Real-time token usage from stream events (message_start / message_delta).
    StreamUsage {
        id: String,
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
        #[serde(rename = "cacheReadTokens")]
        cache_read_tokens: u64,
        #[serde(rename = "cacheCreationTokens")]
        cache_creation_tokens: u64,
        #[serde(default, rename = "contextWindow")]
        context_window: Option<u64>,
    },
    ContextUsage {
        id: String,
        #[serde(default, rename = "conversationId")]
        conversation_id: Option<String>,
        #[serde(rename = "requestedAt")]
        requested_at: u64,
        #[serde(rename = "totalTokens")]
        total_tokens: u64,
        #[serde(rename = "maxTokens")]
        max_tokens: u64,
        percentage: f64,
        #[serde(default)]
        snapshot: Option<serde_json::Value>,
    },
    GoalUpdated {
        id: String,
        #[serde(default, rename = "conversationId")]
        conversation_id: Option<String>,
        #[serde(default, rename = "threadId")]
        thread_id: Option<String>,
        goal: serde_json::Value,
        #[serde(default)]
        source: Option<String>,
    },
    SubagentStarted {
        id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "agentType")]
        agent_type: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default, rename = "sessionId")]
        session_id: Option<String>,
    },
    SubagentStopped {
        id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    SubagentCompleted {
        id: String,
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
        result: String,
        #[serde(rename = "subagentType")]
        subagent_type: String,
        #[serde(default, rename = "agentId")]
        agent_id: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        prompt: Option<String>,
    },
    TaskStarted {
        id: String,
        #[serde(default, rename = "taskId")]
        task_id: String,
        #[serde(default)]
        description: Option<String>,
        #[serde(default, rename = "taskType")]
        task_type: Option<String>,
    },
    TaskProgress {
        id: String,
        #[serde(default, rename = "taskId")]
        task_id: String,
        #[serde(default, rename = "agentId")]
        agent_id: Option<String>,
        #[serde(default, rename = "totalTokens")]
        total_tokens: Option<u64>,
        #[serde(default, rename = "inputTokens")]
        input_tokens: Option<u64>,
        #[serde(default, rename = "outputTokens")]
        output_tokens: Option<u64>,
        #[serde(default, rename = "cacheReadTokens")]
        cache_read_tokens: Option<u64>,
        #[serde(default, rename = "cacheCreationTokens")]
        cache_creation_tokens: Option<u64>,
        #[serde(default, rename = "toolUses")]
        tool_uses: Option<u32>,
        #[serde(default, rename = "durationMs")]
        duration_ms: Option<u64>,
        #[serde(default, rename = "lastToolName")]
        last_tool_name: Option<String>,
        #[serde(default)]
        summary: Option<String>,
    },
    TaskNotification {
        id: String,
        #[serde(default, rename = "taskId")]
        task_id: String,
        #[serde(default, rename = "agentId")]
        agent_id: Option<String>,
        #[serde(default)]
        status: String,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default, rename = "totalTokens")]
        total_tokens: Option<u64>,
        #[serde(default, rename = "inputTokens")]
        input_tokens: Option<u64>,
        #[serde(default, rename = "outputTokens")]
        output_tokens: Option<u64>,
        #[serde(default, rename = "cacheReadTokens")]
        cache_read_tokens: Option<u64>,
        #[serde(default, rename = "cacheCreationTokens")]
        cache_creation_tokens: Option<u64>,
        #[serde(default, rename = "toolUses")]
        tool_uses: Option<u32>,
        #[serde(default, rename = "durationMs")]
        duration_ms: Option<u64>,
    },
    TodoUpdated {
        id: String,
        todos: Vec<TodoItemPayload>,
        #[serde(default)]
        diff: Option<Vec<TodoDiffEntryPayload>>,
    },
    AskUserQuestion {
        id: String,
        #[serde(rename = "confirmId")]
        confirm_id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        questions: Vec<AskUserQuestionItemPayload>,
    },
    SystemInit {
        id: String,
        tools: Vec<String>,
        #[serde(rename = "mcpServers")]
        mcp_servers: Vec<McpServerStatusPayload>,
        model: String,
        #[serde(rename = "fastModeState")]
        fast_mode_state: Option<String>,
        #[serde(rename = "slashCommands")]
        slash_commands: Vec<super::events::SlashCommandInfoPayload>,
    },
    /// Emitted when the Claude SDK begins context compaction.
    Compact {
        id: String,
        trigger: String,
        #[serde(rename = "preTokens")]
        pre_tokens: u64,
    },
    /// Emitted when the Claude SDK produces a thinking/reasoning delta.
    ThinkingDelta {
        id: String,
        delta: String,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default, rename = "startNewBlock")]
        start_new_block: Option<bool>,
    },
    /// Subagent natural-language reply delta — routed to the subagent panel.
    /// Sourced from SDK stream_event with parent_tool_use_id != null.
    SubagentTextDelta {
        id: String,
        #[serde(rename = "subagentSessionId")]
        subagent_session_id: String,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: String,
        delta: String,
    },
    /// Subagent thinking delta — routed to the subagent panel.
    /// Sourced from SDK stream_event or assistant message thinking blocks
    /// with parent_tool_use_id != null.
    SubagentThinkingDelta {
        id: String,
        #[serde(rename = "subagentSessionId")]
        subagent_session_id: String,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: String,
        delta: String,
        #[serde(default, rename = "startNewBlock")]
        start_new_block: Option<bool>,
    },
    /// Emitted by PostToolUse hook when a file-modifying tool completes.
    FileChanged {
        id: String,
        #[serde(rename = "filePath")]
        file_path: String,
        action: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        additions: u64,
        deletions: u64,
    },
    /// Emitted when the turn-level aggregated unified diff is updated (Codex mode).
    TurnDiff {
        id: String,
        diff: String,
    },
    /// Emitted by the Stop hook when the Claude SDK finishes a turn.
    /// The live-reviewer uses this to trigger PR-style batched reviews.
    TurnFinished {
        id: String,
        #[serde(default, rename = "lastAssistantMessage")]
        last_assistant_message: Option<String>,
    },
    /// Emitted when a user message UUID is captured from the SDK stream.
    UserMessageUuid {
        id: String,
        uuid: String,
    },
    /// Emitted when a queued mid-stream user message is about to start a new turn.
    NewTurn {
        id: String,
        #[serde(default, rename = "commandName")]
        command_name: Option<String>,
    },
    /// Result of a rewindFiles operation.
    RewindFilesResult {
        id: String,
        success: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default, rename = "filesChanged")]
        files_changed: Option<Vec<String>>,
        #[serde(default)]
        insertions: Option<u64>,
        #[serde(default)]
        deletions: Option<u64>,
    },
    // ---- Teams Events (SDK-native multi-agent) ----
    TeamsStart {
        id: String,
        #[serde(rename = "agentCount")]
        agent_count: u32,
        agents: Vec<TeamsAgentInfoPayload>,
    },
    TeamsAgentDelta {
        id: String,
        #[serde(rename = "agentName")]
        agent_name: String,
        delta: String,
    },
    TeamsAgentToolStart {
        id: String,
        #[serde(rename = "agentName")]
        agent_name: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: String,
    },
    TeamsAgentToolResult {
        id: String,
        #[serde(rename = "agentName")]
        agent_name: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: String,
        success: bool,
        result: String,
        #[serde(default)]
        display: Option<ToolDisplayMetaPayload>,
    },
    TeamsAgentStatus {
        id: String,
        #[serde(rename = "agentName")]
        agent_name: String,
        status: String,
        #[serde(default)]
        message: Option<String>,
    },
    TeamsAgentThinking {
        id: String,
        #[serde(rename = "agentName")]
        agent_name: String,
        delta: String,
    },
    TeamsStartupStatus {
        id: String,
        status: String,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        attempt: Option<u32>,
        #[serde(default, rename = "maxAttempts")]
        max_attempts: Option<u32>,
        #[serde(default, rename = "retryDelayMs")]
        retry_delay_ms: Option<f64>,
        #[serde(default, rename = "errorStatus")]
        error_status: Option<u16>,
    },
    TeamsReady {
        id: String,
        agents: Vec<TeamsAgentInfoPayload>,
    },
    TeamsComplete {
        id: String,
        summary: String,
    },
    TeamsError {
        id: String,
        error: String,
    },
    TeamsMessageRouted {
        id: String,
        #[serde(rename = "targetAgent")]
        target_agent: String,
        content: String,
        timestamp: u64,
    },
    /// Emitted when a persistent (warm) CLI session ends (timeout, crash, or explicit kill).
    SessionEnded {
        id: String,
        #[serde(rename = "conversationId")]
        conversation_id: String,
    },
    /// Emitted when the CLI process crashes and all retries fail — the frontend
    /// should clear the sessionId so the next message starts a fresh session.
    SessionInvalidated {
        id: String,
        #[serde(rename = "conversationId")]
        conversation_id: String,
        reason: String,
    },
    /// Emitted when the sidecar retries a query after a transient/network error.
    StreamRetry {
        id: String,
        attempt: u32,
        max_attempts: u32,
        reason: String,
    },
}

/// Minimal agent info for the teams_start event.
#[derive(Debug, Deserialize)]
pub(crate) struct TeamsAgentInfoPayload {
    pub name: String,
    pub role: String,
}
