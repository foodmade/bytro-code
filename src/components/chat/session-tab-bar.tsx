import { memo, useCallback, useRef, useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  History,
  MessageSquarePlus,
  CheckCircle2,
  ShieldAlert,
  LayoutGrid,
  GitFork,
} from "lucide-react";
import { useConversationStore, useAppStore } from "@/stores";
import { useStreamStateStore } from "@/stores/stream-state-store";
import { useConversationStatus } from "@/hooks/use-conversation-status";
import { useConversationSwitch } from "@/hooks/use-conversation-switch";
import { useNewSessionDrag } from "@/hooks/use-new-session-drag";
import { usePressActivation } from "@/hooks/use-press-activation";
import { formatConversationTitle } from "@/lib/conversation-text";
import { resolveSplitTargetAtPoint } from "@/lib/split-drag-target";
import { SessionDropdownPanel } from "./session-dropdown-panel";
import { popupTabContextMenu } from "./tab-context-menu";
import { useSplitViewStore } from "@/stores/split-view-store";
import type { ConversationStatus } from "@/hooks/use-conversation-status";

// ── Status Indicator ────────────────────────────────────────────────

function StatusIndicator({ status }: { readonly status: ConversationStatus }) {
  if (status === "running") {
    return (
      <span className="session-tab-pulse-dots">
        <span className="session-tab-pulse-dot green" style={{ animationDelay: "0ms" }} />
        <span className="session-tab-pulse-dot green" style={{ animationDelay: "150ms" }} />
        <span className="session-tab-pulse-dot green" style={{ animationDelay: "300ms" }} />
      </span>
    );
  }
  if (status === "permission") {
    return (
      <>
        <span className="session-tab-pulse-dots">
          <span className="session-tab-pulse-dot amber" style={{ animationDelay: "0ms" }} />
          <span className="session-tab-pulse-dot amber" style={{ animationDelay: "150ms" }} />
          <span className="session-tab-pulse-dot amber" style={{ animationDelay: "300ms" }} />
        </span>
        <span className="session-tab-confirm-badge">
          <ShieldAlert size={10} />
          <span>Confirm</span>
        </span>
      </>
    );
  }
  if (status === "completed") {
    return <CheckCircle2 size={12} style={{ color: "rgba(34, 197, 94, 0.6)" }} />;
  }
  return null;
}

// ── Session Tab ─────────────────────────────────────────────────────

const SessionTab = memo(function SessionTab({
  title,
  isActive,
  isRenaming,
  renameValue,
  status,
  isDragging,
  isDragOver,
  dragOverSide,
  isInSplit = false,
  isForked = false,
  onSelect,
  onClose,
  onContextMenu,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onPointerDown,
}: {
  readonly title: string;
  readonly isActive: boolean;
  readonly isRenaming: boolean;
  readonly renameValue: string;
  readonly status: ConversationStatus;
  readonly isDragging: boolean;
  readonly isDragOver: boolean;
  readonly dragOverSide: "left" | "right" | null;
  readonly isInSplit?: boolean;
  readonly isForked?: boolean;
  readonly onSelect: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (e: React.MouseEvent) => void;
  readonly onRenameChange: (value: string) => void;
  readonly onRenameSubmit: () => void;
  readonly onRenameCancel: () => void;
  readonly onPointerDown: (e: React.PointerEvent) => void;
}) {
  const { t } = useTranslation();
  const displayTitle = formatConversationTitle(title);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  return (
    <div
      className={`session-tab${isActive ? " active" : ""}${status === "completed" ? " completed" : ""}${isDragging ? " dragging" : ""}${isDragOver ? " drag-over" : ""}`}
      onClick={isRenaming ? undefined : onSelect}
      onContextMenu={isRenaming ? undefined : onContextMenu}
      onPointerDown={isRenaming ? undefined : onPointerDown}
      title={isRenaming ? undefined : displayTitle}
      draggable={false}
      style={{
        borderLeft:
          isDragOver && dragOverSide === "left"
            ? "2px solid var(--color-accent-purple)"
            : undefined,
        borderRight:
          isDragOver && dragOverSide === "right"
            ? "2px solid var(--color-accent-purple)"
            : undefined,
      }}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRenameSubmit();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              onRenameCancel();
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 bg-transparent outline-none font-sans"
          style={{
            fontSize: 11,
            color: "var(--color-foreground)",
            width: 120,
            borderBottom: "1px solid var(--color-accent-purple)",
            padding: "0 2px",
          }}
          maxLength={100}
        />
      ) : (
        <>
          {isForked && (
            <GitFork
              size={11}
              style={{ color: "var(--color-accent-purple)", flexShrink: 0, marginRight: 3 }}
              aria-label={t("chat.forkedFrom")}
            />
          )}
          <span className="truncate" style={{ maxWidth: 140 }}>
            {displayTitle}
          </span>
          <StatusIndicator status={status} />
          {isInSplit && (
            <span
              className="inline-flex items-center justify-center rounded p-[3px] shrink-0"
              style={{
                color: "var(--color-accent-purple)",
                backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)",
              }}
              title={t("splitView.badge.label")}
              aria-label={t("splitView.badge.label")}
            >
              <LayoutGrid size={12} />
            </span>
          )}
        </>
      )}
      <button
        className="session-tab-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close tab"
      >
        <X size={10} />
      </button>
    </div>
  );
});

