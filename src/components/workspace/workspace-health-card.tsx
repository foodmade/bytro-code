import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { m, useReducedMotion } from "motion/react";
import {
  Circle,
  CircleCheck,
  CircleX,
  Loader,
  HeartPulse,
  ShieldCheck,
  Scan,
  ArrowUpRight,
  X,
  AlertTriangle,
  AlertCircle,
  Info,
} from "lucide-react";
import { useHealthCheckStore } from "@/stores/health-check-store";
import { useHealthCheck, loadLastHealthCheckResult } from "@/hooks/use-health-check";
import { useCountUp } from "@/hooks/use-count-up";
import { useWorkspaceStore, useAppStore } from "@/stores";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { useWorkspaceEntryToken } from "./workspace-entry-context";
import type { DimensionState, HealthIssue } from "@/stores/health-check-store";

// ---- i18n dimension label helper ----

const DIM_I18N_MAP: Record<string, string> = {
  "code-standards": "dimCodeStandards",
  security: "dimSecurity",
  "perf-deps": "dimPerfDeps",
  "tech-debt": "dimTechDebt",
  maintainability: "dimMaintainability",
};

function dimLabel(id: string, t: (key: string) => string): string {
  const key = DIM_I18N_MAP[id];
  return key ? t(`workspace.healthCheck.${key}`) : id;
}

const DIM_COLOR_MAP: Record<string, string> = {
  "code-standards": "#10B981",
  maintainability: "#F59E0B",
  security: "#4285F4",
  "perf-deps": "#A855F7",
  "tech-debt": "#06B6D4",
};

function dimColor(id: string): string {
  return DIM_COLOR_MAP[id] ?? "#a1a1aa";
}

// ---- Score helpers ----

function getScoreColor(score: number): string {
  if (score >= 90) return "#10B981";
  if (score >= 70) return "#3B82F6";
  if (score >= 60) return "#F59E0B";
  return "#EF4444";
}

function getScoreLabel(score: number, t: (key: string) => string): string {
  if (score >= 90) return t("workspace.healthCheck.scoreExcellent");
  if (score >= 80) return t("workspace.healthCheck.scoreGood");
  if (score >= 60) return t("workspace.healthCheck.scoreAverage");
  return t("workspace.healthCheck.scoreNeedsImprovement");
}

// ---- Dimension Bar (completed / idle-with-result state) ----

function DimensionBar({
  dim,
  translatedLabel,
  onClick,
  animate = false,
  animateDelay = 0,
  animateKey = 0,
}: {
  readonly dim: DimensionState;
  readonly translatedLabel: string;
  readonly onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  readonly animate?: boolean;
  readonly animateDelay?: number;
  readonly animateKey?: number;
}) {
  const prefersReducedMotion = useReducedMotion();
  const playAnimation = animate && !prefersReducedMotion;
  const rawScore = dim.score ?? 0;
  const score = useCountUp(rawScore, playAnimation, animateDelay, 800, animateKey);
  const color = dimColor(dim.id);
  const barWidth = 80;
  const fillWidth = Math.round((rawScore / 100) * barWidth);
  const hasDetails = dim.findings.length > 0 || dim.issues.length > 0;
  const clickable = hasDetails || rawScore > 0;

  return (
    <div
      className="flex items-center justify-between w-full"
      style={{
        padding: "2px 0",
        cursor: clickable ? "pointer" : "default",
      }}
      onClick={clickable ? onClick : undefined}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: "normal",
          color: "var(--color-muted-foreground)",
          fontFamily: "Inter, sans-serif",
        }}
      >
        {translatedLabel}
      </span>
      <div className="flex items-center" style={{ gap: 8 }}>
        <div style={{ position: "relative", width: barWidth, height: 4 }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 2,
              backgroundColor: "var(--color-border)",
            }}
          />

          <m.div
            // `animateKey` forces a remount on every replay: `initial` only
            // applies at mount time, and a plain animate boolean can go
            // true→true across two entries (React batches away the reset) —
            // see useEntryAnimation for why a counter is needed instead.
            key={animateKey}
            initial={playAnimation ? { width: 0 } : false}
            animate={{ width: fillWidth }}
            transition={{ duration: 0.5, ease: "easeOut", delay: animateDelay / 1000 }}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              borderRadius: 2,
              backgroundColor: color,
            }}
          />
        </div>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color,
            fontFamily: "Inter, sans-serif",
            minWidth: 20,
            textAlign: "right",
          }}
        >
          {score}
        </span>
      </div>
    </div>
  );
}

// ---- Scanning Ring Progress ----

