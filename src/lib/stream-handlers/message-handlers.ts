import type { UnlistenFn } from "@tauri-apps/api/event";
import { windowListen } from "@/lib/window-listen";
import { useChatStore, useAgentStatusStore, useConversationStore } from "@/stores";
import { useStreamStateStore } from "@/stores/stream-state-store";
import { getStreamRequestContext, type StreamRequestContext } from "@/lib/chat-stream-registry";
import type { ChatMessage, ThinkingEntry } from "@/stores/chat-types";
import { triggerTitleGeneration } from "./helpers";
import type {
  ListenerParams,
  DeltaPayload,
  CompletePayload,
  MediaPayload,
} from "./types";

/**
 * Snapshot the mutable thinking blocks from a context into an immutable array
 * suitable for the Zustand store. Each block gets a `complete` flag based on
 * whether it's finished (all blocks before the last are always complete; the
 * last block is complete only when thinkingPhaseActive is false).
 */
function snapshotThinkingBlocks(ctx: StreamRequestContext): ReadonlyArray<ThinkingEntry> {
  return ctx.thinkingBlocks.map((b, i) => ({
    text: b.text,
    textOffset: b.textOffset,
    complete: i < ctx.thinkingBlocks.length - 1 || !ctx.thinkingPhaseActive,
    kind: b.kind,
  }));
}

// ---------------------------------------------------------------------------
// Throttled store updates — delta events fire every ~10-50ms but we only need
// to push to React at ~80ms intervals. Text is accumulated in ctx.accumulated
// (zero-latency), only the store set() calls are batched.
//
// NOTE: scheduleContentFlush / scheduleThinkingFlush capture `ctx` by reference
// intentionally — `ctx.accumulated` is mutated in-place by the delta handler,
// so the flush callback always reads the latest accumulated text.
// ---------------------------------------------------------------------------
const DELTA_THROTTLE_MS = 80;

/** Safety-net: auto-evict stale entries after this duration in case
 *  chat-complete never fires (network drop, abnormal stream termination). */
const THROTTLE_MAX_LIFETIME_MS = 30_000;

/** Per-message throttle state for content deltas. */
const _contentFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Track messages that have already received their first delta.
 *  The first delta bypasses the throttle timer for instant display. */
const _firstContentDeltaSeen = new Set<string>();
const _firstThinkingDeltaSeen = new Set<string>();

function flushContent(msgId: string, ctx: StreamRequestContext) {
  _contentFlushTimers.delete(msgId);
  const prefix = ctx.contentPrefix ?? "";
  const separator = prefix && ctx.accumulated.trim() ? "\n\n" : "";
  useChatStore.getState().updateMessageContent(msgId, prefix + separator + ctx.accumulated);
}

function scheduleContentFlush(msgId: string, ctx: StreamRequestContext) {
  // First delta for this message: flush immediately for instant first-token display
  if (!_firstContentDeltaSeen.has(msgId)) {
    _firstContentDeltaSeen.add(msgId);
    flushContent(msgId, ctx);
    return;
  }
  if (_contentFlushTimers.has(msgId)) return; // already scheduled
  _contentFlushTimers.set(
    msgId,
    setTimeout(() => flushContent(msgId, ctx), DELTA_THROTTLE_MS),
  );
}

/** Cancel any pending content flush timer for a message.
 *  The caller is responsible for performing the final store update. */
function cancelPendingContentFlush(msgId: string) {
  const timer = _contentFlushTimers.get(msgId);
  if (timer !== undefined) {
    clearTimeout(timer);
    _contentFlushTimers.delete(msgId);
  }
}

/** Per-message throttle state for thinking deltas. */
const _thinkingFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushThinking(msgId: string, ctx: StreamRequestContext) {
  _thinkingFlushTimers.delete(msgId);
  useChatStore.getState().updateMessageThinkingBlocks(
    msgId,
    snapshotThinkingBlocks(ctx),
  );
}

function scheduleThinkingFlush(msgId: string, ctx: StreamRequestContext) {
  // First thinking delta: flush immediately for instant display
  if (!_firstThinkingDeltaSeen.has(msgId)) {
    _firstThinkingDeltaSeen.add(msgId);
    flushThinking(msgId, ctx);
    return;
  }
  if (_thinkingFlushTimers.has(msgId)) return;
  _thinkingFlushTimers.set(
    msgId,
    setTimeout(() => flushThinking(msgId, ctx), DELTA_THROTTLE_MS),
  );
}

function cancelPendingThinkingFlush(msgId: string) {
  const timer = _thinkingFlushTimers.get(msgId);
  if (timer !== undefined) {
    clearTimeout(timer);
    _thinkingFlushTimers.delete(msgId);
  }
}

/** Clean up all throttle state for a message. Called when a stream ends
 *  (chat-complete) to release closure references and prevent leaks.
 *  Also schedules a delayed safety-net eviction at schedule time in case
 *  chat-complete never arrives. */
