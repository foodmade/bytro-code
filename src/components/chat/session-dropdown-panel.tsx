import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Search, Pin, GitFork, CheckCircle2, ShieldAlert, LayoutGrid } from "lucide-react";
import { useConversationStore, useChatStore, useAppStore, useSplitViewStore } from "@/stores";
import { useConversationStatus } from "@/hooks/use-conversation-status";
import { useConversationSwitch } from "@/hooks/use-conversation-switch";
import { formatConversationTitle, formatConversationPreview } from "@/lib/conversation-text";
import { formatRelativeTime } from "./message-config";
import { groupByDate } from "@/lib/conversation-utils";
import type { ConversationStatus } from "@/hooks/use-conversation-status";
import { popupConversationContextMenu } from "./conversation-context-menu";
import { resolveSplitTargetAtPoint } from "@/lib/split-drag-target";

// ── Filter types ────────────────────────────────────────────────────

type FilterType = "all" | "starred" | "archived";

// ── Row Status Indicator ────────────────────────────────────────────

function RowStatusIndicator({ status }: { readonly status: ConversationStatus }) {
  const { t } = useTranslation();
  if (status === "running") {
    return (
      <span className="session-tab-pulse-dots">
        <span className="session-tab-pulse-dot green" style={{ animationDelay: "0ms" }} />
        <span className="session-tab-pulse-dot green" style={{ animationDelay: "150ms" }} />
        <span className="session-tab-pulse-dot green" style={{ animationDelay: "300ms" }} />
      </span>
    );
  }
  if (status === "listening") {
    return (
      <span className="session-tab-pulse-dots" title={t("sessionTab.listening")}>
        <span className="session-tab-pulse-dot blue slow" style={{ animationDelay: "0ms" }} />
        <span className="session-tab-pulse-dot blue slow" style={{ animationDelay: "400ms" }} />
        <span className="session-tab-pulse-dot blue slow" style={{ animationDelay: "800ms" }} />
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

// ── Split-view Badge ────────────────────────────────────────────────

function SplitBadge({ label }: { readonly label: string }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded p-[3px]"
      style={{
        color: "var(--color-accent-purple)",
        backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)",
        flexShrink: 0,
      }}
      title={label}
      aria-label={label}
    >
      <LayoutGrid size={12} />
    </span>
  );
}

// ── Session Dropdown Panel ──────────────────────────────────────────

interface SessionDropdownPanelProps {
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

interface DragPreviewState {
  readonly title: string;
  readonly x: number;
  readonly y: number;
}

const MOVE_TOLERANCE_PX = 12;

export function SessionDropdownPanel({ anchorRef, onClose }: SessionDropdownPanelProps) {
  const { t } = useTranslation();
  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const splitPanes = useSplitViewStore((s) => s.panes);
  const splitConversationIds = useMemo(
    () =>
      splitPanes.length > 1
        ? new Set(splitPanes.map((p) => p.conversationId).filter((id): id is string => Boolean(id)))
        : new Set<string>(),
    [splitPanes],
  );
  const { getStatus, runningIds } = useConversationStatus();
  const { handleSelect } = useConversationSwitch();

  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const pinConversation = useConversationStore((s) => s.pinConversation);
  const renameConversation = useConversationStore((s) => s.renameConversation);
  const setConversationArchived = useConversationStore((s) => s.setConversationArchived);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const clearMessages = useChatStore((s) => s.clearMessages);

  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);

  // Position
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({ left: rect.left, top: rect.bottom + 4 });
    }
  }, [anchorRef]);

  // Auto-focus search
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Auto-focus rename input
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // Click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (panelRef.current && !panelRef.current.contains(target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (renamingId) {
          setRenamingId(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose, renamingId]);

  // ⌘K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Filter + search
  const filtered = useMemo(() => {
    let items = conversations;

    if (filter === "archived") {
      items = items.filter((c) => c.is_archived);
    } else if (filter === "starred") {
      items = items.filter((c) => !c.is_archived && c.is_pinned);
    } else {
      items = items.filter((c) => !c.is_archived);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (c) =>
          formatConversationTitle(c.title).toLowerCase().includes(q) ||
          formatConversationPreview(c.preview).toLowerCase().includes(q),
      );
    }

    return items;
  }, [conversations, filter, searchQuery]);

  const groups = useMemo(() => {
    const splitConvs = filtered.filter((c) => splitConversationIds.has(c.id));
    const rest = filtered.filter((c) => !splitConversationIds.has(c.id));
    const dateGroups = groupByDate(rest, runningIds);
    if (splitConvs.length === 0) return dateGroups;
    const sortedSplit = [...splitConvs].sort((a, b) => {
      const aRunning = runningIds.has(a.id) ? 1 : 0;
      const bRunning = runningIds.has(b.id) ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
    return [{ label: "split", conversations: sortedSplit }, ...dateGroups];
  }, [filtered, runningIds, splitConversationIds]);

  const switchToFileTab = useAppStore((s) => s.switchToFileTab);
  const startDraggingConversation = useSplitViewStore((s) => s.startDraggingConversation);
  const setHoveredDropZone = useSplitViewStore((s) => s.setHoveredDropZone);
  const focusPane = useSplitViewStore((s) => s.focusPane);
  const dropConversation = useSplitViewStore((s) => s.dropConversation);
  const endDraggingConversation = useSplitViewStore((s) => s.endDraggingConversation);

  const handleSelectRow = useCallback(
    (id: string) => {
      if (suppressClickRef.current) return;
      switchToFileTab(null);
      handleSelect(id);
    },
    [handleSelect, switchToFileTab],
  );

  const handleRowPointerDown = useCallback(
    (conversationId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;

      if (dragCleanupRef.current) {
        dragCleanupRef.current();
        dragCleanupRef.current = null;
      }

      const activeConversationIdAtPointerDown =
        useConversationStore.getState().activeConversationId;
      suppressClickRef.current = true;
      switchToFileTab(null);
      handleSelect(conversationId);

      const startX = e.clientX;
      const startY = e.clientY;
      let lastX = e.clientX;
      let lastY = e.clientY;
      const pointerTarget = e.currentTarget as HTMLElement | null;
      const rootElement = document.documentElement;
      let dragging = false;
      let splitDragging = false;

      const conversation = conversations.find((item) => item.id === conversationId);

      const cleanup = () => {
        window.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("pointerup", onPointerUp, true);
        window.removeEventListener("pointercancel", onPointerUp, true);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        rootElement.classList.remove("split-dragging");
        panelRef.current?.classList.remove("dragging-history");
        if (pointerTarget) {
          pointerTarget.classList.remove("dragging");
        }
        setDragPreview(null);
        setHoveredDropZone(null, null);
        endDraggingConversation();
        dragCleanupRef.current = null;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };

      const activateDragPreview = () => {
        if (dragging) {
          return;
        }
        dragging = true;
        suppressClickRef.current = true;
        if (pointerTarget) {
          pointerTarget.classList.add("dragging");
        }
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        rootElement.classList.add("split-dragging");
        panelRef.current?.classList.add("dragging-history");
        document.getSelection?.()?.removeAllRanges();
        setDragPreview({
          title: formatConversationTitle(conversation?.title ?? "Untitled"),
          x: lastX,
          y: lastY,
        });
      };

      const activateSplitDrag = () => {
        if (splitDragging) {
          return;
        }
        splitDragging = true;
        startDraggingConversation(conversationId);
        const target = resolveSplitTargetAtPoint(lastX, lastY);
        setHoveredDropZone(
          (target?.zone as Parameters<typeof setHoveredDropZone>[0]) ?? null,
          target?.paneId ?? null,
        );
      };

      const onPointerMove = (event: PointerEvent) => {
        if ((event.buttons & 1) === 0) {
          cleanup();
          return;
        }

        lastX = event.clientX;
        lastY = event.clientY;
        const distance = Math.hypot(lastX - startX, lastY - startY);

        if (!dragging) {
          const panelRect = panelRef.current?.getBoundingClientRect() ?? null;
          const leftPanel = panelRect
            ? lastX < panelRect.left ||
              lastX > panelRect.right ||
              lastY < panelRect.top ||
              lastY > panelRect.bottom
            : true;
          if (distance >= MOVE_TOLERANCE_PX) {
            activateDragPreview();
            if (leftPanel) {
              activateSplitDrag();
            }
          }
          if (!dragging) {
            return;
          }
        }

        const panelRect = panelRef.current?.getBoundingClientRect() ?? null;
        const leftPanel = panelRect
          ? lastX < panelRect.left ||
            lastX > panelRect.right ||
            lastY < panelRect.top ||
            lastY > panelRect.bottom
          : true;
        if (leftPanel) {
          activateSplitDrag();
        }

        if (event.cancelable) {
          event.preventDefault();
        }
        setDragPreview((current) =>
          current
            ? {
                ...current,
                x: lastX,
                y: lastY,
              }
            : current,
        );
        if (splitDragging) {
          const target = resolveSplitTargetAtPoint(lastX, lastY);
          setHoveredDropZone(
            (target?.zone as Parameters<typeof setHoveredDropZone>[0]) ?? null,
            target?.paneId ?? null,
          );
        } else {
          setHoveredDropZone(null, null);
        }
      };

      const onPointerUp = (event: PointerEvent) => {
        if (splitDragging) {
          const target = resolveSplitTargetAtPoint(event.clientX, event.clientY);
          if (target) {
            const paneId = dropConversation(
              conversationId,
              target.zone as Parameters<typeof dropConversation>[1],
              activeConversationIdAtPointerDown,
              target.paneId as Parameters<typeof dropConversation>[3],
            );
            if (paneId) {
              focusPane(paneId);
            }
            switchToFileTab(null);
          }
        }
        cleanup();
      };

      dragCleanupRef.current = cleanup;
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

  useEffect(() => {
    return () => {
      if (dragCleanupRef.current) {
        dragCleanupRef.current();
        dragCleanupRef.current = null;
      }
    };
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      if (activeConversationId === id) {
        clearMessages();
      }
    },
    [deleteConversation, activeConversationId, clearMessages],
  );

  const handleRename = useCallback(
    (convId: string) => {
      const conv = conversations.find((c) => c.id === convId);
      setRenameTitle(conv?.title ?? "");
      setRenamingId(convId);
    },
    [conversations],
  );

  const handleSubmitRename = useCallback(
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

  const handlePin = useCallback(
    async (id: string, pinned: boolean) => {
      await pinConversation(id, pinned);
    },
    [pinConversation],
  );

  const handleArchive = useCallback(
    async (id: string, archived: boolean) => {
      const wasActive = useConversationStore.getState().activeConversationId === id;
      await setConversationArchived(id, archived);
      if (wasActive && archived) {
        const nextId = useConversationStore.getState().activeConversationId;
        if (nextId) {
          await loadMessages(nextId);
        } else {
          clearMessages();
        }
      }
    },
    [setConversationArchived, loadMessages, clearMessages],
  );

  const handleCopyId = useCallback((id: string) => {
    navigator.clipboard.writeText(id);
  }, []);

  const handleOpenContextMenu = useCallback(
    (conv: (typeof conversations)[number], x: number, y: number) => {
      popupConversationContextMenu({
        menuId: "bytro-session-dropdown-context-menu",
        conversation: conv,
        t,
        x,
        y,
        actions: {
          onPin: () => handlePin(conv.id, !conv.is_pinned),
          onRename: () => handleRename(conv.id),
          onArchive: () => handleArchive(conv.id, !conv.is_archived),
          onCopyId: () => handleCopyId(conv.id),
          onDelete: () => handleDelete(conv.id),
        },
      }).catch((err) => {
        console.error("Unable to open session dropdown context menu:", err);
      });
    },
    [handleArchive, handleCopyId, handleDelete, handlePin, handleRename, t],
  );

  const groupLabelMap = useMemo<Record<string, string>>(
    () => ({
      split: t("sessionDropdown.split", "Split"),
      pinned: t("sessionDropdown.pinned", "Pinned"),
      today: t("sessionDropdown.today", "Today"),
      yesterday: t("sessionDropdown.yesterday", "Yesterday"),
      lastWeek: t("sessionDropdown.lastWeek", "Last 7 Days"),
      older: t("sessionDropdown.older", "Older"),
    }),
    [t],
  );

  return createPortal(
    <div
      ref={panelRef}
      className="session-dropdown-panel"
      style={{ left: position.left, top: position.top }}
    >
      {/* Search */}
      <div className="session-dropdown-search">
        <Search size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
        <input
          ref={searchRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("sessionDropdown.searchPlaceholder", "Search sessions...")}
          className="flex-1 min-w-0 bg-transparent text-[12px] text-foreground font-sans outline-none placeholder:text-muted"
        />
        <kbd className="session-dropdown-kbd">⌘K</kbd>
      </div>

      {/* Filter pills + count */}
      <div className="session-dropdown-filters">
        <div className="flex items-center" style={{ gap: 4 }}>
          {(["all", "starred", "archived"] as const).map((f) => (
            <button
              key={f}
              className={`session-dropdown-pill${filter === f ? " active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {t(
                `sessionDropdown.filter${f[0].toUpperCase()}${f.slice(1)}` as `sessionDropdown.filterAll`,
                f,
              )}
            </button>
          ))}
        </div>
        <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
          {t("sessionDropdown.sessionCount", {
            count: filtered.length,
            defaultValue: `${filtered.length} sessions`,
          })}
        </span>
      </div>

      {/* Session list */}
      <div className="session-dropdown-list">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="session-dropdown-group-label">
              {groupLabelMap[group.label] ?? group.label}
            </div>
            {group.conversations.map((conv) => {
              const isActive = conv.id === activeConversationId;
              const status = getStatus(conv.id);
              const isRenaming = renamingId === conv.id;
              return (
                <div
                  key={conv.id}
                  className={`session-dropdown-row${isActive ? " active" : ""}`}
                  onClick={isRenaming ? undefined : () => handleSelectRow(conv.id)}
                  onPointerDown={isRenaming ? undefined : (e) => handleRowPointerDown(conv.id, e)}
                  onContextMenu={(e) => {
                    if (isRenaming) return;
                    e.preventDefault();
                    e.stopPropagation();
                    handleOpenContextMenu(conv, e.clientX, e.clientY);
                  }}
                >
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={renameTitle}
                      onChange={(e) => setRenameTitle(e.target.value)}
                      onBlur={() => handleSubmitRename(conv.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleSubmitRename(conv.id);
                        }
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setRenamingId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 min-w-0 bg-surface border border-border-strong rounded px-2 text-[12px] text-foreground font-sans outline-none"
                      style={{ height: 24 }}
                    />
                  ) : (
                    <>
                      {conv.parent_conversation_id && (
                        <GitFork
                          size={11}
                          style={{ color: "var(--color-accent-purple)", flexShrink: 0 }}
                          aria-label={t("chat.forkedFrom")}
                        />
                      )}
                      <span className="truncate flex-1 min-w-0" style={{ fontSize: 13 }}>
                        {formatConversationTitle(conv.title)}
                      </span>
                      {splitConversationIds.has(conv.id) && (
                        <SplitBadge label={t("splitView.badge.label")} />
                      )}
                      <RowStatusIndicator status={status} />
                      {conv.is_pinned && (
                        <Pin
                          size={11}
                          style={{ color: "rgba(var(--theme-accent-rgb),0.5)", flexShrink: 0 }}
                        />
                      )}
                      <span className="session-dropdown-time">
                        {formatRelativeTime(conv.updated_at)}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              {searchQuery.trim()
                ? t("conversations.noMatching", "No matching conversations")
                : t("conversations.noConversations", "No conversations yet")}
            </span>
          </div>
        )}
      </div>
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
    </div>,
    document.body,
  );
}
