import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useHealthCheckStore } from "@/stores/health-check-store";
import type { PersistedHealthCheckResult, DimensionId } from "@/stores/health-check-store";

const CARD_STYLE = {
  backgroundColor: "var(--color-surface-raised)",
  borderRadius: 12,
  border: "1px solid var(--color-border-light)",
  boxShadow: "var(--shadow-card)",
} as const;

const DIMENSION_COLORS: Record<DimensionId, string> = {
  "code-standards": "#10B981",
  "security": "#0A84FF",
  "perf-deps": "#A855F7",
  "tech-debt": "#06B6D4",
  "maintainability": "#F59E0B",
};

export function HealthCheckHistoryView() {
  const { t } = useTranslation();
  const historyResults = useHealthCheckStore((s) => s.historyResults);
  const issueFixStatuses = useHealthCheckStore((s) => s.issueFixStatuses);

  // History is ordered newest-first, reverse for chart display (oldest left)
  const chartData = useMemo(() => [...historyResults].reverse(), [historyResults]);

  // Fix stats from current session
  const fixStats = useMemo(() => {
    let fixed = 0;
    let pending = 0;
    let ignored = 0;
    for (const status of Object.values(issueFixStatuses)) {
      if (status === "fixed") fixed++;
      else if (status === "ignored") ignored++;
      else pending++;
    }
    const total = fixed + pending + ignored;
    return { fixed, pending, ignored, total };
  }, [issueFixStatuses]);

  if (historyResults.length === 0) {
    return <EmptyHistory />;
  }

  const latest = historyResults[0];
  const previous = historyResults.length > 1 ? historyResults[1] : null;
  const scoreChange = previous ? latest.overallScore - previous.overallScore : 0;

  return (
    <div className="flex" style={{ gap: 20, flex: 1, minHeight: 0 }}>
      {/* Left column — flex:1, trend chart card */}
      <div className="flex flex-col flex-1 min-w-0" style={{ gap: 20 }}>
        <div style={{ ...CARD_STYLE, padding: "20px 24px", flex: 1, display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted)", fontFamily: "Inter, sans-serif", marginBottom: 16 }}>
            {t("workspace.healthCheck.detail.historyTitle", "评分趋势")}
          </span>
          <div style={{ flex: 1, minHeight: 180 }}>
            <ScoreTrendChart data={chartData} />
          </div>
        </div>
      </div>

      {/* Right column — w:340 */}
      <div className="flex flex-col shrink-0" style={{ width: 340, gap: 20 }}>
        {/* Compare card */}
        {previous && (
          <div style={{ ...CARD_STYLE, padding: "20px 24px" }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted)", fontFamily: "Inter, sans-serif", display: "block", marginBottom: 16 }}>
              {t("workspace.healthCheck.detail.historyCompare", "与上次对比")}
            </span>

            {/* Score comparison */}
            <div className="flex items-center" style={{ gap: 16, marginBottom: 16 }}>
              <div className="flex flex-col items-center" style={{ gap: 2 }}>
                <span style={{ fontSize: 10, color: "var(--color-text-placeholder)", fontFamily: "Inter, sans-serif" }}>
                  {t("workspace.healthCheck.detail.previousScore", "上次")}
                </span>
                <span style={{ fontSize: 28, fontWeight: 700, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}>
                  {previous.overallScore}
                </span>
              </div>
              <span style={{ fontSize: 16, color: "var(--color-text-placeholder)" }}>→</span>
              <div className="flex flex-col items-center" style={{ gap: 2 }}>
                <span style={{ fontSize: 10, color: "var(--color-text-placeholder)", fontFamily: "Inter, sans-serif" }}>
                  {t("workspace.healthCheck.detail.currentScore", "本次")}
                </span>
                <span style={{ fontSize: 28, fontWeight: 700, color: "var(--color-foreground)", fontFamily: "Inter, sans-serif" }}>
                  {latest.overallScore}
                </span>
              </div>
              <DeltaBadge change={scoreChange} />
            </div>

            {/* Per-dimension comparison */}
            <div className="flex flex-col" style={{ gap: 8 }}>
              {latest.dimensions.map((dim) => {
                const prevDim = previous.dimensions.find((d) => d.id === dim.id);
                const change = (dim.score ?? 0) - (prevDim?.score ?? 0);
                const color = DIMENSION_COLORS[dim.id] ?? "#888";
                return (
                  <div key={dim.id} className="flex items-center" style={{ gap: 10 }}>
                    <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, flexShrink: 0 }} />
                    <span style={{ width: 55, fontSize: 11, fontWeight: 500, color: "var(--color-muted)", flexShrink: 0, fontFamily: "Inter, sans-serif" }}>
                      {dim.label}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color, width: 28, textAlign: "right", flexShrink: 0, fontFamily: "Inter, sans-serif" }}>
                      {dim.score ?? "—"}
                    </span>
                    <ChangeChip change={change} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Fix summary card */}
        <div style={{ ...CARD_STYLE, padding: "20px 24px" }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted)", fontFamily: "Inter, sans-serif", display: "block", marginBottom: 16 }}>
            {t("workspace.healthCheck.detail.fixProgress", "修复进度")}
          </span>

          {/* Progress bar */}
          {fixStats.total > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: "var(--color-border-light)",
                  overflow: "hidden",
                  display: "flex",
                }}
              >
                {fixStats.fixed > 0 && (
                  <div
                    style={{
                      width: `${(fixStats.fixed / fixStats.total) * 100}%`,
                      height: "100%",
                      backgroundColor: "#30D158",
                      transition: "width 0.4s ease",
                    }}
                  />
                )}
                {fixStats.ignored > 0 && (
                  <div
                    style={{
                      width: `${(fixStats.ignored / fixStats.total) * 100}%`,
                      height: "100%",
                      backgroundColor: "var(--color-text-placeholder)",
                      transition: "width 0.4s ease",
                    }}
                  />
                )}
              </div>
            </div>
          )}

          {/* Fix stats rows */}
          <div className="flex flex-col" style={{ gap: 10 }}>
            <FixStatRow
              label={t("workspace.healthCheck.detail.fixedCount", "已修复")}
              count={fixStats.fixed}
              color="#30D158"
            />
            <FixStatRow
              label={t("workspace.healthCheck.detail.pendingCount", "待修复")}
              count={fixStats.pending}
              color="#FF9F0A"
            />
            <FixStatRow
              label={t("workspace.healthCheck.detail.ignoredCount", "已忽略")}
              count={fixStats.ignored}
              color="var(--color-text-placeholder)"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyHistory() {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center justify-center flex-1"
      style={{ padding: "60px 24px", gap: 12 }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          backgroundColor: "var(--color-surface-raised)",
          border: "1px solid var(--color-border-light)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
        }}
      >
        📈
      </div>
      <p style={{ fontSize: 13, color: "var(--color-text-placeholder)", textAlign: "center", maxWidth: 300, fontFamily: "Inter, sans-serif" }}>
        {t("workspace.healthCheck.detail.historyNoData", "暂无历史数据，完成多次体检后可查看趋势")}
      </p>
    </div>
  );
}

