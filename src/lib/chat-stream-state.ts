import {
  getActiveStreamRequestContext,
  hasActiveStreamRequests,
  removeStreamRequestContext,
  type StreamRequestContext,
  type StreamRequestRegistry,
} from "@/lib/chat-stream-registry";

/**
 * Check whether a session ID belongs to a Claude session (JSONL source).
 * Claude session IDs have no prefix; non-Claude sessions use:
 * - `oai-` for OpenAI/Codex
 * - `gem-` for Gemini
 * - `ccmpl-` for ChatCompletion
 */
export function isClaudeSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return (
    !sessionId.startsWith("oai-") &&
    !sessionId.startsWith("gem-") &&
    !sessionId.startsWith("ccmpl-")
  );
}

export interface StreamStateWriter {
  readonly setStreamingMessageId: (messageId: string | null) => void;
  readonly setStreamingConversationId: (conversationId: string | null) => void;
  readonly setStreaming: (streaming: boolean) => void;
}

/**
 * Check whether the registry has any in-flight requests that belong to the
 * given conversation.  Returns false when conversationId is null/undefined.
 */
function hasActiveRequestsForConversation(
  registry: StreamRequestRegistry,
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId) return false;
  for (const ctx of registry.contexts.values()) {
    if (ctx.conversationId === conversationId) return true;
  }
  return false;
}

export function syncStreamStateFromRegistry(
  registry: StreamRequestRegistry,
  writer: StreamStateWriter,
  activeConversationId?: string | null,
): void {
  const active = getActiveStreamRequestContext(registry);
  writer.setStreamingMessageId(active?.messageId ?? null);
  writer.setStreamingConversationId(active?.conversationId ?? null);

  // Turn off streaming when there are no requests at all, OR when the
  // remaining requests all belong to background conversations (not the one
  // the user is currently viewing).
  if (!hasActiveStreamRequests(registry) || !hasActiveRequestsForConversation(registry, activeConversationId)) {
    writer.setStreaming(false);
  }
}

export function removeRequestAndSyncStreamState(
  registry: StreamRequestRegistry,
  requestId: string,
  writer: StreamStateWriter,
  activeConversationId?: string | null,
): StreamRequestContext | undefined {
  const context = removeStreamRequestContext(registry, requestId);
  if (!context) {
    return undefined;
  }

  syncStreamStateFromRegistry(registry, writer, activeConversationId);
  return context;
}
