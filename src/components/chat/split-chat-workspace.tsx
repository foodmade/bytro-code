import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FileCode2, GitMerge, GripVertical, History, MessageSquare, MessageSquareDashed, MessageSquarePlus, X } from "lucide-react";
import { SessionTabBar } from "./session-tab-bar";
import { SessionDropdownPanel } from "./session-dropdown-panel";
import { ChatPanel } from "./chat-panel";
import { useAppStore, useConversationStore, useSplitViewStore } from "@/stores";
import { useConversationSwitch } from "@/hooks/use-conversation-switch";
import { useConversationStatus } from "@/hooks/use-conversation-status";
import { useNewSessionDrag } from "@/hooks/use-new-session-drag";
import type { SplitPaneContent, SplitPaneId } from "@/stores";
import { SOLO_PANE_ID } from "@/stores/split-view-store";
import { formatConversationTitle } from "@/lib/conversation-text";
import { resolveSplitTargetAtPoint } from "@/lib/split-drag-target";

const CodeEditor = lazy(async () => {
  const m = await import("@/components/editor/code-editor");
  return { default: m.CodeEditor };
});

const CONVERSATION_TAB_MIME = "application/x-bytro-conversation-tab";

function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function getPaneTitle(
  content: SplitPaneContent,
  fallbackTitle: string,
  isDraftPane: boolean,
  labels: { readonly newSession: string; readonly emptyPane: string },
): string {
  switch (content.type) {
    case "chat":
      return content.conversationId ? fallbackTitle : isDraftPane ? labels.newSession : labels.emptyPane;
    case "file":
      return getFileName(content.path);
    case "diff":
      return getFileName(content.path);
    case "empty":
      return labels.emptyPane;
  }
}

function getPaneItemIcon(content: SplitPaneContent) {
  switch (content.type) {
    case "chat":
      return <MessageSquare size={12} />;
    case "file":
      return <FileCode2 size={12} />;
    case "diff":
      return <GitMerge size={12} />;
    case "empty":
      return <MessageSquareDashed size={12} />;
  }
}

function getDragConversationId(event: React.DragEvent): string | null {
  try {
    return event.dataTransfer.getData(CONVERSATION_TAB_MIME) || null;
  } catch {
    return null;
  }
}