function cleanupThrottleState(msgId: string) {
  cancelPendingContentFlush(msgId);
  cancelPendingThinkingFlush(msgId);
  _firstContentDeltaSeen.delete(msgId);
  _firstThinkingDeltaSeen.delete(msgId);
}

// Safety-net timers: auto-evict stale throttle entries if chat-complete
// never fires (e.g. network drop). Keyed by msgId.
const _safetyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function ensureSafetyNet(msgId: string) {
  if (_safetyTimers.has(msgId)) return;
  _safetyTimers.set(
    msgId,
    setTimeout(() => {
      _safetyTimers.delete(msgId);
      cleanupThrottleState(msgId);
    }, THROTTLE_MAX_LIFETIME_MS),
  );
}

function clearSafetyNet(msgId: string) {
  const timer = _safetyTimers.get(msgId);
  if (timer !== undefined) {
    clearTimeout(timer);
    _safetyTimers.delete(msgId);
  }
}

function persistCompletedAssistantMessage(ctx: StreamRequestContext, content: string) {
  const convId = ctx.conversationId;
  if (!convId) return;

  const store = useChatStore.getState();
  const fromLive = store.messages.find((m) => m.id === ctx.messageId);
  const fromSnapshot = store._snapshots[convId]?.messages.find((m) => m.id === ctx.messageId);
  const existing = fromLive ?? fromSnapshot;
  const fallback: ChatMessage = {
    id: ctx.messageId,
    role: ctx.sdk ?? "claude",
    content,
    agent: ctx.modelLabel,
    timestamp: Date.now(),
  };

  void store.persistMessage(convId, {
    ...(existing ?? fallback),
    content,
    ...(ctx.currentTurnUsage ? { turnUsage: ctx.currentTurnUsage } : {}),
  });
}

/**
 * Register listeners for message-content events:
 *   - chat-delta          (streaming text)
 *   - chat-complete       (full text on stream end)
 *   - chat-thinking-delta (extended thinking)
 *   - chat-media          (images / other media)
 */
