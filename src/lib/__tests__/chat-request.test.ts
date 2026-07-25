import { describe, it, expect } from "vitest";
import { buildApiMessages, buildProviderTransportArgs } from "../chat-request";
import type { ChatMessage } from "@/stores/chat-store";

describe("buildApiMessages", () => {
  it("maps user/assistant history and appends latest user message", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "user", content: "hello", timestamp: 1 },
      { id: "2", role: "claude", content: "hi", timestamp: 2 },
      { id: "3", role: "system", content: "ignored", timestamp: 3 },
      { id: "4", role: "codex", content: "", timestamp: 4 },
      { id: "5", role: "gemini", content: "ok", timestamp: 5 },
    ];

    const result = buildApiMessages(messages, "latest");

    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "latest" },
    ]);
  });
});

describe("buildProviderTransportArgs", () => {
  it("returns unified baseUrl and apiKey for all SDK types", () => {
    const claude = buildProviderTransportArgs("claude", {
      baseUrl: "https://api.anthropic.com",
      apiKey: "claude-key",
    });
    expect(claude).toEqual({
      baseUrl: "https://api.anthropic.com",
      apiKey: "claude-key",
    });

    const codex = buildProviderTransportArgs("codex", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
    });
    expect(codex).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
    });

    const gemini = buildProviderTransportArgs("gemini", {
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "gemini-key",
    });
    expect(gemini).toEqual({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "gemini-key",
    });
  });

  it("drops empty values", () => {
    const args = buildProviderTransportArgs("claude", {
      baseUrl: "",
      apiKey: "   ",
    });

    expect(args).toEqual({
      baseUrl: undefined,
      apiKey: undefined,
    });
  });
});
