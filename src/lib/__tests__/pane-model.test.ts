import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaneModel } from "@/lib/pane-model";
import { useConversationStore } from "@/stores/conversation-store";
import { useSettingsStore } from "@/stores/settings-store";
import { SOLO_PANE_ID, useSplitViewStore } from "@/stores/split-view-store";

const BASE_CONVERSATION = {
  id: "conv-1",
  title: "test",
  updated_at: "2026-04-01T00:00:00Z",
  message_count: 0,
  preview: "",
  session_id: null,
  workspace_id: null,
  is_pinned: false,
  is_archived: false,
  parent_conversation_id: null,
};

function resetStores() {
  useConversationStore.setState({ conversations: [], activeConversationId: null });
  useSplitViewStore.getState().resetToSingle(null);
}

describe("resolvePaneModel", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("prefers a bound conversation over stale draft state", () => {
    useConversationStore.setState({
      conversations: [{ ...BASE_CONVERSATION, model: "claude:claude-opus-4-6" }],
    });
    useSplitViewStore.getState().setDraftPaneModel(SOLO_PANE_ID, "official:gpt-5.4");

    expect(resolvePaneModel({ paneId: SOLO_PANE_ID, conversationId: "conv-1" })).toEqual({
      model: "claude:claude-opus-4-6",
      platformId: "claude",
      modelId: "claude-opus-4-6",
      requiresLocalSelection: false,
    });
  });

  it("normalizes a retired model only when its local provider is explicit", () => {
    useConversationStore.setState({
      conversations: [
        { ...BASE_CONVERSATION, id: "conv-old", model: "codex:gpt-5.2-codex" },
      ],
    });

    const resolved = resolvePaneModel({ conversationId: "conv-old" });

    expect(resolved.platformId).toBe("codex");
    expect(resolved.modelId).toBe("gpt-5.6-sol");
    expect(resolved.requiresLocalSelection).toBe(false);
  });

  it("downgrades a retired hosted model id but still requires local selection", () => {
    useConversationStore.setState({
      conversations: [
        { ...BASE_CONVERSATION, id: "conv-hosted", model: "official:openai/gpt-5.1" },
      ],
    });

    const resolved = resolvePaneModel({ conversationId: "conv-hosted" });

    expect(resolved.modelId).toBe("gpt-5.6-sol");
    expect(resolved.platformId).toBeNull();
    expect(resolved.requiresLocalSelection).toBe(true);
  });

  it("treats a legacy bare model id as ambiguous", () => {
    useConversationStore.setState({
      conversations: [{ ...BASE_CONVERSATION, id: "conv-bare", model: "gpt-5.4" }],
    });

    const resolved = resolvePaneModel({ conversationId: "conv-bare" });

    expect(resolved.platformId).toBeNull();
    expect(resolved.modelId).toBe("gpt-5.4");
    expect(resolved.requiresLocalSelection).toBe(true);
  });

  it("keeps a hosted draft blocked until a local model is selected", () => {
    useSplitViewStore.getState().setDraftPaneModel(SOLO_PANE_ID, "official:gpt-5.4");

    const resolved = resolvePaneModel({ paneId: SOLO_PANE_ID });

    expect(resolved.platformId).toBeNull();
    expect(resolved.requiresLocalSelection).toBe(true);
  });

  it("falls back to the configured global local model", () => {
    useSettingsStore.setState({ activePlatformId: "claude" });

    const resolved = resolvePaneModel({});

    expect(resolved.platformId).toBe("claude");
    expect(resolved.model.startsWith("claude:")).toBe(true);
    expect(resolved.requiresLocalSelection).toBe(false);
  });

  it("uses draft state when a requested conversation no longer exists", () => {
    useSplitViewStore
      .getState()
      .setDraftPaneModel(SOLO_PANE_ID, "claude:claude-opus-4-7");

    const resolved = resolvePaneModel({
      paneId: SOLO_PANE_ID,
      conversationId: "conv-missing",
    });

    expect(resolved.platformId).toBe("claude");
    expect(resolved.modelId).toBe("claude-opus-4-7");
  });
});
