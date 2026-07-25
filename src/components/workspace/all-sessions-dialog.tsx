import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Check,
  Trash2,
  Download,
  GitFork,
} from "lucide-react";
import { useConversationStore, useAppStore, useChatStore, useAgentStatusStore } from "@/stores";
import type { ConversationSummary } from "@/stores/conversation-store";
import { useToastStore } from "@/stores/toast-store";
import { formatError } from "@/lib/format-error";
import { formatConversationTitle, formatConversationPreview } from "@/lib/conversation-text";
import { getAgentColor, getAgentLabel } from "@/components/chat/conversation-list-types";
import { formatRelativeTime } from "@/components/chat/message-config";
import { useConversationStatus } from "@/hooks/use-conversation-status";

// ── Types ──────────────────────────────────────────────────────────

type TimeFilter = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

interface TimeFilterGroup {
  readonly key: TimeFilter;
  readonly conversations: ReadonlyArray<ConversationSummary>;
}

// ── Helpers ─────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

function groupByTimeFilter(
  conversations: ReadonlyArray<ConversationSummary>,
): ReadonlyArray<TimeFilterGroup> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const today: ConversationSummary[] = [];
  const yesterday: ConversationSummary[] = [];
  const thisWeek: ConversationSummary[] = [];
  const thisMonth: ConversationSummary[] = [];
  const older: ConversationSummary[] = [];

  for (const conv of conversations) {
    const ts = new Date(conv.updated_at).getTime();
    if (ts >= todayStart) {
      today.push(conv);
    } else if (ts >= yesterdayStart) {
      yesterday.push(conv);
    } else if (ts >= weekStart) {
      thisWeek.push(conv);
    } else if (ts >= monthStart) {
      thisMonth.push(conv);
    } else {
      older.push(conv);
    }
  }

  const groups: TimeFilterGroup[] = [];
  if (today.length > 0) groups.push({ key: "today", conversations: today });
  if (yesterday.length > 0) groups.push({ key: "yesterday", conversations: yesterday });
  if (thisWeek.length > 0) groups.push({ key: "thisWeek", conversations: thisWeek });
  if (thisMonth.length > 0) groups.push({ key: "thisMonth", conversations: thisMonth });
  if (older.length > 0) groups.push({ key: "older", conversations: older });

  return groups;
}

// ── Component ───────────────────────────────────────────────────────

interface AllSessionsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function AllSessionsDialog({ open, onClose }: AllSessionsDialogProps) {
  const { t } = useTranslation();
  const conversations = useConversationStore((s) => s.conversations);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const { isActiveConversationStreaming } = useConversationStatus();

