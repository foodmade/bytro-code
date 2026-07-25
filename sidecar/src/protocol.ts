// ---------------------------------------------------------------------------
// NDJSON Protocol Types — Rust ↔ Sidecar communication
// ---------------------------------------------------------------------------

// ---- Commands: Rust → Sidecar (stdin) ----

export interface ImageData {
  readonly media_type: string;
  readonly data: string;
}

export interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

export interface McpServerConfigStdio {
  readonly type?: "stdio";
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly alwaysLoad?: boolean;
  readonly timeout?: number;
}

export interface McpServerConfigSse {
  readonly type: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly alwaysLoad?: boolean;
  readonly timeout?: number;
}

export interface McpServerConfigHttp {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly alwaysLoad?: boolean;
  readonly timeout?: number;
}

export type McpServerConfig = McpServerConfigStdio | McpServerConfigSse | McpServerConfigHttp;

/** Platform identifier — maps to a fixed SDK type. */
export type PlatformId =
  | "claude" | "codex" | "gemini"
  | "grok" | "deepseek" | "qwen" | "bigmodel" | "mimo" | "minimax" | "kimi"
  | "ollama";

/** Slash-command metadata threaded through from the frontend. Codex inspects
 *  `canonicalName` to route native commands like /compact and /status through
 *  Codex App Server RPCs instead of treating the literal text as turn input. */
