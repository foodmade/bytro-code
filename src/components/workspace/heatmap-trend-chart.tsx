import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { m } from "motion/react";
import {
  type DailyDataPoint,
  MONTH_ABBREVIATIONS,
  buildSmoothPath,
  buildAreaPath,
  formatTokenCount,
} from "./heatmap-utils";
import { useEntryAnimation } from "./workspace-entry-context";

const CHART_PADDING = { left: 24, right: 32, top: 14, bottom: 22 };

/** Interval between X-axis labels (show every Nth day) */
const X_LABEL_STEP = 5;

/** Line-draw timing: sessions (green) draws first, tokens (purple) follows. */
const SESSION_LINE_DURATION_S = 0.6;
const TOKEN_LINE_DELAY_S = 0.15;
const TOKEN_LINE_DURATION_S = 0.6;
const AREA_FADE_DURATION_S = 0.3;

export function TrendChartSVG({
  dailyData,
  isLight,
  hoveredDayIndex,
  onHoverDay,
  svgRef,
  t,
}: {
  dailyData: readonly DailyDataPoint[];
  isLight: boolean;
  hoveredDayIndex: number | null;
  onHoverDay: (index: number | null) => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const uniqueId = useId();
  const sessionFillId = `sessionFill-${uniqueId}`;
  const tokenFillId = `tokenFill-${uniqueId}`;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
        setHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const MIN_CHART_HEIGHT = 48;
  const chartHeight = Math.max(MIN_CHART_HEIGHT, height);

  const plotW = width - CHART_PADDING.left - CHART_PADDING.right;
  const plotH = chartHeight - CHART_PADDING.top - CHART_PADDING.bottom;
  const baseY = CHART_PADDING.top + plotH;

  const {
    sessionPoints,
    tokenPoints,
    sessionLinePath,
    tokenLinePath,
    sessionAreaPath,
    tokenAreaPath,
    maxSessions,
    maxTokens,
  } = useMemo(() => {
    const maxS = Math.max(1, ...dailyData.map((d) => d.sessions));
    const maxT = Math.max(1, ...dailyData.map((d) => d.tokens));
    const sPoints = dailyData.map((_, i) => ({
      x: CHART_PADDING.left + (plotW > 0 ? (i / Math.max(1, dailyData.length - 1)) * plotW : 0),
      y: CHART_PADDING.top + plotH - (dailyData[i].sessions / maxS) * plotH,
    }));
    const tPoints = dailyData.map((_, i) => ({
      x: CHART_PADDING.left + (plotW > 0 ? (i / Math.max(1, dailyData.length - 1)) * plotW : 0),
      y: CHART_PADDING.top + plotH - (dailyData[i].tokens / maxT) * plotH,
    }));
    const sLine = buildSmoothPath(sPoints);
    const tLine = buildSmoothPath(tPoints);
    const bY = CHART_PADDING.top + plotH;
    return {
      sessionPoints: sPoints,
      tokenPoints: tPoints,
      sessionLinePath: sLine,
      tokenLinePath: tLine,
      sessionAreaPath: buildAreaPath(sLine, sPoints, bY),
      tokenAreaPath: buildAreaPath(tLine, tPoints, bY),
      maxSessions: maxS,
      maxTokens: maxT,
    };
  }, [dailyData, plotW, plotH]);

  const xLabels = useMemo(() => {
    return dailyData
      .map((d, i) => {
        const dt = new Date(d.date + "T00:00:00");
        const label = `${MONTH_ABBREVIATIONS[dt.getMonth()]} ${dt.getDate()}`;
        const x =
          CHART_PADDING.left + (plotW > 0 ? (i / Math.max(1, dailyData.length - 1)) * plotW : 0);
        return { label, x, index: i };
      })
      .filter((_, i) => i % X_LABEL_STEP === 0 || i === dailyData.length - 1);
  }, [dailyData, plotW]);

  const sessionTicks = [Math.round(maxSessions / 2), maxSessions];
  const tokenTicks = [Math.round(maxTokens / 2), maxTokens];

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || dailyData.length === 0) return;
      const rect = svgRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left - CHART_PADDING.left;
      const stepW = plotW / Math.max(1, dailyData.length - 1);
      const index = Math.round(mouseX / stepW);
      onHoverDay(Math.max(0, Math.min(dailyData.length - 1, index)));
    },
    [dailyData, plotW, onHoverDay, svgRef],
  );

  const handleMouseLeave = useCallback(() => {
    onHoverDay(null);
  }, [onHoverDay]);

  // A monotonically-increasing key, not a boolean: two back-to-back entries
  // that both resolve synchronously would otherwise go true→true with no
  // observable edge (React batches the reset away) — see useEntryAnimation.
  const entryPlayKey = useEntryAnimation(true);
  const playEntryAnimation = entryPlayKey > 0;

  if (width === 0 || height === 0) {
    return <div ref={containerRef} style={{ width: "100%", flex: 1, minHeight: 48 }} />;
  }

  return (
    <div ref={containerRef} style={{ width: "100%", flex: 1, minHeight: 48, position: "relative" }}>
      <svg
        ref={svgRef}
        width={width}
        height={chartHeight}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ display: "block", cursor: "crosshair" }}
      >
        <defs>
          <linearGradient id={sessionFillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10B981" stopOpacity={isLight ? 0.15 : 0.2} />
            <stop offset="100%" stopColor="#10B981" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id={tokenFillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#A855F7" stopOpacity={isLight ? 0.12 : 0.15} />
            <stop offset="100%" stopColor="#A855F7" stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* Horizontal grid line at 50% */}
        <line
          x1={CHART_PADDING.left}
          y1={CHART_PADDING.top + plotH * 0.5}
          x2={width - CHART_PADDING.right}
          y2={CHART_PADDING.top + plotH * 0.5}
          stroke={isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.06)"}
          strokeDasharray="3 3"
        />

        {/* Baseline */}
        <line
          x1={CHART_PADDING.left}
          y1={baseY}
          x2={width - CHART_PADDING.right}
          y2={baseY}
          stroke={isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)"}
        />

        {/* Area fills — fade in once their line has finished drawing.
            `entryPlayKey` forces a remount on every replay: `initial` only
            applies at mount time. */}
        {sessionAreaPath && (
          <m.path
            key={`session-area-${entryPlayKey}`}
            d={sessionAreaPath}
            fill={`url(#${sessionFillId})`}
            initial={playEntryAnimation ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{
              duration: AREA_FADE_DURATION_S,
              ease: "easeOut",
              delay: SESSION_LINE_DURATION_S,
            }}
          />
        )}
        {tokenAreaPath && (
          <m.path
            key={`token-area-${entryPlayKey}`}
            d={tokenAreaPath}
            fill={`url(#${tokenFillId})`}
            initial={playEntryAnimation ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{
              duration: AREA_FADE_DURATION_S,
              ease: "easeOut",
              delay: TOKEN_LINE_DELAY_S + TOKEN_LINE_DURATION_S,
            }}
          />
        )}

        {/* Lines — sessions draws first, tokens follows */}
        {sessionLinePath && (
          <m.path
            key={`session-line-${entryPlayKey}`}
            d={sessionLinePath}
            fill="none"
            stroke="#10B981"
            strokeWidth={1.5}
            initial={playEntryAnimation ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{ duration: SESSION_LINE_DURATION_S, ease: "easeOut" }}
          />
        )}
        {tokenLinePath && (
          <m.path
            key={`token-line-${entryPlayKey}`}
            d={tokenLinePath}
            fill="none"
            stroke="#A855F7"
            strokeWidth={1.5}
            initial={playEntryAnimation ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{
              duration: TOKEN_LINE_DURATION_S,
              ease: "easeOut",
              delay: TOKEN_LINE_DELAY_S,
            }}
          />
        )}

        {/* Single data point — show dots when only 1 day */}
        {dailyData.length === 1 && sessionPoints[0] && (
          <>
            <circle
              cx={sessionPoints[0].x}
              cy={sessionPoints[0].y}
              r={3.5}
              fill="#10B981"
              stroke={isLight ? "#fff" : "#1c1c1c"}
              strokeWidth={1.5}
            />
            <circle
              cx={tokenPoints[0].x}
              cy={tokenPoints[0].y}
              r={3.5}
              fill="#A855F7"
              stroke={isLight ? "#fff" : "#1c1c1c"}
              strokeWidth={1.5}
            />
          </>
        )}

        {/* Left Y axis labels (Sessions) */}
        {sessionTicks.map((val) => {
          const y = CHART_PADDING.top + plotH - (val / maxSessions) * plotH;
          return (
            <text
              key={`s-${val}`}
              x={CHART_PADDING.left - 4}
              y={y + 3}
              textAnchor="end"
              fontSize={8}
              fill="var(--color-muted)"
              fontFamily="Inter, sans-serif"
            >
              {val}
            </text>
          );
        })}

        {/* Right Y axis labels (Tokens) */}
        {tokenTicks.map((val) => {
          const y = CHART_PADDING.top + plotH - (val / maxTokens) * plotH;
          return (
            <text
              key={`t-${val}`}
              x={width - CHART_PADDING.right + 4}
              y={y + 3}
              textAnchor="start"
              fontSize={8}
              fill="var(--color-muted)"
              fontFamily="Inter, sans-serif"
            >
              {formatTokenCount(val)}
            </text>
          );
        })}

        {/* X axis date labels (sampled every X_LABEL_STEP days) */}
        {xLabels.map(({ label, x, index }) => (
          <text
            key={index}
            x={x}
            y={chartHeight - 4}
            textAnchor="middle"
            fontSize={8}
            fill="var(--color-muted)"
            fontFamily="Inter, sans-serif"
          >
            {label}
          </text>
        ))}

        {/* Hover vertical line + dots */}
        {hoveredDayIndex !== null && sessionPoints[hoveredDayIndex] && (
          <>
            <line
              x1={sessionPoints[hoveredDayIndex].x}
              y1={CHART_PADDING.top}
              x2={sessionPoints[hoveredDayIndex].x}
              y2={baseY}
              stroke={isLight ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.15)"}
              strokeDasharray="3 3"
            />
            <circle
              cx={sessionPoints[hoveredDayIndex].x}
              cy={sessionPoints[hoveredDayIndex].y}
              r={3}
              fill="#10B981"
              stroke={isLight ? "#fff" : "#1c1c1c"}
              strokeWidth={1.5}
            />
            <circle
              cx={tokenPoints[hoveredDayIndex].x}
              cy={tokenPoints[hoveredDayIndex].y}
              r={3}
              fill="#A855F7"
              stroke={isLight ? "#fff" : "#1c1c1c"}
              strokeWidth={1.5}
            />
          </>
        )}

        {/* Legend (top-right corner) */}
        <line
          x1={width - CHART_PADDING.right - 100}
          y1={CHART_PADDING.top - 4}
          x2={width - CHART_PADDING.right - 90}
          y2={CHART_PADDING.top - 4}
          stroke="#10B981"
          strokeWidth={1.5}
        />
        <text
          x={width - CHART_PADDING.right - 87}
          y={CHART_PADDING.top - 1}
          fontSize={7}
          fill="var(--color-muted)"
          fontFamily="Inter, sans-serif"
        >
          {t("workspace.activity.sessions")}
        </text>
        <line
          x1={width - CHART_PADDING.right - 48}
          y1={CHART_PADDING.top - 4}
          x2={width - CHART_PADDING.right - 38}
          y2={CHART_PADDING.top - 4}
          stroke="#A855F7"
          strokeWidth={1.5}
        />
        <text
          x={width - CHART_PADDING.right - 35}
          y={CHART_PADDING.top - 1}
          fontSize={7}
          fill="var(--color-muted)"
          fontFamily="Inter, sans-serif"
        >
          {t("workspace.activity.tokensLabel")}
        </text>
      </svg>

      {/* Hover tooltip via portal */}
      {hoveredDayIndex !== null &&
        svgRef.current &&
        dailyData[hoveredDayIndex] &&
        (() => {
          const svgRect = svgRef.current!.getBoundingClientRect();
          return createPortal(
            <div
              style={{
                position: "fixed",
                left: svgRect.left + sessionPoints[hoveredDayIndex].x,
                top: svgRect.top + CHART_PADDING.top - 6,
                transform: "translate(-50%, -100%)",
                backgroundColor: isLight ? "#24292f" : "#1c1c1c",
                color: "#fff",
                fontSize: 10,
                fontFamily: "Inter, sans-serif",
                padding: "5px 8px",
                borderRadius: 5,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 9999,
                border: isLight ? "none" : "1px solid rgba(255,255,255,0.1)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                lineHeight: 1.4,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 1 }}>
                {dailyData[hoveredDayIndex].date}
              </div>
              <div style={{ color: "rgba(255,255,255,0.7)" }}>
                {dailyData[hoveredDayIndex].sessions}{" "}
                {t("workspace.activity.sessions").toLowerCase()}
                {" \u00b7 "}
                {formatTokenCount(dailyData[hoveredDayIndex].tokens)}{" "}
                {t("workspace.activity.tokensLabel").toLowerCase()}
              </div>
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  bottom: -4,
                  transform: "translateX(-50%) rotate(45deg)",
                  width: 7,
                  height: 7,
                  backgroundColor: isLight ? "#24292f" : "#1c1c1c",
                  borderRight: isLight ? "none" : "1px solid rgba(255,255,255,0.1)",
                  borderBottom: isLight ? "none" : "1px solid rgba(255,255,255,0.1)",
                }}
              />
            </div>,
            document.body,
          );
        })()}
    </div>
  );
}
