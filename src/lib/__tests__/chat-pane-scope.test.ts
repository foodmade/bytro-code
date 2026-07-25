import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveChatPaneScope } from "@/lib/chat-pane-scope";
import { useConversationStore } from "@/stores/conversation-store";

function resetConversationScope() {
  useConversationStore.setState({ activeConversationId: null });
}

describe("resolveChatPaneScope", () => {
  beforeEach(() => {
    resetConversationScope();
  });

  afterEach(() => {
    resetConversationScope();
  });

  it("falls back to the global active conversation outside split panes", () => {
    useConversationStore.setState({ activeConversationId: "conv-global" });

    expect(resolveChatPaneScope({ conversationId: null })).toEqual({
      paneId: null,
      conversationId: "conv-global",
      isPaneScoped: false,
    });
  });

  it("keeps a draft pane scoped to null conversation", () => {
    useConversationStore.setState({ activeConversationId: "conv-global" });

    expect(resolveChatPaneScope({ paneId: "right", conversationId: null })).toEqual({
      paneId: "right",
      conversationId: null,
      isPaneScoped: true,
    });
  });

  it("uses the pane conversation when a split pane is already bound", () => {
    expect(resolveChatPaneScope({ paneId: "left", conversationId: "conv-pane" })).toEqual({
      paneId: "left",
      conversationId: "conv-pane",
      isPaneScoped: true,
    });
  });
});
