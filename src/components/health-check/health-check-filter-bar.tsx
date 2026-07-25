import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Wrench, EyeOff } from "lucide-react";
import { useHealthCheckStore } from "@/stores/health-check-store";
import type { IssueSeverityFilter, EnrichedIssue } from "@/stores/health-check-store";

interface HealthCheckFilterBarProps {
  readonly allIssues: ReadonlyArray<EnrichedIssue>;
  readonly onBatchFix?: () => void;
}

export function HealthCheckFilterBar({ allIssues, onBatchFix }: HealthCheckFilterBarProps) {
  const { t } = useTranslation();
  const severityFilter = useHealthCheckStore((s) => s.severityFilter);
  const setSeverityFilter = useHealthCheckStore((s) => s.setSeverityFilter);
  const searchQuery = useHealthCheckStore((s) => s.searchQuery);
  const setSearchQuery = useHealthCheckStore((s) => s.setSearchQuery);

  /* Per-severity counts for pill labels */
  const counts = useMemo(() => {
    let critical = 0;
    let warning = 0;
    let info = 0;
    for (const issue of allIssues) {
      if (issue.severity === "critical") critical++;
      else if (issue.severity === "warning") warning++;
      else info++;
    }
    return { all: allIssues.length, critical, warning, info };
  }, [allIssues]);

  const pills: Array<{
    value: IssueSeverityFilter;
    label: string;
    count: number;
    dotColor?: string;
  }> = [
    { value: "all", label: t("workspace.healthCheck.detail.filterAll", "全部"), count: counts.all },
    { value: "critical", label: t("workspace.healthCheck.detail.filterCritical", "严重"), count: counts.critical, dotColor: "#FF453A" },
    { value: "warning", label: t("workspace.healthCheck.detail.filterWarning", "警告"), count: counts.warning, dotColor: "#FF9F0A" },
    { value: "info", label: t("workspace.healthCheck.detail.filterInfo", "建议"), count: counts.info, dotColor: "#0A84FF" },
  ];

  return (
    <div
      className="flex items-center shrink-0"
      style={{
        height: 44,
        padding: "0 16px",
        backgroundColor: "var(--color-card)",
        gap: 10,
      }}
    >
      {/* Severity pills — design: active=bg:#0A84FF color:#FFF; inactive=bg:surface-raised color:muted-foreground + dot */}
      {pills.map((opt) => {
        const active = severityFilter === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => setSeverityFilter(opt.value)}
            className="flex items-center"
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: "none",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              gap: 5,
              backgroundColor: active ? "#0A84FF" : "var(--color-surface-raised)",
              color: active ? "#FFFFFF" : "var(--color-muted-foreground)",
              fontFamily: "Inter, sans-serif",
              transition: "all 0.15s ease",
            }}
          >
            {/* Design: 6px colored dot on inactive pills */}
            {opt.dotColor && !active && (
              <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: opt.dotColor }} />
            )}
            <span>{opt.label} ({opt.count})</span>
          </button>
        );
      })}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Search — design: bg:surface-raised, cornerRadius:6, padding:5 10, gap:6 */}
      <div
        className="flex items-center"
        style={{
          borderRadius: 6,
          backgroundColor: "var(--color-surface-raised)",
          padding: "5px 10px",
          gap: 6,
        }}
      >
        <Search size={14} style={{ color: "var(--color-text-placeholder)", flexShrink: 0 }} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("workspace.healthCheck.detail.searchPlaceholder", "搜索文件路径...")}
          style={{
            width: 140,
            border: "none",
            backgroundColor: "transparent",
            color: "var(--color-foreground)",
            fontSize: 12,
            outline: "none",
            fontFamily: "Inter, sans-serif",
          }}
        />
      </div>

      {/* Batch fix pill — design: bg:#30D15820, color:#30D158, cornerRadius:6, gap:5 */}
      <button
        onClick={onBatchFix}
        className="flex items-center"
        style={{
          gap: 5,
          padding: "5px 12px",
          borderRadius: 6,
          border: "none",
          backgroundColor: "#30D15820",
          color: "#30D158",
          fontSize: 12,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <Wrench size={13} />
        <span>{t("workspace.healthCheck.detail.batchFix", "批量修复")}</span>
      </button>
    </div>
  );
}

/* ── BottomBar — design: h:40, bg:#2C2C2E, justify:space-between ── */
export function HealthCheckBottomBar({
  selectedCount,
  onBatchFix,
  onBatchIgnore,
}: {
  readonly selectedCount: number;
  readonly onBatchFix?: () => void;
  readonly onBatchIgnore?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center shrink-0"
      style={{
        height: 40,
        padding: "0 16px",
        backgroundColor: "var(--color-card)",
        justifyContent: "space-between",
      }}
    >
      {/* Left: selected count — design: color:#0A84FF, fontSize:12, fontWeight:500 */}
      <div className="flex items-center" style={{ gap: 8 }}>
        {selectedCount > 0 && (
          <span style={{ fontSize: 12, fontWeight: 500, color: "#0A84FF", fontFamily: "Inter, sans-serif" }}>
            {t("workspace.healthCheck.detail.selectedCount", "已选 {{count}} 项", { count: selectedCount })}
          </span>
        )}
      </div>

      {/* Right: batch actions — design: batchFixBtn bg:#30D158 color:#FFF + batchIgnoreBtn bg:#3A3A3C color:#EBEBF599 */}
      {selectedCount > 0 && (
        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            onClick={onBatchFix}
            className="flex items-center"
            style={{
              gap: 5,
              padding: "5px 14px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#30D158",
              color: "#FFFFFF",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
            }}
          >
            <Wrench size={12} />
            <span>{t("workspace.healthCheck.detail.batchFix", "批量修复")} ({selectedCount})</span>
          </button>
          <button
            onClick={onBatchIgnore}
            className="flex items-center"
            style={{
              gap: 5,
              padding: "5px 14px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "var(--color-surface-raised)",
              color: "var(--color-muted)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
            }}
          >
            <EyeOff size={12} />
            <span>{t("workspace.healthCheck.detail.ignore", "忽略")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