function ScanningRingProgress({
  completed,
  total,
}: {
  readonly completed: number;
  readonly total: number;
}) {
  const radius = 34;
  const strokeWidth = 5;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? completed / total : 0;
  const dashOffset = circumference * (1 - progress);

  return (
    <div
      className="flex items-center justify-center"
      style={{ width: 80, height: 80, position: "relative" }}
    >
      <svg width={80} height={80} viewBox="0 0 80 80" style={{ transform: "rotate(-90deg)" }}>
        {/* Background track */}
        <circle
          cx={40}
          cy={40}
          r={radius}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={strokeWidth}
        />

        {/* Progress arc */}
        <circle
          cx={40}
          cy={40}
          r={radius}
          fill="none"
          stroke="#F59E0B"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="health-ring-progress"
        />
      </svg>
      <span
        style={{
          position: "absolute",
          fontSize: 18,
          fontWeight: 800,
          color: "var(--color-foreground)",
          fontFamily: "Inter, sans-serif",
        }}
      >
        {completed}/{total}
      </span>
    </div>
  );
}

// ---- Severity icon & color ----

const SEVERITY_CONFIG = {
  critical: { icon: AlertCircle, color: "#EF4444", bg: "rgba(239,68,68,0.08)" },
  warning: { icon: AlertTriangle, color: "#F59E0B", bg: "rgba(245,158,11,0.08)" },
  info: { icon: Info, color: "#3B82F6", bg: "rgba(59,130,246,0.08)" },
} as const;

// ---- Build markdown for a dimension ----

function buildDimensionMarkdown(dim: DimensionState, t: (key: string) => string): string {
  const parts: string[] = [];

  if (dim.findings.length > 0) {
    parts.push(`### ${t("workspace.healthCheck.keyFindings")}\n`);
    for (const f of dim.findings) {
      parts.push(`- ${f}`);
    }
    parts.push("");
  }

  const grouped: Record<string, ReadonlyArray<HealthIssue>> = {
    critical: dim.issues.filter((i) => i.severity === "critical"),
    warning: dim.issues.filter((i) => i.severity === "warning"),
    info: dim.issues.filter((i) => i.severity === "info"),
  };

  const sectionKeys: Record<string, string> = {
    critical: "workspace.healthCheck.criticalIssues",
    warning: "workspace.healthCheck.warningIssues",
    info: "workspace.healthCheck.infoIssues",
  };

  for (const severity of ["critical", "warning", "info"] as const) {
    const issues = grouped[severity];
    if (issues.length === 0) continue;
    parts.push(`### ${t(sectionKeys[severity])}\n`);
    for (const issue of issues) {
      parts.push(`**${issue.message}**`);
      if (issue.file) {
        parts.push(`${t("workspace.healthCheck.filePath")}: \`${issue.file}\``);
      }
      parts.push(`> ${t("workspace.healthCheck.suggestionLabel")}: ${issue.suggestion}\n`);
    }
  }

  if (parts.length === 0) {
    parts.push(`*${t("workspace.healthCheck.noDetails")}*`);
  }

  return parts.join("\n");
}

// ---- Dimension Detail Popover ----

function DimensionDetailPopover({
  dim,
  translatedLabel,
  anchorRect,
  onClose,
}: {
  readonly dim: DimensionState;
  readonly translatedLabel: string;
  readonly anchorRect: DOMRect;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const score = dim.score ?? 0;
  const color = getScoreColor(score);
  const md = buildDimensionMarkdown(dim, t);

  // Click-outside and Escape to close
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Position: to the left of the anchor bar
  const popoverWidth = 380;
  const gap = 12;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let left = anchorRect.left - popoverWidth - gap;
  let top = anchorRect.top - 8;

  // If not enough space on the left, show on the right
  if (left < 8) {
    left = anchorRect.right + gap;
  }
  // If still overflows right, center below
  if (left + popoverWidth > viewportW - 8) {
    left = Math.max(8, anchorRect.left + anchorRect.width / 2 - popoverWidth / 2);
    top = anchorRect.bottom + gap;
  }

  // Ensure it doesn't go off-screen vertically
  const maxTop = viewportH - 420;
  if (top > maxTop) top = Math.max(8, maxTop);

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        left,
        top,
        width: popoverWidth,
        maxHeight: 400,
        zIndex: 9999,
        borderRadius: 12,
        backgroundColor: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        boxShadow: "0 16px 48px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.05)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        animation: "health-popover-in 0.15s ease-out",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: color,
            }}
          />

          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--color-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {translatedLabel}
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color,
              fontFamily: "Inter, sans-serif",
            }}
          >
            {score}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 4,
            borderRadius: 4,
            color: "var(--color-muted)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Issue summary badges */}
      {dim.issues.length > 0 && (
        <div
          className="flex shrink-0"
          style={{ gap: 6, padding: "10px 16px 0 16px", flexWrap: "wrap" }}
        >
          {(["critical", "warning", "info"] as const).map((severity) => {
            const count = dim.issues.filter((i) => i.severity === severity).length;
            if (count === 0) return null;
            const cfg = SEVERITY_CONFIG[severity];
            const Icon = cfg.icon;
            return (
              <div
                key={severity}
                className="flex items-center"
                style={{
                  gap: 4,
                  padding: "3px 8px",
                  borderRadius: 4,
                  backgroundColor: cfg.bg,
                  fontSize: 11,
                  fontWeight: 600,
                  color: cfg.color,
                  fontFamily: "Inter, sans-serif",
                }}
              >
                <Icon size={11} />
                {count}
              </div>
            );
          })}
        </div>
      )}

      {/* Markdown content */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "12px 16px 16px 16px" }}>
        <MarkdownRenderer content={md} variant="compact" />
      </div>
    </div>,
    document.body,
  );
}