// ── Session Tab Bar ─────────────────────────────────────────────────

export const SessionTabBar = memo(function SessionTabBar() {
  const { t } = useTranslation();
  const conversations = useConversationStore((s) => s.conversations);
  const openedTabIds = useConversationStore((s) => s.openedTabIds);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const pinConversation = useConversationStore((s) => s.pinConversation);
  const renameConversation = useConversationStore((s) => s.renameConversation);
  const { getStatus } = useConversationStatus();
  const { handleSelect, handleCreate, handleCreateInPane, handleDelete, handleRemoveTab } =
    useConversationSwitch();
  const switchToFileTab = useAppStore((s) => s.switchToFileTab);
  const startDraggingConversation = useSplitViewStore((s) => s.startDraggingConversation);
  const setHoveredDropZone = useSplitViewStore((s) => s.setHoveredDropZone);
  const focusPane = useSplitViewStore((s) => s.focusPane);
  const dropConversation = useSplitViewStore((s) => s.dropConversation);
  const endDraggingConversation = useSplitViewStore((s) => s.endDraggingConversation);
  const panes = useSplitViewStore((s) => s.panes);
  const scrollRef = useRef<HTMLDivElement>(null);
  const allBtnRef = useRef<HTMLButtonElement>(null);
  const suppressClickRef = useRef(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [dragPreview, setDragPreview] = useState<{
    readonly title: string;
    readonly x: number;
    readonly y: number;
  } | null>(null);

  // Drag-and-drop state
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragOverSide, setDragOverSide] = useState<"left" | "right" | null>(null);

  // Only show tabs for conversations that are in the openedTabIds list
  const tabConversations = conversations.filter((c) => openedTabIds.includes(c.id));

  const splitConversationIds = useMemo(
    () =>
      panes.length > 1
        ? new Set(panes.map((p) => p.conversationId).filter((id): id is string => Boolean(id)))
        : new Set<string>(),
    [panes],
  );

  // Auto-scroll to the active tab when it changes
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const activeEl = container.querySelector(".session-tab.active") as HTMLElement | null;
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
  }, [activeConversationId]);

  // Native wheel listener (non-passive) to properly preventDefault and scroll horizontally
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Trackpad horizontal swipe — let native handle it
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const toggleDropdown = useCallback(() => {
    setIsDropdownOpen((prev) => !prev);
  }, []);
  const dropdownPressActivation = usePressActivation<HTMLButtonElement>(() => {
    toggleDropdown();
  });

  const closeDropdown = useCallback(() => {
    setIsDropdownOpen(false);
  }, []);

  const handleTabContextMenu = useCallback(
    (convId: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const conv = conversations.find((c) => c.id === convId);
      void popupTabContextMenu({
        conversationId: convId,
        isPinned: conv?.is_pinned ?? false,
        t,
        x: e.clientX,
        y: e.clientY,
        actions: {
          onPin: () => {
            const target = conversations.find((c) => c.id === convId);
            if (target) {
              pinConversation(target.id, !target.is_pinned);
            }
          },
          onRename: () => {
            const target = conversations.find((c) => c.id === convId);
            if (target) {
              setRenameTitle(target.title);
              setRenamingId(target.id);
            }
          },
          onCloseSession: () => handleRemoveTab(convId),
          onCloseOthers: () => {
            for (const other of tabConversations) {
              if (other.id !== convId) {
                handleRemoveTab(other.id);
              }
            }
          },
          onCloseAll: () => {
            for (const other of tabConversations) {
              handleRemoveTab(other.id);
            }
          },
          onDelete: () => handleDelete(convId),
        },
      }).catch((err) => {
        console.error("Unable to open tab context menu:", err);
      });
    },
    [conversations, tabConversations, t, pinConversation, handleRemoveTab, handleDelete],
  );

  const {
    dragPreview: newSessionDragPreview,
    handleClick: handleNewSessionClick,
    handlePointerDown: handleNewSessionPointerDown,
  } = useNewSessionDrag({
    title: t("chat.newSession"),
    onCreateClick: handleCreate,
    onCreateAtPane: handleCreateInPane,
  });

  const handleRenameSubmit = useCallback(
    async (convId: string) => {
      const trimmed = renameTitle.trim();
      const conv = conversations.find((c) => c.id === convId);
      if (trimmed && conv && trimmed !== conv.title) {
        await renameConversation(convId, trimmed);
      }
      setRenamingId(null);
    },
    [renameTitle, conversations, renameConversation],
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingId(null);
  }, []);

  // ── Drag-and-drop handlers ──
  const handlePointerDown = useCallback(
    (conversationId: string, e: React.PointerEvent) => {
      if (e.button !== 0) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest(".session-tab-close")) {
        return;
      }
      e.preventDefault();

      const activeConversationIdAtPointerDown =
        useConversationStore.getState().activeConversationId;
      suppressClickRef.current = true;
      switchToFileTab(null);
      useStreamStateStore.getState().clearConversationCompleted(conversationId);
      void handleSelect(conversationId);

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
        setDragOverIndex(null);
        setDragOverSide(null);
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };

      const onPointerMove = (event: PointerEvent) => {
        if ((event.buttons & 1) === 0) {
          cleanup();
          return;
        }

        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        const distance = Math.hypot(dx, dy);

        if (!dragging && distance < 6) {
          return;
        }

        if (!dragging) {
          dragging = true;
          suppressClickRef.current = true;
          if (pointerTarget) {
            pointerTarget.classList.add("dragging");
          }
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          rootElement.classList.add("split-dragging");
          document.getSelection?.()?.removeAllRanges();
          startDraggingConversation(conversationId);
          const conversation = conversations.find((item) => item.id === conversationId);
          setDragPreview({
            title: formatConversationTitle(conversation?.title ?? "Untitled"),
            x: event.clientX,
            y: event.clientY,
          });
        }

        const targetInfo = resolveSplitTargetAtPoint(event.clientX, event.clientY);
        const zone = targetInfo?.zone ?? null;
        setDragPreview((current) =>
          current
            ? {
                ...current,
                x: event.clientX,
                y: event.clientY,
              }
            : current,
        );
        setHoveredDropZone(zone, targetInfo?.paneId ?? null);
      };

      const onPointerUp = (event: PointerEvent) => {
        if (dragging) {
          const targetInfo = resolveSplitTargetAtPoint(event.clientX, event.clientY);
          const zone = targetInfo?.zone ?? null;
          if (zone) {
            const paneId = dropConversation(
              conversationId,
              zone,
              activeConversationIdAtPointerDown,
              targetInfo?.paneId as Parameters<typeof dropConversation>[3],
            );
            if (paneId) {
              focusPane(paneId);
            }
            switchToFileTab(null);
          }
        }

        cleanup();
      };

      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerUp, true);
    },
    [
      conversations,
      dropConversation,
      endDraggingConversation,
      focusPane,
      handleSelect,
      setHoveredDropZone,
      startDraggingConversation,
      switchToFileTab,
    ],
  );

  return (
    <div className="session-tab-bar-wrapper">
      <div className="session-tab-bar">
        <div className="session-tab-action-group">
          <button
            ref={allBtnRef}
            className="session-tab-action-btn"
            onClick={dropdownPressActivation.onClick}
            onPointerDown={dropdownPressActivation.onPointerDown}
            title={t("sessionTab.allSessions", "All sessions")}
            aria-label={t("sessionTab.allSessions", "All sessions")}
          >
            <History size={14} />
          </button>
          <button
            className="session-tab-action-btn"
            onClick={handleNewSessionClick}
            onPointerDown={handleNewSessionPointerDown}
            title={t("sessionTab.newSession", "New session")}
            aria-label={t("sessionTab.newSession", "New session")}
          >
            <MessageSquarePlus size={14} />
          </button>
        </div>

        <div className="session-tab-divider" />

        <div className="session-tab-scroll-wrapper">
          <div className="session-tab-scroll" ref={scrollRef}>
            {tabConversations.map((conv, index) => (
              <SessionTab
                key={conv.id}
                title={conv.title}
                isForked={!!conv.parent_conversation_id}
                isActive={conv.id === activeConversationId}
                isRenaming={renamingId === conv.id}
                renameValue={renamingId === conv.id ? renameTitle : ""}
                status={getStatus(conv.id)}
                isDragging={false}
                isDragOver={dragOverIndex === index}
                dragOverSide={dragOverIndex === index ? dragOverSide : null}
                isInSplit={splitConversationIds.has(conv.id)}
                onSelect={() => {
                  if (suppressClickRef.current) return;
                  switchToFileTab(null);
                  useStreamStateStore.getState().clearConversationCompleted(conv.id);
                  void handleSelect(conv.id);
                }}
                onClose={() => handleRemoveTab(conv.id)}
                onContextMenu={(e) => handleTabContextMenu(conv.id, e)}
                onRenameChange={setRenameTitle}
                onRenameSubmit={() => handleRenameSubmit(conv.id)}
                onRenameCancel={handleRenameCancel}
                onPointerDown={(e) => handlePointerDown(conv.id, e)}
              />
            ))}
          </div>
        </div>
      </div>

      {isDropdownOpen && <SessionDropdownPanel anchorRef={allBtnRef} onClose={closeDropdown} />}

      {dragPreview && (
        <div
          className="split-drag-preview"
          style={{
            left: dragPreview.x,
            top: dragPreview.y,
          }}
        >
          <span className="split-drag-preview-badge">分屏拖拽</span>
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
          <span className="split-drag-preview-badge">新会话</span>
          <span className="split-drag-preview-title">{newSessionDragPreview.title}</span>
        </div>
      )}
    </div>
  );
});
