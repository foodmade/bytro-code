import { create } from "zustand";

// Single shared timer for elapsed time — avoids per-component setInterval storm
let _elapsedTimerId: ReturnType<typeof setInterval> | null = null;

// Safety-net timer: force-reset isStreaming if no events arrive for too long.
// 15 minutes accommodates worst-case image generation (high-quality 4K via
// third-party proxy + non-stream fallback). Tool chains and partial-image
// frames refresh this via refreshStreamSafetyTimeout(); during the silent
// non-stream image-gen window the MCP server now emits heartbeats.
let _streamSafetyTimerId: ReturnType<typeof setTimeout> | null = null;
const STREAM_SAFETY_TIMEOUT_MS = 15 * 60 * 1000;

// Fallback timer: auto-advance from "connecting" to "waiting" for providers
// that don't emit a chat-session event (e.g. Gemini, some ChatCmpl endpoints).
let _phaseFallbackTimerId: ReturnType<typeof setTimeout> | null = null;
const PHASE_FALLBACK_MS = 3_000;

// Per-conversation expiry timers for pending ScheduleWakeup marks. The wakeup
// normally clears via chat-new-turn when the resumed turn starts; the timer is
// a leak guard for wakeups that never fire (sidecar died, session evicted).
const _wakeupExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const WAKEUP_EXPIRY_BUFFER_MS = 90_000;

function clearWakeupExpiryTimer(conversationId: string) {
  const timer = _wakeupExpiryTimers.get(conversationId);
  if (timer !== undefined) {
    clearTimeout(timer);
    _wakeupExpiryTimers.delete(conversationId);
  }
}

export type StreamPhase = "connecting" | "waiting" | "thinking" | null;

function clearPhaseFallbackTimer() {
  if (_phaseFallbackTimerId !== null) {
    clearTimeout(_phaseFallbackTimerId);
    _phaseFallbackTimerId = null;
  }
}

function clearElapsedTimer() {
  if (_elapsedTimerId !== null) {
    clearInterval(_elapsedTimerId);
    _elapsedTimerId = null;
  }
}

/**
 * Reset the safety timeout without changing any stream state.
 * Call this when receiving backend events (tool-use, file-changed, etc.)
 * that prove the sidecar is still alive but don't produce text deltas.
 */
export function refreshStreamSafetyTimeout(): void {
  if (_streamSafetyTimerId === null) return;
  clearTimeout(_streamSafetyTimerId);
  _streamSafetyTimerId = setTimeout(() => {
    _streamSafetyTimerId = null;
    const state = useStreamStateStore.getState();
    if (state.isStreaming) {
      console.warn("[stream-state] safety timeout: force reset isStreaming after 5 min");
      clearElapsedTimer();
      clearPhaseFallbackTimer();
      useStreamStateStore.setState({
        isStreaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        streamStartTime: null,
        streamElapsed: 0,
        retryAttempt: null,
        retryMaxAttempts: null,
        retryReason: null,
        streamPhase: null,
      });
    }
  }, STREAM_SAFETY_TIMEOUT_MS);
}

