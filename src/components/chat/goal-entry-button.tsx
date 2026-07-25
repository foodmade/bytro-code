import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Target } from "lucide-react";
import { Tooltip } from "@/components/ui";
import {
  useAgentStatusStore,
  useConversationStore,
  useGoalSessionStore,
  useToolStateStore,
} from "@/stores";
import {
  deriveGoalProgress,
  formatGoalDuration,
  normalizeGoalStatus,
  resolveGoalElapsedMs,
  type GoalStatus,
} from "./goal-utils";
import { useStreamStateStore } from "@/stores/stream-state-store";

function getStatusColor(status: GoalStatus): string {
  switch (status) {
    case "completed":
      return "var(--color-accent-success)";
    case "blocked":
    case "failed":
      return "var(--color-accent-danger)";
    case "paused":
      return "#F59E0B";
    case "active":
      return "var(--color-accent-info)";
    case "inactive":
      return "var(--color-muted-foreground)";
  }
}

export function GoalEntryButton(_props: { readonly compact?: boolean } = {}) {
  const { t } = useTranslation();
  const conversationId = useConversationStore((s) => s.activeConversationId);
  const goal = useGoalSessionStore((s) =>
    conversationId ? (s.goalsByConversation[conversationId] ?? null) : null,
  );
  const panelOpen = useGoalSessionStore((s) =>
    conversationId ? s.openByConversation[conversationId] === true : s.pendingOpen,
  );
  const setPanelOpen = useGoalSessionStore((s) => s.setPanelOpen);
  const bindPendingToConversation = useGoalSessionStore((s) => s.bindPendingToConversation);
  const todos = useAgentStatusStore((s) => s.todos);
  const streamElapsed = useStreamStateStore((s) => s.streamElapsed);
  const pendingAsk = useToolStateStore((s) =>
    conversationId ? s.pendingAskUserQuestions[conversationId] : undefined,
  );

  useEffect(() => {
    if (conversationId) bindPendingToConversation(conversationId);
  }, [bindPendingToConversation, conversationId]);

  const status = pendingAsk ? ("blocked" as const) : goal ? goal.status : ("inactive" as const);
  const progress = useMemo(
    () => deriveGoalProgress(todos, normalizeGoalStatus(status), pendingAsk ? 1 : 0),
    [pendingAsk, status, todos],
  );
  const elapsed = formatGoalDuration(
    resolveGoalElapsedMs({
      goal,
      streamElapsedMs: streamElapsed,
    }),
  );

  const handleClick = useCallback(() => {
    const next = !panelOpen;
    setPanelOpen(conversationId, next);
  }, [conversationId, panelOpen, setPanelOpen]);

  const tooltip = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <strong style={{ fontSize: 11 }}>{goal?.objective || t("chat.goal.noGoal")}</strong>
      <span style={{ color: "var(--color-muted-foreground)" }}>
        {progress.percentage == null
          ? t("chat.goal.tooltipNoProgress", { status: t(`chat.goal.status.${status}`), elapsed })
          : t("chat.goal.tooltip", {
              percent: progress.percentage,
              status: t(`chat.goal.status.${status}`),
              elapsed,
            })}
      </span>
    </div>
  );

  const color = getStatusColor(status);
  const Icon =
    status === "completed"
      ? CheckCircle2
      : status === "blocked" || status === "failed"
        ? AlertTriangle
        : Target;

  return (
    <Tooltip content={tooltip}>
      <button
        type="button"
        onClick={handleClick}
        aria-label={t("chat.goal.entryLabel")}
        aria-pressed={panelOpen}
        className="flex items-center justify-center cursor-pointer native-css-hover"
        style={
          {
            width: 32,
            height: 32,
            borderRadius: 8,
            border: "none",
            position: "relative",
            color,
            backgroundColor: panelOpen
              ? "color-mix(in srgb, var(--color-accent-info) 12%, transparent)"
              : "transparent",
            "--native-hover-bg-color": panelOpen
              ? "color-mix(in srgb, var(--color-accent-info) 16%, transparent)"
              : "rgba(var(--hover-overlay-rgb), 0.10)",
          } as React.CSSProperties
        }
      >
        <Icon size={14} />
        {status !== "inactive" && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              right: 7,
              top: 7,
              width: 5,
              height: 5,
              borderRadius: 999,
              backgroundColor: color,
              boxShadow: `0 0 0 2px var(--color-background)`,
            }}
          />
        )}
        {progress.percentage != null && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 7,
              right: 7,
              bottom: 5,
              height: 2,
              borderRadius: 999,
              backgroundColor: "var(--color-border)",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                width: `${Math.max(4, Math.min(100, progress.percentage))}%`,
                height: "100%",
                borderRadius: 999,
                backgroundColor: color,
              }}
            />
          </span>
        )}
      </button>
    </Tooltip>
  );
}
