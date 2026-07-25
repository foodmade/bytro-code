import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  ListChecks,
  Bot,
  CircleCheck,
  CircleDashed,
  GripHorizontal,
  Loader,
  Sparkles,
  Wrench,
  Timer,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAgentStatusStore } from "@/stores";
import type { SubagentInfo, TodoItem } from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
// ---------------------------------------------------------------------------
// FadeText — text with fade transition on content change + shimmer when active
// ---------------------------------------------------------------------------

/**
 * Compute elapsed time (ms) since `startedAt` with second-level reactivity
 * while `active` is true. When inactive, returns the frozen elapsed at the
 * `lastDeltaAt` (or `startedAt`) reference point.
 *
 * Without this hook, components reading `Date.now() - startedAt` directly
 * only update on parent re-renders, so a slow-streaming "thinking…" timer
 * would visibly stall whenever no new deltas arrive.
 */
function useElapsedMs(
  startedAt: number | undefined,
  active: boolean,
  lastDeltaAt: number | undefined,
): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (startedAt == null) return undefined;
  if (active) return now - startedAt;
  return (lastDeltaAt ?? startedAt) - startedAt;
}

/**
 * Wrapper around DetailBlock that owns the per-second elapsed timer for a
 * subagent's thinking stream. Isolating the timer here prevents the entire
 * AgentRowItem subtree from re-rendering once a second while thinking is
 * active.
 */
function SubagentThinkingBlock({
  content,
  active,
  startedAt,
  lastDeltaAt,
  title,
}: {
  readonly content: string;
  readonly active: boolean;
  readonly startedAt: number | undefined;
  readonly lastDeltaAt: number | undefined;
  readonly title: string;
}) {
  const elapsedMs = useElapsedMs(startedAt, active, lastDeltaAt);
  return (
    <DetailBlock
      title={title}
      content={content}
      defaultCollapsed={!active}
      accent="purple"
      active={active}
      scrollOnUpdate={active}
      elapsedMs={elapsedMs}
    />
  );
}