export interface CommandInvocationPayload {
  readonly canonicalName: string;
  readonly typedName?: string;
  readonly args?: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

export type AuthMode = "apiKey" | "oauth";

export interface QueryCommand {
  readonly cmd: "query";
  readonly id: string;
  readonly agent: "claude" | "codex" | "gemini" | "chatcmpl";
  readonly prompt: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly permissionMode: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  /** Conversation fork: resume the source session but write to a NEW session id
   *  (SDK `forkSession`). Set on a forked conversation's first turn. Claude only. */
  readonly forkSession?: boolean;
  /** Conversation fork anchor — resume only up to and including this message uuid
   *  (SDK `resumeSessionAt`). Pairs with `forkSession`. */
  readonly resumeSessionAt?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly authMode?: AuthMode;
  readonly profileId?: string;
  readonly proxyUrl?: string;
  readonly platform?: PlatformId;
  readonly images?: ReadonlyArray<ImageData>;
  readonly messages?: ReadonlyArray<ChatMessage>;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** When true, the agent runs with no tools — pure conversation mode. */
  readonly disableTools?: boolean;
  /** Whether extended thinking / reasoning is enabled (legacy, use reasoningLevel). */
  readonly thinkingEnabled?: boolean;
  /** Reasoning effort level: "off" | "low" | "medium" | "high" | "max". */
  readonly reasoningLevel?: string;
  readonly ultracode?: boolean;
  /** Claude fast mode — wired into the SDK `fastMode` session setting by the
   *  Claude handler (via extraArgs.settings). Claude only; other agents ignore it. */
  readonly fastMode?: boolean;
  /** Default quality for the openai_images MCP tool: "low" | "medium" | "high" | "auto". */
  readonly imageGenQuality?: string;
  /** Default size for the openai_images MCP tool (popular gpt-image-2 preset, e.g. "1024x1024" or "auto"). */
  readonly imageGenSize?: string;
  /** Absolute path to the app-managed outputs directory. Sidecar wires this into
   *  `OPENAI_IMAGES_OUT` for the image-gen MCP and instructs the model in the
   *  system prompt to write all generated artifacts here. Decouples generated
   *  content from the user's workspace cwd. */
  readonly outputsDir?: string;
  /** Codex App Server service tier override, e.g. "fast". */
  readonly serviceTier?: string;
  /** Enable Codex App Server Goals mode for this request. */
  readonly goalModeEnabled?: boolean;
  /** Frontend conversation ID — used for persistent (warm) session routing. */
  readonly conversationId?: string;
  /** Health-check dimension prompts — injected by PreToolUse hook when present. */
  readonly dimensionPrompts?: Readonly<Record<string, string>>;
  /** Ollama num_ctx override. */
  readonly numCtx?: number;
  /** Slash-command metadata routed through to the handler. Codex maps native
   *  commands like /compact and /status to App Server RPCs; other agents
   *  ignore this field. */
  readonly commandInvocation?: CommandInvocationPayload;
  /** Caveman compression mode — "off" / "lite" / "full" / "ultra" / "wenyan".
   *  When non-"off", the matching addendum is appended to the system prompt
   *  to elicit terse, fragment-style replies. Currently honored by the Claude
   *  handler. The string is opaque to Rust and the wire layer; sidecar maps
   *  unknown values to no-op. */
  readonly cavemanMode?: "off" | "lite" | "full" | "ultra" | "wenyan";
}

export interface PermissionResponseCommand {
  readonly cmd: "permission_response";
  readonly confirmId: string;
  readonly approved: boolean;
}

export interface AskUserQuestionResponseCommand {
  readonly cmd: "ask_user_question_response";
  readonly confirmId: string;
  readonly answers: Record<string, string>;
}

export interface AbortCommand {
  readonly cmd: "abort";
  readonly id: string;
}

export interface UserInputCommand {
  readonly cmd: "user_input";
  readonly id: string;
  readonly content: string;
  readonly images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>;
  readonly reasoningLevel?: string;
  /** Slash-command metadata threaded through warm-session follow-up turns.
   *  Codex maps native commands like /compact and /status to App Server RPCs. */
  readonly commandInvocation?: CommandInvocationPayload;
}

export interface ShutdownCommand {
  readonly cmd: "shutdown";
}

export interface InitSessionCommand {
  readonly cmd: "init_session";
  readonly id: string;
  readonly model: string;
  readonly cwd: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly authMode?: AuthMode;
  readonly profileId?: string;
  readonly proxyUrl?: string;
  readonly platform?: PlatformId;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly ultracode?: boolean;
  readonly fastMode?: boolean;
}

// ---- Teams Commands (Claude CLI multi-agent) ----

/** A subagent definition sent from the frontend for the CLI adapter. */
export interface TeamsAgentConfig {
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly prompt: string;
  readonly tools?: ReadonlyArray<string>;
  readonly model?: "sonnet" | "opus" | "haiku";
}

export interface TeamsQueryCommand {
  readonly cmd: "teams_query";
  readonly id: string;
  readonly task: string;
  readonly agents: ReadonlyArray<TeamsAgentConfig>;
  readonly cwd: string;
  readonly permissionMode: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly proxyUrl?: string;
  readonly platform?: PlatformId;
  readonly model?: string;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly responseLanguage?: string;
}

// ---- Legacy Orchestration Commands (deprecated) ----

export interface TeamMemberConfig {
  readonly name: string;
  readonly agent: "claude" | "codex" | "gemini" | "chatcmpl";
  readonly model: string;
  readonly role: string;
}

export interface OrchestrateCommand {
  readonly cmd: "orchestrate";
  readonly id: string;
  readonly task: string;
  readonly team: ReadonlyArray<TeamMemberConfig>;
  readonly cwd: string;
  readonly permissionMode: string;
  readonly keys: {
    readonly anthropicKey?: string;
    readonly openaiKey?: string;
    readonly geminiKey?: string;
  };
}

export interface KillSessionCommand {
  readonly cmd: "kill_session";
  readonly conversationId: string;
}

export interface RewindFilesCommand {
  readonly cmd: "rewind_files";
  readonly id: string;
  readonly userMessageUuid: string;
}

export interface CodexAuthStartCommand {
  readonly cmd: "codex_auth_start";
  readonly id: string;
  readonly profileId: string;
}

export interface CodexAuthReadCommand {
  readonly cmd: "codex_auth_read";
  readonly id: string;
  readonly profileId: string;
  readonly refreshToken?: boolean;
}

export interface CodexAuthCancelCommand {
  readonly cmd: "codex_auth_cancel";
  readonly id: string;
  readonly profileId: string;
  readonly loginId: string;
}

export interface CodexAuthSignOutCommand {
  readonly cmd: "codex_auth_sign_out";
  readonly id: string;
  readonly profileId: string;
}

export type SidecarCommand =
  | QueryCommand
  | PermissionResponseCommand
  | AskUserQuestionResponseCommand
  | AbortCommand
  | UserInputCommand
  | ShutdownCommand
  | OrchestrateCommand
  | TeamsQueryCommand
  | InitSessionCommand
  | RewindFilesCommand
  | KillSessionCommand
  | CodexAuthStartCommand
  | CodexAuthReadCommand
  | CodexAuthCancelCommand
  | CodexAuthSignOutCommand;

// ---- Events: Sidecar → Rust (stdout) ----

export interface ReadyEvent {
  readonly evt: "ready";
}

export interface SessionEvent {
  readonly evt: "session";
  readonly id: string;
  readonly sessionId: string;
}

export interface TextDeltaEvent {
  readonly evt: "text_delta";
  readonly id: string;
  readonly delta: string;
}

export type ToolDisplayStatus = "success" | "warning" | "error";
export type ToolDisplaySeverity = "info" | "warning" | "error";

export interface ToolDisplayMeta {
  readonly status: ToolDisplayStatus;
  readonly severity: ToolDisplaySeverity;
  readonly reason?: string;
}

export interface ToolStartEvent {
  readonly evt: "tool_start";
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
}

export interface ToolResultEvent {
  readonly evt: "tool_result";
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly success: boolean;
  readonly result: string;
  readonly display?: ToolDisplayMeta;
}

export interface ToolOutputEvent {
  readonly evt: "tool_output";
  readonly id: string;
  readonly toolCallId: string;
  readonly output: string;
}

export interface PermissionRequestEvent {
  readonly evt: "permission_request";
  readonly id: string;
  readonly confirmId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
}

export interface ToolDeniedEvent {
  readonly evt: "tool_denied";
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly reason: string;
}

export interface CompleteEvent {
  readonly evt: "complete";
  readonly id: string;
  readonly fullText: string;
}

export interface DoneEvent {
  readonly evt: "done";
  readonly id: string;
  /** When true, the CLI session stays alive (warm) for subsequent messages. */
  readonly sessionAlive?: boolean;
  /** Conversation ID associated with the warm session. */
  readonly conversationId?: string;
  /** Why the query loop terminated (SDK 0.2.97+). */
  readonly terminalReason?: string;
}

export interface ErrorEvent {
  readonly evt: "error";
  readonly id: string;
  readonly error: string;
  readonly apiErrorStatus?: number | null;
}

export interface CodexAuthStartedEvent {
  readonly evt: "codex_auth_started";
  readonly id: string;
  readonly profileId: string;
  readonly loginId: string;
  readonly authUrl?: string;
  readonly verificationUrl?: string;
  readonly userCode?: string;
}

export interface CodexAuthCompletedEvent {
  readonly evt: "codex_auth_completed";
  readonly id: string;
  readonly profileId: string;
  readonly email?: string;
  readonly planType?: string;
  readonly requiresOpenaiAuth?: boolean;
}

export interface CodexAuthSignedOutEvent {
  readonly evt: "codex_auth_signed_out";
  readonly id: string;
  readonly profileId: string;
}

export interface CodexAuthErrorEvent {
  readonly evt: "codex_auth_error";
  readonly id: string;
  readonly profileId: string;
  readonly error: string;
}

export interface UsageEvent {
  readonly evt: "usage";
  readonly id: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalCostUsd: number;
  readonly contextWindow: number; // 0 = unknown
  readonly model: string;
}

/** Real-time token usage extracted from stream events (message_start / message_delta). */
export interface StreamUsageEvent {
  readonly evt: "stream_usage";
  readonly id: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly contextWindow?: number;
}

export interface ContextUsageEvent {
  readonly evt: "context_usage";
  readonly id: string;
  readonly conversationId?: string;
  readonly requestedAt: number;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
  readonly snapshot?: unknown;
}

export interface GoalSnapshotPayload {
  readonly objective?: string;
  readonly status?: string;
  readonly tokenBudget?: number | null;
  readonly tokensUsed?: number | null;
  readonly timeUsedSeconds?: number | null;
}

export interface GoalUpdatedEvent {
  readonly evt: "goal_updated";
  readonly id: string;
  readonly conversationId?: string;
  readonly threadId?: string;
  readonly goal: GoalSnapshotPayload;
  readonly source: "thread/goal/set" | "thread/goal/get" | "notification" | "fallback";
}

// ---- Orchestration Events ----

export interface OrchestrateStartEvent {
  readonly evt: "orchestrate_start";
  readonly id: string;
  readonly teamSize: number;
}

export interface SubtaskStartEvent {
  readonly evt: "subtask_start";
  readonly id: string;
  readonly subtaskId: string;
  readonly assignedTo: string;
  readonly agent: string;
  readonly description: string;
}

export interface SubtaskCompleteEvent {
  readonly evt: "subtask_complete";
  readonly id: string;
  readonly subtaskId: string;
  readonly assignedTo: string;
  readonly result: string;
  readonly success: boolean;
}

export interface MediaEvent {
  readonly evt: "media";
  readonly id: string;
  readonly mediaType: string;
  readonly data: string;
}

export interface OrchestrateCompleteEvent {
  readonly evt: "orchestrate_complete";
  readonly id: string;
  readonly summary: string;
}

// ---- Hooks-sourced Events (SubagentStart/Stop, TodoWrite) ----

export interface SubagentStartedEvent {
  readonly evt: "subagent_started";
  readonly id: string;
  readonly agentId: string;
  readonly agentType: string;
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly sessionId?: string;
}

export interface SubagentStoppedEvent {
  readonly evt: "subagent_stopped";
  readonly id: string;
  readonly agentId: string;
}

export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly activeForm: string;
}

