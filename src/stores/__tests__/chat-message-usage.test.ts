import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { dbMessageToChatMessage } from "@/stores/chat-actions";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

describe("chat message turn usage", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useChatStore.setState({
      messages: [],
      hasMoreMessages: false,
      totalMessageCount: 0,
      _dbTotal: 0,
      isLoadingOlder: false,
      _snapshots: {},
      _messageIndex: new Map(),
    });
  });

  it("restores per-turn usage from DB message rows", () => {
    const message = dbMessageToChatMessage({
      id: "m1",
      conversation_id: "c1",
      role: "codex",
      content: "done",
      tool_calls: null,
      agent: "GPT-5.5",
      created_at: "2026-06-16T00:00:00.000Z",
      turn_input_tokens: 120,
      turn_output_tokens: 35,
      turn_cache_read_tokens: 40,
      turn_cache_creation_tokens: 5,
      turn_total_tokens: 200,
      turn_duration_ms: 3210,
    });

    expect(message.turnUsage).toEqual({
      inputTokens: 120,
      outputTokens: 35,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      totalTokens: 200,
      durationMs: 3210,
    });
  });

  it("persists per-turn usage with assistant messages", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const message: ChatMessage = {
      id: "m2",
      role: "claude",
      content: "finished",
      agent: "Claude Opus",
      timestamp: 123,
      turnUsage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        totalTokens: 100,
        durationMs: 2500,
      },
    };

    await useChatStore.getState().persistMessage("c2", message);

    expect(mockInvoke).toHaveBeenCalledWith("save_message", {
      conversationId: "c2",
      id: "m2",
      role: "claude",
      content: "finished",
      agent: "Claude Opus",
      toolCalls: null,
      turnUsage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_creation_tokens: 40,
        total_tokens: 100,
        duration_ms: 2500,
      },
    });
  });
});
