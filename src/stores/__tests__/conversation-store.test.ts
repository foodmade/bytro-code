import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useConversationStore, type ConversationSummary } from "@/stores/conversation-store";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useSplitViewStore } from "@/stores/split-view-store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

function makeConversation(id: string, patch: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: id,
    updated_at: "2026-05-16T00:00:00Z",
    model: "claude-opus-4-7",
    message_count: 0,
    preview: "",
    session_id: null,
    workspace_id: "workspace-1",
    is_pinned: false,
    is_archived: false,
    parent_conversation_id: null,
    ...patch,
  };
}

function resetStore() {
  useConversationStore.setState({
    conversations: [],
    activeConversationId: null,
    openedTabIds: [],
    isLoading: false,
    _workspaceFilter: null,
  });
  mockInvoke.mockReset();
}

describe("useConversationStore archive", () => {
  beforeEach(() => {
    resetStore();
  });

  it("marks a conversation archived and switches away from the active tab", async () => {
    useConversationStore.setState({
      conversations: [makeConversation("a"), makeConversation("b"), makeConversation("c")],
      activeConversationId: "b",
      openedTabIds: ["a", "b", "c"],
    });
    mockInvoke.mockResolvedValue(undefined);

    await useConversationStore.getState().setConversationArchived("b", true);

    expect(mockInvoke).toHaveBeenCalledWith("set_conversation_archived", {
      conversationId: "b",
      archived: true,
    });
    expect(useConversationStore.getState().activeConversationId).toBe("c");
    expect(useConversationStore.getState().openedTabIds).toEqual(["a", "c"]);
    expect(useConversationStore.getState().conversations.find((c) => c.id === "b")?.is_archived).toBe(true);
  });

  it("unarchives without reopening a tab", async () => {
    useConversationStore.setState({
      conversations: [makeConversation("a", { is_archived: true })],
      activeConversationId: null,
      openedTabIds: [],
    });
    mockInvoke.mockResolvedValue(undefined);

    await useConversationStore.getState().setConversationArchived("a", false);

    expect(useConversationStore.getState().conversations[0].is_archived).toBe(false);
    expect(useConversationStore.getState().openedTabIds).toEqual([]);
    expect(useConversationStore.getState().activeConversationId).toBeNull();
  });

  it("loads active and archived conversations while initializing tabs from active conversations only", async () => {
    const active = makeConversation("active", { is_pinned: true });
    const archived = makeConversation("archived", { is_archived: true, is_pinned: true });
    mockInvoke
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([archived]);

    await useConversationStore.getState().loadConversations("workspace-1");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "list_conversations", {
      limit: 50,
      offset: 0,
      workspaceId: "workspace-1",
      archived: false,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "list_conversations", {
      limit: 50,
      offset: 0,
      workspaceId: "workspace-1",
      archived: true,
    });
    expect(useConversationStore.getState().conversations.map((c) => c.id)).toEqual(["active", "archived"]);
    expect(useConversationStore.getState().openedTabIds).toEqual(["active"]);
  });

  it("keeps an open tab whose conversation is missing from the refreshed list", async () => {
    // Repro: while a background new conversation finishes and triggers a
    // parameterless loadConversations(), another new conversation "B" was just
    // created (already in memory + opened as a tab) but the in-flight
    // list_conversations query ran before B's row existed, so the result omits
    // it. The refresh must NOT drop B's tab — it is running in the foreground.
    useConversationStore.setState({
      conversations: [makeConversation("A"), makeConversation("B")],
      activeConversationId: "B",
      openedTabIds: ["A", "B"],
      _workspaceFilter: "workspace-1",
    });
    mockInvoke
      .mockResolvedValueOnce([makeConversation("A")]) // active list: B not returned yet
      .mockResolvedValueOnce([]); // archived: none

    await useConversationStore.getState().loadConversations();

    const state = useConversationStore.getState();
    expect([...state.conversations.map((c) => c.id)].sort()).toEqual(["A", "B"]);
    expect(state.openedTabIds).toEqual(["A", "B"]);
    expect(state.activeConversationId).toBe("B");
  });

  it("loads a missing conversation through the summary command", async () => {
    const archived = makeConversation("archived", { is_archived: true });
    mockInvoke.mockResolvedValueOnce(archived);

    await useConversationStore.getState().ensureConversationLoaded("archived");

    expect(mockInvoke).toHaveBeenCalledWith("get_conversation_summary", {
      conversationId: "archived",
    });
    expect(useConversationStore.getState().conversations[0]).toEqual(archived);
  });

  it("updates a missing conversation model without dropping summary fields", async () => {
    const archived = makeConversation("archived", { is_archived: true, model: "old-model" });
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(archived);

    await useConversationStore.getState().updateConversationModel("archived", "new-model");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "update_conversation_model", {
      conversationId: "archived",
      model: "new-model",
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "get_conversation_summary", {
      conversationId: "archived",
    });
    expect(useConversationStore.getState().conversations[0]).toEqual({
      ...archived,
      model: "new-model",
    });
  });
});

describe("useConversationStore deleteConversation ghost cleanup", () => {
  function userMessage(id: string): ChatMessage {
    return { id, role: "user", content: "hi", timestamp: 123 };
  }

  beforeEach(() => {
    resetStore();
    useSplitViewStore.getState().resetToSingle(null);
    useChatStore.setState({
      messages: [],
      _snapshots: {},
      _messageIndex: new Map(),
    });
  });

  it("purges snapshot, live messages and pane binding of the deleted conversation", async () => {
    // Regression: a deleted conversation that stayed bound to a pane (and kept
    // its snapshot) let the next send reuse an id with no DB row — the stream
    // ran but nothing persisted and the conversation vanished from all lists
    // while the running badge stayed on (ghost conversation).
    useConversationStore.setState({
      conversations: [makeConversation("ghost"), makeConversation("other")],
      activeConversationId: "ghost",
      openedTabIds: ["ghost", "other"],
    });
    useSplitViewStore.getState().resetToSingle("ghost");
    useChatStore.setState({ messages: [userMessage("m1")] });
    useChatStore.getState().saveSnapshot("ghost");
    expect(useChatStore.getState()._snapshots["ghost"]).toBeTruthy();
    mockInvoke.mockResolvedValue(undefined);

    await useConversationStore.getState().deleteConversation("ghost");

    expect(mockInvoke).toHaveBeenCalledWith("delete_conversation", { conversationId: "ghost" });
    expect(useChatStore.getState()._snapshots["ghost"]).toBeUndefined();
    // Deleted conversation was active — its live transcript must not linger.
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useSplitViewStore.getState().panes.some((pane) => pane.conversationId === "ghost")).toBe(false);
  });

  it("keeps the active transcript when deleting a background conversation", async () => {
    useConversationStore.setState({
      conversations: [makeConversation("bg"), makeConversation("active")],
      activeConversationId: "active",
      openedTabIds: ["bg", "active"],
    });
    useSplitViewStore.getState().resetToSingle("active");
    useChatStore.setState({ messages: [userMessage("m1")] });
    useChatStore.getState().saveSnapshot("bg");
    mockInvoke.mockResolvedValue(undefined);

    await useConversationStore.getState().deleteConversation("bg");

    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState()._snapshots["bg"]).toBeUndefined();
    expect(useSplitViewStore.getState().panes.some((pane) => pane.conversationId === "active")).toBe(true);
  });
});
