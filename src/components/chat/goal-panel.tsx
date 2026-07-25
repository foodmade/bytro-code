import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Code2,
  Clock3,
  FileText,
  FolderOpen,
  ListChecks,
  RotateCcw,
  Target,
  X,
} from "lucide-react";
import {
  useAgentStatusStore,
  useChatStore,
  useCheckpointStore,
  useConversationStore,
  useGoalSessionStore,
  useToolStateStore,
  useWorkspaceStore,
} from "@/stores";
import { useStreamStateStore } from "@/stores/stream-state-store";
import {
  deriveGoalProgress,
  formatGoalDuration,
  formatGoalTokens,
  normalizeGoalStatus,
  resolveGoalElapsedMs,
  resolveGoalTokens,
  type GoalStatus,
} from "./goal-utils";
import {
  baseName,
  parseUserContent,
  type AttachmentBlock,
  type SelectionSnippetRef,
} from "./message-config";
import type { GoalActivityItem } from "@/stores/goal-session-store";

const EMPTY_GOAL_ACTIVITIES: ReadonlyArray<GoalActivityItem> = [];

function statusColor(status: GoalStatus): string {
  switch (status) {
    case "completed": return "var(--color-accent-success)";
    case "blocked":
    case "failed": return "var(--color-accent-danger)";
    case "paused": return "#F59E0B";
    case "active": return "var(--color-accent-info)";
    case "inactive": return "var(--color-muted-foreground)";
  }
}

