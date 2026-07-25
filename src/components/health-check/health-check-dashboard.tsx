import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DimensionState, EnrichedIssue, DimensionId } from "@/stores/health-check-store";

interface HealthCheckDashboardProps {
  readonly dimensions: ReadonlyArray<DimensionState>;
  readonly overallScore: number | null;
  readonly summary: string | null;
  readonly allIssues: ReadonlyArray<EnrichedIssue>;
}

/* ── Design-spec dimension colors (from Pencil node 5ortw) ── */
const DIMENSION_COLORS: Record<DimensionId, string> = {
  "code-standards": "#10B981",
  "security": "#0A84FF",
  "perf-deps": "#A855F7",
  "tech-debt": "#06B6D4",
  "maintainability": "#F59E0B",
};

function getScoreGrade(score: number): { label: string; fallback: string; color: string } {
  if (score >= 90) return { label: "workspace.healthCheck.scoreExcellent", fallback: "优秀", color: "#30D158" };
  if (score >= 70) return { label: "workspace.healthCheck.scoreGood", fallback: "良好", color: "#30D158" };
  if (score >= 50) return { label: "workspace.healthCheck.scoreAverage", fallback: "一般", color: "#FF9F0A" };
  return { label: "workspace.healthCheck.scoreNeedsImprovement", fallback: "需改进", color: "#FF453A" };
}

/* Design-spec card shell: #2C2C2E80 bg + #3A3A3C80 1px inside stroke + cornerRadius:12 */
const CARD_STYLE: React.CSSProperties = {
  backgroundColor: "var(--color-surface-raised)",
  borderRadius: 12,
  border: "1px solid var(--color-border-light)",
  boxShadow: "var(--shadow-card)",
  overflow: "hidden",
};

export function HealthCheckDashboard({
  dimensions,
  overallScore,
  allIssues,
}: HealthCheckDashboardProps) {
  const { t } = useTranslation();

  const grade = overallScore != null ? getScoreGrade(overallScore) : null;

  const issueCounts = useMemo(() => {
    let critical = 0;
    let warning = 0;
    let info = 0;
    for (const issue of allIssues) {
      if (issue.severity === "critical") critical++;
      else if (issue.severity === "warning") warning++;
      else info++;
    }
    return { critical, warning, info };
  }, [allIssues]);

  return (
    <div
      className="flex shrink-0"
      style={{ gap: 16, height: 200 }}
    >
      {/* ── ScoreCard — w:200, padding:20, gap:8, center-aligned column ── */}
      <div
        className="flex flex-col items-center"
        style={{
          ...CARD_STYLE,
          width: 200,
          flexShrink: 0,
          height: "100%",
          padding: 20,
          gap: 8,
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}>
          {t("workspace.healthCheck.overallScore", "综合评分")}
        </span>
        <span
          style={{
            fontSize: 56,
            fontWeight: 700,
            color: grade?.color ?? "var(--color-foreground)",
            lineHeight: 1,
            letterSpacing: -2,
            fontFamily: "Inter, sans-serif",
          }}
        >
          {overallScore ?? "—"}
        </span>
        {grade && (
          <div
            className="flex items-center"
            style={{
              padding: "3px 10px",
              borderRadius: 10,
              backgroundColor: `${grade.color}20`,
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 600, color: grade.color, fontFamily: "Inter, sans-serif" }}>
              {t(grade.label, grade.fallback)}
            </span>
          </div>
        )}
        <span style={{ fontSize: 10, color: "var(--color-text-placeholder)", fontFamily: "Inter, sans-serif" }}>
          {new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}
          {" "}
          {new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
        </span>
      </div>

      {/* ── RadarCard — flex:1, padding:16, gap:12 ── */}
      <div
        style={{
          ...CARD_STYLE,
          flex: 1,
          height: "100%",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          minWidth: 0,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted)", fontFamily: "Inter, sans-serif", flexShrink: 0 }}>
          {t("workspace.healthCheck.detail.dimensionAnalysis", "维度分析")}
        </span>
        {/* RadarBody: RadarChartArea + DimList */}
        <div className="flex items-center flex-1" style={{ gap: 16, minHeight: 0, overflow: "hidden" }}>
          {/* RadarChartArea — design: w:140 h:140, cornerRadius:70, bg:#3A3A3C30 */}
          <div
            style={{
              width: 130,
              height: 130,
              flexShrink: 0,
              borderRadius: "50%",
              backgroundColor: "var(--color-surface-alt)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <RadarChart dimensions={dimensions} size={120} />
          </div>
          {/* DimList — design: gap:6, vertical, justify-center, fill-width */}
          <div
            className="flex flex-col flex-1 min-w-0"
            style={{ gap: 6, justifyContent: "center", height: "100%" }}
          >
            {dimensions.map((dim) => (
              <DimensionBar key={dim.id} dim={dim} />
            ))}
          </div>
        </div>
      </div>

      {/* ── StatsCard — w:280, padding:16, gap:12 ── */}
      <div
        style={{
          ...CARD_STYLE,
          width: 280,
          flexShrink: 0,
          height: "100%",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          overflow: "hidden",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}>
          {t("workspace.healthCheck.detail.issueStats", "问题统计")}
        </span>
        {/* statsBody — fit within 200px card */}
        <div className="flex flex-col flex-1" style={{ gap: 8, justifyContent: "center", overflow: "hidden", minHeight: 0 }}>
          <StatRow
            label={t("workspace.healthCheck.criticalIssues", "严重问题")}
            count={issueCounts.critical}
            color="#FF453A"
          />
          <StatRow
            label={t("workspace.healthCheck.warningIssues", "警告问题")}
            count={issueCounts.warning}
            color="#FF9F0A"
          />
          <StatRow
            label={t("workspace.healthCheck.infoIssues", "建议优化")}
            count={issueCounts.info}
            color="#0A84FF"
          />
        </div>
      </div>
    </div>
  );
}

/* ── StatRow — design: 10px colored dot + fontSize:13 label + right-aligned fontSize:22 count ── */
function StatRow({
  label,
  count,
  color,
}: {
  readonly label: string;
  readonly count: number;
  readonly color: string;
}) {
  return (
    <div
      className="flex items-center"
      style={{
        justifyContent: "space-between",
        padding: "8px 12px",
        borderRadius: 8,
        backgroundColor: `${color}15`,
        flexShrink: 0,
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 500, color, fontFamily: "Inter, sans-serif" }}>
          {label}
        </span>
      </div>
      <span style={{ fontSize: 20, fontWeight: 700, color, fontFamily: "Inter, sans-serif" }}>
        {count}
      </span>
    </div>
  );
}

/* ── DimensionBar — design: 8px dot + 56px name + progress bar + score ── */
function DimensionBar({ dim }: { readonly dim: DimensionState }) {
  const { t } = useTranslation();
  const color = DIMENSION_COLORS[dim.id] ?? "#888";
  const score = dim.score ?? 0;

  const dimKeys: Record<DimensionId, string> = {
    "code-standards": "healthCheck.dimCodeStandards",
    "security": "healthCheck.dimSecurity",
    "perf-deps": "healthCheck.dimPerfDeps",
    "tech-debt": "healthCheck.dimTechDebt",
    "maintainability": "healthCheck.dimMaintainability",
  };

  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      {/* Design: 8x8 colored ellipse */}
      <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, flexShrink: 0 }} />
      {/* Design: w:56, fontSize:11, color:#EBEBF5CC */}
      <span
        style={{
          fontSize: 11,
          color: "var(--color-muted-foreground)",
          width: 56,
          flexShrink: 0,
          fontFamily: "Inter, sans-serif",
        }}
      >
        {t(dimKeys[dim.id], dim.label)}
      </span>
      {/* Progress bar — rounded pill style (ref: TopBar iFZRk cornerRadius:12) */}
      <div
        style={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          backgroundColor: "var(--color-border-light)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${score}%`,
            height: "100%",
            borderRadius: 4,
            backgroundColor: color,
            transition: "width 0.6s ease",
          }}
        />
      </div>
      {/* Score — design: fontSize:11, fontWeight:600, color:#EBEBF5CC */}
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--color-muted-foreground)",
          width: 24,
          flexShrink: 0,
          textAlign: "right",
          fontFamily: "Inter, sans-serif",
        }}
      >
        {dim.score ?? "—"}
      </span>
    </div>
  );
}