function FadeText({ text, isActive }: { readonly text: string; readonly isActive: boolean }) {
  const [displayed, setDisplayed] = useState(text);
  const [fading, setFading] = useState(false);
  const prevRef = useRef(text);

  useEffect(() => {
    if (text === prevRef.current) return;
    prevRef.current = text;
    setFading(true);
    const timer = setTimeout(() => {
      setDisplayed(text);
      setFading(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <span
      className={`font-sans${isActive ? " summary-shimmer" : ""}`}
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        color: isActive ? "var(--color-muted-foreground)" : "var(--color-muted)",
        wordBreak: "break-word",
        opacity: fading ? 0 : 1,
        transition: "opacity 200ms ease-in-out",
      }}
    >
      {displayed}
    </span>
  );
}

function DetailBlock({
  title,
  content,
  defaultCollapsed = true,
  accent,
  elapsedMs,
  active = false,
  scrollOnUpdate = false,
}: {
  readonly title: string;
  readonly content: string;
  readonly defaultCollapsed?: boolean;
  readonly accent?: "purple" | "default";
  readonly elapsedMs?: number;
  readonly active?: boolean;
  readonly scrollOnUpdate?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const Arrow = collapsed ? ChevronRight : ChevronDown;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the body to the bottom whenever content grows during streaming.
  useEffect(() => {
    if (!scrollOnUpdate || collapsed) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [content, scrollOnUpdate, collapsed]);

  const isPurple = accent === "purple";
  const containerStyle = isPurple
    ? {
        borderRadius: 8,
        backgroundColor: "rgba(var(--theme-accent-rgb),0.04)",
        borderLeft: "2px solid rgba(var(--theme-accent-rgb),0.4)",
        border: "1px solid rgba(var(--theme-accent-rgb),0.18)",
        overflow: "hidden" as const,
      }
    : {
        borderRadius: 8,
        backgroundColor: "var(--color-background)",
        border: "1px solid var(--color-border)",
        overflow: "hidden" as const,
      };

  const elapsedSec = typeof elapsedMs === "number" && elapsedMs > 0 ? Math.floor(elapsedMs / 1000) : null;

  return (
    <div className="flex flex-col w-full" style={containerStyle}>
      <button
        type="button"
        className="flex items-center w-full"
        style={{
          gap: 4,
          padding: "8px 10px",
          cursor: "pointer",
          background: "none",
          border: "none",
          userSelect: "none",
        }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <Arrow size={10} color="var(--color-text-dim)" className="shrink-0" />
        <span
          className="font-mono"
          style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-dim)", letterSpacing: 0.6 }}
        >
          {title}
        </span>
        {elapsedSec != null ? (
          <span
            className="font-mono"
            style={{ fontSize: 9, color: "var(--color-text-dim)", marginLeft: 6 }}
          >
            {elapsedSec}s
          </span>
        ) : null}
        {active ? (
          <span
            className="summary-pulse-dot shrink-0"
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: isPurple ? "rgba(var(--theme-accent-rgb),0.314)" : "var(--color-accent-purple)",
              marginLeft: 6,
            }}
          />
        ) : null}
      </button>
      {!collapsed && (
        <div
          ref={scrollRef}
          style={{
            padding: "0 10px 10px",
            color: "var(--color-muted-foreground)",
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          <MarkdownRenderer content={content} variant="compact" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utility functions for formatting progress data
// ---------------------------------------------------------------------------

function formatDuration(ms: number | undefined): string {
  if (!ms) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTokens(n: number | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// TokenDetailRow — single row in token tooltip (dot + label + value)
// ---------------------------------------------------------------------------

function TokenDetailRow({
  dotColor,
  label,
  value,
}: {
  readonly dotColor: string;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <div className="flex items-center gap-2">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: dotColor,
            flexShrink: 0,
          }}
        />
        <span style={{ fontFamily: "Inter, sans-serif", fontSize: 11, color: "var(--color-text-tertiary)" }}>
          {label}
        </span>
      </div>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: "var(--color-foreground)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubagentTokenTooltip — hover tooltip showing token breakdown
// ---------------------------------------------------------------------------

function SubagentTokenTooltip({
  totalTokens,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
}: {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}) {
  const { t } = useTranslation();
  const hasBreakdown = inputTokens != null || outputTokens != null;
  const total = totalTokens ?? 0;

  return (
    <div
      className="absolute z-50"
      style={{
        bottom: "calc(100% + 8px)",
        left: "50%",
        transform: "translateX(-50%)",
        width: 210,
        borderRadius: 8,
        backgroundColor: "var(--color-border)",
        border: "1px solid var(--color-border-strong)",
        boxShadow: "var(--shadow-tooltip)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="flex items-center gap-2">
        <Zap size={12} color="var(--color-accent-purple)" />
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--color-foreground)",
          }}
        >
          {t("agentStatus.tokenBreakdown")}
        </span>
      </div>

      <div style={{ height: 1, backgroundColor: "var(--color-border-light)" }} />

      {hasBreakdown ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <TokenDetailRow dotColor="#8B5CF6" label={t("agentStatus.inputTokens")} value={formatNumber(inputTokens ?? 0)} />
          <TokenDetailRow dotColor="#6D28D9" label={t("agentStatus.outputTokens")} value={formatNumber(outputTokens ?? 0)} />
          {(cacheReadTokens ?? 0) > 0 && (
            <TokenDetailRow dotColor="#10B981" label={t("agentStatus.cacheRead")} value={formatNumber(cacheReadTokens!)} />
          )}
          {(cacheCreationTokens ?? 0) > 0 && (
            <TokenDetailRow dotColor="#059669" label={t("agentStatus.cacheWrite")} value={formatNumber(cacheCreationTokens!)} />
          )}
          <div style={{ height: 1, backgroundColor: "var(--color-border-light)" }} />
          <TokenDetailRow dotColor="var(--color-accent-purple)" label={t("agentStatus.totalLabel")} value={formatNumber(total)} />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <TokenDetailRow dotColor="var(--color-accent-purple)" label={t("agentStatus.totalLabel")} value={formatNumber(total)} />
          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: "var(--color-muted)", lineHeight: 1.4 }}>
            {t("agentStatus.tokenNote")}
          </span>
        </div>
      )}

      <div
        style={{
          position: "absolute",
          bottom: -6,
          left: "50%",
          transform: "translateX(-50%)",
          width: 0,
          height: 0,
          borderLeft: "6px solid transparent",
          borderRight: "6px solid transparent",
          borderTop: "6px solid var(--color-border)",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active task row (in_progress / pending) — 32px tall with status badge
// ---------------------------------------------------------------------------

function ActiveTaskRow({ todo }: { readonly todo: TodoItem }) {
  const isRunning = todo.status === "in_progress";

  return (
    <div
      className="task-row-enter flex items-center w-full"
      style={{
        height: 32,
        borderRadius: 6,
        gap: 10,
        padding: "0 10px",
        backgroundColor: isRunning ? "rgba(var(--theme-accent-rgb),0.07)" : "rgba(var(--hover-overlay-rgb),0.01)",
        ...(isRunning && {
          borderLeft: "2px solid var(--color-accent-purple)",
          boxShadow: "0 1px 8px 0 rgba(var(--theme-accent-rgb),0.13)",
        }),
      }}
    >
      {isRunning ? (
        <Loader
          size={14}
          color="var(--color-accent-purple)"
          className="shrink-0 task-loader-spin"
          style={{ filter: "drop-shadow(0 0 4px rgba(var(--theme-accent-rgb),0.3))" }}
        />
      ) : (
        <CircleDashed size={14} color="var(--color-border-strong)" className="shrink-0" />
      )}
      <span
        className="flex-1 min-w-0 truncate font-sans"
        style={{
          fontSize: 11,
          color: isRunning ? "var(--color-foreground)" : "var(--color-muted)",
          fontWeight: isRunning ? 500 : 400,
        }}
      >
        {todo.content}
      </span>
      <span
        className="shrink-0 font-mono"
        style={{
          fontSize: 9,
          fontWeight: 500,
          color: isRunning ? "var(--color-accent-purple)" : "var(--color-border-strong)",
          backgroundColor: isRunning ? "rgba(var(--theme-accent-rgb),0.082)" : "color-mix(in srgb, var(--color-border-strong) 50%, transparent)",
          borderRadius: 4,
          padding: "2px 8px",
        }}
      >
        {todo.status}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Completed task row — 28px tall, compact, muted green style
// ---------------------------------------------------------------------------

function CompletedTaskRow({ todo }: { readonly todo: TodoItem }) {
  return (
    <div
      className="task-row-enter flex items-center w-full"
      style={{
        height: 28,
        borderRadius: 4,
        gap: 8,
        padding: "0 10px",
      }}
    >
      <Check size={12} color="rgba(16,185,129,0.31)" className="shrink-0" />
      <span
        className="flex-1 min-w-0 truncate font-sans"
        style={{ fontSize: 10, color: "var(--color-muted)", fontWeight: 400 }}
      >
        {todo.content}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag handle props type
// ---------------------------------------------------------------------------

interface DragHandleProps {
  readonly onPointerDown: (e: React.PointerEvent) => void;
  readonly onPointerMove: (e: React.PointerEvent) => void;
  readonly onPointerUp: () => void;
}

// ---------------------------------------------------------------------------
// TaskCard — card wrapper for Tasks, with header + grouped task lists
// ---------------------------------------------------------------------------

function TaskCard({ todos, dragHandleProps, onCollapse, collapseSide }: { readonly todos: ReadonlyArray<TodoItem>; readonly dragHandleProps: DragHandleProps; readonly onCollapse?: () => void; readonly collapseSide?: "left" | "right" }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [completedExpanded, setCompletedExpanded] = useState(true);

  const activeTodos = useMemo(
    () => todos.filter((t) => t.status !== "completed"),
    [todos],
  );
  const completedTodos = useMemo(
    () => todos.filter((t) => t.status === "completed"),
    [todos],
  );
  const runningTodos = useMemo(
    () => todos.filter((t) => t.status === "in_progress"),
    [todos],
  );
  const total = todos.length;
  const completedCount = completedTodos.length;
  const progressPct = total > 0 ? (completedCount / total) * 100 : 0;

  const runningCount = runningTodos.length;

  return (
    <div className="status-card flex flex-col" style={{ width: "100%", flexShrink: 0 }}>
      {/* Card header with drag handle */}
      <div
        className="flex items-center w-full"
        style={{
          height: 44,
          borderBottom: expanded ? "1px solid var(--color-border-light)" : "none",
        }}
      >
        {/* Drag handle */}
        <div
          onPointerDown={dragHandleProps.onPointerDown}
          onPointerMove={dragHandleProps.onPointerMove}
          onPointerUp={dragHandleProps.onPointerUp}
          className="agent-status-drag-handle flex items-center justify-center shrink-0"
          style={{ width: 28, height: 44, touchAction: "none", userSelect: "none" }}
        >
          <GripHorizontal size={12} color="var(--color-border-strong)" />
        </div>
        {/* Collapse to floating ball */}
        {onCollapse && <CollapseButton onCollapse={onCollapse} side={collapseSide} />}
        {/* Clickable header area */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className="flex items-center flex-1 min-w-0"
          style={{ height: 44, paddingRight: 16, gap: 8 }}
        >
        {/* Left: chevron + icon + title + badge */}
        <div className="flex items-center shrink-0" style={{ gap: 8 }}>
          <ListChecks size={14} color="var(--color-accent-purple)" />
          <span
            className="font-sans"
            style={{ fontSize: 12, fontWeight: 600, color: "var(--color-muted-foreground)", letterSpacing: 0.3 }}
          >
            {t("agentStatus.tasks")}
          </span>
          <span
            className="font-mono"
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--color-accent-purple)",
              backgroundColor: "rgba(var(--theme-accent-rgb),0.13)",
              border: "1px solid rgba(var(--theme-accent-rgb),0.25)",
              borderRadius: 8,
              padding: "2px 8px",
            }}
          >
            {total}
          </span>
        </div>

        {/* Middle: running task summary when collapsed */}
        {!expanded && runningCount > 0 ? (
          <div className="flex items-center flex-1 min-w-0" style={{ gap: 6, overflow: "hidden", height: 20 }}>
            <Loader size={10} color="var(--color-accent-purple)" className="shrink-0 task-loader-spin" />
            {runningCount === 1 ? (
              <span className="truncate font-sans" style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
                {runningTodos[0].content}
              </span>
            ) : (
              <div className="flex-1 min-w-0 overflow-hidden" style={{ height: 20 }}>
                <div
                  className="status-ticker-vertical"
                  style={{ "--ticker-count": runningCount } as React.CSSProperties}
                >
                  {runningTodos.map((t, i) => (
                    <div key={`t-${i}`} className="truncate font-sans" style={{ fontSize: 10, color: "var(--color-text-tertiary)", height: 20, lineHeight: "20px" }}>
                      {t.content}
                    </div>
                  ))}
                  {/* Duplicate first item for seamless loop */}
                  <div className="truncate font-sans" style={{ fontSize: 10, color: "var(--color-text-tertiary)", height: 20, lineHeight: "20px" }}>
                    {runningTodos[0].content}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* Right: progress bar */}
        <div className="flex items-center shrink-0" style={{ gap: 8 }}>
          <div
            style={{
              width: 48,
              height: 4,
              borderRadius: 2,
              backgroundColor: "var(--color-border)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: 4,
                borderRadius: 2,
                backgroundColor: "#10B981",
              }}
            />
          </div>
          <span className="font-mono" style={{ fontSize: 10, color: "var(--color-border-strong)" }}>
            {completedCount}/{total}
          </span>
        </div>
      </button>
      </div>

      {/* Grouped task lists */}
      {expanded && (
        <div className="flex flex-col w-full overflow-y-auto" style={{ maxHeight: 260 }}>
          {/* IN PROGRESS group */}
          {activeTodos.length > 0 && (
            <div
              className="flex flex-col w-full"
              style={{ gap: 4, padding: "8px 12px" }}
            >
              {/* Group header */}
              <div
                className="flex items-center w-full"
                style={{ height: 24, padding: "0 4px", gap: 8 }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: "var(--color-accent-purple)",
                    boxShadow: "0 0 6px rgba(var(--theme-accent-rgb),0.38)",
                  }}
                />
                <span
                  className="font-sans"
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "var(--color-accent-purple)",
                    letterSpacing: 1.2,
                  }}
                >
                  {t("agentStatus.inProgress")}
                </span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    color: "var(--color-accent-purple)",
                    backgroundColor: "rgba(var(--theme-accent-rgb),0.13)",
                    borderRadius: 6,
                    padding: "1px 6px",
                  }}
                >
                  {activeTodos.length}
                </span>
              </div>

              {activeTodos.map((todo, i) => (
                <ActiveTaskRow key={`active-${todo.content}-${i}`} todo={todo} />
              ))}
            </div>
          )}

          {/* Group separator */}
          {activeTodos.length > 0 && completedTodos.length > 0 && (
            <div className="flex items-center w-full" style={{ padding: "0 16px" }}>
              <div
                style={{
                  height: 1,
                  width: "100%",
                  backgroundColor: "var(--color-border-light)",
                }}
              />
            </div>
          )}

          {/* COMPLETED group */}
          {completedTodos.length > 0 && (
            <div
              className="flex flex-col w-full"
              style={{ gap: 4, padding: "8px 12px 12px 12px" }}
            >
              {/* Group header (collapsible) */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setCompletedExpanded((v) => !v);
                }}
                className="flex items-center w-full"
                style={{ height: 24, padding: "0 4px", gap: 6 }}
              >
                {completedExpanded ? (
                  <ChevronDown size={10} color="var(--color-border-strong)" />
                ) : (
                  <ChevronRight size={10} color="var(--color-border-strong)" />
                )}
                <CircleCheck size={10} color="rgba(16,185,129,0.5)" />
                <span
                  className="font-sans"
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "rgba(16,185,129,0.5)",
                    letterSpacing: 1.2,
                  }}
                >
                  {t("agentStatus.completedGroup")}
                </span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    color: "rgba(16,185,129,0.44)",
                    backgroundColor: "rgba(16,185,129,0.09)",
                    borderRadius: 6,
                    padding: "1px 6px",
                  }}
                >
                  {completedCount}
                </span>
              </button>

              {completedExpanded &&
                completedTodos.map((todo, i) => (
                  <CompletedTaskRow key={`done-${todo.content}-${i}`} todo={todo} />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// AgentRowItem — individually expandable agent row with detail card
// ---------------------------------------------------------------------------

function AgentRowItem({ agent, expanded, onToggle }: { readonly agent: SubagentInfo; readonly expanded: boolean; readonly onToggle: () => void }) {
  const { t } = useTranslation();
  const [tokenHovered, setTokenHovered] = useState(false);
  const isActive = agent.status === "active";
  const isCompleted = agent.finalStatus === "completed";
  const isFailed = agent.finalStatus === "failed";
  const isStopped = agent.finalStatus === "stopped";
  const label = agent.name ?? agent.agentType;
  const hasProgress = (agent.toolUses ?? 0) > 0 || (agent.durationMs ?? 0) > 0;
  const promptText = agent.prompt ?? (agent.description && agent.description !== label ? agent.description : undefined);
  const finalResult = agent.finalResult?.trim();

  const statusColor = isActive
    ? "#10B981"
    : isCompleted ? "#22c55e"
    : isFailed ? "#EF4444"
    : isStopped ? "#F59E0B"
    : "var(--color-muted)";
  const statusLabel = isActive
    ? t("agentStatus.running")
    : agent.finalStatus === "completed" ? t("agentStatus.completed")
    : agent.finalStatus ?? t("agentStatus.idle");
  const summary = isActive ? agent.progressSummary : agent.finalSummary;
  const description = agent.description ?? `${agent.agentType} agent`;
  if (!expanded) {
    // ---- Collapsed row ----
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center w-full"
        style={{
          height: 36,
          borderRadius: 6,
          gap: 8,
          padding: "0 8px",
          backgroundColor: isActive ? "rgba(16,185,129,0.06)" : "transparent",
          cursor: "pointer",
        }}
      >
        {/* Chevron */}
        <ChevronRight size={10} color="var(--color-text-dim)" className="shrink-0" />

        {/* Status dot */}
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: statusColor,
            boxShadow: isActive ? `0 0 6px ${statusColor}60` : "none",
            flexShrink: 0,
          }}
        />

        {/* Agent name */}
        <span
          className="truncate font-mono"
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: isActive ? "var(--color-foreground)" : "var(--color-muted-foreground)",
          }}
        >
          {label}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Current tool name (running only) */}
        {isActive && agent.lastToolName && (
          <span
            className="font-mono shrink-0"
            style={{ fontSize: 9, fontWeight: 500, color: "var(--color-muted)" }}
          >
            {agent.lastToolName}
          </span>
        )}

        {/* Progress stats */}
        {hasProgress && (
          <div className="flex items-center shrink-0" style={{ gap: 6 }}>
            {(agent.toolUses ?? 0) > 0 && (
              <span
                className="font-mono"
                style={{ fontSize: 9, fontWeight: 500, color: "var(--color-accent-purple)" }}
              >
                {agent.toolUses}
              </span>
            )}
            {(agent.toolUses ?? 0) > 0 && (agent.durationMs ?? 0) > 0 && (
              <span style={{ fontSize: 9, color: "var(--color-border-strong)" }}>&middot;</span>
            )}
            {(agent.durationMs ?? 0) > 0 && (
              <span
                className="font-mono"
                style={{ fontSize: 9, fontWeight: 500, color: "var(--color-muted)" }}
              >
                {formatDuration(agent.durationMs)}
              </span>
            )}
          </div>
        )}

        {/* Status badge */}
        <div
          className="flex items-center shrink-0"
          style={{
            gap: 4,
            backgroundColor: isActive ? "rgba(16,185,129,0.09)" : `${statusColor}17`,
            borderRadius: 4,
            padding: "3px 6px",
          }}
        >
          {isActive ? (
            <Loader size={9} color={statusColor} className="task-loader-spin" />
          ) : isCompleted ? (
            <Check size={9} color={statusColor} />
          ) : null}
          <span className="font-mono" style={{ fontSize: 9, fontWeight: 500, color: statusColor }}>
            {statusLabel}
          </span>
        </div>
      </button>
    );
  }

  // ---- Expanded detail card ----
  return (
    <div
      className="flex flex-col w-full"
      style={{
        borderRadius: 10,
        backgroundColor: isActive ? "var(--color-card)" : "var(--color-surface)",
        border: `1px solid ${isActive ? "rgba(16,185,129,0.15)" : "var(--color-border)"}`,
      }}
    >
      {/* Card header — clickable to collapse */}
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center w-full"
        style={{ height: 42, gap: 8, padding: "0 12px", cursor: "pointer" }}
      >
        {/* Status dot */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusColor,
            boxShadow: isActive ? `0 0 8px ${statusColor}60` : "none",
            flexShrink: 0,
          }}
        />

        {/* Name + description */}
        <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
          <span
            className="truncate font-mono"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: isActive ? "var(--color-foreground)" : "var(--color-muted-foreground)",
              textAlign: "left",
            }}
          >
            {label}
          </span>
          <span
            className="truncate font-sans"
            style={{ fontSize: 9, color: isActive ? "var(--color-muted)" : "var(--color-text-dim)", textAlign: "left" }}
          >
            {description}
          </span>
        </div>

        {/* Status badge */}
        <div
          className="flex items-center shrink-0"
          style={{
            gap: 4,
            backgroundColor: isCompleted ? "#22c55e1a" : `${statusColor}1f`,
            borderRadius: 4,
            padding: "4px 8px",
          }}
        >
          {isActive && <Loader size={10} color={statusColor} className="task-loader-spin" />}
          {isCompleted && <CircleCheck size={10} color={statusColor} />}
          <span className="font-mono" style={{ fontSize: 9, fontWeight: 600, color: statusColor }}>
            {statusLabel}
          </span>
        </div>
      </button>

      {/* Card body */}
      <div className="flex flex-col w-full" style={{ gap: 8, padding: "0 12px 10px 12px" }}>
        {/* AI summary with shimmer + fade transition when active */}
        {summary ? (
          <div className="flex items-start w-full" style={{ gap: 6 }}>
            {isActive ? (
              <Sparkles size={12} color="rgba(var(--theme-accent-rgb),0.314)" className="shrink-0" style={{ marginTop: 3 }} />
            ) : (
              <Check size={12} color="#22c55e50" className="shrink-0" style={{ marginTop: 3 }} />
            )}
            <FadeText text={summary} isActive={isActive} />
            {isActive && (
              <div
                className="summary-pulse-dot shrink-0"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: "#A855F7",
                  marginTop: 6,
                }}
              />
            )}
          </div>
        ) : isActive ? (
          <div className="flex items-center w-full" style={{ gap: 6 }}>
            <Sparkles size={12} color="rgba(var(--theme-accent-rgb),0.314)" className="shrink-0" />
            <span className="font-sans summary-shimmer" style={{ fontSize: 11 }}>
              {t("agentStatus.waitingProgress")}
            </span>
            <div
              className="summary-pulse-dot shrink-0"
              style={{
                width: 5,
                height: 5,
                borderRadius: 3,
                backgroundColor: "rgba(var(--theme-accent-rgb),0.314)",
              }}
            />
          </div>
        ) : null}

        {promptText ? (
          <DetailBlock title={t("agentStatus.taskPrompt")} content={promptText} />
        ) : null}

        {agent.accumulatedThinking ? (
          <SubagentThinkingBlock
            content={agent.accumulatedThinking}
            active={!!agent.thinkingActive}
            startedAt={agent.thinkingStartedAt}
            lastDeltaAt={agent.thinkingLastDeltaAt}
            title={t("agentStatus.subagentThinking")}
          />
        ) : null}

        {agent.accumulatedText ? (
          <DetailBlock
            title={t("agentStatus.subagentReply")}
            content={agent.accumulatedText}
            defaultCollapsed={!agent.textActive}
            active={!!agent.textActive}
            scrollOnUpdate={!!agent.textActive}
          />
        ) : null}

        {finalResult ? (
          <DetailBlock title={t("agentStatus.finalResult")} content={finalResult} />
        ) : null}

        {/* Stats bar — card style for active, inline text for completed */}
        {hasProgress && isActive && (
          <div
            className="flex items-center w-full"
            style={{ backgroundColor: "var(--color-background)", borderRadius: 6, padding: "6px 0" }}
          >
            <div className="flex items-center justify-center flex-1" style={{ gap: 5 }}>
              <Wrench size={10} color="var(--color-muted)" />
              <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--color-foreground)" }}>
                {agent.toolUses ?? 0}
              </span>
              <span className="font-sans" style={{ fontSize: 9, color: "var(--color-text-dim)" }}>{t("agentStatus.tools")}</span>
            </div>
            <div style={{ width: 1, height: 16, backgroundColor: "var(--color-border)" }} />
            <div className="flex items-center justify-center flex-1" style={{ gap: 5 }}>
              <Timer size={10} color="var(--color-muted)" />
              <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--color-foreground)" }}>
                {formatDuration(agent.durationMs)}
              </span>
            </div>
            <div style={{ width: 1, height: 16, backgroundColor: "var(--color-border)" }} />
            <div
              className="relative flex items-center justify-center flex-1"
              style={{ gap: 5, cursor: "default" }}
              onMouseEnter={() => setTokenHovered(true)}
              onMouseLeave={() => setTokenHovered(false)}
            >
              <Zap size={10} color="var(--color-muted)" />
              <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--color-foreground)" }}>
                {formatTokens(agent.totalTokens)}
              </span>
              <span className="font-sans" style={{ fontSize: 9, color: "var(--color-text-dim)" }}>{t("agentStatus.tokens")}</span>
              {tokenHovered && (
                <SubagentTokenTooltip
                  totalTokens={agent.totalTokens}
                  inputTokens={agent.inputTokens}
                  outputTokens={agent.outputTokens}
                  cacheReadTokens={agent.cacheReadTokens}
                  cacheCreationTokens={agent.cacheCreationTokens}
                />
              )}
            </div>
          </div>
        )}
        {hasProgress && !isActive && (
          <div className="flex items-center w-full" style={{ gap: 12 }}>
            <span className="font-mono" style={{ fontSize: 9, fontWeight: 500, color: "var(--color-text-dim)" }}>
              {agent.toolUses ?? 0} {t("agentStatus.tools")}
            </span>
            <span style={{ fontSize: 9, color: "var(--color-border-strong)" }}>&middot;</span>
            <span className="font-mono" style={{ fontSize: 9, fontWeight: 500, color: "var(--color-text-dim)" }}>
              {formatDuration(agent.durationMs)}
            </span>
            <span style={{ fontSize: 9, color: "var(--color-border-strong)" }}>&middot;</span>
            <span
              className="relative font-mono"
              style={{ fontSize: 9, fontWeight: 500, color: "var(--color-text-dim)", cursor: "default" }}
              onMouseEnter={() => setTokenHovered(true)}
              onMouseLeave={() => setTokenHovered(false)}
            >
              {formatTokens(agent.totalTokens)} {t("agentStatus.tokens")}
              {tokenHovered && (
                <SubagentTokenTooltip
                  totalTokens={agent.totalTokens}
                  inputTokens={agent.inputTokens}
                  outputTokens={agent.outputTokens}
                  cacheReadTokens={agent.cacheReadTokens}
                  cacheCreationTokens={agent.cacheCreationTokens}
                />
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentCard — card wrapper for Sub-Agents, each row independently expandable
// ---------------------------------------------------------------------------

function AgentCard({ subagents, dragHandleProps, onCollapse, collapseSide }: { readonly subagents: ReadonlyArray<SubagentInfo>; readonly dragHandleProps: DragHandleProps; readonly onCollapse?: () => void; readonly collapseSide?: "left" | "right" }) {
  const { t } = useTranslation();
  // Track which agent IDs are expanded
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  // Whether the entire card body is collapsed (only header visible)
  const [cardCollapsed, setCardCollapsed] = useState(false);
  // Track the previous subagent count to detect new additions
  const prevCountRef = useRef(subagents.length);

  const activeAgents = useMemo(
    () => subagents.filter((sa) => sa.status === "active"),
    [subagents],
  );
  const activeCount = activeAgents.length;

  // Auto-expand first active agent when a new subagent is added
  useEffect(() => {
    if (subagents.length > prevCountRef.current) {
      const firstActive = subagents.find((sa) => sa.status === "active");
      if (firstActive && !expandedIds.has(firstActive.agentId)) {
        setExpandedIds((prev) => new Set([...prev, firstActive.agentId]));
      }
    }
    prevCountRef.current = subagents.length;
  }, [subagents.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Aggregate totals for footer
  const totalToolUses = useMemo(() => subagents.reduce((sum, sa) => sum + (sa.toolUses ?? 0), 0), [subagents]);
  const totalDurationMs = useMemo(() => subagents.reduce((max, sa) => Math.max(max, sa.durationMs ?? 0), 0), [subagents]);
  const totalTokens = useMemo(() => subagents.reduce((sum, sa) => sum + (sa.totalTokens ?? 0), 0), [subagents]);
  const aggInputTokens = useMemo(() => {
    const vals = subagents.map((sa) => sa.inputTokens).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined;
  }, [subagents]);
  const aggOutputTokens = useMemo(() => {
    const vals = subagents.map((sa) => sa.outputTokens).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined;
  }, [subagents]);
  const aggCacheReadTokens = useMemo(() => {
    const vals = subagents.map((sa) => sa.cacheReadTokens).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined;
  }, [subagents]);
  const aggCacheCreationTokens = useMemo(() => {
    const vals = subagents.map((sa) => sa.cacheCreationTokens).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined;
  }, [subagents]);
  const [footerTokenHovered, setFooterTokenHovered] = useState(false);

  const toggleExpanded = useCallback((agentId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);

  const toggleCard = useCallback(() => {
    setCardCollapsed((prev) => !prev);
  }, []);

  return (
    <div className="status-card flex flex-col" style={{ width: "100%", flexShrink: 0 }}>
      {/* Card header with drag handle */}
      <div
        className="flex items-center w-full"
        style={{
          height: 48,
          borderBottom: cardCollapsed ? "none" : "1px solid var(--color-border)",
        }}
      >
        {/* Drag handle */}
        <div
          onPointerDown={dragHandleProps.onPointerDown}
          onPointerMove={dragHandleProps.onPointerMove}
          onPointerUp={dragHandleProps.onPointerUp}
          className="agent-status-drag-handle flex items-center justify-center shrink-0"
          style={{ width: 28, height: 48, touchAction: "none", userSelect: "none" }}
        >
          <GripHorizontal size={12} color="var(--color-border-strong)" />
        </div>
        {/* Collapse to floating ball */}
        {onCollapse && <CollapseButton onCollapse={onCollapse} side={collapseSide} />}

        {/* Header content — clickable to toggle card */}
        <button
          type="button"
          onClick={toggleCard}
          className="flex items-center flex-1 min-w-0"
          style={{ height: 48, paddingRight: 16, gap: 10, cursor: "pointer" }}
        >
          <Bot size={18} color="#A855F7" />
          <span
            className="font-sans"
            style={{ fontSize: 13, fontWeight: 600, color: "var(--color-foreground)", letterSpacing: 0.3 }}
          >
            {t("agentStatus.subAgents")}
          </span>
          <div
            className="flex items-center justify-center"
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: "rgba(var(--theme-accent-rgb),0.125)",
            }}
          >
            <span
              className="font-mono"
              style={{ fontSize: 10, fontWeight: 600, color: "#A855F7" }}
            >
              {subagents.length}
            </span>
          </div>

          <div className="flex-1" />

          {/* Active count badge */}
          {activeCount > 0 && (
            <div
              className="flex items-center"
              style={{
                gap: 4,
                backgroundColor: "#10b98117",
                borderRadius: 4,
                padding: "3px 8px",
              }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: "#10B981",
                  boxShadow: "0 0 4px #10B98180",
                }}
              />
              <span className="font-mono" style={{ fontSize: 9, fontWeight: 500, color: "#10B981" }}>
                {t("agentStatus.activeCount", { count: activeCount })}
              </span>
            </div>
          )}

          {/* Collapse/expand chevron */}
          {cardCollapsed ? (
            <ChevronDown size={14} color="var(--color-muted)" className="shrink-0" />
          ) : (
            <ChevronUp size={14} color="var(--color-muted)" className="shrink-0" />
          )}
        </button>
      </div>

      {/* Agent rows + footer — hidden when card is collapsed */}
      {!cardCollapsed && (
        <>
          <div className="flex flex-col w-full overflow-y-auto" style={{ gap: 6, padding: 10, maxHeight: 560 }}>
            {subagents.map((sa) => (
              <AgentRowItem
                key={sa.agentId}
                agent={sa}
                expanded={expandedIds.has(sa.agentId)}
                onToggle={() => toggleExpanded(sa.agentId)}
              />
            ))}
          </div>

          {/* Panel footer — aggregated stats */}
          <div
            className="flex items-center w-full"
            style={{
              height: 36,
              padding: "0 16px",
              borderTop: "1px solid var(--color-border)",
              justifyContent: "space-between",
            }}
          >
            <div className="flex items-center" style={{ gap: 12 }}>
              <span className="font-sans" style={{ fontSize: 9, fontWeight: 500, color: "var(--color-text-dim)" }}>
                {t("agentStatus.total")}:
              </span>
              <div className="flex items-center" style={{ gap: 4 }}>
                <Wrench size={9} color="var(--color-text-dim)" />
                <span className="font-mono" style={{ fontSize: 9, fontWeight: 600, color: "var(--color-muted-foreground)" }}>
                  {totalToolUses}
                </span>
              </div>
              <div className="flex items-center" style={{ gap: 4 }}>
                <Timer size={9} color="var(--color-text-dim)" />
                <span className="font-mono" style={{ fontSize: 9, fontWeight: 600, color: "var(--color-muted-foreground)" }}>
                  {formatDuration(totalDurationMs)}
                </span>
              </div>
              <div
                className="relative flex items-center"
                style={{ gap: 4, cursor: "default" }}
                onMouseEnter={() => setFooterTokenHovered(true)}
                onMouseLeave={() => setFooterTokenHovered(false)}
              >
                <Zap size={9} color="var(--color-text-dim)" />
                <span className="font-mono" style={{ fontSize: 9, fontWeight: 600, color: "var(--color-muted-foreground)" }}>
                  {formatTokens(totalTokens)}
                </span>
                {footerTokenHovered && (
                  <SubagentTokenTooltip
                    totalTokens={totalTokens}
                    inputTokens={aggInputTokens}
                    outputTokens={aggOutputTokens}
                    cacheReadTokens={aggCacheReadTokens}
                    cacheCreationTokens={aggCacheCreationTokens}
                  />
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useDrag — lightweight hook for pointer-based drag
// ---------------------------------------------------------------------------

function useDrag(initialPos: { x: number; y: number }) {
  const [pos, setPos] = useState(initialPos);
  // Which edge the panel is snapped to
  const sideRef = useRef<"left" | "right">("left");
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Snap panel to its current side & clamp y within container
  useEffect(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement;
    if (!panel || !container) return;

    const snapAndClamp = () => {
      if (dragging.current) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      if (pw === 0 || ph === 0) return;
      setPos((prev) => {
        const x = sideRef.current === "right" ? cw - pw : 0;
        const y = Math.max(0, Math.min(prev.y, ch - ph));
        if (x === prev.x && y === prev.y) return prev;
        return { x, y };
      });
    };

    const ro = new ResizeObserver(snapAndClamp);
    ro.observe(panel);
    ro.observe(container);
    window.addEventListener("resize", snapAndClamp);
    snapAndClamp();

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", snapAndClamp);
    };
  });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    offset.current = {
      x: e.clientX - (panelRef.current?.getBoundingClientRect().left ?? 0),
      y: e.clientY - (panelRef.current?.getBoundingClientRect().top ?? 0),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const container = panelRef.current?.parentElement;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const panelRect = panelRef.current!.getBoundingClientRect();

    let newX = e.clientX - containerRect.left - offset.current.x;
    let newY = e.clientY - containerRect.top - offset.current.y;

    newX = Math.max(0, Math.min(newX, containerRect.width - panelRect.width));
    newY = Math.max(0, Math.min(newY, containerRect.height - panelRect.height));

    setPos({ x: newX, y: newY });
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    // Determine which side to snap to based on panel center
    const panel = panelRef.current;
    const container = panel?.parentElement;
    if (panel && container) {
      const cw = container.clientWidth;
      const pw = panel.offsetWidth;
      const centerX = pos.x + pw / 2;
      sideRef.current = centerX > cw / 2 ? "right" : "left";
      // Snap to edge
      const x = sideRef.current === "right" ? cw - pw : 0;
      const y = Math.max(0, Math.min(pos.y, container.clientHeight - panel.offsetHeight));
      setPos({ x, y });
    }
  }, [pos]);

  // Allow external code to set side (e.g. expand from ball)
  const setSide = useCallback((side: "left" | "right") => {
    sideRef.current = side;
  }, []);

  return { pos, setPos, setSide, side: sideRef, panelRef, onPointerDown, onPointerMove, onPointerUp, isDragging: dragging };
}

// ---------------------------------------------------------------------------
// useCollapsed — persist collapsed state to localStorage
// ---------------------------------------------------------------------------

const COLLAPSED_KEY = "agent-status-collapsed";

function useCollapsed(): readonly [boolean, (v: boolean) => void] {
  const [collapsed, setRaw] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) !== "false"; }
    catch { return true; }
  });
  const set = useCallback((v: boolean) => {
    setRaw(v);
    try { localStorage.setItem(COLLAPSED_KEY, String(v)); } catch { /* noop */ }
  }, []);
  return [collapsed, set] as const;
}

// ---------------------------------------------------------------------------
// useBallDrag — draggable floating ball with left/right edge snap
// ---------------------------------------------------------------------------

const BALL_POS_KEY = "agent-status-ball-pos";
const BALL_SIZE = 60;
const EDGE_MARGIN = 12;

interface BallPos {
  readonly side: "left" | "right";
  readonly y: number;
  readonly containerWidth?: number; // cached at snap time for first-render fallback
}

function useBallDrag(containerRef: React.RefObject<HTMLElement | null>) {
  const [restPos, setRestPos] = useState<BallPos>(() => {
    try {
      const raw = localStorage.getItem(BALL_POS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as BallPos;
        if (parsed.side === "left" || parsed.side === "right") return parsed;
      }
    } catch { /* use default */ }
    return { side: "left", y: 8 };
  });

  const [dragXY, setDragXY] = useState<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const pointerOffset = useRef({ x: 0, y: 0 });
  const startXY = useRef({ x: 0, y: 0 });
  const wasDragged = useRef(false);
  const ballRef = useRef<HTMLDivElement>(null);

  // Force re-calc on any window resize so ball snaps to correct edge
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  const getRestX = useCallback(() => {
    const w = containerRef.current?.clientWidth ?? restPos.containerWidth ?? 0;
    if (w === 0) return EDGE_MARGIN;
    return restPos.side === "left"
      ? EDGE_MARGIN
      : w - BALL_SIZE - EDGE_MARGIN;
  }, [restPos, containerRef]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    wasDragged.current = false;
    startXY.current = { x: e.clientX, y: e.clientY };
    const rect = ballRef.current?.getBoundingClientRect();
    pointerOffset.current = {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const container = containerRef.current;
    if (!container) return;

    const dx = Math.abs(e.clientX - startXY.current.x);
    const dy = Math.abs(e.clientY - startXY.current.y);
    if (dx + dy > 4) wasDragged.current = true;

    const cr = container.getBoundingClientRect();
    let x = e.clientX - cr.left - pointerOffset.current.x;
    let y = e.clientY - cr.top - pointerOffset.current.y;
    x = Math.max(0, Math.min(x, cr.width - BALL_SIZE));
    y = Math.max(0, Math.min(y, cr.height - BALL_SIZE));
    setDragXY({ x, y });
  }, [containerRef]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }

    const container = containerRef.current;
    const xy = dragXY;
    if (!container || !xy) { setDragXY(null); return; }

    const centerX = xy.x + BALL_SIZE / 2;
    const side: "left" | "right" = centerX < container.clientWidth / 2 ? "left" : "right";
    const clampedY = Math.max(0, Math.min(xy.y, container.clientHeight - BALL_SIZE));
    const newPos: BallPos = { side, y: clampedY };
    setRestPos(newPos);
    setDragXY(null);
    try { localStorage.setItem(BALL_POS_KEY, JSON.stringify(newPos)); } catch { /* ignore */ }
  }, [containerRef, dragXY]);

  const currentX = dragXY !== null ? dragXY.x : getRestX();
  const currentY = dragXY !== null ? dragXY.y : restPos.y;
  const isSnapping = dragXY === null;

  const snapTo = useCallback((side: "left" | "right", y: number, containerWidth?: number) => {
    const newPos: BallPos = { side, y, containerWidth };
    setRestPos(newPos);
    setDragXY(null);
    try { localStorage.setItem(BALL_POS_KEY, JSON.stringify(newPos)); } catch { /* ignore */ }
  }, []);

  return { ballRef, x: currentX, y: currentY, side: restPos.side, isSnapping, wasDragged, snapTo, onPointerDown, onPointerMove, onPointerUp };
}

// ---------------------------------------------------------------------------
// FloatingBall — collapsed state: circular button with progress ring + ripple
// ---------------------------------------------------------------------------

const RING_R = 18.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

function FloatingBall({
  completedCount,
  totalCount,
  activeAgentCount,
  hasActiveTasks,
  onExpand,
}: {
  readonly completedCount: number;
  readonly totalCount: number;
  readonly activeAgentCount: number;
  readonly hasActiveTasks: boolean;
  readonly onExpand: () => void;
}) {
  const { t } = useTranslation();
  const ratio = totalCount > 0 ? completedCount / totalCount : 0;
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  const isActive = hasActiveTasks || activeAgentCount > 0;

  // Wrapper size: 44 ball + 8 offset each side for ripple = 60, plus bottom badge space
  const wrapperW = 60;
  const wrapperH = activeAgentCount > 0 || totalCount > 0 ? 68 : 60;
  const ballOffset = 8; // ball is at (8,8) inside wrapper

  return (
    <div
      className="floating-ball-wrapper"
      style={{ position: "relative", width: wrapperW, height: wrapperH }}
    >
      {/* Ripple layers — radial gradient ellipses */}
      {isActive && (
        <>
          <div className="floating-ball-ripple" />
          <div className="floating-ball-ripple-inner" />
        </>
      )}

      {/* Main ball */}
      <button
        type="button"
        className="floating-ball"
        onClick={onExpand}
        title={t("agentStatus.expand")}
        style={{
          position: "absolute",
          left: ballOffset,
          top: ballOffset,
          width: 44,
          height: 44,
          borderRadius: 22,
          background: "linear-gradient(180deg, var(--color-card) 0%, var(--color-surface) 100%)",
          border: "1px solid var(--color-border-strong)",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {/* Progress ring SVG — only for task progress */}
        <svg viewBox="0 0 44 44" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          {totalCount > 0 && (
            <>
              <circle cx={22} cy={22} r={RING_R} fill="none" stroke="var(--color-border-strong)" strokeWidth={2.5} opacity={0.4} />
              <circle
                cx={22} cy={22} r={RING_R}
                fill="none"
                stroke="#A855F7"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={offset}
                transform="rotate(-90 22 22)"
                style={{ transition: "stroke-dashoffset 300ms ease" }}
              />
            </>
          )}
        </svg>
        {/* Center icon */}
        <ListChecks
          size={16}
          color={isActive ? "#A855F7" : "var(--color-muted)"}
          style={{ position: "relative", zIndex: 1 }}
        />
      </button>

      {/* Agent count badge — top-right of ball */}
      {activeAgentCount > 0 && (
        <div
          className="flex items-center justify-center font-mono"
          style={{
            position: "absolute",
            top: 0,
            right: wrapperW - ballOffset - 44 + 6, // align to ball top-right
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: "#10B981",
            padding: "0 6px",
            gap: 2,
            zIndex: 2,
          }}
        >
          <Bot size={10} color="#fff" />
          <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", lineHeight: 1 }}>
            {activeAgentCount}
          </span>
        </div>
      )}

      {/* Task count badge — bottom-left */}
      {totalCount > 0 && (
        <div
          className="flex items-center justify-center font-mono"
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-border-strong)",
            padding: "0 6px",
          }}
        >
          <span style={{ fontSize: 9, fontWeight: 600, color: "var(--color-accent-purple)", lineHeight: 1 }}>
            {completedCount}/{totalCount}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CollapseButton — small button to collapse the panel to floating ball
// ---------------------------------------------------------------------------

function CollapseButton({ onCollapse, side = "left" }: { readonly onCollapse: () => void; readonly side?: "left" | "right" }) {
  const { t } = useTranslation();
  const Icon = side === "left" ? ChevronsLeft : ChevronsRight;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onCollapse(); }}
      title={t("agentStatus.collapse")}
      className="agent-status-collapse-btn flex items-center justify-center shrink-0 transition-colors duration-150 hover:bg-border/30"
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <Icon size={13} color="var(--color-accent-purple)" style={{ opacity: 0.8 }} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main panel — single draggable container, cards stack vertically
// ---------------------------------------------------------------------------

export function AgentStatusPanel() {
  const todos = useAgentStatusStore((s) => s.todos);
  const subagents = useAgentStatusStore((s) => s.subagents);

  const hasTodos = todos.length > 0;
  const hasSubagents = subagents.length > 0;

  const drag = useDrag({ x: 16, y: 8 });
  const [collapsed, setCollapsed] = useCollapsed();
  const ballContainerRef = useRef<HTMLDivElement>(null);
  const ballDrag = useBallDrag(ballContainerRef);

  // Auto-collapse on narrow windows
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = () => { if (mql.matches) setCollapsed(true); };
    handler();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [setCollapsed]);

  // Derived data for floating ball
  const completedCount = useMemo(() => todos.filter((todo) => todo.status === "completed").length, [todos]);
  const totalCount = todos.length;
  const activeAgentCount = useMemo(() => subagents.filter((sa) => sa.status === "active").length, [subagents]);
  const hasActiveTasks = useMemo(() => todos.some((todo) => todo.status === "in_progress"), [todos]);

  const panelSide = drag.side.current;

  const handleCollapse = useCallback(() => {
    const side = drag.side.current;
    const cw = drag.panelRef.current?.parentElement?.clientWidth;
    ballDrag.snapTo(side, drag.pos.y, cw);
    setCollapsed(true);
  }, [ballDrag, drag.side, drag.pos.y, drag.panelRef, setCollapsed]);

  if (!hasTodos && !hasSubagents) {
    return null;
  }

  if (collapsed) {
    return (
      <div
        ref={ballContainerRef}
        style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 10, overflow: "visible" }}
      >
        <div
          ref={ballDrag.ballRef}
          className={ballDrag.isSnapping ? "floating-ball-snap" : ""}
          style={{
            position: "absolute",
            left: ballDrag.x,
            top: ballDrag.y,
            pointerEvents: "auto",
            overflow: "visible",
          }}
          onPointerDown={ballDrag.onPointerDown}
          onPointerMove={ballDrag.onPointerMove}
          onPointerUp={ballDrag.onPointerUp}
        >
          <FloatingBall
            completedCount={completedCount}
            totalCount={totalCount}
            activeAgentCount={activeAgentCount}
            hasActiveTasks={hasActiveTasks}
            onExpand={() => {
              if (!ballDrag.wasDragged.current) {
                drag.setSide(ballDrag.side);
                drag.setPos({ x: 0, y: ballDrag.y });
                setCollapsed(false);
              }
            }}
          />
        </div>
      </div>
    );
  }

  const dragHandleProps = {
    onPointerDown: drag.onPointerDown,
    onPointerMove: drag.onPointerMove,
    onPointerUp: drag.onPointerUp,
  };

  return (
    <div
      ref={drag.panelRef}
      className="agent-status-panel"
      style={{
        position: "absolute",
        left: drag.pos.x,
        top: drag.pos.y,
        zIndex: 10,
        width: "min(496px, 50%)",
        maxHeight: "calc(100% - 16px)",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {hasTodos && (
        <TaskCard
          key="tasks"
          todos={todos}
          dragHandleProps={dragHandleProps}
          onCollapse={handleCollapse}
          collapseSide={panelSide}
        />
      )}
      {hasSubagents && (
        <AgentCard
          key="agents"
          subagents={subagents}
          dragHandleProps={dragHandleProps}
          onCollapse={handleCollapse}
          collapseSide={panelSide}
        />
      )}
    </div>
  );
}
