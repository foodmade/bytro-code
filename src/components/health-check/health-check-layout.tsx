import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HeartPulse } from "lucide-react";
import { WorkspaceRail } from "@/components/layout/workspace-rail";
import { useHealthCheckStore, flattenIssues, loadPersistedIgnoredIssues } from "@/stores/health-check-store";
import { useWorkspaceStore } from "@/stores";
import { useHealthCheck, loadLastHealthCheckResult, loadHealthCheckHistory } from "@/hooks/use-health-check";
import { useHealthFix } from "@/hooks/use-health-fix";
import { exportHealthCheckReport } from "@/lib/health-check-export";
import { HealthCheckToolbar } from "./health-check-toolbar";
import { HealthCheckDashboard } from "./health-check-dashboard";
import { HealthCheckFilterBar, HealthCheckBottomBar } from "./health-check-filter-bar";
import { HealthCheckIssueList } from "./health-check-issue-list";
import { HealthCheckDetailPanel } from "./health-check-detail-panel";
import { HealthCheckHistoryView } from "./health-check-history-view";

export default function HealthCheckLayout() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const phase = useHealthCheckStore((s) => s.phase);
  const dimensions = useHealthCheckStore((s) => s.dimensions);
  const overallScore = useHealthCheckStore((s) => s.overallScore);
  const summary = useHealthCheckStore((s) => s.summary);
  const lastResult = useHealthCheckStore((s) => s.lastResult);
  const activeTab = useHealthCheckStore((s) => s.activeTab);
  const activeIssueId = useHealthCheckStore((s) => s.activeIssueId);
  const severityFilter = useHealthCheckStore((s) => s.severityFilter);
  const searchQuery = useHealthCheckStore((s) => s.searchQuery);
  const issueFixStatuses = useHealthCheckStore((s) => s.issueFixStatuses);

  const { startCheck, cancelCheck } = useHealthCheck();
  const { fixBatchIssues, ignoreBatch } = useHealthFix();
  const selectedIssueIds = useHealthCheckStore((s) => s.selectedIssueIds);

  // Load persisted result, history & ignored issues on mount
  useEffect(() => {
    if (workspaceId) {
      loadLastHealthCheckResult(workspaceId);
      loadHealthCheckHistory(workspaceId);
      loadPersistedIgnoredIssues(workspaceId);
    }
  }, [workspaceId]);

  // Determine which dimensions to display (live scan > last persisted)
  const displayDimensions = phase === "completed" ? dimensions : (lastResult?.dimensions ?? dimensions);
  const displayScore = phase === "completed" ? overallScore : (lastResult?.overallScore ?? overallScore);
  const displaySummary = phase === "completed" ? summary : (lastResult?.summary ?? summary);

  // Flatten issues for the list
  const allIssues = useMemo(() => flattenIssues(displayDimensions), [displayDimensions]);

  // Visible issues: exclude ignored items (used for filter bar counts)
  const visibleIssues = useMemo(
    () => allIssues.filter((i) => issueFixStatuses[i.id] !== "ignored"),
    [allIssues, issueFixStatuses],
  );

  // Apply filters
  const filteredIssues = useMemo(() => {
    let result = [...visibleIssues];

    if (severityFilter !== "all") {
      result = result.filter((i) => i.severity === severityFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (i) =>
          i.message.toLowerCase().includes(q) ||
          (i.file && i.file.toLowerCase().includes(q)) ||
          i.dimensionLabel.toLowerCase().includes(q),
      );
    }

    return result;
  }, [visibleIssues, severityFilter, searchQuery]);

  // Find active issue for detail panel
  const activeIssue = activeIssueId ? allIssues.find((i) => i.id === activeIssueId) ?? null : null;

  const hasData = phase === "completed" || lastResult != null;

  const handleBatchFix = useCallback(() => {
    const selected = filteredIssues.filter((i) => selectedIssueIds.has(i.id));
    fixBatchIssues(selected);
  }, [filteredIssues, selectedIssueIds, fixBatchIssues]);

  const handleBatchIgnore = useCallback(() => {
    const ids = [...selectedIssueIds];
    ignoreBatch(ids);
  }, [selectedIssueIds, ignoreBatch]);

  const workspace = useWorkspaceStore((s) => s.activeWorkspace);
  const handleExport = useCallback(() => {
    exportHealthCheckReport({
      overallScore: displayScore,
      summary: displaySummary,
      dimensions: displayDimensions,
      issues: allIssues,
      workspaceName: workspace?.name ?? "Unknown",
    });
  }, [displayScore, displaySummary, displayDimensions, allIssues, workspace]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      <WorkspaceRail />

      {/* Main area — design: bg:#1C1C1E, vertical layout */}
      <div
        className="flex flex-col flex-1 min-w-0"
        style={{ backgroundColor: "var(--color-background)" }}
      >
        {/* Constrained container — match Workspace page max-width */}
        <div
          className="flex flex-col flex-1 min-h-0"
          style={{
            maxWidth: 1600,
            width: "100%",
            margin: "0 auto",
          }}
        >
          {/* TopBar — design 6J3Nb: cornerRadius:12, h:48, card-style */}
          <div style={{ padding: "16px 24px 0" }}>
            <HealthCheckToolbar
              phase={phase}
              onStartCheck={startCheck}
              onCancelCheck={cancelCheck}
              onExport={handleExport}
            />
          </div>

          {/* MainContent — design: padding:24, gap:20, horizontal flex with LeftPanel + DetailPanel */}
          <div
            className="flex flex-1 min-h-0"
            style={{ padding: "16px 24px 24px", gap: 20 }}
          >
          {/* LeftPanel — scrollable, fills width */}
          <div
            className="flex flex-col flex-1 min-w-0 overflow-y-auto"
            style={{ gap: 16 }}
          >
            {activeTab === "issues" && (
              <>
                {hasData && (
                  <HealthCheckDashboard
                    dimensions={displayDimensions}
                    overallScore={displayScore}
                    summary={displaySummary}
                    allIssues={allIssues}
                  />
                )}

                {hasData ? (
                  <div
                    className="flex flex-col flex-1 min-h-0"
                    style={{
                      backgroundColor: "var(--color-surface-raised)",
                      borderRadius: 12,
                      border: "1px solid var(--color-border-light)",
                      boxShadow: "var(--shadow-card)",
                      overflow: "hidden",
                    }}
                  >
                    <HealthCheckFilterBar
                      allIssues={visibleIssues}
                      onBatchFix={handleBatchFix}
                    />
                    <HealthCheckIssueList issues={filteredIssues} />
                    <HealthCheckBottomBar
                      selectedCount={selectedIssueIds.size}
                      onBatchFix={handleBatchFix}
                      onBatchIgnore={handleBatchIgnore}
                    />
                  </div>
                ) : (
                  <EmptyState phase={phase} onStartCheck={startCheck} />
                )}
              </>
            )}

            {activeTab === "history" && <HealthCheckHistoryView />}
          </div>

          {/* DetailPanel — design: w:380, height:fill_container, inside padding area */}
          {activeIssue && (
            <HealthCheckDetailPanel issue={activeIssue} />
          )}
        </div>
        </div>
      </div>
    </div>
  );
}