  const [activeFilter, setActiveFilter] = useState<TimeFilter | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setCurrentPage(1);
      setSelectedIds(new Set());
      setActiveFilter(null);
      setConfirmingDelete(false);
    }
  }, [open]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const visibleConversations = useMemo(
    () => conversations.filter((c) => !c.is_archived),
    [conversations],
  );

  // Group conversations by time
  const timeGroups = useMemo(() => groupByTimeFilter(visibleConversations), [visibleConversations]);

  // Filtered conversations based on active filter + search
  const filteredConversations = useMemo(() => {
    let result: ReadonlyArray<ConversationSummary>;

    if (activeFilter) {
      const group = timeGroups.find((g) => g.key === activeFilter);
      result = group?.conversations ?? [];
    } else {
      result = visibleConversations;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q),
      );
    }

    return result;
  }, [visibleConversations, timeGroups, activeFilter, searchQuery]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredConversations.length / PAGE_SIZE));
  const paginatedConversations = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredConversations.slice(start, start + PAGE_SIZE);
  }, [filteredConversations, currentPage]);

  // Reset page and confirm state when filter/search changes
  useEffect(() => {
    setCurrentPage(1);
    setConfirmingDelete(false);
  }, [activeFilter, searchQuery]);

  // Count per filter
  const filterCounts = useMemo(() => {
    const counts: Record<TimeFilter, number> = {
      today: 0,
      yesterday: 0,
      thisWeek: 0,
      thisMonth: 0,
      older: 0,
    };
    for (const group of timeGroups) {
      counts[group.key] = group.conversations.length;
    }
    return counts;
  }, [timeGroups]);

  const handleSessionClick = useCallback(
    async (convId: string) => {
      const currentConvId = useConversationStore.getState().activeConversationId;

      if (convId === currentConvId) {
        useAppStore.getState().setActiveView("chat");
        onClose();
        return;
      }

      try {
        const chatState = useChatStore.getState();
        if (currentConvId) {
          useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
          if (isActiveConversationStreaming || chatState.messages.length > 0) {
            chatState.saveSnapshot(currentConvId);
          }
        }

        useAgentStatusStore.getState().resetLiveStatus({
          lastUsage: null,
          subagents: [],
          todos: [],
        });

        switchConversation(convId);
        await loadMessages(convId);
        useAppStore.getState().setActiveView("chat");
        onClose();
      } catch (err) {
        useToastStore
          .getState()
          .addToast("error", `Failed to load conversation: ${formatError(err)}`);
      }
    },
    [switchConversation, loadMessages, isActiveConversationStreaming, onClose],
  );

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === paginatedConversations.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedConversations.map((c) => c.id)));
    }
  }, [paginatedConversations, selectedIds]);

  const handleDeleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;

    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }

    setConfirmingDelete(false);

    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(ids.map((id) => deleteConversation(id)));

    const failedCount = results.filter((r) => r.status === "rejected").length;
    if (failedCount > 0) {
      useToastStore
        .getState()
        .addToast("error", t("allSessions.deleteFailed", { count: failedCount }));
    }

    setSelectedIds(new Set());
  }, [selectedIds, deleteConversation, confirmingDelete, t]);

  if (!open) return null;

  const filterLabels: Record<TimeFilter, string> = {
    today: t("allSessions.today"),
    yesterday: t("allSessions.yesterday"),
    thisWeek: t("allSessions.thisWeek"),
    thisMonth: t("allSessions.thisMonth"),
    older: t("allSessions.older"),
  };

  const filters: TimeFilter[] = ["today", "yesterday", "thisWeek", "thisMonth", "older"];

  const startItem = (currentPage - 1) * PAGE_SIZE + 1;
  const endItem = Math.min(currentPage * PAGE_SIZE, filteredConversations.length);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.5)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        style={{
          width: 820,
          height: 540,
          borderRadius: 14,
          backgroundColor: "var(--color-card)",
          border: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
        }}
      >
        {/* ── Header ────────────────────────────────────────────── */}
        <div
          style={{
            height: 52,
            padding: "0 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--color-border)",
            flexShrink: 0,
          }}
        >
          {/* Left: Title + Count */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--color-foreground)",
                opacity: 0.8,
              }}
            >
              {t("allSessions.title")}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "var(--color-accent-purple)",
                backgroundColor: "rgba(var(--theme-accent-rgb),0.125)",
                borderRadius: 10,
                padding: "2px 8px",
              }}
            >
              {conversations.length}
            </span>
          </div>

          {/* Right: Search + Close */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* Search Box */}
            <div
              style={{
                width: 220,
                height: 32,
                borderRadius: 8,
                backgroundColor: "rgba(26,26,31,0.5)",
                border: "1px solid var(--color-border)",
                display: "flex",
                alignItems: "center",
                padding: "0 10px",
                gap: 8,
              }}
            >
              <Search
                size={12}
                style={{ color: "var(--color-muted)", opacity: 0.6, flexShrink: 0 }}
              />
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("allSessions.searchPlaceholder")}
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: "var(--color-foreground)",
                  backgroundColor: "transparent",
                  border: "none",
                  outline: "none",
                  fontFamily: "Inter, sans-serif",
                }}
              />

              <span
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: "var(--color-muted)",
                  opacity: 0.6,
                  backgroundColor: "rgba(58,58,60,0.375)",
                  borderRadius: 4,
                  padding: "2px 6px",
                }}
              >
                ⌘K
              </span>
            </div>

            {/* Close Button */}
            <button
              onClick={onClose}
              style={
                {
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: "rgba(58,58,60,0.25)",
                  border: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  color: "var(--color-muted)",
                  opacity: 0.7,
                  transition: "background-color 0.15s ease, opacity 0.15s ease",
                  "--native-hover-bg-color": "rgba(58,58,60,0.5)",
                  "--native-hover-opacity": "1",
                } as React.CSSProperties
              }
              className="native-css-hover"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* ── Content Area ──────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* Sidebar */}
          <div
            style={{
              width: 190,
              borderRight: "1px solid var(--color-border)",
              padding: "12px 0",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              flexShrink: 0,
            }}
          >
            {/* Section title */}
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: "var(--color-muted)",
                opacity: 0.6,
                letterSpacing: 1.5,
                padding: "0 16px",
                marginBottom: 4,
                textTransform: "uppercase",
              }}
            >
              {t("allSessions.timeRange")}
            </span>

            {filters.map((filter) => {
              const isActive = activeFilter === filter;
              const count = filterCounts[filter];
              return (
                <button
                  key={filter}
                  onClick={() => setActiveFilter(isActive ? null : filter)}
                  className="native-css-hover"
                  style={
                    {
                      height: 36,
                      padding: "0 16px",
                      borderRadius: 8,
                      margin: "0 8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      border: "none",
                      cursor: "pointer",
                      backgroundColor: isActive ? "rgba(var(--theme-accent-rgb),0.08)" : "transparent",
                      "--native-hover-bg-color": !isActive ? "rgba(255,255,255,0.03)" : undefined,
                    } as React.CSSProperties
                  }
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? 500 : 400,
                      color: isActive
                        ? "var(--color-accent-purple)"
                        : "var(--color-muted-foreground)",
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    {filterLabels[filter]}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: isActive ? 600 : 500,
                      color: isActive ? "var(--color-accent-purple)" : "var(--color-muted)",
                      opacity: isActive ? 1 : 0.6,
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* List Area */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {/* Scrollable list */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "8px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {paginatedConversations.length === 0 ? (
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--color-muted)",
                    fontSize: 13,
                  }}
                >
                  {searchQuery ? t("allSessions.noResults") : t("allSessions.noConversations")}
                </div>
              ) : (
                paginatedConversations.map((conv, idx) => (
                  <ConversationCard
                    key={conv.id}
                    conversation={conv}
                    isFirst={idx === 0 && currentPage === 1 && !searchQuery}
                    isSelected={selectedIds.has(conv.id)}
                    onToggleSelect={() => {
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(conv.id)) {
                          next.delete(conv.id);
                        } else {
                          next.add(conv.id);
                        }
                        return next;
                      });
                    }}
                    onClick={() => handleSessionClick(conv.id)}
                  />
                ))
              )}
            </div>

            {/* Bottom Bar */}
            <div
              style={{
                height: 44,
                padding: "0 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderTop: "1px solid var(--color-border)",
                flexShrink: 0,
              }}
            >
              {/* Left: Actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ActionButton
                  icon={<CheckSquare size={12} />}
                  label={t("allSessions.selectAll")}
                  onClick={handleSelectAll}
                />

                <ActionButton
                  icon={<Trash2 size={12} />}
                  label={
                    confirmingDelete
                      ? t("allSessions.confirmDelete", { count: selectedIds.size })
                      : t("allSessions.delete")
                  }
                  onClick={handleDeleteSelected}
                  danger
                  disabled={selectedIds.size === 0}
                />

                <ActionButton
                  icon={<Download size={12} />}
                  label={t("allSessions.export")}
                  onClick={() => {
                    /* TODO: export */
                  }}
                />
              </div>

              {/* Right: Pagination */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--color-muted)",
                    opacity: 0.6,
                    fontFamily: "Inter, sans-serif",
                  }}
                >
                  {filteredConversations.length > 0
                    ? `${startItem}-${endItem} / ${filteredConversations.length}`
                    : `0 / 0`}
                </span>
                <PaginationButton
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={14} />
                </PaginationButton>
                <PaginationButton
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                >
                  <ChevronRight size={14} />
                </PaginationButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Conversation Card ───────────────────────────────────────────────