/* ── Pure SVG Score Trend Chart ──────────────────────── */

function ScoreTrendChart({ data }: { readonly data: ReadonlyArray<PersistedHealthCheckResult> }) {
  const width = 600;
  const height = 200;
  const padX = 40;
  const padY = 24;

  const chartW = width - padX * 2;
  const chartH = height - padY * 2;

  const points = useMemo(() => {
    if (data.length === 0) return [];
    const maxPoints = data.length;
    return data.map((d, i) => ({
      x: padX + (maxPoints === 1 ? chartW / 2 : (i / (maxPoints - 1)) * chartW),
      y: padY + chartH - (d.overallScore / 100) * chartH,
      score: d.overallScore,
      date: new Date(d.createdAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }),
    }));
  }, [data, chartW, chartH]);

  if (points.length === 0) return null;

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaD = `${pathD} L ${points[points.length - 1].x} ${padY + chartH} L ${points[0].x} ${padY + chartH} Z`;

  const yGridLines = [0, 25, 50, 75, 100];
  const gradientId = "trendGradient";

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0A84FF" stopOpacity={0.2} />
          <stop offset="100%" stopColor="#0A84FF" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Grid */}
      {yGridLines.map((val) => {
        const y = padY + chartH - (val / 100) * chartH;
        return (
          <g key={val}>
            <line x1={padX} y1={y} x2={padX + chartW} y2={y} stroke="var(--color-border-strong)" strokeWidth={0.5} opacity={0.5} />
            <text x={padX - 6} y={y + 3} fill="var(--color-text-placeholder)" fontSize={9} textAnchor="end" fontFamily="Inter, sans-serif">
              {val}
            </text>
          </g>
        );
      })}

      {/* Area fill — gradient from #0A84FF30 to transparent */}
      <path d={areaD} fill={`url(#${gradientId})`} />

      {/* Line — #0A84FF */}
      <path d={pathD} fill="none" stroke="#0A84FF" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      {/* Points — #0A84FF fill + #1C1C1E stroke */}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={4} fill="#0A84FF" stroke="var(--color-surface)" strokeWidth={2} />
          {/* Score label above dot */}
          <text
            x={p.x}
            y={p.y - 10}
            fill="var(--color-foreground)"
            fontSize={9}
            textAnchor="middle"
            fontFamily="Inter, sans-serif"
            fontWeight={600}
          >
            {p.score}
          </text>
          {/* Date label below axis */}
          {(i === 0 || i === points.length - 1 || i % 2 === 0) && (
            <text
              x={p.x}
              y={padY + chartH + 14}
              fill="var(--color-text-placeholder)"
              fontSize={8}
              textAnchor="middle"
              fontFamily="Inter, sans-serif"
            >
              {p.date}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function DeltaBadge({ change }: { readonly change: number }) {
  const color = change > 0 ? "#30D158" : change < 0 ? "#FF453A" : "var(--color-text-placeholder)";
  const bg = change > 0 ? "#30D15815" : change < 0 ? "#FF453A15" : "var(--color-surface-alt)";
  const Icon = change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus;
  const prefix = change > 0 ? "+" : "";

  return (
    <div
      className="flex items-center"
      style={{
        gap: 4,
        padding: "4px 10px",
        borderRadius: 6,
        backgroundColor: bg,
      }}
    >
      <Icon size={14} style={{ color }} />
      <span style={{ fontSize: 14, fontWeight: 600, color, fontFamily: "Inter, sans-serif" }}>
        {prefix}{change}
      </span>
    </div>
  );
}

function ChangeChip({ change }: { readonly change: number }) {
  if (change === 0) return null;
  const color = change > 0 ? "#30D158" : "#FF453A";
  const prefix = change > 0 ? "+" : "";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 500,
        color,
        backgroundColor: `${color}15`,
        padding: "1px 6px",
        borderRadius: 4,
        fontFamily: "Inter, sans-serif",
      }}
    >
      {prefix}{change}
    </span>
  );
}

function FixStatRow({
  label,
  count,
  color,
}: {
  readonly label: string;
  readonly count: number;
  readonly color: string;
}) {
  return (
    <div className="flex items-center" style={{ justifyContent: "space-between" }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
        <span style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}>{label}</span>
      </div>
      <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: "Inter, sans-serif" }}>{count}</span>
    </div>
  );
}
