import { describe, it, expect, vi } from "vitest";
import {
  createStreamRequestRegistry,
  setActiveStreamRequest,
  upsertStreamRequestContext,
} from "../chat-stream-registry";
import {
  removeRequestAndSyncStreamState,
  syncStreamStateFromRegistry,
} from "../chat-stream-state";

function addContext(
  registry: ReturnType<typeof createStreamRequestRegistry>,
  requestId: string,
  messageId: string,
  conversationId?: string,
): void {
  upsertStreamRequestContext(registry, {
    requestId,
    messageId,
    conversationId: conversationId ?? `c-${requestId}`,
    accumulated: "",
    thinkingBlocks: [],
    thinkingPhaseActive: false,
    isNewConversation: false,
    firstUserMessage: "",
    titleTriggered: false,
  });
}

describe("chat-stream-state", () => {
  it("syncs streaming message id from active request", () => {
    const registry = createStreamRequestRegistry();
    addContext(registry, "r1", "m1", "conv-a");
    addContext(registry, "r2", "m2", "conv-a");
    setActiveStreamRequest(registry, "r2");

    const setStreamingMessageId = vi.fn();
    const setStreamingConversationId = vi.fn();
    const setStreaming = vi.fn();
    syncStreamStateFromRegistry(registry, { setStreamingMessageId, setStreamingConversationId, setStreaming }, "conv-a");

    expect(setStreamingMessageId).toHaveBeenCalledWith("m2");
    expect(setStreamingConversationId).toHaveBeenCalledWith("conv-a");
    // Active conversation has requests, so setStreaming(false) should NOT be called
    expect(setStreaming).not.toHaveBeenCalled();
  });

  it("stops streaming when registry becomes empty", () => {
    const registry = createStreamRequestRegistry();
    addContext(registry, "r1", "m1", "conv-a");
    setActiveStreamRequest(registry, "r1");

    const setStreamingMessageId = vi.fn();
    const setStreamingConversationId = vi.fn();
    const setStreaming = vi.fn();

    const removed = removeRequestAndSyncStreamState(registry, "r1", {
      setStreamingMessageId,
      setStreamingConversationId,
      setStreaming,
    }, "conv-a");

    expect(removed?.requestId).toBe("r1");
    expect(setStreamingMessageId).toHaveBeenCalledWith(null);
    expect(setStreamingConversationId).toHaveBeenCalledWith(null);
    expect(setStreaming).toHaveBeenCalledWith(false);
  });

  it("falls back to previous active message on removal (same conversation)", () => {
    const registry = createStreamRequestRegistry();
    addContext(registry, "r1", "m1", "conv-a");
    addContext(registry, "r2", "m2", "conv-a");
    setActiveStreamRequest(registry, "r2");

    const setStreamingMessageId = vi.fn();
    const setStreamingConversationId = vi.fn();
    const setStreaming = vi.fn();

    removeRequestAndSyncStreamState(registry, "r2", {
      setStreamingMessageId,
      setStreamingConversationId,
      setStreaming,
    }, "conv-a");

    expect(setStreamingMessageId).toHaveBeenCalledWith("m1");
    expect(setStreamingConversationId).toHaveBeenCalledWith("conv-a");
    // r1 is still active for conv-a, so streaming should stay on
    expect(setStreaming).not.toHaveBeenCalled();
  });

  it("stops streaming when active conversation finishes but background conversation still runs", () => {
    const registry = createStreamRequestRegistry();
    addContext(registry, "r-a", "m-a", "conv-a");
    addContext(registry, "r-b", "m-b", "conv-b");
    setActiveStreamRequest(registry, "r-a");

    const setStreamingMessageId = vi.fn();
    const setStreamingConversationId = vi.fn();
    const setStreaming = vi.fn();

    // conv-a is the active (foreground) conversation; remove its request
    const removed = removeRequestAndSyncStreamState(registry, "r-a", {
      setStreamingMessageId,
      setStreamingConversationId,
      setStreaming,
    }, "conv-a");

    expect(removed?.requestId).toBe("r-a");
    // Registry still has r-b, but it belongs to conv-b (background).
    // The active conversation (conv-a) has no requests, so streaming should stop.
    expect(setStreaming).toHaveBeenCalledWith(false);
  });

  it("stops streaming when no activeConversationId is provided", () => {
    const registry = createStreamRequestRegistry();
    addContext(registry, "r1", "m1", "conv-a");
    setActiveStreamRequest(registry, "r1");

    const setStreamingMessageId = vi.fn();
    const setStreamingConversationId = vi.fn();
    const setStreaming = vi.fn();

    // No activeConversationId — conservative: stop streaming
    syncStreamStateFromRegistry(registry, { setStreamingMessageId, setStreamingConversationId, setStreaming });

    expect(setStreaming).toHaveBeenCalledWith(false);
  });

  it("stops streaming when activeConversationId is null", () => {
    const registry = createStreamRequestRegistry();
    addContext(registry, "r1", "m1", "conv-a");
    setActiveStreamRequest(registry, "r1");

    const setStreamingMessageId = vi.fn();
    const setStreamingConversationId = vi.fn();
    const setStreaming = vi.fn();

    syncStreamStateFromRegistry(registry, { setStreamingMessageId, setStreamingConversationId, setStreaming }, null);

    expect(setStreaming).toHaveBeenCalledWith(false);
  });
});