interface ConversationCardProps {
  readonly conversation: ConversationSummary;
  readonly isFirst: boolean;
  readonly isSelected: boolean;
  readonly onToggleSelect: () => void;
  readonly onClick: () => void;
}

function ConversationCard({
  conversation,
  isFirst,
  isSelected,
  onToggleSelect,
  onClick,
}: ConversationCardProps) {
  const { t } = useTranslation();
  const agentColor = getAgentColor(conversation.model);
  const agentLabel = getAgentLabel(conversation.model);
  const displayTitle = formatConversationTitle(conversation.title);
  const displayPreview = formatConversationPreview(conversation.preview);
  const timeStr = formatRelativeTime(conversation.updated_at);

  const isHighlighted = isFirst || isSelected;

  return (
    <div
      onClick={onClick}
      className="native-css-hover"
      style={
        {
          padding: "12px 14px",
          borderRadius: 10,
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          cursor: "pointer",
          border: isHighlighted
            ? "1px solid rgba(var(--theme-accent-rgb),0.19)"
            : "1px solid rgba(39,39,42,0.375)",
          backgroundColor: isHighlighted ? "rgba(var(--theme-accent-rgb),0.063)" : "transparent",
          "--native-hover-bg-color": !isHighlighted ? "rgba(255,255,255,0.02)" : undefined,
          "--native-hover-border-color": !isHighlighted ? "rgba(39,39,42,0.6)" : undefined,
        } as React.CSSProperties
      }
    >
      {/* Checkbox */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        style={
          {
            flexShrink: 0,
            width: 18,
            height: 18,
            marginTop: 1,
            borderRadius: 4,
            border: isSelected
              ? "1px solid var(--color-accent-purple)"
              : "1px solid rgba(255,255,255,0.15)",
            backgroundColor: isSelected ? "var(--color-accent-purple)" : "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            padding: 0,
            "--native-hover-bg-color": !isSelected ? "rgba(var(--theme-accent-rgb),0.1)" : undefined,
            "--native-hover-border-color": !isSelected ? "rgba(var(--theme-accent-rgb),0.5)" : undefined,
          } as React.CSSProperties
        }
        className="native-css-hover"
      >
        {isSelected && <Check size={12} style={{ color: "#fff" }} />}
      </button>

      {/* Card content */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Top: Title + Time */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          {conversation.parent_conversation_id && (
            <GitFork
              size={12}
              style={{ color: "var(--color-accent-purple)", flexShrink: 0, marginRight: 5 }}
              aria-label={t("chat.forkedFrom")}
            />
          )}
          <span
            style={{
              fontSize: 13,
              fontWeight: isHighlighted ? 600 : 500,
              color: isHighlighted ? "var(--color-foreground)" : "var(--color-muted-foreground)",
              fontFamily: "Inter, sans-serif",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayTitle}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--color-muted)",
              opacity: 0.6,
              fontFamily: "Inter, sans-serif",
              flexShrink: 0,
              marginLeft: 12,
            }}
          >
            {timeStr}
          </span>
        </div>

        {/* Preview */}
        {displayPreview && (
          <span
            style={{
              fontSize: 12,
              color: "var(--color-muted)",
              opacity: isHighlighted ? 0.6 : 0.5,
              fontFamily: "Inter, sans-serif",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayPreview}
          </span>
        )}

        {/* Meta: Agent badge + tokens + messages */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Agent badge */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 6px",
              borderRadius: 4,
              backgroundColor: `${agentColor}20`,
              fontSize: 10,
              fontWeight: 500,
              color: agentColor,
              fontFamily: "Inter, sans-serif",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                backgroundColor: agentColor,
              }}
            />

            {agentLabel}
          </span>

          {/* Message count */}
          {conversation.message_count > 0 && (
            <>
              <span
                style={{
                  width: 3,
                  height: 3,
                  borderRadius: "50%",
                  backgroundColor: "var(--color-muted)",
                  opacity: 0.4,
                }}
              />

              <span
                style={{
                  fontSize: 10,
                  color: "var(--color-muted)",
                  opacity: 0.5,
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {t("allSessions.messageCount", { count: conversation.message_count })}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Action Button ───────────────────────────────────────────────────

interface ActionButtonProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

function ActionButton({ icon, label, onClick, danger, disabled }: ActionButtonProps) {
  const textColor = danger ? "#FF453A" : "var(--color-muted-foreground)";
  const bgColor = danger ? "rgba(255,69,58,0.12)" : "rgba(58,58,60,0.25)";
  const hoverBg = danger ? "rgba(255,69,58,0.22)" : "rgba(58,58,60,0.45)";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="native-css-hover"
      style={
        {
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderRadius: 6,
          border: "none",
          backgroundColor: bgColor,
          color: textColor,
          fontSize: 11,
          fontWeight: 500,
          fontFamily: "Inter, sans-serif",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.4 : 1,
          "--native-hover-bg-color": !disabled ? hoverBg : undefined,
        } as React.CSSProperties
      }
    >
      {icon}
      {label}
    </button>
  );
}

// ── Pagination Button ───────────────────────────────────────────────

interface PaginationButtonProps {
  readonly children: React.ReactNode;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

function PaginationButton({ children, disabled, onClick }: PaginationButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="native-css-hover"
      style={
        {
          width: 26,
          height: 26,
          borderRadius: 6,
          backgroundColor: "rgba(58,58,60,0.25)",
          border: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "not-allowed" : "pointer",
          color: disabled ? "var(--color-muted)" : "var(--color-foreground)",
          opacity: disabled ? 0.3 : 0.6,
          "--native-hover-bg-color": !disabled ? "rgba(58,58,60,0.45)" : undefined,
          "--native-hover-opacity": !disabled ? "0.9" : undefined,
        } as React.CSSProperties
      }
    >
      {children}
    </button>
  );
}