// ---- Dimension Row (scanning state) ----

function DimensionRow({
  dim,
  translatedLabel,
}: {
  readonly dim: DimensionState;
  readonly translatedLabel: string;
}) {
  const { t } = useTranslation();

  if (dim.status === "completed") {
    return (
      <div className="flex items-center justify-between w-full" style={{ height: 22 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <CircleCheck size={14} style={{ color: "#10B981" }} />
          <span
            style={{
              fontSize: 12,
              color: "var(--color-muted-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {translatedLabel}
          </span>
        </div>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#10B981",
            fontFamily: "Inter, sans-serif",
          }}
        >
          {dim.score ?? ""}
        </span>
      </div>
    );
  }

  if (dim.status === "running") {
    return (
      <div className="flex items-center justify-between w-full" style={{ height: 22 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <Loader size={14} className="animate-spin" style={{ color: "#F59E0B" }} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "#F59E0B",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {translatedLabel}
          </span>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: "#F59E0B",
            fontFamily: "Inter, sans-serif",
          }}
        >
          {t("workspace.healthCheck.analyzing")}
        </span>
      </div>
    );
  }

  if (dim.status === "cancelled") {
    return (
      <div className="flex items-center justify-between w-full" style={{ height: 22 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <CircleX size={14} style={{ color: "var(--color-muted)" }} />
          <span
            style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}
          >
            {translatedLabel}
          </span>
        </div>
        <span
          style={{ fontSize: 11, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}
        >
          {t("workspace.healthCheck.cancelled")}
        </span>
      </div>
    );
  }

  // pending
  return (
    <div className="flex items-center justify-between w-full" style={{ height: 22 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <Circle size={14} style={{ color: "var(--color-muted)" }} />
        <span
          style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}
        >
          {translatedLabel}
        </span>
      </div>
      <span style={{ fontSize: 11, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}>
        {t("workspace.healthCheck.waiting")}
      </span>
    </div>
  );
}

// ---- Main Component ----

export function WorkspaceHealthCard() {
  const { t } = useTranslation();
  const workspace = useWorkspaceStore((s) => s.activeWorkspace);
  const phase = useHealthCheckStore((s) => s.phase);
  const dimensions = useHealthCheckStore((s) => s.dimensions);
  const overallScore = useHealthCheckStore((s) => s.overallScore);
  const lastResult = useHealthCheckStore((s) => s.lastResult);
  const { startCheck, cancelCheck } = useHealthCheck();
  const entryToken = useWorkspaceEntryToken();
  const prefersReducedMotion = useReducedMotion();

  // Popover state
  const [activeDimId, setActiveDimId] = useState<string | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<DOMRect | null>(null);

  const handleDimClick = useCallback(
    (dim: DimensionState, e: React.MouseEvent<HTMLDivElement>) => {
      if (activeDimId === dim.id) {
        setActiveDimId(null);
        setPopoverAnchor(null);
      } else {
        setActiveDimId(dim.id);
        setPopoverAnchor(e.currentTarget.getBoundingClientRect());
      }
    },
    [activeDimId],
  );

  const closePopover = useCallback(() => {
    setActiveDimId(null);
    setPopoverAnchor(null);
  }, []);

  // Close popover when phase changes
  useEffect(() => {
    closePopover();
  }, [phase, closePopover]);

  // Score count-up animation: on scanning → completed transition, or on a
  // fresh entry into the workspace (first mount / switching workspace) when
  // a result is already available.
  //
  // `scoreAnimationKey` is a monotonically-increasing counter, not just a
  // boolean: React 18 batches multiple setState calls inside one effect into
  // a single render, so two back-to-back entries that both resolve
  // synchronously (e.g. cached lastResult) would otherwise go true→true with
  // no observable edge — no remount, no replay. Motion's `initial` is also
  // mount-only, so DimensionBar's progress-bar animation needs this key to
  // force a remount on every replay (see useEntryAnimation for the same
  // reasoning applied to the shared hook).
  const prevPhaseRef = useRef(phase);
  const [scoreAnimating, setScoreAnimating] = useState(false);
  const [scoreAnimationKey, setScoreAnimationKey] = useState(0);

  useEffect(() => {
    if (prevPhaseRef.current === "scanning" && phase === "completed") {
      setScoreAnimating(true);
      setScoreAnimationKey((k) => k + 1);
    } else if (phase === "idle" || phase === "scanning") {
      setScoreAnimating(false);
    }
    prevPhaseRef.current = phase;
  }, [phase]);

  // `lastResult` loads asynchronously from SQLite, so it may arrive after
  // `entryToken` has already changed — track whether this entry has already
  // played its animation rather than gating purely on the token edge, so a
  // late-arriving result still gets one play-through.
  const lastEntryTokenRef = useRef<number | null>(null);
  const hasPlayedForEntryRef = useRef(false);
  useEffect(() => {
    if (entryToken !== lastEntryTokenRef.current) {
      lastEntryTokenRef.current = entryToken;
      hasPlayedForEntryRef.current = false;
    }
    if (prefersReducedMotion || hasPlayedForEntryRef.current) return;
    const hasResult = phase === "completed" || lastResult != null;
    if (hasResult) {
      hasPlayedForEntryRef.current = true;
      setScoreAnimating(true);
      setScoreAnimationKey((k) => k + 1);
    }
  }, [entryToken, phase, lastResult, prefersReducedMotion]);

  useEffect(() => {
    const wsId = workspace?.id ?? null;
    useHealthCheckStore.getState().switchWorkspace(wsId);
    // Only load persisted result from DB if no live/snapshot state was restored
    if (wsId && useHealthCheckStore.getState().phase === "idle") {
      loadLastHealthCheckResult(wsId);
    }
  }, [workspace?.id]);

  const currentRunning = dimensions.find((d) => d.status === "running");

  const isScanning = phase === "scanning";
  const isComplete = phase === "completed";
  const hasLastResult = lastResult != null;

  const displayScore = isComplete ? overallScore : hasLastResult ? lastResult.overallScore : null;
  const displayDims = isScanning
    ? dimensions
    : isComplete
      ? dimensions
      : hasLastResult
        ? lastResult.dimensions
        : null;
  const animatedMainScore = useCountUp(
    displayScore ?? 0,
    scoreAnimating,
    0,
    1500,
    scoreAnimationKey,
  );
  const isIdle = !isScanning && displayScore == null;

  // Find the active dimension for popover
  const activeDim =
    activeDimId && displayDims ? (displayDims.find((d) => d.id === activeDimId) ?? null) : null;

  const cardBg = "var(--color-surface)";
  const cardBorder = "var(--color-border)";

  return (
    <div
      className={isScanning ? "health-border-glow" : ""}
      style={{
        position: "relative",
        height: "100%",
        borderRadius: 16,
        padding: isScanning ? 1.5 : 0,
      }}
    >
      <div
        className="flex flex-col"
        style={{
          position: "relative",
          zIndex: 1,
          height: "100%",
          padding: "16px 20px",
          borderRadius: isScanning ? 15 : 16,
          backgroundColor: cardBg,
          border: isScanning ? "none" : `1px solid ${cardBorder}`,
          gap: 12,
          overflow: "hidden",
        }}
      >
        {isIdle ? (
          <>
            {/* Idle state — MhDhP design */}
            <div
              className="flex flex-col items-center justify-center w-full"
              style={{ flex: 1, gap: 12, minHeight: 0 }}
            >
              <div
                className="flex items-center justify-center"
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: "var(--color-border)",
                }}
              >
                <ShieldCheck size={24} style={{ color: "var(--color-muted)" }} />
              </div>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--color-muted-foreground)",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {t("workspace.healthCheck.title")}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--color-muted)",
                  fontFamily: "Inter, sans-serif",
                  textAlign: "center",
                  lineHeight: 1.5,
                }}
              >
                {t("workspace.healthCheck.description")}
              </span>
            </div>
            <button
              onClick={startCheck}
              className="flex items-center justify-center w-full health-start-btn"
              style={{
                height: 40,
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                gap: 8,
                flexShrink: 0,
              }}
            >
              <Scan size={16} style={{ color: "#FFFFFF" }} />
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#FFFFFF",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {t("workspace.healthCheck.startCheck")}
              </span>
            </button>
          </>
        ) : (
          <>
            {/* Header — scanning & result states */}
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center" style={{ gap: 8 }}>
                <HeartPulse size={14} style={{ color: isScanning ? "#F59E0B" : "#10B981" }} />
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--color-muted-foreground)",
                    fontFamily: "Inter, sans-serif",
                  }}
                >
                  {t("workspace.healthCheck.projectQuality")}
                </span>
              </div>
              <div className="flex items-center" style={{ gap: 8 }}>
                {isScanning ? (
                  <button
                    onClick={cancelCheck}
                    className="flex items-center health-scanning-badge"
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "none",
                      cursor: "pointer",
                      gap: 6,
                    }}
                  >
                    <Loader size={12} className="animate-spin health-scanning-badge-icon" />
                    <span
                      className="health-scanning-badge-text"
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        fontFamily: "Inter, sans-serif",
                      }}
                    >
                      {t("workspace.healthCheck.checking")}
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={startCheck}
                    className="health-start-btn-sm"
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 10,
                      fontWeight: 600,
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    {t("workspace.healthCheck.startCheck")}
                  </button>
                )}
                <button
                  onClick={() => useAppStore.getState().setActiveView("health-check")}
                  className="flex items-center justify-center native-css-hover"
                  style={
                    {
                      padding: "4px 6px",
                      borderRadius: 6,
                      backgroundColor: "var(--color-border)",
                      border: "none",
                      cursor: "pointer",
                      transition: "opacity 0.15s ease",
                      "--native-hover-opacity": "0.7",
                    } as React.CSSProperties
                  }
                >
                  <ArrowUpRight size={12} style={{ color: "var(--color-muted)" }} />
                </button>
              </div>
            </div>

            {/* Scanning state */}
            {isScanning ? (
              <>
                <div
                  className="flex flex-col items-center justify-center w-full"
                  style={{ gap: 12, flex: 1, minHeight: 0 }}
                >
                  <ScanningRingProgress
                    completed={dimensions.filter((d) => d.status === "completed").length}
                    total={dimensions.length}
                  />

                  <span
                    className="health-text-pulse"
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--color-muted-foreground)",
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    {currentRunning
                      ? t("workspace.healthCheck.analyzingDim", {
                          label: dimLabel(currentRunning.id, t),
                        })
                      : t("workspace.healthCheck.checking")}
                  </span>
                  <div style={{ position: "relative", width: 200, height: 4 }}>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: 2,
                        backgroundColor: "var(--color-border)",
                      }}
                    />

                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${(dimensions.filter((d) => d.status === "completed").length / dimensions.length) * 100}%`,
                        borderRadius: 2,
                        backgroundColor: "#F59E0B",
                        transition: "width 0.6s ease",
                      }}
                    />
                  </div>
                </div>
                <div className="flex flex-col w-full" style={{ gap: 8 }}>
                  {dimensions.map((dim) => (
                    <DimensionRow key={dim.id} dim={dim} translatedLabel={dimLabel(dim.id, t)} />
                  ))}
                </div>
              </>
            ) : (
              <>
                {/* Score display — centered, fills remaining space */}
                <div
                  className="flex flex-col items-center justify-center w-full"
                  style={{ gap: 2, flex: 1, minHeight: 0 }}
                >
                  <span
                    style={{
                      fontSize: 40,
                      fontWeight: 900,
                      color: "var(--color-foreground)",
                      fontFamily: "Inter, sans-serif",
                      lineHeight: 1,
                    }}
                  >
                    {scoreAnimating ? animatedMainScore : displayScore}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: "normal",
                      color: "var(--color-muted-foreground)",
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    / 100 · {getScoreLabel(displayScore!, t)}
                  </span>
                </div>
                <div className="flex flex-col w-full shrink-0" style={{ gap: 4 }}>
                  {displayDims?.map((dim, index) => (
                    <DimensionBar
                      key={dim.id}
                      dim={dim}
                      translatedLabel={dimLabel(dim.id, t)}
                      onClick={(e) => handleDimClick(dim, e)}
                      animate={scoreAnimating}
                      animateDelay={200 + index * 150}
                      animateKey={scoreAnimationKey}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* Dimension detail popover */}
        {activeDim && popoverAnchor && (
          <DimensionDetailPopover
            dim={activeDim}
            translatedLabel={dimLabel(activeDim.id, t)}
            anchorRect={popoverAnchor}
            onClose={closePopover}
          />
        )}
      </div>
    </div>
  );
}
