import { useCallback } from "react";
import { useChatStore, useConversationStore, useAppStore, useAgentStatusStore, useSettingsStore, useSplitViewStore, useToastStore } from "@/stores";
import type { SplitPane, SplitPaneId } from "@/stores";
import { useConversationStatus } from "./use-conversation-status";
import { resolvePaneModel, resolveStoredModel } from "@/lib/pane-model";

/** Restore the model selection for a conversation from its saved model field. */
function isChatPane(pane: SplitPane): boolean {
  return pane.group.items.some((item) => item.content.type === "chat") || pane.content.type === "chat";
}

function restoreConversationModel(conversationId: string): void {
  const splitState = useSplitViewStore.getState();
  // Model restoration only makes sense when the top-level chat view follows one conversation:
  // either the single-pane layout, or the solo overlay.
  if (splitState.layout !== "single" && !splitState.soloMode) {
    return;
  }
  const conversation = useConversationStore.getState().conversations.find((c) => c.id === conversationId);
  if (!conversation?.model) return;

  const { platformId, modelId, requiresLocalSelection } = resolveStoredModel(conversation.model);

  if (requiresLocalSelection || !platformId) {
    useToastStore.getState().addToast(
      "warning",
      "This conversation used a hosted model. Select a local model profile to continue.",
    );
    return;
  }

  const settings = useSettingsStore.getState();
  if (settings.activePlatformId !== platformId) {
    settings.setActivePlatform(platformId);
  }
  if (settings.platforms[platformId].activeModelId !== modelId) {
    settings.setActiveModel(platformId, modelId);
  }
}

export function useConversationSwitch() {
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const removeTab = useConversationStore((s) => s.removeTab);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const { isActiveConversationStreaming } = useConversationStatus();

  /** Save current conversation state before switching away. */
  const saveCurrentSnapshot = useCallback(() => {
    const currentConvId = useConversationStore.getState().activeConversationId;
    if (!currentConvId) return;
    const chatState = useChatStore.getState();
    useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
    if (isActiveConversationStreaming || chatState.messages.length > 0) {
      chatState.saveSnapshot(currentConvId);
    }
  }, [isActiveConversationStreaming]);

  const finalizeCreate = useCallback((paneId: SplitPaneId | null) => {
    useConversationStore.getState().setActiveConversationId(null);
    clearMessages();

    const splitState = useSplitViewStore.getState();

    const activePane = splitState.activePaneId ? splitState.panes.find((pane) => pane.id === splitState.activePaneId) : null;
    const fallbackChatPane = splitState.panes.find(isChatPane) ?? null;
    const targetPaneId = paneId ?? (activePane && isChatPane(activePane) ? activePane.id : fallbackChatPane?.id) ?? splitState.panes[0]?.id ?? null;
    if (targetPaneId) {
      const paneConversationId = splitState.panes.find((pane) => pane.id === targetPaneId)?.conversationId ?? null;
      const shouldUsePaneModel = paneConversationId !== null || splitState.draftPaneIds.includes(targetPaneId);
      const initialModel = resolvePaneModel({
        paneId: shouldUsePaneModel ? targetPaneId : undefined,
        conversationId: paneConversationId ?? useConversationStore.getState().activeConversationId,
      });
      splitState.markPaneDraft(targetPaneId);
      splitState.setDraftPaneModel(targetPaneId, initialModel.model);
      if (splitState.soloMode) {
        splitState.exitSoloMode(targetPaneId);
      } else {
        splitState.focusPane(targetPaneId);
      }
    }

    useAppStore.getState().switchToFileTab(null);
    const currentView = useAppStore.getState().activeView;
    if (currentView !== "chat") {
      useAppStore.getState().setActiveView("chat");
    }
  }, [clearMessages]);

  const handleSelect = useCallback(
    async (id: string) => {
      const currentConvId = useConversationStore.getState().activeConversationId;
      const splitState = useSplitViewStore.getState();
      const paneOwningConv = splitState.panes.find((pane) => pane.conversationId === id) ?? null;

      // Selecting a conversation that already lives in the split: exit overlay and focus its pane.
      if (paneOwningConv) {
        if (splitState.soloMode) {
          splitState.exitSoloMode(paneOwningConv.id);
        } else {
          splitState.focusPane(paneOwningConv.id);
        }
      } else if (splitState.layout !== "single") {
        // Non-split conversation while layout is split: keep the split in memory,
        // show the conversation in a solo overlay.
        if (splitState.soloMode) {
          splitState.setSoloConversationId(id);
        } else {
          splitState.enterSoloMode(id);
        }
      }

      if (id === currentConvId) {
        const currentView = useAppStore.getState().activeView;
        if (currentView !== "chat") {
          useAppStore.getState().setActiveView("chat");
        }
        return;
      }

      saveCurrentSnapshot();

      useAgentStatusStore.getState().resetLiveStatus({
        lastUsage: null,
        subagents: [],
        todos: [],
      });

      switchConversation(id);
      await loadMessages(id);
      restoreConversationModel(id);

      const currentView = useAppStore.getState().activeView;
      if (currentView === "workspace" || currentView === "welcome") {
        useAppStore.getState().setActiveView("chat");
      }
    },
    [switchConversation, loadMessages, saveCurrentSnapshot],
  );

  const handleCreate = useCallback(() => {
    saveCurrentSnapshot();
    finalizeCreate(null);
  }, [finalizeCreate, saveCurrentSnapshot]);

  const handleCreateInPane = useCallback((paneId: SplitPaneId) => {
    saveCurrentSnapshot();
    finalizeCreate(paneId);
  }, [finalizeCreate, saveCurrentSnapshot]);

  const handleDelete = useCallback(
    async (id: string) => {
      const wasActive = useConversationStore.getState().activeConversationId === id;
      const splitBefore = useSplitViewStore.getState();
      const wasSoloConv = splitBefore.soloMode?.conversationId === id;
      await deleteConversation(id);

      if (wasSoloConv) {
        const splitAfter = useSplitViewStore.getState();
        const firstOccupiedPane = splitAfter.panes.find((pane) => pane.conversationId) ?? null;
        if (firstOccupiedPane) {
          splitAfter.exitSoloMode(firstOccupiedPane.id);
        } else {
          splitAfter.setSoloConversationId(null);
        }
      }

      // deleteConversation already picks the next tab; load its messages
      if (wasActive) {
        const nextId = useConversationStore.getState().activeConversationId;
        if (nextId) {
          await loadMessages(nextId);
          restoreConversationModel(nextId);
        } else {
          clearMessages();
        }
      }
    },
    [deleteConversation, loadMessages, clearMessages],
  );

  /** Remove tab from tab bar only — does NOT delete from database.
   *  Automatically switches to the nearest remaining tab. */
  const handleRemoveTab = useCallback(
    async (id: string) => {
      const wasActive = useConversationStore.getState().activeConversationId === id;
      if (wasActive) {
        saveCurrentSnapshot();
      }
      removeTab(id);
      if (wasActive) {
        const nextId = useConversationStore.getState().activeConversationId;
        if (nextId) {
          useAgentStatusStore.getState().resetLiveStatus({
            lastUsage: null,
            subagents: [],
            todos: [],
          });
          await loadMessages(nextId);
          restoreConversationModel(nextId);
        } else {
          clearMessages();
        }
      }
    },
    [removeTab, loadMessages, clearMessages, saveCurrentSnapshot],
  );

  return { handleSelect, handleCreate, handleCreateInPane, handleDelete, handleRemoveTab } as const;
}