/* ── SVG Radar Chart ── */
function RadarChart({
  dimensions,
  size,
}: {
  readonly dimensions: ReadonlyArray<DimensionState>;
  readonly size: number;
}) {
  const center = size / 2;
  const radius = size / 2 - 10;
  const n = dimensions.length || 5;

  const getPoint = (index: number, r: number) => {
    const angle = (Math.PI * 2 * index) / n - Math.PI / 2;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };

  const levels = [0.2, 0.4, 0.6, 0.8, 1.0];

  const gridLines = levels.map((level) => {
    const points = Array.from({ length: n }, (_, i) => {
      const p = getPoint(i, radius * level);
      return `${p.x},${p.y}`;
    }).join(" ");
    return points;
  });

  const dataPoints = dimensions.map((dim, i) => {
    const score = (dim.score ?? 0) / 100;
    return getPoint(i, radius * score);
  });

  const dataPath = dataPoints.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {gridLines.map((points, i) => (
        <polygon
          key={i}
          points={points}
          fill="none"
          stroke="var(--color-border-strong)"
          strokeWidth={0.5}
          opacity={0.6}
        />
      ))}
      {Array.from({ length: n }, (_, i) => {
        const p = getPoint(i, radius);
        return (
          <line
            key={i}
            x1={center}
            y1={center}
            x2={p.x}
            y2={p.y}
            stroke="var(--color-border-strong)"
            strokeWidth={0.5}
            opacity={0.4}
          />
        );
      })}
      <polygon
        points={dataPath}
        fill="#0A84FF20"
        stroke="#0A84FF"
        strokeWidth={1.5}
      />
      {dataPoints.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={3}
          fill={DIMENSION_COLORS[dimensions[i]?.id] ?? "#0A84FF"}
        />
      ))}
    </svg>
  );
}

export { DIMENSION_COLORS };
