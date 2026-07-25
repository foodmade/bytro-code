import type { UnlistenFn } from "@tauri-apps/api/event";
import type { StreamRequestRegistry } from "@/lib/chat-stream-registry";
import type { StreamStateWriter } from "@/lib/chat-stream-state";

// ---------------------------------------------------------------------------
// Shared context passed to each handler group's registration function
// ---------------------------------------------------------------------------

export type { StreamStateWriter };

export interface ListenerParams {
  readonly registry: StreamRequestRegistry;
  readonly shouldIgnore: () => boolean;
  readonly syncWriter: StreamStateWriter;
}

// ---------------------------------------------------------------------------
// Event payload interfaces
// ---------------------------------------------------------------------------

export interface DeltaPayload {
  readonly request_id: string;
  readonly delta: string;
  readonly kind?: "summary" | "raw";
  readonly start_new_block?: boolean;
}

export interface CompletePayload {
  readonly request_id: string;
  readonly full_text: string;
}

export interface ErrorPayload {
  readonly request_id: string;
  readonly error: string;
  readonly error_status?: number;
}

export interface DonePayload {
  readonly request_id: string;
  readonly session_alive?: boolean;
  readonly conversation_id?: string;
}

export interface SessionEndedPayload {
  readonly request_id: string;
  readonly conversation_id: string;
}

export interface ToolDisplayMetaPayload {
  readonly status: "success" | "warning" | "error";
  readonly severity: "info" | "warning" | "error";
  readonly reason?: string;
}

export interface ToolUsePayload {
  readonly request_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly tool_input: string;
}

export interface ToolResultPayload {
  readonly request_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly tool_input: string;
  readonly success: boolean;
  readonly result: string;
  readonly display?: ToolDisplayMetaPayload;
}

export interface ToolOutputPayload {
  readonly request_id: string;
  readonly tool_call_id: string;
  readonly output: string;
}

export interface ToolConfirmPayload {
  readonly request_id: string;
  readonly confirm_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly tool_input: string;
}

export interface ToolDeniedPayload {
  readonly request_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly reason: string;
}

export interface SessionPayload {
  readonly request_id: string;
  readonly session_id: string;
}

export interface MediaPayload {
  readonly request_id: string;
  readonly media_type: string;
  readonly data: string;
}

export interface UsagePayload {
  readonly request_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly total_cost_usd: number;
  readonly context_window: number;
  readonly model: string;
}

export interface StreamUsagePayload {
  readonly request_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly context_window?: number;
}

export interface ContextUsagePayload {
  readonly request_id: string;
  readonly conversation_id?: string;
  readonly requested_at: number;
  readonly total_tokens: number;
  readonly max_tokens: number;
  readonly percentage: number;
  readonly snapshot?: unknown;
}

export interface GoalUpdatedPayload {
  readonly request_id: string;
  readonly conversation_id?: string;
  readonly thread_id?: string;
  readonly goal: {
    readonly objective?: string;
    readonly status?: string;
    readonly tokenBudget?: number | null;
    readonly tokensUsed?: number | null;
    readonly timeUsedSeconds?: number | null;
  };
  readonly source?: string;
}

export interface SubagentStartedPayload {
  readonly request_id: string;
  readonly agent_id: string;
  readonly agent_type: string;
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly session_id?: string;
}

export interface SubagentStoppedPayload {
  readonly request_id: string;
  readonly agent_id: string;
}

export interface SubagentTextDeltaPayload {
  readonly request_id: string;
  readonly subagent_session_id: string;
  readonly parent_tool_use_id: string;
  readonly delta: string;
}

export interface SubagentThinkingDeltaPayload {
  readonly request_id: string;
  readonly subagent_session_id: string;
  readonly parent_tool_use_id: string;
  readonly delta: string;
  readonly start_new_block?: boolean;
}

export interface SubagentCompletedPayload {
  readonly request_id: string;
  readonly tool_use_id: string;
  readonly result: string;
  readonly subagent_type: string;
  readonly agent_id?: string;
  readonly description?: string;
  readonly prompt?: string;
}

export interface TaskStartedPayload {
  readonly request_id: string;
  readonly task_id: string;
  readonly description?: string;
  readonly task_type?: string;
}

export interface TaskProgressPayload {
  readonly request_id: string;
  readonly task_id: string;
  readonly agent_id?: string;
  readonly total_tokens?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_creation_tokens?: number;
  readonly tool_uses?: number;
  readonly duration_ms?: number;
  readonly last_tool_name?: string;
  readonly summary?: string;
}

export interface TaskNotificationPayload {
  readonly request_id: string;
  readonly task_id: string;
  readonly agent_id?: string;
  readonly status: string;
  readonly summary?: string;
  readonly total_tokens?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_creation_tokens?: number;
  readonly tool_uses?: number;
  readonly duration_ms?: number;
}

export interface TodoDiffEntry {
  readonly content: string;
  readonly changeType: "added" | "removed" | "status_changed" | "unchanged";
  readonly oldStatus?: string;
  readonly newStatus?: string;
}

export interface TodoUpdatedPayload {
  readonly request_id: string;
  readonly todos: ReadonlyArray<{
    readonly content: string;
    readonly status: string;
    readonly activeForm: string;
  }>;
  readonly diff?: ReadonlyArray<TodoDiffEntry>;
}

export interface AskUserQuestionPayload {
  readonly request_id: string;
  readonly confirm_id: string;
  readonly tool_call_id: string;
  readonly questions: ReadonlyArray<{
    readonly question: string;
    readonly header: string;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
    readonly multi_select: boolean;
  }>;
}

/** Slash command metadata as serialized by Rust `SlashCommandInfoPayload`.
 *  Field names match the Rust serde rename (camelCase). */
export interface SlashCommandInfoPayload {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: ReadonlyArray<string>;
}

export interface SystemInitPayload {
  readonly request_id: string;
  readonly tools: ReadonlyArray<string>;
  readonly mcp_servers: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly model: string;
  readonly fast_mode_state?: string;
  readonly slash_commands: ReadonlyArray<SlashCommandInfoPayload>;
}

export interface CompactPayload {
  readonly request_id: string;
  readonly trigger: string;
  readonly pre_tokens: number;
}

export interface FileChangedPayload {
  readonly request_id: string;
  readonly file_path: string;
  readonly action: string;
  readonly tool_name: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface TurnDiffPayload {
  readonly request_id: string;
  readonly diff: string;
}

export interface UserMessageUuidPayload {
  readonly request_id: string;
  readonly uuid: string;
}

export interface NewTurnPayload {
  readonly request_id: string;
  readonly commandName?: string;
  readonly command_name?: string;
}

export interface TurnFinishedPayload {
  readonly request_id: string;
  readonly last_assistant_message?: string | null;
}

export interface RewindFilesResultPayload {
  readonly request_id: string;
  readonly success: boolean;
  readonly error?: string;
  readonly files_changed?: ReadonlyArray<string>;
  readonly insertions?: number;
  readonly deletions?: number;
}

export interface StreamRetryPayload {
  readonly request_id: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly reason: string;
}

export interface SessionInvalidatedPayload {
  readonly request_id: string;
  readonly conversation_id: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Handler registration return type
// ---------------------------------------------------------------------------

export type UnlistenFnArray = UnlistenFn[];
