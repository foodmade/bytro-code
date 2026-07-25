import { useEffect } from "react";
import { Braces, FileCode, GitCommitHorizontal, TrendingUp, TrendingDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { m } from "motion/react";
import { useWorkspaceStatsStore } from "@/stores";
import { useCountUp } from "@/hooks/use-count-up";
import { useEntryAnimation } from "./workspace-entry-context";

interface StatCardData {
  readonly rawValue: number | null;
  readonly label: string;
  readonly icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  readonly iconColor: string;
  readonly trend?: number;
}

function formatTrend(trend: number): string {
  const pct = Math.round(Math.abs(trend) * 100);
  if (pct > 999) return `${trend >= 0 ? "+" : "-"}999%+`;
  return `${trend >= 0 ? "+" : "-"}${pct}%`;
}

const STAT_STAGGER_MS = 60;

function StatCard({ stat, index }: { readonly stat: StatCardData; readonly index: number }) {
  const Icon = stat.icon;
  const hasTrend = stat.trend != null && stat.trend !== 0;
  const isPositive = (stat.trend ?? 0) >= 0;
  const trendColor = isPositive ? "#10B981" : "#EF4444";

  const delayMs = index * STAT_STAGGER_MS;
  // A monotonically-increasing key, not a boolean: two back-to-back entries
  // that both resolve synchronously would otherwise go true→true with no
  // observable edge (React batches the reset away) — see useEntryAnimation.
  const playKey = useEntryAnimation(stat.rawValue != null);
  const playAnimation = playKey > 0;
  const animatedValue = useCountUp(stat.rawValue ?? 0, playAnimation, delayMs, 900, playKey);
  const displayValue = stat.rawValue == null ? "--" : animatedValue.toLocaleString();

  return (
    <m.div
      // `playKey` forces a remount on every replay: `initial` only applies at
      // mount time (the outer `key={stat.label}` in the parent's .map()
      // doesn't change here, so this component wouldn't otherwise remount).
      key={playKey}
      initial={playAnimation ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut", delay: delayMs / 1000 }}
      className="flex flex-col flex-1 min-w-0"
      style={{
        height: "100%",
        minWidth: 180,
        borderRadius: 16,
        backgroundColor: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        padding: "16px 20px",
        gap: 10,
        overflow: "hidden",
        justifyContent: "center",
      }}
    >
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center" style={{ gap: 8 }}>
          <Icon size={16} style={{ color: stat.iconColor }} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "var(--color-muted-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {stat.label}
          </span>
        </div>
        {hasTrend && (
          <div
            className="flex items-center"
            style={{
              gap: 4,
              padding: "2px 8px",
              borderRadius: 10,
              backgroundColor: `${trendColor}18`,
            }}
          >
            {isPositive ? (
              <TrendingUp size={10} style={{ color: trendColor }} />
            ) : (
              <TrendingDown size={10} style={{ color: trendColor }} />
            )}
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: trendColor,
                fontFamily: "Inter, sans-serif",
              }}
            >
              {formatTrend(stat.trend!)}
            </span>
          </div>
        )}
      </div>

      <span
        style={{
          fontSize: 26,
          fontWeight: 800,
          color: "var(--color-foreground)",
          fontFamily: "Inter, sans-serif",
          lineHeight: 1.1,
        }}
      >
        {displayValue}
      </span>
    </m.div>
  );
}

const REFRESH_INTERVAL = 60_000;

export function WorkspaceStatsSection({ workspacePath }: { readonly workspacePath: string }) {
  const { t } = useTranslation();
  const stats = useWorkspaceStatsStore((s) => s.stats);
  const isLoading = useWorkspaceStatsStore((s) => s.isLoading);
  const fetchStats = useWorkspaceStatsStore((s) => s.fetchStats);
  const clear = useWorkspaceStatsStore((s) => s.clear);

  useEffect(() => {
    clear();
    fetchStats(workspacePath);

    const timer = setInterval(() => {
      fetchStats(workspacePath);
    }, REFRESH_INTERVAL);

    return () => {
      clearInterval(timer);
    };
  }, [workspacePath, fetchStats, clear]);

  const cards: readonly StatCardData[] = [
    {
      rawValue: isLoading ? null : (stats?.totalLines ?? null),
      label: t("workspace.stats.linesOfCode"),
      icon: Braces,
      iconColor: "#4285F4",
      trend: stats?.linesTrend,
    },
    {
      rawValue: isLoading ? null : (stats?.totalFiles ?? null),
      label: t("workspace.stats.fileCount"),
      icon: FileCode,
      iconColor: "#A855F7",
      trend: stats?.filesTrend,
    },
    {
      rawValue: isLoading ? null : (stats?.totalCommits ?? null),
      label: t("workspace.stats.totalCommits"),
      icon: GitCommitHorizontal,
      iconColor: "#10B981",
      trend: stats?.commitsTrend,
    },
  ];

  return (
    <>
      {cards.map((stat, index) => (
        <StatCard key={stat.label} stat={stat} index={index} />
      ))}
    </>
  );
}