export interface TodoDiffEntry {
  readonly content: string;
  readonly changeType: "added" | "removed" | "status_changed" | "unchanged";
  readonly oldStatus?: string;
  readonly newStatus?: string;
}

export interface TodoUpdatedEvent {
  readonly evt: "todo_updated";
  readonly id: string;
  readonly todos: ReadonlyArray<TodoItem>;
  readonly diff?: ReadonlyArray<TodoDiffEntry>;
}

/** Emitted by PostToolUse(Task) hook when a subagent completes. */
export interface SubagentCompletedEvent {
  readonly evt: "subagent_completed";
  readonly id: string;
  readonly toolUseId: string;
  readonly result: string;
  readonly subagentType: string;
  readonly agentId?: string;
  readonly description?: string;
  readonly prompt?: string;
}

/** Emitted when a subagent task starts (SDK system message: task_started). */
export interface TaskStartedEvent {
  readonly evt: "task_started";
  readonly id: string;
  readonly taskId: string;
  readonly description?: string;
  readonly taskType?: string;
}

/** Emitted periodically with subagent progress (SDK system message: task_progress). */
export interface TaskProgressEvent {
  readonly evt: "task_progress";
  readonly id: string;
  readonly taskId: string;
  readonly agentId?: string;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly lastToolName?: string;
  readonly summary?: string;
}

