import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Timer } from "lucide-react";
import { useConversationStore, useAppStore, useChatStore, useAgentStatusStore } from "@/stores";
import { useConversationStatus } from "@/hooks/use-conversation-status";
import { AllSessionsDialog } from "./all-sessions-dialog";

function formatTimeAgo(
  dateStr: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return t("workspace.timeAgo.justNow");
  if (diffMin < 60) return t("workspace.timeAgo.minutesAgo", { count: diffMin });

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return t("workspace.timeAgo.hoursAgo", { count: diffHours });

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return t("workspace.timeAgo.yesterday");
  return t("workspace.timeAgo.daysAgo", { count: diffDays });
}

const DOT_COLORS = ["#A855F7", "#10B981", "#6366F1", "#3B82F6", "#F59E0B", "#EF4444"];

export function WorkspaceSessionsSection({
  workspaceId: _workspaceId,
}: {
  readonly workspaceId: string;
}) {
  const { t } = useTranslation();
  const conversations = useConversationStore((s) => s.conversations);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const { isActiveConversationStreaming } = useConversationStatus();

  const [showAllSessions, setShowAllSessions] = useState(false);

  const recentSessions = useMemo(() => {
    return conversations;
  }, [conversations]);

  const handleSessionClick = useCallback(
    async (convId: string) => {
      const currentConvId = useConversationStore.getState().activeConversationId;

      // Already viewing this conversation — just switch to chat view
      if (convId === currentConvId) {
        useAppStore.getState().setActiveView("chat");
        return;
      }

      // Preserve current conversation's state before switching away
      const chatState = useChatStore.getState();
      if (currentConvId) {
        useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
        if (isActiveConversationStreaming || chatState.messages.length > 0) {
          chatState.saveSnapshot(currentConvId);
        }
      }

      // Clear stale agent status before loading
      useAgentStatusStore.getState().resetLiveStatus({
        lastUsage: null,
        subagents: [],
        todos: [],
      });

      // Switch and load messages (restores snapshot + streaming state if any)
      switchConversation(convId);
      await loadMessages(convId);

      useAppStore.getState().setActiveView("chat");
    },
    [switchConversation, loadMessages, isActiveConversationStreaming],
  );

  const handleViewAll = useCallback(() => {
    setShowAllSessions(true);
  }, []);

  return (
    <div
      className="flex flex-col flex-1 min-w-0"
      style={{
        height: "100%",
        minWidth: 260,
        gap: 10,
        backgroundColor: "var(--color-surface)",
        borderRadius: 16,
        border: "1px solid var(--color-border)",
        padding: 20,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between w-full">
        <div className="flex items-center" style={{ gap: 8 }}>
          <Timer size={14} style={{ color: "#6366F1" }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--color-muted-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {t("workspace.recentSessions")}
          </span>
        </div>
        <button
          onClick={handleViewAll}
          style={{
            fontSize: 11,
            fontWeight: "normal",
            color: "var(--color-muted-foreground)",
            fontFamily: "Inter, sans-serif",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          {t("workspace.viewAll") + " \u2192"}
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 min-h-0 flex flex-col" style={{ gap: 4, overflow: "hidden" }}>
        {recentSessions.length === 0 && (
          <div style={{ padding: "8px 12px" }}>
            <span
              style={{
                fontSize: 12,
                color: "var(--color-muted)",
                fontFamily: "Inter, sans-serif",
              }}
            >
              {t("workspace.noSessions", "No sessions yet")}
            </span>
          </div>
        )}
        {recentSessions.map((session, index) => (
          <button
            key={session.id}
            onClick={() => handleSessionClick(session.id)}
            className="flex items-center justify-between w-full text-left native-css-hover"
            style={
              {
                padding: "8px 12px",
                borderRadius: 6,
                backgroundColor: "transparent",
                border: "none",
                cursor: "pointer",
                transition: "background-color 0.15s ease",
                "--native-hover-bg-color": "var(--color-surface-alt)",
              } as React.CSSProperties
            }
          >
            <div className="flex items-center min-w-0" style={{ gap: 8 }}>
              <div
                className="shrink-0"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  backgroundColor: DOT_COLORS[index % DOT_COLORS.length],
                }}
              />

              <span
                className="truncate"
                style={{
                  fontSize: 12,
                  fontWeight: "normal",
                  color: "var(--color-foreground)",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {session.title || t("workspace.untitledSession")}
              </span>
            </div>
            <span
              className="shrink-0"
              style={{
                fontSize: 10,
                fontWeight: "normal",
                color: "var(--color-muted)",
                fontFamily: "Inter, sans-serif",
                marginLeft: 12,
              }}
            >
              {formatTimeAgo(session.updated_at, t)}
            </span>
          </button>
        ))}
      </div>

      <AllSessionsDialog open={showAllSessions} onClose={() => setShowAllSessions(false)} />
    </div>
  );
}
