import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Gauge, Loader2, Layers, Shrink } from "lucide-react";
import { useAgentStatusStore, useConversationStore } from "@/stores";
import { useConversationStatus } from "@/hooks/use-conversation-status";
import type { UsageData } from "@/stores/chat-store";
import type { ContextUsageData, StreamUsageData } from "@/stores/agent-status-store";
import { formatDuration } from "@/lib/format-duration";

function formatNumber(n: number, locale: string): string {
  return n.toLocaleString(locale);
}

/** Compact token count: 1.2k, 45.3k, 1.2M etc. */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Resolve stream output tokens: prefer actual value, fall back to character-based estimate. */
function resolveStreamOutput(su: StreamUsageData): number {
  return su.outputTokens > 0 ? su.outputTokens : su.estimatedOutputTokens;
}

function getContextTone(percentage: number | null): string {
  if (percentage != null && percentage >= 80) return "var(--color-accent-danger)";
  return "var(--color-accent-purple)";
}

export function getUsageTotal(
  usage: Pick<UsageData, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">,
): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
}

export function resolveContextUsageTotal({
  contextUsage,
}: {
  readonly contextUsage: ContextUsageData | null;
  readonly streamUsage: StreamUsageData | null;
  readonly lastStreamUsage: StreamUsageData | null;
  readonly isStreaming: boolean;
}): number {
  return contextUsage?.totalTokens ?? 0;
}

const EMPTY_USAGE: UsageData = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalCostUsd: 0,
  contextWindow: 0,
  model: "",
  totalDurationMs: 0,
};

interface ConversationUsageView {
  readonly lastUsage: UsageData | null;
  readonly streamUsage: StreamUsageData | null;
  readonly lastStreamUsage: StreamUsageData | null;
  readonly contextUsage: ContextUsageData | null;
  readonly lastTurnDurationMs: number | null;
}

export function resolveConversationUsageState(
  state: ReturnType<typeof useAgentStatusStore.getState>,
  conversationId: string | null | undefined,
  activeConversationId: string | null,
): ConversationUsageView {
  if (!conversationId) {
    return {
      lastUsage: null,
      streamUsage: null,
      lastStreamUsage: null,
      contextUsage: null,
      lastTurnDurationMs: null,
    };
  }
  if (conversationId === activeConversationId) {
    return {
      lastUsage: state.lastUsage,
      streamUsage: state.streamUsage,
      lastStreamUsage: state.lastStreamUsage,
      contextUsage: state.contextUsage,
      lastTurnDurationMs: state.lastTurnDurationMs,
    };
  }
  const cached = state._agentStatusCache[conversationId];
  return {
    lastUsage: cached?.lastUsage ?? null,
    streamUsage: cached?.streamUsage ?? null,
    lastStreamUsage: cached?.lastStreamUsage ?? null,
    contextUsage: cached?.contextUsage ?? null,
    lastTurnDurationMs: cached?.lastTurnDurationMs ?? null,
  };
}

