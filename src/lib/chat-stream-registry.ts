import type { AgentRole } from "@/types";
import type { WarmSessionConfig } from "@/lib/warm-session-tracker";
import type { TurnUsageData } from "@/stores/chat-types";

/**
 * Tracks per-request state during streaming. Stored in a React ref (NOT in
 * Zustand state), so mutations here intentionally bypass React's rendering
 * cycle. The `readonly` fields are identity keys that must never change;
 * the mutable fields (`accumulated`, `isNewConversation`, `firstUserMessage`)
 * are updated in-place by event listeners for performance — creating new
 * objects on every text delta would be wasteful since React re-renders are
 * driven by the Zustand store, not by this registry.
 */
export interface StreamRequestContext {
  readonly requestId: string;
  /** Timestamp (ms) when this request/turn started. Used for per-request duration. */
  readonly startedAt?: number;
  /** Timestamp (ms) when the current logical assistant turn started. Reset on chat-new-turn. */
  turnStartedAt?: number;
  /** Target assistant message ID. Updated when a mid-stream user message creates a new assistant placeholder. */
  messageId: string;
  readonly conversationId: string | null;
  /** Platform ID that originated this request (e.g. "codex", "claude"). Used by
   *  new-turn handler to avoid misattributing responses to the wrong agent. */
  readonly platformId?: string;
  /** SDK type for the request (e.g. "codex", "claude", "chatcmpl"). Determines
   *  the assistant message `role` field. */
  readonly sdk?: AgentRole;
  /** Human-readable model name (e.g. "GPT-5.3 Codex", "Opus 4.6"). Captured at
   *  request creation so event handlers can display it without re-deriving from
   *  global state that may have changed (e.g. official model selection). */
  readonly modelLabel?: string;
  /** Accumulates streamed text deltas. Mutated in-place by chat-delta listener. */
  accumulated: string;
  /** Ordered thinking blocks. Each block accumulates deltas for one thinking phase. */
  thinkingBlocks: Array<{ text: string; textOffset: number; kind?: "summary" | "raw" }>;
  /** True while thinking deltas are actively arriving (before next text_delta). */
  thinkingPhaseActive: boolean;
  /** Whether this request created a new conversation (used for title generation). */
  isNewConversation: boolean;
  /** First user message content (used for fallback title). */
  firstUserMessage: string;
  /** Whether title generation has already been triggered for this request. */
  titleTriggered: boolean;
  /**
   * Whether this context is actively streaming. Set to `false` when a turn's
   * `done` event arrives with `session_alive=true` — the context is kept alive
   * for future turns (mid-stream or warm session), but the UI should not show
   * it as running. Reset to `true` by `chat-new-turn` when a new turn starts.
   * Defaults to `true` when omitted.
   */
  streamingActive?: boolean;
  /**
   * When a mid-stream turn starts, stores the current message display
   * content as a prefix. Delta flushes prepend this so the new response
   * appends to the original message instead of overwriting it.
   */
  contentPrefix?: string;
  /**
   * Snapshot of the most recent completed assistant turn. Warm Codex sessions
   * reuse one request context across turns, and `chat-complete` can unlock the
   * input before `chat-done` finishes persistence. Keeping this snapshot lets
   * `chat-done` finalize the correct message even if `chat-new-turn` has
   * already reset `messageId` / `accumulated` for the next turn.
   */
  completedMessageId?: string;
  completedContent?: string;
  completedTurnStartedAt?: number;
  currentTurnUsage?: TurnUsageData;
  completedTurnUsage?: TurnUsageData;
  /** Config snapshot captured at request creation time. Used by chat-done to
   *  register warm sessions with the correct config, not the current UI state. */
  warmSessionConfig?: WarmSessionConfig;
}

/**
 * Mutable registry of in-flight streaming requests. Lives inside a React ref
 * so it persists across renders without triggering them. All mutations
 * (Map.set/delete, Array.push/splice) are intentional — this is NOT a
 * Zustand store and does not follow immutable update patterns.
 */
export interface StreamRequestRegistry {
  readonly contexts: Map<string, StreamRequestContext>;
  readonly order: string[];
  activeRequestId: string | null;
}

export function createStreamRequestRegistry(): StreamRequestRegistry {
  return {
    contexts: new Map<string, StreamRequestContext>(),
    order: [],
    activeRequestId: null,
  };
}

export function upsertStreamRequestContext(
  registry: StreamRequestRegistry,
  context: StreamRequestContext,
): void {
  const exists = registry.contexts.has(context.requestId);
  registry.contexts.set(context.requestId, context);

  if (!exists) {
    registry.order.push(context.requestId);
  }
}

export function setActiveStreamRequest(
  registry: StreamRequestRegistry,
  requestId: string | null,
): void {
  registry.activeRequestId = requestId;
}

export function getStreamRequestContext(
  registry: StreamRequestRegistry,
  requestId: string,
): StreamRequestContext | undefined {
  return registry.contexts.get(requestId);
}

export function getActiveStreamRequestContext(
  registry: StreamRequestRegistry,
): StreamRequestContext | undefined {
  const requestId = registry.activeRequestId;
  if (!requestId) {
    return undefined;
  }
  return registry.contexts.get(requestId);
}

export function getLatestStreamRequestContextForConversation(
  registry: StreamRequestRegistry,
  conversationId: string,
): StreamRequestContext | undefined {
  for (let index = registry.order.length - 1; index >= 0; index -= 1) {
    const requestId = registry.order[index];
    const context = registry.contexts.get(requestId);
    if (context?.conversationId === conversationId) {
      return context;
    }
  }
  return undefined;
}

export function hasActiveStreamRequests(registry: StreamRequestRegistry): boolean {
  return registry.contexts.size > 0;
}

export function removeStreamRequestContext(
  registry: StreamRequestRegistry,
  requestId: string,
): StreamRequestContext | undefined {
  const context = registry.contexts.get(requestId);
  if (!context) {
    return undefined;
  }

  registry.contexts.delete(requestId);
  const index = registry.order.indexOf(requestId);
  if (index >= 0) {
    registry.order.splice(index, 1);
  }

  if (registry.activeRequestId === requestId) {
    registry.activeRequestId = registry.order.length > 0
      ? registry.order[registry.order.length - 1]
      : null;
  }

  return context;
}