export function SplitChatWorkspace() {
  const { t } = useTranslation();
  const conversations = useConversationStore((state) => state.conversations);
  const openedTabIds = useConversationStore((state) => state.openedTabIds);
  const activeConversationId = useConversationStore((state) => state.activeConversationId);
  const setActiveFileTab = useAppStore((state) => state.setActiveFileTab);
  const switchToFileTab = useAppStore((state) => state.switchToFileTab);
  const removeFileTabState = useAppStore((state) => state.removeFileTabState);
  const layout = useSplitViewStore((state) => state.layout);
  const root = useSplitViewStore((state) => state.root);
  const panes = useSplitViewStore((state) => state.panes);
  const draftPaneIds = useSplitViewStore((state) => state.draftPaneIds);
  const activePaneId = useSplitViewStore((state) => state.activePaneId);
  const soloMode = useSplitViewStore((state) => state.soloMode);
  const draggedConversationId = useSplitViewStore((state) => state.draggedConversationId);
  const draggedContent = useSplitViewStore((state) => state.draggedContent);
  const draggedNewSession = useSplitViewStore((state) => state.draggedNewSession);
  const draggedPaneId = useSplitViewStore((state) => state.draggedPaneId);
  const hoveredDropZone = useSplitViewStore((state) => state.hoveredDropZone);
  const hoveredPaneId = useSplitViewStore((state) => state.hoveredPaneId);
  const ensureInitialized = useSplitViewStore((state) => state.ensureInitialized);
  const syncActiveConversation = useSplitViewStore((state) => state.syncActiveConversation);
  const startDraggingConversation = useSplitViewStore((state) => state.startDraggingConversation);
  const startDraggingContent = useSplitViewStore((state) => state.startDraggingContent);
  const startDraggingPane = useSplitViewStore((state) => state.startDraggingPane);
  const focusPane = useSplitViewStore((state) => state.focusPane);
  const setHoveredDropZone = useSplitViewStore((state) => state.setHoveredDropZone);
  const endDraggingConversation = useSplitViewStore((state) => state.endDraggingConversation);
  const dropContent = useSplitViewStore((state) => state.dropContent);
  const removePane = useSplitViewStore((state) => state.removePane);
  const activatePaneItem = useSplitViewStore((state) => state.activatePaneItem);
  const closePaneItem = useSplitViewStore((state) => state.closePaneItem);
  const movePaneToZone = useSplitViewStore((state) => state.movePaneToZone);
  const cleanupClosedConversations = useSplitViewStore((state) => state.cleanupClosedConversations);
  const normalizeEditorPaneOrder = useSplitViewStore((state) => state.normalizeEditorPaneOrder);
  const resizeBranch = useSplitViewStore((state) => state.resizeBranch);
  const { handleSelect, handleCreate, handleCreateInPane } = useConversationSwitch();
  const { runningIds } = useConversationStatus();
  const historyButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [openHistoryPaneId, setOpenHistoryPaneId] = useState<SplitPaneId | null>(null);
  const [dragPreview, setDragPreview] = useState<null | { readonly title: string; readonly x: number; readonly y: number }>(null);
  const [swapAnimatingPaneIds, setSwapAnimatingPaneIds] = useState<ReadonlyArray<SplitPaneId>>([]);
  const swapAnimationTimerRef = useRef<number | null>(null);
  const paneDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressPaneTabClickRef = useRef(false);
  const occupiedPaneCount = useMemo(
    () => panes.filter((pane) => pane.content.type !== "empty" || draftPaneIds.includes(pane.id)).length,
    [draftPaneIds, panes],
  );
  const hasEditorPane = useMemo(
    () => panes.some((pane) => pane.content.type === "file" || pane.content.type === "diff"),
    [panes],
  );
  const paneMap = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes]);
  const draftPaneIdSet = useMemo(() => new Set(draftPaneIds), [draftPaneIds]);
  const {
    dragPreview: newSessionDragPreview,
    handleClick: handleNewSessionClick,
    handlePointerDown: handleNewSessionPointerDown,
  } = useNewSessionDrag({
    title: t("chat.newSession"),
    onCreateClick: (event) => {
      const paneId = event.currentTarget.dataset.paneId;
      if (paneId) {
        handleCreateInPane(paneId);
        return;
      }
      handleCreate();
    },
    onCreateAtPane: handleCreateInPane,
  });
  const setHistoryButtonRef = useCallback((paneId: SplitPaneId, node: HTMLButtonElement | null) => {
    historyButtonRefs.current[paneId] = node;
  }, []);
  const closeHistoryPanel = useCallback(() => {
    setOpenHistoryPaneId(null);
  }, []);

  useEffect(() => {
    return () => {
      if (swapAnimationTimerRef.current !== null) {
        window.clearTimeout(swapAnimationTimerRef.current);
      }
      if (paneDragCleanupRef.current) {
        paneDragCleanupRef.current();
        paneDragCleanupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    ensureInitialized(activeConversationId);
  }, [activeConversationId, ensureInitialized]);

  useEffect(() => {
    syncActiveConversation(activeConversationId);
  }, [activeConversationId, syncActiveConversation]);

  useEffect(() => {
    normalizeEditorPaneOrder(activeConversationId);
  }, [activeConversationId, normalizeEditorPaneOrder, root]);

  useEffect(() => {
    const validIds = [
      ...openedTabIds,
      ...panes
        .map((pane) => pane.conversationId)
        .filter((conversationId): conversationId is string => Boolean(conversationId)),
    ];
    if (activeConversationId) {
      validIds.push(activeConversationId);
    }
    if (soloMode?.conversationId) {
      validIds.push(soloMode.conversationId);
    }
    cleanupClosedConversations(validIds, activeConversationId);
  }, [openedTabIds, panes, activeConversationId, cleanupClosedConversations, soloMode]);

  const titleMap = useMemo(() => {
    return new Map(conversations.map((conversation) => [conversation.id, conversation.title]));
  }, [conversations]);
  const paneTitleLabels = useMemo(() => ({
    newSession: t("chat.newSession"),
    emptyPane: t("splitView.emptyPane"),
  }), [t]);

  const handleActivatePane = useCallback(async (paneId: SplitPaneId, content: SplitPaneContent, conversationId: string | null) => {
    if (content.type === "file" || content.type === "diff") {
      setActiveFileTab(content.path);
      focusPane(paneId);
      return;
    }
    setActiveFileTab(null, { preserveEditorPath: true });
    if (!conversationId) {
      focusPane(paneId);
      return;
    }
    if (conversationId !== activeConversationId) {
      await handleSelect(conversationId);
      return;
    }
    focusPane(paneId);
  }, [activeConversationId, focusPane, handleSelect, setActiveFileTab]);

  const handleDropOnWorkspace = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const target = resolveSplitTargetAtPoint(event.clientX, event.clientY);
    const zone = target?.zone ?? null;
    const dataConversationId = getDragConversationId(event);
    const content = draggedContent ?? (dataConversationId ?? draggedConversationId ? { type: "chat", conversationId: dataConversationId ?? draggedConversationId } as const : null);
    if (!content || !zone) {
      endDraggingConversation();
      return;
    }
    const paneId = dropContent(content, zone, activeConversationId, target?.paneId ?? null);
    endDraggingConversation();
    if (paneId) {
      focusPane(paneId);
    }
    if (content.type === "chat" && content.conversationId && content.conversationId !== activeConversationId) {
      setActiveFileTab(null, { preserveEditorPath: true });
      await handleSelect(content.conversationId);
    }
  }, [activeConversationId, draggedContent, draggedConversationId, dropContent, endDraggingConversation, focusPane, handleSelect, setActiveFileTab]);

  const handleRemovePane = useCallback(async (paneId: SplitPaneId) => {
    const next = removePane(paneId, activeConversationId);
    setActiveFileTab(null, { preserveEditorPath: true });
    if (next.conversationId && next.conversationId !== activeConversationId) {
      await handleSelect(next.conversationId);
      return;
    }
    if (next.paneId) {
      focusPane(next.paneId);
    }
  }, [activeConversationId, focusPane, handleSelect, removePane, setActiveFileTab]);

  const handleClosePaneItem = useCallback(async (paneId: SplitPaneId, itemId: string) => {
    const closingPane = useSplitViewStore.getState().panes.find((item) => item.id === paneId) ?? null;
    const closingItem = closingPane?.group.items.find((item) => item.id === itemId) ?? null;
    const next = closePaneItem(paneId, itemId, activeConversationId);
    const nextPanes = useSplitViewStore.getState().panes;
    const pane = next.paneId ? nextPanes.find((item) => item.id === next.paneId) ?? null : null;
    const activeContent = pane?.content ?? null;
    if (closingItem?.content.type === "file" || closingItem?.content.type === "diff") {
      removeFileTabState(closingItem.content.path);
    }
    if (activeContent?.type === "file" || activeContent?.type === "diff") {
      setActiveFileTab(activeContent.path);
    } else {
      setActiveFileTab(null, { preserveEditorPath: true });
    }
    if (next.conversationId && next.conversationId !== activeConversationId) {
      await handleSelect(next.conversationId);
      return;
    }
    if (next.paneId) focusPane(next.paneId);
  }, [activeConversationId, closePaneItem, focusPane, handleSelect, removeFileTabState, setActiveFileTab]);

  const handleContentTabPointerDown = useCallback((content: SplitPaneContent, title: string, e: React.PointerEvent) => {
    if (content.type !== "file" && content.type !== "diff") return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(".split-pane-item-tab-close")) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerTarget = e.currentTarget as HTMLElement | null;
    const rootElement = document.documentElement;
    let dragging = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      rootElement.classList.remove("split-dragging");
      pointerTarget?.classList.remove("dragging");
      setDragPreview(null);
      setHoveredDropZone(null, null);
      endDraggingConversation();
      window.setTimeout(() => {
        suppressPaneTabClickRef.current = false;
      }, 0);
    };

    const onPointerMove = (event: PointerEvent) => {
      if ((event.buttons & 1) === 0) {
        cleanup();
        return;
      }
      const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
      if (!dragging && distance < 6) return;

      if (!dragging) {
        dragging = true;
        suppressPaneTabClickRef.current = true;
        pointerTarget?.classList.add("dragging");
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        rootElement.classList.add("split-dragging");
        document.getSelection?.()?.removeAllRanges();
        startDraggingContent(content);
        setDragPreview({ title, x: event.clientX, y: event.clientY });
      }

      const targetInfo = resolveSplitTargetAtPoint(event.clientX, event.clientY);
      const zone = targetInfo?.zone ?? null;
      setDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
      setHoveredDropZone(zone, targetInfo?.paneId ?? null);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (dragging) {
        const targetInfo = resolveSplitTargetAtPoint(event.clientX, event.clientY);
        const zone = targetInfo?.zone ?? null;
        if (zone) {
          const activeConversationIdNow = useConversationStore.getState().activeConversationId;
          const paneId = dropContent(content, zone, activeConversationIdNow, targetInfo?.paneId ?? null);
          if (paneId) focusPane(paneId);
          switchToFileTab(content.path);
        }
      }
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
  }, [dropContent, endDraggingConversation, focusPane, setHoveredDropZone, startDraggingContent, switchToFileTab]);

  const handleWorkspaceDragOver = useCallback((event: React.DragEvent) => {
    const dataConversationId = getDragConversationId(event);
    if (!event.dataTransfer.types.includes(CONVERSATION_TAB_MIME) && !draggedContent && !draggedConversationId && !dataConversationId) {
      return;
    }
    event.preventDefault();
    if (dataConversationId && draggedConversationId !== dataConversationId) {
      startDraggingConversation(dataConversationId);
    }
    const target = resolveSplitTargetAtPoint(event.clientX, event.clientY);
    setHoveredDropZone(target?.zone ?? null, target?.paneId ?? null);
  }, [draggedContent, draggedConversationId, setHoveredDropZone, startDraggingConversation]);

  const handleBranchResizePointerDown = useCallback((branchId: string, direction: "horizontal" | "vertical", event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const branchElement = event.currentTarget.parentElement;
    if (!branchElement) return;
    const rect = branchElement.getBoundingClientRect();
    const axisSize = direction === "horizontal" ? rect.width : rect.height;
    if (axisSize <= 0) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const offset = direction === "horizontal"
        ? moveEvent.clientX - rect.left
        : moveEvent.clientY - rect.top;
      resizeBranch(branchId, offset / axisSize);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", cleanup, true);
      window.removeEventListener("pointercancel", cleanup, true);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", cleanup, true);
    window.addEventListener("pointercancel", cleanup, true);
  }, [resizeBranch]);

  const handlePanePointerDown = useCallback((paneId: SplitPaneId, title: string, e: React.PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    if (paneDragCleanupRef.current) {
      paneDragCleanupRef.current();
      paneDragCleanupRef.current = null;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerTarget = e.currentTarget as HTMLElement | null;
    const rootElement = document.documentElement;
    let dragging = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      rootElement.classList.remove("split-dragging");
      if (pointerTarget) {
        pointerTarget.classList.remove("dragging");
      }
      setDragPreview(null);
      setHoveredDropZone(null, null);
      endDraggingConversation();
      paneDragCleanupRef.current = null;
    };

    paneDragCleanupRef.current = cleanup;

    const onPointerMove = (event: PointerEvent) => {
      if ((event.buttons & 1) === 0) {
        cleanup();
        return;
      }
      const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
      if (!dragging && distance < 6) {
        return;
      }
      if (!dragging) {
        dragging = true;
        if (pointerTarget) {
          pointerTarget.classList.add("dragging");
        }
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        rootElement.classList.add("split-dragging");
        document.getSelection?.()?.removeAllRanges();
        startDraggingPane(paneId);
        setDragPreview({
          title: formatConversationTitle(title),
          x: event.clientX,
          y: event.clientY,
        });
      }
      const target = resolveSplitTargetAtPoint(event.clientX, event.clientY);
      setDragPreview((current) => current ? {
        ...current,
        x: event.clientX,
        y: event.clientY,
      } : current);
      setHoveredDropZone(target?.zone ?? null, target?.paneId ?? null);
    };

    const onPointerUp = async (event: PointerEvent) => {
      let needSelectAfterCleanup: string | null = null;
      try {
        if (dragging) {
          const target = resolveSplitTargetAtPoint(event.clientX, event.clientY);
          if (target?.paneId && target.paneId !== paneId) {
            const sourceContent = useSplitViewStore.getState().panes.find((pane) => pane.id === paneId)?.content ?? null;
            const nextPaneId = movePaneToZone(paneId, target.paneId, target.zone, activeConversationId);
            if (!nextPaneId) {
              return;
            }
            setSwapAnimatingPaneIds([nextPaneId]);
            if (swapAnimationTimerRef.current !== null) {
              window.clearTimeout(swapAnimationTimerRef.current);
            }
            swapAnimationTimerRef.current = window.setTimeout(() => {
              setSwapAnimatingPaneIds([]);
              swapAnimationTimerRef.current = null;
            }, 320);
            if (sourceContent?.type === "chat" && sourceContent.conversationId) {
              setActiveFileTab(null, { preserveEditorPath: true });
              if (sourceContent.conversationId !== activeConversationId) {
                needSelectAfterCleanup = sourceContent.conversationId;
              } else {
                focusPane(nextPaneId);
              }
            } else {
              focusPane(nextPaneId);
            }
          }
        }
      } finally {
        cleanup();
      }
      if (needSelectAfterCleanup) {
        await handleSelect(needSelectAfterCleanup);
      }
    };

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
  }, [activeConversationId, endDraggingConversation, focusPane, handleSelect, movePaneToZone, setHoveredDropZone, startDraggingPane, setActiveFileTab]);

  const hasActiveDrag = draggedConversationId !== null || draggedContent !== null || draggedNewSession || draggedPaneId !== null;

  const handlePaneTabsWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += event.deltaY;
  }, []);

  const renderPane = useCallback((paneId: SplitPaneId): ReactNode => {
    const pane = paneMap.get(paneId);
    if (!pane) return null;

    const isActivePane = pane.id === activePaneId;
    const isDraftPane = draftPaneIdSet.has(pane.id);
    const isSessionPane = pane.content.type === "chat" || isDraftPane;
    const isEditorPane = pane.content.type === "file" || pane.content.type === "diff";
    const isRunningPane = pane.conversationId ? runningIds.has(pane.conversationId) : false;
    const fallbackTitle = pane.conversationId ? (titleMap.get(pane.conversationId) ?? t("sessionTab.untitled", "Untitled")) : t("sessionTab.untitled", "Untitled");
    const title = getPaneTitle(pane.content, fallbackTitle, isDraftPane, paneTitleLabels);
    const paneTabItems = pane.group.items.filter((item) => {
      if (isEditorPane) return item.content.type === "file" || item.content.type === "diff";
      if (isSessionPane) return item.content.type === "chat" || item.content.type === "empty";
      return item.content.type === pane.content.type;
    });
    const shouldShowPaneTabs = paneTabItems.length > 0 && (layout !== "single" || isEditorPane);
    const splitPreviewZone =
      hasActiveDrag && hoveredPaneId === pane.id && hoveredDropZone && hoveredDropZone !== "center"
        ? hoveredDropZone
        : null;

    return (
      <section
        key={pane.id}
        data-pane-id={pane.id}
        className={`split-chat-pane${layout !== "single" && pane.id === activePaneId ? " focused" : ""}`}
        data-pane-content={pane.content.type}
        data-swap-animating={swapAnimatingPaneIds.includes(pane.id) || undefined}
        data-focused={isActivePane || undefined}
        data-running={isRunningPane || undefined}
        onMouseDown={() => {
          if (!isActivePane) {
            void handleActivatePane(pane.id, pane.content, pane.conversationId);
          }
        }}
      >
        {shouldShowPaneTabs && (
          <div
            className="split-pane-item-tabs"
            data-content-type={pane.content.type}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={handlePaneTabsWheel}
          >
            {isSessionPane && (
              <div className="split-pane-item-actions">
                <button
                  ref={(node) => setHistoryButtonRef(pane.id, node)}
                  className="split-pane-item-action-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenHistoryPaneId((current) => current === pane.id ? null : pane.id);
                  }}
                  title={t("sessionTab.allSessions", "All sessions")}
                  aria-label={t("sessionTab.allSessions", "All sessions")}
                >
                  <History size={13} />
                </button>
                <button
                  className="split-pane-item-action-btn"
                  data-pane-id={pane.id}
                  onClick={handleNewSessionClick}
                  onPointerDown={handleNewSessionPointerDown}
                  title={t("sessionTab.newSession", "New session")}
                  aria-label={t("sessionTab.newSession", "New session")}
                >
                  <MessageSquarePlus size={13} />
                </button>
              </div>
            )}
            {paneTabItems.map((item) => {
              const itemFallbackTitle = item.content.type === "chat" && item.content.conversationId
                ? (titleMap.get(item.content.conversationId) ?? t("sessionTab.untitled", "Untitled"))
                : t("sessionTab.untitled", "Untitled");
              const itemTitle = getPaneTitle(item.content, itemFallbackTitle, isDraftPane, paneTitleLabels);
              const itemActive = item.id === pane.group.activeItemId;
              return (
                <button
                  key={item.id}
                  className={`split-pane-item-tab${itemActive ? " active" : ""}`}
                  title={itemTitle}
                  onClick={() => {
                    if (suppressPaneTabClickRef.current) return;
                    activatePaneItem(pane.id, item.id);
                    void handleActivatePane(pane.id, item.content, item.content.type === "chat" ? item.content.conversationId : null);
                  }}
                  onPointerDown={(event) => handleContentTabPointerDown(item.content, itemTitle, event)}
                >
                  {getPaneItemIcon(item.content)}
                  <span>{formatConversationTitle(itemTitle)}</span>
                  <span
                    className="split-pane-item-tab-close"
                    role="button"
                    aria-label={t("splitView.closeItem")}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleClosePaneItem(pane.id, item.id);
                    }}
                  >
                    <X size={10} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="split-pane-content-host">
          {pane.content.type === "chat" || isDraftPane ? (
            <ChatPanel
              hideSessionTabs
              conversationId={pane.conversationId}
              paneId={pane.id}
              isFocused={isActivePane}
              compact={layout !== "single"}
            />
          ) : pane.content.type === "file" ? (
            <Suspense fallback={<div className="flex items-center justify-center h-full text-[12px] text-muted-foreground">{t("splitView.loadingEditor")}</div>}>
              <CodeEditor filePath={pane.content.path} />
            </Suspense>
          ) : pane.content.type === "diff" ? (
            <Suspense fallback={<div className="flex items-center justify-center h-full text-[12px] text-muted-foreground">{t("splitView.loadingEditor")}</div>}>
              <CodeEditor filePath={pane.content.path} diffMode={pane.content.diff} />
            </Suspense>
          ) : (
            <button className="split-pane-preview split-pane-preview-empty" onClick={() => focusPane(pane.id)}>
              <MessageSquareDashed size={18} />
              <span>{t("splitView.emptyDropHint")}</span>
            </button>
          )}
        </div>
        {splitPreviewZone && (
          <div className={`split-pane-split-preview zone-${splitPreviewZone}`} aria-hidden="true">
            <div className="split-pane-split-preview-slice" />
            <div className="split-pane-split-preview-badge">
              {splitPreviewZone === "left" || splitPreviewZone === "right" ? t("splitView.horizontalSplit") : t("splitView.verticalSplit")}
            </div>
          </div>
        )}
        {isSessionPane && openHistoryPaneId === pane.id && (
          <SessionDropdownPanel
            anchorRef={{ current: historyButtonRefs.current[pane.id] ?? null }}
            onClose={closeHistoryPanel}
          />
        )}
        {layout !== "single" && pane.content.type !== "empty" && (
          <button
            className={`split-chat-pane-drag-handle${draggedPaneId === pane.id ? " dragging" : ""}`}
            onPointerDown={(event) => handlePanePointerDown(pane.id, title, event)}
            aria-label={t("splitView.dragPane")}
            title={t("splitView.dragPaneTitle")}
          >
            <GripVertical size={12} />
          </button>
        )}
        {layout !== "single" && (
          <button
            className="split-chat-pane-close"
            onClick={(event) => {
              event.stopPropagation();
              void handleRemovePane(pane.id);
            }}
            aria-label={t("splitView.closePane")}
            title={t("splitView.closePane")}
          >
            <X size={12} />
          </button>
        )}
      </section>
    );
  }, [
    activePaneId,
    activatePaneItem,
    draftPaneIdSet,
    handleContentTabPointerDown,
    focusPane,
    draggedPaneId,
    handleActivatePane,
    handleClosePaneItem,
    handlePanePointerDown,
    handleRemovePane,
    handlePaneTabsWheel,
    hasActiveDrag,
    hoveredDropZone,
    closeHistoryPanel,
    handleNewSessionClick,
    handleNewSessionPointerDown,
    hoveredPaneId,
    layout,
    openHistoryPaneId,
    paneMap,
    paneTitleLabels,
    runningIds,
    setHistoryButtonRef,
    swapAnimatingPaneIds,
    t,
    titleMap,
  ]);

  const renderNode = useCallback((node: typeof root): ReactNode => {
    if (node.kind === "leaf") {
      return renderPane(node.paneId);
    }

    const ratio = node.ratio ?? 0.5;
    const style = {
      "--split-first-size": `${ratio}fr`,
      "--split-second-size": `${1 - ratio}fr`,
    } as CSSProperties;

    return (
      <div key={node.id} className={`split-layout-branch dir-${node.direction}`} style={style}>
        <div className="split-layout-child">{renderNode(node.first)}</div>
        <div
          className="split-layout-resizer"
          role="separator"
          aria-orientation={node.direction === "horizontal" ? "vertical" : "horizontal"}
          onPointerDown={(event) => handleBranchResizePointerDown(node.id, node.direction, event)}
        />
        <div className="split-layout-child">{renderNode(node.second)}</div>
      </div>
    );
  }, [handleBranchResizePointerDown, renderPane]);

  const singlePane = layout === "single" ? panes[0] ?? null : null;
  const showSessionTabBar = layout === "single" && singlePane?.content.type !== "file" && singlePane?.content.type !== "diff";

  if (soloMode) {
    return (
      <div className="split-chat-workspace">
        <SessionTabBar />
        <div
          className="split-chat-workspace-body layout-single pane-count-1"
          data-split-layout="single"
        >
          <div className="split-layout-root">
            <section
              key={SOLO_PANE_ID}
              data-pane-id={SOLO_PANE_ID}
              className="split-chat-pane"
              data-focused
              onDragOver={handleWorkspaceDragOver}
              onDrop={(event) => void handleDropOnWorkspace(event)}
              onDragLeave={() => setHoveredDropZone(null, null)}
            >
              <ChatPanel
                hideSessionTabs
                conversationId={soloMode.conversationId}
                paneId={SOLO_PANE_ID}
                isFocused
              />
            </section>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="split-chat-workspace" data-editor-pane-active={hasEditorPane || undefined}>
      {showSessionTabBar && <SessionTabBar />}

      <div
        className={`split-chat-workspace-body layout-${layout} pane-count-${occupiedPaneCount}`}
        data-split-layout={layout}
        onDragOver={handleWorkspaceDragOver}
        onDrop={(event) => void handleDropOnWorkspace(event)}
        onDragLeave={() => setHoveredDropZone(null, null)}
      >
        <div className="split-layout-root">
          {renderNode(root)}
        </div>
        {dragPreview && (
          <div
            className="split-drag-preview"
            style={{
              left: dragPreview.x,
              top: dragPreview.y,
            }}
          >
            <span className="split-drag-preview-badge">
              {draggedPaneId ? t("splitView.swapPosition") : t("splitView.dragSplit")}
            </span>
            <span className="split-drag-preview-title">{dragPreview.title}</span>
          </div>
        )}
        {newSessionDragPreview && (
          <div
            className="split-drag-preview"
            style={{
              left: newSessionDragPreview.x,
              top: newSessionDragPreview.y,
            }}
          >
            <span className="split-drag-preview-badge">{t("chat.newSession")}</span>
            <span className="split-drag-preview-title">{newSessionDragPreview.title}</span>
          </div>
        )}
      </div>
    </div>
  );
}
