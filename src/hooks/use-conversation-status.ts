import { useMemo } from "react";
import { useChatStore, useStreamStateStore, useConversationStore } from "@/stores";
import { useToolStateStore } from "@/stores/tool-state-store";
import { getGlobalRegistry } from "@/lib/chat-stream-manager";
import {
  buildConversationRunningIds,
  getConversationRunState,
  type ConversationRunState,
} from "@/lib/conversation-status";
import { findPendingConfirmation } from "@/components/chat/tool-confirmation-utils";

export type ConversationStatus = "running" | "permission" | "completed" | "idle";

export function useConversationStatus() {
  const isStreaming = useStreamStateStore((s) => s.isStreaming);
  const streamingMessageId = useStreamStateStore((s) => s.streamingMessageId);
  const streamingConversationId = useStreamStateStore((s) => s.streamingConversationId);
  const streamStartTime = useStreamStateStore((s) => s.streamStartTime);
  const streamPhase = useStreamStateStore((s) => s.streamPhase);
  const streamElapsed = useStreamStateStore((s) => s.streamElapsed);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const messages = useChatStore((s) => s.messages);
  const snapshots = useChatStore((s) => s._snapshots);
  const pendingAskUserQuestions = useToolStateStore((s) => s.pendingAskUserQuestions);
  const completedConversationIds = useStreamStateStore((s) => s.completedConversationIds);

  const runningIds = useMemo(() => {
    return buildConversationRunningIds({
      isStreaming,
      streamingConversationId,
      snapshots,
      registry: getGlobalRegistry(),
    });
  }, [
    isStreaming,
    streamingConversationId,
    snapshots,
  ]);

  /** Conversation IDs that have a pending confirmation or ask-user-question dialog. */
  const permissionIds = useMemo(() => {
    const ids = new Set<string>();

    // Check live messages (active conversation) for pending tool confirmations
    if (activeConversationId && findPendingConfirmation(messages)) {
      ids.add(activeConversationId);
    }

    // Check snapshots for pending tool confirmations in background conversations
    for (const [convId, snap] of Object.entries(snapshots)) {
      if (findPendingConfirmation(snap.messages)) {
        ids.add(convId);
      }
    }

    // Check pending AskUserQuestions (all conversations)
    for (const pending of Object.values(pendingAskUserQuestions)) {
      if (pending.conversationId) {
        ids.add(pending.conversationId);
      }
    }

    return ids;
  }, [activeConversationId, messages, snapshots, pendingAskUserQuestions]);

  const getStatus = useMemo(() => {
    return (convId: string): ConversationStatus => {
      if (permissionIds.has(convId)) return "permission";
      if (runningIds.has(convId)) return "running";
      if (completedConversationIds.has(convId)) return "completed";
      return "idle";
    };
  }, [runningIds, permissionIds, completedConversationIds]);

  const getRunState = useMemo(() => {
    return (convId: string | null | undefined): ConversationRunState & { readonly streamElapsedMs: number } => {
      const runState = getConversationRunState({
        conversationId: convId,
        isStreaming,
        streamingMessageId,
        streamingConversationId,
        snapshots,
        registry: getGlobalRegistry(),
        streamStartTime,
      });
      const effectivePhase =
        convId != null && streamingConversationId === convId && isStreaming
          ? streamPhase
          : runState.streamPhase;
      const elapsedMs =
        runState.isRunning && runState.streamStartTime != null
          ? (streamingConversationId === convId && isStreaming
            ? streamElapsed
            : Math.max(0, Date.now() - runState.streamStartTime))
          : 0;
      return { ...runState, streamPhase: effectivePhase, streamElapsedMs: elapsedMs };
    };
  }, [
    isStreaming,
    streamElapsed,
    streamPhase,
    streamingConversationId,
    streamingMessageId,
    snapshots,
    streamStartTime,
  ]);

  const activeRunState = useMemo(
    () => getRunState(activeConversationId),
    [activeConversationId, getRunState],
  );

  return {
    runningIds,
    getStatus,
    isActiveConversationStreaming: activeRunState.isRunning,
    getRunState,
    activeRunState,
  } as const;
}