/** Floating tooltip panel with detailed token breakdown. */
function TokenTooltip({
  usage,
  contextUsage,
  streamUsage,
  lastStreamUsage,
  isStreaming,
  lastDuration,
  onCompact,
  isCompacting,
}: {
  readonly usage: UsageData;
  readonly contextUsage: ContextUsageData | null;
  readonly streamUsage: StreamUsageData | null;
  readonly lastStreamUsage: StreamUsageData | null;
  readonly isStreaming: boolean;
  readonly lastDuration: number | null;
  readonly onCompact?: () => void;
  readonly isCompacting: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || "en-US";
  const contextUsed = contextUsage || lastStreamUsage || streamUsage
    ? resolveContextUsageTotal({ contextUsage, streamUsage, lastStreamUsage, isStreaming })
    : null;
  const contextWindow = contextUsage?.maxTokens ?? usage.contextWindow;
  const contextPct = contextUsed != null && contextWindow > 0
    ? (contextUsed / contextWindow) * 100
    : null;
  // During streaming, include current turn's real-time tokens in session totals
  const sInput = isStreaming && streamUsage ? streamUsage.inputTokens : 0;
  const sOutput = isStreaming && streamUsage ? resolveStreamOutput(streamUsage) : 0;
  const totalInput = usage.inputTokens + sInput;
  const totalOutput = usage.outputTokens + sOutput;

  // Compute cache hit rate — include stream cache reads to keep ratio consistent
  const totalCacheRead = usage.cacheReadTokens
    + (isStreaming && streamUsage ? streamUsage.cacheReadTokens : 0);
  const totalCacheCreation = usage.cacheCreationTokens
    + (isStreaming && streamUsage ? streamUsage.cacheCreationTokens : 0);
  const totalUsed = getUsageTotal({
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheCreationTokens: totalCacheCreation,
  });
  const totalInputContext = totalInput + totalCacheRead + totalCacheCreation;
  const cacheHitRate =
    totalInputContext > 0 ? ((totalCacheRead / totalInputContext) * 100) : 0;
  const contextPctClamped = contextPct == null ? 0 : Math.max(0, Math.min(100, contextPct));

  return (
    <div
      className="absolute z-50"
      style={{
        bottom: "calc(100% + 8px)",
        right: 0,
        width: 280,
        borderRadius: 14,
        backgroundColor: "var(--color-surface)",
        border: "1px solid var(--color-border-subtle)",
        boxShadow: "var(--shadow-float)",
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div className="flex items-center gap-2">
        <Gauge size={16} color="var(--color-accent-purple)" />
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            fontWeight: 700,
            color: "var(--color-foreground)",
          }}
        >
          {t("chat.tokenUsage.title")}
        </span>
      </div>

      <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />

      {contextUsage && contextUsed != null && (
        <>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              borderRadius: 10,
              backgroundColor: "var(--color-card)",
              border: "1px solid var(--color-border-subtle)",
              padding: "10px 12px",
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Layers size={11} color="var(--color-accent-purple)" />
                <span style={{ fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600, color: "var(--color-foreground)" }}>
                  {t("chat.tokenUsage.contextWindow")}
                </span>
              </div>
              {contextPct != null && (
                <div className="flex items-baseline" style={{ gap: 4 }}>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 700, color: "var(--color-foreground)" }}>
                    {Math.round(contextPct)}
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, color: "var(--color-accent-purple)" }}>
                    %
                  </span>
                </div>
              )}
            </div>
            <div
              style={{
                position: "relative",
                height: 6,
                width: "100%",
                overflow: "hidden",
                borderRadius: 999,
                backgroundColor: "var(--color-surface-dark)",
                border: "1px solid var(--color-border-subtle)",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${contextPctClamped}%`,
                  borderRadius: 999,
                  background: "linear-gradient(90deg, color-mix(in srgb, var(--color-accent-purple) 70%, var(--color-surface-dark)) 0%, var(--color-accent-purple) 60%, color-mix(in srgb, var(--color-accent-purple) 75%, var(--color-foreground)) 100%)",
                }}
              />
              {contextPctClamped > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: -6,
                    left: `calc(${contextPctClamped}% - 9px)`,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 80%, transparent)",
                    filter: "blur(6px)",
                  }}
                />
              )}
            </div>
            <div className="flex items-center justify-between">
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 500, color: "var(--color-muted)" }}>
                {t("chat.tokenUsage.contextTokens", {
                  used: formatCompact(contextUsed),
                  max: formatCompact(contextWindow),
                })}
              </span>
              {onCompact && (
                <button
                  type="button"
                  disabled={isCompacting}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isCompacting) return;
                    onCompact();
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    borderRadius: 4,
                    border: "1px solid color-mix(in srgb, var(--color-accent-purple) 36%, transparent)",
                    backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 10%, transparent)",
                    padding: "2px 7px",
                    color: "var(--color-accent-purple)",
                    cursor: isCompacting ? "default" : "pointer",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 10,
                    fontWeight: 600,
                    opacity: isCompacting ? 0.75 : 1,
                  }}
                  title={isCompacting ? t("chat.tokenUsage.compactingTitle") : t("chat.tokenUsage.compactTitle")}
                >
                  {isCompacting ? (
                    <Loader2 size={9} style={{ animation: "spin 1.2s linear infinite" }} />
                  ) : (
                    <Shrink size={9} />
                  )}
                  <span>{isCompacting ? t("chat.tokenUsage.compacting") : t("chat.tokenUsage.compact")}</span>
                </button>
              )}
            </div>
          </div>
          <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />
        </>
      )}

      {/* Real-time stream usage (current turn) */}
      {isStreaming && streamUsage && (streamUsage.inputTokens > 0 || streamUsage.outputTokens > 0) && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 600, color: "var(--color-accent-info)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              {t("chat.tokenUsage.currentTurn")}
            </span>
            <DetailRow dotColor="var(--color-accent-info)" dotFilled label={t("chat.tokenUsage.input")} value={formatNumber(streamUsage.inputTokens, locale)} />
            <DetailRow dotColor="var(--color-accent-info)" dotFilled label={t("chat.tokenUsage.output")} value={formatNumber(streamUsage.outputTokens, locale)} />
            {streamUsage.cacheReadTokens > 0 && (
              <DetailRow dotColor="var(--color-accent-green)" dotFilled label={t("chat.tokenUsage.cacheRead")} value={formatNumber(streamUsage.cacheReadTokens, locale)} />
            )}
            {streamUsage.cacheCreationTokens > 0 && (
              <DetailRow dotColor="var(--color-accent-success)" dotFilled label={t("chat.tokenUsage.cacheWrite")} value={formatNumber(streamUsage.cacheCreationTokens, locale)} />
            )}
          </div>
          <div style={{ height: 1, backgroundColor: "var(--color-border-light)" }} />
        </>
      )}

      {/* Cumulative session usage */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {isStreaming && streamUsage && (streamUsage.inputTokens > 0 || streamUsage.outputTokens > 0) && (
          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 600, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {t("chat.tokenUsage.sessionTotal")}
          </span>
        )}
        <DetailRow dotColor="var(--color-accent-purple)" dotFilled label={t("chat.tokenUsage.total")} value={formatNumber(totalUsed, locale)} />
        <DetailRow dotColor="color-mix(in srgb, var(--color-accent-purple) 75%, var(--color-foreground))" dotFilled label={t("chat.tokenUsage.input")} value={formatNumber(totalInput, locale)} />
        <DetailRow dotColor="color-mix(in srgb, var(--color-accent-purple) 70%, var(--color-surface-dark))" dotFilled label={t("chat.tokenUsage.output")} value={formatNumber(totalOutput, locale)} />
        {usage.cacheReadTokens > 0 && (
          <DetailRow dotColor="var(--color-accent-green)" dotFilled label={t("chat.tokenUsage.cacheRead")} value={formatNumber(usage.cacheReadTokens, locale)} />
        )}
        {usage.cacheCreationTokens > 0 && (
          <DetailRow dotColor="var(--color-accent-success)" dotFilled label={t("chat.tokenUsage.cacheWrite")} value={formatNumber(usage.cacheCreationTokens, locale)} />
        )}
        {cacheHitRate > 0 && (
          <DetailRow dotColor="var(--color-accent-green)" dotFilled label={t("chat.tokenUsage.cacheHit")} value={`${cacheHitRate.toFixed(1)}%`} />
        )}
        {usage.totalCostUsd > 0 && (
          <DetailRow dotColor="var(--color-accent-amber)" dotFilled label={t("chat.tokenUsage.cost")} value={`$${usage.totalCostUsd.toFixed(4)}`} />
        )}
        {usage.totalDurationMs > 0 && (
          <DetailRow dotColor="var(--color-text-tertiary)" dotFilled label={t("chat.tokenUsage.totalTime")} value={formatDuration(usage.totalDurationMs)} />
        )}
        {!isStreaming && lastDuration != null && lastDuration > 0 && (
          <DetailRow dotColor="var(--color-text-tertiary)" dotFilled label={t("chat.tokenUsage.lastTurn")} value={formatDuration(lastDuration)} />
        )}
      </div>

      {/* Triangle pointer */}
      <div
        style={{
          position: "absolute",
          bottom: -6,
          right: 6,
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

function DetailRow({
  dotColor,
  dotFilled,
  label,
  value,
}: {
  readonly dotColor: string;
  readonly dotFilled: boolean;
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
            backgroundColor: dotFilled ? dotColor : "transparent",
            border: dotFilled ? "none" : `1.5px solid ${dotColor}`,
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

/**
 * Inline cumulative token usage indicator — placed inside the input box bottom row,
 * to the left of the send button. Includes a 1px vertical separator.
 *
 * Shows real-time input/output tokens during streaming and cumulative totals.
 * During streaming, the label changes to show the current turn's input tokens
 * so the user can see that the model is processing their request.
 */
export const ContextUsageBar = memo(function ContextUsageBar({
  conversationId,
  onCompact,
}: {
  readonly conversationId: string | null | undefined;
  readonly onCompact?: () => void;
}) {
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const hasConversation = conversationId != null;
  const lastUsage = useAgentStatusStore(
    useCallback((state) => {
      if (!conversationId) return null;
      if (conversationId === activeConversationId) {
        return state.lastUsage;
      }
      return state._agentStatusCache[conversationId]?.lastUsage ?? null;
    }, [activeConversationId, conversationId]),
  );
  const streamUsage = useAgentStatusStore(
    useCallback((state) => {
      if (!conversationId) return null;
      if (conversationId === activeConversationId) {
        return state.streamUsage;
      }
      return state._agentStatusCache[conversationId]?.streamUsage ?? null;
    }, [activeConversationId, conversationId]),
  );
  const lastStreamUsage = useAgentStatusStore(
    useCallback((state) => {
      if (!conversationId) return null;
      if (conversationId === activeConversationId) {
        return state.lastStreamUsage;
      }
      return state._agentStatusCache[conversationId]?.lastStreamUsage ?? null;
    }, [activeConversationId, conversationId]),
  );
  const contextUsage = useAgentStatusStore(
    useCallback((state) => {
      if (!conversationId) return null;
      if (conversationId === activeConversationId) {
        return state.contextUsage;
      }
      return state._agentStatusCache[conversationId]?.contextUsage ?? null;
    }, [activeConversationId, conversationId]),
  );
  const lastTurnDurationMs = useAgentStatusStore(
    useCallback((state) => {
      if (!conversationId) return null;
      if (conversationId === activeConversationId) {
        return state.lastTurnDurationMs;
      }
      return state._agentStatusCache[conversationId]?.lastTurnDurationMs ?? null;
    }, [activeConversationId, conversationId]),
  );
  const compacting = useAgentStatusStore((state) => state.compacting);
  const { getRunState } = useConversationStatus();
  const [hovered, setHovered] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current == null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const hideTooltip = useCallback(() => {
    clearCloseTimer();
    setHovered(false);
  }, [clearCloseTimer]);

  const showTooltip = useCallback(() => {
    clearCloseTimer();
    setHovered(true);
  }, [clearCloseTimer]);

  const scheduleHideTooltip = useCallback(() => {
    if (closeTimerRef.current != null) return;
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false);
      closeTimerRef.current = null;
    }, 180);
  }, []);

  const isPointerInsideRoot = useCallback((event: PointerEvent) => {
    const root = rootRef.current;
    if (!root) return false;
    const hitTarget = document.elementFromPoint(event.clientX, event.clientY);
    if (hitTarget) return root.contains(hitTarget);
    return event.target instanceof Node && root.contains(event.target);
  }, []);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  useEffect(() => {
    if (!hovered) return;

    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      hideTooltip();
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (isPointerInsideRoot(event)) {
        clearCloseTimer();
        return;
      }
      scheduleHideTooltip();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideTooltip();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", hideTooltip);
    window.addEventListener("resize", hideTooltip);
    window.addEventListener("scroll", hideTooltip, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", hideTooltip);
      window.removeEventListener("resize", hideTooltip);
      window.removeEventListener("scroll", hideTooltip, true);
    };
  }, [clearCloseTimer, hideTooltip, hovered, isPointerInsideRoot, scheduleHideTooltip]);

  if (!hasConversation) return null;

  const usage = lastUsage ?? EMPTY_USAGE;
  const runState = getRunState(conversationId);
  const isStreaming = runState.isRunning;
  const isCompacting = compacting?.active === true
    && (!compacting.conversationId || compacting.conversationId === conversationId);

  const totalUsed = resolveContextUsageTotal({ contextUsage, streamUsage, lastStreamUsage, isStreaming });
  const contextWindow = contextUsage?.maxTokens ?? usage.contextWindow;
  const contextPct = totalUsed > 0 && contextWindow > 0 ? (totalUsed / contextWindow) * 100 : null;
  const contextPctClamped = contextPct == null ? 0 : Math.max(0, Math.min(100, contextPct));
  const ringColor = getContextTone(contextPct);
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference * (1 - contextPctClamped / 100);

  return (
    <>
      {/* TokenSep — 1px vertical separator matching Pencil node gnoMG */}
      <div style={{ width: 1, height: 14, backgroundColor: "var(--color-border)", flexShrink: 0 }} />
      <div
        ref={rootRef}
        className="relative flex items-center justify-center cursor-default"
        onMouseEnter={showTooltip}
        onMouseLeave={scheduleHideTooltip}
        style={{ padding: "0 3px" }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke="var(--color-border-strong)"
            strokeWidth="2"
            opacity={0.85}
          />
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
            transform="rotate(-90 9 9)"
          />
        </svg>
        {hovered && (
          <div onMouseEnter={showTooltip} onMouseLeave={scheduleHideTooltip}>
            <TokenTooltip
              usage={usage}
              contextUsage={contextUsage}
              streamUsage={streamUsage}
              lastStreamUsage={lastStreamUsage}
              isStreaming={isStreaming}
              lastDuration={lastTurnDurationMs}
              onCompact={onCompact}
              isCompacting={isCompacting}
            />
          </div>
        )}
      </div>
    </>
  );
});
