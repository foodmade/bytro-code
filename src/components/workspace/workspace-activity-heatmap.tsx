import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { m } from "motion/react";
import { useHeatmapData, type HeatmapDayData } from "@/hooks/use-heatmap-data";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";
import { useWorkspaceStore } from "@/stores";
import {
  calculateActivityLevel,
  buildCalendarGrid,
  buildDailyTrend,
  computeDailySummary,
  formatTokenCount,
} from "./heatmap-utils";
import { TrendChartSVG } from "./heatmap-trend-chart";
import { useEntryAnimation } from "./workspace-entry-context";

/** Total time budget for the heatmap's column-by-column entrance sweep. */
const HEATMAP_ENTRY_SWEEP_MS = 450;

interface TooltipInfo {
  readonly dateStr: string;
  readonly dayData: HeatmapDayData | undefined;
  readonly x: number;
  readonly y: number;
}

export function WorkspaceActivityHeatmap() {
  const projectId = useWorkspaceStore((s) => s.activeProjectId);
  const { data, loading } = useHeatmapData(projectId);
  const isLight = useIsLightTheme();
  const { t } = useTranslation();
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [hoveredDayIndex, setHoveredDayIndex] = useState<number | null>(null);
  const trendSvgRef = useRef<SVGSVGElement>(null);
  // A monotonically-increasing key, not a boolean: two back-to-back entries
  // that both resolve synchronously would otherwise go true→true with no
  // observable edge (React batches the reset away) — see useEntryAnimation.
  const entryPlayKey = useEntryAnimation(!loading);
  const playEntryAnimation = entryPlayKey > 0;

  const levelColors = isLight
    ? ["#EBEDF0", "#9BE9A8", "#40C463", "#30A14E", "#216E39"]
    : [
        "rgba(63,63,70,0.5)",
        "rgba(6,78,59,0.6)",
        "rgba(4,120,87,0.7)",
        "rgba(16,185,129,0.8)",
        "#34D399",
      ];

  const gridCellColor = (level: 0 | 1 | 2 | 3 | 4) => levelColors[level];

  const handleCellEnter = useCallback(
    (e: React.MouseEvent, dateStr: string, dayData: HeatmapDayData | undefined) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setTooltip({
        dateStr,
        dayData,
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    },
    [],
  );

  const handleCellLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const grid = useMemo(() => buildCalendarGrid(), []);

  const maxValues = useMemo(() => {
    let fileChanges = 0;
    let chatCount = 0;
    let tokenUsage = 0;

    for (const day of data.values()) {
      if (day.file_changes > fileChanges) fileChanges = day.file_changes;
      if (day.chat_count > chatCount) chatCount = day.chat_count;
      if (day.token_usage > tokenUsage) tokenUsage = day.token_usage;
    }

    return { fileChanges, chatCount, tokenUsage } as const;
  }, [data]);

  const totalSessions = useMemo(() => {
    let total = 0;
    for (const day of data.values()) {
      total += day.chat_count;
    }
    return total;
  }, [data]);

  const dailyData = useMemo(() => buildDailyTrend(data), [data]);

  const dailySummary = useMemo(() => computeDailySummary(dailyData), [dailyData]);

  return (
    <div
      className="flex flex-col"
      style={{
        height: "100%",
        borderRadius: 16,
        backgroundColor: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        padding: "14px 16px",
        gap: 6,
        overflow: "hidden",
      }}
    >
      {/* Header + Legend in one row */}
      <div className="flex items-center justify-between w-full" style={{ gap: 8 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <Activity size={14} style={{ color: "#10B981" }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--color-muted-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {t("workspace.activity.title")}
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 8 }}>
          {/* Legend inline */}
          <div className="flex items-center" style={{ gap: 3 }}>
            <span
              style={{ fontSize: 9, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}
            >
              {t("workspace.activity.less")}
            </span>
            {levelColors.map((color, i) => (
              <div
                key={i}
                style={{ width: 7, height: 7, borderRadius: 1.5, backgroundColor: color }}
              />
            ))}
            <span
              style={{ fontSize: 9, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}
            >
              {t("workspace.activity.more")}
            </span>
          </div>
          <span
            className="shrink-0"
            style={{
              fontSize: 10,
              color: "var(--color-muted)",
              fontFamily: "Inter, sans-serif",
              whiteSpace: "nowrap",
            }}
          >
            {loading
              ? t("workspace.activity.loading")
              : t("workspace.activity.sessionsInYear", {
                  count: totalSessions,
                  year: new Date().getFullYear(),
                })}
          </span>
        </div>
      </div>

      {/* Heatmap content */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0" style={{ gap: 4, overflow: "hidden" }}>
        {loading ? (
          <div className="flex items-center justify-center" style={{ height: 120 }}>
            <Loader2 size={20} className="animate-spin" style={{ color: "var(--color-muted)" }} />
          </div>
        ) : (
          <>
            {/* Month labels */}
            <div
              className="flex"
              style={{
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              {grid.monthLabels.map((label, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 10,
                    fontWeight: "normal",
                    color: "var(--color-muted)",
                    fontFamily: "Inter, sans-serif",
                  }}
                >
                  {label.name}
                </span>
              ))}
            </div>

            {/* Heatmap grid */}
            <div
              ref={gridRef}
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${grid.weeks.length}, 1fr)`,
                gap: 2.5,
                width: "100%",
                position: "relative",
              }}
            >
              {Array.from({ length: 7 }, (_, rowIndex) =>
                grid.weeks.map((week, colIndex) => {
                  const dateStr = week.days[rowIndex];

                  if (dateStr === null) {
                    return (
                      <div
                        key={`${rowIndex}-${colIndex}`}
                        style={{ aspectRatio: "1", borderRadius: 2 }}
                      />
                    );
                  }

                  const dayData = data.get(dateStr);
                  const level = calculateActivityLevel(dayData, maxValues);
                  const isHovered = tooltip?.dateStr === dateStr;
                  const columnDelay =
                    (colIndex / Math.max(1, grid.weeks.length - 1)) *
                    (HEATMAP_ENTRY_SWEEP_MS / 1000);

                  return (
                    <m.div
                      // `entryPlayKey` forces a remount on every replay:
                      // `initial` only applies at mount time.
                      key={`${rowIndex}-${colIndex}-${entryPlayKey}`}
                      onMouseEnter={(e) => handleCellEnter(e, dateStr, dayData)}
                      onMouseLeave={handleCellLeave}
                      initial={playEntryAnimation ? { opacity: 0, scale: 0.5 } : false}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.25, ease: "easeOut", delay: columnDelay }}
                      style={{
                        aspectRatio: "1",
                        borderRadius: 2,
                        backgroundColor: gridCellColor(level),
                        outline: isHovered ? "1px solid var(--color-foreground)" : "none",
                        outlineOffset: -1,
                        cursor: "pointer",
                        transition: "outline 0.1s ease",
                      }}
                    />
                  );
                }),
              )}
            </div>

            {/* Heatmap tooltip */}
            {tooltip &&
              createPortal(
                <div
                  style={{
                    position: "fixed",
                    left: tooltip.x,
                    top: tooltip.y - 6,
                    transform: "translate(-50%, -100%)",
                    backgroundColor: isLight ? "#24292f" : "#1c1c1c",
                    color: "#fff",
                    fontSize: 11,
                    fontFamily: "Inter, sans-serif",
                    padding: "6px 10px",
                    borderRadius: 6,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    zIndex: 9999,
                    border: isLight ? "none" : "1px solid rgba(255,255,255,0.1)",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                    lineHeight: 1.4,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: tooltip.dayData ? 2 : 0 }}>
                    {tooltip.dateStr}
                  </div>
                  {tooltip.dayData ? (
                    <div style={{ color: "rgba(255,255,255,0.7)" }}>
                      {[
                        tooltip.dayData.chat_count > 0
                          ? t("workspace.activity.chats", { count: tooltip.dayData.chat_count })
                          : null,
                        tooltip.dayData.file_changes > 0
                          ? t("workspace.activity.fileChanges", {
                              count: tooltip.dayData.file_changes,
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  ) : (
                    <div style={{ color: "rgba(255,255,255,0.5)" }}>
                      {t("workspace.activity.noActivity")}
                    </div>
                  )}
                  <div
                    style={{
                      position: "absolute",
                      left: "50%",
                      bottom: -4,
                      transform: "translateX(-50%) rotate(45deg)",
                      width: 8,
                      height: 8,
                      backgroundColor: isLight ? "#24292f" : "#1c1c1c",
                      borderRight: isLight ? "none" : "1px solid rgba(255,255,255,0.1)",
                      borderBottom: isLight ? "none" : "1px solid rgba(255,255,255,0.1)",
                    }}
                  />
                </div>,
                document.body,
              )}

            {/* Trend Chart — dual line: Sessions (green) + Tokens (purple) */}
            {dailyData.length >= 1 && (
              <div className="flex flex-col flex-1 min-h-0" style={{ gap: 2, marginTop: 0 }}>
                <TrendChartSVG
                  dailyData={dailyData}
                  isLight={isLight}
                  hoveredDayIndex={hoveredDayIndex}
                  onHoverDay={setHoveredDayIndex}
                  svgRef={trendSvgRef}
                  t={t}
                />

                {/* Summary row */}
                <div
                  className="flex items-center justify-between flex-wrap"
                  style={{ paddingTop: 0, gap: "2px 12px" }}
                >
                  <div className="flex items-center" style={{ gap: 6, whiteSpace: "nowrap" }}>
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: "#10B981",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 9,
                        color: "var(--color-foreground)",
                        fontWeight: 500,
                        fontFamily: "Inter, sans-serif",
                      }}
                    >
                      {t("workspace.activity.today", {
                        count: dailySummary.todaySessions,
                      })}
                    </span>
                    <span
                      style={{
                        fontSize: 9,
                        color: "var(--color-muted)",
                        fontFamily: "Inter, sans-serif",
                      }}
                    >
                      ·{" "}
                      {t("workspace.activity.avgPerDay", {
                        count: dailySummary.avgDailySessions,
                      })}
                    </span>
                  </div>
                  <div className="flex items-center" style={{ gap: 6, whiteSpace: "nowrap" }}>
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: "#A855F7",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 9,
                        color: "var(--color-foreground)",
                        fontWeight: 500,
                        fontFamily: "Inter, sans-serif",
                      }}
                    >
                      {formatTokenCount(dailySummary.todayTokens)}{" "}
                      {t("workspace.activity.tokensLabel").toLowerCase()}
                    </span>
                    {dailySummary.tokensChangePercent !== null && (
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: "Inter, sans-serif",
                          color: dailySummary.tokensChangePercent >= 0 ? "#10B981" : "#EF4444",
                        }}
                      >
                        {dailySummary.tokensChangePercent >= 0 ? "↑" : "↓"}
                        {Math.abs(dailySummary.tokensChangePercent)}%
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
