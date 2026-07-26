import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamStateStore } from "@/stores/stream-state-store";

function clearBackgroundState() {
  const state = useStreamStateStore.getState();
  for (const convId of [...state.backgroundTaskIds.keys()]) {
    state.clearBackgroundActivity(convId);
  }
  for (const convId of [...state.pendingWakeupConversationIds]) {
    state.clearPendingWakeup(convId);
  }
}

describe("useStreamStateStore", () => {
  beforeEach(() => {
    useStreamStateStore.getState().resetStreamState();
    clearBackgroundState();
  });

  afterEach(() => {
    useStreamStateStore.getState().resetStreamState();
    clearBackgroundState();
    vi.useRealTimers();
  });

  it("restores the saved stream phase for active snapshots", () => {
    useStreamStateStore.getState().restoreStreamState({
      isStreaming: true,
      streamingMessageId: "msg-1",
      streamingConversationId: "conv-1",
      streamStartTime: Date.now() - 2_000,
      streamPhase: "thinking",
    });

    const state = useStreamStateStore.getState();
    expect(state.isStreaming).toBe(true);
    expect(state.streamPhase).toBe("thinking");
  });

  it("tracks background tasks per conversation", () => {
    const store = useStreamStateStore.getState();
    store.addBackgroundTask("conv-1", "task-a");
    store.addBackgroundTask("conv-1", "task-a"); // idempotent
    store.addBackgroundTask("conv-1", "task-b");
    store.addBackgroundTask("conv-2", "task-c");

    expect(useStreamStateStore.getState().backgroundTaskIds.get("conv-1")?.size).toBe(2);

    store.removeBackgroundTask("conv-1", "task-a");
    expect(useStreamStateStore.getState().backgroundTaskIds.get("conv-1")?.size).toBe(1);

    // Removing the last task drops the conversation entry entirely
    store.removeBackgroundTask("conv-1", "task-b");
    expect(useStreamStateStore.getState().backgroundTaskIds.has("conv-1")).toBe(false);
    expect(useStreamStateStore.getState().backgroundTaskIds.get("conv-2")?.size).toBe(1);
  });

  it("clears pending wakeup on new turn and auto-expires as a leak guard", () => {
    vi.useFakeTimers();
    const store = useStreamStateStore.getState();

    store.setPendingWakeup("conv-1", 60_000);
    expect(useStreamStateStore.getState().pendingWakeupConversationIds.has("conv-1")).toBe(true);

    store.clearPendingWakeup("conv-1");
    expect(useStreamStateStore.getState().pendingWakeupConversationIds.has("conv-1")).toBe(false);

    // Expiry guard: delayMs + buffer without a new turn clears the mark
    store.setPendingWakeup("conv-2", 60_000);
    vi.advanceTimersByTime(60_000 + 90_000 + 1_000);
    expect(useStreamStateStore.getState().pendingWakeupConversationIds.has("conv-2")).toBe(false);
  });

  it("clearBackgroundActivity drops tasks and wakeup for one conversation", () => {
    const store = useStreamStateStore.getState();
    store.addBackgroundTask("conv-1", "task-a");
    store.setPendingWakeup("conv-1", 60_000);
    store.addBackgroundTask("conv-2", "task-b");

    store.clearBackgroundActivity("conv-1");

    const state = useStreamStateStore.getState();
    expect(state.backgroundTaskIds.has("conv-1")).toBe(false);
    expect(state.pendingWakeupConversationIds.has("conv-1")).toBe(false);
    expect(state.backgroundTaskIds.has("conv-2")).toBe(true);
  });
});
