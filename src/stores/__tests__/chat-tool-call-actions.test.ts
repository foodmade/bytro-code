import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function resetChatStore() {
  useChatStore.setState({
    messages: [],
    hasMoreMessages: false,
    totalMessageCount: 0,
    _dbTotal: 0,
    isLoadingOlder: false,
    _snapshots: {},
    _messageIndex: new Map(),
  });
}

function taskMessage(id: string): ChatMessage {
  return {
    id,
    role: "claude",
    content: "",
    timestamp: 123,
    toolCalls: [
      {
        id: "toolu_task",
        toolName: "Task",
        toolInput: "{\"description\":\"review\"}",
        status: "success",
        result: "Task started asynchronously",
      },
    ],
  };
}

describe("chat tool call actions", () => {
  beforeEach(() => {
    resetChatStore();
  });

  it("updates a live Task tool call by tool use id", () => {
    const message = taskMessage("m-live");
    useChatStore.setState({
      messages: [message],
      _messageIndex: new Map([[message.id, null]]),
    });

    useChatStore.getState().updateToolCallResultById(
      "toolu_task",
      "Final subagent result",
      true,
      undefined,
      { status: "success", severity: "info" },
    );

    expect(useChatStore.getState().messages[0]?.toolCalls?.[0]).toMatchObject({
      id: "toolu_task",
      status: "success",
      result: "Final subagent result",
      display: { status: "success", severity: "info" },
    });
  });

  it("updates a cached Task tool call by tool use id", () => {
    const message = taskMessage("m-cached");
    useChatStore.setState({
      _snapshots: {
        "conv-cached": {
          messages: [message],
          hasMoreMessages: false,
          totalMessageCount: 1,
          dbTotal: 0,
          isLoadingOlder: false,
          isStreaming: true,
          streamingMessageId: message.id,
          streamingConversationId: "conv-cached",
          streamStartTime: 123,
          streamPhase: "waiting",
        },
      },
      _messageIndex: new Map([[message.id, "conv-cached"]]),
    });

    useChatStore.getState().updateToolCallResultById(
      "toolu_task",
      "Cached subagent result",
      true,
      undefined,
      { status: "success", severity: "info" },
    );

    expect(useChatStore.getState()._snapshots["conv-cached"]?.messages[0]?.toolCalls?.[0])
      .toMatchObject({
        id: "toolu_task",
        status: "success",
        result: "Cached subagent result",
        display: { status: "success", severity: "info" },
      });
  });
});
