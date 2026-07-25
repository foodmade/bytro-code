import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SOLO_PANE_ID,
  mergePersistedSplitView,
  useSplitViewStore,
} from "@/stores/split-view-store";
import { bindConversationToPreferredSessionPane } from "@/lib/session-pane-target";

function resetSplitViewStore() {
  useSplitViewStore.getState().resetToSingle(null);
}

function getPaneIdByConversation(conversationId: string): string {
  const pane = useSplitViewStore.getState().panes.find((item) => item.conversationId === conversationId);
  expect(pane).toBeTruthy();
  return pane!.id;
}

describe("useSplitViewStore", () => {
  beforeEach(() => {
    resetSplitViewStore();
  });

  afterEach(() => {
    resetSplitViewStore();
  });

  it("keeps a draft pane alive when focus moves to another pane", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-left");
    const draftPaneId = store.placeDraftPane("right", "conv-left");
    const conversationPaneId = getPaneIdByConversation("conv-left");

    expect(draftPaneId).toBeTruthy();

    store.focusPane(conversationPaneId);
    store.cleanupClosedConversations(["conv-left"], "conv-left");

    const state = useSplitViewStore.getState();
    expect(state.layout).toBe("horizontal");
    expect(state.panes).toHaveLength(2);
    expect(state.draftPaneIds).toEqual([draftPaneId]);
    expect(state.activePaneId).toBe(conversationPaneId);
  });

  it("binds a draft pane to the created conversation and clears draft model state", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-left");
    const draftPaneId = store.placeDraftPane("right", "conv-left");

    expect(draftPaneId).toBeTruthy();

    store.setDraftPaneModel(draftPaneId!, "official:gpt-5.4");
    store.bindDraftPaneToConversation(draftPaneId!, "conv-new");

    const state = useSplitViewStore.getState();
    expect(state.panes.find((pane) => pane.id === draftPaneId)?.conversationId).toBe("conv-new");
    expect(state.draftPaneIds).toEqual([]);
    expect(state.draftPaneModels).toEqual({});
  });

  it("splits panes recursively instead of upgrading straight to a four-slot grid", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");

    const paneB = store.dropConversation("conv-b", "right", "conv-a");
    const paneC = store.dropConversation("conv-c", "bottom", null, paneB);

    const state = useSplitViewStore.getState();
    expect(paneB).toBeTruthy();
    expect(paneC).toBeTruthy();
    expect(state.layout).toBe("nested");
    expect(state.panes).toHaveLength(3);
    expect(state.panes.map((pane) => pane.conversationId)).toEqual(["conv-a", "conv-b", "conv-c"]);
    expect(state.activePaneId).toBe(paneC);
  });

  it("supports a vertical split from a single pane", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");

    const paneB = store.dropConversation("conv-b", "bottom", "conv-a");
    const state = useSplitViewStore.getState();

    expect(paneB).toBeTruthy();
    expect(state.layout).toBe("vertical");
    expect(state.root.kind).toBe("branch");
    if (state.root.kind === "branch") {
      expect(state.root.direction).toBe("vertical");
    }
    expect(state.panes.map((pane) => pane.conversationId)).toEqual(["conv-a", "conv-b"]);
    expect(state.activePaneId).toBe(paneB);
  });

  it("keeps the nested branch vertical when splitting an existing side pane downward", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const paneB = store.dropConversation("conv-b", "right", "conv-a");
    const paneC = store.dropConversation("conv-c", "bottom", null, paneB);
    const state = useSplitViewStore.getState();

    expect(paneC).toBeTruthy();
    expect(state.layout).toBe("nested");
    expect(state.root.kind).toBe("branch");
    if (state.root.kind === "branch") {
      expect(state.root.direction).toBe("horizontal");
      expect(state.root.second.kind).toBe("branch");
      if (state.root.second.kind === "branch") {
        expect(state.root.second.direction).toBe("vertical");
      }
    }
  });

  it("can keep splitting from an existing draft pane without losing the earlier draft", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const firstDraftPaneId = store.placeDraftPane("right", "conv-a");
    const secondDraftPaneId = store.placeDraftPane("bottom", null, firstDraftPaneId);

    const state = useSplitViewStore.getState();
    expect(firstDraftPaneId).toBeTruthy();
    expect(secondDraftPaneId).toBeTruthy();
    expect(state.layout).toBe("nested");
    expect(state.panes).toHaveLength(3);
    expect(state.panes.filter((pane) => pane.conversationId === null)).toHaveLength(2);
    expect(state.draftPaneIds).toEqual([firstDraftPaneId, secondDraftPaneId]);
    expect(state.activePaneId).toBe(secondDraftPaneId);
  });

  it("replaces a draft pane in place when dropping on center", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-left");
    const draftPaneId = store.placeDraftPane("right", "conv-left");

    const replacedPaneId = store.dropConversation("conv-next", "center", null, draftPaneId);

    const state = useSplitViewStore.getState();
    expect(replacedPaneId).toBe(draftPaneId);
    expect(state.layout).toBe("horizontal");
    expect(state.panes.find((pane) => pane.id === draftPaneId)?.conversationId).toBe("conv-next");
    expect(state.draftPaneIds).toEqual([]);
    expect(state.activePaneId).toBe(draftPaneId);
  });

  it("swaps pane draft state and draft model together with pane contents", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-left");
    const draftPaneId = store.placeDraftPane("right", "conv-left");
    const conversationPaneId = getPaneIdByConversation("conv-left");

    store.setDraftPaneModel(draftPaneId!, "official:gpt-5.4");
    store.swapPaneContents(conversationPaneId, draftPaneId!);

    const state = useSplitViewStore.getState();
    expect(state.draftPaneIds).toEqual([conversationPaneId]);
    expect(state.draftPaneModels).toEqual({
      [conversationPaneId]: { model: "official:gpt-5.4" },
    });
    expect(state.panes.find((pane) => pane.id === draftPaneId)?.conversationId).toBe("conv-left");
  });

  it("moves an existing pane into another pane split zone instead of replacing it", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const paneB = store.dropConversation("conv-b", "right", "conv-a");

    const movedPaneId = store.movePaneToZone(getPaneIdByConversation("conv-a"), paneB!, "bottom", "conv-b");
    const state = useSplitViewStore.getState();

    expect(movedPaneId).toBeTruthy();
    expect(state.layout).toBe("vertical");
    expect(state.panes).toHaveLength(2);
    expect(state.panes.map((pane) => pane.conversationId)).toEqual(["conv-b", "conv-a"]);
    expect(state.activePaneId).toBe(movedPaneId);
  });

  it("collapses the tree when removing a draft pane", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-left");
    const draftPaneId = store.placeDraftPane("right", "conv-left");

    const next = store.removePane(draftPaneId!, "conv-left");

    const state = useSplitViewStore.getState();
    expect(state.layout).toBe("single");
    expect(state.panes).toMatchObject([
      { id: "single", content: { type: "chat", conversationId: "conv-left" }, conversationId: "conv-left" },
    ]);
    expect(state.draftPaneIds).toEqual([]);
    expect(state.draftPaneModels).toEqual({});
    expect(next).toEqual({ paneId: "single", conversationId: "conv-left" });
  });

  it("removes a nested pane and folds the parent branch back into a two-pane split", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const paneB = store.dropConversation("conv-b", "right", "conv-a");
    store.dropConversation("conv-c", "bottom", null, paneB);

    const next = store.removePane(paneB!, "conv-a");
    const state = useSplitViewStore.getState();

    expect(state.layout).toBe("horizontal");
    expect(state.panes).toHaveLength(2);
    expect(state.panes.map((pane) => pane.conversationId)).toEqual(["conv-a", "conv-c"]);
    expect(next.conversationId).toBe("conv-c");
  });

  it("clears SOLO draft model when entering solo mode for a bound conversation", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    // Simulate a stale SOLO draft entry left over from a previous flow.
    store.enterSoloMode(null);
    store.setDraftPaneModel(SOLO_PANE_ID, "official:gpt-5.4");
    expect(useSplitViewStore.getState().draftPaneModels[SOLO_PANE_ID]).toBeTruthy();

    store.enterSoloMode("conv-b");

    const state = useSplitViewStore.getState();
    expect(state.soloMode?.conversationId).toBe("conv-b");
    expect(state.draftPaneIds).not.toContain(SOLO_PANE_ID);
    expect(state.draftPaneModels[SOLO_PANE_ID]).toBeUndefined();
  });

  it("preserves SOLO draft model when entering solo mode for a fresh draft", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");

    store.enterSoloMode(null);
    store.setDraftPaneModel(SOLO_PANE_ID, "claude:opus-4-7");

    const state = useSplitViewStore.getState();
    expect(state.soloMode?.conversationId).toBeNull();
    expect(state.draftPaneModels[SOLO_PANE_ID]).toEqual({ model: "claude:opus-4-7" });
  });

  it("clears SOLO draft model when setSoloConversationId binds to a conversation", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    store.enterSoloMode(null);
    store.setDraftPaneModel(SOLO_PANE_ID, "official:gpt-5.4");
    expect(useSplitViewStore.getState().draftPaneModels[SOLO_PANE_ID]).toBeTruthy();

    store.setSoloConversationId("conv-b");

    const state = useSplitViewStore.getState();
    expect(state.soloMode?.conversationId).toBe("conv-b");
    expect(state.draftPaneIds).not.toContain(SOLO_PANE_ID);
    expect(state.draftPaneModels[SOLO_PANE_ID]).toBeUndefined();
  });

  it("dropConversation in solo mode promotes the solo conversation and creates a real split", () => {
    // Regression: previously dropConversation aborted on SOLO_PANE_ID, leaving
    // users stranded in solo mode with no way to split-via-drag. New contract:
    // a drop while in solo discards the (stale) background tree, treats the
    // currently visible solo conversation as the new root, and splits from
    // there — what the user sees becomes one half, the dropped conversation
    // becomes the other.
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    store.enterSoloMode("conv-solo");
    expect(useSplitViewStore.getState().soloMode?.conversationId).toBe("conv-solo");

    const newPaneId = store.dropConversation("conv-dragged", "right", null, SOLO_PANE_ID);

    const state = useSplitViewStore.getState();
    expect(newPaneId).toBeTruthy();
    expect(state.soloMode).toBeNull();
    expect(state.layout).toBe("horizontal");
    expect(state.panes.map((pane) => pane.conversationId).sort()).toEqual(["conv-dragged", "conv-solo"]);
    expect(state.activePaneId).toBe(newPaneId);
  });

  it("placeDraftPane in solo mode promotes solo and adds the draft as a real second pane", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    store.enterSoloMode("conv-solo");

    const newPaneId = store.placeDraftPane("right", null, SOLO_PANE_ID);

    const state = useSplitViewStore.getState();
    expect(newPaneId).toBeTruthy();
    expect(state.soloMode).toBeNull();
    expect(state.layout).toBe("horizontal");
    // One pane keeps the previously-solo conversation; the other is the new draft (no conversation yet).
    const paneConvIds = state.panes.map((pane) => pane.conversationId);
    expect(paneConvIds).toContain("conv-solo");
    expect(paneConvIds).toContain(null);
    expect(state.draftPaneIds).toContain(newPaneId);
  });

  it("clears draft model on the target pane when syncActiveConversation binds a conversation", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized(null);
    const draftPaneId = useSplitViewStore.getState().panes[0]!.id;
    store.setDraftPaneModel(draftPaneId, "official:gpt-5.4");
    expect(useSplitViewStore.getState().draftPaneModels[draftPaneId]).toBeTruthy();

    store.syncActiveConversation("conv-new");

    const state = useSplitViewStore.getState();
    expect(state.panes.find((pane) => pane.id === draftPaneId)?.conversationId).toBe("conv-new");
    expect(state.draftPaneIds).not.toContain(draftPaneId);
    expect(state.draftPaneModels[draftPaneId]).toBeUndefined();
  });

  it("opens a file to the left of an occupied chat pane", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");

    const paneId = store.openContent({ type: "file", path: "/tmp/demo.ts" }, "conv-a");

    const state = useSplitViewStore.getState();
    expect(paneId).toBeTruthy();
    expect(state.layout).toBe("horizontal");
    expect(state.panes.map((pane) => pane.content)).toEqual([
      { type: "file", path: "/tmp/demo.ts" },
      { type: "chat", conversationId: "conv-a" },
    ]);
    expect(state.root.kind).toBe("branch");
    if (state.root.kind === "branch") {
      expect(state.root.ratio).toBe(0.62);
    }
    expect(state.activePaneId).toBe(paneId);
  });

  it("reuses the existing editor pane when opening another file from chat", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const firstPaneId = store.openContent({ type: "file", path: "/tmp/one.ts" }, "conv-a");
    store.focusPane(getPaneIdByConversation("conv-a"));

    const secondPaneId = store.openContent({ type: "file", path: "/tmp/two.ts" }, "conv-a");

    const state = useSplitViewStore.getState();
    expect(secondPaneId).toBe(firstPaneId);
    expect(state.panes).toHaveLength(2);
    expect(state.panes.find((pane) => pane.id === firstPaneId)?.content).toEqual({ type: "file", path: "/tmp/two.ts" });
  });

  it("drops diff content into a split pane", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const diff = { filePath: "/tmp/demo.ts", original: "old", modified: "new", canWriteBack: true };

    const paneId = store.dropContent({ type: "diff", path: diff.filePath, diff }, "right", "conv-a");

    const state = useSplitViewStore.getState();
    expect(paneId).toBeTruthy();
    expect(state.layout).toBe("horizontal");
    expect(state.panes.find((pane) => pane.id === paneId)?.content).toEqual({ type: "diff", path: diff.filePath, diff });
  });

  it("does not replace an active file pane when syncing a conversation", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const filePaneId = store.openContent({ type: "file", path: "/tmp/demo.ts" }, "conv-a");

    store.syncActiveConversation("conv-b");

    const state = useSplitViewStore.getState();
    expect(state.panes.find((pane) => pane.id === filePaneId)?.content).toEqual({ type: "file", path: "/tmp/demo.ts" });
    expect(state.panes.find((pane) => pane.content.type === "chat" && pane.content.conversationId === "conv-b")).toBeTruthy();
  });

  it("binds a new conversation to the session pane when the active pane is a file", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const filePaneId = store.openContent({ type: "file", path: "/tmp/demo.ts" }, "conv-a");
    const sessionPaneId = useSplitViewStore
      .getState()
      .panes.find((pane) => pane.conversationId === "conv-a")?.id;

    expect(filePaneId).toBeTruthy();
    expect(sessionPaneId).toBeTruthy();
    expect(useSplitViewStore.getState().activePaneId).toBe(filePaneId);

    const targetPaneId = bindConversationToPreferredSessionPane("conv-new");

    const state = useSplitViewStore.getState();
    expect(targetPaneId).toBe(sessionPaneId);
    expect(state.activePaneId).toBe(sessionPaneId);
    expect(state.panes.find((pane) => pane.id === filePaneId)?.content).toEqual({
      type: "file",
      path: "/tmp/demo.ts",
    });
    expect(state.panes.find((pane) => pane.id === sessionPaneId)?.conversationId).toBe("conv-new");
  });

  it("exits solo mode when binding a new conversation to an existing session pane", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    store.openContent({ type: "file", path: "/tmp/demo.ts" }, "conv-a");
    const sessionPaneId = useSplitViewStore
      .getState()
      .panes.find((pane) => pane.conversationId === "conv-a")?.id;
    store.enterSoloMode("conv-solo");

    const targetPaneId = bindConversationToPreferredSessionPane("conv-new");

    const state = useSplitViewStore.getState();
    expect(targetPaneId).toBe(sessionPaneId);
    expect(state.soloMode).toBeNull();
    expect(state.activePaneId).toBe(sessionPaneId);
    expect(state.panes.find((pane) => pane.id === sessionPaneId)?.conversationId).toBe("conv-new");
  });

  it("normalizes an existing chat-left editor-right split", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const filePaneId = store.dropContent({ type: "file", path: "/tmp/demo.ts" }, "right", "conv-a");

    let state = useSplitViewStore.getState();
    expect(filePaneId).toBeTruthy();
    expect(state.panes.map((pane) => pane.content)).toEqual([
      { type: "chat", conversationId: "conv-a" },
      { type: "file", path: "/tmp/demo.ts" },
    ]);

    store.normalizeEditorPaneOrder();

    state = useSplitViewStore.getState();
    expect(state.panes.map((pane) => pane.content)).toEqual([
      { type: "file", path: "/tmp/demo.ts" },
      { type: "chat", conversationId: "conv-a" },
    ]);
  });

  it("clamps resized branch ratios", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    store.openContent({ type: "file", path: "/tmp/demo.ts" }, "conv-a");

    let state = useSplitViewStore.getState();
    expect(state.root.kind).toBe("branch");
    if (state.root.kind !== "branch") return;

    store.resizeBranch(state.root.id, 0.04);
    state = useSplitViewStore.getState();
    if (state.root.kind !== "branch") return;
    expect(state.root.ratio).toBe(0.18);

    store.resizeBranch(state.root.id, 0.96);
    state = useSplitViewStore.getState();
    if (state.root.kind !== "branch") return;
    expect(state.root.ratio).toBe(0.82);
  });

  it("keeps file tabs scoped to their editor pane group", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const filePaneId = store.openContent({ type: "file", path: "/tmp/one.ts" }, "conv-a");
    store.openContent({ type: "file", path: "/tmp/two.ts" }, "conv-a", filePaneId);

    let state = useSplitViewStore.getState();
    const filePane = state.panes.find((pane) => pane.id === filePaneId);
    expect(filePane?.group.items.map((item) => item.content)).toEqual([
      { type: "file", path: "/tmp/one.ts" },
      { type: "file", path: "/tmp/two.ts" },
    ]);
    expect(filePane?.content).toEqual({ type: "file", path: "/tmp/two.ts" });

    store.activatePaneItem(filePaneId!, "file:/tmp/one.ts");
    state = useSplitViewStore.getState();
    expect(state.panes.find((pane) => pane.id === filePaneId)?.content).toEqual({ type: "file", path: "/tmp/one.ts" });
  });

  it("closes a pane group item without replacing sibling panes", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const filePaneId = store.openContent({ type: "file", path: "/tmp/one.ts" }, "conv-a");
    store.openContent({ type: "file", path: "/tmp/two.ts" }, "conv-a", filePaneId);

    store.closePaneItem(filePaneId!, "file:/tmp/two.ts");

    const state = useSplitViewStore.getState();
    expect(state.panes.find((pane) => pane.id === filePaneId)?.content).toEqual({ type: "file", path: "/tmp/one.ts" });
    expect(state.panes.find((pane) => pane.content.type === "chat" && pane.content.conversationId === "conv-a")).toBeTruthy();
  });

  it("collapses the split when closing the last file item beside chat", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const filePaneId = store.openContent({ type: "file", path: "/tmp/one.ts" }, "conv-a");

    store.closePaneItem(filePaneId!, "file:/tmp/one.ts", "conv-a");

    const state = useSplitViewStore.getState();
    expect(state.layout).toBe("single");
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]).toMatchObject({ content: { type: "chat", conversationId: "conv-a" }, conversationId: "conv-a" });
    expect(state.activePaneId).toBe(state.panes[0]!.id);
  });

  it("normalizes stale empty editor panes back to a single chat pane", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const filePaneId = store.openContent({ type: "file", path: "/tmp/one.ts" }, "conv-a");
    store.setPaneContent(filePaneId!, { type: "empty" });

    store.normalizeEditorPaneOrder("conv-a");

    const state = useSplitViewStore.getState();
    expect(state.layout).toBe("single");
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.content).toEqual({ type: "chat", conversationId: "conv-a" });
  });

  it("cleans up historical non-draft empty panes during conversation cleanup", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const emptyPaneId = store.placeDraftPane("right", "conv-a");

    store.clearPaneDraft(emptyPaneId!);
    store.cleanupClosedConversations(["conv-a"], "conv-a");

    const state = useSplitViewStore.getState();
    expect(state.layout).toBe("single");
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.content).toEqual({ type: "chat", conversationId: "conv-a" });
    expect(state.draftPaneIds).toEqual([]);
  });

  it("purgeConversation removes the deleted conversation's pane and keeps siblings", () => {
    // cleanupClosedConversations callers whitelist current pane bindings, so a
    // deleted-but-still-bound conversation survives forever (ghost conversation).
    // purgeConversation must remove exactly that binding.
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    store.dropConversation("conv-ghost", "right", "conv-a");
    expect(useSplitViewStore.getState().panes).toHaveLength(2);

    store.purgeConversation("conv-ghost", "conv-a");

    const state = useSplitViewStore.getState();
    expect(state.layout).toBe("single");
    expect(state.panes.map((pane) => pane.conversationId)).toEqual(["conv-a"]);
  });

  it("purgeConversation falls back to an empty single pane when it was the only binding", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-ghost");

    store.purgeConversation("conv-ghost", null);

    const state = useSplitViewStore.getState();
    expect(state.layout).toBe("single");
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.conversationId).toBeNull();
  });

  it("purgeConversation clears a solo binding pointing at the deleted conversation", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    store.enterSoloMode("conv-ghost");
    expect(useSplitViewStore.getState().soloMode?.conversationId).toBe("conv-ghost");

    store.purgeConversation("conv-ghost", "conv-a");

    const state = useSplitViewStore.getState();
    expect(state.soloMode).toBeNull();
    expect(state.panes.map((pane) => pane.conversationId)).toContain("conv-a");
  });

  it("rebindPaneConversation swaps a stale binding in place without touching layout", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const paneB = store.dropConversation("conv-ghost", "right", "conv-a");

    store.rebindPaneConversation(paneB!, "conv-ghost", "conv-new");

    const state = useSplitViewStore.getState();
    expect(state.layout).toBe("horizontal");
    const pane = state.panes.find((item) => item.id === paneB);
    expect(pane?.conversationId).toBe("conv-new");
    expect(pane?.group.activeItemId).toBe("chat:conv-new");
    expect(pane?.group.items.some((item) => item.id === "chat:conv-ghost")).toBe(false);
  });

  it("rebindPaneConversation keeps sibling items in the same pane group", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-ghost");
    const paneId = useSplitViewStore.getState().panes[0]!.id;
    // A second chat item in the same group must survive the rebind.
    store.setPaneConversation(paneId, "conv-keep");
    store.setPaneConversation(paneId, "conv-ghost");

    store.rebindPaneConversation(paneId, "conv-ghost", "conv-new");

    const pane = useSplitViewStore.getState().panes.find((item) => item.id === paneId);
    expect(pane?.conversationId).toBe("conv-new");
    expect(pane?.group.items.map((item) => item.id)).toContain("chat:conv-keep");
    expect(pane?.group.items.map((item) => item.id)).not.toContain("chat:conv-ghost");
  });

  it("rebindPaneConversation is a no-op when the pane does not hold the stale conversation", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    const paneId = useSplitViewStore.getState().panes[0]!.id;

    store.rebindPaneConversation(paneId, "conv-ghost", "conv-new");

    const pane = useSplitViewStore.getState().panes.find((item) => item.id === paneId);
    expect(pane?.conversationId).toBe("conv-a");
    expect(pane?.group.items.map((item) => item.id)).toEqual(["chat:conv-a"]);
  });

  it("rebindPaneConversation updates a solo binding through the SOLO pane id", () => {
    const store = useSplitViewStore.getState();
    store.ensureInitialized("conv-a");
    store.enterSoloMode("conv-ghost");

    store.rebindPaneConversation(SOLO_PANE_ID, "conv-ghost", "conv-new");

    expect(useSplitViewStore.getState().soloMode?.conversationId).toBe("conv-new");
  });
});

