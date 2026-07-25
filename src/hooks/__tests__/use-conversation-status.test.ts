import { describe, expect, it } from "vitest";
import {
  createStreamRequestRegistry,
  upsertStreamRequestContext,
} from "@/lib/chat-stream-registry";
import { buildConversationRunningIds, getConversationRunState } from "@/lib/conversation-status";

describe("buildConversationRunningIds", () => {
  it("uses explicit streamingConversationId instead of inferring from active tab", () => {
    const registry = createStreamRequestRegistry();

    const runningIds = buildConversationRunningIds({
      isStreaming: true,
      streamingConversationId: "conv-b",
      snapshots: {},
      registry,
    });

    expect(runningIds.has("conv-a")).toBe(false);
    expect(runningIds.has("conv-b")).toBe(true);
  });

  it("keeps background snapshot conversations marked as running", () => {
    const registry = createStreamRequestRegistry();

    const runningIds = buildConversationRunningIds({
      isStreaming: false,
      streamingConversationId: null,
      snapshots: {
        "conv-b": {
          messages: [],
          hasMoreMessages: false,
          totalMessageCount: 0,
          dbTotal: 0,
          isLoadingOlder: false,
          isStreaming: true,
          streamingMessageId: "msg-b",
          streamingConversationId: "conv-b",
          streamStartTime: Date.now(),
          streamPhase: "waiting",
        },
      },
      registry,
    });

    expect(runningIds.has("conv-b")).toBe(true);
  });

  it("ignores snapshot running flags when the snapshot belongs to another conversation", () => {
    const registry = createStreamRequestRegistry();

    const runningIds = buildConversationRunningIds({
      isStreaming: false,
      streamingConversationId: null,
      snapshots: {
        "conv-a": {
          messages: [],
          hasMoreMessages: false,
          totalMessageCount: 0,
          dbTotal: 0,
          isLoadingOlder: false,
          isStreaming: true,
          streamingMessageId: "msg-b",
          streamingConversationId: "conv-b",
          streamStartTime: Date.now(),
          streamPhase: "waiting",
        },
      },
      registry,
    });

    expect(runningIds.has("conv-a")).toBe(false);
    expect(runningIds.has("conv-b")).toBe(false);
  });

  it("falls back to active registry contexts when snapshots are absent", () => {
    const registry = createStreamRequestRegistry();
    upsertStreamRequestContext(registry, {
      requestId: "req-1",
      messageId: "msg-1",
      conversationId: "conv-c",
      accumulated: "",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      isNewConversation: false,
      firstUserMessage: "",
      titleTriggered: false,
    });

    const runningIds = buildConversationRunningIds({
      isStreaming: false,
      streamingConversationId: null,
      snapshots: {},
      registry,
    });

    expect(runningIds.has("conv-c")).toBe(true);
  });
});

describe("getConversationRunState", () => {
  it("keeps the active conversation running when the registry context still exists after done", () => {
    const registry = createStreamRequestRegistry();
    upsertStreamRequestContext(registry, {
      requestId: "req-1",
      messageId: "msg-1",
      conversationId: "conv-a",
      accumulated: "partial output",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      isNewConversation: false,
      firstUserMessage: "",
      titleTriggered: false,
      streamingActive: false,
    });

    const runState = getConversationRunState({
      conversationId: "conv-a",
      isStreaming: true,
      streamingConversationId: "conv-a",
      streamingMessageId: "msg-1",
      snapshots: {},
      registry,
      streamStartTime: 123,
    });

    expect(runState.isRunning).toBe(true);
    expect(runState.streamingMessageId).toBe("msg-1");
    expect(runState.streamStartTime).toBe(123);
  });

  it("uses snapshot state when the registry no longer has the conversation", () => {
    const registry = createStreamRequestRegistry();

    const runState = getConversationRunState({
      conversationId: "conv-b",
      isStreaming: false,
      streamingConversationId: null,
      streamingMessageId: null,
      snapshots: {
        "conv-b": {
          messages: [],
          hasMoreMessages: false,
          totalMessageCount: 0,
          dbTotal: 0,
          isLoadingOlder: false,
          isStreaming: true,
          streamingMessageId: "msg-b",
          streamingConversationId: "conv-b",
          streamStartTime: 456,
          streamPhase: "thinking",
        },
      },
      registry,
      streamStartTime: null,
    });

    expect(runState.isRunning).toBe(true);
    expect(runState.streamingMessageId).toBe("msg-b");
    expect(runState.streamStartTime).toBe(456);
  });

  it("ignores mismatched snapshot stream metadata for the current conversation", () => {
    const registry = createStreamRequestRegistry();

    const runState = getConversationRunState({
      conversationId: "conv-a",
      isStreaming: false,
      streamingConversationId: null,
      streamingMessageId: null,
      snapshots: {
        "conv-a": {
          messages: [],
          hasMoreMessages: false,
          totalMessageCount: 0,
          dbTotal: 0,
          isLoadingOlder: false,
          isStreaming: true,
          streamingMessageId: "msg-b",
          streamingConversationId: "conv-b",
          streamStartTime: 456,
          streamPhase: "thinking",
        },
      },
      registry,
      streamStartTime: null,
    });

    expect(runState.isRunning).toBe(false);
    expect(runState.streamingMessageId).toBeNull();
    expect(runState.streamingConversationId).toBeNull();
    expect(runState.streamStartTime).toBeNull();
    expect(runState.streamPhase).toBeNull();
  });
});
