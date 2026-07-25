import { describe, it, expect } from "vitest";
import {
  buildStreamInvokePayload,
  buildStreamSendContext,
} from "../chat-stream-send";

describe("buildStreamSendContext", () => {
  it("builds user/assistant/request context for new conversation", () => {
    const idSequence = ["u1", "a1", "r1"];
    const generateId = () => {
      const next = idSequence.shift();
      if (!next) {
        throw new Error("Missing test id");
      }
      return next;
    };

    const built = buildStreamSendContext(
      {
        content: "hello",
        images: [{ mediaType: "image/png", base64: "Zm9v" }],
        conversationId: "c1",
        isNewConversation: true,
        agentType: "claude",
        modelLabel: "Claude Opus",
      },
      {
        generateId,
        now: () => 123,
      },
    );

    expect(built.userMessage).toEqual({
      id: "u1",
      role: "user",
      content: "hello",
      timestamp: 123,
      media: [{ mediaType: "image/png", data: "Zm9v" }],
    });
    expect(built.assistantMessage).toEqual({
      id: "a1",
      role: "claude",
      content: "",
      agent: "Claude Opus",
      timestamp: 123,
    });
    expect(built.requestContext).toMatchObject({
      requestId: "r1",
      messageId: "a1",
      conversationId: "c1",
      platformId: undefined,
      sdk: "claude",
      modelLabel: "Claude Opus",
      accumulated: "",
      thinkingBlocks: [],
      thinkingPhaseActive: false,
      isNewConversation: true,
      firstUserMessage: "hello",
      titleTriggered: false,
    });
    expect(built.requestContext.startedAt).toEqual(expect.any(Number));
  });

  it("always populates firstUserMessage regardless of isNewConversation", () => {
    const idSequence = ["u2", "a2", "r2"];
    const built = buildStreamSendContext(
      {
        content: "follow up",
        conversationId: "c2",
        isNewConversation: false,
        agentType: "codex",
        modelLabel: "GPT-5.3 Codex",
      },
      {
        generateId: () => {
          const next = idSequence.shift();
          if (!next) {
            throw new Error("Missing test id");
          }
          return next;
        },
        now: () => 456,
      },
    );

    expect(built.requestContext.firstUserMessage).toBe("follow up");
    expect(built.requestContext.modelLabel).toBe("GPT-5.3 Codex");
    expect(built.userMessage.media).toBeUndefined();
  });

  it("marks user messages submitted as goals", () => {
    const idSequence = ["u3", "a3", "r3"];
    const built = buildStreamSendContext(
      {
        content: "ship the goal flow",
        conversationId: "c3",
        isNewConversation: false,
        agentType: "codex",
        modelLabel: "GPT-5.5",
        sentAsGoal: true,
      },
      {
        generateId: () => {
          const next = idSequence.shift();
          if (!next) {
            throw new Error("Missing test id");
          }
          return next;
        },
        now: () => 789,
      },
    );

    expect(built.userMessage.sentAsGoal).toBe(true);
  });
});

describe("buildStreamInvokePayload", () => {
  it("builds invoke payload with normalized optionals", () => {
    const payload = buildStreamInvokePayload({
      requestId: "r1",
      agentType: "gemini",
      messages: [{ role: "user", content: "hello" }],
      model: "",
      apiKey: "k",
      baseUrl: "https://g",
      systemPrompt: "",
      permissionMode: "default",
      sessionId: null,
      images: [{ mediaType: "image/jpeg", base64: "abc" }],
      proxyUrl: undefined,
      cwd: "C:/repo",
      platform: "gemini",
    });

    expect(payload).toEqual({
      requestId: "r1",
      agent: "gemini",
      messages: [{ role: "user", content: "hello" }],
      model: undefined,
      apiKey: "k",
      baseUrl: "https://g",
      system: undefined,
      permissionMode: "default",
      sessionId: null,
      images: [{ media_type: "image/jpeg", data: "abc" }],
      proxyUrl: undefined,
      cwd: "C:/repo",
      platform: "gemini",
    });
  });

  it("keeps OAuth credentials out of the WebView invoke payload", () => {
    const payload = buildStreamInvokePayload({
      requestId: "oauth-r1",
      agentType: "claude",
      messages: [{ role: "user", content: "hello" }],
      model: "claude-opus-4-7",
      apiKey: "ACCESS_TOKEN_SENTINEL",
      authMode: "oauth",
      profileId: "profile-1",
      oauthProvider: "claude",
      systemPrompt: "",
      permissionMode: "default",
      sessionId: null,
    });

    expect(payload.apiKey).toBeUndefined();
    expect(payload).toMatchObject({
      authMode: "oauth",
      profileId: "profile-1",
      oauthProvider: "claude",
    });
    expect(JSON.stringify(payload)).not.toContain("ACCESS_TOKEN_SENTINEL");
  });

});