describe("mergePersistedSplitView", () => {
  it("never restores soloMode from persistence (transient overlay only)", () => {
    // Old builds wrote soloMode to disk, which silently stranded users in solo
    // mode across restarts. The contract now: soloMode is purely transient and
    // always re-initializes to null after rehydrate, regardless of what's on
    // disk. SOLO_PANE_ID-keyed draft state is dropped along with it because
    // SOLO is no longer a valid pane id in the rehydrated tree.
    const persisted = {
      root: { kind: "leaf" as const, paneId: "single", conversationId: "conv-a" },
      draftPaneIds: [SOLO_PANE_ID],
      draftPaneModels: {
        [SOLO_PANE_ID]: { model: "official:gpt-5.4" },
      },
      activePaneId: SOLO_PANE_ID,
      soloMode: { conversationId: "conv-a" },
    };

    const merged = mergePersistedSplitView(persisted);
    expect(merged).not.toBeNull();
    expect(merged!.soloMode).toBeNull();
    expect(merged!.draftPaneIds).not.toContain(SOLO_PANE_ID);
    expect(merged!.draftPaneModels[SOLO_PANE_ID]).toBeUndefined();
    // activePaneId pointed at SOLO_PANE_ID on disk; merge must fall back to a
    // real pane in the rehydrated tree instead of preserving the stale SOLO id.
    expect(merged!.activePaneId).toBe("single");
  });

  it("drops a fresh SOLO draft (no conversation) the same way", () => {
    const persisted = {
      root: { kind: "leaf" as const, paneId: "single", conversationId: "conv-a" },
      draftPaneIds: [SOLO_PANE_ID],
      draftPaneModels: {
        [SOLO_PANE_ID]: { model: "claude:opus-4-7" },
      },
      activePaneId: SOLO_PANE_ID,
      soloMode: { conversationId: null },
    };

    const merged = mergePersistedSplitView(persisted);
    expect(merged).not.toBeNull();
    expect(merged!.soloMode).toBeNull();
    expect(merged!.draftPaneIds).not.toContain(SOLO_PANE_ID);
    expect(merged!.draftPaneModels[SOLO_PANE_ID]).toBeUndefined();
  });

  it("drops draft model entries for panes that are already bound to a conversation", () => {
    const persisted = {
      root: {
        kind: "branch" as const,
        id: "branch-1",
        direction: "horizontal" as const,
        first: { kind: "leaf" as const, paneId: "pane-a", conversationId: "conv-a" },
        second: { kind: "leaf" as const, paneId: "pane-b", conversationId: null },
      },
      draftPaneIds: ["pane-a", "pane-b"],
      draftPaneModels: {
        "pane-a": { model: "official:gpt-5.4" },
        "pane-b": { model: "claude:opus-4-7" },
      },
      activePaneId: "pane-b",
      soloMode: null,
    };

    const merged = mergePersistedSplitView(persisted);
    expect(merged).not.toBeNull();
    expect(merged!.draftPaneIds).toEqual(["pane-b"]);
    expect(merged!.draftPaneModels).toEqual({
      "pane-b": { model: "claude:opus-4-7" },
    });
  });

  it("fills a default ratio for old persisted branches", () => {
    const persisted = {
      root: {
        kind: "branch" as const,
        id: "branch-1",
        direction: "horizontal" as const,
        first: { kind: "leaf" as const, paneId: "pane-a", conversationId: "conv-a" },
        second: { kind: "leaf" as const, paneId: "pane-b", conversationId: "conv-b" },
      },
      draftPaneIds: [],
      draftPaneModels: {},
      activePaneId: "pane-a",
    };

    const merged = mergePersistedSplitView(persisted);
    expect(merged).not.toBeNull();
    expect(merged!.root.kind).toBe("branch");
    if (merged!.root.kind === "branch") {
      expect(merged!.root.ratio).toBe(0.5);
    }
  });

  it("returns null when the persisted payload is malformed", () => {
    expect(mergePersistedSplitView(null)).toBeNull();
    expect(mergePersistedSplitView({ root: { kind: "garbage" } })).toBeNull();
  });
});
