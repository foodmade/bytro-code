import type { AgentRole } from "@/types";

// ---------------------------------------------------------------------------
// Public types (re-exported by chat-store for backward compatibility)
// ---------------------------------------------------------------------------

export interface ToolDisplayMeta {
  readonly status: "success" | "warning" | "error";
  readonly severity: "info" | "warning" | "error";
  readonly reason?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly status: "running" | "success" | "warning" | "error" | "pending_confirmation" | "denied";
  readonly result?: string;
  readonly display?: ToolDisplayMeta;
  readonly confirmId?: string;
  /** Position in the content string where this tool call was inserted */
  readonly textOffset?: number;
  /** True once this file edit/write has been undone via the tool card's
   *  revert action. Drives the "reverted" card styling and disables re-undo. */
  readonly reverted?: boolean;
}

/** A single thinking/reasoning block produced during extended thinking mode. */
export interface ThinkingEntry {
  readonly text: string;
  /** Position in the accumulated content string when this thinking phase began. */
  readonly textOffset: number;
  /** True once this thinking phase has ended (text_delta arrived after it). */
  readonly complete: boolean;
  /** Source of the thinking content when provided by the SDK. */
  readonly kind?: "summary" | "raw";
}

/** Slash-command invocation metadata attached to a user message. Set when
 *  the input text was classified as an SDK slash command (came from
 *  Query.supportedCommands()). When present, the chat UI should render this
 *  message as a compact command card instead of a normal user bubble — to
 *  match the terminal Claude Code experience where /compact / /init / etc.
 *  don't appear as user-typed text. */
export interface CommandInvocationMeta {
  /** Canonical command name (after alias resolution), e.g. "usage" for /cost. */
  readonly canonicalName: string;
  /** What the user actually typed (with aliases preserved), e.g. "cost". */
  readonly typedName: string;
  /** Argument hint string from the SDK, e.g. "<file>". Optional. */
  readonly argumentHint?: string;
  /** Trailing arguments after the command, verbatim. May be empty. */
  readonly args: string;
  /** Short description from the SDK, used as card subtitle. */
  readonly description: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: AgentRole;
  readonly content: string;
  /** User-facing display text when `content` contains hidden system instructions.
   *  UI components should render this instead of `content` when present. */
  readonly displayContent?: string;
  readonly agent?: string;
  readonly timestamp: number;
  readonly toolCalls?: ReadonlyArray<ToolCall>;
  readonly media?: ReadonlyArray<{ readonly mediaType: string; readonly data: string }>;
  /** Ordered thinking blocks, interleaved with text/tool segments by textOffset. */
  readonly thinkingBlocks?: ReadonlyArray<ThinkingEntry>;
  /** True when this message was sent mid-stream via Ctrl+Enter. */
  readonly midStream?: boolean;
  /** True after the sidecar has picked up this mid-stream message for processing. */
  readonly midStreamConsumed?: boolean;
  /** Present when a required CLI tool is missing for the selected SDK. */
  readonly cliMissing?: {
    readonly sdk: string;
    readonly displayName: string;
  };
  /** Aggregated unified diff for the entire turn (Codex mode). Updated in real-time. */
  readonly turnDiff?: string;
  /** Set on user messages classified as slash-command invocations.
   *  When present, the chat UI renders a compact command card. */
  readonly commandInvocation?: CommandInvocationMeta;
  /** True when this user message was submitted through Codex Goals mode. */
  readonly sentAsGoal?: boolean;
  /** Set on user messages forwarded from the Live Reviewer panel.  When
   *  present, the chat UI renders a compact, collapsible review card and
   *  hides the raw injected text from the bubble.  Type imported lazily
   *  from `@/lib/live-review-events` to keep store/UI layers decoupled. */
  readonly reviewForward?: import("@/lib/live-review-events").ReviewForwardMeta;
  /** Per-turn usage for the assistant response represented by this message. */
  readonly turnUsage?: TurnUsageData;
}

export interface TurnUsageData {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;
  readonly durationMs: number;
}

export interface UsageData {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalCostUsd: number;
  readonly contextWindow: number;
  readonly model: string;
  /** Cumulative session duration in milliseconds (sum of all turn durations). */
  readonly totalDurationMs: number;
}

/** A single entry in the subagent's tool-call activity log. */
export interface ToolHistoryEntry {
  readonly toolName: string;
  readonly timestamp: number;
}