/** Emitted when a subagent task completes/fails (SDK system message: task_notification). */
export interface TaskNotificationEvent {
  readonly evt: "task_notification";
  readonly id: string;
  readonly taskId: string;
  readonly agentId?: string;
  readonly status: string;
  readonly summary?: string;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface McpServerStatus {
  readonly name: string;
  readonly status: string;
}

export interface AskUserQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface AskUserQuestionItem {
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<AskUserQuestionOption>;
  readonly multiSelect: boolean;
}

export interface AskUserQuestionEvent {
  readonly evt: "ask_user_question";
  readonly id: string;
  readonly confirmId: string;
  readonly toolCallId: string;
  readonly questions: ReadonlyArray<AskUserQuestionItem>;
}

/** Metadata for one slash command, sourced from the SDK's supportedCommands()
 *  API or — when unavailable (non-Claude providers, prewarm degraded paths) —
 *  derived from the simplified `slash_commands: string[]` field on system.init.
 *  In the degraded case only `name` is meaningful; other fields are empty/undefined. */
export interface SlashCommandInfo {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: ReadonlyArray<string>;
}

export interface SystemInitEvent {
  readonly evt: "system_init";
  readonly id: string;
  readonly tools: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<McpServerStatus>;
  readonly model: string;
  /** CLI fast-mode state reported at session init: "on" | "off" | "cooldown" (absent if unknown). */
  readonly fastModeState?: string;
  readonly slashCommands: ReadonlyArray<SlashCommandInfo>;
}

/** Emitted when the Claude SDK begins context compaction (auto or manual). */
export interface CompactEvent {
  readonly evt: "compact";
  readonly id: string;
  readonly trigger: "auto" | "manual";
  readonly preTokens: number;
}

/** Emitted when the Claude SDK produces a thinking/reasoning delta. */
export interface ThinkingDeltaEvent {
  readonly evt: "thinking_delta";
  readonly id: string;
  readonly delta: string;
  readonly kind?: "summary" | "raw";
  readonly startNewBlock?: boolean;
}

/** Subagent natural-language reply delta — routed to the subagent panel,
 *  not the main conversation. Source: SDK stream_event content_block_delta
 *  with parent_tool_use_id != null. */
export interface SubagentTextDeltaEvent {
  readonly evt: "subagent_text_delta";
  readonly id: string;
  readonly subagentSessionId: string;
  readonly parentToolUseId: string;
  readonly delta: string;
}

/** Subagent thinking delta — routed to the subagent panel, not the main
 *  conversation. Source: SDK stream_event thinking_delta or assistant
 *  message thinking block, both with parent_tool_use_id != null. */
export interface SubagentThinkingDeltaEvent {
  readonly evt: "subagent_thinking_delta";
  readonly id: string;
  readonly subagentSessionId: string;
  readonly parentToolUseId: string;
  readonly delta: string;
  readonly startNewBlock?: boolean;
}

/** Emitted by PostToolUse hook when a file-modifying tool completes. */
export interface FileChangedEvent {
  readonly evt: "file_changed";
  readonly id: string;
  readonly filePath: string;
  readonly action: "edit" | "create" | "delete";
  readonly toolName: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Emitted when the turn-level aggregated unified diff is updated (Codex mode). */
export interface TurnDiffEvent {
  readonly evt: "turn_diff";
  readonly id: string;
  readonly diff: string;
}

/**
 * Emitted by the Stop hook when the Claude SDK finishes a turn (assistant
 * message stream is complete). Used by the live-reviewer to trigger a
 * "PR-style" batched review once the agent has stopped writing.
 *
 * `lastAssistantMessage` is the text content of the last assistant message
 * the SDK produced this turn — typically a summary describing what the agent
 * did. Truncated by the SDK to a reasonable size, may be `null` for purely
 * tool-only turns or when the SDK omits it.
 */
export interface TurnFinishedEvent {
  readonly evt: "turn_finished";
  readonly id: string;
  readonly lastAssistantMessage: string | null;
}

/** Emitted when a user message UUID is captured from the SDK stream. */
export interface UserMessageUuidEvent {
  readonly evt: "user_message_uuid";
  readonly id: string;
  readonly uuid: string;
}

/**
 * Emitted by the interactive prompt generator when a queued mid-stream user
 * message is about to be yielded to the SDK as a new turn. The frontend uses
 * this to create a new assistant placeholder before deltas start arriving.
 */
export interface NewTurnEvent {
  readonly evt: "new_turn";
  readonly id: string;
  readonly commandName?: string;
}

/** Emitted when a persistent (warm) CLI session ends (idle timeout, crash, abort). */
export interface SessionEndedEvent {
  readonly evt: "session_ended";
  readonly id: string;
  readonly conversationId: string;
}

/** Emitted when the sidecar retries a query after a transient/network error. */
export interface StreamRetryEvent {
  readonly evt: "stream_retry";
  readonly id: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly reason: string;
}

/** Result of a rewindFiles operation. */
export interface RewindFilesResultEvent {
  readonly evt: "rewind_files_result";
  readonly id: string;
  readonly success: boolean;
  readonly error?: string;
  readonly filesChanged?: ReadonlyArray<string>;
  readonly insertions?: number;
  readonly deletions?: number;
}

// ---- Teams Events (SDK-native multi-agent) ----

/** Emitted when the teams session starts and agents are being initialized. */
export interface TeamsStartEvent {
  readonly evt: "teams_start";
  readonly id: string;
  readonly agentCount: number;
  readonly agents: ReadonlyArray<{ readonly name: string; readonly role: string }>;
}

/** Per-agent text delta — routed by agentName so the UI can show parallel streams. */
export interface TeamsAgentDeltaEvent {
  readonly evt: "teams_agent_delta";
  readonly id: string;
  readonly agentName: string;
  readonly delta: string;
}

/** Per-agent tool start — the agent began invoking a tool (Read, Write, Bash, etc.). */
export interface TeamsAgentToolStartEvent {
  readonly evt: "teams_agent_tool_start";
  readonly id: string;
  readonly agentName: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
}

/** Per-agent tool result — the tool call completed with a result. */
export interface TeamsAgentToolResultEvent {
  readonly evt: "teams_agent_tool_result";
  readonly id: string;
  readonly agentName: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly success: boolean;
  readonly result: string;
  readonly display?: ToolDisplayMeta;
}

/** Agent lifecycle status changes (spawned, active, idle, stopped, error). */
export interface TeamsAgentStatusEvent {
  readonly evt: "teams_agent_status";
  readonly id: string;
  readonly agentName: string;
  readonly status: "spawned" | "active" | "idle" | "stopped" | "error";
  readonly message?: string;
}

/** Per-agent thinking delta — extended reasoning content from an agent. */
export interface TeamsAgentThinkingEvent {
  readonly evt: "teams_agent_thinking";
  readonly id: string;
  readonly agentName: string;
  readonly delta: string;
}

/** Startup status emitted while teams mode is still launching. */
export interface TeamsStartupStatusEvent {
  readonly evt: "teams_startup_status";
  readonly id: string;
  readonly status: string;
  readonly message?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly errorStatus?: number;
}

/** Teams session complete — all agents finished, final summary available. */
export interface TeamsCompleteEvent {
  readonly evt: "teams_complete";
  readonly id: string;
  readonly summary: string;
}

/** SDK initialized, agents are defined — frontend can transition to "ready". */
export interface TeamsReadyEvent {
  readonly evt: "teams_ready";
  readonly id: string;
  readonly agents: ReadonlyArray<{ readonly name: string; readonly role: string }>;
}

/** Teams session error — unrecoverable error during multi-agent execution. */
export interface TeamsErrorEvent {
  readonly evt: "teams_error";
  readonly id: string;
  readonly error: string;
}

/** Emitted when a directed message (via @mention) is routed to a specific agent. */
export interface TeamsMessageRoutedEvent {
  readonly evt: "teams_message_routed";
  readonly id: string;
  readonly targetAgent: string;
  readonly content: string;
  readonly timestamp: number;
}

export type SidecarEvent =
  | ReadyEvent
  | SessionEvent
  | TextDeltaEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolOutputEvent
  | PermissionRequestEvent
  | ToolDeniedEvent
  | CompleteEvent
  | DoneEvent
  | ErrorEvent
  | CodexAuthStartedEvent
  | CodexAuthCompletedEvent
  | CodexAuthSignedOutEvent
  | CodexAuthErrorEvent
  | UsageEvent
  | StreamUsageEvent
  | ContextUsageEvent
  | GoalUpdatedEvent
  | MediaEvent
  | OrchestrateStartEvent
  | SubtaskStartEvent
  | SubtaskCompleteEvent
  | OrchestrateCompleteEvent
  | SubagentStartedEvent
  | SubagentStoppedEvent
  | SubagentCompletedEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationEvent
  | TodoUpdatedEvent
  | AskUserQuestionEvent
  | SystemInitEvent
  | CompactEvent
  | ThinkingDeltaEvent
  | SubagentTextDeltaEvent
  | SubagentThinkingDeltaEvent
  | FileChangedEvent
  | TurnDiffEvent
  | TurnFinishedEvent
  | UserMessageUuidEvent
  | RewindFilesResultEvent
  | NewTurnEvent
  | TeamsStartEvent
  | TeamsAgentDeltaEvent
  | TeamsAgentToolStartEvent
  | TeamsAgentToolResultEvent
  | TeamsAgentStatusEvent
  | TeamsAgentThinkingEvent
  | TeamsStartupStatusEvent
  | TeamsCompleteEvent
  | TeamsReadyEvent
  | TeamsErrorEvent
  | TeamsMessageRoutedEvent
  | SessionEndedEvent
  | StreamRetryEvent;
