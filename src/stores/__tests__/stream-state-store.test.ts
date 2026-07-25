import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStreamStateStore } from "@/stores/stream-state-store";

describe("useStreamStateStore", () => {
  beforeEach(() => {
    useStreamStateStore.getState().resetStreamState();
  });

  afterEach(() => {
    useStreamStateStore.getState().resetStreamState();
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
});