export async function registerMessageHandlers(
  params: ListenerParams,
): Promise<UnlistenFn[]> {
  const { registry, shouldIgnore, syncWriter } = params;

  // ---- chat-delta --------------------------------------------------------
  const u1 = await windowListen<DeltaPayload>("chat-delta", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;

    // Clear retry state if it was set — the retry succeeded and streaming resumed.
    // Only clear for the foreground conversation to avoid cross-conversation leakage.
    const streamState = useStreamStateStore.getState();
    if (streamState.retryAttempt !== null) {
      const activeConvId = useConversationStore.getState().activeConversationId;
      if (ctx.conversationId === activeConvId) {
        streamState.clearRetryState();
      }
    }

    // Clear cold-start phase — real content is arriving, AgentLoading will hide.
    // Only for foreground conversation to avoid cross-conversation leakage.
    if (streamState.streamPhase !== null) {
      const activeConvId = useConversationStore.getState().activeConversationId;
      if (ctx.conversationId === activeConvId) {
        streamState.setStreamPhase(null);
      }
    }

    // Auto-recover: if we receive a text delta but streamingActive was set to
    // false (e.g. by done(sessionAlive=true) arriving slightly early), restore
    // the streaming indicator so the UI reflects the ongoing turn.
    if (ctx.streamingActive === false) {
      ctx.streamingActive = true;
      const activeConvId = useConversationStore.getState().activeConversationId;
      if (ctx.conversationId === activeConvId) {
        syncWriter.setStreamingConversationId(ctx.conversationId);
        syncWriter.setStreaming(true);
        syncWriter.setStreamingMessageId(ctx.messageId);
      }
    }

    // Register a safety-net timer on the first delta for this message.
    // If chat-complete never fires, the throttle entries are auto-evicted.
    ensureSafetyNet(ctx.messageId);

    // Text delta means the active thinking phase (if any) is over.
    // Mark blocks complete so each ThinkingBlock stops its timer.
    if (ctx.thinkingPhaseActive) {
      ctx.thinkingPhaseActive = false;
      cancelPendingThinkingFlush(ctx.messageId);
      useChatStore.getState().updateMessageThinkingBlocks(
        ctx.messageId,
        snapshotThinkingBlocks(ctx),
      );
    }

    // Accumulate text immediately (zero latency), throttle the store update.
    ctx.accumulated += e.payload.delta;
    scheduleContentFlush(ctx.messageId, ctx);

    // Estimate output tokens from the delta text length (~4 chars/token).
    const agentStore = useAgentStatusStore.getState();
    const activeConvId = useConversationStore.getState().activeConversationId;
    const isBackground = ctx.conversationId != null && ctx.conversationId !== activeConvId;
    if (isBackground) {
      agentStore.addCachedOutputTokenEstimate(ctx.conversationId!, e.payload.delta.length);
    } else {
      agentStore.addOutputTokenEstimate(e.payload.delta.length);
    }

    // If we were compacting, receiving a text delta means compaction finished.
    if (useAgentStatusStore.getState().compacting) {
      useAgentStatusStore.getState().clearCompacting(ctx.conversationId);
    }

    // Trigger title generation on the very first delta.
    triggerTitleGeneration(ctx);
  });

  // ---- chat-complete -----------------------------------------------------
  const u2 = await windowListen<CompletePayload>("chat-complete", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    const activeConvId = useConversationStore.getState().activeConversationId;

    // Cancel all pending throttled flushes — the final state will be written
    // atomically below, avoiding race conditions where React sees an
    // intermediate state (e.g. content updated but thinkingBlocks still stale).
    cancelPendingThinkingFlush(ctx.messageId);
    cancelPendingContentFlush(ctx.messageId);

    // Snapshot thinking blocks if any exist.
    const hasThinking = ctx.thinkingPhaseActive || ctx.thinkingBlocks.length > 0;
    ctx.thinkingPhaseActive = false;
    const finalThinking = hasThinking ? snapshotThinkingBlocks(ctx) : undefined;

    // Prefer the text accumulated via deltas.
    const rawText = ctx.accumulated || e.payload.full_text;
    ctx.accumulated = rawText;

    // Prepend contentPrefix if present.
    const prefix = ctx.contentPrefix ?? "";
    const separator = prefix && rawText.trim() ? "\n\n" : "";
    const displayText = prefix + separator + rawText;

    // Atomically update both content and thinkingBlocks in a single store
    // write to prevent React from rendering an intermediate state where
    // thinkingBlocks is present but content is stale (or vice versa).
    useChatStore.getState().updateMessageCompleteState(
      ctx.messageId,
      displayText,
      finalThinking,
    );

    ctx.completedMessageId = ctx.messageId;
    ctx.completedContent = displayText;
    ctx.completedTurnStartedAt = ctx.turnStartedAt ?? ctx.startedAt;
    ctx.completedTurnUsage = ctx.currentTurnUsage;
    persistCompletedAssistantMessage(ctx, displayText);

    // Once the final content for the foreground turn is committed, it is safe
    // to clear the compatibility streaming store. This avoids the race where
    // chat-done(session_alive=true) fires before the last deltas/complete event.
    if (ctx.conversationId === activeConvId) {
      const streamState = useStreamStateStore.getState();
      if (
        streamState.isStreaming &&
        streamState.streamingConversationId === ctx.conversationId &&
        streamState.streamingMessageId === ctx.messageId
      ) {
        syncWriter.setStreaming(false);
      }
    }

    // Release all throttle state and safety-net for this message.
    cleanupThrottleState(ctx.messageId);
    clearSafetyNet(ctx.messageId);
  });

  // ---- chat-thinking-delta -----------------------------------------------
  // Thinking/reasoning deltas from the Claude SDK extended thinking mode.
  // Each time a new thinking phase begins (thinkingPhaseActive was false),
  // a new block is created with the current text accumulation offset.
  const u3 = await windowListen<DeltaPayload>("chat-thinking-delta", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) {
      console.warn("[stream] thinking delta ignored because no request context was found");
      return;
    }

    // Advance cold-start phase to "thinking" (foreground only)
    const thinkPhase = useStreamStateStore.getState().streamPhase;
    if (thinkPhase === "connecting" || thinkPhase === "waiting") {
      const activeConvId = useConversationStore.getState().activeConversationId;
      if (ctx.conversationId === activeConvId) {
        useStreamStateStore.getState().setStreamPhase("thinking");
      }
    }

    // Auto-recover streaming state (same as chat-delta above).
    if (ctx.streamingActive === false) {
      ctx.streamingActive = true;
      const activeConvId = useConversationStore.getState().activeConversationId;
      if (ctx.conversationId === activeConvId) {
        syncWriter.setStreamingConversationId(ctx.conversationId);
        syncWriter.setStreaming(true);
        syncWriter.setStreamingMessageId(ctx.messageId);
      }
    }

    const incomingKind = e.payload.kind;
    const lastBlock = ctx.thinkingBlocks[ctx.thinkingBlocks.length - 1];
    const shouldStartNewBlock =
      e.payload.start_new_block === true ||
      !ctx.thinkingPhaseActive ||
      (lastBlock !== undefined && lastBlock.kind !== incomingKind);

    if (shouldStartNewBlock) {
      // Start a new thinking block at the current text position.
      ctx.thinkingBlocks.push({ text: "", textOffset: ctx.accumulated.length, kind: incomingKind });
      ctx.thinkingPhaseActive = true;
    }

    if (!e.payload.delta) {
      return;
    }

    // Append delta to the current (last) block.
    const last = ctx.thinkingBlocks[ctx.thinkingBlocks.length - 1];
    if (last.kind !== incomingKind) last.kind = incomingKind;
    last.text += e.payload.delta;

    // Throttle: accumulate in-memory, flush to store at intervals.
    scheduleThinkingFlush(ctx.messageId, ctx);
  });

  // ---- chat-media --------------------------------------------------------
  const u4 = await windowListen<MediaPayload>("chat-media", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;

    useChatStore.getState().addMessageMedia(ctx.messageId, e.payload.media_type, e.payload.data);
  });

  return [u1, u2, u3, u4];
}
