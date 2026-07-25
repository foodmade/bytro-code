import { describe, it, expect } from "vitest";
import {
  createStreamRequestRegistry,
  getActiveStreamRequestContext,
  getLatestStreamRequestContextForConversation,
  getStreamRequestContext,
  hasActiveStreamRequests,
  removeStreamRequestContext,
  setActiveStreamRequest,
  upsertStreamRequestContext,
} from "../chat-stream-registry";

describe("chat-stream-registry", () => {
  it("stores and reads contexts", () => {
    const registry = createStreamRequestRegistry();

    upsertStreamRequestContext(registry, {
      requestId: "r1",
      messageId: "m1",
      conversationId: "c1",
      accumulated: "",
      isNewConversation: true,
      firstUserMessage: "hello",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      titleTriggered: false,
    });

    expect(getStreamRequestContext(registry, "r1")?.messageId).toBe("m1");
    expect(hasActiveStreamRequests(registry)).toBe(true);
  });

  it("tracks active context and falls back on removal", () => {
    const registry = createStreamRequestRegistry();

    upsertStreamRequestContext(registry, {
      requestId: "r1",
      messageId: "m1",
      conversationId: "c1",
      accumulated: "a",
      isNewConversation: false,
      firstUserMessage: "",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      titleTriggered: false,
    });
    upsertStreamRequestContext(registry, {
      requestId: "r2",
      messageId: "m2",
      conversationId: "c2",
      accumulated: "b",
      isNewConversation: false,
      firstUserMessage: "",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      titleTriggered: false,
    });

    setActiveStreamRequest(registry, "r2");
    expect(getActiveStreamRequestContext(registry)?.requestId).toBe("r2");

    removeStreamRequestContext(registry, "r2");
    expect(getActiveStreamRequestContext(registry)?.requestId).toBe("r1");
  });

  it("clears active when all contexts removed", () => {
    const registry = createStreamRequestRegistry();
    upsertStreamRequestContext(registry, {
      requestId: "r1",
      messageId: "m1",
      conversationId: null,
      accumulated: "",
      isNewConversation: false,
      firstUserMessage: "",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      titleTriggered: false,
    });

    setActiveStreamRequest(registry, "r1");
    removeStreamRequestContext(registry, "r1");

    expect(getActiveStreamRequestContext(registry)).toBeUndefined();
    expect(hasActiveStreamRequests(registry)).toBe(false);
  });

  it("finds latest request by conversation", () => {
    const registry = createStreamRequestRegistry();

    upsertStreamRequestContext(registry, {
      requestId: "r1",
      messageId: "m1",
      conversationId: "c1",
      accumulated: "",
      isNewConversation: false,
      firstUserMessage: "",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      titleTriggered: false,
    });
    upsertStreamRequestContext(registry, {
      requestId: "r2",
      messageId: "m2",
      conversationId: "c2",
      accumulated: "",
      isNewConversation: false,
      firstUserMessage: "",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      titleTriggered: false,
    });
    upsertStreamRequestContext(registry, {
      requestId: "r3",
      messageId: "m3",
      conversationId: "c1",
      accumulated: "",
      isNewConversation: false,
      firstUserMessage: "",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      titleTriggered: false,
    });

    expect(getLatestStreamRequestContextForConversation(registry, "c1")?.requestId).toBe("r3");
    expect(getLatestStreamRequestContextForConversation(registry, "c2")?.requestId).toBe("r2");
    expect(getLatestStreamRequestContextForConversation(registry, "missing")).toBeUndefined();
  });
});