interface StreamState {
  readonly isStreaming: boolean;
  readonly streamingMessageId: string | null;
  readonly streamingConversationId: string | null;
  /** Timestamp (ms) when the current streaming turn started. */
  readonly streamStartTime: number | null;
  /** Duration (ms) of the last completed streaming turn. */
  readonly lastStreamDuration: number | null;
  /** Live elapsed ms updated by a single shared interval. */
  readonly streamElapsed: number;
  /** Current retry attempt number (1-based). Null when not retrying. */
  readonly retryAttempt: number | null;
  /** Total max retry attempts. Null when not retrying. */
  readonly retryMaxAttempts: number | null;
  /** Reason for the retry. Null when not retrying. */
  readonly retryReason: string | null;
  /** Cold-start phase for progressive loading UI. */
  readonly streamPhase: StreamPhase;
  /** Conversation IDs whose tasks just completed (for tab shimmer effect). */
  readonly completedConversationIds: ReadonlySet<string>;
  /**
   * Tracked background-task IDs per conversation (e.g. run_in_background Bash).
   * Non-empty ⇒ the turn ended but the agent is still awaiting task results,
   * so the conversation shows as "listening" instead of "idle".
   */
  readonly backgroundTaskIds: ReadonlyMap<string, ReadonlySet<string>>;
  /** Conversations with a pending ScheduleWakeup — the agent will resume on its own. */
  readonly pendingWakeupConversationIds: ReadonlySet<string>;
  readonly setStreaming: (streaming: boolean) => void;
  readonly setStreamingMessageId: (id: string | null) => void;
  readonly setStreamingConversationId: (conversationId: string | null) => void;
  readonly setRetryState: (attempt: number, maxAttempts: number, reason: string) => void;
  readonly clearRetryState: () => void;
  readonly setStreamPhase: (phase: StreamPhase) => void;
  readonly resetStreamState: () => void;
  /** Mark a conversation as just-completed (tab shimmer). */
  readonly markConversationCompleted: (id: string) => void;
  /** Clear the completed mark for a conversation (on tab click). */
  readonly clearConversationCompleted: (id: string) => void;
  /** Track a background task for a conversation (idempotent). */
  readonly addBackgroundTask: (conversationId: string, taskId: string) => void;
  /** Untrack a background task (its task-notification arrived). */
  readonly removeBackgroundTask: (conversationId: string, taskId: string) => void;
  /** Mark a pending ScheduleWakeup; auto-expires after delayMs + buffer. */
  readonly setPendingWakeup: (conversationId: string, delayMs: number) => void;
  /** Clear the pending-wakeup mark (the resumed turn started, or it expired). */
  readonly clearPendingWakeup: (conversationId: string) => void;
  /** Drop all background-activity tracking for a conversation (session ended / error). */
  readonly clearBackgroundActivity: (conversationId: string) => void;
  /** Restore full stream state from a conversation snapshot (no side-effects). */
  readonly restoreStreamState: (state: {
    isStreaming: boolean;
    streamingMessageId: string | null;
    streamingConversationId: string | null;
    streamStartTime: number | null;
    streamPhase: StreamPhase;
  }) => void;
}

function startElapsedTimer(get: () => StreamState, set: (partial: Partial<StreamState>) => void) {
  clearElapsedTimer();
  _elapsedTimerId = setInterval(() => {
    const start = get().streamStartTime;
    if (start != null) {
      set({ streamElapsed: Date.now() - start });
    }
  }, 1000);
}