export interface SubagentInfo {
  readonly agentId: string;
  readonly agentType: string;
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly sessionId?: string;
  readonly status: "active" | "stopped";
  // Task progress fields (populated by task_started/task_progress/task_notification)
  readonly taskId?: string;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly lastToolName?: string;
  readonly progressSummary?: string;
  readonly finalSummary?: string;
  readonly finalResult?: string;
  readonly finalStatus?: string;
  /** Accumulated tool-call activity log built from task_progress events. */
  readonly toolHistory?: ReadonlyArray<ToolHistoryEntry>;
  /** Per-tool-name cumulative call counts, keyed by tool name. */
  readonly toolCountMap?: Readonly<Record<string, number>>;
  /** Streaming-accumulated subagent thinking text (forwarded via parent_tool_use_id). */
  readonly accumulatedThinking?: string;
  /** Streaming-accumulated subagent natural-language reply text. */
  readonly accumulatedText?: string;
  /** Timestamp (ms) of the first thinking delta — for elapsed display. */
  readonly thinkingStartedAt?: number;
  /** Timestamp (ms) of the most recent thinking delta. */
  readonly thinkingLastDeltaAt?: number;
  /** Whether thinking is still streaming (cleared on subagent_stopped / finalize). */
  readonly thinkingActive?: boolean;
  /** Whether reply text is still streaming (cleared on subagent_stopped / finalize). */
  readonly textActive?: boolean;
}

export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly activeForm: string;
}

export interface McpServerInfo {
  readonly name: string;
  readonly status: string;
}