function EmptyState({
  phase,
  onStartCheck,
}: {
  readonly phase: string;
  readonly onStartCheck: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center justify-center flex-1"
      style={{ gap: 16, padding: "60px 24px" }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          backgroundColor: "var(--color-surface-raised)",
          border: "1px solid var(--color-border-light)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <HeartPulse size={28} style={{ color: "#0A84FF" }} />
      </div>
      <div style={{ textAlign: "center" }}>
        <h3
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "var(--color-foreground)",
            marginBottom: 6,
            fontFamily: "Inter, sans-serif",
          }}
        >
          {t("workspace.healthCheck.title", "项目体检")}
        </h3>
        <p
          style={{
            fontSize: 13,
            color: "var(--color-text-placeholder)",
            maxWidth: 320,
            fontFamily: "Inter, sans-serif",
          }}
        >
          {t("workspace.healthCheck.description", "全面检查代码质量、测试覆盖率、安全性等维度")}
        </p>
      </div>
      {phase !== "scanning" && (
        <button
          onClick={onStartCheck}
          className="flex items-center"
          style={{
            marginTop: 8,
            padding: "8px 20px",
            gap: 6,
            borderRadius: 8,
            border: "none",
            backgroundColor: "#0A84FF",
            color: "#FFFFFF",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: "Inter, sans-serif",
          }}
        >
          <HeartPulse size={14} />
          <span>{t("workspace.healthCheck.startCheck", "一键体检")}</span>
        </button>
      )}
    </div>
  );
}