export const useStreamStateStore = create<StreamState>((set, get) => ({
  isStreaming: false,
  streamingMessageId: null,
  streamingConversationId: null,
  streamStartTime: null,
  lastStreamDuration: null,
  streamElapsed: 0,
  retryAttempt: null,
  retryMaxAttempts: null,
  retryReason: null,
  streamPhase: null,
  completedConversationIds: new Set<string>(),
  backgroundTaskIds: new Map<string, ReadonlySet<string>>(),
  pendingWakeupConversationIds: new Set<string>(),
  setStreaming: (streaming) => {
    if (streaming) {
      set({
        isStreaming: true,
        streamStartTime: Date.now(),
        streamElapsed: 0,
        streamPhase: "connecting",
      });
      startElapsedTimer(get, set);
      // Fallback: auto-advance to "waiting" if no chat-session arrives within 3s
      clearPhaseFallbackTimer();
      _phaseFallbackTimerId = setTimeout(() => {
        _phaseFallbackTimerId = null;
        if (get().streamPhase === "connecting") {
          set({ streamPhase: "waiting" });
        }
      }, PHASE_FALLBACK_MS);
      // Start safety-net timer to force-reset if events stop arriving
      if (_streamSafetyTimerId !== null) clearTimeout(_streamSafetyTimerId);
      _streamSafetyTimerId = setTimeout(() => {
        _streamSafetyTimerId = null;
        if (get().isStreaming) {
          console.warn("[stream-state] safety timeout: force reset isStreaming after 5 min");
          clearElapsedTimer();
          clearPhaseFallbackTimer();
          set({
            isStreaming: false,
            streamingMessageId: null,
            streamingConversationId: null,
            streamStartTime: null,
            streamElapsed: 0,
            retryAttempt: null,
            retryMaxAttempts: null,
            retryReason: null,
            streamPhase: null,
          });
        }
      }, STREAM_SAFETY_TIMEOUT_MS);
    } else {
      if (_streamSafetyTimerId !== null) {
        clearTimeout(_streamSafetyTimerId);
        _streamSafetyTimerId = null;
      }
      clearElapsedTimer();
      clearPhaseFallbackTimer();
      const startTime = get().streamStartTime;
      const duration = startTime != null ? Date.now() - startTime : null;
      set({
        isStreaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        streamStartTime: null,
        streamElapsed: 0,
        lastStreamDuration: duration,
        retryAttempt: null,
        retryMaxAttempts: null,
        retryReason: null,
        streamPhase: null,
      });
    }
  },
  setStreamingMessageId: (id) => set({ streamingMessageId: id }),
  setStreamingConversationId: (conversationId) => set({ streamingConversationId: conversationId }),
  setRetryState: (attempt, maxAttempts, reason) =>
    set({ retryAttempt: attempt, retryMaxAttempts: maxAttempts, retryReason: reason }),
  clearRetryState: () => set({ retryAttempt: null, retryMaxAttempts: null, retryReason: null }),
  setStreamPhase: (phase) => {
    if (phase !== "connecting") clearPhaseFallbackTimer();
    set({ streamPhase: phase });
  },
  markConversationCompleted: (id) => {
    const next = new Set(get().completedConversationIds);
    next.add(id);
    set({ completedConversationIds: next });
  },
  clearConversationCompleted: (id) => {
    const prev = get().completedConversationIds;
    if (!prev.has(id)) return;
    const next = new Set(prev);
    next.delete(id);
    set({ completedConversationIds: next });
  },
  addBackgroundTask: (conversationId, taskId) => {
    const prev = get().backgroundTaskIds;
    if (prev.get(conversationId)?.has(taskId)) return;
    const next = new Map(prev);
    next.set(conversationId, new Set(prev.get(conversationId)).add(taskId));
    set({ backgroundTaskIds: next });
  },
  removeBackgroundTask: (conversationId, taskId) => {
    const prev = get().backgroundTaskIds;
    const tasks = prev.get(conversationId);
    if (!tasks?.has(taskId)) return;
    const next = new Map(prev);
    const nextTasks = new Set(tasks);
    nextTasks.delete(taskId);
    if (nextTasks.size === 0) {
      next.delete(conversationId);
    } else {
      next.set(conversationId, nextTasks);
    }
    set({ backgroundTaskIds: next });
  },
  setPendingWakeup: (conversationId, delayMs) => {
    clearWakeupExpiryTimer(conversationId);
    _wakeupExpiryTimers.set(
      conversationId,
      setTimeout(() => {
        _wakeupExpiryTimers.delete(conversationId);
        get().clearPendingWakeup(conversationId);
      }, delayMs + WAKEUP_EXPIRY_BUFFER_MS),
    );
    const prev = get().pendingWakeupConversationIds;
    if (prev.has(conversationId)) return;
    set({ pendingWakeupConversationIds: new Set(prev).add(conversationId) });
  },
  clearPendingWakeup: (conversationId) => {
    clearWakeupExpiryTimer(conversationId);
    const prev = get().pendingWakeupConversationIds;
    if (!prev.has(conversationId)) return;
    const next = new Set(prev);
    next.delete(conversationId);
    set({ pendingWakeupConversationIds: next });
  },
  clearBackgroundActivity: (conversationId) => {
    get().clearPendingWakeup(conversationId);
    const prev = get().backgroundTaskIds;
    if (!prev.has(conversationId)) return;
    const next = new Map(prev);
    next.delete(conversationId);
    set({ backgroundTaskIds: next });
  },
  resetStreamState: () => {
    clearElapsedTimer();
    clearPhaseFallbackTimer();
    set({
      isStreaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      streamStartTime: null,
      streamElapsed: 0,
      retryAttempt: null,
      retryMaxAttempts: null,
      retryReason: null,
      streamPhase: null,
    });
  },
  restoreStreamState: (state) => {
    clearElapsedTimer();
    clearPhaseFallbackTimer();
    const elapsed =
      state.isStreaming && state.streamStartTime != null ? Date.now() - state.streamStartTime : 0;
    set({
      isStreaming: state.isStreaming,
      streamingMessageId: state.streamingMessageId,
      streamingConversationId: state.streamingConversationId,
      streamStartTime: state.streamStartTime,
      streamElapsed: elapsed,
      retryAttempt: null,
      retryMaxAttempts: null,
      retryReason: null,
      streamPhase: state.isStreaming ? state.streamPhase : null,
    });
    if (state.isStreaming && state.streamStartTime != null) {
      startElapsedTimer(get, set);
    }
  },
}));
