import { useSplitViewStore, type SplitPane, type SplitPaneId } from "@/stores";

function isSessionPane(pane: SplitPane): boolean {
  return (
    pane.content.type === "chat" ||
    pane.content.type === "empty" ||
    pane.group.items.some((item) => item.content.type === "chat")
  );
}

export function findPreferredSessionPaneId(): SplitPaneId | null {
  const splitState = useSplitViewStore.getState();
  const activePane = splitState.activePaneId
    ? (splitState.panes.find((pane) => pane.id === splitState.activePaneId) ?? null)
    : null;

  return (
    (activePane && isSessionPane(activePane) ? activePane.id : null) ??
    splitState.panes.find(isSessionPane)?.id ??
    null
  );
}

export function bindConversationToPreferredSessionPane(conversationId: string): SplitPaneId | null {
  const targetPaneId = findPreferredSessionPaneId();
  if (!targetPaneId) return null;

  const splitState = useSplitViewStore.getState();
  if (splitState.soloMode) {
    splitState.exitSoloMode(targetPaneId);
  }
  useSplitViewStore.getState().setPaneConversation(targetPaneId, conversationId);
  return targetPaneId;
}
