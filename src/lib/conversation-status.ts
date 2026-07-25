import type { StreamRequestRegistry } from "@/lib/chat-stream-registry";
import { getLatestStreamRequestContextForConversation } from "@/lib/chat-stream-registry";
import type { ConversationSnapshot } from "@/stores/chat-types";

export interface ConversationRunState {
  readonly isRunning: boolean;
  readonly streamingMessageId: string | null;
  readonly streamingConversationId: string | null;
  readonly streamStartTime: number | null;
  readonly streamPhase: "connecting" | "waiting" | "thinking" | null;
}

export function buildConversationRunningIds(params: {
  readonly isStreaming: boolean;
  readonly streamingConversationId: string | null;
  readonly snapshots: Record<string, ConversationSnapshot>;
  readonly registry: StreamRequestRegistry;
}): Set<string> {
  const ids = new Set<string>();

  if (params.isStreaming && params.streamingConversationId) {
    ids.add(params.streamingConversationId);
  }

  for (const [convId, snap] of Object.entries(params.snapshots)) {
    if (snap.isStreaming && snap.streamingConversationId === convId) {
      ids.add(convId);
    }
  }

  for (const ctx of params.registry.contexts.values()) {
    if (ctx.conversationId && ctx.streamingActive !== false) {
      ids.add(ctx.conversationId);
    }
  }

  return ids;
}

export function getConversationRunState(params: {
  readonly conversationId: string | null | undefined;
  readonly isStreaming: boolean;
  readonly streamingConversationId: string | null;
  readonly streamingMessageId: string | null;
  readonly snapshots: Record<string, ConversationSnapshot>;
  readonly registry: StreamRequestRegistry;
  readonly streamStartTime: number | null;
}): ConversationRunState {
  const conversationId = params.conversationId;
  if (!conversationId) {
    return {
      isRunning: false,
      streamingMessageId: null,
      streamingConversationId: null,
      streamStartTime: null,
      streamPhase: null,
    };
  }

  const snapshot = params.snapshots[conversationId];
  const snapshotMatchesConversation =
    snapshot?.isStreaming === true &&
    snapshot.streamingConversationId === conversationId;
  const latestContext = getLatestStreamRequestContextForConversation(
    params.registry,
    conversationId,
  );
  const isForegroundStream =
    params.isStreaming && params.streamingConversationId === conversationId;

  const isRunning = Boolean(
    (latestContext && (latestContext.streamingActive !== false || isForegroundStream)) ||
    snapshotMatchesConversation ||
    isForegroundStream,
  );

  return {
    isRunning,
    streamingMessageId:
      latestContext?.messageId ??
      (snapshotMatchesConversation
        ? snapshot.streamingMessageId
        : null) ??
      (isForegroundStream ? params.streamingMessageId : null),
    streamingConversationId:
      latestContext?.conversationId ??
      (snapshotMatchesConversation ? snapshot.streamingConversationId : null) ??
      (isForegroundStream ? params.streamingConversationId : null),
    streamStartTime:
      (isForegroundStream ? params.streamStartTime : null) ??
      (snapshotMatchesConversation ? snapshot.streamStartTime : null) ??
      null,
    streamPhase:
      (isForegroundStream ? params.snapshots[conversationId]?.streamPhase ?? null : null) ??
      (snapshotMatchesConversation ? snapshot.streamPhase : null) ??
      null,
  };
}