function relativeTime(ts: number, now: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return t("chat.goal.time.secondsAgo", { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("chat.goal.time.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  return t("chat.goal.time.hoursAgo", { count: hours });
}

function metricStyle(color: string): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    height: 30,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color,
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    fontWeight: 800,
    backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 24%, transparent)`,
  };
}

function GoalAttachmentChip({ attachment }: { readonly attachment: AttachmentBlock }) {
  const isDir = attachment.kind === "directory";
  const color = isDir ? "#F59E0B" : "#A78BFA";
  const name = baseName(attachment.path);

  return (
    <span
      title={attachment.path}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: "100%",
        minWidth: 0,
        height: 24,
        padding: "0 8px",
        borderRadius: 6,
        backgroundColor: isDir ? "rgba(245,158,11,0.1)" : "rgba(var(--theme-accent-rgb),0.1)",
        border: `1px solid ${isDir ? "rgba(245,158,11,0.22)" : "rgba(var(--theme-accent-rgb),0.24)"}`,
        color,
        verticalAlign: "middle",
      }}
    >
      {isDir ? <FolderOpen size={12} style={{ flexShrink: 0 }} /> : <FileText size={12} style={{ flexShrink: 0 }} />}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontWeight: 800 }}>
        {name}
      </span>
    </span>
  );
}

function GoalSelectionChip({ selection }: { readonly selection: SelectionSnippetRef }) {
  const label = selection.label || baseName(selection.path) || selection.id;

  return (
    <span
      title={selection.path || label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: "100%",
        minWidth: 0,
        height: 24,
        padding: "0 8px",
        borderRadius: 6,
        backgroundColor: "color-mix(in srgb, var(--color-accent-info) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-accent-info) 24%, transparent)",
        color: "var(--color-accent-info)",
        verticalAlign: "middle",
      }}
    >
      <Code2 size={12} style={{ flexShrink: 0 }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontWeight: 800 }}>
        {label}
      </span>
    </span>
  );
}

function GoalObjectiveContent({
  objective,
  fallback,
}: {
  readonly objective: string | undefined;
  readonly fallback: string;
}) {
  const value = objective?.trim() ? objective : fallback;
  const parsed = useMemo(() => parseUserContent(value), [value]);
  const hasStructuredRefs = parsed.attachments.length > 0 || parsed.selections.length > 0;

  if (!hasStructuredRefs) {
    return (
      <strong style={{ color: "var(--color-foreground)", fontSize: 14, lineHeight: 1.25, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
        {value}
      </strong>
    );
  }

  return (
    <div
      style={{
        color: "var(--color-foreground)",
        fontSize: 14,
        lineHeight: 1.4,
        fontWeight: 800,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 6px",
        minWidth: 0,
      }}
    >
      {parsed.segments.map((segment, index) => {
        if (segment.type === "attachment") {
          return <GoalAttachmentChip key={`goal-att-${index}-${segment.attachment.path}`} attachment={segment.attachment} />;
        }
        if (segment.type === "selection") {
          return <GoalSelectionChip key={`goal-sel-${index}-${segment.selection.id}`} selection={segment.selection} />;
        }
        return (
          <span key={`goal-text-${index}`} style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
            {segment.text}
          </span>
        );
      })}
    </div>
  );
}

function compactActivityMessage(message: string): string {
  const parsed = parseUserContent(message);
  if (parsed.attachments.length === 0 && parsed.selections.length === 0) {
    return message.replace(/\s+/g, " ").trim();
  }

  const parts = parsed.segments.flatMap((segment) => {
    if (segment.type === "text") {
      const text = segment.text.replace(/\s+/g, " ").trim();
      return text ? [text] : [];
    }
    if (segment.type === "attachment") {
      return [baseName(segment.attachment.path)];
    }
    return [segment.selection.label || baseName(segment.selection.path) || segment.selection.id];
  });

  return parts.join(" ").trim();
}

export function GoalPanel() {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const confirmRestoreTimerRef = useRef<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  const conversationId = useConversationStore((s) => s.activeConversationId);
  const panelWidth = useGoalSessionStore((s) => s.panelWidth);
  const setPanelWidth = useGoalSessionStore((s) => s.setPanelWidth);
  const setPanelOpen = useGoalSessionStore((s) => s.setPanelOpen);
  const goal = useGoalSessionStore((s) => conversationId ? s.goalsByConversation[conversationId] ?? null : null);
  const activities = useGoalSessionStore((s) =>
    conversationId ? s.activityByConversation[conversationId] ?? EMPTY_GOAL_ACTIVITIES : EMPTY_GOAL_ACTIVITIES,
  );
  const todos = useAgentStatusStore((s) => s.todos);
  const usage = useAgentStatusStore((s) => s.lastUsage);
  const streamUsage = useAgentStatusStore((s) => s.streamUsage);
  const streamElapsed = useStreamStateStore((s) => s.streamElapsed);
  const pendingAsk = useToolStateStore((s) => conversationId ? s.pendingAskUserQuestions[conversationId] : undefined);
  const hasPendingConfirmation = useChatStore((s) =>
    s.messages.some((m) => m.toolCalls?.some((tc) => tc.status === "pending_confirmation")),
  );
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");
  const checkpointState = useCheckpointStore((s) => s.getConversationCheckpoints(conversationId));
  const restoreCheckpoint = useCheckpointStore((s) => s.restoreCheckpoint);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (confirmRestoreTimerRef.current !== null) {
        window.clearTimeout(confirmRestoreTimerRef.current);
      }
    };
  }, []);

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    startXRef.current = event.clientX;
    startWidthRef.current = panel.getBoundingClientRect().width;
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (event: MouseEvent) => {
      const delta = startXRef.current - event.clientX;
      setPanelWidth(startWidthRef.current + delta);
    };
    const onMouseUp = () => setDragging(false);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging, setPanelWidth]);

  const blockedSignals = (pendingAsk ? 1 : 0) + (hasPendingConfirmation ? 1 : 0);
  const effectiveStatus = normalizeGoalStatus(blockedSignals > 0 ? "blocked" : goal?.status);
  const progress = useMemo(
    () => deriveGoalProgress(todos, effectiveStatus, blockedSignals),
    [blockedSignals, effectiveStatus, todos],
  );
  const elapsed = formatGoalDuration(resolveGoalElapsedMs({
    goal,
    streamElapsedMs: streamElapsed,
    usage,
  }));
  const tokens = formatGoalTokens(resolveGoalTokens({ goal, usage, streamUsage }));
  const color = statusColor(effectiveStatus);
  const latestCheckpoint = useMemo(
    () => [...checkpointState.checkpoints].sort((a, b) => b.timestamp - a.timestamp)[0] ?? null,
    [checkpointState.checkpoints],
  );

  useEffect(() => {
    if (confirmRestoreTimerRef.current !== null) {
      window.clearTimeout(confirmRestoreTimerRef.current);
      confirmRestoreTimerRef.current = null;
    }
    setConfirmingRestore(false);
  }, [conversationId, latestCheckpoint?.id]);

  const displayActivities = useMemo(() => {
    const checkpointActivity = latestCheckpoint
      ? [{
          id: `checkpoint-${latestCheckpoint.commitId}`,
          timestamp: latestCheckpoint.timestamp,
          kind: "checkpoint" as const,
          message: latestCheckpoint.label,
        }]
      : [];
    return [...checkpointActivity, ...activities].sort((a, b) => b.timestamp - a.timestamp).slice(0, 3);
  }, [activities, latestCheckpoint]);

  const handleClose = useCallback(() => {
    setPanelOpen(conversationId, false);
  }, [conversationId, setPanelOpen]);

  const handleRestore = useCallback(() => {
    if (!conversationId || !workspacePath || !latestCheckpoint || checkpointState.isRestoring) return;
    if (!confirmingRestore) {
      setConfirmingRestore(true);
      if (confirmRestoreTimerRef.current !== null) {
        window.clearTimeout(confirmRestoreTimerRef.current);
      }
      confirmRestoreTimerRef.current = window.setTimeout(() => {
        confirmRestoreTimerRef.current = null;
        setConfirmingRestore(false);
      }, 5000);
      return;
    }
    if (confirmRestoreTimerRef.current !== null) {
      window.clearTimeout(confirmRestoreTimerRef.current);
      confirmRestoreTimerRef.current = null;
    }
    setConfirmingRestore(false);
    restoreCheckpoint(conversationId, workspacePath, latestCheckpoint.id);
  }, [checkpointState.isRestoring, confirmingRestore, conversationId, latestCheckpoint, restoreCheckpoint, workspacePath]);

  const handleCancelRestore = useCallback(() => {
    if (confirmRestoreTimerRef.current !== null) {
      window.clearTimeout(confirmRestoreTimerRef.current);
      confirmRestoreTimerRef.current = null;
    }
    setConfirmingRestore(false);
  }, []);

  const hasGoal = Boolean(goal?.objective || goal?.status);
  const canRestore = Boolean(latestCheckpoint && workspacePath && !checkpointState.isRestoring);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      style={{
        width: panelWidth,
        minWidth: 320,
        maxWidth: 560,
        flexShrink: 0,
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--color-background)",
        borderLeft: "1px solid var(--color-border)",
        outline: "none",
      }}
    >
      <div
        onMouseDown={onMouseDown}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          cursor: "col-resize",
          zIndex: 10,
          backgroundColor: dragging ? "var(--color-accent-info)" : "var(--color-border)",
        }}
      />

      <header style={{ padding: "18px 20px 14px 20px", borderBottom: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <div style={{ width: 30, height: 30, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, backgroundColor: "color-mix(in srgb, var(--color-accent-info) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--color-accent-info) 34%, transparent)" }}>
              <Target size={14} style={{ color: "var(--color-accent-info)" }} />
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-foreground)", whiteSpace: "nowrap" }}>
              {t("chat.goal.title")}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 7px", borderRadius: 999, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`, color, fontSize: 9, fontWeight: 800, textTransform: "uppercase" }}>
              <span style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: color }} />
              {t(`chat.goal.status.${effectiveStatus}`)}
            </span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            title={t("chat.goal.close")}
            style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-muted-foreground)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
          >
            <X size={14} />
          </button>
        </div>
        <span style={{ fontSize: 11, color: "var(--color-muted-foreground)", lineHeight: 1.4 }}>
          {t("chat.goal.subtitle")}
        </span>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        {!hasGoal ? (
          <div style={{ flex: 1, minHeight: 240, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center", color: "var(--color-muted-foreground)" }}>
            <Target size={28} style={{ opacity: 0.45 }} />
            <strong style={{ color: "var(--color-foreground)", fontSize: 13 }}>{t("chat.goal.emptyTitle")}</strong>
            <span style={{ fontSize: 11, lineHeight: 1.45, maxWidth: 260 }}>{t("chat.goal.emptyDescription")}</span>
          </div>
        ) : (
          <>
            <section style={{ borderRadius: 10, padding: 14, backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ color: "var(--color-muted-foreground)", fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800 }}>{t("chat.goal.currentGoal")}</span>
                  <GoalObjectiveContent objective={goal?.objective} fallback={t("chat.goal.untitled")} />
                </div>
                <span style={{ color, fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 900 }}>
                  {progress.percentage == null ? "--" : `${progress.percentage}%`}
                </span>
              </div>
              <div style={{ width: "100%", height: 8, borderRadius: 999, backgroundColor: "var(--color-border)", overflow: "hidden" }}>
                <div style={{ width: `${progress.percentage ?? 36}%`, height: "100%", borderRadius: 999, backgroundColor: color, opacity: progress.percentage == null ? 0.5 : 1 }} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={metricStyle("var(--color-accent-success)")}>{t("chat.goal.metrics.done", { count: progress.completed })}</span>
                <span style={metricStyle("var(--color-accent-info)")}>{t("chat.goal.metrics.running", { count: progress.running })}</span>
                <span style={metricStyle("var(--color-accent-danger)")}>{t("chat.goal.metrics.blocked", { count: progress.blocked })}</span>
              </div>
            </section>

            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontSize: 12, color: "var(--color-foreground)", fontWeight: 800, display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <ListChecks size={13} /> {t("chat.goal.subtasks")}
                </h3>
                <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--color-muted-foreground)" }}>{t("chat.goal.sessionScoped")}</span>
              </div>
              {todos.length === 0 ? (
                <div style={{ border: "1px dashed var(--color-border)", borderRadius: 8, padding: 12, color: "var(--color-muted-foreground)", fontSize: 11 }}>
                  {t("chat.goal.noSubtasks")}
                </div>
              ) : todos.slice(0, 3).map((todo) => {
                const todoColor = todo.status === "completed"
                  ? "var(--color-accent-success)"
                  : todo.status === "in_progress"
                    ? "var(--color-accent-info)"
                    : "var(--color-muted-foreground)";
                return (
                  <div key={`${todo.status}-${todo.content}`} style={{ display: "flex", alignItems: "center", gap: 10, borderRadius: 8, border: "1px solid var(--color-border)", backgroundColor: "rgba(var(--hover-overlay-rgb), 0.025)", padding: 10 }}>
                    {todo.status === "completed" ? <CheckCircle2 size={13} style={{ color: todoColor, flexShrink: 0 }} /> : <Circle size={9} style={{ color: todoColor, fill: todo.status === "in_progress" ? todoColor : "transparent", flexShrink: 0 }} />}
                    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ color: "var(--color-foreground)", fontSize: 11, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{todo.content}</span>
                      <span style={{ color: todoColor, fontFamily: "var(--font-mono)", fontSize: 8, fontWeight: 700 }}>{t(`chat.goal.todoStatus.${todo.status}`)}</span>
                    </div>
                  </div>
                );
              })}
            </section>

            <section style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: "1px solid var(--color-border)" }}>
              <h3 style={{ margin: 0, fontSize: 12, color: "var(--color-foreground)", fontWeight: 800 }}>{t("chat.goal.latestUpdates")}</h3>
              {displayActivities.length === 0 ? (
                <span style={{ color: "var(--color-muted-foreground)", fontSize: 11 }}>{t("chat.goal.noUpdates")}</span>
              ) : displayActivities.map((item) => (
                <div key={item.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
                  {item.kind === "blocked" ? <AlertTriangle size={10} style={{ color: "var(--color-accent-danger)", marginTop: 2, flexShrink: 0 }} /> : item.kind === "checkpoint" ? <RotateCcw size={10} style={{ color: "var(--color-accent-success)", marginTop: 2, flexShrink: 0 }} /> : <Clock3 size={10} style={{ color: "var(--color-accent-info)", marginTop: 2, flexShrink: 0 }} />}
                  <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ color: "var(--color-muted-foreground)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{compactActivityMessage(item.message)}</span>
                    <span style={{ color: "var(--color-muted)", fontFamily: "var(--font-mono)", fontSize: 8 }}>{relativeTime(item.timestamp, now, t)}</span>
                  </div>
                </div>
              ))}
            </section>
          </>
        )}
      </main>

      <footer style={{ flexShrink: 0, padding: 18, borderTop: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={handleRestore}
            disabled={!canRestore}
            style={{
              flex: 1,
              minWidth: 0,
              height: 34,
              borderRadius: 8,
              border: confirmingRestore
                ? "1px solid color-mix(in srgb, var(--color-accent-danger) 48%, var(--color-border))"
                : "1px solid var(--color-border)",
              backgroundColor: confirmingRestore
                ? "color-mix(in srgb, var(--color-accent-danger) 16%, var(--color-surface))"
                : latestCheckpoint
                  ? "var(--color-foreground)"
                  : "var(--color-surface)",
              color: confirmingRestore
                ? "var(--color-accent-danger)"
                : latestCheckpoint
                  ? "var(--color-background)"
                  : "var(--color-muted-foreground)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontSize: 12,
              fontWeight: 800,
              cursor: canRestore ? "pointer" : "not-allowed",
            }}
          >
            {confirmingRestore ? <AlertTriangle size={13} /> : <RotateCcw size={13} />}
            {checkpointState.isRestoring
              ? t("chat.goal.restoring")
              : confirmingRestore
                ? t("chat.goal.restoreConfirmAction")
                : t("chat.goal.resume")}
          </button>
          {confirmingRestore && (
            <button
              type="button"
              onClick={handleCancelRestore}
              style={{
                width: 72,
                height: 34,
                borderRadius: 8,
                border: "1px solid var(--color-border)",
                backgroundColor: "var(--color-surface)",
                color: "var(--color-muted-foreground)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                fontSize: 12,
                fontWeight: 800,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <X size={13} />
              {t("chat.goal.restoreCancel")}
            </button>
          )}
        </div>
        {confirmingRestore && (
          <div style={{ color: "var(--color-accent-danger)", fontSize: 10, lineHeight: 1.35 }}>
            {t("chat.goal.restoreWarning")}
          </div>
        )}
        <div style={{ color: "var(--color-muted-foreground)", fontSize: 10, display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
          <span>{t("chat.goal.elapsed", { value: elapsed })}</span>
          <span>{t("chat.goal.tokens", { value: tokens })}</span>
          <span>{t("chat.goal.checkpoint", { value: latestCheckpoint ? latestCheckpoint.commitId.slice(0, 7) : "--" })}</span>
        </div>
        <div style={{ color: "var(--color-muted)", fontSize: 9, fontFamily: "var(--font-mono)" }}>
          {t("chat.goal.source", {
            source: goal?.source === "notification" ? t("chat.goal.sources.notification") : goal ? t("chat.goal.sources.appServer") : t("chat.goal.sources.none"),
            time: goal?.updatedAt ? relativeTime(goal.updatedAt, now, t) : "--",
          })}
        </div>
      </footer>
    </div>
  );
}