export interface SlashCommandInfo {
  readonly name: string;
  readonly description: string;
  /** Argument hint string, e.g. "<file>", "[query]". Sourced from Claude Agent
   *  SDK's `Query.supportedCommands()`. Filesystem-scanned .md commands omit it. */
  readonly argumentHint?: string;
  /** Alternate command names that resolve to this command (e.g. "/cost" → "/usage"). */
  readonly aliases?: ReadonlyArray<string>;
  /** Where this command metadata came from. Codex built-ins and filesystem
   *  commands are prompt-expanded by the host because the App Server does not
   *  execute TUI-only slash commands directly. */
  readonly source?: "sdk" | "filesystem" | "builtin";
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

export interface PendingAskUserQuestion {
  readonly confirmId: string;
  readonly toolCallId: string;
  readonly questions: ReadonlyArray<AskUserQuestionItem>;
  /** The conversation that triggered this question — used to scope dialog visibility. */
  readonly conversationId?: string;
}

// ---------------------------------------------------------------------------
// Internal types (used by chat-store and chat-actions)
// ---------------------------------------------------------------------------

export interface MemoryContext {
  readonly system_prompt: string;
  readonly has_context: boolean;
}

export interface DbMessage {
  readonly id: string;
  readonly conversation_id: string;
  readonly role: string;
  readonly content: string;
  readonly tool_calls?: string | null;
  readonly agent: string | null;
  readonly turn_input_tokens?: number | null;
  readonly turn_output_tokens?: number | null;
  readonly turn_cache_read_tokens?: number | null;
  readonly turn_cache_creation_tokens?: number | null;
  readonly turn_total_tokens?: number | null;
  readonly turn_duration_ms?: number | null;
  readonly created_at: string;
}

export interface DbMessagePage {
  readonly messages: ReadonlyArray<DbMessage>;
  readonly total: number;
}

/** Per-conversation snapshot to preserve in-flight streaming state across switches */
export interface ConversationSnapshot {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly hasMoreMessages: boolean;
  readonly totalMessageCount: number;
  readonly dbTotal: number;
  readonly isLoadingOlder: boolean;
  readonly isStreaming: boolean;
  readonly streamingMessageId: string | null;
  readonly streamingConversationId: string | null;
  readonly streamStartTime: number | null;
  readonly streamPhase: "connecting" | "waiting" | "thinking" | null;
}

export const PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Store state interface
// ---------------------------------------------------------------------------

export interface ChatState {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly activeAgent: string;
  /** Whether there are older messages that can be loaded */
  readonly hasMoreMessages: boolean;
  /** Total message count for the current conversation (live: includes streaming) */
  readonly totalMessageCount: number;
  /** DB-side total at last full load -- used for offset calculations in pagination.
   *  Unlike totalMessageCount, this is NOT incremented by addMessage. */
  readonly _dbTotal: number;
  /** Whether older messages are currently being loaded */
  readonly isLoadingOlder: boolean;
  /** In-memory cache keyed by conversationId -- holds unsaved streaming state */
  readonly _snapshots: Record<string, ConversationSnapshot>;
  /** Index: messageId → conversationId (null = live/foreground messages).
   *  Enables O(1) lookup in mapMessages instead of O(m×n) scanning. */
  readonly _messageIndex: Map<string, string | null>;
  readonly addMessage: (message: ChatMessage) => void;
  readonly updateMessageContent: (id: string, content: string) => void;
  readonly updateMessageThinkingBlocks: (id: string, blocks: ReadonlyArray<ThinkingEntry>) => void;
  /** Atomically update both content and thinkingBlocks in a single store write.
   *  Prevents race conditions where two separate updates could cause React to
   *  render an intermediate state with stale thinkingBlocks. */
  readonly updateMessageCompleteState: (
    id: string,
    content: string,
    thinkingBlocks: ReadonlyArray<ThinkingEntry> | undefined,
  ) => void;
  readonly updateMessageTurnUsage: (id: string, turnUsage: TurnUsageData) => void;
  readonly addToolCall: (
    messageId: string,
    toolCall: { id: string; toolName: string; toolInput: string },
  ) => void;
  readonly appendToolCallOutput: (messageId: string, toolCallId: string, output: string) => void;
  readonly updateToolCallResult: (
    messageId: string,
    toolCallId: string,
    result: string,
    success: boolean,
    toolInput?: string,
    display?: ToolDisplayMeta,
  ) => void;
  readonly updateToolCallResultById: (
    toolCallId: string,
    result: string,
    success: boolean,
    toolInput?: string,
    display?: ToolDisplayMeta,
  ) => void;
  readonly setToolCallPendingConfirmation: (
    messageId: string,
    toolCallId: string,
    confirmId: string,
    toolName: string,
    toolInput: string,
  ) => void;
  readonly resolveToolCallConfirmation: (toolCallId: string, approved: boolean) => void;
  /**
   * Roll a tool call back to `pending_confirmation` after an optimistic
   * resolve whose IPC dispatch failed, so the confirmation dialog re-appears
   * and the user can retry instead of being stuck on a phantom approval.
   */
  readonly revertToolCallToPending: (toolCallId: string) => void;
  readonly addMessageMedia: (messageId: string, mediaType: string, data: string) => void;
  /** Mark the most recent unconsumed mid-stream user message as consumed. */
  readonly markMidStreamConsumed: (conversationId?: string | null) => void;
  readonly setTurnDiff: (messageId: string, diff: string) => void;
  readonly revertSingleFile: (
    messageId: string,
    filePath: string,
    fileKind: "M" | "A" | "D",
    fileDiff: string,
  ) => Promise<{ readonly success: boolean; readonly error?: string }>;
  /** Undo a single Edit/Write tool call using its own recorded content.
   *  Reverts new_string→old_string (Edit) or deletes the file (Write), then
   *  marks the tool call `reverted`. Located globally by toolCallId. */
  readonly revertToolCallEdit: (
    toolCallId: string,
  ) => Promise<{ readonly success: boolean; readonly error?: string }>;
  readonly clearMessages: () => void;
  readonly setActiveAgent: (agent: string) => void;
  readonly loadMessages: (conversationId: string) => Promise<void>;
  /** Load older messages (prepend to current list) for pagination */
  readonly loadOlderMessages: (conversationId: string) => Promise<void>;
  readonly persistMessage: (conversationId: string, msg: ChatMessage) => Promise<void>;
  readonly fetchMemoryContext: (conversationId: string, userMessage: string) => Promise<string>;
  /** Save current messages into the snapshot cache for a conversation */
  readonly saveSnapshot: (conversationId: string) => void;
  /** Remove a snapshot (e.g. when streaming completes and message is persisted) */
  readonly clearSnapshot: (conversationId: string) => void;
  /** Insert a message into a background conversation's snapshot and register it in _messageIndex. */
  readonly addMessageToSnapshot: (conversationId: string, message: ChatMessage) => void;
  /** Ensure a background conversation has a renderable snapshot without switching the active conversation. */
  readonly ensureSnapshotLoaded: (conversationId: string) => Promise<void>;
  /** Re-query DB for the true message count and update _dbTotal + hasMoreMessages.
   *  Called after streaming ends and after context compaction to fix pagination drift. */
  readonly refreshDbTotal: (conversationId: string) => Promise<void>;
}
